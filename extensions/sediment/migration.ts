import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "../memory/settings";
import { rebuildGraphIndex } from "../memory/graph";
import { rebuildMarkdownIndex } from "../memory/index-file";
import {
  defaultConfidence,
  extractTitle,
  inferKindFromPath,
  parseFrontmatter,
  scalarNumber,
  scalarString,
  splitCompiledTruth,
  splitFrontmatter,
} from "../memory/parser";
import { lintMarkdown } from "../memory/lint";
import { clamp, normalizeBareSlug, slugify, titleFromSlug } from "../memory/utils";
import type { SedimentSettings } from "./settings";
import { sanitizeForMemory } from "./sanitizer";
import { appendAudit } from "./writer";

const execFileAsync = promisify(execFile);

type MigrateOneStatus = "applied" | "dry_run" | "rejected";
type RestoreMigrationBackupStatus = "restored" | "rejected";

export interface MigrateOneDerivedResult {
  graph?: {
    path: string;
    nodeCount: number;
    edgeCount: number;
    deadLinkCount: number;
    orphanCount: number;
  };
  index?: {
    path: string;
    entryCount: number;
    kindCount: number;
    orphanCount: number;
  };
  error?: string;
}

export interface MigrateOnePreview {
  frontmatter: string;
  compiledTruthPreview: string;
  timelinePreview: string[];
}

export interface MigrateOneResult {
  status: MigrateOneStatus;
  reason?: string;
  slug?: string;
  title?: string;
  source_path: string;
  target_path?: string;
  backup_path?: string;
  target_exists?: boolean;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  actions?: string[];
  preview?: MigrateOnePreview;
  derived?: MigrateOneDerivedResult;
}

export interface RestoreMigrationBackupResult {
  status: RestoreMigrationBackupStatus;
  reason?: string;
  slug?: string;
  title?: string;
  source_path?: string;
  target_path?: string;
  backup_path: string;
  removed_target?: boolean;
  gitCommit?: string | null;
  derived?: MigrateOneDerivedResult;
}

