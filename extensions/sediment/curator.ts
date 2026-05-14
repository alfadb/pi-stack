import * as path from "node:path";
import type { MemorySettings } from "../memory/settings";
import { loadEntries } from "../memory/parser";
import { llmSearchEntries } from "../memory/llm-search";
import type { MemoryEntry } from "../memory/types";
import type { SedimentSettings } from "./settings";
import type { DeleteMode, ProjectEntryDraft, ProjectEntryUpdateDraft } from "./writer";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export type CuratorDecision =
  | { op: "create"; scope?: "world"; rationale?: string }
  | { op: "update"; slug: string; scope?: "world"; patch: ProjectEntryUpdateDraft; rationale?: string }
  | { op: "merge"; target: string; sources: string[]; scope?: "world"; compiledTruth: string; timelineNote?: string; rationale?: string }
  | { op: "archive"; slug: string; scope?: "world"; reason: string; rationale?: string }
  | { op: "supersede"; oldSlug: string; newSlug?: string; scope?: "world"; reason: string; rationale?: string }
  | { op: "delete"; slug: string; mode: DeleteMode; scope?: "world"; reason: string; rationale?: string }
  | { op: "skip"; reason: string; rationale?: string };

export interface CuratorAudit {
  decision: CuratorDecision;
  neighbors: Array<{ slug: string; score?: number; rank_reason?: string }>;
  stage_ms: { search: number; decide: number; total: number };
  error?: string;
}

export interface CuratorOutcome {
  decision: CuratorDecision;
  audit: CuratorAudit;
}

