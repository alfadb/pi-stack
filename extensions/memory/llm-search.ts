import type { MemorySettings } from "./settings";
import type { MemoryEntry, SearchFilters, SearchParams } from "./types";
import { relationValues } from "./parser";
import { entryMatchesFilters } from "./search";
import { clamp, normalizeBareSlug, stableUnique } from "./utils";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface CandidatePick {
  slug: string;
  reason?: string;
}

interface FinalPick {
  slug: string;
  score?: number;
  why?: string;
}

interface ModelCallResult {
  rawText: string;
  stopReason?: string;
}

const STAGE1_TIMEOUT_MS = 120_000;
const STAGE2_TIMEOUT_MS = 180_000;
const STAGE_MAX_RETRIES = 1;
const MAX_STAGE2_ENTRY_CHARS = 12_000;

function parseModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function assertModelRegistry(modelRegistry: unknown): asserts modelRegistry is ModelRegistryLike {
  const reg = modelRegistry as ModelRegistryLike | undefined;
  if (!reg || typeof reg.find !== "function" || typeof reg.getApiKeyAndHeaders !== "function") {
    throw new Error("memory_search LLM path requires ctx.modelRegistry; set MEMORY_SEARCH_GREP_ONLY=1 to use grep fallback");
  }
}

async function callSearchModel(
  modelRef: string,
  prompt: string,
  modelRegistry: ModelRegistryLike,
  signal?: AbortSignal,
  timeoutMs = STAGE1_TIMEOUT_MS,
): Promise<ModelCallResult> {
  const parsed = parseModelRef(modelRef);
  if (!parsed) throw new Error(`invalid memory.search model ref: ${modelRef || "<empty>"}; expected provider/model`);

  const model = modelRegistry.find(parsed.provider, parsed.id);
  if (!model) throw new Error(`memory.search model not found in registry: ${modelRef}`);

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`memory.search model auth unavailable for ${modelRef}: ${auth.error || "missing api key"}`);
  }

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: unknown[] },
      config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai");

  const stream = piAi.streamSimple(
    model,
    {
      messages: [{
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp: Date.now(),
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      timeoutMs,
      maxRetries: STAGE_MAX_RETRIES,
    },
  );

  const finalMsg = await stream.result();
  if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
    throw new Error(`memory.search ${modelRef} failed: ${finalMsg.errorMessage || finalMsg.stopReason}`);
  }

  const rawText = (finalMsg.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (!rawText) throw new Error(`memory.search ${modelRef} returned empty text`);
  return { rawText, stopReason: finalMsg.stopReason };
}

function kindLabel(kind: string): string {
  if (kind.endsWith("s")) return kind;
  if (kind === "maxim") return "maxims";
  if (kind === "decision") return "decisions";
  if (kind === "smell") return "staging";
  if (kind === "anti-pattern") return "anti-patterns";
  return `${kind}s`;
}

function entryDate(entry: MemoryEntry): string {
  return entry.updated || entry.created || "";
}

function sortForIndex(a: MemoryEntry, b: MemoryEntry): number {
  if (a.kind !== b.kind) return kindLabel(a.kind).localeCompare(kindLabel(b.kind));
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const ad = entryDate(a);
  const bd = entryDate(b);
  if (ad !== bd) return bd.localeCompare(ad);
  return a.slug.localeCompare(b.slug);
}

function buildLlmIndexText(entries: MemoryEntry[]): string {
  const lines: string[] = [
    "# Memory Search Index",
    "",
    `> Generated in-memory for ADR 0015 LLM stage-1 candidate selection | ${entries.length} entries`,
    "",
    "## Entries",
    "",
  ];

  let currentKind = "";
  for (const entry of entries.slice().sort(sortForIndex)) {
    const label = kindLabel(entry.kind);
    if (label !== currentKind) {
      currentKind = label;
      lines.push(`### ${label}`, "");
    }

    const meta: string[] = [
      `kind: ${entry.kind}`,
      `status: ${entry.status}`,
      `confidence: ${entry.confidence}`,
    ];
    const date = entryDate(entry);
    if (date) meta.push(`updated: ${date}`);

    const triggers = relationValues(entry.frontmatter.trigger_phrases)
      .map((t) => t.trim())
      .filter(Boolean);
    const related = entry.relatedSlugs.slice(0, 8);
    const summary = (entry.summary || "").replace(/\s+/g, " ").trim();

    lines.push(`#### [[${entry.slug}]] — ${entry.title.replace(/\s+/g, " ").trim()}`);
    lines.push(`- ${meta.join(" | ")}`);
    if (triggers.length > 0) lines.push(`- trigger: ${JSON.stringify(triggers)}`);
    if (related.length > 0) lines.push(`- related: ${JSON.stringify(related)}`);
    if (summary) lines.push(`- summary: ${summary}`);
    lines.push("");
  }

  return lines.join("\n");
}

function unwrapJsonText(rawText: string): unknown {
  const raw = rawText.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [raw, fence?.[1]?.trim()].filter((x): x is string => !!x);

  for (const text of candidates) {
    try {
      return JSON.parse(text);
    } catch {
      // keep trying below
    }
  }

  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(raw.slice(arrayStart, arrayEnd + 1));
    } catch {
      // fall through
    }
  }

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    try {
      return JSON.parse(raw.slice(objectStart, objectEnd + 1));
    } catch {
      // fall through
    }
  }

  throw new Error(`LLM did not return parseable JSON: ${raw.slice(0, 300)}`);
}

function asArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["results", "candidates", "entries", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function parseCandidatePicks(rawText: string): CandidatePick[] {
  const payload = asArrayPayload(unwrapJsonText(rawText));
  const out: CandidatePick[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      const slug = normalizeBareSlug(item);
      if (slug) out.push({ slug });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = normalizeBareSlug(String(obj.slug ?? obj.id ?? obj.entry ?? ""));
    if (!slug) continue;
    const reason = obj.reason ?? obj.why;
    out.push({ slug, ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}) });
  }
  const seen = new Set<string>();
  return out.filter((pick) => {
    if (seen.has(pick.slug)) return false;
    seen.add(pick.slug);
    return true;
  });
}

function parseFinalPicks(rawText: string): FinalPick[] {
  const payload = asArrayPayload(unwrapJsonText(rawText));
  const out: FinalPick[] = [];
  for (const item of payload) {
    if (typeof item === "string") {
      const slug = normalizeBareSlug(item);
      if (slug) out.push({ slug });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const slug = normalizeBareSlug(String(obj.slug ?? obj.id ?? obj.entry ?? ""));
    if (!slug) continue;
    const scoreRaw = obj.score ?? obj.relevance ?? obj.relevance_score;
    const score = typeof scoreRaw === "number" ? scoreRaw : typeof scoreRaw === "string" ? Number(scoreRaw) : undefined;
    const why = obj.why ?? obj.reason ?? obj.analysis;
    out.push({
      slug,
      ...(Number.isFinite(score) ? { score: score as number } : {}),
      ...(typeof why === "string" && why.trim() ? { why: why.trim() } : {}),
    });
  }
  const seen = new Set<string>();
  return out.filter((pick) => {
    if (seen.has(pick.slug)) return false;
    seen.add(pick.slug);
    return true;
  });
}

function makeStage1Prompt(query: string, indexText: string, limit: number): string {
  return [
    "You are pi-astack memory search candidate selector.",
    "",
    "Task: given a user query and a markdown index of all knowledge entries, select entries that are most likely relevant.",
    "Output JSON only: an array of objects [{\"slug\": string, \"reason\": string}]. No markdown wrapper.",
    "",
    "Hard rules:",
    "- The query may be a natural-language prompt OR a keyword phrase. Treat both as user intent.",
    "- The query may be Chinese, English, or mixed. Match across languages semantically, not just literally (e.g. 沉淀 ≡ sediment, 自动写入 ≡ auto-write).",
    "- Prefer entries whose title, summary, trigger_phrases, or related slugs match query intent.",
    "- Prefer recent and high-confidence entries over stale/low-confidence ones, all else equal.",
    "- Do not invent slugs. Return only slugs present in the index.",
    `- Return at most ${limit} items. If nothing is relevant, return [].`,
    "",
    "Index:",
    "<<<MEMORY_SEARCH_INDEX",
    indexText,
    "MEMORY_SEARCH_INDEX>>>",
    "",
    `Query: ${query}`,
  ].join("\n");
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 120);
  return [
    text.slice(0, head),
    `\n\n[... truncated ${text.length - head - tail} chars from middle for context budget ...]\n\n`,
    text.slice(text.length - tail),
  ].join("");
}

