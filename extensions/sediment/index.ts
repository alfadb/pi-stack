/**
 * pi-sediment extension — automatic insight capture engine.
 *
 * Architecture:
 *   - agent_end only marks each target's pending head entry.
 *   - Each target has an independent checkpoint scheduler, not a FIFO queue.
 *   - A run evaluates the whole window from lastProcessedEntryId to pendingHeadEntryId.
 *   - New turns arriving during a run coalesce into the next pending window.
 *   - Workers are never interrupted by the main session; only internal timeouts apply.
 */

import type {
  AgentEndEvent,
  ExtensionAPI,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { detectTargets } from "./detector.js";
import {
  registerScheduler,
  markPending,
  onPhaseChange,
  type RunResult,
  type RunWindow,
  type SchedulerPhase,
} from "./scheduler.js";
import { runGbrainAgent } from "./gbrain-agent.js";
import {
  searchGbrainForLinks,
  writeToGbrainWithRetry,
  type GbrainTranslateFn,
} from "./targets/gbrain.js";
import { writePensieve } from "./pensieve-writer.js";
import { loadConfig } from "./config.js";
import { logLine } from "./utils.js";
import { completeSimple } from "@mariozechner/pi-ai";
import type { TargetStatus } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Helpers ────────────────────────────────────────────────────


const STATUS_PENSIEVE = "pi-sediment-pensieve";
const STATUS_GBRAIN = "pi-sediment-gbrain";
// Legacy single-key status from before per-target split. Kept only so we
// can clear any stale value left in a host UI from older versions.
const STATUS_LEGACY = "pi-sediment";

/**
 * True when the host pi process is a one-shot subprocess spawned by another
 * pi (e.g. by pi-multi-agent's print/rpc backends). Such subprocesses inherit
 * the project cwd, but they should NOT run sediment because:
 *   1. The conversation is ephemeral / non-interactive; results aren't a
 *      durable engineering insight worth persisting.
 *   2. Multiple subprocesses run in parallel against the same .pensieve/ +
 *      .pi-sediment/state.json — they race on the checkpoint file and
 *      corrupt each other's state (observed: same window processed by two
 *      parallel workers, retryCount thrash).
 *   3. They re-enter the gbrain agent loop, which would itself spawn more
 *      subprocesses if any tool used multi-dispatch (no recursion guard).
 *
 * Detection uses argv: pi-multi-agent's backends always pass `--print` or
 * `--mode rpc`. Interactive main pi has neither. We also honor an explicit
 * env opt-out so callers can suppress sediment without depending on argv.
 */
function isSubprocessPi(): boolean {
  if (process.env.PI_SEDIMENT_DISABLE === "1") return true;
  const argv = process.argv.slice(2);
  if (argv.includes("--print")) return true;
  const modeIdx = argv.indexOf("--mode");
  if (modeIdx >= 0 && argv[modeIdx + 1] === "rpc") return true;
  return false;
}

/**
 * Classify the most recent assistant message's stop reason. Sediment
 * processes only "clean" turns; everything else is skipped to avoid
 * persisting half-truths or rejected content to long-term memory.
 *
 * Stop-reason coverage (pi-ai types StopReason):
 *   stop     → normal completion, persist
 *   toolUse  → tool round; pi will emit another agent_end after the next
 *              completion, so we treat the *current* event as
 *              persistable too (the final turn's stopReason will be
 *              stop|error|aborted, and that's what gates the actual
 *              window). Also persistable.
 *   aborted  → user ESC. Skip: user explicitly rejected this output.
 *   error    → upstream/network/protocol failure (e.g. sub2api SSE EOF).
 *              Skip: the visible message is whatever bytes happened to
 *              flush before the disconnect, often half a sentence or
 *              an incomplete tool call. Even with retry-stream-eof.ts
 *              auto-retrying, *this* agent_end fires once with the
 *              broken message before the retry succeeds. Without this
 *              skip, sediment would feed garbage to the writer agent
 *              and either parse_failure (advancing checkpoint past the
 *              real turn) or pollute memory.
 *   length   → hit maxTokens. Skip: the assistant was mid-thought when
 *              cut off; persisting a truncated argument or list yields
 *              dangling references that confuse future reads. Rare in
 *              practice (pi's defaults are generous).
 *
 * Reads `messages` off AgentEndEvent (not ctx.sessionManager) so we
 * examine the exact set of messages that just completed, not whatever
 * the session has accumulated since.
 */
function shouldSkipForStopReason(messages: any[] | undefined): { skip: boolean; reason: string } {
  if (!Array.isArray(messages)) return { skip: false, reason: "" };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const sr = m.stopReason;
    if (sr === "aborted") return { skip: true, reason: "aborted (user ESC)" };
    if (sr === "error")   return { skip: true, reason: `error (${String(m.errorMessage ?? "unknown").slice(0, 80)})` };
    if (sr === "length")  return { skip: true, reason: "length (maxTokens reached)" };
    return { skip: false, reason: "" };
  }
  return { skip: false, reason: "" };
}

