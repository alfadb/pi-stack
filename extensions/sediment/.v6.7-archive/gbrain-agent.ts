/**
 * sediment/gbrain-agent — single-agent evaluator + writer with lookup tools.
 *
 * Replaces the v6.5 multi-model voter pipeline (3 voters × full-history
 * JSON output + quorum) with a single agent loop. Same architecture as
 * pi-sediment/gbrain-agent.ts but adapted for the v6 ctx + ModelRegistry,
 * targeting only gbrain (pensieve removed per ADR 0005).
 *
 * The agent emits ONE terminal output:
 *   - "SKIP"                       → no insight worth saving
 *   - "SKIP_DUPLICATE: slug ..."   → existing page already covers it
 *   - "## GBRAIN ..." block        → write (mode=update keeps slug; mode=new fresh)
 *
 * Why markdown not JSON:
 *   - LLMs reliably emit prose-prefixed code-blocked JSON, breaking
 *     strict parse. Markdown with sentinel headers (## GBRAIN, __CONTENT__)
 *     never trips on language wrapping or chinese prose preambles.
 *   - Frees the model from escape gymnastics for content fields.
 *
 * Why one model not three:
 *   - The "voting" defense was theoretical; in practice all three voters
 *     see the same prompt and drift the same direction.
 *   - lookup tools (gbrain_search/get) provide stronger duplicate
 *     prevention than majority vote ever could.
 */

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { runAgentLoop } from "./agent-loop";
import { buildLookupTools } from "./lookup-tools";
import type { TrackConfig } from "./tracks";
import { buildSystemPrompt } from "./tracks";

// ── Output parsing ─────────────────────────────────────────────

export type GbrainAgentResult =
  | { kind: "skip" }
  | { kind: "skip_duplicate"; slug: string; reason: string }
  | { kind: "page"; output: GbrainPageOutput }
  | { kind: "parse_failure"; rawText: string };

export interface GbrainPageOutput {
  title: string;
  tags: string[];
  content: string;
  /** When mode=update, the slug to overwrite; otherwise undefined. */
  updateSlug?: string;
}

function extractField(header: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = header.match(regex);
  return match?.[1]?.trim() ?? null;
}

