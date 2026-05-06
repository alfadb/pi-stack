/**
 * pi-sediment scheduler — coalescing per-target checkpoint scheduler.
 *
 * This is not a FIFO queue. Each target keeps:
 *   lastProcessedEntryId → pendingHeadEntryId
 * and processes the whole conversation window between them.
 *
 * If new turns arrive while a target is running, only pendingHeadEntryId is
 * updated. When the current run finishes, the scheduler immediately processes
 * the newest pending window.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Result returned by a worker for one window.
 *
 *   "processed"          — success, skip, or a deterministic outcome that
 *                          should NEVER be retried (parse_failure,
 *                          sanitize_reject, skip_duplicate, blocked
 *                          non-Latin write, etc.). The scheduler advances
 *                          the checkpoint and resets retryCount.
 *   "failed_retryable"   — transient failure (network error, rate-limit,
 *                          provider 5xx, model timeout). Retry with
 *                          exponential backoff; do NOT count toward the
 *                          deterministic-failure cap (otherwise a 10-minute
 *                          provider outage would force-advance a real
 *                          insight off the checkpoint within ~2 minutes
 *                          of retries).
 *   "failed_permanent"   — deterministic worker failure (model not in
 *                          registry, auth permanently broken, exception
 *                          thrown by worker code). Force-advance the
 *                          checkpoint immediately — retrying produces the
 *                          exact same failure and burns LLM budget.
 *
 * Workers MUST classify their failures. Returning the legacy "failed"
 * string is preserved as an alias for failed_retryable, so old workers
 * keep working but log a deprecation note. Once all workers migrate,
 * remove the alias.
 */
export type RunResult =
  | "processed"
  | "failed_retryable"
  | "failed_permanent"
  | "failed"; // legacy alias for failed_retryable

export interface BranchSnapshot {
  sessionId: string;
  projectRoot: string;
  headEntryId: string;
  entries: any[];
  /**
   * Live model registry from the most recent agent_end ctx.
   * MUST come from the ctx passed to the agent_end handler — not from a
   * captured session_start ctx. Captured ctx becomes stale after
   * session replacement/reload, and even property access on it throws.
   */
  modelRegistry: any;
}

export interface RunWindow {
  target: string;
  sessionId: string;
  projectRoot: string;
  fromEntryId: string | null;
  toEntryId: string;
  /** Timestamp/date of the source conversation head, used for timeline entries. */
  sourceTimestamp?: string;
  sourceDateIso?: string;
  text: string;
  entryCount: number;
  /** Live model registry, refreshed each markPending(). See BranchSnapshot. */
  modelRegistry: any;
}

type WorkerFn = (window: RunWindow) => Promise<RunResult>;

/**
 * Lifecycle phase observed by external listeners (typically the UI).
 * Scheduler is the single source of truth for what's happening per target;
 * callers should NOT compute or override phase from event handlers — they
 * just subscribe and react.
 *
 *   idle    → nothing pending, nothing running
 *   pending → work queued (either fresh markPending or retry-scheduled),
 *             not yet running
 *   running → worker is actively executing
 *
 * Transitions ("→ same" listed for completeness; same-state emits are
 * deduped by emitPhase and never reach listeners):
 *
 *   idle      → pending  : markPending() while worker not running
 *   idle      → running  : markPending() if buildRunWindow yields work synchronously (typical)
 *   pending   → running  : tick() picks up the queued window
 *   pending   → idle     : a same-tick buildRunWindow returns null AND nothing pending (rare)
 *   running   → idle     : worker finishes, no more pending
 *   running   → running  : (deduped) coalesced new pending consumed in same tick
 *   running   → pending  : worker finished but failed; scheduleRetry queued backoff timer
 *
 * The UI may see the cluster idle→pending→running collapse to a single
 * ⏳ frame because emit happens synchronously inside markPending; that's
 * intentional. Pending becomes visible when buildRunWindow can't build
 * (e.g., snapshot doesn't yet contain the head id), or while a
 * retry-backoff timer is waiting.
 */
export type SchedulerPhase = "idle" | "pending" | "running";

type PhaseListener = (target: string, phase: SchedulerPhase) => void;

