/**
 * audit-logger — writes structured JSON Lines to sediment.log.
 *
 * Each agent_end produces a group of events (job:start, voter:prep, ..., job:end).
 * In Slice B dry-run mode, no voter events are emitted.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const AUDIT_LOG_PATH = join(homedir(), ".pi", ".gbrain-cache", "sediment.log");
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 5;

// Ensure log directory exists
const logDir = dirname(AUDIT_LOG_PATH);
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

// ── rotation ───────────────────────────────────────────────────

function rotateIfNeeded() {
  try {
    if (!existsSync(AUDIT_LOG_PATH)) return;
    const stat = statSync(AUDIT_LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: sediment.log → sediment.log.1, etc.
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const oldPath = i === 1 ? AUDIT_LOG_PATH : `${AUDIT_LOG_PATH}.${i - 1}`;
      const newPath = `${AUDIT_LOG_PATH}.${i}`;
      if (existsSync(newPath)) {
        // Delete the oldest if it exceeds rotation limit
        if (i === MAX_ROTATIONS) {
          const { unlinkSync } = require("node:fs");
          try { unlinkSync(newPath); } catch {}
        }
      }
      if (existsSync(oldPath)) {
        renameSync(oldPath, newPath);
      }
    }
  } catch {
    // Rotation is best-effort
  }
}

// ── event types ────────────────────────────────────────────────

export type SedimentLogEvent =
  | { type: "job:start"; ts: string; jobId: string; cwd: string; resolverSource: string; scope: string }
  | { type: "classifier:done"; ts: string; jobId: string; candidatesCount: number; markerHit: boolean; secretHit: boolean }
  | { type: "pending"; ts: string; jobId: string; reason: string; slug?: string; candidatePreview: string }
  | { type: "job:end"; ts: string; jobId: string; totalDurationMs: number; candidatesConsidered: number; written: number; pending: number; skipped: number; skipReasons: string[]; writtenSlugs: string[]; voterTools: string }
  ;

// ── write ──────────────────────────────────────────────────────

export function writeLogEntry(entry: SedimentLogEvent) {
  rotateIfNeeded();
  try {
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Log writing is best-effort; don't crash sediment for log failures
  }
}

export function getLogPath(): string {
  return AUDIT_LOG_PATH;
}
