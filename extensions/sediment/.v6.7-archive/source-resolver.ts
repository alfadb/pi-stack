/**
 * sediment/source-resolver — resolve project-track source id from cwd.
 *
 * Resolution priority (returns the first match):
 *   1. .gbrain-source dotfile (walk up from cwd to git root or $HOME)
 *      — explicit, cross-machine portable, ADR 0008 dual-role design
 *   2. git remote.origin.url slug
 *      — auto-derived from `git -C <cwd> config --get remote.origin.url`
 *      — handles ssh / https / git:// formats
 *   3. null (refuse)
 *      — caller skips project-track sediment for this turn (Q4 decision)
 *      — world-track still runs (cross-project insights don't need a source)
 *
 * Why not fall back to basename(repo_root)?
 *   ~/work/foo and ~/play/foo would collide. Returning null is safer than
 *   guessing — the user can drop a .gbrain-source dotfile to opt in.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileP = promisify(execFile);

export interface ResolvedSource {
  /** gbrain source id (lowercase, [a-z0-9-]{1,32}). */
  id: string;
  /** How we found it: "dotfile" | "git_remote". */
  via: "dotfile" | "git_remote";
  /** The directory we'd register the source against (= repo root for dotfile/git, cwd otherwise). */
  rootPath: string;
}

/**
 * Walk up from `start` to find a .gbrain-source dotfile. Stops at git root,
 * filesystem root, or $HOME (whichever first) so we don't accidentally
 * read a parent project's dotfile.
 */
function findDotfile(start: string): { dir: string; content: string } | null {
  const home = process.env.HOME ?? "/";
  let cur = path.resolve(start);
  while (true) {
    const candidate = path.join(cur, ".gbrain-source");
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, "utf-8").trim();
        if (content) return { dir: cur, content };
      } catch { /* fall through */ }
    }
    // Stop at git root, filesystem root, or $HOME
    if (fs.existsSync(path.join(cur, ".git"))) return null;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (cur === home) return null;
    cur = parent;
  }
}

/**
 * Find git repo root by walking up from `start` looking for .git directory.
 * Returns null if not in a git repo.
 */
function findGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Extract source id from a git remote URL. Handles common formats:
 *   git@github.com:alfadb/pi-stack.git       → pi-stack
 *   https://github.com/alfadb/pi-stack.git   → pi-stack
 *   ssh://git@github.com/alfadb/pi-stack     → pi-stack
 *   git://github.com/alfadb/pi-stack.git     → pi-stack
 *
 * Returns null if the URL doesn't yield a clean repo name.
 */
function urlToSlug(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  // Strip trailing .git
  s = s.replace(/\.git\/?$/i, "");
  // Strip trailing slash
  s = s.replace(/\/$/, "");
  // Last path component is the repo name
  const lastSlash = s.lastIndexOf("/");
  const lastColon = s.lastIndexOf(":");
  const cut = Math.max(lastSlash, lastColon);
  if (cut < 0) return null;
  let slug = s.slice(cut + 1);
  // Sanitize to gbrain id constraints: lowercase a-z 0-9 -, max 32
  slug = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  slug = slug.slice(0, 32);
  return slug || null;
}

async function readGitRemote(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["-C", cwd, "config", "--get", "remote.origin.url"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    const url = (stdout ?? "").trim();
    return url || null;
  } catch {
    return null;
  }
}

function isValidSourceId(id: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(id);
}

/**
 * Resolve the project-track source id for a given cwd. Returns null when
 * neither dotfile nor git-remote yields a usable id (project-track will
 * be skipped this turn; world-track still runs).
 */
export async function resolveProjectSource(cwd: string): Promise<ResolvedSource | null> {
  // 1. Dotfile walk-up
  const dotfile = findDotfile(cwd);
  if (dotfile) {
    if (isValidSourceId(dotfile.content)) {
      return { id: dotfile.content, via: "dotfile", rootPath: dotfile.dir };
    }
  }

  // 2. Git remote slug
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const remoteUrl = await readGitRemote(gitRoot);
    if (remoteUrl) {
      const slug = urlToSlug(remoteUrl);
      if (slug && isValidSourceId(slug)) {
        return { id: slug, via: "git_remote", rootPath: gitRoot };
      }
    }
  }

  // 3. Refuse
  return null;
}
