import * as path from "node:path";
import { DEFAULT_SETTINGS } from "../memory/settings";
import { scanStore } from "../memory/parser";
// Title-derived slug uses `slugify` directly, NOT `normalizeBareSlug`,
// because the input is a free-text title where `/` is punctuation.
// `normalizeBareSlug` would treat `/` as a path separator and only
// keep the trailing segment, which both (a) silently truncates titles
// like "distinguished by extractor/reason combinations" and (b)
// breaks dedupe consistency vs. writer.ts which now also uses slugify.
import { slugify } from "../memory/utils";

export interface DedupeMatch {
  slug: string;
  title: string;
  kind: string;
  status: string;
  source_path: string;
}

export interface DedupeResult {
  duplicate: boolean;
  reason?: "slug_exact" | "title_trigram";
  score: number;
  match?: DedupeMatch;
}

export const TITLE_TRIGRAM_THRESHOLD = 0.7;

function wordTokens(title: string): string[] {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/@#.:\\/\-]+/g, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function ngrams(items: string[], n: number): string[] {
  if (items.length === 0) return [];
  if (items.length < n) return [items.join(" ")];
  const out: string[] = [];
  for (let i = 0; i <= items.length - n; i++) out.push(items.slice(i, i + n).join(" "));
  return out;
}

function charTrigrams(title: string): string[] {
  const s = slugify(title).replace(/-/g, "");
  if (!s) return [];
  if (s.length <= 3) return [s];
  const out: string[] = [];
  for (let i = 0; i <= s.length - 3; i++) out.push(s.slice(i, i + 3));
  return out;
}

export function titleTrigramSet(title: string): Set<string> {
  const tokens = wordTokens(title);
  const grams = tokens.length >= 3 ? ngrams(tokens, 3) : charTrigrams(title);
  return new Set(grams.filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export async function detectProjectDuplicate(
  projectRoot: string,
  title: string,
  opts?: { slug?: string; threshold?: number; signal?: AbortSignal },
): Promise<DedupeResult> {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const slug = opts?.slug ?? slugify(title);
  const threshold = opts?.threshold ?? TITLE_TRIGRAM_THRESHOLD;
  const entries = await scanStore(
    { scope: "project", root: pensieveRoot, label: "project" },
    projectRoot,
    DEFAULT_SETTINGS,
    opts?.signal,
  );

  for (const entry of entries) {
    if (entry.slug === slug) {
      return {
        duplicate: true,
        reason: "slug_exact",
        score: 1,
        match: {
          slug: entry.slug,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          source_path: entry.displayPath,
        },
      };
    }
  }

  const candidate = titleTrigramSet(title);
  let best: DedupeResult = { duplicate: false, score: 0 };
  for (const entry of entries) {
    const score = jaccard(candidate, titleTrigramSet(entry.title));
    if (score > best.score) {
      best = {
        duplicate: score >= threshold,
        reason: score >= threshold ? "title_trigram" : undefined,
        score,
        match: {
          slug: entry.slug,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          source_path: entry.displayPath,
        },
      };
    }
  }

  return best;
}
