/**
 * Abrain auto-sync to remote (ADR 0020).
 *
 * Provides four operations against the `~/.abrain` git repo:
 *
 *   - pushAsync()    fire-and-forget after sediment commits; single-flight locked
 *   - fetchAndFF()   pi startup fetch + fast-forward only (never merge / rebase)
 *   - sync()         /abrain sync slash command: fetch+ff+push in one call
 *   - getStatus()    /abrain status: ahead/behind/last-sync/last-error
 *
 * Design principles (per ADR 0020 + 2026-05-15 decision):
 *
 *   1. ALL git ops are silent-by-default. Failures write to
 *      ~/.abrain/.state/git-sync.jsonl (audit) and never throw to caller.
 *      Sediment's commit path must NEVER be blocked by network/auth issues.
 *
 *   2. Conflict resolution is OUT OF SCOPE: ff-only is the only merge
 *      strategy. Divergence → abort + audit + user-visible hint via the
 *      `/abrain status` slash command. No LLM auto-merge (explicitly
 *      rejected in design discussion — hallucination risk in knowledge
 *      base content is unacceptable for a long-term substrate).
 *
 *   3. No git ops when there's no `origin` remote — silently skipped.
 *      This keeps users who run abrain locally without a remote unaffected.
 *
 *   4. Single-flight in-process: concurrent sediment commits in the SAME
 *      pi process would race on git's index lock; we serialize via an
 *      in-memory promise singleton. Cross-process protection (multiple pi
 *      instances) relies on git's own .git/index.lock — that's the
 *      fail-soft path (one wins, others audit-log a failed result).
 *
 *   5. Argv contains zero secrets. We only pass branch names and standard
 *      git verbs; credentials come from the system git credential helper
 *      (typically ~/.git-credentials or SSH agent). This matches the
 *      vault.ts pattern: never inject plaintext via argv.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BUFFER = 1024 * 1024;

export type GitSyncOp = "push" | "fetch" | "sync";

/**
 * Sync result taxonomy. Distinct codes for the audit log so `/abrain status`
 * can surface the right hint without parsing error strings.
 *
 *   ok            success (push completed / ff merged)
 *   noop          nothing to do (ahead=0 for push; behind=0 for fetch)
 *   skipped       no git repo or no origin remote — silently inactive
 *   diverged      fetch found local+remote both have new commits; ff refused
 *   push_rejected git push rejected (remote ahead; user must pull first)
 *   timeout       git command exceeded timeout (likely network)
 *   failed        any other error (auth, fs, network reset, etc.)
 */
export type GitSyncResult =
  | "ok"
  | "noop"
  | "skipped"
  | "diverged"
  | "push_rejected"
  | "timeout"
  | "failed";

export interface GitSyncEvent {
  ts: string;
  op: GitSyncOp;
  result: GitSyncResult;
  ahead?: number;
  behind?: number;
  durationMs?: number;
  error?: string;
}

export interface GitSyncOptions {
  abrainHome: string;
  timeoutMs?: number;
}

// ── single-flight lock ──────────────────────────────────────────────
//
// Protects against concurrent in-process git ops racing on .git/index.lock.
// Multiple sediment writes during one agent_end can call pushAsync nearly
// simultaneously; without this lock the second push fails with "fatal:
// Unable to create '.git/index.lock'" and we'd audit it as a spurious
// failure even though the first push succeeded.
let inflightOp: Promise<GitSyncEvent> | null = null;

async function singleFlight(
  fn: () => Promise<GitSyncEvent>,
): Promise<GitSyncEvent> {
  // Wait for any prior op to finish, but don't propagate its error —
  // each op records its own outcome in audit.
  if (inflightOp) {
    await inflightOp.catch(() => undefined);
  }
  const p = fn();
  inflightOp = p;
  try {
    return await p;
  } finally {
    // Only clear if no newer op has overwritten the slot in the meantime.
    if (inflightOp === p) inflightOp = null;
  }
}

// Visible for tests. Lets smoke verify single-flight by inspecting the lock.
export function _hasInflightOp(): boolean {
  return inflightOp !== null;
}

// ── git helpers ─────────────────────────────────────────────────────

