/**
 * Batch-collect per-file git author-date for a directory scope.
 *
 * Used by per-repo migration (`migrate-go.ts`) to recover real
 * `created` / `updated` timestamps from git history when legacy
 * `.pensieve/` frontmatter only carries best-effort YYYY-MM-DD dates
 * (often just mirror of the slug prefix, almost never refreshed).
 *
 * Why author-date (`%aI`) instead of committer-date (`%cI`):
 *   - Author-date is fixed when the change was first authored and
 *     survives rebase / cherry-pick / commit --amend / merge replay.
 *   - Committer-date is rewritten on every rebase, so a rebased repo
 *     reports "modified yesterday" for every file that was actually
 *     authored weeks ago. Use `%aI` to keep historical signal stable.
 *
 * Why two separate `git log` invocations:
 *   - First-add uses `--diff-filter=A --reverse` so the earliest
 *     `git add`-ing commit wins (file may have been deleted and re-
 *     added across history; we want the very first creation).
 *   - Last-touch uses default (reverse-chronological) order with no
 *     filter so any commit that touched the file (mod/rename/delete)
 *     counts, and the first occurrence we see is the most recent.
 *
 * Rename behavior: we deliberately do NOT pass `--follow`. `--follow`
 * only accepts a single path argument and would force one subprocess
 * per file (O(N) instead of O(1) for the whole tree). The cost is
 * that a renamed file's first-add resolves to the rename commit, not
 * the original creation. For .pensieve content this is a rare and
 * acceptable trade — rename also resets fs `birthtime`, so even with
 * `--follow` we couldn't surface the pre-rename timestamp through fs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { throwIfAborted } from "./utils";

const execFileAsync = promisify(execFile);

export interface GitAuthorTimes {
  /** Map<absolutePath, ISO author-date> for the commit that first added the file. */
  firstByPath: Map<string, string>;
  /** Map<absolutePath, ISO author-date> for the most recent commit touching the file. */
  lastByPath: Map<string, string>;
}

// %aI is strict-ISO 8601 with timezone, e.g. 2026-04-30T16:43:21+08:00.
// Header lines look like: <40-hex-sha>|<iso>.
const HEADER_LINE = /^([0-9a-f]{40})\|(.+)$/;

/**
 * Parse the interleaved (header, name-only file list) output of
 * `git log --pretty=format:%H|%aI --name-only`. Empty lines separate
 * commit blocks; non-empty, non-header lines are filenames belonging
 * to the most recently parsed commit header.
 */
function parseGitLogBlocks(
  stdout: string,
  onCommit: (iso: string, files: string[]) => void,
): void {
  let iso: string | null = null;
  let files: string[] = [];
  const flush = () => {
    if (iso !== null) onCommit(iso, files);
    iso = null;
    files = [];
  };
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    const m = HEADER_LINE.exec(line);
    if (m) {
      flush();
      iso = m[2]!;
    } else if (line.length > 0) {
      // Filename row (git log --name-only emits one per line).
      files.push(line);
    }
    // Blank line: commit block separator; do not flush yet — git
    // emits blanks both inside and between blocks, and flushing on
    // every blank would split single commits with empty trailers.
  }
  flush();
}

async function runGitLog(
  repoRoot: string,
  extraArgs: string[],
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "-c",
        // Force unquoted path output so non-ASCII filenames stay
        // byte-identical to fs paths (path.resolve compares strictly).
        "core.quotePath=false",
        ...extraArgs,
      ],
      {
        timeout: 60_000,
        // .pensieve scope is bounded in practice (hundreds of files,
        // tens of MB of log). 128MB headroom keeps us safe even for
        // long-history repos like ~/.pi without paying the streaming
        // complexity tax.
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    return stdout;
  } catch {
    // Repo unreadable / scope outside repo / no commits yet. Caller
    // resolveCreated / resolveUpdated fall back to fs / frontmatter.
    return "";
  }
}

/**
 * Collect `%aI` first-add and last-touch times for every file under
 * `scopePath` (typically the project's `.pensieve/` directory).
 *
 * Keys are ABSOLUTE filesystem paths to match the absolute paths that
 * the migration loop already holds (`path.resolve(repoRoot, gitRel)`).
 * Caller is expected to look up entries by their absolute `file` path.
 *
 * Failure modes (all degrade to empty maps, never throw):
 *   - `repoRoot` is not a git repo
 *   - `scopePath` is outside the repo
 *   - `git` is missing / times out
 *   - The repo has zero commits touching `scopePath`
 *
 * Resolve* helpers in migrate-go.ts treat a missing key as "no git
 * signal available" and fall through to fs.birthtime / fs.mtime /
 * frontmatter / migrationTimestamp in that order.
 */
export async function collectGitAuthorTimes(
  repoRoot: string,
  scopePath: string,
  signal?: AbortSignal,
): Promise<GitAuthorTimes> {
  const result: GitAuthorTimes = {
    firstByPath: new Map(),
    lastByPath: new Map(),
  };

  // First-add: --reverse + --diff-filter=A walks history oldest→newest
  // emitting only commits that ADD a file. The first time we see a
  // path, that ISO is its earliest add (even if later deleted + re-
  // added — we keep the earliest).
  const firstOut = await runGitLog(
    repoRoot,
    [
      "log",
      "--reverse",
      "--diff-filter=A",
      "--name-only",
      "--pretty=format:%H|%aI",
      "--",
      scopePath,
    ],
    signal,
  );
  parseGitLogBlocks(firstOut, (iso, files) => {
    for (const f of files) {
      const abs = path.resolve(repoRoot, f);
      if (!result.firstByPath.has(abs)) result.firstByPath.set(abs, iso);
    }
  });

  // Last-touch: default order (newest→oldest) with no diff filter so
  // every commit that touched the file counts. First sighting of a
  // path is the most recent commit involving it.
  const lastOut = await runGitLog(
    repoRoot,
    [
      "log",
      "--name-only",
      "--pretty=format:%H|%aI",
      "--",
      scopePath,
    ],
    signal,
  );
  parseGitLogBlocks(lastOut, (iso, files) => {
    for (const f of files) {
      const abs = path.resolve(repoRoot, f);
      if (!result.lastByPath.has(abs)) result.lastByPath.set(abs, iso);
    }
  });

  return result;
}
