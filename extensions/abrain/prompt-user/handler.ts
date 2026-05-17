/**
 * LLM tool handler for `prompt_user` (ADR 0022 P2).
 *
 * Responsibilities (in order):
 *
 *   1. Layer-3 sub-pi guard: refuse when `PI_ABRAIN_DISABLED === "1"`
 *      (this branch is dead under normal extension activation —
 *      `index.ts` returns early — but is here for defense-in-depth
 *      against the registry being driven by a different host).
 *
 *   2. `!ctx.hasUI` reject (§D3 + INV-A). `ctx.ui.custom` being
 *      missing alone does NOT reject — it triggers chained fallback
 *      (R4 P0 fix vs the R3 draft).
 *
 *   3. Validate params via `schema.ts`. On `errors`, return
 *      `schema-invalid` immediately.
 *
 *   4. INV-I concurrent gate: if a pending prompt already exists,
 *      return `schema-invalid` with the distinctive `detail`
 *      message so the LLM can choose to retry or batch.
 *
 *   5. Redaction pre-pass (`redactPromptParams`) over the 5
 *      user-visible fields (INV-D).
 *
 *   6. Soft-cap counter (§D8.4): same-turn `prompt_user` count > 2 →
 *      append `detail` warning, NEVER reject.
 *
 *   7. Delegate to `service.askPromptUser`.
 *
 *   8. Translate the canonical result back into a JSON string that
 *      pi's tool registry can hand to the LLM.
 *
 * NEVER throws. Every error path returns a `PromptUserResult`.
 */

import type {
  PromptUserOption,
  PromptUserParams,
  PromptUserQuestion,
  PromptUserResult,
} from "./types";
import { validatePromptUserParams } from "./schema";
import { getPendingPromptCount } from "./manager";
import {
  askPromptUser,
  type PromptUserCtx,
  type PromptDialogDeps,
  type PromptAuditSink,
} from "./service";
import { redactCredentials } from "../redact";

// ── Redact user-visible fields (INV-D) ──────────────────────────────

/**
 * Run `redactCredentials` over every user-visible string in the params.
 * P0 only does URL credential redaction here — the heavier
 * `sanitizeForMemory` (sediment's home-path / IP scanner) is NOT
 * called from this hot path to avoid pulling sediment internals into
 * abrain. INV-D third layer (sediment transcript pre-pass) is where
 * that runs.
 *
 * 5 fields covered (R4 P0 fix vs R3 which missed `header` and
 * `option.label`):
 *
 *   - `reason`
 *   - `question.header`
 *   - `question.question`
 *   - `option.label`
 *   - `option.description`
 *
 * The redacted label is what both the UI renders AND the answer
 * comparator expects, so LLM-visible schema stays consistent with
 * user-visible chip rendering.
 */
export function redactPromptParams(p: PromptUserParams): PromptUserParams {
  const redactOption = (o: PromptUserOption): PromptUserOption => ({
    ...o,
    label: redactCredentials(o.label),
    ...(o.description !== undefined
      ? { description: redactCredentials(o.description) }
      : {}),
  });
  const redactQuestion = (q: PromptUserQuestion): PromptUserQuestion => ({
    ...q,
    header: redactCredentials(q.header),
    question: redactCredentials(q.question),
    ...(q.options !== undefined
      ? { options: q.options.map(redactOption) }
      : {}),
  });
  return {
    ...p,
    reason: redactCredentials(p.reason),
    questions: p.questions.map(redactQuestion),
  };
}

// ── Soft-cap counter (§D8.4) ────────────────────────────────────────

/**
 * Per-process count of prompt_user invocations. Reset at session
 * shutdown via `resetSoftCapCounter`. NOT per-turn — pi does not
 * expose a turn boundary event to extensions today. Practically
 * speaking, sessions are 1:few turns so over-counting is fine: a
 * spurious "consider batching" hint after a long session is preferable
 * to under-detecting prompt spam.
 */
let promptCallCount = 0;
const SOFT_CAP = 2;

export function resetSoftCapCounter(): void {
  promptCallCount = 0;
}

// ── The handler ─────────────────────────────────────────────────────

