import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MemorySettings } from "./settings";
import {
  defaultConfidence,
  extractTitle,
  inferKindFromPath,
  parseFrontmatter,
  scalarString,
  scalarNumber,
  splitCompiledTruth,
  splitFrontmatter,
} from "./parser";
import { isEmptyFrontmatterValue, markdownFilesForTarget, REQUIRED_FRONTMATTER_FIELDS } from "./lint";
import { clamp, normalizeBareSlug, prettyPath, slugify, titleFromSlug, throwIfAborted } from "./utils";
import {
  abrainProjectDir,
  abrainProjectWorkflowsDir,
  abrainWorkflowsDir,
  canonicalizeGitRemote,
  formatLocalIsoTimestamp,
  validateAbrainProjectId,
} from "../_shared/runtime";

const execFileAsync = promisify(execFile);

/* ────────────────────────────────────────────────────────────────────────
 * Per-repo migration executor: .pensieve/ → ~/.abrain/projects/<id>/
 *
 * Spec: docs/migration/abrain-pensieve-migration.md §3
 *
 * Why a separate module from migrate.ts?
 *   - migrate.ts is a read-only planner that outputs a report. It infers
 *     a "what would change" view of a single .pensieve. Reused here for
 *     frontmatter normalization decisions (defaults, kind, status,
 *     confidence) so we don't drift from the planner.
 *   - migrate-go.ts is the actual writer. It owns precondition checks,
 *     entry routing (knowledge kind dir vs. workflows lane), atomic
 *     file moves, and the two paired git commits.
 *
 * Why not call sediment.writeProjectEntry per entry?
 *   - writeProjectEntry timestamps `created`/`updated` at "now" and
 *     emits a Timeline line "created by sediment project writer".
 *     For migration we preserve the original entry timestamps and add
 *     a Timeline note "migrated-from-legacy" instead. Reusing the writer
 *     would rewrite history.
 *   - writeProjectEntry targets <projectRoot>/.pensieve/<kind-dir>/, but
 *     migration target is ~/.abrain/projects/<id>/<kind-dir>/.
 *   - writeProjectEntry does per-entry git commit + lock; for a one-shot
 *     migration of 200+ entries we batch a single commit per side instead.
 *
 * Pipeline routing uses sediment.writeAbrainWorkflow (B1) because workflows
 * have a different schema (trigger/body/cross_project) and a separate
 * audit lane. That writer is the only place workflows can be created.
 * ──────────────────────────────────────────────────────────────────── */

export interface MigrationGoOptions {
  /** Absolute path to <cwd>/.pensieve. Project root is inferred as its parent. */
  pensieveTarget: string;
  /** Absolute path to ~/.abrain (env ABRAIN_ROOT or default os.homedir()/.abrain). */
  abrainHome: string;
  /** Optional explicit project id; otherwise inferred from git remote → cwd basename. */
  projectId?: string;
  /** Override timestamp for migrated-from-legacy timeline; tests use this for stability. */
  migrationTimestamp?: string;
  cwd?: string;
  signal?: AbortSignal;
  settings: MemorySettings;
}

export interface MigrationGoEntryReport {
  source: string;
  target: string;
  slug: string;
  title: string;
  kind: string;
  route: "knowledge" | "workflow-project" | "workflow-cross-project";
  action: "migrated" | "skipped" | "failed";
  reason?: string;
}

export interface MigrationGoResult {
  ok: boolean;
  projectId: string;
  projectIdSource: "explicit" | "git-remote" | "cwd-basename";
  parentRepoRoot: string;
  abrainProjectDir: string;
  entries: MigrationGoEntryReport[];
  movedCount: number;
  workflowCount: number;
  skippedCount: number;
  failedCount: number;
  parentCommitSha?: string | null;
  abrainCommitSha?: string | null;
  preconditionFailures: string[];
}

interface PreflightOutcome {
  ok: boolean;
  projectId: string;
  projectIdSource: "explicit" | "git-remote" | "cwd-basename";
  parentRepoRoot: string;
  failures: string[];
}

