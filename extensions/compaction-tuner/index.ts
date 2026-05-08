/**
 * compaction-tuner extension for pi-astack.
 *
 * Triggers `ctx.compact()` when context usage crosses a configurable
 * percentage of the model's contextWindow. Solves the problem that pi's
 * built-in `reserveTokens` is an absolute number while user-stack models
 * span 200k → 1M+ contextWindows, making a single number unable to
 * represent a percentage threshold uniformly.
 *
 * Configuration lives in `~/.pi/agent/pi-astack-settings.json`:
 *
 *   "compactionTuner": {
 *     "enabled": true,
 *     "thresholdPercent": 75,
 *     "rearmMarginPercent": 5,
 *     "notifyOnTrigger": true,
 *     "customInstructions": ""
 *   }
 *
 * Runtime data:
 *   - audit: <projectRoot>/.pi-astack/compaction-tuner/audit.jsonl
 *
 * Default `enabled: false` — extension is a no-op until user opts in.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  compactionTunerAuditPath,
  compactionTunerDir,
  formatLocalIsoTimestamp,
} from "../_shared/runtime";
import {
  DEFAULT_COMPACTION_TUNER_SETTINGS,
  resolveCompactionTunerSettings,
  snapshotCompactionTunerSettings,
  type CompactionTunerSettings,
} from "./settings";

const AUDIT_VERSION = 1;

interface CompactionTunerCtx {
  cwd?: string;
  hasUI?: boolean;
  ui?: { notify?(message: string, type?: string): void };
  model?: { id?: string; provider?: string; contextWindow?: number };
  sessionManager?: {
    getSessionId?(): string | undefined | null;
    getSessionFile?(): string | undefined | null;
  };
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  compact?(options?: {
    customInstructions?: string;
    onComplete?(result?: unknown): void;
    onError?(error: Error): void;
  }): void;
}

/**
 * Per-process armed state (keyed by session id, so multiple sessions in
 * one pi process — dispatched subagents, etc. — don't leak hysteresis
 * state across each other). Each session is "armed" until it triggers,
 * then becomes "disarmed" until usage drops by `rearmMarginPercent`
 * below threshold.
 */
const armedBySession = new Map<string, boolean>();

