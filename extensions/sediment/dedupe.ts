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
  /**
   * Hard-duplicate signal. True when the candidate would create a slug
   * collision OR shares >= TITLE_TRIGRAM_THRESHOLD word-trigram jaccard
   * with an existing entry. Callers MUST reject in this case.
   */
  duplicate: boolean;
  reason?: "slug_exact" | "title_trigram" | "near_duplicate_rare_token";
  /** Score relevant to `reason`. For trigram reasons it is the jaccard. */
  score: number;
  match?: DedupeMatch;
  /**
   * Soft near-duplicate signal (added 2026-05-08). True when the
   * candidate shares a high char-trigram score AND >= 1 rare token
   * (df <= rareTokenMaxDf) with an existing entry of the same kind.
   *
   * Trigger case: t1="normalizeBareSlug Breaks on Titles Containing
   * Forward Slash" vs t2="normalizeBareSlug Must Not Be Used for
   * Free-Text Titles" — word-trigram jaccard 0.000 (no shared 3-token
   * windows) but they describe the same insight. Char trigram 0.267,
   * shared rare token "normalizebareslug" (df=2, only in these two).
   *
   * Why two signals AND'd: char trigram alone false-fires on legitimate
   * series like "memory-architecture.md 三模型共识评审" vs "memory-
   * architecture.md 第二轮三模型双盲评审" (char trigram 0.566) where
   * the shared tokens ("memory", "architecture") are common enough
   * that df > rareTokenMaxDf, so the rare-token gate keeps them apart.
   */
  nearDuplicate?: boolean;
  /**
   * Diagnostic fields for the soft signal; populated when nearDuplicate
   * is true OR when char trigram > 0 against best near-match. Useful
   * for audit + future tuning.
   */
  nearDuplicateDetail?: {
    charTrigramScore: number;
    sharedRareTokens: string[];
    sameKind: boolean;
  };
}

export const TITLE_TRIGRAM_THRESHOLD = 0.7;

/**
 * Char-trigram jaccard threshold for the soft near-duplicate signal.
 * Calibrated against the live `.pensieve/` (97 titles, 2026-05-08): a
 * sweep showed legitimate-but-similar pairs cluster at 0.30-0.55 while
 * unrelated pairs sit < 0.05; the target near-duplicate (
 * normalizebareslug pair) sits at 0.267. Threshold 0.20 catches it
 * with a wide false-positive margin when combined with the rare-token
 * AND same-kind constraints.
 */
export const NEAR_DUP_CHAR_TRIGRAM_THRESHOLD = 0.20;

/**
 * Maximum document-frequency for a token to count as "rare" — i.e.
 * the token appears in at most this many existing entry titles. df=2
 * is intentionally strict: a technical identifier shared between only
 * the candidate and one existing entry is high-precision evidence of
 * near-duplication.
 */
export const NEAR_DUP_RARE_TOKEN_MAX_DF = 2;

