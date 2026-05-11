/**
 * sediment extension for pi-astack — project-only markdown writer.
 *
 * agent_end pipeline (in order):
 *   1. Synchronous ctx capture (cwd / branch / sessionId / notify) to
 *      survive stale-ctx invalidation during async work.
 *   2. Ephemeral session early-return (--no-session, dispatch_agent
 *      subprocesses, CI). Records a single audit row and returns.
 *   3. buildRunWindow over the per-session checkpoint slot.
 *   4. parseExplicitMemoryBlocks (deterministic, fence-aware). Always
 *      attempted. If hit, write each block via writeProjectEntry.
 *   5. When (4) yielded zero blocks AND autoLlmWriteEnabled gates pass,
 *      the LLM auto-write lane runs in the background. ADR 0016 changes
 *      the default posture from mechanical semantic gates to an LLM-curator
 *      posture: the LLM decides whether a durable candidate is worth
 *      writing; hard gates are reserved for sensitive information and
 *      storage integrity.
 *      No dry-run/readiness/rate/sampling/rolling semantic gates remain.
 *      Git history + audit are the rollback surface; hard gates are only
 *      standard write-side defenses (sensitive-info sanitizer, schema,
 *      lint, lock, atomic write, audit).
 *   6. Lane A advances checkpoint after terminal write outcomes. Lane C
 *      optimistically advances before bg work because auto-write is
 *      best-effort, not an authoritative replay queue.
 *   7. Audit row.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSedimentSettings, type SedimentSettings } from "./settings";
import { buildRunWindow, checkpointSummary, loadSessionCheckpoint, saveSessionCheckpoint, type RunWindow } from "./checkpoint";
import { curateProjectDraft, type CuratorAudit } from "./curator";
import { detectProjectDuplicate } from "./dedupe";
import { parseExplicitMemoryBlocks, previewExtraction } from "./extractor";
import { runLlmExtractor, summarizeLlmExtractorResult, type LlmExtractorResult } from "./llm-extractor";
import { listMigrationBackups, migrateOne, restoreMigrationBackup } from "./migration";
import { resolveSettings as resolveMemorySettings } from "../memory/settings";

import { appendAudit, archiveProjectEntry, deleteProjectEntry, mergeProjectEntries, supersedeProjectEntry, updateProjectEntry, writeProjectEntry, type ProjectEntryDraft, type WriteProjectEntryResult, type WriterAuditContext } from "./writer";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";

// ---------------------------------------------------------------
// Phase 1.4 A2 / ADR 0016: in-process bg work tracking.
//
// We intentionally keep only an in-flight guard. Older readiness/rate/
// sampling/rolling Maps were removed when sediment became an LLM curator:
// git + audit are the rollback surface; semantic hard gates are gone.
// ---------------------------------------------------------------

/**
 * sessionId -> in-flight Promise of the background LLM-extraction work.
 *
 * agent_end intentionally does NOT await this promise. The handler
 * captures everything it needs synchronously, schedules the bg work,
 * and returns immediately so the user's main session is not blocked
 * on a 30s LLM call (observed live post-A2: pi shows "Working" for
 * the entire LLM duration if we await here).
 *
 * If a NEW agent_end fires while the previous turn's bg work is
 * still running, we silently do nothing for the new turn: no audit,
 * no checkpoint advance. The next agent_end after the bg worker drains
 * starts from the checkpoint advanced by that previous sediment run.
 */
const autoWriteInFlight = new Map<string, Promise<void>>();

/** Track agent_start/end balance per session. When ended >= started,
 *  the main-session LLM is in agent_end state (finished, not working) —
 *  safe for bg drain. When started > ended, the LLM is working — drain
 *  must wait for the next agent_end. */
const sessionAgentCycle = new Map<string, { started: number; ended: number }>();

/** Status key for ctx.ui.setStatus(). */
const SEDIMENT_STATUS_KEY = FOOTER_STATUS_KEYS.sediment;

/**
 * Footer status state machine for the sediment extension.
 *
 *   idle      Pi is loaded; sediment is enabled; no extraction work
 *             is currently in progress (either nothing has run yet,
 *             or the last activity already flushed back to idle on
 *             a fresh agent_start).
 *
 *   running   The agent_end handler is currently running the explicit
 *             write loop (synchronous, fast) OR has scheduled
 *             background LLM auto-write that is still in flight.
 *
 *   completed The most recent extraction finished successfully
 *             (writes succeeded, lint clean, audit row written) or
 *             produced no entries in a healthy way (the LLM returned
 *             SKIP, or the curator chose skip).
 *
 *   failed    The most recent extraction hit an error path: lint /
 *             validation reject, LLM call errored, or bg work threw.
 *
 * Transitions, per user spec (2026-05-08):
 *   - session_start                          -> idle (always)
 *   - agent_start while in completed/failed  -> idle (reset)
 *   - agent_start while in running           -> running (unchanged)
 *   - agent_end                              -> running -> completed/failed
 */
type SedimentStatus = "idle" | "running" | "completed" | "failed";

const sedimentStatusBySession = new Map<string, SedimentStatus>();

/** Exported for smoke regression. Do not rely on this signature
 *  outside test code; the formatting is informational. */
export function renderSedimentStatus(state: SedimentStatus, detail?: string): string {
  const prefix = (() => {
    switch (state) {
      case "idle":      return "💤 sediment idle";
      case "running":   return "📝 sediment running";
      case "completed": return "✅ sediment completed";
      case "failed":    return "⚠️  sediment failed";
    }
  })();
  return detail ? `${prefix}: ${detail}` : prefix;
}

/**
 * Apply a sediment status to ctx.ui.setStatus and remember it under
 * the sessionId. Both setStatus and sessionId may be undefined (older
 * pi version without setStatus, or ephemeral session); the function
 * tolerates both. The setStatus call is always wrapped in try/catch
 * so a stale-ctx late fire from background work never throws.
 */