function readSessionId(sm: CompactionTunerCtx["sessionManager"]): string | undefined {
  if (!sm || typeof sm.getSessionId !== "function") return undefined;
  try {
    const id = sm.getSessionId();
    return typeof id === "string" && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

async function appendAudit(projectRoot: string, row: Record<string, unknown>): Promise<void> {
  await fs.mkdir(compactionTunerDir(projectRoot), { recursive: true });
  const enriched = {
    timestamp: formatLocalIsoTimestamp(new Date()),
    audit_version: AUDIT_VERSION,
    pid: process.pid,
    project_root: projectRoot,
    ...row,
  };
  await fs.appendFile(compactionTunerAuditPath(projectRoot), `${JSON.stringify(enriched)}\n`, "utf-8");
}

function classifyDecision(
  percent: number | null,
  threshold: number,
  armed: boolean,
  rearmMargin: number,
):
  | { decision: "skip"; reason: string }
  | { decision: "rearm"; reason: string }
  | { decision: "trigger" } {
  if (percent === null) return { decision: "skip", reason: "no_usage_yet" };
  if (percent < threshold - rearmMargin && !armed) {
    return { decision: "rearm", reason: "below_rearm_floor" };
  }
  if (percent < threshold) return { decision: "skip", reason: "below_threshold" };
  if (!armed) return { decision: "skip", reason: "already_triggered_awaiting_rearm" };
  return { decision: "trigger" };
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (_event: unknown, ctx: CompactionTunerCtx) => {
    // Capture ctx fields synchronously — pi may invalidate ctx during
    // async work (same pattern sediment uses).
    const cwd = path.resolve(ctx.cwd || process.cwd());
    const sessionId = readSessionId(ctx.sessionManager);
    const hasUI = !!ctx.hasUI;
    const notify = ctx.ui?.notify?.bind(ctx.ui);
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const compact = typeof ctx.compact === "function" ? ctx.compact.bind(ctx) : undefined;
    const modelInfo = {
      provider: ctx.model?.provider,
      id: ctx.model?.id,
      contextWindow: ctx.model?.contextWindow,
    };

    const settings = resolveCompactionTunerSettings();
    if (!settings.enabled) return;
    if (!compact) return;

    // Hysteresis state key: prefer sessionId; fall back to a stable
    // per-process key so ephemeral sessions still have one slot.
    const stateKey = sessionId ?? `pid:${process.pid}`;
    const wasArmed = armedBySession.get(stateKey) ?? true;

    const percent = usage?.percent ?? null;
    const decision = classifyDecision(percent, settings.thresholdPercent, wasArmed, settings.rearmMarginPercent);

    // Update arming state for "rearm" decisions before logging/short-circuiting.
    if (decision.decision === "rearm") {
      armedBySession.set(stateKey, true);
      // Don't audit pure rearm transitions to keep the log focused on triggers.
      return;
    }

    if (decision.decision === "skip") {
      // Silent skip: avoid audit churn (one row per turn would dominate
      // the log). Only triggers and errors are logged.
      return;
    }

    // decision === "trigger"
    const ts = Date.now();
    armedBySession.set(stateKey, false);

    if (hasUI && settings.notifyOnTrigger && notify) {
      notify(
        `compaction-tuner: triggering compact at ${(percent ?? 0).toFixed(1)}% (threshold ${settings.thresholdPercent}%)`,
        "info",
      );
    }

    let outcomeRecorded = false;
    const recordOutcome = async (row: Record<string, unknown>) => {
      if (outcomeRecorded) return;
      outcomeRecorded = true;
      try {
        await appendAudit(cwd, row);
      } catch {
        // never let audit failures break compaction
      }
    };

    try {
      compact({
        customInstructions: settings.customInstructions || undefined,
        onComplete: () => {
          if (hasUI && settings.notifyOnTrigger && notify) {
            notify("compaction-tuner: compaction completed", "info");
          }
          void recordOutcome({
            operation: "trigger",
            outcome: "completed",
            session_id: sessionId,
            ephemeral_session: !sessionId,
            percent_at_trigger: percent,
            threshold_percent: settings.thresholdPercent,
            rearm_margin_percent: settings.rearmMarginPercent,
            tokens_at_trigger: usage?.tokens ?? null,
            context_window: usage?.contextWindow ?? modelInfo.contextWindow ?? null,
            model_provider: modelInfo.provider ?? null,
            model_id: modelInfo.id ?? null,
            elapsed_ms: Date.now() - ts,
            settings_snapshot: snapshotCompactionTunerSettings(settings),
          });
        },
        onError: (error) => {
          if (hasUI && notify) {
            notify(`compaction-tuner: compaction failed: ${error.message}`, "error");
          }
          // Re-arm on error so a transient failure doesn't permanently
          // suppress future triggers.
          armedBySession.set(stateKey, true);
          void recordOutcome({
            operation: "trigger",
            outcome: "error",
            error_message: error.message,
            session_id: sessionId,
            ephemeral_session: !sessionId,
            percent_at_trigger: percent,
            threshold_percent: settings.thresholdPercent,
            tokens_at_trigger: usage?.tokens ?? null,
            context_window: usage?.contextWindow ?? modelInfo.contextWindow ?? null,
            model_provider: modelInfo.provider ?? null,
            model_id: modelInfo.id ?? null,
            elapsed_ms: Date.now() - ts,
            settings_snapshot: snapshotCompactionTunerSettings(settings),
          });
        },
      });
    } catch (err) {
      // ctx.compact is fire-and-forget so a sync throw is highly
      // unlikely, but guard anyway.
      const message = err instanceof Error ? err.message : String(err);
      armedBySession.set(stateKey, true);
      await recordOutcome({
        operation: "trigger",
        outcome: "sync_error",
        error_message: message,
        session_id: sessionId,
        ephemeral_session: !sessionId,
        percent_at_trigger: percent,
        threshold_percent: settings.thresholdPercent,
        elapsed_ms: Date.now() - ts,
        settings_snapshot: snapshotCompactionTunerSettings(settings),
      });
    }
  });

  pi.registerCommand("compaction-tuner", {
    description: "Inspect / debug compaction-tuner: status | trigger",
    handler: async (
      args: string,
      ctx: CompactionTunerCtx & {
        ui: { notify(message: string, type?: string): void };
      },
    ) => {
      const sub = args.trim() || "status";
      const settings = resolveCompactionTunerSettings();
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;

      if (sub === "status") {
        const lines = [
          "# compaction-tuner",
          "",
          `enabled: ${settings.enabled}`,
          `thresholdPercent: ${settings.thresholdPercent}%`,
          `rearmMarginPercent: ${settings.rearmMarginPercent}%`,
          `notifyOnTrigger: ${settings.notifyOnTrigger}`,
          `customInstructions: ${settings.customInstructions ? `(${settings.customInstructions.length} chars)` : "(empty)"}`,
          "",
          `current usage: ${usage?.percent != null ? `${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow} tokens)` : "(unknown — no post-compaction usage yet)"}`,
          `model: ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "trigger") {
        if (typeof ctx.compact !== "function") {
          ctx.ui.notify("ctx.compact unavailable", "error");
          return;
        }
        ctx.ui.notify(
          `compaction-tuner: forced compact (${usage?.percent != null ? `${usage.percent.toFixed(1)}%` : "unknown"})`,
          "info",
        );
        ctx.compact({
          customInstructions: settings.customInstructions || undefined,
          onComplete: () => ctx.ui.notify("compaction-tuner: forced compact completed", "info"),
          onError: (e) => ctx.ui.notify(`compaction-tuner: forced compact failed: ${e.message}`, "error"),
        });
        return;
      }

      ctx.ui.notify(`unknown subcommand: ${sub}\nusage: /compaction-tuner [status|trigger]`, "warning");
    },
  });
}

// Test-only exports: the smoke harness uses these directly to verify
// decision logic without going through pi's runtime.
export { classifyDecision, DEFAULT_COMPACTION_TUNER_SETTINGS };