type TargetDiskState = {
  lastProcessedEntryId: string | null;
  pendingHeadEntryId: string | null;
  retryCount?: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
};

type DiskState = {
  version: 1;
  targets: Record<string, TargetDiskState>;
};

type TargetState = TargetDiskState & {
  running: boolean;
  worker: WorkerFn | null;
  latestSnapshot: BranchSnapshot | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  phase: SchedulerPhase;
};

const states = new Map<string, TargetState>(); // target → state
const phaseListeners = new Set<PhaseListener>();

function emitPhase(target: string, state: TargetState, next: SchedulerPhase): void {
  if (state.phase === next) return;
  state.phase = next;
  for (const fn of phaseListeners) {
    try { fn(target, next); } catch { /* listener must not break scheduler */ }
  }
}

// ── Disk state ────────────────────────────────────────────────

function statePath(projectRoot: string): string {
  return path.join(projectRoot, ".pi-sediment", "state.json");
}

function readDisk(projectRoot: string): DiskState {
  try {
    const raw = fs.readFileSync(statePath(projectRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && parsed?.targets) return parsed as DiskState;
  } catch { /* first run */ }
  return { version: 1, targets: {} };
}

function writeDisk(projectRoot: string, state: DiskState): void {
  const dir = path.join(projectRoot, ".pi-sediment");
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: serialize, write to a sibling .tmp file, then rename.
  // POSIX rename is atomic within a single filesystem, so a power loss
  // either leaves the previous state.json intact or atomically swaps in
  // the new one — never a half-written JSON. Without this, an interrupted
  // writeFileSync corrupts state.json; readDisk's catch-all returns an
  // empty state; sediment then re-processes every past entry in the
  // session as if it were new (verified failure mode — 30+ duplicate LLM
  // agent loops + duplicate gbrain pages on restart after a crash).
  //
  // The serialize step happens first so an in-memory JSON.stringify error
  // (cyclic ref, etc.) doesn't trash the existing file via an empty .tmp.
  const finalPath = statePath(projectRoot);
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  const payload = JSON.stringify(state, null, 2) + "\n";
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, finalPath);
}

function loadTarget(projectRoot: string, target: string): TargetDiskState {
  const disk = readDisk(projectRoot);
  return disk.targets[target] ?? { lastProcessedEntryId: null, pendingHeadEntryId: null };
}

function saveTarget(projectRoot: string, target: string, patch: TargetDiskState): void {
  const disk = readDisk(projectRoot);
  disk.targets[target] = patch;
  writeDisk(projectRoot, disk);
}

// ── Window formatting ─────────────────────────────────────────
//
// Sediment's writer agents only consume what survives serialization here.
// Three classes of session content matter:
//
//   text       — the assistant's prose answer; verbatim what the user saw
//   toolCall   — the assistant's tool invocation: name + arguments
//   toolResult — the tool's response, fed back into the next LLM turn
//
// One class is intentionally NOT preserved:
//
//   thinking   — model-private chain-of-thought reasoning
//
// Why drop thinking?
//   - Anthropic models (opus/sonnet) ship thinking as opaque encrypted blobs
//     when accessed via the sub2api/codex path; the local session contains
//     only `thinkingSignature` (a 364-byte server-side ciphertext) and an
//     EMPTY `thinking` string. There is literally nothing to forward.
//   - DeepSeek models ship thinking as plaintext, but it can be 1-3x the
//     size of the final text — a 250K-char session balloons to 800K+ if
//     thinking is included. Sediment would burn tokens on draft reasoning.
//   - Thinking is exploratory: "maybe X? no, Y; actually Z" — the wrong
//     half is as visible as the right half. The final text already encodes
//     the conclusions; thinking is the discarded scaffolding.
//   - Treating sediment as model-agnostic means relying only on what every
//     provider exposes consistently, which is text + tool I/O.
//
// What about the redacted/encrypted thinking signature? That field exists
// SOLELY for round-trip continuity inside one LLM provider's API — it lets
// a multi-turn anthropic call re-attach prior thinking when sending the
// next request. It cannot be decrypted client-side, cannot be summarized,
// and contains no information sediment can use. Skip it cleanly.

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      // Format: a single-line header for diff-friendly logs, then the
      // arguments JSON pretty-printed if small or single-line if large.
      // Sediment writers care about *what tool ran with what args*, not
      // the formatting; preserve verbatim args so a write/edit/grep is
      // reconstructable from the window.
      const name = block.name ?? "unknown";
      let argsRepr: string;
      try {
        const json = JSON.stringify(block.arguments ?? {});
        argsRepr = json.length > 400
          ? JSON.stringify(block.arguments ?? {}, null, 2)
          : json;
      } catch {
        argsRepr = "(unserializable arguments)";
      }
      parts.push(`[tool_call ${name}] ${argsRepr}`);
    } else if (block.type === "image") {
      // Don't dump base64 — a single image is megabytes and serves no
      // purpose for sediment's text-based knowledge extraction.
      parts.push(`[image ${block.mimeType ?? "unknown"}]`);
    }
    // Skip thinking blocks (see header comment for rationale).
  }
  return parts.join("\n");
}