export function parseGbrainAgentOutput(text: string): GbrainAgentResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "parse_failure", rawText: text };

  // Terminal A: SKIP exactly
  if (/^SKIP\s*$/.test(trimmed)) return { kind: "skip" };

  // Terminal B: SKIP_DUPLICATE: <slug> [— reason]
  const dupMatch = trimmed.match(/^SKIP_DUPLICATE:\s*(\S+)\s*(?:[—\-]\s*(.*))?$/m);
  if (dupMatch) {
    return {
      kind: "skip_duplicate",
      slug: dupMatch[1],
      reason: (dupMatch[2] ?? "").trim(),
    };
  }

  // Terminal C/D: ## GBRAIN block (strip optional code-fence wrapping)
  let clean = trimmed
    .replace(/^```(?:markdown|md)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const headerRegex = /^#{2,3}\s+GBRAIN\s*$/mi;
  const match = clean.match(headerRegex);
  if (!match || match.index === undefined) {
    return { kind: "parse_failure", rawText: text };
  }
  const raw = clean.slice(match.index + match[0].length).trim();

  const contentIdx = raw.search(/__CONTENT__/i);
  if (contentIdx === -1) return { kind: "parse_failure", rawText: text };

  const header = raw.slice(0, contentIdx).trim();
  const content = raw.slice(contentIdx + "__CONTENT__".length).trim().replace(/^\n+/, "");
  if (!content || content.length < 60) return { kind: "parse_failure", rawText: text };

  let title = extractField(header, "title");
  if (!title) {
    const h1 = content.match(/^#\s+(.+)$/m);
    if (h1) title = h1[1].trim();
  }
  if (!title) return { kind: "parse_failure", rawText: text };

  const tagsRaw = extractField(header, "tags");
  let tags = tagsRaw
    ? tagsRaw.split(/[,;]/).map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];
  if (!tags.includes("engineering")) tags.unshift("engineering");

  const mode = (extractField(header, "mode") ?? "new").toLowerCase();
  let updateSlug: string | undefined;
  if (mode === "update") {
    const rawSlug = extractField(header, "update_slug");
    if (rawSlug) {
      const cleaned = rawSlug
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      if (cleaned) updateSlug = cleaned;
    }
  }

  return {
    kind: "page",
    output: { title, tags, content, ...(updateSlug ? { updateSlug } : {}) },
  };
}

// ── System prompt ──────────────────────────────────────────────
//
// Per-track system prompts now live in tracks.ts (PROJECT_TRACK_PROMPT,
// WORLD_TRACK_PROMPT). buildSystemPrompt(track) returns the right one with
// $\{SOURCE_ID\} interpolation. The single GBRAIN_AGENT_PROMPT export was
// removed when we moved to the two-track design (project + world).

export function buildAgentUserPrompt(args: {
  dateIso: string;
  windowText: string;
  truncated: boolean;
  entryCount: number;
  gbrainColdStart: boolean;
  trackName: "project" | "world";
  sourceId?: string;
}): string {
  const coldStartNote = args.gbrainColdStart
    ? "\n\nNOTE: This source is nearly empty (< 10 pages). " +
      "If you find ANY insight at the right layer, lean toward NEW."
    : "";
  const truncNote = args.truncated
    ? "\n[note: older entries truncated to fit the window]"
    : "";
  const trackBanner = args.trackName === "project"
    ? `Track: project (source: ${args.sourceId ?? "<unset>"})`
    : `Track: world (source: default)`;
  return `Date: ${args.dateIso}\n${trackBanner}\n\n` +
    `Use the read-only tools to investigate existing memory before deciding. ` +
    `Then emit your terminal output.${coldStartNote}\n\n` +
    `Recent agent_end window (${args.entryCount} entries${truncNote}):\n\n` +
    `<window>\n${args.windowText}\n</window>`;
}

// ── Public API ─────────────────────────────────────────────────

export interface RunGbrainAgentArgs {
  /** Track-specific config (model, reasoning, source, etc.). */
  track: TrackConfig;
  registry: ModelRegistry;
  windowText: string;
  truncated: boolean;
  entryCount: number;
  dateIso: string;
  gbrainColdStart: boolean;
  signal: AbortSignal;
  onEvent?: (ev: any) => void;
}

export interface RunGbrainAgentReturn {
  result: GbrainAgentResult;
  rawText: string;
  turns: number;
  toolCalls: number;
  stopReason: string;
  ok: boolean;
  errorMessage?: string;
}

export async function runGbrainAgent(args: RunGbrainAgentArgs): Promise<RunGbrainAgentReturn> {
  const m = args.registry.find(args.track.modelProvider, args.track.modelId);
  if (!m) {
    return {
      result: { kind: "parse_failure", rawText: "" },
      rawText: "",
      turns: 0,
      toolCalls: 0,
      stopReason: "model_not_found",
      ok: false,
      errorMessage: `model not found: ${args.track.modelProvider}/${args.track.modelId}`,
    };
  }

  const auth = await args.registry.getApiKeyAndHeaders(m);
  if (!auth.ok || !auth.apiKey) {
    return {
      result: { kind: "parse_failure", rawText: "" },
      rawText: "",
      turns: 0,
      toolCalls: 0,
      stopReason: "auth_failed",
      ok: false,
      errorMessage: `auth failed: ${(auth as any).error ?? "no api key"}`,
    };
  }

  const { tools, handlers } = buildLookupTools();
  const systemPrompt = buildSystemPrompt(args.track);
  const userPrompt = buildAgentUserPrompt({
    dateIso: args.dateIso,
    windowText: args.windowText,
    truncated: args.truncated,
    entryCount: args.entryCount,
    gbrainColdStart: args.gbrainColdStart,
    trackName: args.track.name,
    sourceId: args.track.source ?? undefined,
  });

  const loopResult = await runAgentLoop({
    model: m,
    apiKey: auth.apiKey,
    headers: auth.headers,
    systemPrompt,
    userPrompt,
    tools,
    handlers,
    signal: args.signal,
    maxTokens: args.track.maxTokens,
    reasoning: args.track.reasoning,
    onEvent: args.onEvent,
  });

  if (!loopResult.ok) {
    return {
      result: { kind: "parse_failure", rawText: loopResult.finalText },
      rawText: loopResult.finalText,
      turns: loopResult.turns,
      toolCalls: loopResult.toolCalls,
      stopReason: loopResult.stopReason,
      ok: false,
      errorMessage: loopResult.errorMessage,
    };
  }

  const parsed = parseGbrainAgentOutput(loopResult.finalText);
  return {
    result: parsed,
    rawText: loopResult.finalText,
    turns: loopResult.turns,
    toolCalls: loopResult.toolCalls,
    stopReason: loopResult.stopReason,
    ok: parsed.kind !== "parse_failure",
  };
}
