import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "./settings";
import type { Jsonish, MemoryEntry, RelationEdge, RelationScope, StoreRef, Scope } from "./types";
import { compareTimestamps, normalizeBareSlug, prettyPath, stableUnique, titleFromSlug, throwIfAborted } from "./utils";
import { resolveActiveProject, abrainProjectDir } from "../_shared/runtime";

const execFileAsync = promisify(execFile);

const IGNORE_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", ".state", ".index", ".cache",
]);

const RELATION_KEYS = new Set([
  "relates_to",
  "derives_from",
  "superseded_by",
  "applied_in",
  "contested_with",
  "references",
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with",
  "is", "are", "was", "were", "be", "by", "as", "at", "from", "this", "that",
  "it", "its", "into", "via", "not", "no", "do", "does", "did", "use", "using",
]);

export function resolveStores(cwdRaw: string | undefined, settings: MemorySettings): StoreRef[] {
  const cwd = path.resolve(cwdRaw || process.cwd());
  const stores: StoreRef[] = [];

  // 1. Primary project store: <cwd>/.pensieve/ (Phase 1.4 SOT)
  const projectRoot = path.join(cwd, ".pensieve");
  if (fsSync.existsSync(projectRoot) && fsSync.statSync(projectRoot).isDirectory()) {
    stores.push({ scope: "project", root: projectRoot, label: "project" });
  }

  // Resolve abrain home once (used by both project-dual and world)
  const abrainHome = path.resolve(
    process.env.ABRAIN_ROOT
      ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".abrain"),
  );
  const abrainExists = fsSync.existsSync(abrainHome) && fsSync.statSync(abrainHome).isDirectory();

  // 2. Abrain project store (dual-read, migration plan P2):
  //    ~/.abrain/projects/<id>/ — read alongside .pensieve/ when
  //    the active project has a binding. Currently this directory
  //    is empty (migration P5-P6 not yet executed), so this store
  //    is a future-proof no-op. When migration happens, entries
  //    found here will be deduped against .pensieve/ in loadEntries().
  if (abrainExists) {
    try {
      const resolved = resolveActiveProject(cwd, { abrainHome });
      if (resolved.activeProject) {
        const abrainProjDir = abrainProjectDir(abrainHome, resolved.activeProject.projectId);
        if (fsSync.existsSync(abrainProjDir) && fsSync.statSync(abrainProjDir).isDirectory()) {
          stores.push({ scope: "project", root: abrainProjDir, label: "abrain-project" });
        }
      }
    } catch {
      // Strict binding resolution failure → no project dual-read, not an error.
    }
  }

  // 3. World store: ~/.abrain/ (flat legacy world knowledge)
  if (settings.includeWorld && abrainExists) {
    stores.push({ scope: "world", root: abrainHome, label: "world" });
  }

  return stores;
}

export function splitFrontmatter(raw: string): { frontmatterText: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatterText: "", body: raw };
  }

  // Accept both common forms:
  //   ---\nfrontmatter\n---\nbody
  //   ---\nfrontmatter\n---        (empty body / EOF after closing fence)
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) return { frontmatterText: "", body: raw };
  return { frontmatterText: match[1], body: match[2] ?? "" };
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function parseScalar(raw: string): Jsonish {
  let s = stripInlineComment(raw).trim();
  if (!s) return "";

  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }

  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((part) => parseScalar(part.trim()))
      .filter((part) => part !== "");
  }

  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatter(text: string): Record<string, Jsonish> {
  const out: Record<string, Jsonish> = {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue;

    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) continue;

    const key = match[1];
    const rest = (match[2] ?? "").trim();

    if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].replace(/^\s+/, ""));
      }
      out[key] = rest.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
      continue;
    }

    if (rest === "") {
      const arr: Jsonish[] = [];
      let consumed = false;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const item = next.match(/^\s+-\s+(.*)$/);
        if (!item) break;
        consumed = true;
        i++;
        arr.push(parseScalar(item[1]));
      }
      out[key] = consumed ? arr : {};
      continue;
    }

    out[key] = parseScalar(rest);
  }

  return out;
}

export function extractTitle(body: string): string | undefined {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}

export function splitCompiledTruth(body: string): { compiledTruth: string; timeline: string[] } {
  const normalized = body.replace(/\r\n/g, "\n");
  const match = /^##\s+Timeline\s*$/m.exec(normalized);
  if (!match) return { compiledTruth: normalized.trim(), timeline: [] };

  const compiled = normalized.slice(0, match.index).trim();
  const timelineRaw = normalized.slice(match.index + match[0].length).trim();
  const timeline = timelineRaw
    ? timelineRaw.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim())
    : [];
  return { compiledTruth: compiled, timeline };
}