/**
 * Is `abrainHome` a git repo with an `origin` remote? Used to decide
 * whether any sync op should run at all.
 *
 * Returns false on:
 *   - .git missing (not a repo)
 *   - `git remote get-url origin` failing (no origin configured)
 *   - timeout (treat as "doesn't really work, skip")
 */
export async function hasGitRemote(abrainHome: string): Promise<boolean> {
  if (!existsSync(path.join(abrainHome, ".git"))) return false;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "remote", "get-url", "origin"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    return Boolean(stdout.trim());
  } catch {
    return false;
  }
}

/**
 * Resolve ahead/behind vs origin/main. Returns {0,0} if anything goes
 * wrong (e.g. origin/main not yet fetched). The format
 *   `git rev-list --left-right --count origin/main...HEAD`
 * prints "<behind>\t<ahead>" — that's the git convention for left=base.
 */
export async function getAheadBehind(
  abrainHome: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "rev-list", "--left-right", "--count", "origin/main...HEAD"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    const parts = stdout.trim().split(/\s+/);
    const behind = parseInt(parts[0] ?? "0", 10);
    const ahead = parseInt(parts[1] ?? "0", 10);
    return {
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

/**
 * Append one event to ~/.abrain/.state/git-sync.jsonl. Best-effort:
 * audit-write failure must never block the actual sync path (we'd be
 * masking the original outcome by throwing on log write).
 */
async function audit(abrainHome: string, event: GitSyncEvent): Promise<void> {
  try {
    const stateDir = path.join(abrainHome, ".state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(
      path.join(stateDir, "git-sync.jsonl"),
      JSON.stringify(event) + "\n",
      "utf-8",
    );
  } catch {
    // intentionally silent
  }
}

/**
 * Classify an execFile error into a GitSyncResult code.
 * Used by both pushAsync and fetchAndFF so taxonomy stays consistent.
 */
function classifyError(e: unknown): { result: GitSyncResult; message: string } {
  const err = e as { killed?: boolean; signal?: string; message?: string; stderr?: string };
  const msg = String(err?.message || err || "unknown");
  const stderr = String(err?.stderr || "");
  const combined = msg + " " + stderr;

  if (err?.killed && err?.signal) {
    return { result: "timeout", message: msg.slice(0, 500) };
  }
  if (/rejected|non-fast-forward|stale|fetch first|behind/i.test(combined)) {
    return { result: "push_rejected", message: msg.slice(0, 500) };
  }
  return { result: "failed", message: msg.slice(0, 500) };
}

// ── public ops ──────────────────────────────────────────────────────

/**
 * Push HEAD to origin/main. Single-flight protected.
 *
 * Behavior:
 *   - no remote / not a repo → result: "skipped"
 *   - ahead = 0              → result: "noop" (don't even invoke git push)
 *   - push success           → result: "ok"
 *   - remote rejected        → result: "push_rejected" (user must pull first)
 *   - network/auth/timeout   → result: "failed" or "timeout"
 *
 * Never throws. Always records to audit.
 */
export async function pushAsync(opts: GitSyncOptions): Promise<GitSyncEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  if (!(await hasGitRemote(opts.abrainHome))) {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "push",
      result: "skipped",
      durationMs: Date.now() - start,
    };
    await audit(opts.abrainHome, event);
    return event;
  }

  return singleFlight(async () => {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "push",
      result: "ok",
      durationMs: 0,
    };
    try {
      const { ahead, behind } = await getAheadBehind(opts.abrainHome);
      event.ahead = ahead;
      event.behind = behind;

      if (ahead === 0) {
        event.result = "noop";
        event.durationMs = Date.now() - start;
        await audit(opts.abrainHome, event);
        return event;
      }

      // Use HEAD:main to push current branch (whatever it's called locally)
      // to the remote main branch. Resilient to non-conventional local
      // branch names.
      await execFileAsync(
        "git",
        ["-C", opts.abrainHome, "push", "origin", "HEAD:main"],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      );

      event.result = "ok";
      event.durationMs = Date.now() - start;
    } catch (e: unknown) {
      const { result, message } = classifyError(e);
      event.result = result;
      event.error = message;
      event.durationMs = Date.now() - start;
    }
    await audit(opts.abrainHome, event);
    return event;
  });
}

