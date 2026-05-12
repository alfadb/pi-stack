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
import {
  abrainProjectWorkflowsDir,
  abrainSedimentAuditPath,
  abrainSedimentLocksDir,
  abrainWorkflowsDir,
  ensureSedimentLegacyMigrated,
  formatLocalIsoTimestamp,
  sedimentAuditPath,
  sedimentLocksDir,
  validateAbrainProjectId,
} from "../_shared/runtime";

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

/** Round 7 P0-D (opus audit fix): `/memory migrate --go` writes a flag
 *  file at `<projectRoot>/.pi-astack/sediment/migrated-to-abrain.flag`
 *  with the abrain projectId + migration timestamp. While B5 (sediment
 *  writer cutover to ~/.abrain/projects/<id>/) is pending, any mutation
 *  call into the project's .pensieve substrate after a successful migration
 *  would silently rebuild `.pensieve/` and split memory across two stores
 *  (.pensieve fragment + ~/.abrain/projects/<id>/). This helper detects
 *  the flag and lets writer entry points return a structured `rejected`
 *  audit row instead of writing.
 *
 *  Returns `{ migratedAt, projectId }` when the flag is present,
 *  `null` otherwise. Bad / unreadable flag files are ignored (returns
 *  null) so a hand-corrupted flag doesn't permanently brick the writer. */
export interface PostMigrationGuardInfo {
  migratedAt: string;
  projectId: string;
}

// Round 7 P0-D: flag lives INSIDE `.pensieve/` so that:
//   1. migrate-go's parent-side commit (`git add .pensieve && git commit`)
//      automatically captures it as part of the migration commit.
//   2. `git reset --hard <parentPreSha>` rolls it back atomically with the
//      .pensieve restoration — no manual cleanup needed for re-apply.
//   3. `.pensieve/` is in the user's git tracking by design, so the flag
//      becomes part of the durable migration audit trail.
// File name uses ALL_CAPS + no extension to make it stand out in `ls`
// output, mirroring the convention of MIGRATING/COMMIT_EDITMSG/etc.
const POST_MIGRATION_FLAG_REL = path.join(".pensieve", "MIGRATED_TO_ABRAIN");

