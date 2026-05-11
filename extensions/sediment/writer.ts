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
import { parseFrontmatter, splitCompiledTruth, splitFrontmatter } from "../memory/parser";
import type { Jsonish } from "../memory/types";
// `slugify` is the free-text-to-bare-slug normalizer. We deliberately
// do NOT use `normalizeBareSlug` here, because that one is designed
// for path/wikilink/id inputs (`[[X]]`, `project:foo:bar`,
// `path/to/file.md`) and treats `/` as a path separator, taking only
// the last component. For a free-text TITLE that happens to contain
// `/` as punctuation (e.g. "Distinguished by extractor/reason
// Combinations"), normalizeBareSlug would silently truncate to just
// the last segment ("reason-combinations"). Auto-write produced
// exactly this bug on first production fire (2026-05-08); we now
// always slugify titles directly.
import { slugify } from "../memory/utils";
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

export interface WriterAuditContext {
  lane?: "explicit" | "auto_write" | string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

export interface WriteProjectEntryOptions {
  projectRoot: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditOperation?: string;
  auditExtras?: Record<string, unknown>;
  auditContext?: WriterAuditContext;
}

export type DeleteMode = "soft" | "hard";

export interface ProjectEntryUpdateDraft {
  title?: string;
  kind?: EntryKind;
  status?: EntryStatus;
  confidence?: number;
  compiledTruth?: string;
  triggerPhrases?: string[];
  frontmatterPatch?: Record<string, Jsonish | undefined>;
  sessionId?: string;
  timelineNote?: string;
  timelineAction?: string;
}

export interface WriteProjectEntryResult {
  slug: string;
  path: string;
  status: "created" | "updated" | "merged" | "archived" | "superseded" | "deleted" | "skipped" | "dry_run" | "rejected";
  reason?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  auditPath?: string;
  deleteMode?: DeleteMode;
  sanitizedReplacements?: string[];
  duplicate?: DedupeResult;
  validationErrors?: Array<{ field: string; message: string }>;
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

interface LockHandle {
  release(): Promise<void>;
}

function writerAuditFields(opts: WriteProjectEntryOptions, fallbackSessionId?: string): Record<string, unknown> {
  const ctx = opts.auditContext;
  const sessionId = ctx?.sessionId ?? fallbackSessionId;
  return {
    ...(ctx?.lane ? { lane: ctx.lane } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(ctx?.correlationId ? { correlation_id: ctx.correlationId } : {}),
    ...(ctx?.candidateId ? { candidate_id: ctx.candidateId } : {}),
  };
}

function resultAuditFields(opts: WriteProjectEntryOptions, fallbackSessionId?: string): Pick<WriteProjectEntryResult, "lane" | "sessionId" | "correlationId" | "candidateId"> {
  const ctx = opts.auditContext;
  return {
    ...(ctx?.lane ? { lane: ctx.lane } : {}),
    ...((ctx?.sessionId ?? fallbackSessionId) ? { sessionId: ctx?.sessionId ?? fallbackSessionId } : {}),
    ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(ctx?.candidateId ? { candidateId: ctx.candidateId } : {}),
  };
}

function withWriterAuditContext(opts: WriteProjectEntryOptions, fallbackSessionId: string | undefined, event: Record<string, unknown>): Record<string, unknown> {
  return { ...writerAuditFields(opts, fallbackSessionId), ...event };
}

function nowIso(): string {
  return formatLocalIsoTimestamp();
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlValue(value: Jsonish): string[] {
  if (Array.isArray(value)) return value.map((item) => `  - ${yamlString(String(item))}`);
  if (value && typeof value === "object") return [yamlString(JSON.stringify(value))];
  if (typeof value === "boolean") return [value ? "true" : "false"];
  if (typeof value === "number") return [String(value)];
  if (value === null) return ["null"];
  return [yamlString(String(value ?? ""))];
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
  // Defense against frontmatter break-out: a body line that is
  // exactly `---` would terminate frontmatter on the next read pass
  // (see `splitFrontmatter` in extensions/memory/parser.ts). Markdown
  // hr is a real authoring need though, so we don't reject — we escape
  // by indenting one space, which renders identically in CommonMark
  // (a paragraph-leading space does not start a code block) but no
  // longer matches the strict `^---$` frontmatter delimiter regex.
  text = text.replace(/^---$/gm, " ---");
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

async function ensureProjectPensieveRoot(projectRoot: string): Promise<string> {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  await fs.mkdir(pensieveRoot, { recursive: true });
  return pensieveRoot;
}

function buildMarkdown(draft: ProjectEntryDraft, projectRoot: string): { slug: string; markdown: string } {
  const timestamp = nowIso();
  const status = draft.status ?? "provisional";
  const confidence = Math.min(10, Math.max(0, Math.round(draft.confidence ?? 3)));
  const slug = slugify(draft.title);
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
    `created: ${timestamp}`,
    `updated: ${timestamp}`,
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
    `- ${timestamp} | ${timelineSession} | captured | ${timelineNote}`,
    "",
  ].join("\n");

  return { slug, markdown };
}

function frontmatterOrder(frontmatterText: string): string[] {
  const out: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):/);
    if (match && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

function renderFrontmatter(frontmatter: Record<string, Jsonish>, originalOrder: string[]): string {
  const preferred = [
    "id", "scope", "kind", "status", "confidence", "schema_version",
    "title", "created", "updated", "trigger_phrases",
  ];
  const keys = [
    ...preferred,
    ...originalOrder,
    ...Object.keys(frontmatter).sort(),
  ].filter((key, index, arr) => frontmatter[key] !== undefined && arr.indexOf(key) === index);

  const lines = ["---"];
  for (const key of keys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`, ...yamlValue(value));
      continue;
    }
    lines.push(`${key}: ${yamlValue(value)[0]}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function findProjectEntryFile(projectRoot: string, slug: string): Promise<string | undefined> {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const targetName = `${slug}.md`;
  async function walk(dir: string): Promise<string | undefined> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".state" || entry.name === ".index") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await walk(abs);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name === targetName) {
        return abs;
      }
    }
    return undefined;
  }
  return walk(pensieveRoot);
}

function mergeUpdateMarkdown(
  raw: string,
  patch: ProjectEntryUpdateDraft,
  slug: string,
  projectRoot: string,
): { markdown: string; validationDraft: ProjectEntryDraft; sanitizedReplacements: string[] } | { error: string } {
  const timestamp = nowIso();
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth: existingCompiledTruth, timeline } = splitCompiledTruth(body);