function applySedimentStatus(
  setStatus: ((msg?: string) => void) | undefined,
  sessionId: string | undefined,
  state: SedimentStatus,
  detail?: string,
): void {
  if (sessionId) sedimentStatusBySession.set(sessionId, state);
  if (!setStatus) return;
  try {
    setStatus(renderSedimentStatus(state, detail));
  } catch { /* stale ctx late fire is best-effort */ }
}

function shouldAdvanceAfterResults(results: WriteProjectEntryResult[]): boolean {
  const terminalReasons = new Set([
    "duplicate_slug", "validation_error", "lint_error",
  ]);
  return results.every((result) => {
    if (result.status === "created" || result.status === "updated" || result.status === "merged" || result.status === "archived" || result.status === "superseded" || result.status === "deleted" || result.status === "skipped" || result.status === "dry_run") return true;
    if (!result.reason) return false;
    return terminalReasons.has(result.reason) || result.reason.startsWith("credential pattern detected");
  });
}

function safeAuditIdPart(value: string | undefined, fallback: string): string {
  const cleaned = (value || fallback).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(-24);
}

function makeCorrelationId(lane: "explicit" | "auto_write", sessionId: string, window: RunWindow): string {
  return `${lane}-${safeAuditIdPart(sessionId, "session")}-${safeAuditIdPart(window.lastEntryId, "entry")}-${Date.now().toString(36)}`;
}

function candidateIdFor(correlationId: string, index: number): string {
  return `${correlationId}:c${index + 1}`;
}

function resultSummary(result: WriteProjectEntryResult) {
  return {
    status: result.status,
    slug: result.slug,
    reason: result.reason,
    path: result.path,
    deleteMode: result.deleteMode,
    lintErrors: result.lintErrors,
    lintWarnings: result.lintWarnings,
    validationErrors: result.validationErrors,
    duplicate: result.duplicate,
    sanitizedReplacements: result.sanitizedReplacements,
    gitCommit: result.gitCommit,
    correlation_id: result.correlationId,
    candidate_id: result.candidateId,
  };
}

function registerSedimentCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[]; getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null }; modelRegistry?: unknown; signal?: AbortSignal; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("sediment", {
    description: "Sediment status/dedupe/migration-backups/migrate-one: /sediment status, /sediment dedupe --title <title>, /sediment migration-backups [--limit N], /sediment migrate-one --plan <file>, /sediment migrate-one --apply --yes <file>, /sediment migrate-one --restore <backup> --yes",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "dedupe --title ", "migration-backups", "migration-backups --limit ", "migrate-one --plan ", "migrate-one --apply --yes ", "migrate-one --restore "];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[]; getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null }; modelRegistry?: unknown; signal?: AbortSignal; ui: { notify(message: string, type?: string): void } }) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const settings = resolveSedimentSettings();
      const sessionId = readSessionId(ctx.sessionManager);
      const [subcommand = "status", ...rest] = args.trim() ? args.trim().split(/\s+/) : [];

      if (subcommand === "status") {
        ctx.ui.notify(
          [
            `Sediment enabled: ${settings.enabled}`,
            `Git commit: ${settings.gitCommit}`,
            `Lock timeout: ${settings.lockTimeoutMs}ms`,
            `Window: min=${settings.minWindowChars} chars, max=${settings.maxWindowChars} chars, entries=${settings.maxWindowEntries}`,
            `LLM extractor model: ${settings.extractorModel}`,
            `Auto LLM write enabled: ${settings.autoLlmWriteEnabled}`,
            "Auto LLM extractor: LIVE on agent_end after explicit MEMORY miss; no dry-run/readiness/rate/sampling/rolling semantic gates",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "migration-backups") {
        const limitFlagIndex = rest.indexOf("--limit");
        const limitRaw = limitFlagIndex >= 0 ? Number(rest[limitFlagIndex + 1]) : undefined;
        const result = await listMigrationBackups(cwd, resolveMemorySettings(), limitRaw);
        ctx.ui.notify(JSON.stringify(result, null, 2), result.returned > 0 ? "info" : "warning");
        return;
      }

      if (subcommand === "dedupe") {
        const titleFlagIndex = rest.indexOf("--title");
        const title = titleFlagIndex >= 0 ? rest.slice(titleFlagIndex + 1).join(" ").trim() : rest.join(" ").trim();
        if (!title) {
          ctx.ui.notify("Usage: /sediment dedupe --title <title>", "warning");
          return;
        }
        const result = await detectProjectDuplicate(cwd, title);
        ctx.ui.notify(JSON.stringify(result, null, 2), result.duplicate ? "warning" : "info");
        return;
      }

      if (subcommand === "migrate-one") {
        const plan = rest.includes("--plan");
        const apply = rest.includes("--apply");
        const restore = rest.includes("--restore");
        const yes = rest.includes("--yes");
        const fileParts = rest.filter((part) => part !== "--plan" && part !== "--apply" && part !== "--restore" && part !== "--yes");
        const source = fileParts.join(" ").trim();
        const modeCount = [plan, apply, restore].filter(Boolean).length;
        if (!source || modeCount !== 1) {
          ctx.ui.notify("Usage: /sediment migrate-one --plan <file> OR /sediment migrate-one --apply --yes <file> OR /sediment migrate-one --restore <backup> --yes", "warning");
          return;
        }
        if (restore) {
          const result = await restoreMigrationBackup(source, {
            projectRoot: cwd,
            sedimentSettings: settings,
            memorySettings: resolveMemorySettings(),
            yes,
          });
          ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "restored" ? "info" : "warning");
          return;
        }
        const result = await migrateOne(source, {
          projectRoot: cwd,
          sedimentSettings: settings,
          memorySettings: resolveMemorySettings(),
          apply,
          yes,
          plan,
        });
        ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "applied" || result.status === "dry_run" ? "info" : "warning");
        return;
      }

      ctx.ui.notify("Usage: /sediment status OR /sediment dedupe --title <title> OR /sediment migration-backups [--limit N] OR /sediment migrate-one --plan <file> OR /sediment migrate-one --apply --yes <file> OR /sediment migrate-one --restore <backup> --yes", "warning");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSedimentCommand(pi);

  // Footer state machine: session_start always sets idle.
  // Used cast for ctx.ui because older pi versions may not expose
  // setStatus; applySedimentStatus already tolerates undefined.
  pi.on("session_start", async (_event: unknown, ctx: { sessionManager?: { getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null }; ui?: { setStatus?(extId: string, message?: string): void } }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;
    const sessionId = readSessionId(ctx.sessionManager);
    const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
    const setStatus = setStatusRaw
      ? (msg?: string) => { try { setStatusRaw(SEDIMENT_STATUS_KEY, msg); } catch {} }
      : undefined;
    applySedimentStatus(setStatus, sessionId, "idle");
  });

  // Footer state machine: agent_start resets completed/failed back to
  // idle so each new prompt starts visually clean. running stays
  // unchanged so a long-running bg work from the previous turn
  // remains visible.
  pi.on("agent_start", async (_event: unknown, ctx: { sessionManager?: { getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null }; ui?: { setStatus?(extId: string, message?: string): void } }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;
    const sessionId = readSessionId(ctx.sessionManager);
    if (!sessionId) return;
    const c = sessionAgentCycle.get(sessionId) ?? { started: 0, ended: 0 };
    c.started++;
    sessionAgentCycle.set(sessionId, c);
    const prev = sedimentStatusBySession.get(sessionId);
    if (prev !== "completed" && prev !== "failed") return;  // running -> stay; idle -> already idle
    const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
    const setStatus = setStatusRaw
      ? (msg?: string) => { try { setStatusRaw(SEDIMENT_STATUS_KEY, msg); } catch {} }
      : undefined;
    applySedimentStatus(setStatus, sessionId, "idle");
  });

  pi.on("agent_end", async (event: { messages?: ReadonlyArray<{ role?: string; stopReason?: string; errorMessage?: string }> }, ctx: {
    cwd?: string;
    sessionManager?: { getBranch(): unknown[]; getSessionId?(): string | undefined | null; getSessionFile?(): string | undefined | null };
    modelRegistry?: unknown;
    signal?: AbortSignal;
    ui?: {
      notify(message: string, type?: string): void;
      setStatus?(extId: string, message?: string): void;
    };
  }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;

    // Capture everything we need from `ctx` SYNCHRONOUSLY before the first
    // await. pi may invalidate ctx ("stale ctx") if newSession/fork/reload
    // happens during our async work; touching ctx after invalidation
    // throws "Extension error: stale ctx". Capturing values upfront makes
    // the rest of the handler ctx-independent.
    const cwd = path.resolve(ctx.cwd || process.cwd());
    if (!ctx.sessionManager?.getBranch) return;
    let branch: unknown[];
    try {
      branch = ctx.sessionManager.getBranch();
    } catch {
      // ctx already stale at hook entry — skip silently.
      return;
    }
    const sessionId = readSessionId(ctx.sessionManager);
    // Track agent_end for drain-loop gating (only drain when LLM not working).
    if (sessionId) {
      const c = sessionAgentCycle.get(sessionId) ?? { started: 0, ended: 0 };
      c.ended++;
      sessionAgentCycle.set(sessionId, c);
    }
    // Capture getBranch for drain-loop re-reads (bg work outlives ctx).
    const getBranch = ctx.sessionManager.getBranch.bind(ctx.sessionManager);
    const notify = ctx.ui?.notify?.bind(ctx.ui);
    // setStatus is ctx.ui.setStatus; we need to bind it AND tolerate
    // older pi versions where the method is missing. Wrap in a
    // try/catch so a stale-ctx late call cannot throw out of bg work.
    const setStatusRaw = ctx.ui?.setStatus?.bind(ctx.ui);
    const setStatus = setStatusRaw
      ? (msg?: string) => { try { setStatusRaw(SEDIMENT_STATUS_KEY, msg); } catch {} }
      : undefined;
    // Capture EVERY ctx field we'll need post-await synchronously.
    // pi may invalidate ctx ("stale ctx") between any await pair if a
    // newSession/fork/reload/process-shutdown race fires; touching
    // ctx after invalidation throws "Extension error: stale ctx". Do NOT
    // pass ctx.signal into fire-and-forget LLM work: it is tied to the
    // foreground turn lifecycle and gets aborted when the user continues,
    // which would cancel sediment mid-flight.
    const modelRegistry = ctx.modelRegistry;
    const settingsSnapshot = snapshotSedimentSettings(settings);

    // Ephemeral sessions (`pi --print --no-session`, dispatch_agent
    // subprocess, CI / automation) refuse to run the deterministic
    // extractor entirely.
    //
    // Rationale:
    //   - Subagents return their output to the calling session via
    //     tool_result; that real session's own agent_end hook will see
    //     the subagent's content (including any MEMORY: blocks) and
    //     sediment it there. Running sediment in the subprocess too is
    //     redundant.
    //   - `--no-session` is a user-explicit "throwaway" signal; writing
    //     to .pensieve/ + git committing it directly contradicts that.
    //   - Attribution: an entry written from `session_id: undefined` has
    //     no session JSONL to trace back to; future debugging cannot
    //     answer "where did this come from?".
    //
    // We still record a single audit row for observability so users
    // running `tail audit.jsonl` can see ephemeral runs happened.
    if (!sessionId) {
      await appendAudit(cwd, {
        operation: "skip",
        lane: "system",
        reason: "ephemeral_session",
        ephemeral_session: true,
        branch_size: branch.length,
        settings_snapshot: settingsSnapshot,
        extractor: "explicit_marker",
        parser_version: PARSER_VERSION,
        checkpoint_advanced: false,
        stage_ms: { window_build: 0, parse: 0, write_total: 0, total: 0 },
      });
      return;
    }

    // Skip sediment when the agent loop ended unhealthy (LLM error or
    // user-abort). Per spec: do NOT advance checkpoint — the next
    // successful agent_end will re-process this window so MEMORY: blocks
    // written before the failure (or regenerated cleanly on retry) are
    // still recoverable. We still emit one audit row + a footer status
    // so the skip is visible / traceable.
    //
    // Only `error` and `aborted` are treated as unhealthy here. `length`
    // (token truncation) and `toolUse` (rare at loop end) are left in
    // the healthy path because MEMORY: blocks typically aren't at the
    // tail and may still be intact.
    const lastAssistant = [...(event.messages ?? [])]
      .reverse()
      .find((m) => m?.role === "assistant");
    const unhealthyStopReason =
      lastAssistant?.stopReason === "error"   ? "agent_error"   :
      lastAssistant?.stopReason === "aborted" ? "agent_aborted" :
      null;
    if (unhealthyStopReason) {
      await appendAudit(cwd, {
        operation: "skip",
        lane: "system",
        reason: unhealthyStopReason,
        session_id: sessionId,
        branch_size: branch.length,
        stop_reason: lastAssistant?.stopReason,
        error_message: lastAssistant?.errorMessage,
        settings_snapshot: settingsSnapshot,
        extractor: "explicit_marker",
        parser_version: PARSER_VERSION,
        checkpoint_advanced: false,
        stage_ms: { window_build: 0, parse: 0, write_total: 0, total: 0 },
      });
      const detail = unhealthyStopReason === "agent_error"
        ? "skip: agent error"
        : "skip: agent aborted";
      applySedimentStatus(setStatus, sessionId, "completed", detail);
      return;
    }

    const tStart = Date.now();
    const checkpoint = await loadSessionCheckpoint(cwd, sessionId);
    const window = buildRunWindow(branch, checkpoint, settings);
    const tWindowBuilt = Date.now();
    const summary = checkpointSummary(window);
    const entryBreakdown = countEntryTypes(window.entries);

    if (window.skipReason || !window.lastEntryId) {
      if (window.lastEntryId) await saveSessionCheckpoint(cwd, sessionId, { lastProcessedEntryId: window.lastEntryId });
      await appendAudit(cwd, {
        operation: "skip",
        lane: "window",
        reason: window.skipReason ?? "no_last_entry",
        session_id: sessionId,
        ...summary,
        extractor: "explicit_marker",
        parser_version: PARSER_VERSION,
        settings_snapshot: settingsSnapshot,
        entry_breakdown: entryBreakdown,
        stage_ms: { window_build: tWindowBuilt - tStart, parse: 0, write_total: 0, total: Date.now() - tStart },
        checkpoint_advanced: !!window.lastEntryId,
      });
      // Healthy no-op skip (window too small or empty). Mark completed
      // so the agent_start of the next prompt resets to idle.
      applySedimentStatus(setStatus, sessionId, "completed", window.skipReason ?? "no new entries");
      return;
    }

    const tParseStart = Date.now();
    const drafts = parseExplicitMemoryBlocks(window.text);
    const tParseEnd = Date.now();
    if (drafts.length === 0) {
      // Phase 1.4 A2 + UX fix: LLM auto-write lane is FIRE-AND-FORGET.
      //
      // pi awaits agent_end synchronously; if we await the LLM call
      // here, the user's main session shows "Working" for the full
      // LLM duration (~30s+). Instead:
      //   1. Optimistically advance the checkpoint past this window
      //      (we KNOW explicit-marker found 0 hits; bg work is
      //      best-effort over the same window).
      //   2. Schedule the LLM lane as background work, tracked in
      //      autoWriteInFlight Map so a re-fire on the next prompt
      //      doesn't double-spend.
      //   3. Show a footer status (ctx.ui.setStatus) while bg work
      //      runs, cleared on completion.
      //
      // Tradeoffs:
      //   - Optimistic checkpoint advance: if bg work fails, that
      //     window is gone (LLM extraction is best-effort, not
      //     authoritative). Explicit MEMORY: blocks always go
      //     through the synchronous path above so user-attested
      //     writes are never optimistically dropped.
      //   - In pi --print, the process exits after agent_end and bg
      //     work is cancelled. Acceptable: --print is one-shot.
      // ── Drain loop ─────────────────────────────────────────────
      // After a bg auto-write cycle completes, immediately check if
      // more entries accumulated while it was running. If so, start
      // another cycle without waiting for the next agent_end.
      const scheduleDrainIfBacklog = () => {
        // Only drain when the main-session LLM is NOT working
        // (agent_end fires and no new agent_start has followed).
        // If started > ended, the LLM is mid-response — the next
        // agent_end will trigger sediment naturally.
        const cyc = sessionAgentCycle.get(sessionId);
        if (!cyc || cyc.started > cyc.ended) return;

        const branchNow = getBranch();
        loadSessionCheckpoint(cwd, sessionId).then((cp) => {
          const win = buildRunWindow(branchNow, cp, settings);
          if (win.skipReason || !win.lastEntryId) return; // no backlog

          // Save checkpoint and launch another cycle
          saveSessionCheckpoint(cwd, sessionId, { lastProcessedEntryId: win.lastEntryId }).then(() => {
            applySedimentStatus(setStatus, sessionId, "running", `auto-write drain (model=${settings.extractorModel})`);
            const corrId = makeCorrelationId("auto_write", sessionId, win);
            const bg = (async () => {
              try {
                const auto = await tryAutoWriteLane({
                  cwd, sessionId, settings, window: win,
                  modelRegistry, signal: undefined, correlationId: corrId,
                });
                // ... audit + notify (same as main bg path) ...
                if (auto.kind === "wrote") {
                  await appendAudit(cwd, {
                    operation: "auto_write", lane: "auto_write",
                    session_id: sessionId, ...checkpointSummary(win),
                    extractor: "llm_extractor", parser_version: PARSER_VERSION,
                    settings_snapshot: settingsSnapshot,
                    correlation_id: corrId,
                    candidate_count: auto.drafts.length,
                    results: auto.results.map(resultSummary),
                    curator: auto.curatorAudits, llm: auto.llmAuditSummary,
                    raw_text: auto.rawTextStored,
                    raw_text_truncated: auto.rawTextTruncated,
                    checkpoint_advanced: true, background_async: true,
                  });
                  const ok = auto.results.filter(r => r.status !== "rejected" && r.status !== "skipped").length;
                  applySedimentStatus(setStatus, sessionId, "completed", `drain: ${ok} written`);
                } else {
                  applySedimentStatus(setStatus, sessionId, "completed", `drain: ${auto.kind}`);
                }
              } catch (err: any) {
                applySedimentStatus(setStatus, sessionId, "failed", `drain error: ${err?.message ?? String(err)}`);
              } finally {
                if (autoWriteInFlight.get(sessionId) === bg) autoWriteInFlight.delete(sessionId);
                scheduleDrainIfBacklog(); // recurse
              }
            })();
            autoWriteInFlight.set(sessionId, bg);
          }).catch(() => {});
        }).catch(() => {});
      };

      if (autoWriteInFlight.has(sessionId)) {
        // A previous background sediment run is still authoritative.
        // Do not advance the checkpoint and do not write audit noise:
        // the next agent_end after that worker drains will start from
        // the checkpoint advanced by the previous run and include this
        // turn's content in the next window.
        return;
      }

      // Optimistic checkpoint advance before launching bg work.
      await saveSessionCheckpoint(cwd, sessionId, { lastProcessedEntryId: window.lastEntryId });

      // Mark running BEFORE scheduling the bg promise so the footer
      // updates synchronously with agent_end. The bg promise will
      // transition to completed/failed in its finally block.
      applySedimentStatus(setStatus, sessionId, "running", `auto-write (model=${settings.extractorModel})`);
      const autoCorrelationId = makeCorrelationId("auto_write", sessionId, window);

      let bgPromise: Promise<void>;
      bgPromise = (async () => {
        try {
          const auto = await tryAutoWriteLane({
            cwd,
            sessionId,
            settings,
            window,
            modelRegistry,
            signal: undefined,
            correlationId: autoCorrelationId,
          });
          const tAutoEnd = Date.now();

          if (auto.kind === "wrote") {
            await appendAudit(cwd, {
              operation: "auto_write",
              lane: "auto_write",
              session_id: sessionId,
              ...summary,
              extractor: "llm_extractor",
              parser_version: PARSER_VERSION,
              settings_snapshot: settingsSnapshot,
              entry_breakdown: entryBreakdown,
              correlation_id: autoCorrelationId,
              candidate_count: auto.drafts.length,
              candidates: auto.drafts.map((d, i) => ({ candidate_id: candidateIdFor(autoCorrelationId, i), title: d.title, kind: d.kind, confidence: d.confidence, status: d.status, body_chars: (d.compiledTruth || "").length })),
              results: auto.results.map(resultSummary),
              curator: auto.curatorAudits,
              llm: auto.llmAuditSummary,
              raw_text: auto.rawTextStored,
              raw_text_truncated: auto.rawTextTruncated,
              stage_ms: { window_build: tWindowBuilt - tStart, parse: tParseEnd - tParseStart, llm_total: auto.llmDurationMs, write_total: tAutoEnd - auto.writeStart, total: Date.now() - tStart, background: true },
              checkpoint_advanced: true,
              background_async: true,
            });
            if (notify) {
              try {
                notify(
                  `Sediment auto-write (bg): ${auto.results.map((r) => `${r.slug}:${r.status}${r.reason ? `(${r.reason})` : ""}`).join(", ")}`,
                  "info",
                );
              } catch {}
            }
            const createdCount = auto.results.filter(r => r.status === "created").length;
            const updatedCount = auto.results.filter(r => r.status === "updated").length;
            const mergedCount = auto.results.filter(r => r.status === "merged").length;
            const archivedCount = auto.results.filter(r => r.status === "archived").length;
            const supersededCount = auto.results.filter(r => r.status === "superseded").length;
            const skippedCount = auto.results.filter(r => r.status === "skipped").length;
            const deletedCount = auto.results.filter(r => r.status === "deleted").length;
            const rejectedCount = auto.results.filter(r => r.status === "rejected").length;
            const okSummary = `${createdCount} created, ${updatedCount} updated, ${mergedCount} merged, ${archivedCount} archived, ${supersededCount} superseded, ${deletedCount} deleted, ${skippedCount} skipped`;
            if (rejectedCount > 0) {
              applySedimentStatus(setStatus, sessionId, "failed", `auto-write: ${okSummary}, ${rejectedCount} rejected`);
            } else {
              applySedimentStatus(setStatus, sessionId, "completed", `auto-write: ${okSummary}`);
            }
            return;
          }

          await appendAudit(cwd, {
            operation: "skip",
            lane: "auto_write",
            reason: auto.kind === "ineligible" ? auto.eligibility.reason ?? "auto_write_ineligible"
                  : auto.kind === "llm_skip"   ? "llm_returned_skip"
                  : auto.kind === "llm_error"  ? "llm_extraction_error"
                  : "no_explicit_memory_markers",
            session_id: sessionId,
            ...summary,
            extractor: auto.kind === "ineligible" ? "explicit_marker" : "llm_extractor",
            parser_version: PARSER_VERSION,
            settings_snapshot: settingsSnapshot,
            entry_breakdown: entryBreakdown,
            correlation_id: autoCorrelationId,
            eligibility: auto.kind === "ineligible" ? auto.eligibility : undefined,
            llm: auto.kind === "ineligible" ? undefined : auto.llmAuditSummary,
            raw_text: auto.kind === "llm_error" || auto.kind === "llm_skip" ? auto.rawTextStored : undefined,
            raw_text_truncated: auto.kind === "llm_error" || auto.kind === "llm_skip" ? auto.rawTextTruncated : undefined,
            stage_ms: { window_build: tWindowBuilt - tStart, parse: tParseEnd - tParseStart, llm_total: auto.kind === "ineligible" ? 0 : auto.llmDurationMs, write_total: 0, total: Date.now() - tStart, background: true },
            checkpoint_advanced: true,
            background_async: true,
          });
          // ineligible / llm_skip = healthy completion;
          // llm_error = failed (LLM call broke; user should know).
          if (auto.kind === "llm_error") {
            applySedimentStatus(setStatus, sessionId, "failed", `LLM error: ${auto.llmAuditSummary.error ?? "unknown"}`);
          } else if (auto.kind === "ineligible") {
            applySedimentStatus(setStatus, sessionId, "completed", auto.eligibility.reason ?? "ineligible");
          } else {
            applySedimentStatus(setStatus, sessionId, "completed", "LLM returned skip");
          }
        } catch (err: any) {
          // Last-resort failure path. Never let bg work throw out of
          // the Promise (uncaught rejection in pi can crash the
          // session).
          try {
            await appendAudit(cwd, {
              operation: "skip",
              lane: "auto_write",
              reason: "auto_write_bg_threw",
              session_id: sessionId,
              ...summary,
              extractor: "llm_extractor",
              parser_version: PARSER_VERSION,
              settings_snapshot: settingsSnapshot,
              entry_breakdown: entryBreakdown,
              correlation_id: autoCorrelationId,
              error: err?.message ?? String(err),
              checkpoint_advanced: true,
              background_async: true,
            });
          } catch {}
          applySedimentStatus(setStatus, sessionId, "failed", `bg error: ${err?.message ?? String(err)}`);
        } finally {
          // Status is already transitioned to completed/failed above.
          // Do NOT clear with setStatus(undefined) — user wants the
          // completed/failed indicator visible until the next
          // agent_start resets to idle.
          if (autoWriteInFlight.get(sessionId) === bgPromise) {
            autoWriteInFlight.delete(sessionId);
          }

          // Drain loop: while this bg cycle ran, the user may have sent
          // more messages → new entries in the branch. Check immediately
          // and start another cycle if there's a backlog, rather than
          // waiting for the next agent_end (which might not come soon).
          scheduleDrainIfBacklog({
            cwd, sessionId, settings, getBranch, notify, setStatus,
            modelRegistry, settingsSnapshot,
          });
        }
      })();
      autoWriteInFlight.set(sessionId, bgPromise);
      // DO NOT await bgPromise. agent_end returns immediately so the
      // main session is unblocked.
      return;
    }

    // Synchronous explicit lane: status visible briefly during the
    // write loop (each writeProjectEntry typically < 200ms). Lands at
    // completed/failed when agent_end returns.
    applySedimentStatus(setStatus, sessionId, "running", `explicit (${drafts.length} candidate${drafts.length === 1 ? "" : "s"})`);

    const tWriteStart = Date.now();
    const explicitCorrelationId = makeCorrelationId("explicit", sessionId, window);
    const results: WriteProjectEntryResult[] = [];
    for (const [i, draft] of drafts.entries()) {
      const auditContext: WriterAuditContext = {
        lane: "explicit",
        sessionId,
        correlationId: explicitCorrelationId,
        candidateId: candidateIdFor(explicitCorrelationId, i),
      };
      results.push(await writeProjectEntry({
        ...draft,
        sessionId,
        timelineNote: draft.timelineNote || "captured from explicit MEMORY block",
      }, { projectRoot: cwd, settings, dryRun: false, auditContext }));
    }
    const tWriteEnd = Date.now();

    const shouldAdvance = shouldAdvanceAfterResults(results);
    if (shouldAdvance) await saveSessionCheckpoint(cwd, sessionId, { lastProcessedEntryId: window.lastEntryId });
    await appendAudit(cwd, {
      operation: "explicit_extract",
      lane: "explicit",
      session_id: sessionId,
      ...summary,
      extractor: "explicit_marker",
      parser_version: PARSER_VERSION,
      settings_snapshot: settingsSnapshot,
      entry_breakdown: entryBreakdown,
      correlation_id: explicitCorrelationId,
      candidate_count: drafts.length,
      candidates: drafts.map((d, i) => ({ candidate_id: candidateIdFor(explicitCorrelationId, i), title: d.title, kind: d.kind, confidence: d.confidence, status: d.status, body_chars: (d.compiledTruth || "").length })),
      results: results.map(resultSummary),
      stage_ms: { window_build: tWindowBuilt - tStart, parse: tParseEnd - tParseStart, write_total: tWriteEnd - tWriteStart, total: Date.now() - tStart },
      checkpoint_advanced: shouldAdvance,
    });

    // Use captured `notify` (ctx.ui.notify pre-bound) rather than ctx.ui
    // directly, so a late ctx invalidation does not throw here.
    if (notify) {
      try {
        notify(
          `Sediment explicit marker extraction: ${results.map((r) => `${r.slug}:${r.status}${r.reason ? `(${r.reason})` : ""}`).join(", ")}`,
          shouldAdvance ? "info" : "warning",
        );
      } catch {
        // notify against a stale ui is best-effort; the audit is the
        // canonical record.
      }
    }
    const createdCount = results.filter(r => r.status === "created").length;
    const rejectedCount = results.filter(r => r.status === "rejected").length;
    if (rejectedCount > 0 || !shouldAdvance) {
      applySedimentStatus(setStatus, sessionId, "failed", `explicit: ${createdCount} created, ${rejectedCount} rejected`);
    } else {
      applySedimentStatus(setStatus, sessionId, "completed", `explicit: ${createdCount} ${createdCount === 1 ? "entry" : "entries"}`);
    }
  });
}

