/**
 * pending-queue — manages ~/.pi/.gbrain-cache/sediment-pending.jsonl
 *
 * All candidates that fail quorum, trigger security scanners, or come from
 * dry-run mode are written here for alfadb review.
 *
 * Reason-sensitive schema (ADR 0004 § 6, v6.5.2):
 * - secret_scan_hit: only stores redacted preview + contentHash + pattern
 * - prompt_injection_suspected: only stores summary + markers
 * - dry_run / votes_disagree: stores full candidate
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PENDING_PATH = join(homedir(), ".pi", ".gbrain-cache", "sediment-pending.jsonl");

// Ensure directory exists
const pendingDir = dirname(PENDING_PATH);
if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true });

// ── types ──────────────────────────────────────────────────────

export interface PendingBase {
  id: string;
  ts: string;
  jobId: string;
  reason: string;
  contextHint: string;
}

export interface PendingDryRun extends PendingBase {
  reason: "dry_run";
  candidate: Record<string, unknown>;
}

export interface PendingSecretHit extends PendingBase {
  reason: "secret_scan_hit";
  candidatePreview: string;
  contentHash: string;
  matchedPattern: string;
}

export interface PendingInjection extends PendingBase {
  reason: "prompt_injection_suspected";
  candidatePreview: string;
  matchedMarkers: string[];
}

export type PendingRecord = PendingDryRun | PendingSecretHit | PendingInjection;

// ── write ──────────────────────────────────────────────────────

export function appendPending(record: PendingRecord) {
  try {
    appendFileSync(PENDING_PATH, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Best-effort
  }
}

export function readPending(): PendingRecord[] {
  try {
    if (!existsSync(PENDING_PATH)) return [];
    const raw = readFileSync(PENDING_PATH, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function countPending(): number {
  try {
    if (!existsSync(PENDING_PATH)) return 0;
    const raw = readFileSync(PENDING_PATH, "utf8");
    return raw.split("\n").filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

export function getPendingPath(): string {
  return PENDING_PATH;
}