/* ── Project-id inference ──────────────────────────────────────────── */

function deriveProjectIdFromRemote(remote: string | undefined | null): string | null {
  const canon = canonicalizeGitRemote(remote);
  if (!canon) return null;
  // canon = "host/path"; strip host, take last 2 path segments → "org-repo"
  const slashIdx = canon.indexOf("/");
  if (slashIdx < 0) return null;
  const pathPart = canon.slice(slashIdx + 1);
  const parts = pathPart.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  // Prefer `org-repo`; for monorepo-style remotes with deeper paths
  // fall back to the last segment only (rare in practice).
  const candidate = parts.length >= 2
    ? `${parts[parts.length - 2]}-${parts[parts.length - 1]}`
    : parts[parts.length - 1]!;
  return sanitizeProjectIdCandidate(candidate);
}

function deriveProjectIdFromCwd(cwd: string): string {
  // Use the last two path components if available to disambiguate
  // ~/work/uamp/full vs ~/work/kihh/full → "uamp-full" / "kihh-full".
  // Falls back to just the basename when cwd has no useful parent.
  const norm = path.resolve(cwd).replace(/\/+$/, "");
  if (norm === "/" || norm === "") return "project";
  const parts = norm.split(path.sep).filter(Boolean);
  if (parts.length === 0) return "project";
  if (parts.length === 1) return sanitizeProjectIdCandidate(parts[0]!);
  const last = parts[parts.length - 1]!;
  const parent = parts[parts.length - 2]!;
  // Skip generic parent names that would still collide.
  const candidate = (last === "full" || last === "src" || last === "main")
    ? `${parent}-${last}`
    : last;
  return sanitizeProjectIdCandidate(candidate);
}

function sanitizeProjectIdCandidate(raw: string): string {
  // validateAbrainProjectId allows [a-zA-Z0-9_.-]+; slugify always emits
  // lowercase letters+digits+dashes, which is the safe subset.
  const slug = slugify(raw);
  if (slug.length === 0) return "project";
  if (slug.startsWith(".")) return `_${slug}`;
  return slug.slice(0, 128);
}

/* ── Git helpers (small wrappers; throw → caller decides) ──────────── */

async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 3000, maxBuffer: 256 * 1024 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitRemoteOrigin(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 3000, maxBuffer: 256 * 1024 });
    return stdout.trim() || null;
  } catch { return null; }
}

async function gitIsClean(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "status", "--porcelain"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim().length === 0;
  } catch { return false; }
}

async function gitTrackedCount(cwd: string, subpath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "ls-files", "--", subpath], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").filter((line) => line.trim().length > 0).length;
  } catch { return 0; }
}

async function gitIsTracked(cwd: string, file: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", cwd, "ls-files", "--error-unmatch", "--", file], { timeout: 3000, maxBuffer: 64 * 1024 });
    return true;
  } catch { return false; }
}

async function gitRmOrUnlink(cwd: string, file: string): Promise<void> {
  if (await gitIsTracked(cwd, file)) {
    try {
      await execFileAsync("git", ["-C", cwd, "rm", "-q", "--", file], { timeout: 5000, maxBuffer: 64 * 1024 });
      return;
    } catch {
      // fall through to unlink
    }
  }
  try { await fs.unlink(file); } catch {}
}

