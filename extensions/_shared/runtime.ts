/**
 * Shared runtime utilities for pi-astack extensions.
 *
 * - Local-timezone ISO 8601 timestamp (replaces UTC `toISOString()`)
 * - Path resolvers that route per-extension state/log files into
 *   `<projectRoot>/.pi-astack/<module>/...` rather than the legacy
 *   `<projectRoot>/.pensieve/.state/...` location.
 *
 * Boundary:
 * - `.pi-astack/<module>/`  — runtime state, audit logs, locks, backups
 * - `.pensieve/`            — canonical markdown knowledge + browsable
 *                             derived views (_index.md, .index/graph.json)
 *
 * This file deliberately has zero imports from sibling extensions.
 */
import * as fs from "node:fs";
import { execFileSync as nodeExecFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * Format a Date as ISO 8601 with the LOCAL timezone offset, e.g.:
 *
 *   2026-05-08T14:08:38.295+08:00
 *
 * (Replaces `new Date().toISOString()` which always emits UTC.)
 *
 * Stable across DST transitions because the offset is computed from the
 * Date instance at the moment of formatting.
 */
export function formatLocalIsoTimestamp(d: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  // getTimezoneOffset returns minutes WEST of UTC (positive for negative
  // offsets), so flip the sign to get the conventional "+08:00".
  const offsetMin = -d.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offsetMins = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offsetSign}${offsetHours}:${offsetMins}`;
}

/**
 * Generate a backup directory name from the local-timezone timestamp.
 * Uses dashes instead of colons (filesystem-safe) and drops the ms separator.
 *
 *   2026-05-08T14-08-38-295+08-00
 */
export function localTimestampForFilename(d: Date = new Date()): string {
  return formatLocalIsoTimestamp(d).replace(/:/g, "-").replace(/\./, "-");
}

/** Root for all pi-astack runtime artifacts within a given project. */
export function piAstackRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack");
}

/** Per-module subdirectory under `.pi-astack/`. */
export function piAstackModuleDir(projectRoot: string, module: string): string {
  return path.join(piAstackRoot(projectRoot), module);
}

/* -------- sediment ----------------------------------------------------- */

export function sedimentDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "sediment");
}
export function sedimentAuditPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "audit.jsonl");
}
export function sedimentCheckpointPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "checkpoint.json");
}
export function sedimentLocksDir(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "locks");
}
export function sedimentMigrationBackupsDir(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "migration-backups");
}

/* -------- memory ------------------------------------------------------- */

export function memoryDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "memory");
}
export function memoryMigrationReportPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), "migration-report.md");
}
export function memorySearchMetricsPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), "search-metrics.jsonl");
}

/* -------- compaction-tuner -------------------------------------------- */

export function compactionTunerDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "compaction-tuner");
}
export function compactionTunerAuditPath(projectRoot: string): string {
  return path.join(compactionTunerDir(projectRoot), "audit.jsonl");
}

/* -------- model-fallback ----------------------------------------------- */

export function modelFallbackDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "model-fallback");
}
export function modelFallbackCanaryPath(projectRoot: string): string {
  return path.join(modelFallbackDir(projectRoot), "canary.log");
}
/** Legacy home-level location, used to be `~/.pi-extensions/model-fallback.log`. */
export function legacyModelFallbackCanaryPath(home: string): string {
  return path.join(home, ".pi-extensions", "model-fallback.log");
}
export function legacyRetryStreamEofPath(home: string): string {
  return path.join(home, ".pi-extensions", "retry-stream-eof.log");
}

/* -------- legacy fallback paths ---------------------------------------- *
 * Returned alongside the canonical paths so consumers can read either
 * location during the transition window. Once existing data is migrated,
 * these can be removed.                                                    */

export function legacySedimentAuditPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-events.jsonl");
}
export function legacySedimentCheckpointPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-checkpoint.json");
}
export function legacySedimentLocksDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "locks");
}
export function legacySedimentMigrationBackupsDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "migration-backups");
}
export function legacyMemoryMigrationReportPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "migration-report.md");
}

/* -------- abrain project identity ------------------------------------- *
 * ADR 0014 active project is a boot-time snapshot: callers should resolve
 * once from pi's startup cwd and keep that project id stable for the session.
 * Bash `cd` must not dynamically switch active project / vault visibility. */

export interface AbrainProjectBinding {
  cwd: string;
  project: string;
  boundAt?: string;
  boundVia?: string;
  gitRemote?: string;
  raw: Record<string, string>;
}

export type ActiveProjectMatchKind = "git_root_exact" | "git_remote" | "cwd_prefix";

export interface ActiveProjectResolution {
  projectId: string;
  binding: AbrainProjectBinding;
  matchedBy: ActiveProjectMatchKind;
  cwd: string;
  lookupCwd: string;
  bindingsPath: string;
  gitRoot?: string;
  gitRemote?: string;
}

export type ResolveActiveProjectResult =
  | { activeProject: ActiveProjectResolution; reason?: undefined }
  | {
      activeProject: null;
      reason: "bindings_missing" | "bindings_empty" | "unbound" | "ambiguous_remote" | "ambiguous_prefix" | "invalid_cwd";
      cwd: string;
      bindingsPath: string;
      gitRoot?: string;
      gitRemote?: string;
    };

export interface ResolveActiveProjectOptions {
  abrainHome: string;
  bindingsPath?: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  execFileSync?: (file: string, args: string[], options: { cwd?: string; encoding: BufferEncoding; stdio?: Array<"ignore" | "pipe">; timeout?: number }) => string;
}

export interface BrainPaths {
  abrainHome: string;
  projectsDir: string;
  bindingsPath: string;
  projectDir: string;
  projectVaultDir: string;
}

export function abrainProjectsDir(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), "projects");
}
export function abrainProjectBindingsPath(abrainHome: string): string {
  return path.join(abrainProjectsDir(abrainHome), "_bindings.md");
}
export function abrainProjectDir(abrainHome: string, projectId: string): string {
  validateAbrainProjectId(projectId);
  return path.join(abrainProjectsDir(abrainHome), projectId);
}
export function abrainProjectVaultDir(abrainHome: string, projectId: string): string {
  return path.join(abrainProjectDir(abrainHome, projectId), "vault");
}
/**
 * List every project id that has a directory under ~/.abrain/projects/.
 * Skips entries that fail validateAbrainProjectId (defense against
 * traversal / leading-dot files / files mistakenly placed in projects/).
 * Read-only: does not create or migrate anything.
 */
export function listAbrainProjects(abrainHome: string): string[] {
  const root = abrainProjectsDir(abrainHome);
  if (!fs.existsSync(root)) return [];
  const ids: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    try { validateAbrainProjectId(id); } catch { continue; }
    ids.push(id);
  }
  ids.sort();
  return ids;
}

export function resolveBrainPaths(abrainHome: string, projectId: string): BrainPaths {
  const root = path.resolve(abrainHome);
  return {
    abrainHome: root,
    projectsDir: abrainProjectsDir(root),
    bindingsPath: abrainProjectBindingsPath(root),
    projectDir: abrainProjectDir(root, projectId),
    projectVaultDir: abrainProjectVaultDir(root, projectId),
  };
}

export function validateAbrainProjectId(projectId: string): void {
  if (!projectId) throw new Error("project id cannot be empty");
  if (projectId.length > 128) throw new Error(`project id too long (${projectId.length} > 128)`);
  if (projectId.startsWith(".")) throw new Error(`project id cannot start with '.': ${projectId}`);
  if (projectId.includes("/") || projectId.includes("\\")) throw new Error(`project id cannot contain path separators: ${projectId}`);
  if (projectId.includes("..")) throw new Error(`project id cannot contain '..': ${projectId}`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(projectId)) throw new Error(`project id must match [a-zA-Z0-9_.-]+: ${projectId}`);
}

function unquoteYamlScalar(raw: string): string {
  let value = raw.trim().replace(/\s+#.*$/, "");
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function parseBindingKeyValue(line: string): [string, string] | null {
  const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
  if (!match) return null;
  return [match[1]!, unquoteYamlScalar(match[2] ?? "")];
}

function bindingFromRaw(raw: Record<string, string>): AbrainProjectBinding | null {
  const cwd = raw.cwd?.trim();
  const project = raw.project?.trim();
  if (!cwd || !project) return null;
  try { validateAbrainProjectId(project); } catch { return null; }
  return {
    cwd,
    project,
    boundAt: raw.bound_at,
    boundVia: raw.bound_via,
    gitRemote: raw.git_remote,
    raw: { ...raw },
  };
}

export function parseProjectBindingsMarkdown(markdown: string): AbrainProjectBinding[] {
  const bindings: AbrainProjectBinding[] = [];
  let current: Record<string, string> | null = null;

  const flush = () => {
    if (!current) return;
    const binding = bindingFromRaw(current);
    if (binding) bindings.push(binding);
    current = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      flush();
      current = {};
      const rest = trimmed.slice(2).trim();
      if (rest) {
        const kv = parseBindingKeyValue(rest);
        if (kv) current[kv[0]] = kv[1];
      }
      continue;
    }
    if (!current) continue;
    const kv = parseBindingKeyValue(trimmed);
    if (kv) current[kv[0]] = kv[1];
  }
  flush();
  return bindings;
}

export function canonicalizeGitRemote(remote: string | undefined | null): string | null {
  if (!remote) return null;
  let value = unquoteYamlScalar(remote);
  if (!value) return null;
  value = value.replace(/^git\+/, "").replace(/\/$/, "");
  const scpLike = value.match(/^([^/@:]+)@([^:]+):(.+)$/);
  if (scpLike) value = `ssh://${scpLike[1]}@${scpLike[2]}/${scpLike[3]}`;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    let pathname = url.pathname.replace(/^\/+/, "").replace(/\/$/, "");
    pathname = pathname.replace(/\.git$/i, "");
    return `${host}/${pathname}`.toLowerCase();
  } catch {
    return value.replace(/\.git$/i, "").toLowerCase();
  }
}

