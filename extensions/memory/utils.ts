import * as os from "node:os";
import * as path from "node:path";
import { asNumber } from "./settings";
import type { ListFilters, SearchFilters } from "./types";

export function stableUnique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s) return undefined;
  if (!(s.startsWith("{") || s.startsWith("[") || s.startsWith('"'))) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function toStringArray(value: unknown): string[] | undefined {
  const v = parseMaybeJson(value);
  if (Array.isArray(v)) {
    return stableUnique(v.map((x) => String(x).trim()).filter(Boolean));
  }
  if (typeof v === "string" && v.trim()) {
    return stableUnique(v.split(",").map((x) => x.trim()).filter(Boolean));
  }
  return undefined;
}

export function normalizeSearchFilters(value: unknown): SearchFilters {
  const obj = (parseMaybeJson(value) as Record<string, unknown>) ?? {};
  const kinds = toStringArray(obj.kinds ?? obj.kind);
  const status = toStringArray(obj.status ?? obj.statuses);
  const limit = obj.limit === undefined ? undefined : asNumber(obj.limit, NaN);
  return {
    ...(kinds ? { kinds } : {}),
    ...(status ? { status } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  };
}

export function normalizeListFilters(value: unknown): ListFilters {
  // scope is intentionally NOT read from LLM input (Facade per
  // memory-architecture.md §3 + brain-redesign-spec.md §4.3). Any `scope`
  // key supplied by the LLM is silently ignored—list returns merged results
  // across all stores.
  const obj = (parseMaybeJson(value) as Record<string, unknown>) ?? {};
  const base = normalizeSearchFilters(obj);
  const cursor = obj.cursor === undefined ? undefined : String(obj.cursor);
  return { ...base, ...(cursor ? { cursor } : {}) };
}

export function normalizeBareSlug(input: string): string {
  let s = String(input || "").trim();
  if (!s) return "";

  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
  s = s.split("|")[0].split("#")[0].trim();
  s = s.replace(/\.md$/i, "");

  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);

  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length > 0) {
    if (parts[parts.length - 1] === "content" && parts.length >= 2) {
      s = parts[parts.length - 2];
    } else {
      s = parts[parts.length - 1];
    }
  }

  return slugify(s);
}

export function slugify(input: string): string {
  return String(input || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

export function prettyPath(absPath: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const rel = path.relative(resolvedCwd, absPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel || ".";
  const home = os.homedir();
  const relHome = path.relative(home, absPath);
  if (relHome && !relHome.startsWith("..") && !path.isAbsolute(relHome)) {
    return path.join("~", relHome);
  }
  return absPath;
}

export function isAbort(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

export function throwIfAborted(signal?: AbortSignal) {
  if (isAbort(signal)) throw new Error("aborted");
}