// (2026-05-11: timeout/retries moved to SedimentSettings.curatorTimeoutMs/curatorMaxRetries)

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function unwrapJsonText(rawText: string): unknown {
  const raw = rawText.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fence?.[1]?.trim()].filter((x): x is string => !!x);

  for (const text of candidates) {
    try { return JSON.parse(text); } catch {}
  }

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)); } catch {}
  }

  throw new Error(`curator did not return parseable JSON: ${raw.slice(0, 300)}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asDeleteMode(value: unknown): DeleteMode {
  return value === "hard" ? "hard" : "soft";
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter((v): v is string => !!v);
  const single = asString(value);
  return single ? single.split(",").map((part) => part.trim()).filter(Boolean) : [];
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseDecision(rawText: string, allowedSlugs: Set<string>): CuratorDecision {
  const payload = unwrapJsonText(rawText);
  if (!payload || typeof payload !== "object") throw new Error("curator JSON must be an object");
  const obj = payload as Record<string, unknown>;
  const op = asString(obj.op)?.toLowerCase();
  const rationale = asString(obj.rationale ?? obj.why);
  const scope = asString(obj.scope) === "world" ? "world" as const : undefined;

  if (op === "skip") {
    return { op: "skip", reason: asString(obj.reason) ?? rationale ?? "curator decided to skip", ...(rationale ? { rationale } : {}) };
  }

  if (op === "update") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new Error(`curator update slug is not an allowed neighbor: ${slug || "<missing>"}`);
    const patchObj = (obj.patch && typeof obj.patch === "object" ? obj.patch : obj) as Record<string, unknown>;
    const patch: ProjectEntryUpdateDraft = {
      ...(asString(patchObj.title) ? { title: asString(patchObj.title)! } : {}),
      ...(asString(patchObj.kind) ? { kind: asString(patchObj.kind)! as ProjectEntryUpdateDraft["kind"] } : {}),
      ...(asString(patchObj.status) ? { status: asString(patchObj.status)! as ProjectEntryUpdateDraft["status"] } : {}),
      ...(asNumber(patchObj.confidence) !== undefined ? { confidence: asNumber(patchObj.confidence)! } : {}),
      ...(asString(patchObj.compiled_truth ?? patchObj.compiledTruth) ? { compiledTruth: asString(patchObj.compiled_truth ?? patchObj.compiledTruth)! } : {}),
      ...(Array.isArray(patchObj.trigger_phrases) ? { triggerPhrases: patchObj.trigger_phrases.map(String).filter(Boolean) } : {}),
      timelineNote: asString(obj.timeline_note ?? obj.timelineNote) ?? rationale ?? "updated by sediment curator",
    };
    return { op: "update", slug, ...(scope ? { scope } : {}), patch, ...(rationale ? { rationale } : {}) };
  }

  if (op === "merge") {
    const target = asString(obj.target);
    const sources = asStringArray(obj.sources);
    const compiledTruth = asString(obj.compiled_truth ?? obj.compiledTruth);
    if (!target || !allowedSlugs.has(target)) throw new Error(`curator merge target is not an allowed neighbor: ${target || "<missing>"}`);
    const invalidSource = sources.find((slug) => !allowedSlugs.has(slug));
    if (invalidSource) throw new Error(`curator merge source is not an allowed neighbor: ${invalidSource}`);
    if (!sources.includes(target)) sources.unshift(target);
    if (!compiledTruth) throw new Error("curator merge requires compiled_truth");
    return { op: "merge", target, sources: Array.from(new Set(sources)), ...(scope ? { scope } : {}), compiledTruth, timelineNote: asString(obj.timeline_note ?? obj.timelineNote) ?? rationale, ...(rationale ? { rationale } : {}) };
  }

  if (op === "archive") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new Error(`curator archive slug is not an allowed neighbor: ${slug || "<missing>"}`);
    return { op: "archive", slug, ...(scope ? { scope } : {}), reason: asString(obj.reason) ?? rationale ?? "archived by sediment curator", ...(rationale ? { rationale } : {}) };
  }

  if (op === "supersede") {
    const oldSlug = asString(obj.old_slug ?? obj.oldSlug ?? obj.slug);
    const newSlug = asString(obj.new_slug ?? obj.newSlug);
    if (!oldSlug || !allowedSlugs.has(oldSlug)) throw new Error(`curator supersede old_slug is not an allowed neighbor: ${oldSlug || "<missing>"}`);
    if (newSlug && !allowedSlugs.has(newSlug)) throw new Error(`curator supersede new_slug is not an allowed neighbor: ${newSlug}`);
    return { op: "supersede", oldSlug, ...(newSlug ? { newSlug } : {}), ...(scope ? { scope } : {}), reason: asString(obj.reason) ?? rationale ?? "superseded by sediment curator", ...(rationale ? { rationale } : {}) };
  }

  if (op === "delete") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new Error(`curator delete slug is not an allowed neighbor: ${slug || "<missing>"}`);
    return {
      op: "delete",
      slug,
      ...(scope ? { scope } : {}),
      mode: asDeleteMode(obj.mode),
      reason: asString(obj.reason) ?? rationale ?? "deleted by sediment curator",
      ...(rationale ? { rationale } : {}),
    };
  }

  if (op === "create") {
    return { op: "create", ...(scope ? { scope } : {}), ...(rationale ? { rationale } : {}) };
  }

  throw new Error(`unsupported curator op: ${op || "<missing>"}`);
}

function relevantEntriesForCurator(entries: MemoryEntry[]): MemoryEntry[] {
  // Include both project and world entries so the curator can:
  //   1. dedupe world candidates against existing world maxims
  //   2. run full lifecycle ops (update/merge/archive/supersede/delete) on world entries
  //   3. detect cross-scope relationships (project specialization of world principle)
  // Without world neighbors, world store is structurally append-only and
  // ADR 0016 "knowledge is self-evolving" is violated for world scope.
  return entries.filter((entry) => entry.scope === "project" || entry.scope === "world");
}

function entryForPrompt(entry: MemoryEntry): string {
  return [
    `## ${entry.slug}`,
    `scope: ${entry.scope ?? "project"}`,
    `title: ${entry.title}`,
    `kind: ${entry.kind}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    entry.created ? `created: ${entry.created}` : undefined,
    entry.updated ? `updated: ${entry.updated}` : undefined,
    "",
    "### compiled_truth",
    entry.compiledTruth,
    "",
    "### timeline_tail",
    entry.timeline.slice(-4).join("\n") || "(none)",
  ].filter((x): x is string => x !== undefined).join("\n");
}

function makeSearchPrompt(draft: ProjectEntryDraft): string {
  return [
    "For sediment curator: find existing project memories that this candidate may update, merge with, supersede, or duplicate.",
    "Prefer entries with matching durable meaning even if wording differs. Include stale design decisions that this candidate implements or corrects.",
    "",
    `Candidate title: ${draft.title}`,
    `Candidate kind: ${draft.kind}`,
    `Candidate confidence: ${draft.confidence ?? "unknown"}`,
    "Candidate compiled truth:",
    draft.compiledTruth,
  ].join("\n");
}

/**
 * Build the prompt sent to the curator model. Exported so smoke can
 * assert directive markers (e.g. cross-scope wikilink hygiene) survive
 * future refactors. The curator decides create/update/merge/archive/
 * supersede/delete/skip; weakening these directives could regress
 * graph quality silently across thousands of auto-write decisions.
 */
export function buildCuratorPrompt(draft: ProjectEntryDraft, neighbors: MemoryEntry[]): string {
  return makeCuratorPrompt(draft, neighbors);
}

function makeCuratorPrompt(draft: ProjectEntryDraft, neighbors: MemoryEntry[]): string {
  return [
    "You are pi-astack sediment curator.",
    "Your job is to maintain the current best knowledge state, not append duplicate notes.",
    "Decide whether the candidate should create a new memory, update/merge existing memories, archive/supersede/delete an existing memory, or be skipped.",
    "Output JSON only, one object. No markdown wrapper.",
    "",
    "Allowed operations for this implementation batch:",
    "- {\"op\":\"create\", \"scope\"?: \"world\", \"rationale\": string}  — scope omitted defaults to project",
    "",
    "Scope judgment (when to set scope: world on create):",
    "- Use scope: world when the candidate is a durable cross-project engineering maxim, principle, or pattern that does NOT depend on any specific project's context, file paths, or module names.",
    "- Use project scope (default, omit scope) when the candidate is a project-specific fact, decision, observation, or pattern tied to the current project's codebase, architecture, or workflow.",
    "- Signal: if you could drop the candidate into any other project's knowledge base and it would still be true and useful, it's world scope. If it mentions or depends on this project's specifics, it's project scope.",
    "- The same agent_end window can produce both project and world entries from different aspects of the same debugging session (e.g. 'pi-astack entry 4 runs slowest' is project fact; 'agent_end handlers must defer async' is world principle).",
    "- {\"op\":\"update\", \"slug\": one_of_neighbors, \"patch\": {\"title\"?: string, \"kind\"?: string, \"status\"?: string, \"confidence\"?: number, \"compiled_truth\"?: string, \"trigger_phrases\"?: string[]}, \"timeline_note\": string, \"rationale\": string}",
    "- {\"op\":\"merge\", \"target\": one_of_neighbors, \"sources\": [one_or_more_neighbors], \"compiled_truth\": string, \"timeline_note\": string, \"rationale\": string}",
    "- {\"op\":\"skip\", \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"archive\", \"slug\": one_of_neighbors, \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"supersede\", \"old_slug\": one_of_neighbors, \"new_slug\"?: one_of_neighbors, \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"delete\", \"slug\": one_of_neighbors, \"mode\": \"soft\"|\"hard\", \"reason\": string, \"rationale\": string}",
    "",
    "Rules:",
    "- Prefer update over create when the candidate refines, implements, corrects, or supersedes a single neighbor.",
    "- Prefer merge when two or more neighbors are the same evolving knowledge unit and the candidate supplies a better compiled truth.",
    "- Prefer skip when the candidate adds no durable information beyond a neighbor.",
    "- Use create only when no neighbor is the same evolving knowledge unit.",
    "- Use archive when a neighbor is no longer useful as active knowledge but should remain retained.",
    "- Use supersede when an existing neighbor is replaced by another existing neighbor or explicitly made stale by the candidate.",
    "- Delete defaults to mode=soft: archive the existing entry with a delete timeline note. Use mode=hard only for secrets, obvious junk/noise, or explicit user-requested removal. Git history is the rollback surface.",
    "",
    "Update vs create discipline (added 2026-05-13 after curator P0 in abrain commit 2e8924d: candidate was a downstream observation that touched the same topic as an existing entry; curator overwrote the upstream entry instead of creating a derived one, dropping 4 evidence bullets + 3 fix steps + principle section).",
    "- Use UPDATE only when the candidate REFINES the SAME claim the neighbor already makes (corrects an error, adds confidence, narrows scope, supplies a better compiled truth for the SAME assertion).",
    "- Use CREATE with `derives_from: [<neighbor-slug>]` when the candidate is a DOWNSTREAM observation that builds on the neighbor's premise but states a DIFFERENT claim (a new failure mode, a new operational hazard, a new consequence, a new specialization). 'Same topic area' is NOT sufficient grounds for update; the candidate must contradict, supersede, or directly refine the neighbor's claim.",
    "- When in doubt: prefer CREATE with derives_from over UPDATE. A spurious duplicate is recoverable via merge later; an UPDATE that overwrites durable evidence/fix/principle sections is data loss recoverable only via git history.",
    "",
    "Update body-preservation contract (when you DO choose update):",
    "- For update, compiled_truth should be the new current best truth, not an append-only delta. But: PRESERVE the neighbor's Evidence, Fix, Principle, code-example, and similarly-load-bearing sections VERBATIM unless the candidate explicitly contradicts a specific sentence in them. Removing such a section because the candidate 'no longer discusses it' is the bug. The candidate's compiled_truth is a DELTA proposal; you must integrate it into the existing body, not replace the body.",
    "- The candidate's title is a HINT, not a directive. Do NOT change the neighbor's title via the title patch field unless the candidate's title genuinely renames the same claim (e.g. fixing a typo). If the candidate's title describes a different claim than the neighbor's title, that is a strong signal you should CREATE, not UPDATE.",
    "- trigger_phrases on update: UNION the existing trigger_phrases with the candidate's, do not REPLACE. Drop existing phrases only if they describe a sub-claim the candidate explicitly retires; otherwise keep all old phrases (they are retrieval anchors, losing them breaks future memory_search). If you want to fully replace trigger_phrases, you almost certainly meant CREATE.",
    "",
    "- timeline_note should be short and evidence-based.",
    "- Do not invent slugs. update/merge/archive/delete/supersede slugs must be one of the neighbor slugs.",
    "- Cross-scope wikilink hygiene (soft, prefer but not strict): if compiled_truth references entries outside this project, prefer the explicit scope prefix `[[world:slug]]` (for ~/.abrain/knowledge/ maxims and durable knowledge), `[[workflow:slug]]` (for ~/.abrain/workflows/ pipelines), or `[[project:<projectId>:slug]]` (for other projects). Bare `[[slug]]` resolves to the current project by default and to global as fallback during read, but explicit prefixes reduce future graph-rewrite work. Do not invent slugs you have not seen.",
    "",
    "Scope stickiness (CRITICAL — added 2026-05-14 after world-scope neighbor pool opened):",
    "- Scope is immutable on update/merge/archive/supersede/delete. You MUST NOT change an entry's scope via these operations. The scope shown in the neighbor header is authoritative.",
    "- If a project-scope candidate matches a world-scope neighbor by topic but adds project-specific evidence: output CREATE (scope: project), NOT update the world entry. The world entry is the general principle; the project entry is a specialization.",
    "- If a world-scope candidate (a cross-project maxim/principle) matches an existing world entry: output UPDATE or MERGE or SKIP, NOT create. World store must self-evolve, not grow append-only duplicates.",
    "- If a world-scope candidate matches a project entry by topic and the project entry's claim is fully subsumed by the candidate: output CREATE (scope: world) for the world entry. In a future pass the world entry may be linked to supersede the project entry; do not attempt to do both in one decision.",
    "- Wikilink target discipline: `[[...]]` MUST point to an existing abrain memory entry slug (one of the neighbor slugs shown below, or a global maxim/workflow slug you have memory_search'd for). ADR files (`docs/adr/00XX-name.md`), source code paths, file basenames, section anchors, and external URLs MUST be referenced in PROSE — NEVER as `[[...]]`. Forms like `[[project:foo:0018-some-adr]]` are bugs: that target is not an abrain entry, doctor-lite will report it as a dead link, and `memory_search` won't find it. Write `documented in ADR 0018 (docs/adr/0018-some-adr.md)` or `see the brain-redesign-spec` instead.",
    "- Preserve existing wikilinks verbatim when merging. Only change a `[[...]]` form if you are deliberately re-pointing it; never silently drop or rewrite an existing link's slug.",
    "- Example update line: `This refines [[world:reduce-complexity-before-adding-branches]] in the writer-substrate context.`",
    "",
    "Candidate:",
    "<<<SEDIMENT_CANDIDATE",
    `title: ${draft.title}`,
    `kind: ${draft.kind}`,
    draft.status ? `status: ${draft.status}` : undefined,
    draft.confidence !== undefined ? `confidence: ${draft.confidence}` : undefined,
    "",
    draft.compiledTruth,
    "SEDIMENT_CANDIDATE>>>",
    "",
    "Neighbors:",
    "<<<SEDIMENT_NEIGHBORS",
    neighbors.length ? neighbors.map(entryForPrompt).join("\n\n---\n\n") : "(none)",
    "SEDIMENT_NEIGHBORS>>>",
  ].filter((x): x is string => x !== undefined).join("\n");
}

async function callCuratorModel(
  settings: SedimentSettings,
  modelRegistry: ModelRegistryLike,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = parseModelRef(settings.curatorModel);
  if (!parsed) throw new Error(`invalid sediment.curatorModel: ${settings.curatorModel || "<empty>"}; expected provider/model`);
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`sediment curator model not found in registry: ${settings.curatorModel}`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(`sediment curator auth unavailable: ${auth.error || "missing api key"}`);

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai");

  const stream = piAi.streamSimple(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: settings.curatorTimeoutMs, maxRetries: settings.curatorMaxRetries },
  );
  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(finalMsg.errorMessage || finalMsg.stopReason);
  }
  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error("sediment curator returned empty text");
  return rawText;
}

export async function curateProjectDraft(
  draft: ProjectEntryDraft,
  deps: {
    projectRoot: string;
    sedimentSettings: SedimentSettings;
    memorySettings: MemorySettings;
    modelRegistry: ModelRegistryLike;
    signal?: AbortSignal;
  },
): Promise<CuratorOutcome> {
  const totalStart = Date.now();
  const searchStart = Date.now();
  let entries: MemoryEntry[];
  let cards: any[];
  try {
    entries = relevantEntriesForCurator(await loadEntries(deps.projectRoot, deps.memorySettings, deps.signal));
    cards = await llmSearchEntries(
      entries,
      { query: makeSearchPrompt(draft), filters: { limit: 5, status: ["all"] } },
      deps.memorySettings,
      deps.modelRegistry,
      deps.signal,
      deps.projectRoot,
    ) as any[];
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    const searchMs = Date.now() - searchStart;
    const decision: CuratorDecision = { op: "skip", reason: "curator_search_error", rationale: error };
    return {
      decision,
      audit: { decision, neighbors: [], stage_ms: { search: searchMs, decide: 0, total: Date.now() - totalStart }, error },
    };
  }
  const searchMs = Date.now() - searchStart;
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  const neighbors = cards
    .map((card: any) => bySlug.get(String(card.slug)))
    .filter((entry): entry is MemoryEntry => !!entry);
  const neighborAudit = cards.map((card: any) => ({
    slug: String(card.slug),
    ...(typeof card.score === "number" ? { score: card.score } : {}),
    ...(typeof card.rank_reason === "string" ? { rank_reason: card.rank_reason } : {}),
  }));

  // Even with zero neighbors, run the curator model: it can still classify
  // scope (project vs world) and produce a richer rationale. Skipping the
  // curator on empty neighbors used to force-create project-scope entries
  // for all candidates that happened to have no memory_search hits.
  if (neighbors.length === 0) {
    // fall through to curator call below
  }

  const decideStart = Date.now();
  try {
    const raw = await callCuratorModel(
      deps.sedimentSettings,
      deps.modelRegistry,
      makeCuratorPrompt(draft, neighbors),
      deps.signal,
    );
    const decision = parseDecision(raw, new Set(neighbors.map((entry) => entry.slug)));
    const decideMs = Date.now() - decideStart;
    return {
      decision,
      audit: { decision, neighbors: neighborAudit, stage_ms: { search: searchMs, decide: decideMs, total: Date.now() - totalStart } },
    };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    const decision: CuratorDecision = { op: "skip", reason: "curator_error", rationale: error };
    const decideMs = Date.now() - decideStart;
    return {
      decision,
      audit: { decision, neighbors: neighborAudit, stage_ms: { search: searchMs, decide: decideMs, total: Date.now() - totalStart }, error },
    };
  }
}
