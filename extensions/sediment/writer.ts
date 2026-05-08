import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SedimentSettings } from "./settings";
import { detectProjectDuplicate, type DedupeResult } from "./dedupe";
import { sanitizeForMemory } from "./sanitizer";
import { type EntryKind, type EntryStatus, validateProjectEntryDraft } from "./validation";
import { lintMarkdown } from "../memory/lint";
import { normalizeBareSlug, slugify } from "../memory/utils";
import { ensureSedimentLegacyMigrated, formatLocalIsoTimestamp, sedimentAuditPath, sedimentLocksDir } from "../_shared/runtime";

const AUDIT_SCHEMA_VERSION = 2;

const execFileAsync = promisify(execFile);

export interface ProjectEntryDraft {
  title: string;
  kind: EntryKind;
  compiledTruth: string;
  summary?: string;
  status?: EntryStatus;
  confidence?: number;
  triggerPhrases?: string[];
  sessionId?: string;
  timelineNote?: string;
}

export interface WriteProjectEntryOptions {
  projectRoot: string;
  settings: SedimentSettings;
  dryRun?: boolean;
}

export interface WriteProjectEntryResult {
  slug: string;
  path: string;
  status: "created" | "dry_run" | "rejected";
  reason?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  auditPath?: string;
  sanitizedReplacements?: string[];
  duplicate?: DedupeResult;
  validationErrors?: Array<{ field: string; message: string }>;
}