interface LockHandle {
  release(): Promise<void>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function normalizeLegacyKind(kindOrType: string): string {
  const k = kindOrType.toLowerCase();
  if (k === "maxim") return "maxim";
  if (k === "decision") return "decision";
  if (k === "pattern") return "pattern";
  if (k === "anti-pattern" || k === "antipattern") return "anti-pattern";
  if (k === "preference") return "preference";
  if (k === "smell") return "smell";
  if (k === "knowledge") return "fact";
  if (k === "pipeline") return "pipeline";
  return k || "fact";
}

function inferLegacyArea(relPath: string): { area: string; shortTerm: boolean; unsupported?: string } {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  const shortTerm = parts[0] === "short-term";
  const head = shortTerm ? parts[1] : parts[0];

  if (!head || head === "state.md") return { area: "", shortTerm, unsupported: "support file outside memory entry directories" };
  if (head === "pipelines") return { area: head, shortTerm, unsupported: "pipeline resources are not migrated by memory schema v1" };
  if (["maxims", "decisions", "knowledge", "staging", "archive"].includes(head)) {
    return { area: head, shortTerm };
  }
  return { area: head, shortTerm, unsupported: `unsupported memory directory: ${head}` };
}

function targetForLegacy(sourcePath: string, pensieveRoot: string, relPath: string, slug: string): string {
  const { area, shortTerm } = inferLegacyArea(relPath);
  if (!area) return sourcePath;
  const basename = path.basename(sourcePath);
  const targetDir = path.join(pensieveRoot, area);
  if (basename === "content.md") return path.join(targetDir, `${slug}.md`);
  if (shortTerm) return path.join(targetDir, `${slug}.md`);
  return sourcePath;
}

function addDaysIso(dateLike: string | undefined, days: number): string {
  const base = dateLike && /^\d{4}-\d{2}-\d{2}/.test(dateLike)
    ? new Date(`${dateLike.slice(0, 10)}T00:00:00Z`)
    : new Date();
  if (Number.isNaN(base.getTime())) return addDaysIso(undefined, days);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function projectSlug(projectRoot: string): string {
  try {
    const cfgPath = path.join(projectRoot, ".pensieve", "config.yml");
    const raw = fsSync.readFileSync(cfgPath, "utf-8");
    const match = raw.match(/^\s*id:\s*([A-Za-z0-9_.-]+)/m) || raw.match(/^\s*project:\s*\n(?:.*\n)*?\s+id:\s*([A-Za-z0-9_.-]+)/m);
    if (match?.[1]) return slugify(match[1]);
  } catch {}
  return slugify(path.basename(projectRoot) || "project");
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function backupPath(pensieveRoot: string, sourcePath: string): string {
  const rel = path.relative(pensieveRoot, sourcePath);
  return path.join(pensieveRoot, ".state", "migration-backups", timestampSlug(), rel);
}

async function acquireLock(projectRoot: string, timeoutMs: number): Promise<LockHandle> {
  const lockDir = path.join(projectRoot, ".pensieve", ".state", "locks");
  const lockPath = path.join(lockDir, "sediment.lock");
  await fs.mkdir(lockDir, { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), op: "migrate-one" }));
      await handle.close();
      return { release: async () => { await fs.unlink(lockPath).catch(() => undefined); } };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      if (Date.now() - start > timeoutMs) throw new Error(`sediment lock timeout after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

function uniqueGitPaths(projectRoot: string, paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const rel = path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

async function isIgnoredByGit(projectRoot: string, relPath: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", projectRoot, "check-ignore", "-q", "--", relPath], { timeout: 2_000, maxBuffer: 128 * 1024 });
    return true;
  } catch {
    // Exit code 1 means "not ignored"; other failures are handled by the later best-effort git add.
    return false;
  }
}

async function stageableGitPaths(projectRoot: string, pathsToStage: string[]): Promise<string[]> {
  const relPaths = uniqueGitPaths(projectRoot, pathsToStage);
  const out: string[] = [];
  for (const rel of relPaths) {
    if (await isIgnoredByGit(projectRoot, rel)) continue;
    out.push(rel);
  }
  return out;
}

async function gitCommitMigration(projectRoot: string, slug: string, pathsToStage: string[], action = "migrate"): Promise<string | null> {
  try {
    const relPaths = await stageableGitPaths(projectRoot, pathsToStage);
    if (relPaths.length === 0) return null;
    await execFileAsync("git", ["-C", projectRoot, "add", "-A", "--", ...relPaths], { timeout: 5_000, maxBuffer: 512 * 1024 });
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", `memory: ${action} ${slug}`], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function rebuildDerivedIndexes(projectRoot: string, memorySettings: MemorySettings): Promise<MigrateOneDerivedResult> {
  try {
    const target = path.join(projectRoot, ".pensieve");
    const graph = await rebuildGraphIndex(target, memorySettings, undefined, projectRoot);
    const index = await rebuildMarkdownIndex(target, memorySettings, undefined, projectRoot);
    return {
      graph: {
        path: graph.graph_path,
        nodeCount: graph.nodeCount,
        edgeCount: graph.edgeCount,
        deadLinkCount: graph.deadLinkCount,
        orphanCount: graph.orphanCount,
      },
      index: {
        path: index.index_path,
        entryCount: index.entryCount,
        kindCount: index.kindCount,
        orphanCount: index.orphanCount,
      },
    };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function derivedGitPaths(derived: MigrateOneDerivedResult): string[] {
  return [derived.graph?.path, derived.index?.path].filter((p): p is string => !!p);
}

function truncatePreview(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function buildMigrationPreview(markdown: string): MigrateOnePreview {
  const { frontmatterText, body } = splitFrontmatter(markdown);
  const split = splitCompiledTruth(body);
  return {
    frontmatter: frontmatterText,
    compiledTruthPreview: truncatePreview(split.compiledTruth.trim(), 1_200),
    timelinePreview: split.timeline.slice(0, 5),
  };
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return undefined;
    throw e;
  }
}

function backupRestorePaths(projectRoot: string, backupInput: string): { backupPath: string; originalRel: string; originalPath: string } {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const backupsRoot = path.join(pensieveRoot, ".state", "migration-backups");
  const backupPath = path.resolve(projectRoot, backupInput);
  if (!isInside(backupsRoot, backupPath)) {
    throw new Error("backup must be inside .pensieve/.state/migration-backups");
  }

  const rel = path.relative(backupsRoot, backupPath);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length < 2) throw new Error("backup path must include timestamp and original relative path");
  const originalRel = parts.slice(1).join(path.sep);
  const originalPath = path.join(pensieveRoot, originalRel);
  if (!isInside(pensieveRoot, originalPath)) throw new Error("backup original path escapes .pensieve");
  if (originalRel.startsWith(`.state${path.sep}`) || originalRel.startsWith(`.index${path.sep}`)) {
    throw new Error("refusing to restore .state/.index files");
  }
  return { backupPath, originalRel, originalPath };
}

function buildMigratedMarkdown(args: {
  raw: string;
  sourcePath: string;
  relPath: string;
  projectRoot: string;
  memorySettings: MemorySettings;
}): { slug: string; title: string; markdown: string; shortTerm: boolean; targetPath: string; actions: string[] } {
  const { frontmatterText, body } = splitFrontmatter(args.raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const split = splitCompiledTruth(body);
  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(args.sourcePath, path.extname(args.sourcePath)) === "content"
    ? path.basename(path.dirname(args.sourcePath))
    : path.basename(args.sourcePath, path.extname(args.sourcePath));
  const slug = normalizeBareSlug(id || pathSlug || extractTitle(body) || "entry");
  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const kind = normalizeLegacyKind(scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(args.relPath));
  const status = scalarString(frontmatter.status) || "active";
  const confidence = clamp(scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind), 0, 10);
  const created = scalarString(frontmatter.created) || todayIso();
  const updated = scalarString(frontmatter.updated) || created;
  const area = inferLegacyArea(args.relPath);
  const expires = addDaysIso(created, args.memorySettings.shortTermTtlDays);
  const targetPath = targetForLegacy(args.sourcePath, path.join(args.projectRoot, ".pensieve"), args.relPath, slug);
  const timeline = split.timeline.length > 0
    ? split.timeline
    : [`- ${todayIso()} | migrate | migrated from legacy format`];

  const lifetime = area.shortTerm
    ? ["lifetime:", "  kind: ttl", `  expires_at: ${expires}`]
    : [];

  const markdown = [
    "---",
    `id: project:${projectSlug(args.projectRoot)}:${slug}`,
    "scope: project",
    `kind: ${kind}`,
    `status: ${status}`,
    `confidence: ${confidence}`,
    "schema_version: 1",
    `title: ${yamlString(title)}`,
    `created: ${created}`,
    `updated: ${updated}`,
    ...lifetime,
    "---",
    "",
    split.compiledTruth.trim() || `# ${title}`,
    "",
    "## Timeline",
    "",
    ...timeline,
    "",
  ].join("\n");

  const actions = ["write schema_version v1 frontmatter", "ensure ## Timeline"];
  if (area.shortTerm) actions.push(`add ttl lifetime until ${expires}`);
  if (targetPath !== args.sourcePath) actions.push("move to canonical path");
  return { slug, title, markdown, shortTerm: area.shortTerm, targetPath, actions };
}

interface RestorePreflightOk {
  expectedMarkdown: string;
  built: ReturnType<typeof buildMigratedMarkdown>;
  displaySource: string;
  displayTarget: string;
  samePath: boolean;
  targetExists: boolean;
  alreadyRestored: boolean;
}

async function restorePreflight(args: {
  raw: string;
  originalPath: string;
  originalRel: string;
  projectRoot: string;
  memorySettings: MemorySettings;
}): Promise<RestorePreflightOk> {
  const built = buildMigratedMarkdown({
    raw: args.raw,
    sourcePath: args.originalPath,
    relPath: args.originalRel,
    projectRoot: args.projectRoot,
    memorySettings: args.memorySettings,
  });
  const sanitize = sanitizeForMemory(built.markdown);
  if (!sanitize.ok) throw new Error(`cannot verify migrated target: ${sanitize.error}`);

  const expectedMarkdown = sanitize.text ?? built.markdown;
  const samePath = path.resolve(args.originalPath) === path.resolve(built.targetPath);
  const originalRaw = await readTextIfExists(args.originalPath);
  const targetRaw = samePath ? originalRaw : await readTextIfExists(built.targetPath);
  const originalIsBackup = originalRaw === args.raw;
  const targetIsExpected = targetRaw === expectedMarkdown;
  const targetExists = targetRaw !== undefined;

  if (samePath) {
    if (originalIsBackup) {
      return {
        expectedMarkdown,
        built,
        displaySource: path.relative(args.projectRoot, args.originalPath) || args.originalPath,
        displayTarget: path.relative(args.projectRoot, built.targetPath) || built.targetPath,
        samePath,
        targetExists,
        alreadyRestored: true,
      };
    }
    if (!targetIsExpected) throw new Error(originalRaw === undefined ? "source_missing" : "source_modified");
  } else {
    if (originalRaw !== undefined && !originalIsBackup) throw new Error("source_exists");
    if (targetRaw !== undefined && !targetIsExpected) throw new Error("target_modified");
  }

  return {
    expectedMarkdown,
    built,
    displaySource: path.relative(args.projectRoot, args.originalPath) || args.originalPath,
    displayTarget: path.relative(args.projectRoot, built.targetPath) || built.targetPath,
    samePath,
    targetExists,
    alreadyRestored: !samePath && originalIsBackup && !targetExists,
  };
}

export async function restoreMigrationBackup(
  backupInput: string,
  opts: {
    projectRoot: string;
    sedimentSettings: SedimentSettings;
    memorySettings: MemorySettings;
    yes: boolean;
  },
): Promise<RestoreMigrationBackupResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const displayBackup = path.relative(projectRoot, path.resolve(projectRoot, backupInput)) || backupInput;
  if (!opts.yes) return { status: "rejected", reason: "--yes required", backup_path: displayBackup };