export interface PromptUserHandlerDeps {
  dialog: PromptDialogDeps;
  audit: PromptAuditSink;
  /** Hook for handler-level audit (subagent-blocked, ui-unavailable).
   * service.audit handles the per-prompt rows; this is for the cases
   * where we never get far enough to acquire a pending slot. */
  recordBlocked(ev: { reason: "subagent" | "no-ui" | "schema-invalid"; detail?: string }): void;
}

/**
 * Convert a `PromptUserResult` into the JSON-stringified payload that
 * pi's tool registry hands to the LLM. We use `toolJson`-style
 * serialization (matches the rest of abrain).
 */
function toolJson(result: PromptUserResult): string {
  return JSON.stringify(result);
}

/**
 * Top-level entry the `registerTool({ execute })` callback delegates to.
 *
 * Signature mirrors pi's: `(toolCallId, params, signal, onUpdate, ctx)`.
 * We ignore `toolCallId` and `onUpdate` (no streaming progress events
 * in P0). `signal` flows into ctx for the service.
 */
export async function executePromptUserTool(
  rawParams: unknown,
  signal: AbortSignal | undefined,
  ctx: PromptUserCtx,
  deps: PromptUserHandlerDeps,
): Promise<string> {
  const started = Date.now();

  // 1. Sub-pi guard (defense-in-depth; main strip is in index.ts
  //    `if (PI_ABRAIN_DISABLED) return` at module activation).
  if (process.env.PI_ABRAIN_DISABLED === "1") {
    deps.recordBlocked({ reason: "subagent" });
    return toolJson({
      ok: false,
      reason: "subagent-blocked",
      durationMs: Date.now() - started,
      detail: "prompt_user is not available in sub-pi processes",
    });
  }

  // 2. ctx.hasUI guard. ctx.ui.custom missing alone does NOT reject —
  //    we'll route through chained fallback inside service. The
  //    distinct "no-ui" branch covers `-p` print mode, JSON mode,
  //    headless CI runs (ctx.hasUI === false).
  if (ctx.hasUI === false) {
    deps.recordBlocked({ reason: "no-ui" });
    return toolJson({
      ok: false,
      reason: "ui-unavailable",
      durationMs: Date.now() - started,
      detail: "prompt_user requires an interactive UI (ctx.hasUI=false)",
    });
  }

  // 3. Schema validation.
  const validation = validatePromptUserParams(rawParams);
  if (!validation.ok || !validation.normalized) {
    const detail = validation.errors.join(" | ").slice(0, 800);
    deps.recordBlocked({ reason: "schema-invalid", detail });
    return toolJson({
      ok: false,
      reason: "schema-invalid",
      durationMs: Date.now() - started,
      detail,
    });
  }

  // 4. INV-I concurrent gate.
  if (getPendingPromptCount() > 0) {
    return toolJson({
      ok: false,
      reason: "schema-invalid",
      durationMs: Date.now() - started,
      // R3 INV-I dictates a DISTINCT detail string so smoke can grep.
      detail:
        "another prompt is pending — wait for the previous prompt_user " +
        "to resolve before issuing a new one (INV-I: concurrent ≤ 1)",
    });
  }

  // 5. Redaction pre-pass.
  const safeParams = redactPromptParams(validation.normalized);

  // 6. Soft-cap counter (§D8.4).
  promptCallCount += 1;
  const softCapWarning =
    promptCallCount > SOFT_CAP
      ? `prompt_user has been called ${promptCallCount} times in this session — consider batching related questions into a single prompt with multiple questions[] entries.`
      : undefined;

  // 7. Wire ctx.signal through to the service.
  const serviceCtx: PromptUserCtx = {
    ...ctx,
    signal,
  };

  const result = await askPromptUser(
    serviceCtx,
    safeParams,
    deps.dialog,
    deps.audit,
    { variant: "question" },
  );

  // 8. Attach soft-cap warning to detail if applicable. We preserve
  //    any existing detail from the service (e.g. fallback note) by
  //    concatenating.
  if (softCapWarning) {
    const existing = result.detail ? `${result.detail} ` : "";
    return toolJson({
      ...result,
      detail: `${existing}${softCapWarning}`.trim(),
    });
  }

  return toolJson(result);
}
