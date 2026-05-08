import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "./settings";
import type { Jsonish, MemoryEntry, RelationEdge, StoreRef, Scope } from "./types";
import { normalizeBareSlug, prettyPath, stableUnique, titleFromSlug, throwIfAborted } from "./utils";

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

  const projectRoot = path.join(cwd, ".pensieve");
  if (fsSync.existsSync(projectRoot) && fsSync.statSync(projectRoot).isDirectory()) {
    stores.push({ scope: "project", root: projectRoot, label: "project" });
  }

  if (settings.includeWorld) {
    const abrainRoot = path.resolve(
      process.env.ABRAIN_ROOT
        ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
        : path.join(os.homedir(), ".abrain"),
    );
    if (fsSync.existsSync(abrainRoot) && fsSync.statSync(abrainRoot).isDirectory()) {
      stores.push({ scope: "world", root: abrainRoot, label: "world" });
    }
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

export function inferKindFromPath(relPath: string): string {
  const parts = relPath.split(/[\\/]+/);
  const dirs = new Set(parts.slice(0, -1));
  if (dirs.has("maxims")) return "maxim";
  if (dirs.has("decisions")) return "decision";
  if (dirs.has("patterns")) return "pattern";
  if (dirs.has("anti-patterns")) return "anti-pattern";
  if (dirs.has("facts")) return "fact";
  if (dirs.has("staging")) return "smell";
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

function extractBodyWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  const stripped = stripCode(body);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped))) {
    const slug = normalizeBareSlug(match[1]);
    if (slug) out.push(slug);
  }
  return stableUnique(out);
}

function extractRelations(frontmatter: Record<string, Jsonish>, body: string): RelationEdge[] {
  const edges: RelationEdge[] = [];

  for (const key of RELATION_KEYS) {
    for (const raw of relationValues(frontmatter[key])) {
      const to = normalizeBareSlug(raw);
      if (to) edges.push({ to, type: key, source: "frontmatter" });
    }
  }

  for (const to of extractBodyWikilinks(body)) {
    edges.push({ to, type: "references", source: "body_wikilink" });
  }

  const seen = new Set<string>();
  return edges.filter((edge) => {
    const sig = `${edge.to}\0${edge.type}\0${edge.source}`;
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

  const batches = await Promise.all(
    stores.map((store) => scanStore(store, cwd, settings, signal).catch(() => [])),
  );
  return batches.flat();
}