// ===========================================================================
// LLM auto-write lane implementation
// ===========================================================================

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

type AutoWriteLaneOutcome =
  | { kind: "ineligible"; eligibility: { eligible: false; reason: string; detail?: Record<string, unknown> } }
  | { kind: "llm_skip"; llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>; llmDurationMs: number; rawTextStored?: string; rawTextTruncated?: boolean }
  | { kind: "llm_error"; llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>; llmDurationMs: number; rawTextStored?: string; rawTextTruncated?: boolean }
  | { kind: "wrote"; drafts: ProjectEntryDraft[]; results: WriteProjectEntryResult[]; curatorAudits?: CuratorAudit[]; llmAuditSummary: ReturnType<typeof summarizeLlmExtractorResult>; llmDurationMs: number; writeStart: number; rawTextStored?: string; rawTextTruncated?: boolean };

function truncateRawForAudit(raw: string | undefined, cap: number): { text?: string; truncated?: boolean } {
  if (!raw || cap <= 0) return {};
  if (raw.length <= cap) return { text: raw, truncated: false };
  return { text: raw.slice(0, cap), truncated: true };
}

/**
 * Run the LLM auto-write lane end-to-end. The function performs all
 * gate checks, runs the LLM extractor when enabled, and applies
 * `previewExtraction` plus the curator loop so compliant candidates
 * become create/update/merge/archive/supersede/delete/skip operations. Semantic hard gates were
 * removed in ADR 0016; git + audit provide rollback.
 */