async function gitCommitAll(cwd: string, message: string): Promise<string | null> {
  try {
    await execFileAsync("git", ["-C", cwd, "add", "-A"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["-C", cwd, "commit", "-m", message], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/* ── Preflight (§2 preconditions) ──────────────────────────────────── */

export async function preflightMigrationGo(opts: MigrationGoOptions): Promise<PreflightOutcome> {
  const failures: string[] = [];
  const pensieveAbs = path.resolve(opts.pensieveTarget);

  // Resolve parent repo root: git toplevel of the .pensieve's parent
  const inferredParent = path.dirname(pensieveAbs);
  const parentRepoRoot = (await gitToplevel(inferredParent)) ?? inferredParent;

  if (!fsSync.existsSync(pensieveAbs)) {
    failures.push(`pensieve target not found: ${pensieveAbs}`);
  }
  if (!fsSync.existsSync(opts.abrainHome)) {
    failures.push(`abrain home not found: ${opts.abrainHome}`);
  }

  // Project id resolution
  let projectId = "";
  let projectIdSource: "explicit" | "git-remote" | "cwd-basename" = "cwd-basename";
  if (opts.projectId) {
    projectId = opts.projectId;
    projectIdSource = "explicit";
  } else {
    const remote = await gitRemoteOrigin(parentRepoRoot);
    const fromRemote = deriveProjectIdFromRemote(remote);
    if (fromRemote) {
      projectId = fromRemote;
      projectIdSource = "git-remote";
    } else {
      projectId = deriveProjectIdFromCwd(parentRepoRoot);
      projectIdSource = "cwd-basename";
    }
  }
  try { validateAbrainProjectId(projectId); }
  catch (e) { failures.push(`invalid project id "${projectId}": ${(e as Error).message}`); }

  // Parent repo must be clean (so the migration commit is the only change)
  if (fsSync.existsSync(parentRepoRoot)) {
    const parentClean = await gitIsClean(parentRepoRoot);
    if (!parentClean) {
      failures.push(`parent repo not clean: ${parentRepoRoot} (commit or stash before migrating)`);
    }
    // .pensieve must have tracked files; untracked .pensieve has no git
    // undo trail and would lose history if migrated.
    const tracked = await gitTrackedCount(parentRepoRoot, path.relative(parentRepoRoot, pensieveAbs));
    if (tracked === 0) {
      failures.push(`pensieve has no git-tracked files in ${parentRepoRoot}; run \`git add .pensieve && git commit\` first to preserve undo`);
    }
    // .pensieve must contain at least one user-facing .md entry (derived
    // .state/.index files don't count). Without this, --go would commit
    // an empty migration and confuse the operator into thinking it ran.
    const userEntries = await markdownFilesForTarget(pensieveAbs, opts.settings, opts.signal);
    if (userEntries.length === 0) {
      failures.push(`pensieve has no user entries to migrate at ${pensieveAbs} (only derived .state/.index files remain; migration is likely already complete)`);
    }
  } else {
    failures.push(`parent repo root not found: ${parentRepoRoot}`);
  }

  // abrain repo must be clean
  if (fsSync.existsSync(opts.abrainHome)) {
    const abrainTopl = await gitToplevel(opts.abrainHome);
    if (!abrainTopl) {
      failures.push(`abrain home is not a git repo: ${opts.abrainHome}`);
    } else {
      const abrainClean = await gitIsClean(abrainTopl);
      if (!abrainClean) {
        failures.push(`abrain repo not clean: ${abrainTopl} (commit or stash before migrating)`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    projectId,
    projectIdSource,
    parentRepoRoot,
    failures,
  };
}

/* ── Per-entry analysis (route + normalized content) ───────────────── */

interface AnalyzedEntry {
  sourceAbs: string;
  relSource: string;        // relative to pensieveTarget
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  isPipeline: boolean;
  crossProject: boolean;
  route: "knowledge" | "workflow-project" | "workflow-cross-project";
  targetAbs: string;
  normalizedMarkdown: string;
  /** legacy entries with missing frontmatter, etc., that we filled in */
  normalizationNotes: string[];
}

const KNOWLEDGE_KIND_DIR: Record<string, string> = {
  maxim: "maxims",
  decision: "decisions",
  "anti-pattern": "knowledge",
  pattern: "knowledge",
  fact: "knowledge",
  preference: "knowledge",
  smell: "staging",
};

function kindDirectory(kind: string, status: string): string {
  if (status === "archived") return "archive";
  return KNOWLEDGE_KIND_DIR[kind] ?? "knowledge";
}

function nowIsoLocal(): string {
  return formatLocalIsoTimestamp();
}

function buildNormalizedFrontmatter(input: {
  projectId: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  created: string;
  updated: string;
  preservedFields: Record<string, string>;
}): string {
  // Canonical field order, mirrors sediment writer + buildMarkdown layout.
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: project:${input.projectId}:${input.slug}`);
  lines.push("scope: project");
  lines.push(`kind: ${input.kind}`);
  lines.push(`status: ${input.status}`);
  lines.push(`confidence: ${input.confidence}`);
  lines.push("schema_version: 1");
  lines.push(`title: ${yamlScalar(input.title)}`);
  lines.push(`created: ${yamlScalar(input.created)}`);
  lines.push(`updated: ${yamlScalar(input.updated)}`);
  for (const [key, value] of Object.entries(input.preservedFields)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9._\-/+:@ ]+$/.test(value) && !/^[\s\-?:]/.test(value)) return value;
  return JSON.stringify(value);
}

function preservedFrontmatterLines(text: string, droppedKeys: Set<string>): Record<string, string> {
  // Extract raw line values for fields we want to preserve verbatim (e.g.
  // tags lists, trigger_phrases, relations). We don't parse YAML; we keep
  // the line as-is from the original frontmatter so list rendering stays
  // valid. Frontmatter block-level fields with `:` followed by newline
  // (multi-line values) are kept as a contiguous block.
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (!currentKey) return;
    if (droppedKeys.has(currentKey)) { currentKey = null; currentLines = []; return; }
    result[currentKey] = currentLines.length === 1
      ? currentLines[0]!
      : currentLines.join("\n").trimEnd();
    currentKey = null;
    currentLines = [];
  };
  for (const line of lines) {
    if (line === "---") continue;
    const m = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
    if (m && !line.startsWith(" ") && !line.startsWith("\t")) {
      flush();
      currentKey = m[1]!;
      currentLines = [m[2]!.replace(/^\s/, "")];
    } else if (currentKey) {
      currentLines.push(line);
    }
  }
  flush();
  return result;
}

function isPipelinePath(relPath: string): boolean {
  // Legacy pipeline locations: top-level `pipelines/` or nested
  // `short-term/pipelines/`. Filename convention is run-when-*.md
  // but not all legacy entries follow it, so trust the dir first.
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  return parts.includes("pipelines");
}

function readBool(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return false;
}

async function analyzeEntry(
  file: string,
  pensieveRoot: string,
  projectId: string,
  abrainHome: string,
  migrationTimestamp: string,
  _settings: MemorySettings,
): Promise<AnalyzedEntry> {
  // markdownFilesForTarget already filters .index/, .state/, .git/, and
  // _index.md (via IGNORE_DIRS + listFilesWithRg globs + the explicit
  // basename filter in lint.ts:231), so no per-entry derived-file guard
  // is reachable here.
  const relSource = path.relative(pensieveRoot, file);

  const raw = await fs.readFile(file, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth, timeline } = splitCompiledTruth(body);

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id?.replace(/^project:[^:]+:/, "") || pathSlug || extractTitle(body) || "entry");
  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const status = scalarString(frontmatter.status) || "active";

  const isPipeline = isPipelinePath(relSource) || scalarString(frontmatter.kind) === "pipeline";
  const crossProject = readBool(frontmatter.cross_project);

  /* ── pipeline routing ── */
  if (isPipeline) {
    const targetDir = crossProject
      ? abrainWorkflowsDir(abrainHome)
      : abrainProjectWorkflowsDir(abrainHome, projectId);
    const targetAbs = path.join(targetDir, `${slug}.md`);
    // Workflow markdown is built by writeAbrainWorkflow; we pass through the
    // raw legacy body as-is and let the writer regenerate frontmatter + Timeline.
    // The route flag tells runMigrationGo which writer to invoke.
    return {
      sourceAbs: file,
      relSource,
      slug,
      title,
      kind: "workflow",
      status,
      confidence: 5,
      isPipeline: true,
      crossProject,
      route: crossProject ? "workflow-cross-project" : "workflow-project",
      targetAbs,
      normalizedMarkdown: "",  // not used for workflows; writer rebuilds
      normalizationNotes: [],
    };
  }

  /* ── knowledge-kind routing ── */
  const inferredKind = scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relSource);
  const kind = legacyKindNormalize(inferredKind);
  const confidence = clamp(
    scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind),
    0,
    10,
  );
  const created = scalarString(frontmatter.created) || migrationTimestamp.slice(0, 10);
  const updated = scalarString(frontmatter.updated) || migrationTimestamp;

  const notes: string[] = [];
  if (!frontmatterText) notes.push("missing frontmatter");
  if (isEmptyFrontmatterValue(frontmatter.schema_version)) notes.push("missing schema_version");
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (isEmptyFrontmatterValue(frontmatter[field])) notes.push(`missing ${field}`);
  }
  if (timeline.length === 0) notes.push("missing Timeline entries");
  if (!/^##\s+Timeline\s*$/m.test(body)) notes.push("missing ## Timeline heading");

  const preserved = preservedFrontmatterLines(frontmatterText, new Set([
    "id", "scope", "kind", "type", "status", "confidence", "schema_version",
    "title", "created", "updated",
  ]));

  const newFrontmatter = buildNormalizedFrontmatter({
    projectId,
    slug,
    title,
    kind,
    status,
    confidence,
    created,
    updated,
    preservedFields: preserved,
  });

  // Build body: keep compiledTruth + ensure `# <title>` heading + reattach
  // Timeline (preserving existing entries, prepending migrated-from-legacy).
  const newBody = buildNormalizedBody(title, compiledTruth, timeline, migrationTimestamp);
  const normalizedMarkdown = `${newFrontmatter}\n\n${newBody}\n`;

  const kindDir = kindDirectory(kind, status);
  const targetAbs = path.join(abrainProjectDir(abrainHome, projectId), kindDir, `${slug}.md`);

  return {
    sourceAbs: file,
    relSource,
    slug,
    title,
    kind,
    status,
    confidence,
    isPipeline: false,
    crossProject: false,
    route: "knowledge",
    targetAbs,
    normalizedMarkdown,
    normalizationNotes: notes,
  };
}

function legacyKindNormalize(kindOrType: string): string {
  const k = (kindOrType || "").toLowerCase().trim();
  if (k === "maxim") return "maxim";
  if (k === "decision") return "decision";
  if (k === "pattern") return "pattern";
  if (k === "anti-pattern" || k === "antipattern") return "anti-pattern";
  if (k === "preference") return "preference";
  if (k === "smell") return "smell";
  if (k === "knowledge") return "fact";   // legacy alias → fact
  if (k === "fact") return "fact";
  return "fact";
}

function buildNormalizedBody(
  title: string,
  compiledTruth: string,
  timeline: string[],
  migrationTimestamp: string,
): string {
  let main = compiledTruth.trim();
  // Defense against frontmatter break-out (same trick as sediment writer):
  // body line that is exactly `---` would re-open frontmatter on next parse.
  main = main.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(main)) main = `# ${title}\n\n${main}`;
  const tlLines = ["## Timeline", ""];
  tlLines.push(`- ${migrationTimestamp} | migration | migrated-from-legacy | one-shot per-repo migration to abrain projects substrate`);
  for (const line of timeline) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // existing lines already start with `- ts | ...`; keep verbatim
    tlLines.push(trimmed.startsWith("- ") ? trimmed : `- ${trimmed}`);
  }
  return `${main.trim()}\n\n${tlLines.join("\n")}`;
}

/* ── Run (write + commit) ──────────────────────────────────────────── */

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

export async function runMigrationGo(opts: MigrationGoOptions): Promise<MigrationGoResult> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const pensieveAbs = path.resolve(opts.pensieveTarget);
  const abrainHome = path.resolve(opts.abrainHome);
  const migrationTimestamp = opts.migrationTimestamp || nowIsoLocal();

  const pre = await preflightMigrationGo(opts);
  if (!pre.ok) {
    return {
      ok: false,
      projectId: pre.projectId,
      projectIdSource: pre.projectIdSource,
      parentRepoRoot: pre.parentRepoRoot,
      abrainProjectDir: pre.projectId ? abrainProjectDir(abrainHome, pre.projectId) : "",
      entries: [],
      movedCount: 0,
      workflowCount: 0,
      skippedCount: 0,
      failedCount: 0,
      preconditionFailures: pre.failures,
    };
  }

  const projectId = pre.projectId;
  const parentRepoRoot = pre.parentRepoRoot;
  const projectAbrainDir = abrainProjectDir(abrainHome, projectId);

  // Lazy import to avoid pulling sediment into the memory module's eager
  // dependency graph. The writer module is independently bundled.
  const { writeAbrainWorkflow } = await import("../sediment/writer");
  const { DEFAULT_SEDIMENT_SETTINGS } = await import("../sediment/settings");

  const files = await markdownFilesForTarget(pensieveAbs, opts.settings, opts.signal);
  const entries: MigrationGoEntryReport[] = [];
  let movedCount = 0;
  let workflowCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const file of files) {
    throwIfAborted(opts.signal);
    const relSource = path.relative(pensieveAbs, file);
    try {
      const analyzed = await analyzeEntry(file, pensieveAbs, projectId, abrainHome, migrationTimestamp, opts.settings);

      if (analyzed.isPipeline) {
        const raw = await fs.readFile(file, "utf-8");
        const { body } = splitFrontmatter(raw);
        const { compiledTruth, timeline } = splitCompiledTruth(body);
        // Trigger heuristic: explicit `trigger:` frontmatter wins; else look
        // for "**Trigger**:" line in body; else use a generic placeholder.
        const fm = parseFrontmatter(splitFrontmatter(raw).frontmatterText);
        const trigger = scalarString(fm.trigger)
          || (compiledTruth.match(/\*\*Trigger\*\*:\s*(.+)/i)?.[1]?.trim())
          || `migrated pipeline: ${analyzed.title}`;

        // workflowBody: drop existing `# <title>` since the writer prepends
        // one. Preserve everything else as-is; timeline gets regenerated
        // by writer (B1 deliberately drops legacy Timeline to keep audit
        // history single-source). We add legacy Timeline as a note paragraph
        // so the data isn't lost.
        let workflowBody = compiledTruth.trim();
        workflowBody = workflowBody.replace(/^#\s+.*$/m, "").trim();
        if (timeline.length > 0) {
          workflowBody += `\n\n### Legacy Timeline\n${timeline.map((line) => line.trim().startsWith("- ") ? line.trim() : `- ${line.trim()}`).join("\n")}`;
        }
        if (workflowBody.length < 20) {
          workflowBody = `${workflowBody}\n\n(migrated from ${prettyPath(file, cwd)}; body recovered as-is)`;
        }

        const result = await writeAbrainWorkflow(
          {
            title: analyzed.title,
            trigger,
            body: workflowBody,
            crossProject: analyzed.crossProject,
            projectId: analyzed.crossProject ? undefined : projectId,
            slug: analyzed.slug,
            timelineNote: "migrated from legacy .pensieve/pipelines/",
          },
          { abrainHome, settings: DEFAULT_SEDIMENT_SETTINGS },
        );
        if (result.status === "created") {
          await gitRmOrUnlink(parentRepoRoot, file);
          workflowCount += 1;
          entries.push({
            source: relSource,
            target: path.relative(abrainHome, result.path),
            slug: result.slug,
            title: analyzed.title,
            kind: "workflow",
            route: analyzed.route,
            action: "migrated",
          });
        } else {
          failedCount += 1;
          entries.push({
            source: relSource,
            target: path.relative(abrainHome, result.path),
            slug: result.slug,
            title: analyzed.title,
            kind: "workflow",
            route: analyzed.route,
            action: "failed",
            reason: result.reason || result.status,
          });
        }
        continue;
      }

      // knowledge route: atomic write + git rm source
      if (fsSync.existsSync(analyzed.targetAbs)) {
        failedCount += 1;
        entries.push({
          source: relSource,
          target: path.relative(abrainHome, analyzed.targetAbs),
          slug: analyzed.slug,
          title: analyzed.title,
          kind: analyzed.kind,
          route: "knowledge",
          action: "failed",
          reason: "target already exists in abrain projects dir (slug collision)",
        });
        continue;
      }
      await atomicWrite(analyzed.targetAbs, analyzed.normalizedMarkdown);
      await gitRmOrUnlink(parentRepoRoot, file);
      movedCount += 1;
      entries.push({
        source: relSource,
        target: path.relative(abrainHome, analyzed.targetAbs),
        slug: analyzed.slug,
        title: analyzed.title,
        kind: analyzed.kind,
        route: "knowledge",
        action: "migrated",
      });
    } catch (e: unknown) {
      failedCount += 1;
      entries.push({
        source: relSource,
        target: "",
        slug: "",
        title: "",
        kind: "",
        route: "knowledge",
        action: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Single commit per side (workflow writer already committed individual
  // workflows in abrain; we commit any leftover staged changes — typically
  // none, but in case writeAbrainWorkflow's gitCommit hit a soft failure
  // we don't want to leave orphans).
  const parentBasename = path.basename(parentRepoRoot);
  const parentCommitSha = await gitCommitAll(
    parentRepoRoot,
    `chore: migrate .pensieve → ~/.abrain/projects/${projectId} (${movedCount + workflowCount} entries)`,
  );
  const abrainCommitSha = await gitCommitAll(
    abrainHome,
    `migrate(in): ${projectId} (${movedCount} knowledge + ${workflowCount} workflow entries from ${parentBasename})`,
  );

  return {
    ok: true,
    projectId,
    projectIdSource: pre.projectIdSource,
    parentRepoRoot,
    abrainProjectDir: projectAbrainDir,
    entries,
    movedCount,
    workflowCount,
    skippedCount,
    failedCount,
    parentCommitSha,
    abrainCommitSha,
    preconditionFailures: [],
  };
}

/* ── Pretty-print summary for /memory migrate --go output ──────────── */

export function formatMigrationGoSummary(result: MigrationGoResult, cwd: string = process.cwd()): string {
  const lines: string[] = [];
  if (!result.ok) {
    lines.push(`Migration aborted: ${result.preconditionFailures.length} precondition(s) failed.`);
    for (const f of result.preconditionFailures) lines.push(`  - ${f}`);
    return lines.join("\n");
  }
  lines.push(
    `Migration complete: projectId=${result.projectId} (${result.projectIdSource})`,
    `  moved (knowledge): ${result.movedCount}`,
    `  routed (workflow): ${result.workflowCount}`,
    `  skipped: ${result.skippedCount}`,
    `  failed: ${result.failedCount}`,
    `  parent commit: ${result.parentCommitSha ?? "(none — no changes staged)"}`,
    `  abrain commit: ${result.abrainCommitSha ?? "(none — no changes staged)"}`,
  );
  if (result.failedCount > 0) {
    lines.push("", "Failures:");
    for (const entry of result.entries.filter((e) => e.action === "failed").slice(0, 10)) {
      lines.push(`  - ${entry.source} → ${entry.target}: ${entry.reason}`);
    }
    if (result.failedCount > 10) lines.push(`  ... ${result.failedCount - 10} more failure(s) omitted`);
  }
  lines.push(
    "",
    `Rollback (if needed):`,
    `  cd ${prettyPath(result.parentRepoRoot, cwd)} && git reset --hard HEAD~1`,
    `  cd ~/.abrain && git reset --hard HEAD~1`,
  );
  return lines.join("\n");
}