  const title = patch.title ?? (typeof frontmatter.title === "string" ? frontmatter.title : slug);
  const kind = patch.kind ?? (typeof frontmatter.kind === "string" ? frontmatter.kind as EntryKind : "fact");
  const status = patch.status ?? (typeof frontmatter.status === "string" ? frontmatter.status as EntryStatus : "provisional");
  const confidenceRaw = patch.confidence ?? (typeof frontmatter.confidence === "number" ? frontmatter.confidence : Number(frontmatter.confidence ?? 3));
  const confidence = Math.min(10, Math.max(0, Math.round(Number.isFinite(confidenceRaw) ? confidenceRaw : 3)));
  const compiledTruth = patch.compiledTruth !== undefined
    ? normalizeCompiledTruth(title, patch.compiledTruth)
    : existingCompiledTruth.trim();

  const validationDraft: ProjectEntryDraft = { title, kind, status, confidence, compiledTruth };
  const validationErrors = validateProjectEntryDraft(validationDraft);
  if (validationErrors.length > 0) return { error: `validation_error: ${validationErrors.map((e) => `${e.field}:${e.message}`).join("; ")}` };

  const titleSanitize = sanitizeForMemory(title);
  const bodySanitize = sanitizeForMemory(compiledTruth);
  const noteSanitize = patch.timelineNote
    ? sanitizeForMemory(patch.timelineNote)
    : { ok: true, text: undefined, replacements: [] as string[] };
  const triggerPhrases = patch.triggerPhrases;
  const triggerPhraseSanitizes = (triggerPhrases ?? []).map((p) => sanitizeForMemory(p));
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize, ...triggerPhraseSanitizes].find((result) => !result.ok);
  if (failedSanitize) return { error: failedSanitize.error ?? "sanitize_error" };

  const safeTitle = titleSanitize.text ?? title;
  const safeCompiledTruth = bodySanitize.text ?? compiledTruth;
  const safeTimelineNote = patch.timelineNote ? (noteSanitize.text ?? patch.timelineNote) : "updated by sediment curator";
  const safeTimelineAction = (patch.timelineAction || "updated").replace(/[|\r\n]/g, " ").trim() || "updated";
  const sanitizedReplacements = [
    ...titleSanitize.replacements,
    ...bodySanitize.replacements,
    ...noteSanitize.replacements,
    ...triggerPhraseSanitizes.flatMap((s) => s.replacements),
  ];

