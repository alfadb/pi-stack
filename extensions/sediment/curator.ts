import * as path from "node:path";
import type { MemorySettings } from "../memory/settings";
import { loadEntries } from "../memory/parser";
import { llmSearchEntries } from "../memory/llm-search";
import type { MemoryEntry } from "../memory/types";
import type { SedimentSettings } from "./settings";
import type { ProjectEntryDraft, ProjectEntryUpdateDraft } from "./writer";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

export type CuratorDecision =
  | { op: "create"; rationale?: string }
  | { op: "update"; slug: string; patch: ProjectEntryUpdateDraft; rationale?: string }
  | { op: "delete"; slug: string; reason: string; rationale?: string }
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

const CURATOR_TIMEOUT_MS = 180_000;
const CURATOR_MAX_RETRIES = 0;

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
    return { op: "update", slug, patch, ...(rationale ? { rationale } : {}) };
  }

  if (op === "delete") {
    const slug = asString(obj.slug);
    if (!slug || !allowedSlugs.has(slug)) throw new Error(`curator delete slug is not an allowed neighbor: ${slug || "<missing>"}`);
    return { op: "delete", slug, reason: asString(obj.reason) ?? rationale ?? "deleted by sediment curator", ...(rationale ? { rationale } : {}) };
  }

  if (op === "create") {
    return { op: "create", ...(rationale ? { rationale } : {}) };
  }

  throw new Error(`unsupported curator op: ${op || "<missing>"}`);
}

function projectEntriesOnly(entries: MemoryEntry[], projectRoot: string): MemoryEntry[] {
  const pensieveRoot = path.join(path.resolve(projectRoot), ".pensieve") + path.sep;
  return entries.filter((entry) => entry.scope === "project" && path.resolve(entry.sourcePath).startsWith(pensieveRoot));
}

function entryForPrompt(entry: MemoryEntry): string {
  return [
    `## ${entry.slug}`,
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

function makeCuratorPrompt(draft: ProjectEntryDraft, neighbors: MemoryEntry[]): string {
  return [
    "You are pi-astack sediment curator.",
    "Your job is to maintain the current best knowledge state, not append duplicate notes.",
    "Decide whether the candidate should create a new memory, update an existing memory, or be skipped.",
    "Output JSON only, one object. No markdown wrapper.",
    "",
    "Allowed operations for this implementation batch:",
    "- {\"op\":\"create\", \"rationale\": string}",
    "- {\"op\":\"update\", \"slug\": one_of_neighbors, \"patch\": {\"title\"?: string, \"kind\"?: string, \"status\"?: string, \"confidence\"?: number, \"compiled_truth\"?: string, \"trigger_phrases\"?: string[]}, \"timeline_note\": string, \"rationale\": string}",
    "- {\"op\":\"skip\", \"reason\": string, \"rationale\": string}",
    "- {\"op\":\"delete\", \"slug\": one_of_neighbors, \"reason\": string, \"rationale\": string}",
    "",
    "Rules:",
    "- Prefer update over create when the candidate refines, implements, corrects, or supersedes a neighbor.",
    "- Prefer skip when the candidate adds no durable information beyond a neighbor.",
    "- Use create only when no neighbor is the same evolving knowledge unit.",
    "- Use delete only for clear junk/noise or when the candidate establishes that an existing neighbor should be removed rather than archived/updated. Git history is the rollback surface.",
    "- For update, compiled_truth should be the new current best truth, not an append-only delta. Preserve useful stable context from the old entry when needed.",
    "- timeline_note should be short and evidence-based.",
    "- Do not invent slugs. Update slug must be one of the neighbor slugs.",
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
  const parsed = parseModelRef(settings.extractorModel);
  if (!parsed) throw new Error(`invalid sediment.extractorModel: ${settings.extractorModel || "<empty>"}; expected provider/model`);
  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`sediment curator model not found in registry: ${settings.extractorModel}`);
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
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { apiKey: auth.apiKey, headers: auth.headers, signal, timeoutMs: CURATOR_TIMEOUT_MS, maxRetries: CURATOR_MAX_RETRIES },
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
    entries = projectEntriesOnly(await loadEntries(deps.projectRoot, deps.memorySettings, deps.signal), deps.projectRoot);
    cards = await llmSearchEntries(
      entries,
      { query: makeSearchPrompt(draft), filters: { limit: 5, status: ["all"] } },
      deps.memorySettings,
      deps.modelRegistry,
      deps.signal,
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

  if (neighbors.length === 0) {
    const decision: CuratorDecision = { op: "create", rationale: "no relevant existing project memory found" };
    return { decision, audit: { decision, neighbors: neighborAudit, stage_ms: { search: searchMs, decide: 0, total: Date.now() - totalStart } } };
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