export async function readPostMigrationGuard(projectRoot: string): Promise<PostMigrationGuardInfo | null> {
  const flagPath = path.join(projectRoot, POST_MIGRATION_FLAG_REL);
  try {
    const raw = await fs.readFile(flagPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PostMigrationGuardInfo>;
    if (typeof parsed.migratedAt !== "string" || typeof parsed.projectId !== "string") return null;
    return { migratedAt: parsed.migratedAt, projectId: parsed.projectId };
  } catch {
    return null;
  }
}

export async function writePostMigrationGuard(
  projectRoot: string,
  info: PostMigrationGuardInfo,
): Promise<string> {
  const flagPath = path.join(projectRoot, POST_MIGRATION_FLAG_REL);
  await fs.mkdir(path.dirname(flagPath), { recursive: true });
  await fs.writeFile(flagPath, JSON.stringify(info, null, 2) + "\n", "utf-8");
  return flagPath;
}

export async function clearPostMigrationGuard(projectRoot: string): Promise<void> {
  const flagPath = path.join(projectRoot, POST_MIGRATION_FLAG_REL);
  try { await fs.unlink(flagPath); } catch { /* idempotent */ }
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

/**
 * If a lock file is older than this, the previous holder is assumed to have
 * crashed without releasing it and the lock can be reclaimed. Set generously
 * (vs the few-second-tops typical sediment write) so a slow agent_end run is
 * never stolen mid-flight; but short enough that a `kill -9` followed by
 * restart auto-heals within seconds, not days.
 *
 * History: Round 5 audit (2026-05-12, deepseek-v4-pro) found that
 * `acquireLock` and `acquireAbrainWorkflowLock` had no reclaim path at all
 * — a crash mid-write left the lock file on disk forever, and every
 * subsequent /memory write call timed out after `lockTimeoutMs` (5s default)
 * with the misleading "sediment lock timeout" error. The pattern below is
 * borrowed from `withCheckpointLock` (`checkpoint.ts:139`) which uses the
 * same mtime-based reclaim. We don't bother parsing the JSON inside the
 * lock file (pid + created_at) for `process.kill(pid, 0)` checks because
 * pid recycle across reboots can give false-positives; mtime is the safer
 * signal.
 */
const SEDIMENT_LOCK_STEAL_AFTER_MS = 30_000;

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
      // Steal stale lock (previous holder crashed). Mirror checkpoint.ts:139.
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > SEDIMENT_LOCK_STEAL_AFTER_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        /* lock vanished between EEXIST and stat — retry the wx open */
      }
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
  const guard = await readPostMigrationGuard(projectRoot);
  if (guard) {
    const slug = slugify(slugRaw);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "reject",
      reason: "post_migration_pensieve_writes_disabled",
      target: `project:${slug}`,
      post_migration_guard: guard,
      duration_ms: Date.now() - started,
    }));
    return {
      slug,
      path: path.join(projectRoot, ".pensieve", `${slug}.md`),
      status: "rejected",
      reason: "post_migration_pensieve_writes_disabled",
      auditPath,
      deleteMode: opts.mode === "hard" ? "hard" : "soft",
      ...resultAuditFields(opts, opts.sessionId),
    };
  }
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
  const guard = await readPostMigrationGuard(projectRoot);
  if (guard) {
    const slug = slugify(slugRaw);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
      operation: "reject",
      reason: "post_migration_pensieve_writes_disabled",
      target: `project:${slug}`,
      post_migration_guard: guard,
      duration_ms: Date.now() - started,
    }));
    return {
      slug,
      path: path.join(projectRoot, ".pensieve", `${slug}.md`),
      status: "rejected",
      reason: "post_migration_pensieve_writes_disabled",
      auditPath,
      ...resultAuditFields(opts, patch.sessionId),
    };
  }
  const pensieveRoot = await ensureProjectPensieveRoot(projectRoot);
  const slug = slugify(slugRaw);
  const resultCtx = resultAuditFields(opts, patch.sessionId);

  // Round 8 P0 (gpt-5.5 audit fix): the full read-modify-write (find target +
  // readFile + merge + lint + write) MUST happen inside the sediment lock.
  // Previously read/merge/lint happened lock-OUTSIDE and only atomicWrite
  // was lock-INSIDE — a textbook lost-update race:
  //
  //   Process A: read raw → prepare merged markdown → (no lock yet)
  //   Process B: acquire lock → deleteProjectEntry hard delete: unlink(target)
  //              → audit row says deleted → release lock
  //   Process A: acquire lock → atomicWrite(target, merged) → entry RESURRECTED
  //
  // Same race applies for concurrent update overlaps (older raw overwrites
  // newer state) and for archive/supersede vs update (older active-status
  // snapshot overwrites the post-archive state).
  //
  // The dry-run path stays lock-OUTSIDE (read-only preview; tolerating a
  // brief race window here is acceptable because no disk mutation happens).
  // The real RMW path is wrapped end-to-end in the lock and re-does the
  // find+read+merge+lint after acquireLock so any concurrent unlink /
  // atomicWrite is observed.

  // Helper: prepare merged markdown + lint, returning either ok result or
  // a rejected response. Used by both dry-run preview and locked RMW path.
  async function prepareMergedMarkdown(): Promise<
    | { ok: true; target: string; merged: { markdown: string; sanitizedReplacements: string[] }; lintErrors: number; lintWarnings: number }
    | { ok: false; response: WriteProjectEntryResult }
  > {
    const target = await findProjectEntryFile(projectRoot, slug);
    if (!target) {
      const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "entry_not_found",
        target: `project:${slug}`,
        duration_ms: Date.now() - started,
      }));
      return { ok: false, response: { slug, path: path.join(pensieveRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath, ...resultCtx } };
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
      return { ok: false, response: { slug, path: target, status: "rejected", reason: `read_error: ${message}`, auditPath, ...resultCtx } };
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
      return { ok: false, response: { slug, path: target, status: "rejected", reason, auditPath, ...resultCtx } };
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
      return { ok: false, response: { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath, ...resultCtx } };
    }
    return { ok: true, target, merged, lintErrors, lintWarnings };
  }

  // Dry-run path: lock-outside preview. Stale reads are acceptable here
  // because no disk mutation happens; callers requesting dry_run already
  // accept best-effort semantics.
  if (opts.dryRun) {
    const preview = await prepareMergedMarkdown();
    if (!preview.ok) return preview.response;
    return {
      slug,
      path: preview.target,
      status: "dry_run",
      lintErrors: preview.lintErrors,
      lintWarnings: preview.lintWarnings,
      sanitizedReplacements: preview.merged.sanitizedReplacements,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  let target = "";
  let lintErrors = 0;
  let lintWarnings = 0;
  let mergedForCatch: { markdown: string; sanitizedReplacements: string[] } | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.settings.lockTimeoutMs);
    // Re-do the find+read+merge+lint cycle INSIDE the lock to observe any
    // concurrent state changes (hard delete, prior atomic write).
    const prepared = await prepareMergedMarkdown();
    if (!prepared.ok) return prepared.response;
    target = prepared.target;
    lintErrors = prepared.lintErrors;
    lintWarnings = prepared.lintWarnings;
    mergedForCatch = prepared.merged;
    const merged = prepared.merged;
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
  const guard = await readPostMigrationGuard(projectRoot);
  if (guard) {
    const slug = slugify(draft.title);
    const auditPath = await appendAudit(projectRoot, withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "post_migration_pensieve_writes_disabled",
      target: `project:${slug}`,
      title: draft.title,
      post_migration_guard: guard,
      duration_ms: Date.now() - started,
    }));
    return {
      slug,
      path: path.join(projectRoot, ".pensieve", `${slug}.md`),
      status: "rejected",
      reason: "post_migration_pensieve_writes_disabled",
      auditPath,
      ...resultAuditFields(opts, draft.sessionId),
    };
  }
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

