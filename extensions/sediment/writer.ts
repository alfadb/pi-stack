import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SedimentSettings } from "./settings";
import { detectProjectDuplicate, type DedupeResult } from "./dedupe";
import { sanitizeForMemory } from "./sanitizer";
import { type DraftPolicy, type EntryKind, type EntryStatus, validateProjectEntryDraft } from "./validation";
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

export interface WriteProjectEntryOptions {
  projectRoot: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  /**
   * Optional policy overlay applied on top of the standard schema check.
   * Used by the Phase 1.4 LLM auto-write lane to enforce stricter
   * gates (no maxim, status capped to initial states, confidence
   * capped). Caller is responsible for assembling this from
   * `SedimentSettings` (see `buildAutoWritePolicy` in `index.ts`); the
   * writer does not look at settings directly so explicit MEMORY:
   * blocks remain unaffected.
   */
  policy?: DraftPolicy;
  /**
   * If true, the draft's `status` is forcibly rewritten to "provisional"
   * regardless of whatever the LLM/extractor produced. This is the
   * sediment-state half of `policy.disallowArchived`: validation alone
   * would reject `archived/deprecated/superseded`, but for `active`
   * vs `provisional` distinctions we prefer to coerce silently rather
   * than fail the whole write — a too-confident `active` from the LLM
   * is still better captured at `provisional`.
   */
  forceProvisional?: boolean;
}

export interface ProjectEntryUpdateDraft {
  title?: string;
  kind?: EntryKind;
  status?: EntryStatus;
  confidence?: number;
  compiledTruth?: string;
  triggerPhrases?: string[];
  sessionId?: string;
  timelineNote?: string;
}

export interface WriteProjectEntryResult {
  slug: string;
  path: string;
  status: "created" | "updated" | "skipped" | "dry_run" | "rejected";
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
  // Defense against frontmatter break-out (G6): a body line that is
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
  };
  if (triggerPhrases) {
    nextFrontmatter.trigger_phrases = triggerPhraseSanitizes.map((s, i) => s.text ?? triggerPhrases[i]);
  }

  const timelineSession = patch.sessionId || "sediment";
  const nextTimeline = [
    ...timeline,
    `- ${timestamp} | ${timelineSession} | updated | ${safeTimelineNote}`,
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

export async function updateProjectEntry(
  slugRaw: string,
  patch: ProjectEntryUpdateDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const slug = slugify(slugRaw);
  if (!fsSync.existsSync(pensieveRoot)) {
    return { slug, path: pensieveRoot, status: "rejected", reason: ".pensieve directory not found" };
  }

  const target = await findProjectEntryFile(projectRoot, slug);
  if (!target) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: "entry_not_found",
      target: `project:${slug}`,
      duration_ms: Date.now() - started,
    });
    return { slug, path: path.join(pensieveRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath };
  }

  let raw: string;
  try {
    raw = await fs.readFile(target, "utf-8");
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: `read_error: ${message}`,
      target: `project:${slug}`,
      duration_ms: Date.now() - started,
    });
    return { slug, path: target, status: "rejected", reason: `read_error: ${message}`, auditPath };
  }

  const merged = mergeUpdateMarkdown(raw, patch, slug, projectRoot);
  if ("error" in merged) {
    const reason = merged.error.startsWith("credential pattern detected") ? merged.error : merged.error.split(":")[0];
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason,
      target: `project:${slug}`,
      detail: merged.error,
      duration_ms: Date.now() - started,
    });
    return { slug, path: target, status: "rejected", reason, auditPath };
  }

  const lint = lintMarkdown(merged.markdown, target);
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
      sanitizedReplacements: merged.sanitizedReplacements,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(projectRoot, opts.settings.lockTimeoutMs);
    await atomicWrite(target, merged.markdown);
    const git = opts.settings.gitCommit ? await gitCommit(projectRoot, target, `update ${slug}`) : null;
    const auditPath = await appendAudit(projectRoot, {
      operation: "update",
      target: `project:${slug}`,
      path: path.relative(projectRoot, target),
      lint_result: "pass",
      git_commit: git,
      duration_ms: Date.now() - started,
    });
    return {
      slug,
      path: target,
      status: "updated",
      lintErrors,
      lintWarnings,
      gitCommit: git,
      auditPath,
      sanitizedReplacements: merged.sanitizedReplacements,
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

export async function writeProjectEntry(
  draft: ProjectEntryDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  if (!fsSync.existsSync(pensieveRoot)) {
    return { slug: slugify(draft.title), path: pensieveRoot, status: "rejected", reason: ".pensieve directory not found" };
  }

  const validationErrors = validateProjectEntryDraft(draft, opts.policy);
  if (validationErrors.length > 0) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
    });
    return {
      slug: slugify(draft.title),
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
  // G8: triggerPhrases are part of frontmatter and otherwise bypass
  // sanitize. We run each phrase through the same gate; failure of any
  // phrase fails the whole draft (the dropped-credential alternative is
  // worse — silently losing trigger phrases would also remove the
  // signal that something was wrong).
  const triggerPhraseSanitizes = (draft.triggerPhrases ?? []).map((p) => sanitizeForMemory(p));
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize, ...triggerPhraseSanitizes].find((result) => !result.ok);
  if (failedSanitize) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: failedSanitize.error,
      title: draft.title,
      duration_ms: Date.now() - started,
    });
    return { slug: slugify(draft.title), path: pensieveRoot, status: "rejected", reason: failedSanitize.error, auditPath };
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
    // forceProvisional: applied AFTER sanitize so the audit row reflects
    // the actual stored status. This intentionally happens unconditionally
    // when set, overriding any LLM-supplied value (validation already
    // banned archived/deprecated/superseded if disallowArchived is on,
    // but `active` slipping through is still a downgrade-on-write here).
    status: opts.forceProvisional ? "provisional" : draft.status,
  };

  const { slug, markdown } = buildMarkdown(safeDraft, projectRoot);
  const status = safeDraft.status ?? "provisional";
  const target = path.join(pensieveRoot, kindDirectory(safeDraft.kind, status), `${slug}.md`);

  const duplicate = await detectProjectDuplicate(projectRoot, safeDraft.title, {
    slug,
    kind: safeDraft.kind,
  });
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
  // Soft near-duplicate gate. Only enforced when the policy explicitly
  // opts in (LLM auto-write lane). Explicit-marker writes are
  // user-attested and intentionally bypass this gate — if the user
  // wants to record a refined restatement of an existing entry they
  // can.
  if (duplicate.nearDuplicate && opts.policy?.disallowNearDuplicate) {
    const auditPath = await appendAudit(projectRoot, {
      operation: "reject",
      reason: "near_duplicate",
      target: `project:${slug}`,
      duplicate,
      duration_ms: Date.now() - started,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "near_duplicate",
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