async function tryAutoWriteLane(args: {
  cwd: string;
  sessionId: string;
  settings: SedimentSettings;
  window: RunWindow;
  modelRegistry: unknown;
  signal?: AbortSignal;
  correlationId: string;
}): Promise<AutoWriteLaneOutcome> {
  const { cwd, sessionId, settings, window, correlationId } = args;
  const modelRegistry = args.modelRegistry as ModelRegistryLike | undefined;

  if (!settings.autoLlmWriteEnabled) {
    return { kind: "ineligible", eligibility: { eligible: false, reason: "auto_write_disabled_setting" } };
  }

  if (!modelRegistry || typeof modelRegistry.find !== "function" || typeof modelRegistry.getApiKeyAndHeaders !== "function") {
    return {
      kind: "ineligible",
      eligibility: { eligible: false, reason: "model_registry_unavailable" },
    };
  }

  // 1. Run extractor. It does not write or commit; it only runs the
  //    model and parses the MEMORY/SKIP response. The curator/writer
  //    stages below decide and persist lifecycle operations.
  const llmStart = Date.now();
  let llmResult: LlmExtractorResult;
  try {
    llmResult = await runLlmExtractor(window.text, {
      settings,
      modelRegistry: modelRegistry as Parameters<typeof runLlmExtractor>[1]["modelRegistry"],
      signal: args.signal,
    });
  } catch (e: any) {
    llmResult = { ok: false, model: settings.extractorModel, error: e?.message ?? "extractor threw" };
  }
  const llmDurationMs = Date.now() - llmStart;

  const llmAuditSummary = summarizeLlmExtractorResult(llmResult, {
    maxCandidates: settings.extractorMaxCandidates,
    rawPreviewChars: settings.extractorAuditRawChars,
  });

  const { text: rawTextStored, truncated: rawTextTruncated } = truncateRawForAudit(
    llmResult.rawText,
    settings.autoWriteRawAuditChars,
  );

  if (!llmResult.ok) {
    return { kind: "llm_error", llmAuditSummary, llmDurationMs, rawTextStored, rawTextTruncated };
  }

  // 2. Keep only schema-valid candidates. Semantic gates are gone; the
  //    curator decides create/update/merge/archive/supersede/delete/skip after looking up existing memory.
  const fullDrafts = (llmResult.rawText && llmResult.rawText !== "SKIP")
    ? (await import("./extractor")).parseExplicitMemoryBlocks(llmResult.rawText)
    : [];
  const schemaPreview = previewExtraction(fullDrafts);
  const compliantDrafts: ProjectEntryDraft[] = fullDrafts.filter((_, i) => schemaPreview.drafts[i]?.validationErrors.length === 0);

  if (compliantDrafts.length === 0) {
    return { kind: "llm_skip", llmAuditSummary, llmDurationMs, rawTextStored, rawTextTruncated };
  }

  // 3. Apply each compliant draft through the curator lookup loop.
  const writeStart = Date.now();
  const results: WriteProjectEntryResult[] = [];
  const curatorAudits: CuratorAudit[] = [];
  for (const [i, draft] of compliantDrafts.entries()) {
    const candidateId = candidateIdFor(correlationId, i);
    const auditContext: WriterAuditContext = {
      lane: "auto_write",
      sessionId,
      correlationId,
      candidateId,
    };
    const curated = await curateProjectDraft(draft, {
      projectRoot: cwd,
      sedimentSettings: settings,
      memorySettings: resolveMemorySettings(),
      modelRegistry,
      signal: args.signal,
    });
    curatorAudits.push(curated.audit);
    if (curated.decision.op === "skip") {
      results.push({
        slug: draft.title,
        path: "",
        status: "skipped",
        reason: curated.decision.reason,
        lane: "auto_write",
        sessionId,
        correlationId,
        candidateId,
      });
      continue;
    }
    if (curated.decision.op === "update") {
      results.push(await updateProjectEntry(curated.decision.slug, {
        ...curated.decision.patch,
        sessionId,
        timelineNote: curated.decision.patch.timelineNote || curated.decision.rationale || "updated by sediment curator",
      }, {
        projectRoot: cwd,
        settings,
        dryRun: false,
        auditContext,
      }));
      continue;
    }
    if (curated.decision.op === "merge") {
      results.push(...await mergeProjectEntries(curated.decision.target, curated.decision.sources, {
        compiledTruth: curated.decision.compiledTruth,
        timelineNote: curated.decision.timelineNote,
        reason: curated.decision.rationale || curated.decision.timelineNote || "merged by sediment curator",
        sessionId,
      }, {
        projectRoot: cwd,
        settings,
        dryRun: false,
        auditContext,
      }));
      continue;
    }
    if (curated.decision.op === "archive") {
      results.push(await archiveProjectEntry(curated.decision.slug, {
        projectRoot: cwd,
        settings,
        dryRun: false,
        reason: curated.decision.reason || curated.decision.rationale || "archived by sediment curator",
        sessionId,
        auditContext,
      }));
      continue;
    }
    if (curated.decision.op === "supersede") {
      results.push(await supersedeProjectEntry(curated.decision.oldSlug, {
        projectRoot: cwd,
        settings,
        dryRun: false,
        newSlug: curated.decision.newSlug,
        reason: curated.decision.reason || curated.decision.rationale || "superseded by sediment curator",
        sessionId,
        auditContext,
      }));
      continue;
    }
    if (curated.decision.op === "delete") {
      results.push(await deleteProjectEntry(curated.decision.slug, {
        projectRoot: cwd,
        settings,
        dryRun: false,
        mode: curated.decision.mode,
        reason: curated.decision.reason || curated.decision.rationale || "deleted by sediment curator",
        sessionId,
        auditContext,
      }));
      continue;
    }

    results.push(await writeProjectEntry({
      ...draft,
      sessionId,
      timelineNote: draft.timelineNote || "captured from LLM auto-write extractor",
    }, {
      projectRoot: cwd,
      settings,
      dryRun: false,
      auditContext,
    }));
  }

  return {
    kind: "wrote",
    drafts: compliantDrafts,
    results,
    curatorAudits,
    llmAuditSummary,
    llmDurationMs,
    writeStart,
    rawTextStored,
    rawTextTruncated,
  };
}