// ══ abrain workflows lane writer (B1) ═════════════════════════════════════
//
// `writeAbrainWorkflow` writes pipeline-shaped entries ("run-when-*" task
// blueprints, sediment-event-style automations) into the abrain `workflows/`
// zone instead of the project `.pensieve/` knowledge tree.
//
// Why a separate API instead of extending writeProjectEntry / ENTRY_KINDS:
//   - ENTRY_KINDS is the 7-kind knowledge contract (maxim / decision /
//     pattern / anti-pattern / fact / preference / smell). Pipeline is NOT
//     knowledge; it's a flow. Mixing it into ENTRY_KINDS pollutes the kind
//     model that sediment curator + memory_search rely on.
//   - abrain workflows live outside the per-project pensieve git tree
//     (cross-project workflows are global; project-specific live under
//     ~/.abrain/projects/<id>/workflows/), so substrate paths (lock /
//     audit / git commit) target abrainHome, not projectRoot.
//   - workflow frontmatter shape differs from knowledge entries: it has
//     `trigger`, `tags`, no `confidence`, no `compiled_truth` section.
//
// What it shares with writeProjectEntry (intentionally, to avoid drift):
//   - sanitize gate (sanitizeForMemory, fail-closed on secrets)
//   - atomic write (tmp + rename)
//   - markdown lint (lintMarkdown)
//   - lockfile + atomic stale reclaim
//   - git commit + audit row append (lane="workflow")
//
// Callers (today only future /memory migrate --go, B4): can produce both
// cross-project (~/.abrain/workflows/<slug>.md) and project-specific
// (~/.abrain/projects/<id>/workflows/<slug>.md) outputs via the
// `crossProject` flag.