/**
 * Render a tool's result inline. ToolResultMessage carries content that's
 * the tool's actual output — a bash command's stdout, an edit's diff, a
 * read's file contents. This is where most signal lives for sediment:
 * "the assistant ran X and got Y, then said Z".
 */
function toolResultToText(msg: any): string {
  const name = msg?.toolName ?? "unknown";
  const errFlag = msg?.isError ? " ERROR" : "";
  const body = contentToText(msg?.content).trim();
  return `[tool_result ${name}${errFlag}]\n${body}`;
}

function entryToText(entry: any): string | null {
  if (entry.type === "message") {
    const msg = entry.message;
    const role = msg?.role ?? "message";

    // Tool results live in their own message role in pi-ai. Render them
    // as a labeled block so writers can correlate tool_call → tool_result.
    if (role === "toolResult") {
      const body = toolResultToText(msg).trim();
      if (!body) return null;
      return `### toolResult (${entry.id})\n${body}`;
    }

    const text = contentToText(msg?.content).trim();
    if (!text) return null;
    return `### ${role} (${entry.id})\n${text}`;
  }

  if (entry.type === "custom_message") {
    const text = contentToText(entry.content).trim();
    if (!text) return null;
    return `### custom_message:${entry.customType} (${entry.id})\n${text}`;
  }

  if (entry.type === "compaction") {
    return `### compaction (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  if (entry.type === "branch_summary") {
    return `### branch_summary (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  return null;
}

// Per-entry cap: bash output / file reads can be enormous. 30K chars is
// generous for typical tool results while still preventing a single read
// of a 1MB file from monopolizing the window.
const MAX_ENTRY_CHARS = 30_000;

// Window cap: at ~4 chars/token this is ~50K tokens of session content,
// which fits comfortably in any modern model's context (opus has 200K,
// gpt-5.5 has 400K, deepseek-v4 has 128K). Tool I/O often dwarfs prose
// by 4-5x in tool-heavy sessions — verified May 2026: text 181K chars,
// tool args 793K chars. The previous 80K cap was tuned for text-only
// extraction and clipped 80% of the actual signal.
const MAX_WINDOW_CHARS = 200_000;

function buildWindowText(entries: any[]): string {
  // Build BACKWARD from the newest entry. The window is anchored at
  // pendingHeadEntryId (the assistant turn that JUST triggered sediment),
  // and that turn is what the writer agent must see to make a decision.
  //
  // Original implementation iterated forward; when MAX_WINDOW_CHARS was
  // hit, it `break`-ed and the most recent (= triggering) turn was silently
  // omitted. Verified failure mode: a tool-heavy session with 200K of bash
  // output earlier in the branch would push the trailing "insight" turn
  // out of the window entirely, and sediment would emit SKIP with no
  // visibility into why.
  //
  // Backward iteration with a prepend buffer guarantees the newest turns
  // are always present; older turns get truncated instead. Per-entry
  // head+tail truncation behavior unchanged: tool results often have
  // signal at both ends so we keep the same MAX_ENTRY_CHARS strategy.
  const reversedChunks: string[] = [];
  let total = 0;
  let truncated = false;

  for (let i = entries.length - 1; i >= 0; i--) {
    let text = entryToText(entries[i]);
    if (!text) continue;
    if (text.length > MAX_ENTRY_CHARS) {
      const headSize = Math.floor(MAX_ENTRY_CHARS * 0.7);
      const tailSize = MAX_ENTRY_CHARS - headSize - 50;
      text = text.slice(0, headSize) +
        `\n[...${text.length - MAX_ENTRY_CHARS} chars elided...]\n` +
        text.slice(-tailSize);
    }
    if (total + text.length > MAX_WINDOW_CHARS) {
      truncated = true;
      break;
    }
    reversedChunks.push(text);
    total += text.length;
  }

  // reversedChunks holds [newest, …, oldest]; flip back to chronological.
  reversedChunks.reverse();
  if (truncated) {
    reversedChunks.unshift("[...older window entries truncated due to size...]");
  }
  return reversedChunks.join("\n\n---\n\n");
}

function isoDateFromTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function buildRunWindow(target: string, state: TargetState): RunWindow | null {
  const snapshot = state.latestSnapshot;
  if (!snapshot || !state.pendingHeadEntryId) return null;

  const entries = snapshot.entries;
  const headIdx = entries.findIndex((e) => e.id === state.pendingHeadEntryId);
  if (headIdx === -1) {
    // pendingHeadEntryId is gone from the branch — most likely the user
    // forked or compacted between markPending() and tick(), or they
    // switched to a sibling session. We can't process a window we can't
    // locate. Returning null here lets the next markPending() refresh the
    // snapshot and try again. Log so a stuck phase is visible in the
    // sidecar trail.
    try {
      const projectRoot = snapshot.projectRoot;
      const dir = path.join(projectRoot, ".pi-sediment");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "sidecar.log"),
        `${new Date().toISOString()} scheduler ${target}: pendingHead ${state.pendingHeadEntryId} not in current branch — awaiting next agent_end\n`,
      );
    } catch { /* best-effort */ }
    return null;
  }
  const headEntry = entries[headIdx];
  const sourceTimestamp = typeof headEntry?.timestamp === "string" ? headEntry.timestamp : undefined;
  const sourceDateIso = isoDateFromTimestamp(sourceTimestamp);

  // lastProcessedEntryId is from the persisted state.json; the branch may
  // have been compacted since (compaction replaces a run of entries with a
  // single summary, deleting the original IDs). When that happens, findIndex
  // returns -1 and we used to silently re-process from index 0 — which
  // works but produces a giant window the first time. Differentiate the
  // two cases:
  //   - lastProcessedEntryId == null     → first run for this target,
  //                                          start from beginning (fine)
  //   - lastProcessedEntryId set, found  → normal incremental run
  //   - lastProcessedEntryId set, gone   → RESET to head only (avoid
  //                                          re-emitting the entire history;
  //                                          the missing entries are gone
  //                                          anyway, future windows will
  //                                          continue from this head).
  let startIdx: number;
  if (!state.lastProcessedEntryId) {
    startIdx = 0;
  } else {
    const lastIdx = entries.findIndex((e) => e.id === state.lastProcessedEntryId);
    if (lastIdx >= 0) {
      startIdx = lastIdx + 1;
    } else {
      // Recovery: lastProcessedEntryId no longer exists in the branch.
      // Skip ahead to just the current head turn (window of size 1).
      // This loses fidelity for the compacted range, but the alternative
      // is replaying potentially hundreds of pre-compaction entries to
      // every writer agent on every tick, which would burn LLM budget
      // and likely produce a giant SKIP anyway.
      startIdx = headIdx;
      try {
        const projectRoot = snapshot.projectRoot;
        const dir = path.join(projectRoot, ".pi-sediment");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, "sidecar.log"),
          `${new Date().toISOString()} scheduler ${target}: lastProcessed ${state.lastProcessedEntryId} compacted away — resetting window to head only\n`,
        );
      } catch { /* best-effort */ }
    }
  }
  if (startIdx > headIdx) return null;

  const windowEntries = entries.slice(startIdx, headIdx + 1);
  const text = buildWindowText(windowEntries);
  if (!text.trim()) return null;

  return {
    target,
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot,
    fromEntryId: state.lastProcessedEntryId,
    toEntryId: state.pendingHeadEntryId,
    sourceTimestamp,
    sourceDateIso,
    text,
    entryCount: windowEntries.length,
    modelRegistry: snapshot.modelRegistry,
  };
}