function entryForStage2(entry: MemoryEntry): string {
  const triggers = relationValues(entry.frontmatter.trigger_phrases);
  const pieces = [
    `## ${entry.slug}`,
    `title: ${entry.title}`,
    `kind: ${entry.kind}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    entry.created ? `created: ${entry.created}` : undefined,
    entry.updated ? `updated: ${entry.updated}` : undefined,
    triggers.length ? `trigger_phrases: ${JSON.stringify(triggers)}` : undefined,
    entry.relatedSlugs.length ? `related_slugs: ${JSON.stringify(entry.relatedSlugs.slice(0, 20))}` : undefined,
    "",
    "### summary",
    entry.summary,
    "",
    "### compiled_truth",
    entry.compiledTruth,
    "",
    "### timeline",
    entry.timeline.length ? entry.timeline.join("\n") : "(none)",
  ].filter((x): x is string => x !== undefined).join("\n");
  return truncateMiddle(pieces, MAX_STAGE2_ENTRY_CHARS);
}

function makeStage2Prompt(query: string, candidates: MemoryEntry[], limit: number): string {
  return [
    "You are pi-astack memory search final ranker.",
    "",
    `Task: given a user query and ${candidates.length} candidate knowledge entries (full content), rank them by relevance and output the top ${limit}.`,
    "Output JSON only: an array of objects [{\"slug\": string, \"score\": number, \"why\": string}]. Score is 0-10 relevance.",
    "",
    "Hard rules:",
    "- Read each entry's compiled_truth AND timeline. Timeline may refine, supersede, or invalidate compiled_truth; reflect this in ranking.",
    "- Match Chinese/English/mixed intent semantically, not literally.",
    "- Prefer the most directly useful entry for the query over broad background entries.",
    "- If an entry is obsolete/superseded by another candidate, rank the newer/superseding one higher.",
    "- Do not invent slugs. Return only slugs present in Candidates.",
    "- If nothing is relevant, return [].",
    "",
    `Query: ${query}`,
    "",
    "Candidates:",
    "<<<MEMORY_SEARCH_CANDIDATES",
    candidates.map(entryForStage2).join("\n\n---\n\n"),
    "MEMORY_SEARCH_CANDIDATES>>>",
  ].join("\n");
}

function resultCard(entry: MemoryEntry, score: number) {
  return {
    slug: entry.slug,
    title: entry.title,
    summary: entry.summary,
    score: Number(clamp(score, 0, 1).toFixed(4)),
    kind: entry.kind,
    status: entry.status,
    confidence: entry.confidence,
    degraded: false,
    related_slugs: entry.relatedSlugs.slice(0, 5),
  };
}

function rankFromStage1(entriesBySlug: Map<string, MemoryEntry>, picks: CandidatePick[], limit: number) {
  const hits = picks
    .map((pick, i) => {
      const entry = entriesBySlug.get(pick.slug);
      if (!entry) return undefined;
      const score = picks.length <= 1 ? 1 : 1 - (i / Math.max(1, picks.length - 1)) * 0.35;
      return resultCard(entry, score);
    })
    .filter((x): x is ReturnType<typeof resultCard> => !!x);
  return hits.slice(0, limit);
}

function rankFromStage2(entriesBySlug: Map<string, MemoryEntry>, picks: FinalPick[], limit: number) {
  const hits = picks
    .map((pick, i) => {
      const entry = entriesBySlug.get(pick.slug);
      if (!entry) return undefined;
      const rawScore = typeof pick.score === "number" && Number.isFinite(pick.score)
        ? pick.score
        : Math.max(0, 10 - i);
      const normalized = rawScore > 1 ? rawScore / 10 : rawScore;
      return resultCard(entry, normalized);
    })
    .filter((x): x is ReturnType<typeof resultCard> => !!x)
    .sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function filteredEntries(entries: MemoryEntry[], filters: SearchFilters | undefined): MemoryEntry[] {
  return entries.filter((entry) => entryMatchesFilters(entry, filters));
}

export function shouldUseGrepSearch(settings: MemorySettings): boolean {
  return process.env.MEMORY_SEARCH_GREP_ONLY === "1" || !settings.search.stage1Model.trim();
}

export async function llmSearchEntries(
  entries: MemoryEntry[],
  params: SearchParams,
  settings: MemorySettings,
  modelRegistryRaw: unknown,
  signal?: AbortSignal,
) {
  const query = String(params.query ?? "").trim();
  if (!query) return [];

  assertModelRegistry(modelRegistryRaw);
  const modelRegistry = modelRegistryRaw;

  const filters = params.filters ?? {};
  const finalLimit = clamp(
    Math.floor(filters.limit ?? settings.search.stage2Limit ?? settings.defaultLimit),
    1,
    settings.maxLimit,
  );
  const candidateLimit = Math.max(finalLimit, Math.floor(settings.search.stage1Limit));
  const stage2Model = settings.search.stage2Model.trim();

  const corpus = filteredEntries(entries, filters);
  if (corpus.length === 0) return [];

  const indexText = buildLlmIndexText(corpus);
  const stage1 = await callSearchModel(
    settings.search.stage1Model,
    makeStage1Prompt(query, indexText, candidateLimit),
    modelRegistry,
    signal,
    STAGE1_TIMEOUT_MS,
  );
  const stage1Picks = parseCandidatePicks(stage1.rawText).slice(0, candidateLimit);
  if (stage1Picks.length === 0) return [];

  const entriesBySlug = new Map(corpus.map((entry) => [entry.slug, entry]));
  const candidateEntries = stableUnique(stage1Picks.map((pick) => pick.slug))
    .map((slug) => entriesBySlug.get(slug))
    .filter((entry): entry is MemoryEntry => !!entry);

  if (candidateEntries.length === 0) return [];
  if (!stage2Model || candidateEntries.length <= settings.search.stage2SkipThreshold) {
    return rankFromStage1(entriesBySlug, stage1Picks, finalLimit);
  }

  const stage2 = await callSearchModel(
    stage2Model,
    makeStage2Prompt(query, candidateEntries, finalLimit),
    modelRegistry,
    signal,
    STAGE2_TIMEOUT_MS,
  );
  const stage2Picks = parseFinalPicks(stage2.rawText);
  if (stage2Picks.length === 0) return [];
  return rankFromStage2(entriesBySlug, stage2Picks, finalLimit);
}