function wordTokens(title: string): string[] {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[_/@#.:\\/\-]+/g, " ")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether a token is "distinctive enough" to participate in the rare-
 * token signal. Filters out short noise tokens ("pi", "is", "the")
 * while keeping technical identifiers (`normalizebareslug`,
 * `slugify`) and CJK content words.
 *
 * Rule: ASCII tokens require length >= 6 (matches typical identifier
 * lengths); non-ASCII tokens require length >= 2 (CJK characters
 * carry per-char content density).
 */
function isDistinctiveToken(tok: string): boolean {
  if (tok.length < 2) return false;
  if (/^[a-z0-9]+$/.test(tok)) return tok.length >= 6;
  return tok.length >= 2;
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

export interface DetectDuplicateOpts {
  slug?: string;
  threshold?: number;
  signal?: AbortSignal;
  /** Candidate's kind, used by the soft near-duplicate signal. */
  kind?: string;
  /** Override char-trigram threshold for the soft signal. */
  charTrigramThreshold?: number;
  /** Override max document-frequency for a token to count as rare. */
  rareTokenMaxDf?: number;
}

export async function detectProjectDuplicate(
  projectRoot: string,
  title: string,
  opts?: DetectDuplicateOpts,
): Promise<DedupeResult> {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const slug = opts?.slug ?? slugify(title);
  const threshold = opts?.threshold ?? TITLE_TRIGRAM_THRESHOLD;
  const charThreshold = opts?.charTrigramThreshold ?? NEAR_DUP_CHAR_TRIGRAM_THRESHOLD;
  const rareTokenMaxDf = opts?.rareTokenMaxDf ?? NEAR_DUP_RARE_TOKEN_MAX_DF;
  const candidateKind = opts?.kind;
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

  // Pre-compute df map across existing-entry title tokens. Used for the
  // rare-token signal; no-op when there are no entries.
  const dfMap = new Map<string, number>();
  for (const entry of entries) {
    const titleTokens = new Set(wordTokens(entry.title));
    for (const tok of titleTokens) {
      if (!isDistinctiveToken(tok)) continue;
      dfMap.set(tok, (dfMap.get(tok) ?? 0) + 1);
    }
  }

  const candidateTokens = wordTokens(title);
  const candidateRareTokens = new Set(
    candidateTokens.filter((t) => {
      if (!isDistinctiveToken(t)) return false;
      const df = dfMap.get(t) ?? 0;
      return df > 0 && df <= rareTokenMaxDf;
    }),
  );

  const candidateWordTrigrams = titleTrigramSet(title);
  const candidateCharTrigrams = new Set(charTrigrams(title));

  // Track best HARD signal (existing word-trigram path) and best SOFT
  // signal (new char-trigram + rare-token path) separately so a hard
  // hit always wins over a soft hit, but we still surface the soft
  // info even when no hard hit fires.
  let bestHard: DedupeResult = { duplicate: false, score: 0 };
  let bestSoft: { score: number; match: DedupeMatch; sharedRare: string[]; sameKind: boolean } | undefined;

  for (const entry of entries) {
    const wordScore = jaccard(candidateWordTrigrams, titleTrigramSet(entry.title));
    if (wordScore > bestHard.score) {
      bestHard = {
        duplicate: wordScore >= threshold,
        reason: wordScore >= threshold ? "title_trigram" : undefined,
        score: wordScore,
        match: {
          slug: entry.slug,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          source_path: entry.displayPath,
        },
      };
    }

    // Soft signal evaluation. Skip cheaply when no rare candidate token
    // is even available; char-trigram alone is too noisy without a
    // rare-token anchor.
    if (candidateRareTokens.size === 0) continue;
    const entryTokens = new Set(wordTokens(entry.title));
    const sharedRare = [...candidateRareTokens].filter((t) => entryTokens.has(t));
    if (sharedRare.length === 0) continue;

    const charScore = jaccard(candidateCharTrigrams, new Set(charTrigrams(entry.title)));
    if (charScore < charThreshold) continue;
    const sameKind = candidateKind ? entry.kind === candidateKind : true;
    if (!sameKind) continue;

    if (!bestSoft || charScore > bestSoft.score) {
      bestSoft = {
        score: charScore,
        match: {
          slug: entry.slug,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          source_path: entry.displayPath,
        },
        sharedRare,
        sameKind,
      };
    }
  }

  // Hard signal wins outright.
  if (bestHard.duplicate) return bestHard;

  // No hard hit but soft hit — return as nearDuplicate. Keep the hard
  // word-trigram score in the result so callers can see how close we
  // were to the hard threshold.
  if (bestSoft) {
    return {
      duplicate: false,
      score: bestHard.score,
      match: bestHard.match ?? bestSoft.match,
      nearDuplicate: true,
      reason: "near_duplicate_rare_token",
      nearDuplicateDetail: {
        charTrigramScore: bestSoft.score,
        sharedRareTokens: bestSoft.sharedRare,
        sameKind: bestSoft.sameKind,
      },
    };
  }

  return bestHard;
}