function setStatus(ctx: any, key: string, value: string | undefined): void {
  // Defensive: ctx may be stale (session replaced/reloaded since the closure
  // captured it). Even reading ctx.hasUI on a stale ctx throws — so the
  // guard must live INSIDE the try. If this leaks out of a worker promise,
  // the scheduler interprets it as failure and the retry-loop bug returns.
  try {
    if (!ctx?.hasUI) return;
    ctx.ui.setStatus(key, value);
  } catch { /* stale ctx / print / rpc mode */ }
}

/**
 * Map a scheduler phase to its UI glyph. Worker code never writes status
 * directly — the scheduler is the single source of truth for what's
 * happening per target, and the UI is just a projection.
 *
 *   idle    → cleared (undefined)
 *   pending → ⏱ (queued, includes retry-backoff windows)
 *   running → ⏳ (worker actively executing)
 */
function phaseGlyph(target: string, phase: SchedulerPhase): string | undefined {
  if (phase === "idle") return undefined;
  const tag = target === "pensieve" ? "Pz" : "Gb";
  return phase === "running" ? `⏳ ${tag}` : `⏱ ${tag}`;
}

function statusKeyFor(target: string): string {
  return target === "pensieve" ? STATUS_PENSIEVE : STATUS_GBRAIN;
}

// ── gbrain translation (non-Latin → English) ────────────────────

const TRANSLATE_SYSTEM_PROMPT = `You are a technical translator. Your ONLY job is to translate the given technical content to English.

Rules:
- Preserve ALL technical accuracy, terms, and code references
- Keep the same structure (sections, lists, etc.)
- Output ONLY the translated content, no preamble or commentary
- Both the title and body must be in English`;

