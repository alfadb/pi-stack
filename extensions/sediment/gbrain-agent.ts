/**
 * pi-sediment gbrain agent — merged evaluator + writer with lookup tools.
 *
 * Replaces the previous two-call pipeline (evaluateForGbrain → writeForGbrain)
 * with a single agent loop. The model uses lookup tools to investigate
 * existing memory in both gbrain and pensieve, then emits a terminal output:
 *
 *   - "SKIP"                     → no insight worth saving
 *   - "SKIP_DUPLICATE: slug ..." → existing page already covers it
 *   - "## GBRAIN ..."            → write (mode=update keeps slug; mode=new fresh)
 *
 * Output parsing reuses the existing writer.ts protocol so we don't
 * duplicate the format-error handling logic.
 */

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatModelRef, loadConfig } from "./config.js";
import { runAgentLoop } from "./agent-loop.js";
import { buildLookupTools } from "./lookup-tools.js";
import { GBRAIN_AGENT_PROMPT, buildGbrainAgentPrompt, sanitizeContent } from "./prompts.js";
import { logLine, sanitizeSlug, saveParseFailure } from "./utils.js";
import type { GbrainWriteOutput, ResolvedModel, TargetStatus } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────

async function resolveModel(
  registry: ModelRegistry,
  projectRoot: string,
): Promise<ResolvedModel | { error: string }> {
  const config = loadConfig(projectRoot);
  const m = registry.find(config.model.provider, config.model.modelId);
  if (!m) return { error: `model not found: ${formatModelRef(config.model)}` };
  const auth = await registry.getApiKeyAndHeaders(m);
  if (!auth.ok) return { error: `auth failed: ${auth.error}` };
  if (!auth.apiKey) return { error: "no api key" };
  return { model: m, apiKey: auth.apiKey, headers: auth.headers, display: formatModelRef(config.model) };
}


function extractField(header: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(.+)$`, "mi");
  const match = header.match(regex);
  return match?.[1]?.trim() ?? null;
}

// ── Output parsing ────────────────────────────────────────────

export type GbrainAgentResult =
  | { kind: "skip" }
  | { kind: "skip_duplicate"; slug: string; reason: string }
  | { kind: "page"; output: GbrainWriteOutput }
  | { kind: "parse_failure"; rawText: string };

function parseGbrainAgentOutput(text: string, projectRoot: string): GbrainAgentResult {
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

  // Terminal C/D: ## GBRAIN block
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

  // Extract title from header (or fall back to # heading in content).
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

  // Optional update_slug only honored when mode=update; otherwise we derive
  // a fresh slug from title (sanitizeSlug, applied by the gbrain target).
  const mode = (extractField(header, "mode") ?? "new").toLowerCase();
  let updateSlug: string | undefined;
  if (mode === "update") {
    const raw = extractField(header, "update_slug");
    if (raw) {
      const cleaned = raw
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      updateSlug = cleaned || undefined;
      if (!updateSlug) {
        logLine(projectRoot, `gbrain-agent parse:warn invalid update_slug=\"${raw}\" — falling back to NEW`);
      }
    } else {
      logLine(projectRoot, `gbrain-agent parse:warn mode=update without update_slug — falling back to NEW`);
    }
  }

  // Sanitize. On hit treat as skip (not parse_failure): a parse_failure
  // makes the scheduler retry the same window, which will produce similar
  // content and trip the filter again. Drop the write and advance the
  // checkpoint; future windows can re-discover the insight.
  //
  // Save the rejected payload to .pi-sediment/parse-failures/ so we can
  // post-mortem WHICH content tripped the filter. Without this trail, a
  // false-positive sanitizer hit (or a regression in legitimate writer
  // output) is invisible — we'd see only the log line and the lost
  // checkpoint window, with no way to inspect the actual rejected text.
  if (!sanitizeContent(content)) {
    saveParseFailure(content, projectRoot, "injection", "gbrain-agent");
    logLine(projectRoot, `gbrain-agent sanitize:reject — dropping write, advancing checkpoint (saved to parse-failures/)`);
    return { kind: "skip" };
  }

  return {
    kind: "page",
    output: { title, tags, content, ...(updateSlug ? { updateSlug } : {}) },
  };
}

// ── Public ─────────────────────────────────────────────────────

export interface GbrainAgentArgs {
  lastAssistantMessage: string;
  dateIso: string;
  targets: TargetStatus;
  projectRoot: string;
  registry: ModelRegistry;
}

export async function runGbrainAgent(args: GbrainAgentArgs): Promise<GbrainAgentResult> {
  const config = loadConfig(args.projectRoot);
  const tag = "gbrain-agent";

  const resolved = await resolveModel(args.registry, args.projectRoot);
  if ("error" in resolved) {
    logLine(args.projectRoot, `${tag} model:error ${resolved.error}`);
    return { kind: "parse_failure", rawText: "" };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), config.writeTimeoutMs);

  try {
    const { tools, handlers } = buildLookupTools(args.projectRoot);
    const userPrompt = buildGbrainAgentPrompt({
      dateIso: args.dateIso,
      lastAssistantMessage: args.lastAssistantMessage,
      gbrainColdStart: args.targets.gbrain && (args.targets.gbrainPageCount ?? 999) < 10,
    });

    const result = await runAgentLoop({
      model: resolved.model,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      systemPrompt: GBRAIN_AGENT_PROMPT,
      userPrompt,
      tools,
      handlers,
      signal: ac.signal,
      maxTokens: 16384,
      reasoning: config.reasoning,
      onEvent: (ev) => {
        if (ev.kind === "tool_call") {
          logLine(args.projectRoot, `${tag} tool:${ev.name} args=${ev.argSummary.slice(0, 120)}`);
        } else if (ev.kind === "tool_result") {
          logLine(args.projectRoot, `${tag} tool:${ev.name} → ${ev.ok ? "ok" : "err"} bytes=${ev.bytes}`);
        } else if (ev.kind === "llm_done" && ev.stopReason !== "stop") {
          logLine(args.projectRoot, `${tag} llm turn=${ev.turn} stop=${ev.stopReason} toolCalls=${ev.toolCalls}`);
        }
      },
    });

    if (!result.ok) {
      logLine(
        args.projectRoot,
        `${tag} agent:${result.stopReason} ${result.errorMessage ?? ""} turns=${result.turns} toolCalls=${result.toolCalls}`,
      );
      return { kind: "parse_failure", rawText: result.finalText };
    }

    logLine(args.projectRoot, `${tag} agent:done turns=${result.turns} toolCalls=${result.toolCalls}`);
    const parsed = parseGbrainAgentOutput(result.finalText, args.projectRoot);

    if (parsed.kind === "skip") {
      logLine(args.projectRoot, `${tag} decision:skip`);
    } else if (parsed.kind === "skip_duplicate") {
      logLine(args.projectRoot, `${tag} decision:skip_duplicate slug=${parsed.slug} reason=\"${parsed.reason.slice(0, 120)}\"`);
    } else if (parsed.kind === "page") {
      const note = parsed.output.updateSlug
        ? `UPDATE slug=${parsed.output.updateSlug}`
        : `NEW slug=${sanitizeSlug(parsed.output.title)}`;
      logLine(args.projectRoot, `${tag} decision:write ${note} title=\"${parsed.output.title.slice(0, 80)}\"`);
    } else {
      logLine(args.projectRoot, `${tag} parse:fail rawlen=${result.finalText.length}`);
    }

    return parsed;
  } finally {
    clearTimeout(timer);
  }
}