// ── Scheduler loop ────────────────────────────────────────────

function getOrCreate(target: string): TargetState {
  let s = states.get(target);
  if (!s) {
    s = {
      lastProcessedEntryId: null,
      pendingHeadEntryId: null,
      retryCount: 0,
      running: false,
      worker: null,
      latestSnapshot: null,
      retryTimer: null,
      phase: "idle",
    };
    states.set(target, s);
  }
  return s;
}

function persist(state: TargetState, target: string): void {
  const projectRoot = state.latestSnapshot?.projectRoot;
  if (!projectRoot) return;
  saveTarget(projectRoot, target, {
    lastProcessedEntryId: state.lastProcessedEntryId,
    pendingHeadEntryId: state.pendingHeadEntryId,
    retryCount: state.retryCount,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
  });
}

function scheduleRetry(target: string, state: TargetState): void {
  if (state.retryTimer) return;
  const retryCount = state.retryCount ?? 1;
  const delayMs = Math.min(60_000, 5_000 * Math.pow(2, Math.max(0, retryCount - 1)));
  // Phase stays "pending" while waiting for backoff timer — work is queued,
  // not idle. Otherwise the UI would falsely show idle during retry windows.
  emitPhase(target, state, "pending");
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    tick(target);
  }, delayMs);
}