export interface WorkflowDraft {
  /** Human-readable workflow title, e.g. "更新 Claude Code 插件" */
  title: string;
  /** Trigger description: when this workflow should run (e.g. "用户要求更新插件" or "触发词: update plugins") */
  trigger: string;
  /** Workflow body markdown (Task Blueprint, completion criteria, etc). Min 20 chars. */
  body: string;
  /** true → ~/.abrain/workflows/ (cross-project); false (default) → ~/.abrain/projects/<id>/workflows/ */
  crossProject?: boolean;
  /** Required when crossProject=false; ignored otherwise. Must pass validateAbrainProjectId. */
  projectId?: string;
  /** Optional tags, sanitized like everything else. */
  tags?: string[];
  /** Optional slug override (defaults to slugify(title)) for stable rename to `run-when-*` style. */
  slug?: string;
  /** Status enum, default "provisional". */
  status?: EntryStatus;
  /** Optional session id for audit correlation. */
  sessionId?: string;
  /** Optional Timeline note; defaults to "created by sediment workflow writer". */
  timelineNote?: string;
}

export interface WriteWorkflowOptions {
  abrainHome: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
}

export interface WriteWorkflowResult {
  slug: string;
  path: string;
  status: "created" | "skipped" | "dry_run" | "rejected";
  reason?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  auditPath?: string;
  sanitizedReplacements?: string[];
  validationErrors?: Array<{ field: string; message: string }>;
  crossProject?: boolean;
  projectId?: string;
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

function validateWorkflowDraft(draft: WorkflowDraft): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  }
  if (typeof draft.trigger !== "string" || draft.trigger.trim().length === 0) {
    issues.push({ field: "trigger", message: "trigger is required" });
  }
  if (typeof draft.body !== "string" || draft.body.trim().length < 20) {
    issues.push({ field: "body", message: "body must be at least 20 characters" });
  }
  if (draft.crossProject === false || draft.crossProject === undefined) {
    if (typeof draft.projectId !== "string" || draft.projectId.length === 0) {
      issues.push({ field: "projectId", message: "projectId is required when crossProject is false (default)" });
    } else {
      try { validateAbrainProjectId(draft.projectId); }
      catch (e) { issues.push({ field: "projectId", message: (e as Error).message }); }
    }
  }
  if (draft.status !== undefined && typeof draft.status !== "string") {
    issues.push({ field: "status", message: "status must be a string" });
  }
  return issues;
}

function buildWorkflowMarkdown(draft: WorkflowDraft, slug: string): string {
  const timestamp = nowIso();
  const status = draft.status ?? "provisional";
  const crossProject = draft.crossProject === true;
  const id = crossProject ? `workflow:${slug}` : `project:${draft.projectId}:workflow:${slug}`;
  const timelineSession = draft.sessionId || "sediment";
  const timelineNote = draft.timelineNote || "created by sediment workflow writer";
  const tags = (draft.tags ?? []).map((t) => t.trim()).filter(Boolean);

  const fmLines: string[] = [];
  fmLines.push("---");
  fmLines.push(`id: ${yamlString(id)}`);
  // T7 frontmatter-required (lint.ts REQUIRED_FRONTMATTER_FIELDS): title +
  // confidence are mandatory for every markdown entry. Workflows aren't
  // ranked by confidence in retrieval, but we set a deterministic mid
  // value (5) to satisfy the storage contract; the field is informational
  // for workflows.
  fmLines.push(`title: ${yamlString(draft.title)}`);
  fmLines.push(`scope: workflow`);
  fmLines.push(`kind: workflow`);
  fmLines.push(`cross_project: ${crossProject ? "true" : "false"}`);
  if (!crossProject) fmLines.push(`project_id: ${yamlString(draft.projectId!)}`);
  fmLines.push(`status: ${yamlString(status)}`);
  fmLines.push(`confidence: 5`);
  fmLines.push(`trigger: ${yamlString(draft.trigger)}`);
  fmLines.push(...yamlList("tags", tags));
  fmLines.push(`created: ${yamlString(timestamp)}`);
  fmLines.push(`updated: ${yamlString(timestamp)}`);
  fmLines.push(`schema_version: 1`);
  fmLines.push("---");

  // Body normalization: ensure body starts with `# <title>`; escape bare `---` lines
  // (same defensive escape as normalizeCompiledTruth, frontmatter break-out guard).
  let body = draft.body.trim();
  body = body.replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  body = body.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(body)) body = `# ${draft.title}\n\n**Trigger**: ${draft.trigger}\n\n${body}`;

  // Timeline format aligns with buildMarkdown (project entries):
  // `- <ts> | <session> | <action> | <note>` pipe-separated columns.
  const timeline = `## Timeline\n- ${timestamp} | ${timelineSession} | created | ${timelineNote}`;

  return `${fmLines.join("\n")}\n\n${body.trim()}\n\n${timeline}\n`;
}