/** Compact subset of SedimentSettings safe to embed in every audit row. */
function snapshotSedimentSettings(settings: ReturnType<typeof resolveSedimentSettings>) {
  return {
    enabled: settings.enabled,
    autoLlmWriteEnabled: settings.autoLlmWriteEnabled,
    extractorModel: settings.extractorModel,
    defaultConfidence: settings.defaultConfidence,
    maxWindowChars: settings.maxWindowChars,
    maxWindowEntries: settings.maxWindowEntries,
  };
}

/**
 * Test-only hook to reset all in-process state. Smoke tests call this
 * between fixtures so cross-fixture pollution can't mask real bugs.
 * Do not call from production code paths.
 */
export function _resetAutoWriteStateForTests(): void {
  autoWriteInFlight.clear();
  sedimentStatusBySession.clear();
}

/**
 * Test-only hook to await any background auto-write work to settle.
 * Smoke tests that exercise the bg path call this before asserting
 * on audit rows produced asynchronously.
 */
export async function _waitForAutoWriteIdleForTests(): Promise<void> {
  while (autoWriteInFlight.size > 0) {
    await Promise.allSettled([...autoWriteInFlight.values()]);
  }
}

/** Tally entry types within the included window for at-a-glance diagnostics. */
function countEntryTypes(entries: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    let key = typeof obj.type === "string" ? obj.type : "unknown";
    if (key === "message" && obj.message && typeof obj.message === "object") {
      const role = (obj.message as Record<string, unknown>).role;
      if (typeof role === "string") key = `message/${role}`;
    }
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Identifier of the parser-version producing this audit row.
 *  Bumped whenever the parser semantics change (e.g., fence-awareness). */
const PARSER_VERSION = "fence_aware_v1";

/**
 * Best-effort sessionId reader, with ephemeral-session filtering.
 *
 * pi >= 0.74 exposes `getSessionId` on ReadonlySessionManager. However,
 * `--no-session` (and dispatch_agent subprocesses) still allocate a fresh
 * UUID for the in-memory session even though nothing is persisted to
 * disk; using that UUID as a checkpoint slot would balloon
 * `checkpoint.json` with single-use entries and pollute audit `session_id`
 * fields with throwaway IDs.
 *
 * We treat a session as ephemeral (=> return undefined here) when
 * `getSessionFile()` is unavailable or returns no path. The agent_end
 * handler then early-returns before any extractor/writer work and emits
 * a single `ephemeral_session: true` audit row for attribution.
 */
function readSessionId(sm: {
  getSessionId?(): string | undefined | null;
  getSessionFile?(): string | undefined | null;
} | undefined): string | undefined {
  if (!sm || typeof sm.getSessionId !== "function") return undefined;
  if (typeof sm.getSessionFile === "function") {
    try {
      const file = sm.getSessionFile();
      if (!file || typeof file !== "string") return undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const id = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}