function tick(target: string): void {
  const state = states.get(target);
  if (!state || state.running || !state.worker) return;

  const run = buildRunWindow(target, state);
  if (!run) {
    // No work buildable — if we just finished a run and pending == processed,
    // we're truly idle. Otherwise leave phase as caller set it.
    if (state.pendingHeadEntryId === state.lastProcessedEntryId && !state.retryTimer) {
      emitPhase(target, state, "idle");
    }
    return;
  }

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  emitPhase(target, state, "running");
  persist(state, target);

  // Per-window classification: was the most recent worker outcome
  // permanent (don't retry), retryable (back off and try again), or
  // success? Promise.then captures this; the .finally branch consumes it.
  let lastOutcome: "processed" | "failed_retryable" | "failed_permanent" = "processed";

  void state.worker(run)
    .then((result) => {
      if (result === "processed") {
        state.lastProcessedEntryId = run.toEntryId;
        state.retryCount = 0;
        state.lastSuccessAt = new Date().toISOString();
        state.lastError = undefined;
        state.lastErrorAt = undefined;
        lastOutcome = "processed";
      } else if (result === "failed_permanent") {
        // Deterministic failure: do NOT retry. Force-advance immediately.
        // This is the right behavior for "model not in registry" or
        // "auth permanently broken" — retrying just burns budget for the
        // same outcome. We treat it like processed-with-error: the
        // checkpoint moves so future windows can run.
        state.lastProcessedEntryId = run.toEntryId;
        state.retryCount = 0;
        state.lastError = "permanent failure — checkpoint force-advanced";
        state.lastErrorAt = new Date().toISOString();
        lastOutcome = "failed_permanent";
      } else {
        // failed_retryable (or legacy "failed" alias). Increment the
        // retry counter; the .finally block will schedule backoff or hit
        // the MAX_RETRIES safety net.
        state.retryCount = (state.retryCount ?? 0) + 1;
        state.lastError = result === "failed"
          ? "worker returned failed (legacy — treat as retryable)"
          : "worker returned failed_retryable";
        state.lastErrorAt = new Date().toISOString();
        lastOutcome = "failed_retryable";
      }
    })
    .catch((e) => {
      // Uncaught worker exceptions are deterministic by definition (the
      // window deterministically reproduces the throw). Treat as
      // permanent so we don't retry-storm on a bug.
      state.lastProcessedEntryId = run.toEntryId;
      state.retryCount = 0;
      state.lastError = `worker threw — ${e?.message ?? String(e)}`;
      state.lastErrorAt = new Date().toISOString();
      lastOutcome = "failed_permanent";
    })
    .finally(() => {
      state.running = false;

      // Hard retry cap: applies ONLY to retryable failures. Permanent
      // failures already advanced the checkpoint (see above), so this
      // safety net catches a long-running provider outage where every
      // retry is a transient network error. After MAX_RETRIES_RETRYABLE
      // tries (with exp backoff capped at 60s, so worst-case ~5 minutes
      // of attempts), give up and advance the checkpoint anyway. The
      // alternative — retrying forever — means a single broken model
      // can wedge sediment until the user notices and restarts.
      const MAX_RETRIES_RETRYABLE = 8;
      if (lastOutcome === "failed_retryable" &&
          (state.retryCount ?? 0) >= MAX_RETRIES_RETRYABLE &&
          state.pendingHeadEntryId !== state.lastProcessedEntryId) {
        const dropped = state.pendingHeadEntryId;
        state.lastProcessedEntryId = state.pendingHeadEntryId;
        state.retryCount = 0;
        state.lastError = `gave up after ${MAX_RETRIES_RETRYABLE} retryable failures (last: ${state.lastError ?? "unknown"})`;
        state.lastErrorAt = new Date().toISOString();
        // Surface clearly in sidecar.log so the user sees the bail-out.
        const projectRoot = state.latestSnapshot?.projectRoot;
        if (projectRoot) {
          try {
            const dir = path.join(projectRoot, ".pi-sediment");
            fs.mkdirSync(dir, { recursive: true });
            fs.appendFileSync(
              path.join(dir, "sidecar.log"),
              `${new Date().toISOString()} scheduler ${target}: gave up after ${MAX_RETRIES_RETRYABLE} retryable failures, force-advancing to ${dropped}\n`,
            );
          } catch { /* silent */ }
        }
      }

      persist(state, target);
      // If new content arrived while running, process the coalesced pending head.
      // On failure, keep the checkpoint unchanged but retry with backoff — no busy loop.
      if (state.pendingHeadEntryId !== state.lastProcessedEntryId) {
        if ((state.retryCount ?? 0) > 0) {
          scheduleRetry(target, state); // emits "pending"
        } else {
          tick(target); // emits "running" if work runs, or "idle" via the no-work branch
        }
      } else {
        // Done and nothing pending — truly idle.
        emitPhase(target, state, "idle");
      }
    });
}

