/**
 * markdown-fallback — read gbrain content from local markdown cache when
 * the gbrain CLI or PostgreSQL is unavailable.
 *
 * Part of pi-stack ADR 0007: offline degraded mode.
 *
 * The cache lives at ~/.pi/.gbrain-cache/markdown/pi-stack/
 * Each page is a .md file, exportable via `gbrain export --format markdown`.
 *
 * When gbrain is unreachable, tools return results from this cache with
 * `_degraded: true` metadata so the LLM knows the results may be stale.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

const CACHE_ROOT = join(homedir(), ".pi", ".gbrain-cache", "markdown");

// ── search ─────────────────────────────────────────────────────

export interface FallbackResult {
  slug: string;
  title: string;
  snippet: string;
  path: string;
  mtime: number;
}

/**
 * Simple keyword search across cached markdown files.
 * Returns results sorted by mtime (newest first) with relevance filtering.
 */
export function searchMarkdown(
  source: string,
  query: string,
  limit = 10,
): { results: FallbackResult[]; degraded: boolean } {
  const sourceDir = join(CACHE_ROOT, source);
  if (!existsSync(sourceDir)) return { results: [], degraded: true };

  const keywords = query.toLowerCase().split(/\s+/).filter((k) => k.length > 1);
  if (keywords.length === 0) return { results: [], degraded: true };

  const results: FallbackResult[] = [];

  try {
    const files = readdirSync(sourceDir).filter(
      (f) => extname(f) === ".md" && !f.startsWith("_"),
    );

    for (const file of files) {
      const fullPath = join(sourceDir, file);
      try {
        const content = readFileSync(fullPath, "utf8");
        const lower = content.toLowerCase();
        const title = extractTitle(content);

        // Score: count keyword matches
        let score = 0;
        for (const kw of keywords) {
          // Weight title matches higher
          if (title.toLowerCase().includes(kw)) score += 3;
          // Count body matches (capped)
          const bodyMatches = (lower.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
          score += Math.min(bodyMatches, 5);
        }

        if (score > 0) {
          const stat = statSync(fullPath);
          results.push({
            slug: file.replace(/\.md$/, ""),
            title,
            snippet: extractSnippet(content, keywords[0]),
            path: fullPath,
            mtime: stat.mtimeMs,
            // @ts-expect-error — custom field
            _score: score,
          });
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    return { results: [], degraded: true };
  }

  // Sort by score descending, then mtime descending
  results.sort((a: any, b: any) => {
    if (b._score !== a._score) return b._score - a._score;
    return b.mtime - a.mtime;
  });

  return { results: results.slice(0, limit), degraded: true };
}

// ── get single page ────────────────────────────────────────────

export function getMarkdownPage(
  source: string,
  slug: string,
): { content: string | null; degraded: boolean } {
  const sourceDir = join(CACHE_ROOT, source);
  const filePath = join(sourceDir, `${slug.replace(/\//g, "-")}.md`);

  if (!existsSync(filePath)) {
    // Try exact slug without normalization
    const exactPath = join(sourceDir, `${slug}.md`);
    if (!existsSync(exactPath)) return { content: null, degraded: true };
    try {
      return { content: readFileSync(exactPath, "utf8"), degraded: true };
    } catch {
      return { content: null, degraded: true };
    }
  }

  try {
    return { content: readFileSync(filePath, "utf8"), degraded: true };
  } catch {
    return { content: null, degraded: true };
  }
}

// ── query (hybrid) — delegates to search with larger limit ─────

export function queryMarkdown(
  source: string,
  question: string,
  limit = 5,
): { results: FallbackResult[]; degraded: boolean } {
  return searchMarkdown(source, question, limit);
}

// ── helpers ────────────────────────────────────────────────────

function extractTitle(content: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const firstLine = content.split("\n")[0];
  return firstLine.replace(/^#+\s*/, "").trim() || "(untitled)";
}

function extractSnippet(content: string, keyword: string, context = 80): string {
  const idx = content.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx === -1) return content.slice(0, context * 2);
  const start = Math.max(0, idx - context);
  const end = Math.min(content.length, idx + keyword.length + context);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet += "...";
  return snippet;
}