/**
 * Fetch origin and fast-forward main. If ff isn't possible (diverged or
 * conflicting), abort and report "diverged" — NEVER auto-merge or rebase.
 *
 * Behavior:
 *   - no remote / not a repo → result: "skipped"
 *   - behind = 0             → result: "noop" (don't merge)
 *   - ahead = 0 + behind > 0 → ff merge → result: "ok"
 *   - ahead > 0 + behind > 0 → result: "diverged" (manual resolve)
 *   - any error              → result: "failed" or "timeout"
 *
 * Never throws.
 */
export async function fetchAndFF(opts: GitSyncOptions): Promise<GitSyncEvent> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  if (!(await hasGitRemote(opts.abrainHome))) {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "fetch",
      result: "skipped",
      durationMs: Date.now() - start,
    };
    await audit(opts.abrainHome, event);
    return event;
  }

  return singleFlight(async () => {
    const event: GitSyncEvent = {
      ts: new Date().toISOString(),
      op: "fetch",
      result: "ok",
      durationMs: 0,
    };
    try {
      // Step 1: fetch (no merge). Updates origin/main ref only.
      await execFileAsync(
        "git",
        ["-C", opts.abrainHome, "fetch", "origin", "main"],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      );

      const { ahead, behind } = await getAheadBehind(opts.abrainHome);
      event.ahead = ahead;
      event.behind = behind;

      if (behind === 0) {
        // Nothing new on remote.
        event.result = "noop";
      } else if (ahead === 0) {
        // Pure fast-forward: local has no unique commits.
        await execFileAsync(
          "git",
          ["-C", opts.abrainHome, "merge", "--ff-only", "origin/main"],
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER },
        );
        event.result = "ok";
      } else {
        // Both have unique commits — diverged. Refuse to merge.
        event.result = "diverged";
        event.error = `local ahead ${ahead}, remote ahead ${behind}; ff-only refused`;
      }
      event.durationMs = Date.now() - start;
    } catch (e: unknown) {
      const { result, message } = classifyError(e);
      event.result = result;
      event.error = message;
      event.durationMs = Date.now() - start;
    }
    await audit(opts.abrainHome, event);
    return event;
  });
}

/**
 * Manual /abrain sync slash command driver. fetch+ff first, then push.
 * Returns a human-readable summary string for `ui.notify` and the raw
 * events for audit/inspection.
 *
 * If fetch results in "diverged", we skip push (no point — remote would
 * reject anyway) and surface a runbook string telling the user exactly
 * what commands to run manually.
 */
export async function sync(opts: GitSyncOptions): Promise<{
  events: GitSyncEvent[];
  ok: boolean;
  summary: string;
}> {
  const fetchEvent = await fetchAndFF(opts);

  if (fetchEvent.result === "diverged") {
    const summary =
      `diverged: local has ${fetchEvent.ahead} commit(s), remote has ${fetchEvent.behind} commit(s) not in local.\n` +
      `ff-only merge refused. resolve manually:\n` +
      `  cd ${opts.abrainHome}\n` +
      `  git fetch origin && git status\n` +
      `  # then either: git merge origin/main   (creates merge commit)\n` +
      `  #         or: git rebase origin/main   (replays your commits on top)\n` +
      `  # then run /abrain sync again`;
    return { events: [fetchEvent], ok: false, summary };
  }

  if (
    fetchEvent.result !== "ok" &&
    fetchEvent.result !== "noop" &&
    fetchEvent.result !== "skipped"
  ) {
    return {
      events: [fetchEvent],
      ok: false,
      summary: `fetch failed (${fetchEvent.result}): ${fetchEvent.error || "unknown"}`,
    };
  }

  const pushEvent = await pushAsync(opts);

  const ok =
    pushEvent.result === "ok" ||
    pushEvent.result === "noop" ||
    pushEvent.result === "skipped";
  const pushedHint = pushEvent.result === "ok" && pushEvent.ahead
    ? ` (${pushEvent.ahead} commit(s) pushed)` : "";

  const summary = ok
    ? `synced: fetch=${fetchEvent.result}, push=${pushEvent.result}${pushedHint}`
    : `fetch=${fetchEvent.result}, push=${pushEvent.result}: ${pushEvent.error || "unknown"}`;

  return { events: [fetchEvent, pushEvent], ok, summary };
}