function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSummary(compiledTruth: string, fallbackTitle: string): string {
  const withoutTitle = compiledTruth
    .replace(/^#\s+.*$/m, "")
    .replace(/^---$/gm, "");
  const paragraphs = withoutTitle
    .split(/\n\s*\n/g)
    .map((p) => markdownToPlain(p))
    .filter((p) => p.length >= 20);
  const selected = paragraphs[0] || markdownToPlain(withoutTitle) || fallbackTitle;
  return selected.length > 240 ? `${selected.slice(0, 237)}...` : selected;
}

/**
 * Infer entry kind from directory path.
 *
 * Authoritative kind set (write side, see extensions/sediment/validation.ts
 * ENTRY_KINDS) is 7: maxim / decision / pattern / anti-pattern / fact /
 * preference / smell. Writer only produces these.
 *
 * The two extra returns below — `"pipeline"` and `"knowledge"` — are READ-ONLY
 * LEGACY ALIASES for pre-frontmatter pensieve entries that pre-date the v7
 * frontmatter+compiled-truth format. Modern entries always carry an explicit
 * `kind:` field in frontmatter (see parser.ts:~357 priority chain:
 * `frontmatter.kind || frontmatter.type || inferKindFromPath`), so this fallback
 * only triggers on legacy data without frontmatter.kind.
 *
 * Pipeline kind is being phased out: per ADR 0014 v7.1 abrain redesign,
 * pipeline-shaped entries ("run-when-*.md" task blueprints) belong in
 * abrain `workflows/` zone, not in project knowledge. B1 shipped the abrain
 * workflows lane writer; until every legacy repo has migrated, parser keeps
 * the alias so existing legacy `pipelines/` and top-level `knowledge/`
 * directories remain readable.
 *
 * Do not add new kind aliases here — extend ENTRY_KINDS instead.
 */
export function inferKindFromPath(relPath: string): string {
  const parts = relPath.split(/[\\/]+/);
  const dirs = new Set(parts.slice(0, -1));
  if (dirs.has("maxims")) return "maxim";
  if (dirs.has("decisions")) return "decision";
  if (dirs.has("patterns")) return "pattern";
  if (dirs.has("anti-patterns")) return "anti-pattern";
  if (dirs.has("facts")) return "fact";
  if (dirs.has("staging")) return "smell";
  // Legacy aliases — see JSDoc above. Do not extend.
  if (dirs.has("pipelines")) return "pipeline";
  if (dirs.has("knowledge")) return "knowledge";
  return "fact";
}

export function defaultConfidence(kind: string): number {
  switch (kind) {
    case "maxim": return 7;
    case "fact": return 5;
    case "knowledge": return 5;
    case "preference": return 5;
    case "pipeline": return 5;
    case "smell": return 2;
    case "decision": return 3;
    case "pattern": return 3;
    case "anti-pattern": return 3;
    default: return 3;
  }
}

export function scalarString(value: Jsonish | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

export function scalarNumber(value: Jsonish | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function relationValues(value: Jsonish | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

// Strip fenced code blocks (``` ... ```) and inline code spans (`...`)
// so wikilink-shaped examples inside code do not pollute the graph.
function stripCode(body: string): string {
  let out = body.replace(/```[\s\S]*?```/g, "");
  out = out.replace(/`[^`\n]*`/g, "");
  return out;
}

const KNOWN_SCOPE_PREFIXES: ReadonlySet<RelationScope> = new Set(["world", "workflow", "project"]);

export interface WikilinkTarget {
  slug: string;
  scope?: RelationScope;
  qualifier?: string;
}

/**
 * Parse a wikilink target (or any "slug-like" relation value) into a
 * structured tuple of {slug, scope, qualifier}. Recognises:
 *
 *   `[[foo]]`                 → {slug:"foo"}
 *   `[[world:foo]]`           → {slug:"foo", scope:"world"}
 *   `[[workflow:foo]]`        → {slug:"foo", scope:"workflow"}
 *   `[[project:pi:foo]]`      → {slug:"foo", scope:"project", qualifier:"pi"}
 *   `[[person:alfadb]]`       → {slug:"alfadb", scope:"unknown", qualifier:"person"}
 *   `abrain://world/p/foo`    → {slug:"foo", scope:"world"}
 *   `abrain://projects/<id>/x/foo` → {slug:"foo", scope:"project", qualifier:"<id>"}
 *
 * Empty / unparseable input → {slug:""}. Caller filters empties.
 *
 * NOTE: This is the canonical wikilink scope parser. `normalizeBareSlug`
 * is the legacy bare-slug normalizer that silently DROPS the prefix —
 * still used for id-suffix extraction and filename slugging, but no longer
 * used for relation-target parsing where we need scope information.
 */
export function parseWikilinkTarget(raw: string): WikilinkTarget {
  let s = String(raw || "").trim();
  if (!s) return { slug: "" };
  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
  // Strip alias / anchor; pi-astack data has 0 of these in pi-global but
  // wikilink spec allows them.
  s = s.split("|")[0]!.split("#")[0]!.trim();
  if (!s) return { slug: "" };

  // abrain:// URL form (legacy / prototype shape; seen in pi-global
  // frontmatter `relates_to` from May 2026 spec drafts).
  const urlMatch = /^abrain:\/\/([^/]+)\/(.+)$/i.exec(s);
  if (urlMatch) {
    const head = urlMatch[1]!.toLowerCase();
    const tail = urlMatch[2]!;
    if (head === "world" || head === "workflow") {
      return { slug: normalizeBareSlug(tail), scope: head as RelationScope };
    }
    if (head === "projects") {
      const projectMatch = /^([^/]+)\/(.+)$/.exec(tail);
      if (projectMatch) {
        return { slug: normalizeBareSlug(projectMatch[2]!), scope: "project", qualifier: projectMatch[1] };
      }
    }
    // Unrecognised abrain:// host; fall through to bare normalize.
    return { slug: normalizeBareSlug(tail) };
  }

  // Prefix form: <head>:<tail>
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) {
    const head = s.slice(0, colonIdx);
    const tail = s.slice(colonIdx + 1);
    if (head === "world" || head === "workflow") {
      return { slug: normalizeBareSlug(tail), scope: head as RelationScope };
    }
    if (head === "project") {
      // `project:<id>:<slug>` — split off project id.
      const innerIdx = tail.indexOf(":");
      if (innerIdx > 0) {
        return {
          slug: normalizeBareSlug(tail.slice(innerIdx + 1)),
          scope: "project",
          qualifier: tail.slice(0, innerIdx),
        };
      }
      // `project:<slug>` without id — treat as plain slug, no scope.
      return { slug: normalizeBareSlug(tail) };
    }
    if (!KNOWN_SCOPE_PREFIXES.has(head as RelationScope)) {
      // user-defined typed link (`person:`, `company:`, etc.)
      return { slug: normalizeBareSlug(tail), scope: "unknown", qualifier: head };
    }
  }

  return { slug: normalizeBareSlug(s) };
}

function extractBodyWikilinkTargets(body: string): WikilinkTarget[] {
  const out: WikilinkTarget[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  const stripped = stripCode(body);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const tgt = parseWikilinkTarget(match[1]!);
    if (tgt.slug) out.push(tgt);
  }
  // De-duplicate by (slug, scope, qualifier) tuple to preserve scope
  // diversity (project entry MAY legitimately reference both bare `foo`
  // and `world:foo` if they have distinct meanings).
  const seen = new Set<string>();
  return out.filter((t) => {
    const sig = `${t.slug}\0${t.scope ?? ""}\0${t.qualifier ?? ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

function extractRelations(frontmatter: Record<string, Jsonish>, body: string): RelationEdge[] {
  const edges: RelationEdge[] = [];

  for (const key of RELATION_KEYS) {
    for (const raw of relationValues(frontmatter[key])) {
      const tgt = parseWikilinkTarget(raw);
      if (!tgt.slug) continue;
      const edge: RelationEdge = { to: tgt.slug, type: key, source: "frontmatter" };
      if (tgt.scope) edge.scope = tgt.scope;
      if (tgt.qualifier) edge.qualifier = tgt.qualifier;
      edges.push(edge);
    }
  }

  for (const tgt of extractBodyWikilinkTargets(body)) {
    const edge: RelationEdge = { to: tgt.slug, type: "references", source: "body_wikilink" };
    if (tgt.scope) edge.scope = tgt.scope;
    if (tgt.qualifier) edge.qualifier = tgt.qualifier;
    edges.push(edge);
  }

  const seen = new Set<string>();
  return edges.filter((edge) => {
    const sig = `${edge.to}\0${edge.type}\0${edge.source}\0${edge.scope ?? ""}\0${edge.qualifier ?? ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
}

export function tokenize(text: string): string[] {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/@#.:\\/\-]+/g, " ");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function tokenCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export async function parseEntry(file: string, store: StoreRef, cwd: string): Promise<MemoryEntry | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }

  const relPath = path.relative(store.root, file);
  const { frontmatterText, body } = splitFrontmatter(raw);
  // Skip files without frontmatter. Canonical memory entries ALWAYS
  // have schema v1 frontmatter (`---` ... `---`); plain markdown like
  // README.md / CHANGELOG.md / docs would otherwise be coerced into
  // degraded entries (kind=fact, status=active by default) and
  // pollute search results. Discovered when initializing ~/.abrain/
  // and finding the README.md indexed as a memory entry.
  if (!frontmatterText.trim()) return null;
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth, timeline } = splitCompiledTruth(body);

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id || pathSlug || extractTitle(body) || "entry");

  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const kind = scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relPath);
  const status = scalarString(frontmatter.status) || "active";
  const confidence = Math.min(10, Math.max(0, scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind)));
  const scopeRaw = scalarString(frontmatter.scope);
  const scope: Scope = scopeRaw === "world" || scopeRaw === "project" ? scopeRaw : store.scope;
  const summary = makeSummary(compiledTruth, title);
  const relations = extractRelations(frontmatter, body);
  const relatedSlugs = stableUnique(relations.map((edge) => edge.to)).slice(0, 20);
  const tokens = tokenize(`${title}\n${slug}\n${compiledTruth}`);

  return {
    slug,
    ...(id ? { id } : {}),
    scope,
    kind,
    status,
    confidence,
    title,
    summary,
    created: scalarString(frontmatter.created),
    updated: scalarString(frontmatter.updated),
    sourcePath: file,
    displayPath: prettyPath(file, cwd),
    storeRoot: store.root,
    frontmatter,
    compiledTruth,
    timeline,
    relatedSlugs,
    relations,
    tokenCounts: tokenCounts(tokens),
    tokenTotal: Math.max(1, tokens.length),
  };
}

export async function listFilesWithRg(root: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--files",
        "--glob", "*.md",
        "--glob", "!**/.state/**",
        "--glob", "!**/.index/**",
        "--glob", "!**/.git/**",
        root,
      ],
      { signal, timeout: 3_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export async function walkMarkdownFiles(root: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    throwIfAborted(signal);
    if (out.length >= maxEntries) return;

    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_index.md") {
        out.push(abs);
      }
    }
  }

  await walk(root);
  return out;
}

export async function scanStore(
  store: StoreRef,
  cwd: string,
  settings: MemorySettings,
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  throwIfAborted(signal);
  const rgFiles = await listFilesWithRg(store.root, signal);
  const files = (rgFiles ?? await walkMarkdownFiles(store.root, settings.maxEntries, signal))
    .filter((file) => path.basename(file) !== "_index.md")
    .slice(0, settings.maxEntries);

  const entries: MemoryEntry[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    const entry = await parseEntry(path.resolve(file), store, cwd);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function loadEntries(
  cwdRaw: string | undefined,
  settings: MemorySettings,
  signal?: AbortSignal,
): Promise<MemoryEntry[]> {
  const cwd = path.resolve(cwdRaw || process.cwd());
  const stores = resolveStores(cwd, settings);
  if (stores.length === 0) return [];

  // Round 7 P1 (gpt-5.5 audit fix): identify abort errors and rethrow.
  // Previously `.catch(() => [])` swallowed AbortError too, turning user
  // cancellation into "no memory found" — LLMs and humans then misread
  // the empty result as evidence of fact.
  const batches = await Promise.all(
    stores.map((store) => scanStore(store, cwd, settings, signal).catch((err: unknown) => {
      if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) throw err;
      return [];
    })),
  );
  const flat = batches.flat();

  // Dedup: when the same slug appears in multiple stores (e.g. .pensieve/
  // and abrain/projects/<id>/ after migration), keep the first occurrence.
  // Stores are ordered by priority: .pensieve/ > abrain project > world.
  // Within same slug, higher-confidence entries win; otherwise first-wins.
  const seen = new Map<string, MemoryEntry>();
  for (const entry of flat) {
    const existing = seen.get(entry.slug);
    if (!existing) {
      seen.set(entry.slug, entry);
      continue;
    }
    // Keep the entry with higher confidence; tiebreak by updated date
    if (entry.confidence > existing.confidence) {
      seen.set(entry.slug, entry);
    } else if (entry.confidence === existing.confidence) {
      // Round 7 P1 (sonnet audit fix): use compareTimestamps (Date.parse-
      // based, TZ aware) instead of string compare. Date-only vs full ISO
      // / cross-TZ-offset values used to break tiebreak ordering across
      // .pensieve and abrain stores.
      const eu = entry.updated || entry.created;
      const xu = existing.updated || existing.created;
      if (compareTimestamps(eu, xu) > 0) seen.set(entry.slug, entry);
    }
  }

  return Array.from(seen.values());
}