function normalizeBindingCwd(cwd: string): string {
  const expanded = cwd.startsWith("~/") ? path.join(process.env.HOME ?? "", cwd.slice(2)) : cwd;
  return path.resolve(expanded);
}

function isPathPrefix(prefix: string, target: string): boolean {
  const rel = path.relative(prefix, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && rel !== ".." && !path.isAbsolute(rel));
}

function findGitRoot(cwd: string, opts: ResolveActiveProjectOptions): string | undefined {
  const exec = opts.execFileSync ?? nodeExecFileSync;
  try {
    return path.resolve(exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim());
  } catch {
    return undefined;
  }
}

function findGitRemote(gitRoot: string | undefined, opts: ResolveActiveProjectOptions): string | undefined {
  if (!gitRoot) return undefined;
  const exec = opts.execFileSync ?? nodeExecFileSync;
  try {
    const out = exec("git", ["config", "--get", "remote.origin.url"], {
      cwd: gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function uniqueProjectIds(bindings: AbrainProjectBinding[]): string[] {
  return Array.from(new Set(bindings.map((b) => b.project)));
}

function activeProjectResult(
  binding: AbrainProjectBinding,
  matchedBy: ActiveProjectMatchKind,
  cwd: string,
  lookupCwd: string,
  bindingsPath: string,
  gitRoot: string | undefined,
  gitRemote: string | undefined,
): ResolveActiveProjectResult {
  return {
    activeProject: {
      projectId: binding.project,
      binding,
      matchedBy,
      cwd,
      lookupCwd,
      bindingsPath,
      gitRoot,
      gitRemote,
    },
  };
}

export function resolveActiveProject(cwd: string, opts: ResolveActiveProjectOptions): ResolveActiveProjectResult {
  let normalizedCwd: string;
  try { normalizedCwd = path.resolve(cwd); }
  catch {
    const bindingsPath = opts.bindingsPath ?? abrainProjectBindingsPath(opts.abrainHome);
    return { activeProject: null, reason: "invalid_cwd", cwd, bindingsPath };
  }

  const bindingsPath = opts.bindingsPath ?? abrainProjectBindingsPath(opts.abrainHome);
  const exists = opts.existsSync ?? fs.existsSync;
  const read = opts.readFileSync ?? fs.readFileSync;
  const gitRoot = findGitRoot(normalizedCwd, opts);
  const gitRemote = findGitRemote(gitRoot, opts);
  if (!exists(bindingsPath)) return { activeProject: null, reason: "bindings_missing", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };

  const bindings = parseProjectBindingsMarkdown(read(bindingsPath, "utf8"));
  if (bindings.length === 0) return { activeProject: null, reason: "bindings_empty", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };
  const lookupCwd = gitRoot ?? normalizedCwd;

  if (gitRoot) {
    const exact = bindings.filter((b) => normalizeBindingCwd(b.cwd) === gitRoot);
    const projects = uniqueProjectIds(exact);
    if (projects.length > 1) return { activeProject: null, reason: "ambiguous_prefix", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };
    if (exact[0]) return activeProjectResult(exact[0], "git_root_exact", normalizedCwd, lookupCwd, bindingsPath, gitRoot, gitRemote);
  }

  const currentRemote = canonicalizeGitRemote(gitRemote);
  if (currentRemote) {
    const remoteMatches = bindings.filter((b) => canonicalizeGitRemote(b.gitRemote) === currentRemote);
    const projects = uniqueProjectIds(remoteMatches);
    if (projects.length > 1) return { activeProject: null, reason: "ambiguous_remote", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };
    if (remoteMatches[0]) return activeProjectResult(remoteMatches[0], "git_remote", normalizedCwd, lookupCwd, bindingsPath, gitRoot, gitRemote);
  }

  const prefixMatches = bindings
    .map((binding) => ({ binding, cwd: normalizeBindingCwd(binding.cwd) }))
    .filter((b) => isPathPrefix(b.cwd, normalizedCwd))
    .sort((a, b) => b.cwd.length - a.cwd.length);
  if (prefixMatches.length > 0) {
    const bestLen = prefixMatches[0]!.cwd.length;
    const best = prefixMatches.filter((b) => b.cwd.length === bestLen).map((b) => b.binding);
    const projects = uniqueProjectIds(best);
    if (projects.length > 1) return { activeProject: null, reason: "ambiguous_prefix", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };
    return activeProjectResult(best[0]!, "cwd_prefix", normalizedCwd, lookupCwd, bindingsPath, gitRoot, gitRemote);
  }

  return { activeProject: null, reason: "unbound", cwd: normalizedCwd, bindingsPath, gitRoot, gitRemote };
}

/* -------- one-shot legacy data migration ------------------------------ *
 * Moves pi-astack-owned state files from the legacy `.pensieve/.state/`
 * location to `.pi-astack/<module>/`. Idempotent and racy-safe enough for
 * single-process use: skips if the target already exists.
 *
 * Called from `appendAudit` and `loadCheckpoint` so the move happens at
 * the first runtime touch after a code upgrade, with no separate user
 * script required. A per-project flag avoids re-running per call.        */

const migrated = new Set<string>();

export async function ensureSedimentLegacyMigrated(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  // Per-process flag avoids re-statting on every audit append. Cleared on
  // process restart, so post-restart migrations re-run once if a stray
  // legacy file showed up since last cycle.
  if (migrated.has(root)) return;
  migrated.add(root);

  const fs = await import("node:fs/promises");
  const fsSync = await import("node:fs");

  /**
   * Move legacy audit file to canonical location. If both exist (e.g.,
   * a stray write happened between two restarts of mixed code paths),
   * APPEND the legacy content to canonical and remove legacy. Care is
   * taken to produce exactly one `\n` between rows: never zero (would
   * fuse two JSONL lines) and never two+ (would inject blank rows that
   * pass `if (!line.trim()) continue` filters but waste readers' time).
   */
  async function migrateAuditFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: append legacy content to canonical, then remove legacy.
    const legacyRaw = await fs.readFile(oldPath, "utf-8");
    // Strip leading/trailing whitespace, collapse internal blank lines.
    // Each non-empty line must end with exactly one `\n` in the output.
    const lines = legacyRaw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      // Ensure canonical ends with `\n` so the appended block doesn't
      // accidentally fuse onto the previous final row. Standard JSONL
      // append-writes always close with `\n`, so this is usually a no-op.
      const newEndsWithNL = await fileEndsWithNewline(newPath);
      const prefix = newEndsWithNL ? "" : "\n";
      await fs.appendFile(newPath, prefix + lines.join("\n") + "\n", "utf-8");
    }
    await fs.unlink(oldPath);
  }

  async function fileEndsWithNewline(file: string): Promise<boolean> {
    const stat = await fs.stat(file);
    if (stat.size === 0) return true;
    const fd = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(1);
      await fd.read(buf, 0, 1, stat.size - 1);
      return buf[0] === 0x0a;
    } finally {
      await fd.close();
    }
  }

  /**
   * Move legacy checkpoint to canonical location. If both exist, prefer
   * the LATER `lastProcessedEntryId` (or canonical when ambiguous) so we
   * don't replay already-processed entries. Stale legacy gets removed.
   */
  async function migrateCheckpointFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: keep canonical (assumed authoritative under new code),
    // unlink legacy.
    await fs.unlink(oldPath);
  }

  await migrateAuditFile(legacySedimentAuditPath(root), sedimentAuditPath(root));
  await migrateCheckpointFile(legacySedimentCheckpointPath(root), sedimentCheckpointPath(root));
  // Locks are ephemeral; do not migrate. Migration-backups already pruned.
}
