/**
 * sediment/checkpoint — incremental window tracking.
 *
 * Persists the entry id of the last processed turn so the next agent_end
 * only feeds the LLM the NEW entries since the last successful sediment
 * run. This is the single biggest cost optimization in the v6 redesign:
 *
 *   - turn 1: window = entire history (~365K tokens)  → checkpoint = head
 *   - turn 2: window = ONLY new entries (~2-20K)       → checkpoint advances
 *   - turn 3: same                                     → ...
 *
 * Without checkpoints we'd re-feed the entire branch on every turn and
 * make every turn cost 100K+ tokens × 3 voters = 1M tokens/turn.
 *
 * Checkpoint advances ONLY on terminal outcomes:
 *   - SKIP / SKIP_DUPLICATE      → advance (insight rejected, won't change)
 *   - write success              → advance (committed)
 *   - parse failure              → DO NOT advance (transient; retry next turn)
 *   - tool/network error         → DO NOT advance (transient)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { buildWindowText } from "./entry-text";

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".pi", ".gbrain-cache");

function stateFilePath(track: string): string {
  // Sanitize track name to filename-safe chars
  const safe = track.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return path.join(STATE_DIR, `sediment-checkpoint-${safe}.json`);
}

interface CheckpointState {
  /** Most recently processed entry id; null = first run, process all. */
  lastProcessedEntryId: string | null;
  /** Last update timestamp for diagnostics. */
  updatedAt: string;
}

function loadState(track: string): CheckpointState {
  try {
    const raw = fs.readFileSync(stateFilePath(track), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.lastProcessedEntryId === "string" || parsed?.lastProcessedEntryId === null) {
      return parsed as CheckpointState;
    }
  } catch { /* fall through to default */ }
  return { lastProcessedEntryId: null, updatedAt: new Date().toISOString() };
}

function saveState(track: string, state: CheckpointState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = stateFilePath(track);
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* best-effort; next turn will retry */ }
}

export interface RunWindow {
  /** Rendered text of the window for prompt assembly. */
  text: string;
  /** Number of entries actually included after truncation. */
  entryCount: number;
  /** True if older entries were dropped to fit MAX_WINDOW_CHARS. */
  truncated: boolean;
  /** First entry id in the window (inclusive). */
  fromEntryId: string | null;
  /** Last entry id in the window (inclusive); becomes new checkpoint on success. */
  toEntryId: string;
  /** Total entries in the slice before truncation. */
  rawSliceSize: number;
}

/**
 * Build the run window: slice of entries since lastProcessedEntryId,
 * inclusive of head. Returns null when:
 *   - branch is empty
 *   - last checkpoint == head (nothing new since last run)
 *
 * Recovery: if lastProcessedEntryId no longer exists in the branch
 * (compaction wiped it), reset to head-only — don't re-emit the whole
 * pre-compaction history.
 */
export function buildRunWindow(branch: any[], track: string): RunWindow | null {
  if (!Array.isArray(branch) || branch.length === 0) return null;

  const head = branch[branch.length - 1];
  if (!head?.id) return null;
  const headIdx = branch.length - 1;

  const state = loadState(track);
  let startIdx: number;

  if (!state.lastProcessedEntryId) {
    // First run for this state file — process everything up to head.
    startIdx = 0;
  } else if (state.lastProcessedEntryId === head.id) {
    // Nothing new since last successful run.
    return null;
  } else {
    const lastIdx = branch.findIndex((e) => e?.id === state.lastProcessedEntryId);
    if (lastIdx >= 0) {
      startIdx = lastIdx + 1;
    } else {
      // Recovery: checkpoint was compacted away. Reset to head only.
      startIdx = headIdx;
    }
  }

  if (startIdx > headIdx) return null;

  const slice = branch.slice(startIdx, headIdx + 1);
  const window = buildWindowText(slice);
  if (!window.text.trim()) return null;

  return {
    text: window.text,
    entryCount: window.entryCount,
    truncated: window.truncated,
    fromEntryId: state.lastProcessedEntryId,
    toEntryId: head.id,
    rawSliceSize: slice.length,
  };
}

/** Advance checkpoint to the given entry id. Call only on terminal success. */
export function advanceCheckpoint(track: string, toEntryId: string): void {
  saveState(track, {
    lastProcessedEntryId: toEntryId,
    updatedAt: new Date().toISOString(),
  });
}

/** Read current checkpoint (for diagnostics / status display). */
export function getCheckpoint(track: string): string | null {
  return loadState(track).lastProcessedEntryId;
}