async function translateGbrainEntry(
  entry: { title: string; tags: string[]; content: string },
  projectRoot: string,
  registry: any,
): Promise<{ title: string; tags: string[]; content: string } | null> {
  const config = loadConfig(projectRoot);
  const model = registry.find(config.model.provider, config.model.modelId);
  if (!model) return null;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), 30_000);

  try {
    const prompt = [
      "Translate the following technical content to English.",
      "",
      `Title: ${entry.title}`,
      "",
      "Body:",
      entry.content,
    ].join("\n");

    const response = await completeSimple(
      model,
      {
        systemPrompt: TRANSLATE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: ac.signal,
        maxTokens: 8192,
      },
    );

    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      return null;
    }

    const text = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const lines = text.trim().split("\n");
    const engTitle = lines[0]?.replace(/^#+\s*/, "").trim();
    const engBody = lines.slice(1).join("\n").trim();

    if (!engTitle || !engBody) return null;

    const { sanitizeContent } = await import("./prompts.js");
    const safeContent = sanitizeContent(engBody);
    if (!safeContent) {
      logLine(projectRoot, `gbrain translate: rejected (injection pattern)`);
      return null;
    }

    return {
      title: engTitle.slice(0, 200),
      tags: entry.tags,
      content: safeContent,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── gbrain pipeline (with parse:fail retry) ────────────────────

async function processGbrain(
  window: RunWindow,
  targets: TargetStatus,
  registry: any,
): Promise<RunResult> {
  logLine(window.projectRoot, `gbrain window: entries=${window.entryCount} from=${window.fromEntryId ?? "START"} to=${window.toEntryId}`);

  const dateIso = window.sourceDateIso ?? new Date().toISOString().slice(0, 10);

  // The agent does eval + write in a single tool-using loop; it self-checks
  // existing memory via lookup tools (gbrain_search/get, pensieve_grep/read)
  // and decides skip / skip_duplicate / update / new.
  const result = await runGbrainAgent({
    lastAssistantMessage: window.text,
    dateIso,
    targets,
    projectRoot: window.projectRoot,
    registry,
  });

  if (result.kind === "skip") return "processed";
  if (result.kind === "skip_duplicate") {
    logLine(window.projectRoot, `sediment done: gbrain=skip_duplicate`);
    return "processed";
  }
  if (result.kind === "parse_failure") {
    // Deterministic: the model's terminal output was malformed (no SKIP,
    // no SKIP_DUPLICATE, no ## GBRAIN). With the same prompt + same source,
    // a retry produces the same malformed output — burns minutes for no
    // progress. Advance the checkpoint; future windows can re-discover the
    // insight. We mark this as "processed" rather than failed_permanent
    // because semantically the window IS done; there's just no page to
    // write. The scheduler treats both identically (advance + reset retry).
    logLine(window.projectRoot, `gbrain pipeline: parse failure — dropping write, advancing checkpoint`);
    return "processed";
  }

  // Auxiliary: enrich frontmatter with related[] from a cheap server search.
  // The agent picks the slug (NEW or UPDATE); related[] is metadata only.
  const relatedPages = await searchGbrainForLinks(result.output.title, window.projectRoot);
  const relatedTitles = relatedPages
    .map((p) => p.title.replace(/^#+\s*/, "").replace(/\s+/g, " ").trim())
    .filter((t) => Boolean(t) && t !== result.output.title)
    .slice(0, 5);
  const enriched = relatedTitles.length > 0
    ? { ...result.output, related: relatedTitles }
    : result.output;

  const translateFn: GbrainTranslateFn = async (entry, attempt) =>
    translateGbrainEntry(entry, window.projectRoot, registry);

  const ok = await writeToGbrainWithRetry(enriched, window.projectRoot, translateFn);
  logLine(window.projectRoot, `sediment done: gbrain=${ok ? "✓" : "✗"}`);
  // gbrain CLI write failures are typically transient (network, throttle,
  // gbrain server restart). The retry helper inside writeToGbrainWithRetry
  // already exhausts internal retries before returning false; classifying
  // as failed_retryable lets the scheduler take one more shot on its own
  // backoff schedule (covers cross-process gbrain unavailability windows
  // longer than the inner 1+2s retry budget). Truly deterministic write
  // refusals (e.g. content too large — see writeToGbrain) already log
  // their reason and won't recover via retry; the MAX_RETRIES_RETRYABLE
  // safety net force-advances after ~5 minutes of attempts.
  return ok ? "processed" : "failed_retryable";
}

// ── Pensieve pipeline (single LLM call: evaluate + write) ─────

async function processPensieve(
  window: RunWindow,
  registry: any,
): Promise<RunResult> {
  logLine(window.projectRoot, `pensieve window: entries=${window.entryCount} from=${window.fromEntryId ?? "START"} to=${window.toEntryId}`);

  const status = await writePensieve(window.text, window.projectRoot, registry);
  if (status === "written") {
    logLine(window.projectRoot, `sediment done: pensieve=✓`);
    return "processed";
  }
  if (status === "skipped") {
    return "processed";
  }

  // pensieve-writer's only "failed" path is auth/model resolution errors
  // and uncaught exceptions. Both are deterministic for the current
  // configuration; retrying with the same model/key set produces the same
  // failure. Classify as permanent so the scheduler force-advances
  // immediately rather than burning 8 retries on a bad config.
  logLine(window.projectRoot, `sediment done: pensieve=✗ (permanent — likely model/auth)`);
  return "failed_permanent";
}

// ── Extension entry ────────────────────────────────────────────

export default function piSediment(pi: ExtensionAPI) {
  let targets: TargetStatus = {
    pensieve: false,
    gbrain: false,
    gbrainPageCount: null,
  };
  // Live ctx, refreshed on every session_start and agent_end. The phase
  // listener (registered once per process) reads this to write the bottom
  // bar against whatever session is currently alive. Never captured by
  // worker closures.
  let lastCtx: any = null;
  let phaseListenerAttached = false;

  pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
    // Subprocess pi (multi-agent print/rpc) must not run sediment. Detect
    // once at session_start; cwd-bound subprocess detection won't change.
    if (isSubprocessPi()) {
      logLine(ctx.cwd, `sediment disabled: subprocess pi (argv=${process.argv.slice(2).join(" ")})`);
      targets = { pensieve: false, gbrain: false, gbrainPageCount: null };
      return;
    }
    targets = await detectTargets(ctx.cwd);
    lastCtx = ctx;

    // Clear the legacy unsplit key once — harmless on hosts that never had it.
    setStatus(ctx, STATUS_LEGACY, undefined);

    // Subscribe ONCE per process. The scheduler's `states` Map and listener
    // set are module-scope, so subscribing again on every session_start
    // would leak listeners and double-write status.
    if (!phaseListenerAttached) {
      phaseListenerAttached = true;
      onPhaseChange((target, phase) => {
        setStatus(lastCtx, statusKeyFor(target), phaseGlyph(target, phase));
      });
    }

    // CRITICAL: worker closures must NOT capture `ctx`. The ctx supplied to
    // session_start becomes stale once the host swaps sessions (newSession,
    // fork, switchSession, reload), and any property access on a stale ctx
    // throws. Workers run inside the scheduler's promise chain, so a throw
    // there is interpreted as failure — retryCount climbs forever even
    // though the actual write may have succeeded.
    //
    // The fix has two halves:
    //  (1) Workers read modelRegistry off `window` (snapshotted from the
    //      live agent_end ctx), not off any captured `ctx`.
    //  (2) Workers do not write the UI at all. Status is driven by the
    //      scheduler's phase listener using `lastCtx` — which is updated
    //      on every event, so it can never go stale within the same
    //      synchronous chain that emits the phase change.
    if (targets.pensieve) {
      registerScheduler("pensieve", async (window: RunWindow) => {
        return await processPensieve(window, window.modelRegistry);
      });
    } else {
      // Target disabled — ensure any leftover status from a prior session is gone.
      setStatus(ctx, STATUS_PENSIEVE, undefined);
    }

    if (targets.gbrain) {
      registerScheduler("gbrain", async (window: RunWindow) => {
        return await processGbrain(window, targets, window.modelRegistry);
      });
    } else {
      setStatus(ctx, STATUS_GBRAIN, undefined);
    }
  });

  pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
    // Refresh live ctx for the phase listener; if the listener fires after
    // this event, it will write to the fresh ctx.
    lastCtx = ctx;

    if (!targets.pensieve && !targets.gbrain) return;

    // Failed/aborted/truncated turn: skip sediment so we don't persist
    // half-truths or user-rejected content to long-term memory. The
    // conversation head still advances when the next *clean* turn
    // completes; sediment will pick that up on the next agent_end.
    //
    // Notably this catches the upstream-EOF case: when sub2api drops the
    // SSE stream mid-response, pi emits agent_end with stopReason=error
    // *before* retry-stream-eof.ts's transparent auto-retry succeeds.
    // Without this guard we'd sediment whatever half-byte flushed before
    // the disconnect.
    const skipCheck = shouldSkipForStopReason((event as any).messages);
    if (skipCheck.skip) {
      logLine(ctx.cwd, `agent_end: skipping sediment — ${skipCheck.reason}`);
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const head = branch[branch.length - 1];
    if (!head?.id) return;

    const snapshot = {
      sessionId: ctx.sessionManager.getSessionFile?.() ?? ctx.sessionManager.getSessionId?.() ?? "ephemeral",
      projectRoot: ctx.cwd,
      headEntryId: head.id,
      // Shallow-copy the branch array so subsequent in-place mutations
      // (compaction, branch_summary insertion, fork) don't reshuffle the
      // entries the scheduler is iterating. The entry OBJECTS are still
      // shared (cheap), but their order in this snapshot is frozen at
      // agent_end time — which is what buildRunWindow's findIndex needs.
      // Without this, a long-running worker can come back to an array
      // whose entry IDs are reshuffled, producing -1 from findIndex and a
      // silent dropped window.
      entries: [...branch],
      // Snapshot the live registry; workers use this instead of any captured ctx.
      modelRegistry: ctx.modelRegistry,
    };

    // markPending will emit the phase transition ("pending" or "running"
    // depending on whether tick can run synchronously). Do NOT setStatus
    // here — it would either be overwritten in the same microtask
    // (when tick runs sync → "running") or wrongly stomp a still-running
    // worker's ⏳ with a misleading ⏱ (when tick early-exits).
    if (targets.pensieve) markPending("pensieve", snapshot);
    if (targets.gbrain) markPending("gbrain", snapshot);
  });
}