  const nextFrontmatter: Record<string, Jsonish> = {
    ...frontmatter,
    id: frontmatter.id ?? `project:${projectSlug(projectRoot)}:${slug}`,
    scope: "project",
    kind,
    status,
    confidence,
    schema_version: frontmatter.schema_version ?? 1,
    title: safeTitle,
    created: frontmatter.created ?? timestamp,
    updated: timestamp,
    ...(patch.frontmatterPatch ?? {}),
  };
  for (const [key, value] of Object.entries(patch.frontmatterPatch ?? {})) {
    if (value === undefined) delete nextFrontmatter[key];
  }
  if (triggerPhrases) {
    nextFrontmatter.trigger_phrases = triggerPhraseSanitizes.map((s, i) => s.text ?? triggerPhrases[i]);
  }

  const timelineSession = patch.sessionId || "sediment";
  const nextTimeline = [
    ...timeline,
    `- ${timestamp} | ${timelineSession} | ${safeTimelineAction} | ${safeTimelineNote}`,
  ];
  const markdown = [
    renderFrontmatter(nextFrontmatter, frontmatterOrder(frontmatterText)),
    safeCompiledTruth.trim(),
    "",
    "## Timeline",
    "",
    ...nextTimeline,
    "",
  ].join("\n");

  return {
    markdown,
    validationDraft: { title: safeTitle, kind, status, confidence, compiledTruth: safeCompiledTruth },
    sanitizedReplacements,
  };
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

export async function mergeProjectEntries(
  targetSlugRaw: string,
  sourceSlugRaws: string[],
  patch: { compiledTruth: string; reason?: string; sessionId?: string; timelineNote?: string },
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult[]> {
  const targetSlug = slugify(targetSlugRaw);
  const sources = Array.from(new Set(sourceSlugRaws.map((slug) => slugify(slug)).filter(Boolean)));
  const nonTargetSources = sources.filter((slug) => slug !== targetSlug);
  const reason = patch.reason || patch.timelineNote || "merged by sediment curator";
  const targetResult = await updateProjectEntry(targetSlug, {
    compiledTruth: patch.compiledTruth,
    sessionId: patch.sessionId,
    timelineAction: "merged",
    timelineNote: reason,
    frontmatterPatch: nonTargetSources.length > 0 ? { derives_from: nonTargetSources } : undefined,
  }, {
    projectRoot: opts.projectRoot,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "merge",
    auditExtras: { sources, reason },
    auditContext: opts.auditContext,
  });

  const results: WriteProjectEntryResult[] = [
    { ...targetResult, status: targetResult.status === "dry_run" ? "dry_run" : targetResult.status === "rejected" ? "rejected" : "merged" },
  ];
  if (targetResult.status === "rejected") return results;
  for (const source of nonTargetSources) {
    results.push(await archiveProjectEntry(source, {
      projectRoot: opts.projectRoot,
      settings: opts.settings,
      dryRun: opts.dryRun,
      reason: `merged into ${targetSlug}: ${reason}`,
      sessionId: patch.sessionId,
      auditContext: opts.auditContext,
    }));
  }
  return results;
}

export async function archiveProjectEntry(
  slugRaw: string,
  opts: WriteProjectEntryOptions & { reason?: string; sessionId?: string },
): Promise<WriteProjectEntryResult> {
  const reason = opts.reason || "archived by sediment curator";
  const result = await updateProjectEntry(slugRaw, {
    status: "archived",
    sessionId: opts.sessionId,
    timelineAction: "archived",
    timelineNote: reason,
  }, {
    projectRoot: opts.projectRoot,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "archive",
    auditExtras: { reason },
    auditContext: opts.auditContext,
  });
  return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "archived" };
}

export async function supersedeProjectEntry(
  slugRaw: string,
  opts: WriteProjectEntryOptions & { reason?: string; newSlug?: string; sessionId?: string },
): Promise<WriteProjectEntryResult> {
  const reason = opts.reason || "superseded by sediment curator";
  const note = opts.newSlug ? `superseded by ${opts.newSlug}: ${reason}` : reason;
  const result = await updateProjectEntry(slugRaw, {
    status: "superseded",
    sessionId: opts.sessionId,
    timelineAction: "superseded",
    timelineNote: note,
    frontmatterPatch: opts.newSlug ? { superseded_by: [opts.newSlug] } : undefined,
  }, {
    projectRoot: opts.projectRoot,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "supersede",
    auditExtras: { reason, ...(opts.newSlug ? { new_slug: opts.newSlug } : {}) },
    auditContext: opts.auditContext,
  });
  return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "superseded" };
}