/**
 * Snapshot of current sync state for /abrain status command.
 * Read-only — does not invoke git fetch.
 */
export interface AbrainSyncStatus {
  isGitRepo: boolean;
  remote?: string;
  branch?: string;
  ahead: number;
  behind: number;
  lastPush?: GitSyncEvent;
  lastFetch?: GitSyncEvent;
}

export async function getStatus(abrainHome: string): Promise<AbrainSyncStatus> {
  if (!existsSync(path.join(abrainHome, ".git"))) {
    return { isGitRepo: false, ahead: 0, behind: 0 };
  }

  const status: AbrainSyncStatus = { isGitRepo: true, ahead: 0, behind: 0 };

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "remote", "get-url", "origin"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    status.remote = stdout.trim();
  } catch {
    // no remote — leave undefined
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", abrainHome, "branch", "--show-current"],
      { timeout: 3_000, maxBuffer: 64 * 1024 },
    );
    status.branch = stdout.trim() || undefined;
  } catch {
    // no branch (detached HEAD?) — leave undefined
  }

  if (status.remote) {
    const ab = await getAheadBehind(abrainHome);
    status.ahead = ab.ahead;
    status.behind = ab.behind;
  }

  // Tail the audit log to find the most recent push and fetch events.
  // Bounded read (last 200 KB) so a huge audit file doesn't slow status.
  try {
    const auditPath = path.join(abrainHome, ".state", "git-sync.jsonl");
    const handle = await fs.open(auditPath, "r");
    try {
      const stats = await handle.stat();
      const readSize = Math.min(stats.size, 200 * 1024);
      const offset = stats.size - readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, offset);
      const text = buf.toString("utf-8");
      const lines = text.trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as GitSyncEvent;
          if (ev.op === "push" && !status.lastPush) status.lastPush = ev;
          if (ev.op === "fetch" && !status.lastFetch) status.lastFetch = ev;
          if (status.lastPush && status.lastFetch) break;
        } catch {
          // skip malformed audit lines
        }
      }
    } finally {
      await handle.close();
    }
  } catch {
    // no audit yet — leave lastPush/lastFetch undefined
  }

  return status;
}

/**
 * Format AbrainSyncStatus as a multi-line string for /abrain status output.
 * Pure formatter — separated so it can be unit tested without touching git.
 */
export function formatSyncStatus(status: AbrainSyncStatus): string {
  if (!status.isGitRepo) {
    return "abrain repo: not a git repo (auto-sync inactive)";
  }
  const lines: string[] = [];
  lines.push(`abrain git sync (ADR 0020):`);
  lines.push(`  remote: ${status.remote || "(none — auto-sync inactive)"}`);
  if (status.branch) lines.push(`  branch: ${status.branch}`);
  if (status.remote) {
    lines.push(`  ahead:  ${status.ahead}${status.ahead > 0 ? " (run /abrain sync to push)" : ""}`);
    lines.push(`  behind: ${status.behind}${status.behind > 0 ? " (run /abrain sync to ff-pull)" : ""}`);
  }
  const fmtEvent = (label: string, ev?: GitSyncEvent): string => {
    if (!ev) return `  last ${label}: (none recorded)`;
    const dur = ev.durationMs != null ? ` ${ev.durationMs}ms` : "";
    const err = ev.error ? ` — ${ev.error.split("\n")[0].slice(0, 80)}` : "";
    return `  last ${label}: ${ev.ts} ${ev.result}${dur}${err}`;
  };
  lines.push(fmtEvent("push", status.lastPush));
  lines.push(fmtEvent("fetch", status.lastFetch));
  if (status.ahead > 0 && status.behind > 0) {
    lines.push("  ⚠ diverged — run /abrain sync for runbook");
  }
  return lines.join("\n");
}