// ── Public ─────────────────────────────────────────────────────

export function registerScheduler(target: string, worker: WorkerFn): void {
  const state = getOrCreate(target);
  state.worker = worker;
  tick(target);
}

/**
 * Subscribe to phase changes for any target. Returns an unsubscribe fn.
 * Listener is fired only on transition (idle↔pending↔running), not on no-op
 * re-emits. Listener errors are swallowed so the scheduler can't be broken
 * by a buggy UI write.
 */
export function onPhaseChange(listener: PhaseListener): () => void {
  phaseListeners.add(listener);
  return () => { phaseListeners.delete(listener); };
}

/** Read current phase — used to seed the UI on registration. */
export function getPhase(target: string): SchedulerPhase {
  return states.get(target)?.phase ?? "idle";
}

export function markPending(target: string, snapshot: BranchSnapshot): void {
  const state = getOrCreate(target);

  // Load checkpoint lazily for this project root.
  if (!state.latestSnapshot || state.latestSnapshot.projectRoot !== snapshot.projectRoot) {
    const disk = loadTarget(snapshot.projectRoot, target);
    state.lastProcessedEntryId = disk.lastProcessedEntryId;
    state.pendingHeadEntryId = disk.pendingHeadEntryId;
    state.retryCount = disk.retryCount ?? 0;
    state.lastRunAt = disk.lastRunAt;
    state.lastSuccessAt = disk.lastSuccessAt;
    state.lastErrorAt = disk.lastErrorAt;
    state.lastError = disk.lastError;
  }

  state.latestSnapshot = snapshot;
  state.pendingHeadEntryId = snapshot.headEntryId;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  // Mark phase before tick. If tick can run synchronously, it will overwrite
  // "pending" with "running" — correct behavior. If tick can't run (worker
  // already running, or no work buildable yet), "pending" stays visible so
  // the UI shows ⏱ instead of stale running/idle.
  if (!state.running) emitPhase(target, state, "pending");
  persist(state, target);
  tick(target);
}