export async function deleteProjectEntry(
  slugRaw: string,
  opts: WriteProjectEntryOptions & { reason?: string; mode?: DeleteMode; sessionId?: string },
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = await ensureProjectPensieveRoot(projectRoot);
  const slug = slugify(slugRaw);
  const mode: DeleteMode = opts.mode === "hard" ? "hard" : "soft";
  const reason = opts.reason || "deleted by sediment curator";
  const resultCtx = resultAuditFields(opts, opts.sessionId);

  const target = await findProjectEntryFile(projectRoot, slug);
  if (!target) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "reject",
      reason: "entry_not_found",
      target: `project:${slug}`,
      delete_mode: mode,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: path.join(pensieveRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath, deleteMode: mode, ...resultCtx };
  }

  if (mode === "soft") {
    const result = await updateProjectEntry(slug, {
      status: "archived",
      sessionId: opts.sessionId,
      timelineAction: "deleted",
      timelineNote: `soft delete: ${reason}`,
    }, {
      projectRoot,
      settings: opts.settings,
      dryRun: opts.dryRun,
      auditOperation: "delete",
      auditExtras: { delete_mode: "soft", reason },
      auditContext: opts.auditContext,
    });
    return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "deleted", deleteMode: "soft" };
  }

  if (opts.dryRun) {
    return { slug, path: target, status: "dry_run", deleteMode: "hard", ...resultCtx };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.settings.lockTimeoutMs);
    await fs.unlink(target);
    const git = opts.settings.gitCommit ? await gitCommit(projectRoot, target, `hard delete ${slug}`) : null;
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "delete",
      target: `project:${slug}`,
      path: path.relative(projectRoot, target),
      delete_mode: "hard",
      reason,
      git_commit: git,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "deleted", gitCommit: git, auditPath, deleteMode: "hard", ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "error",
      target: `project:${slug}`,
      delete_mode: "hard",
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, auditPath, deleteMode: "hard", ...resultCtx };
  } finally {
    await lock?.release();
  }
}