  let paths: { backupPath: string; originalRel: string; originalPath: string };
  try {
    paths = backupRestorePaths(projectRoot, backupInput);
  } catch (e: unknown) {
    return { status: "rejected", reason: e instanceof Error ? e.message : String(e), backup_path: displayBackup };
  }

  let raw: string;
  try {
    raw = await fs.readFile(paths.backupPath, "utf-8");
  } catch (e: unknown) {
    return { status: "rejected", reason: e instanceof Error ? e.message : String(e), backup_path: path.relative(projectRoot, paths.backupPath) };
  }

  let preflight: RestorePreflightOk;
  try {
    preflight = await restorePreflight({
      raw,
      originalPath: paths.originalPath,
      originalRel: paths.originalRel,
      projectRoot,
      memorySettings: opts.memorySettings,
    });
  } catch (e: unknown) {
    return { status: "rejected", reason: e instanceof Error ? e.message : String(e), backup_path: path.relative(projectRoot, paths.backupPath) };
  }

  if (preflight.alreadyRestored) {
    return {
      status: "restored",
      reason: "already_restored",
      slug: preflight.built.slug,
      title: preflight.built.title,
      source_path: preflight.displaySource,
      target_path: preflight.displayTarget,
      backup_path: path.relative(projectRoot, paths.backupPath),
      removed_target: false,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.sedimentSettings.lockTimeoutMs);
    preflight = await restorePreflight({
      raw,
      originalPath: paths.originalPath,
      originalRel: paths.originalRel,
      projectRoot,
      memorySettings: opts.memorySettings,
    });
    if (preflight.alreadyRestored) {
      return {
        status: "restored",
        reason: "already_restored",
        slug: preflight.built.slug,
        title: preflight.built.title,
        source_path: preflight.displaySource,
        target_path: preflight.displayTarget,
        backup_path: path.relative(projectRoot, paths.backupPath),
        removed_target: false,
      };
    }

    await atomicWrite(paths.originalPath, raw);
    let removedTarget = false;
    if (!preflight.samePath && preflight.targetExists) {
      await fs.unlink(preflight.built.targetPath);
      removedTarget = true;
    }

    const derived = await rebuildDerivedIndexes(projectRoot, opts.memorySettings);
    const git = opts.sedimentSettings.gitCommit
      ? await gitCommitMigration(projectRoot, preflight.built.slug, [paths.originalPath, preflight.built.targetPath, ...derivedGitPaths(derived)], "restore")
      : null;
    await appendAudit(projectRoot, {
      operation: "migrate_one_restore",
      source: paths.originalRel,
      target: preflight.displayTarget,
      backup: path.relative(projectRoot, paths.backupPath),
      slug: preflight.built.slug,
      removed_target: removedTarget,
      derived,
      git_commit: git,
      duration_ms: Date.now() - started,
    });

    return {
      status: "restored",
      slug: preflight.built.slug,
      title: preflight.built.title,
      source_path: preflight.displaySource,
      target_path: preflight.displayTarget,
      backup_path: path.relative(projectRoot, paths.backupPath),
      removed_target: removedTarget,
      gitCommit: git,
      derived,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await appendAudit(projectRoot, {
      operation: "migrate_one_restore_error",
      backup: path.relative(projectRoot, paths.backupPath),
      reason: message,
      duration_ms: Date.now() - started,
    });
    return {
      status: "rejected",
      reason: message,
      slug: preflight.built.slug,
      title: preflight.built.title,
      source_path: preflight.displaySource,
      target_path: preflight.displayTarget,
      backup_path: path.relative(projectRoot, paths.backupPath),
    };
  } finally {
    await lock?.release();
  }
}

export async function migrateOne(
  sourceInput: string,
  opts: {
    projectRoot: string;
    sedimentSettings: SedimentSettings;
    memorySettings: MemorySettings;
    apply: boolean;
    yes: boolean;
    plan?: boolean;
  },
): Promise<MigrateOneResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const sourcePath = path.resolve(projectRoot, sourceInput);
  const displaySource = path.relative(projectRoot, sourcePath) || sourcePath;