async function acquireAbrainWorkflowLock(abrainHome: string, timeoutMs: number): Promise<LockHandle> {
  // Same stale-lock reclaim as `acquireLock` above. The two locks are
  // intentionally distinct files in different repos (project-side
  // sediment.lock vs abrain-side workflow.lock) so a hang on one doesn't
  // block the other; both share the same SEDIMENT_LOCK_STEAL_AFTER_MS
  // grace period.
  const lockDir = abrainSedimentLocksDir(abrainHome);
  const lockPath = path.join(lockDir, "workflow.lock");
  await fs.mkdir(lockDir, { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: formatLocalIsoTimestamp() }));
      await handle.close();
      return {
        async release() { await fs.unlink(lockPath).catch(() => undefined); },
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > SEDIMENT_LOCK_STEAL_AFTER_MS) {
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        /* lock vanished between EEXIST and stat — retry the wx open */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`abrain workflow lock timeout after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function appendAbrainWorkflowAudit(abrainHome: string, event: Record<string, unknown>): Promise<string> {
  const auditPath = abrainSedimentAuditPath(abrainHome);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const enriched = {
    timestamp: formatLocalIsoTimestamp(),
    audit_version: AUDIT_SCHEMA_VERSION,
    pid: process.pid,
    abrain_home: path.resolve(abrainHome),
    lane: "workflow",
    ...event,
  };
  await fs.appendFile(auditPath, `${JSON.stringify(enriched)}\n`, "utf-8");
  return auditPath;
}

async function gitCommitAbrain(abrainHome: string, filePath: string, slug: string): Promise<string | null> {
  try {
    const rel = path.relative(abrainHome, filePath);
    await execFileAsync("git", ["-C", abrainHome, "add", rel], { timeout: 5_000, maxBuffer: 512 * 1024 });
    await execFileAsync("git", ["-C", abrainHome, "commit", "-m", `workflow: ${slug}`], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write a workflow entry to the abrain workflows zone.
 *
 * Routing:
 *   - draft.crossProject === true  → ~/.abrain/workflows/<slug>.md
 *   - otherwise (default)          → ~/.abrain/projects/<projectId>/workflows/<slug>.md
 *
 * Substrate (mirrors writeProjectEntry):
 *   1. validation (schema)
 *   2. sanitize all free-text fields (fail-closed on secrets/PII)
 *   3. build markdown (frontmatter v1 + body + Timeline)
 *   4. lint (warnings recorded; errors reject)
 *   5. dedupe (slug collision)
 *   6. lock (abrain-side, separate from project sediment lock)
 *   7. atomic write + git commit in abrain repo + audit row in abrain audit
 */
export async function writeAbrainWorkflow(
  draft: WorkflowDraft,
  opts: WriteWorkflowOptions,
): Promise<WriteWorkflowResult> {
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const crossProject = draft.crossProject === true;
  const projectId = !crossProject ? draft.projectId : undefined;
  const lane = "workflow";
  const sessionId = opts.auditContext?.sessionId ?? draft.sessionId;
  const resultCtx = {
    lane,
    sessionId,
    correlationId: opts.auditContext?.correlationId,
    candidateId: opts.auditContext?.candidateId,
  };

  const validationErrors = validateWorkflowDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title || "workflow"),
      path: abrainHome,
      status: "rejected",
      reason: "validation_error",
      validationErrors,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  // Sanitize free-text fields (title, trigger, body, tags, timelineNote).
  const titleSan = sanitizeForMemory(draft.title);
  const triggerSan = sanitizeForMemory(draft.trigger);
  const bodySan = sanitizeForMemory(draft.body);
  const noteSan = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true as const, text: undefined, replacements: [] as string[] };
  const tagSans = (draft.tags ?? []).map((t) => sanitizeForMemory(t));
  const failed = [titleSan, triggerSan, bodySan, noteSan, ...tagSans].find((r) => !r.ok);
  if (failed) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: (failed as { ok: false; error: string }).error,
      title: draft.title,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title),
      path: abrainHome,
      status: "rejected",
      reason: (failed as { ok: false; error: string }).error,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  const sanitizedReplacements = [
    ...titleSan.replacements,
    ...triggerSan.replacements,
    ...bodySan.replacements,
    ...noteSan.replacements,
    ...tagSans.flatMap((s) => s.replacements),
  ];

  const safeDraft: WorkflowDraft = {
    ...draft,
    title: titleSan.text ?? draft.title,
    trigger: triggerSan.text ?? draft.trigger,
    body: bodySan.text ?? draft.body,
    timelineNote: draft.timelineNote ? noteSan.text : draft.timelineNote,
    tags: draft.tags ? tagSans.map((s, i) => s.text ?? draft.tags![i]) : draft.tags,
  };

  const slug = (draft.slug && slugify(draft.slug)) || slugify(safeDraft.title);
  const targetDir = crossProject
    ? abrainWorkflowsDir(abrainHome)
    : abrainProjectWorkflowsDir(abrainHome, projectId!);
  const target = path.join(targetDir, `${slug}.md`);

  // Storage-level dedupe: same slug already exists.
  if (fsSync.existsSync(target)) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "duplicate_slug",
      target: crossProject ? `workflow:${slug}` : `project:${projectId}:workflow:${slug}`,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "duplicate_slug",
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  const markdown = buildWorkflowMarkdown(safeDraft, slug);
  const lintIssues = lintMarkdown(markdown, target);
  const lintErrors = lintIssues.filter((i) => i.severity === "error").length;
  const lintWarnings = lintIssues.filter((i) => i.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "lint_error",
      target: path.relative(abrainHome, target),
      lint_errors: lintErrors,
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "lint_error",
      lintErrors,
      lintWarnings,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  if (opts.dryRun) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "dry_run",
      target: path.relative(abrainHome, target),
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "dry_run",
      lintWarnings,
      auditPath,
      sanitizedReplacements,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainWorkflowLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    // Lock-held duplicate re-check (mirror writeProjectEntry @ ~882).
    //
    // The first existsSync above is best-effort and cheap, but it runs
    // *outside* the lock — two concurrent writers can both pass it,
    // then race past the lock barrier and silently overwrite each other
    // via atomicWrite → fs.rename. Re-checking here under the lock is
    // the only correct dedupe surface. Round 6 deepseek-v4-pro P0:
    // discovered by cross-file pattern audit (writeProjectEntry had the
    // re-check, writeAbrainWorkflow did not).
    if (fsSync.existsSync(target)) {
      const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
        operation: "reject",
        reason: "duplicate_slug_race",
        target: crossProject ? `workflow:${slug}` : `project:${projectId}:workflow:${slug}`,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug,
        path: target,
        status: "rejected",
        reason: "duplicate_slug_race",
        auditPath,
        crossProject,
        projectId,
        ...resultCtx,
      };
    }
    await atomicWrite(target, markdown);
    const git = await gitCommitAbrain(abrainHome, target, slug);
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "create",
      target: path.relative(abrainHome, target),
      cross_project: crossProject,
      project_id: projectId,
      lint_result: "pass",
      lint_warnings: lintWarnings,
      git_commit: git,
      duration_ms: Date.now() - started,
      ...resultCtx,
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
      crossProject,
      projectId,
      ...resultCtx,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "error",
      target: path.relative(abrainHome, target),
      reason: message,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: message,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  } finally {
    await lock?.release();
  }
}