export async function updateProjectEntry(
  slugRaw: string,
  patch: ProjectEntryUpdateDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = await ensureProjectPensieveRoot(projectRoot);
  const slug = slugify(slugRaw);
  const resultCtx = resultAuditFields(opts, patch.sessionId);

  const target = await findProjectEntryFile(projectRoot, slug);
  if (!target) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "reject",
      reason: "entry_not_found",
      target: `project:${slug}`,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: path.join(pensieveRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath, ...resultCtx };
  }

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "reject",
      reason: `read_error: ${message}`,
      target: `project:${slug}`,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: `read_error: ${message}`, auditPath, ...resultCtx };
  }

  const merged = mergeUpdateMarkdown(raw, patch, slug, projectRoot);
  if ("error" in merged) {
    const reason = merged.error.startsWith("credential pattern detected") ? merged.error : merged.error.split(":")[0];
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "reject",
      reason,
      target: `project:${slug}`,
      detail: merged.error,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason, auditPath, ...resultCtx };
  }

  const lint = lintMarkdown(merged.markdown, target);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "reject",
      reason: "lint_error",
      target: `project:${slug}`,
      lintErrors,
      lintWarnings,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath, ...resultCtx };
  }

  if (opts.dryRun) {
    return {
      slug,
      path: target,
      status: "dry_run",
      lintErrors,
      lintWarnings,
      sanitizedReplacements: merged.sanitizedReplacements,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.settings.lockTimeoutMs);
    await atomicWrite(target, merged.markdown);
    const operation = opts.auditOperation || "update";
    const git = opts.settings.gitCommit ? await gitCommit(projectRoot, target, `${operation} ${slug}`) : null;
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation,
      target: `project:${slug}`,
      path: path.relative(projectRoot, target),
      lint_result: "pass",
      git_commit: git,
      duration_ms: Date.now() - started,
      ...(opts.auditExtras ?? {}),
    }));
    return {
      slug,
      path: target,
      status: "updated",
      lintErrors,
      lintWarnings,
      gitCommit: git,
      auditPath,
      sanitizedReplacements: merged.sanitizedReplacements,
      ...resultCtx,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "error",
      target: `project:${slug}`,
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, lintErrors, lintWarnings, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

export async function writeProjectEntry(
  draft: ProjectEntryDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = await ensureProjectPensieveRoot(projectRoot);
  const resultCtx = resultAuditFields(opts, draft.sessionId);

  const validationErrors = validateProjectEntryDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
    }));
    return {
      slug: slugify(draft.title),
      path: pensieveRoot,
      status: "rejected",
      reason: "validation_error",
      validationErrors,
      auditPath,
      ...resultCtx,
    };
  }

  const titleSanitize = sanitizeForMemory(draft.title);
  const bodySanitize = sanitizeForMemory(draft.compiledTruth);
  const noteSanitize = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true, text: undefined, replacements: [] as string[] };
  // triggerPhrases are part of frontmatter and otherwise bypass
  // sanitize. We run each phrase through the same gate; failure of any
  // phrase fails the whole draft (the dropped-credential alternative is
  // worse — silently losing trigger phrases would also remove the
  // signal that something was wrong).
  const triggerPhraseSanitizes = (draft.triggerPhrases ?? []).map((p) => sanitizeForMemory(p));
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize, ...triggerPhraseSanitizes].find((result) => !result.ok);
  if (failedSanitize) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: failedSanitize.error,
      title: draft.title,
      duration_ms: Date.now() - started,
    }));
    return { slug: slugify(draft.title), path: pensieveRoot, status: "rejected", reason: failedSanitize.error, auditPath, ...resultCtx };
  }

  const sanitizedReplacements = [
    ...titleSanitize.replacements,
    ...bodySanitize.replacements,
    ...noteSanitize.replacements,
    ...triggerPhraseSanitizes.flatMap((s) => s.replacements),
  ];

  const safeDraft: ProjectEntryDraft = {
    ...draft,
    title: titleSanitize.text ?? draft.title,
    compiledTruth: bodySanitize.text ?? draft.compiledTruth,
    timelineNote: draft.timelineNote ? noteSanitize.text : draft.timelineNote,
    triggerPhrases: draft.triggerPhrases
      ? triggerPhraseSanitizes.map((s, i) => s.text ?? draft.triggerPhrases![i])
      : draft.triggerPhrases,
    status: draft.status,
  };

  const { slug, markdown } = buildMarkdown(safeDraft, projectRoot);
  const status = safeDraft.status ?? "provisional";
  const target = path.join(pensieveRoot, kindDirectory(safeDraft.kind, status), `${slug}.md`);

  const duplicate = await detectProjectDuplicate(projectRoot, safeDraft.title, {
    slug,
    kind: safeDraft.kind,
  });
  if (duplicate.duplicate) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "duplicate_slug",
      target: `project:${slug}`,
      duplicate,
      duration_ms: Date.now() - started,
    }));
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "duplicate_slug",
      duplicate,
      auditPath,
      ...resultCtx,
    };
  }
  const lint = lintMarkdown(markdown, target);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "lint_error",
      target: `project:${slug}`,
      lintErrors,
      lintWarnings,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath, ...resultCtx };
  }

  if (opts.dryRun) {
    return {
      slug,
      path: target,
      status: "dry_run",
      lintErrors,
      lintWarnings,
      sanitizedReplacements,
      ...resultCtx,
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
      const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
        operation: "reject",
        reason: "duplicate_slug",
        target: `project:${slug}`,
        duplicate: duplicateRace,
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "duplicate_slug", duplicate: duplicateRace, auditPath, ...resultCtx };
    }

    await atomicWrite(target, markdown);
    const git = opts.settings.gitCommit ? await gitCommit(projectRoot, target, slug) : null;
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "create",
      target: `project:${slug}`,
      path: path.relative(projectRoot, target),
      lint_result: "pass",
      git_commit: git,
      duration_ms: Date.now() - started,
    }));

    return {
      slug,
      path: target,
      status: "created",
      lintErrors,
      lintWarnings,
      gitCommit: git,
      auditPath,
      sanitizedReplacements,
      ...resultCtx,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "error",
      target: `project:${slug}`,
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, lintErrors, lintWarnings, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}
