import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "../memory/settings";
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

export interface MigrateOneResult {
  status: MigrateOneStatus;
  reason?: string;
  slug?: string;
  source_path: string;
  target_path?: string;
  backup_path?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  actions?: string[];
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

async function gitCommitMigration(projectRoot: string, sourcePath: string, targetPath: string, slug: string): Promise<string | null> {
  try {
    await execFileAsync("git", ["-C", projectRoot, "add", "-A", path.relative(projectRoot, sourcePath), path.relative(projectRoot, targetPath)], { timeout: 5_000, maxBuffer: 512 * 1024 });
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", `memory: migrate ${slug}`], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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

export async function migrateOne(
  sourceInput: string,
  opts: {
    projectRoot: string;
    sedimentSettings: SedimentSettings;
    memorySettings: MemorySettings;
    apply: boolean;
    yes: boolean;
  },
): Promise<MigrateOneResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const sourcePath = path.resolve(projectRoot, sourceInput);
  const displaySource = path.relative(projectRoot, sourcePath) || sourcePath;

  if (!opts.apply) return { status: "rejected", reason: "apply flag required", source_path: displaySource };
  if (!opts.yes) return { status: "rejected", reason: "--yes required", source_path: displaySource };
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
  const sanitize = sanitizeForMemory(built.markdown);
  if (!sanitize.ok) {
    const auditPath = await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: sanitize.error, source: relPath, duration_ms: Date.now() - started });
    return { status: "rejected", reason: sanitize.error, source_path: displaySource, target_path: path.relative(projectRoot, built.targetPath), slug: built.slug, actions: built.actions, backup_path: auditPath };
  }

  const markdown = sanitize.text ?? built.markdown;
  const lint = lintMarkdown(markdown, built.targetPath);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  const displayTarget = path.relative(projectRoot, built.targetPath) || built.targetPath;
  if (lintErrors > 0) {
    const auditPath = await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: "lint_error", source: relPath, target: displayTarget, lintErrors, lintWarnings, duration_ms: Date.now() - started });
    return { status: "rejected", reason: "lint_error", source_path: displaySource, target_path: displayTarget, slug: built.slug, lintErrors, lintWarnings, actions: built.actions, backup_path: auditPath };
  }

  const samePath = path.resolve(sourcePath) === path.resolve(built.targetPath);
  if (!samePath && fsSync.existsSync(built.targetPath)) {
    const auditPath = await appendAudit(projectRoot, { operation: "migrate_one_reject", reason: "target_exists", source: relPath, target: displayTarget, duration_ms: Date.now() - started });
    return { status: "rejected", reason: "target_exists", source_path: displaySource, target_path: displayTarget, slug: built.slug, lintErrors, lintWarnings, actions: built.actions, backup_path: auditPath };
  }

  let lock: LockHandle | undefined;
  const backup = backupPath(pensieveRoot, sourcePath);
  try {
    lock = await acquireLock(projectRoot, opts.sedimentSettings.lockTimeoutMs);
    if (!samePath && fsSync.existsSync(built.targetPath)) {
      return { status: "rejected", reason: "target_exists", source_path: displaySource, target_path: displayTarget, slug: built.slug, lintErrors, lintWarnings, actions: built.actions };
    }

    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.copyFile(sourcePath, backup);
    await atomicWrite(built.targetPath, markdown);
    if (!samePath) await fs.unlink(sourcePath);
    const git = opts.sedimentSettings.gitCommit ? await gitCommitMigration(projectRoot, sourcePath, built.targetPath, built.slug) : null;
    await appendAudit(projectRoot, {
      operation: "migrate_one",
      source: relPath,
      target: displayTarget,
      backup: path.relative(projectRoot, backup),
      slug: built.slug,
      lintErrors,
      lintWarnings,
      git_commit: git,
      duration_ms: Date.now() - started,
    });

    return {
      status: "applied",
      slug: built.slug,
      source_path: displaySource,
      target_path: displayTarget,
      backup_path: path.relative(projectRoot, backup),
      lintErrors,
      lintWarnings,
      gitCommit: git,
      actions: built.actions,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await appendAudit(projectRoot, { operation: "migrate_one_error", source: relPath, target: displayTarget, reason: message, duration_ms: Date.now() - started });
    return { status: "rejected", reason: message, source_path: displaySource, target_path: displayTarget, slug: built.slug, lintErrors, lintWarnings, actions: built.actions };
  } finally {
    await lock?.release();
  }
}