  const plan = !!opts.plan;
  if (plan && opts.apply) return { status: "rejected", reason: "use either --plan or --apply, not both", source_path: displaySource };
  if (!plan && !opts.apply) return { status: "rejected", reason: "--plan or --apply required", source_path: displaySource };
  if (opts.apply && !opts.yes) return { status: "rejected", reason: "--yes required", source_path: displaySource };
  if (!sourcePath.endsWith(".md")) return { status: "rejected", reason: "source must be a markdown file", source_path: displaySource };
  if (!isInside(pensieveRoot, sourcePath)) return { status: "rejected", reason: "source must be inside .pensieve", source_path: displaySource };

  const relPath = path.relative(pensieveRoot, sourcePath);
  if (relPath.startsWith(`.state${path.sep}`) || relPath.startsWith(`.index${path.sep}`)) {
    return { status: "rejected", reason: "refusing to migrate .state/.index files", source_path: displaySource };
  }
  const area = inferLegacyArea(relPath);
  if (area.unsupported) return { status: "rejected", reason: area.unsupported, source_path: displaySource };

  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, "utf-8");
  } catch (e: unknown) {
    return { status: "rejected", reason: e instanceof Error ? e.message : String(e), source_path: displaySource };
  }

  const built = buildMigratedMarkdown({ raw, sourcePath, relPath, projectRoot, memorySettings: opts.memorySettings });
  const displayTarget = path.relative(projectRoot, built.targetPath) || built.targetPath;
  const sanitize = sanitizeForMemory(built.markdown);
  if (!sanitize.ok) {
    const auditPath = plan ? undefined : await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: sanitize.error, source: relPath, duration_ms: Date.now() - started });
    return { status: "rejected", reason: sanitize.error, source_path: displaySource, target_path: displayTarget, slug: built.slug, title: built.title, actions: built.actions, ...(auditPath ? { backup_path: auditPath } : {}) };
  }

  const markdown = sanitize.text ?? built.markdown;
  const preview = buildMigrationPreview(markdown);
  const lint = lintMarkdown(markdown, built.targetPath);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = plan ? undefined : await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: "lint_error", source: relPath, target: displayTarget, lintErrors, lintWarnings, duration_ms: Date.now() - started });
    return { status: "rejected", reason: "lint_error", source_path: displaySource, target_path: displayTarget, slug: built.slug, title: built.title, lintErrors, lintWarnings, actions: built.actions, preview, ...(auditPath ? { backup_path: auditPath } : {}) };
  }

  const samePath = path.resolve(sourcePath) === path.resolve(built.targetPath);
  const targetExists = !samePath && fsSync.existsSync(built.targetPath);
  if (targetExists) {
    const auditPath = plan ? undefined : await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: "target_exists", source: relPath, target: displayTarget, duration_ms: Date.now() - started });
    return { status: "rejected", reason: "target_exists", source_path: displaySource, target_path: displayTarget, slug: built.slug, title: built.title, target_exists: true, lintErrors, lintWarnings, actions: built.actions, preview, ...(auditPath ? { backup_path: auditPath } : {}) };
  }

  if (plan) {
    return {
      status: "dry_run",
      slug: built.slug,
      title: built.title,
      source_path: displaySource,
      target_path: displayTarget,
      target_exists: false,
      lintErrors,
      lintWarnings,
      actions: built.actions,
      preview,
    };
  }

  let lock: LockHandle | undefined;
  const backup = backupPath(pensieveRoot, sourcePath);
  try {
    lock = await acquireLock(projectRoot, opts.sedimentSettings.lockTimeoutMs);
    if (!samePath && fsSync.existsSync(built.targetPath)) {
      return { status: "rejected", reason: "target_exists", source_path: displaySource, target_path: displayTarget, slug: built.slug, title: built.title, target_exists: true, lintErrors, lintWarnings, actions: built.actions, preview };
    }

    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(sourcePath, backup);
    await atomicWrite(built.targetPath, markdown);
    if (!samePath) await fs.unlink(sourcePath);

    const derived = await rebuildDerivedIndexes(projectRoot, opts.memorySettings);
    const git = opts.sedimentSettings.gitCommit
      ? await gitCommitMigration(projectRoot, built.slug, [sourcePath, built.targetPath, ...derivedGitPaths(derived)])
      : null;
    await appendAudit(projectRoot, {
      operation: "migrate_one",
      source: relPath,
      target: displayTarget,
      backup: path.relative(projectRoot, backup),
      slug: built.slug,
      lintErrors,
      lintWarnings,
      derived,
      git_commit: git,
      duration_ms: Date.now() - started,
    });

    return {
      status: "applied",
      slug: built.slug,
      title: built.title,
      source_path: displaySource,
      target_path: displayTarget,
      backup_path: path.relative(projectRoot, backup),
      target_exists: false,
      lintErrors,
      lintWarnings,
      gitCommit: git,
      actions: built.actions,
      derived,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await appendAudit(projectRoot, { operation: "migrate_one_error", source: relPath, target: displayTarget, reason: message, duration_ms: Date.now() - started });
    return { status: "rejected", reason: message, source_path: displaySource, target_path: displayTarget, slug: built.slug, title: built.title, lintErrors, lintWarnings, actions: built.actions, preview };
  } finally {
    await lock?.release();
  }
}