interface LockHandle {
  release(): Promise<void>;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlList(key: string, values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [
    `${key}:`,
    ...values.map((value) => `  - ${yamlString(value)}`),
  ];
}

function kindDirectory(kind: EntryKind, status?: EntryStatus): string {
  if (status === "archived") return "archive";
  switch (kind) {
    case "maxim": return "maxims";
    case "decision": return "decisions";
    case "smell": return "staging";
    case "anti-pattern":
    case "pattern":
    case "fact":
    case "preference":
    default:
      return "knowledge";
  }
}

function normalizeCompiledTruth(title: string, body: string): string {
  let text = body.trim();
  text = text.replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
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

function buildMarkdown(draft: ProjectEntryDraft, projectRoot: string): { slug: string; markdown: string } {
  const date = todayIso();
  const status = draft.status ?? "provisional";
  const confidence = Math.min(10, Math.max(0, Math.round(draft.confidence ?? 3)));
  const slug = normalizeBareSlug(draft.title);
  const compiledTruth = normalizeCompiledTruth(draft.title, draft.compiledTruth);
  const timelineSession = draft.sessionId || "sediment";
  const timelineNote = draft.timelineNote || "created by sediment project writer";

  const frontmatter = [
    "---",
    `id: project:${projectSlug(projectRoot)}:${slug}`,
    "scope: project",
    `kind: ${draft.kind}`,
    `status: ${status}`,
    `confidence: ${confidence}`,
    "schema_version: 1",
    `title: ${yamlString(draft.title)}`,
    `created: ${date}`,
    `updated: ${date}`,
    ...yamlList("trigger_phrases", draft.triggerPhrases),
    "---",
    "",
  ];

  const markdown = [
    ...frontmatter,
    compiledTruth,
    "",
    "## Timeline",
    "",
    `- ${date} | ${timelineSession} | captured | ${timelineNote}`,
    "",
  ].join("\n");

  return { slug, markdown };
}

async function acquireLock(projectRoot: string, timeoutMs: number): Promise<LockHandle> {
  const lockDir = sedimentLocksDir(projectRoot);
  const lockPath = path.join(lockDir, "sediment.lock");
  await fs.mkdir(lockDir, { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: formatLocalIsoTimestamp() }));
      await handle.close();
      return {
        async release() {
          await fs.unlink(lockPath).catch(() => undefined);
        },
      };
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

async function gitCommit(projectRoot: string, filePath: string, slug: string): Promise<string | null> {
  try {
    const rel = path.relative(projectRoot, filePath);
    await execFileAsync("git", ["-C", projectRoot, "add", rel], { timeout: 5_000, maxBuffer: 512 * 1024 });
    await execFileAsync("git", ["-C", projectRoot, "commit", "-m", `memory: ${slug}`], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function appendAudit(projectRoot: string, event: Record<string, unknown>): Promise<string> {
  await ensureSedimentLegacyMigrated(projectRoot);
  const auditPath = sedimentAuditPath(projectRoot);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  // Schema v2 enrichment: every audit row carries the local-tz timestamp
  // plus standard execution context (PID, project root) so that ad-hoc
  // analysis on the JSONL doesn't need to cross-reference other sources.
  // Per-operation fields from `event` are spread last so callers can
  // override anything (rarely needed).
  const enriched = {
    timestamp: formatLocalIsoTimestamp(),
    audit_version: AUDIT_SCHEMA_VERSION,
    pid: process.pid,
    project_root: path.resolve(projectRoot),
    ...event,
  };
  await fs.appendFile(auditPath, `${JSON.stringify(enriched)}\n`, "utf-8");
  return auditPath;
}

export async function writeProjectEntry(
  draft: ProjectEntryDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  if (!fsSync.existsSync(pensieveRoot)) {
    return { slug: normalizeBareSlug(draft.title), path: pensieveRoot, status: "rejected", reason: ".pensieve directory not found" };
  }

  const validationErrors = validateProjectEntryDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
    });
    return {
      slug: normalizeBareSlug(draft.title),
      path: pensieveRoot,
      status: "rejected",
      reason: "validation_error",
      validationErrors,
      auditPath,
    };
  }

  const titleSanitize = sanitizeForMemory(draft.title);
  const bodySanitize = sanitizeForMemory(draft.compiledTruth);
  const noteSanitize = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true, text: undefined, replacements: [] as string[] };
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize].find((result) => !result.ok);
  if (failedSanitize) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: failedSanitize.error,
      title: draft.title,
      duration_ms: Date.now() - started,
    });
    return { slug: normalizeBareSlug(draft.title), path: pensieveRoot, status: "rejected", reason: failedSanitize.error, auditPath };
  }

  const sanitizedReplacements = [
    ...titleSanitize.replacements,
    ...bodySanitize.replacements,
    ...noteSanitize.replacements,
  ];

  const safeDraft: ProjectEntryDraft = {
    ...draft,
    title: titleSanitize.text ?? draft.title,
    compiledTruth: bodySanitize.text ?? draft.compiledTruth,
    timelineNote: draft.timelineNote ? noteSanitize.text : draft.timelineNote,
  };

  const { slug, markdown } = buildMarkdown(safeDraft, projectRoot);
  const status = safeDraft.status ?? "provisional";
  const target = path.join(pensieveRoot, kindDirectory(safeDraft.kind, status), `${slug}.md`);

  const duplicate = await detectProjectDuplicate(projectRoot, safeDraft.title, { slug });
  if (duplicate.duplicate) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: duplicate.reason === "slug_exact" ? "duplicate_slug" : "duplicate_title",
      target: `project:${slug}`,
      duplicate,
      duration_ms: Date.now() - started,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: duplicate.reason === "slug_exact" ? "duplicate_slug" : "duplicate_title",
      duplicate,
      auditPath,
    };
  }

  const lint = lintMarkdown(markdown, target);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: "lint_error",
      target: `project:${slug}`,
      lintErrors,
      lintWarnings,
      duration_ms: Date.now() - started,
    });
    return { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath };
  }

  if (opts.dryRun) {
    return {
      slug,
      path: target,
      status: "dry_run",
      lintErrors,
      lintWarnings,
      sanitizedReplacements,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.settings.lockTimeoutMs);
    if (fsSync.existsSync(target)) {
      const duplicateRace: DedupeResult = {
        duplicate: true,
        reason: "slug_exact",
        score: 1,
        match: { slug, title: safeDraft.title, kind: safeDraft.kind, status, source_path: path.relative(projectRoot, target) },
      };
      const auditPath = await appendAudit(projectRoot, {
        operation: "reject",
        reason: "duplicate_slug",
        target: `project:${slug}`,
        duplicate: duplicateRace,
        duration_ms: Date.now() - started,
      });
      return { slug, path: target, status: "rejected", reason: "duplicate_slug", duplicate: duplicateRace, auditPath };
    }

    await atomicWrite(target, markdown);
    const git = opts.settings.gitCommit ? await gitCommit(projectRoot, target, slug) : null;
    const auditPath = await appendAudit(projectRoot, {
      operation: "create",
      target: `project:${slug}`,
      path: path.relative(projectRoot, target),
      lint_result: "pass",
      git_commit: git,
      duration_ms: Date.now() - started,
    });

    return {
      slug,
      path: target,
      status: "created",
      lintErrors,
      lintWarnings,
      gitCommit: git,
      auditPath,
      sanitizedReplacements,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, {
      operation: "error",
      target: `project:${slug}`,
      reason: message,
      duration_ms: Date.now() - started,
    });
    return { slug, path: target, status: "rejected", reason: message, lintErrors, lintWarnings, auditPath };
  } finally {
    await lock?.release();
  }
}
