/**
 * pi-sediment gbrain target — write to gbrain via CLI, search for related pages.
 *
 * Uses `gbrain put <slug> --content <frontmatter+body>` to avoid
 * Bun's /dev/stdin reliability issues in headless/pipe environments.
 * Throttle/rate-limit → silent downgrade (deferred).
 * gbrain unavailable → silent skip.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gbrainCommand, isNonLatin, logLine, sanitizeSlug } from "../utils.js";
import type { GbrainWriteOutput, GbrainSearchResult } from "../types.js";

const execFileP = promisify(execFile);

// ── Constants ─────────────────────────────────────────────────

/** Be defensive about ARG_MAX; cap content at 96 KB. */
const MAX_CONTENT_BYTES = 96 * 1024;

// ── Helpers ────────────────────────────────────────────────────

function throttleErr(stderr: string): boolean {
  const kw = ["throttle", "rate limit", "capacity", "busy"];
  return kw.some((k) => stderr.toLowerCase().includes(k));
}

/** Wrap body content with minimal YAML frontmatter (gbrain --content requires it). */
function wrapFrontmatter(entry: GbrainWriteOutput): string {
  const tags = entry.tags.map((t) => JSON.stringify(t)).join(", ");
  const lines = [
    "---",
    `title: ${JSON.stringify(entry.title)}`,
    `tags: [${tags}]`,
  ];
  if (entry.related && entry.related.length > 0) {
    const related = entry.related.map((r) => JSON.stringify(r)).join(", ");
    lines.push(`related: [${related}]`);
  }
  return [
    ...lines,
    "---",
    "",
    entry.content,
  ].join("\n");
}

// ── Retry ──────────────────────────────────────────────────────

/**
 * Callback for regenerating a gbrain entry (e.g. translating to English).
 * Called when first write fails and content is predominantly non-Latin.
 */
export type GbrainTranslateFn = (
  entry: GbrainWriteOutput,
  attempt: number,
) => Promise<GbrainWriteOutput | null>;

/**
 * Write to gbrain with retry logic.
 *
 * Strategy:
 *   Attempt 1: write original entry
 *   If failed + non-Latin content + translateFn available:
 *     Attempt 2-3: call translateFn, write translated entry (1s / 2s backoff)
 *   If failed + Latin content (or no translateFn):
 *     Attempt 2-3: retry original entry with backoff (1s / 2s)
 *
 * Returns true if any attempt succeeded.
 */
export async function writeToGbrainWithRetry(
  entry: GbrainWriteOutput,
  projectRoot: string,
  translateFn?: GbrainTranslateFn,
  maxAttempts: number = 3,
): Promise<boolean> {
  // ── Pre-write non-Latin guard ────────────────────────────
  // gbrain is an English-only knowledge base (the underlying tsvector index
  // does not handle CJK). If the entry contains non-Latin content (e.g.
  // Chinese title/body), translate it BEFORE the first write attempt.
  //
  // Hard rule: if translation FAILS, BLOCK the write. The previous policy
  // ("attempting raw write") shipped Chinese pages into gbrain, where the
  // CLI silently accepts them — the search index then returns Chinese pages
  // for English queries (or vice versa), polluting the brain bilingually
  // with no error surfaced to the user. Better to drop the page; the
  // scheduler will advance the checkpoint past the un-translatable window
  // (caller returns "processed") and future windows can re-discover the
  // insight if it's durable.
  let current = entry;
  if (translateFn && (isNonLatin(entry.title) || isNonLatin(entry.content))) {
    logLine(projectRoot, `gbrain pre-translate: non-Latin detected title="${entry.title.slice(0, 60)}"`);
    const translated = await translateFn(entry, 0);
    if (translated) {
      current = translated;
      logLine(projectRoot, `gbrain pre-translate: ok title="${translated.title.slice(0, 60)}"`);
    } else {
      // Return false so the worker (processGbrain) sees a write failure;
      // it converts that to RunResult "processed" so the checkpoint
      // advances rather than burning 5 retries on the same untranslatable
      // window.
      logLine(projectRoot, `gbrain pre-translate: failed — BLOCKING non-Latin write to advance checkpoint`);
      return false;
    }
  } else if (!translateFn && (isNonLatin(entry.title) || isNonLatin(entry.content))) {
    // No translateFn and content is non-Latin: same blocking policy.
    // Surface this in logs so the operator knows translation is unwired.
    logLine(projectRoot, `gbrain write: BLOCKED non-Latin content with no translateFn registered`);
    return false;
  }

  // Attempt 1: write (possibly already translated above)
  const firstOk = await writeToGbrain(current, projectRoot);
  if (firstOk) return true;

  // If still non-Latin and first write failed, translate on retry
  const needsTranslate =
    translateFn &&
    (isNonLatin(current.title) || isNonLatin(current.content));

  for (let attempt = 2; attempt <= maxAttempts; attempt++) {
    const delayMs = 1000 * (attempt - 1);
    await sleep(delayMs);

    if (needsTranslate) {
      const translated = await translateFn(current, attempt);
      if (translated) {
        current = translated;
        logLine(projectRoot, `gbrain retry:translated attempt=${attempt} slug=${sanitizeSlug(current.title)}`);
      } else {
        logLine(projectRoot, `gbrain retry:translate_failed attempt=${attempt}`);
        continue;
      }
    }

    const ok = await writeToGbrain(current, projectRoot);
    if (ok) {
      logLine(projectRoot, `gbrain retry:ok attempt=${attempt}`);
      return true;
    }
  }

  logLine(projectRoot, `gbrain retry:exhausted attempts=${maxAttempts}`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Public (bare) ───────────────────────────────────────────────

export async function writeToGbrain(
  entry: GbrainWriteOutput,
  projectRoot: string,
): Promise<boolean> {
  // UPDATE mode: writer chose to overwrite a specific existing slug.
  // Honor it verbatim so gbrain put's upsert semantics overwrite the existing
  // page in place (preserving identity and inbound graph links).
  // NEW mode: derive slug from title.
  const slug = entry.updateSlug || sanitizeSlug(entry.title);
  if (!slug) {
    logLine(projectRoot, `gbrain write:skip slug=empty title="${entry.title.slice(0, 80)}"`);
    return false;
  }

  const fullContent = wrapFrontmatter(entry);
  const contentBytes = Buffer.byteLength(fullContent, "utf8");

  // Guard against ARG_MAX on platforms with low limits.
  if (contentBytes > MAX_CONTENT_BYTES) {
    logLine(projectRoot, `gbrain write:skip slug=${slug} reason=content_too_large bytes=${contentBytes}`);
    return false;
  }

  const args = [
    "put", slug,
    "--title", entry.title,
    "--tags", entry.tags.join(","),
    "--content", fullContent,
  ];

  return new Promise((resolve) => {
    const [cmd, lead] = gbrainCommand();
    const child = spawn(cmd, [...lead, ...args], {
      cwd: path.join(os.homedir(), "gbrain"),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let resolved = false;
    const done = (ok: boolean, logMsg: string) => {
      if (resolved) return;
      resolved = true;
      logLine(projectRoot, logMsg);
      resolve(ok);
    };

    const timer = setTimeout(() => {
      child.kill();
      done(false, `gbrain write:timeout slug=${slug}`);
    }, 60_000);

    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.stdout.on("data", () => {});

    child.on("error", (e) => {
      clearTimeout(timer);
      done(false, `gbrain write:error slug=${slug} ${e.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        done(true, `gbrain write:ok slug=${slug}`);
      } else if (throttleErr(stderr)) {
        done(true, `gbrain write:throttle slug=${slug} → deferred`);
      } else {
        done(false, `gbrain write:fail slug=${slug} code=${code} ${stderr.slice(0, 200)}`);
      }
    });
  });
}

// ── gbrain search ───────────────────────────────────────────────

/** Extract keywords for gbrain search from the summary. */
function extractKeywords(summary: string): string {
  // Take meaningful words, skip common stop words and punctuation
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "to", "of", "in", "for", "on", "with", "at", "by", "from",
    "as", "into", "through", "during", "before", "after", "and",
    "but", "or", "not", "no", "this", "that", "it", "its",
  ]);
  const words = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  // Take up to 5 most distinctive words
  return words.slice(0, 5).join(" ");
}

/**
 * Search gbrain for pages related to the insight summary.
 * Used to provide the writer LLM with existing pages and frontmatter related links.
 */
export async function searchGbrainForLinks(
  summary: string,
  projectRoot: string,
): Promise<GbrainSearchResult[]> {
  const query = extractKeywords(summary);
  if (!query) return [];

  try {
    const [cmd, lead] = gbrainCommand();
    const { stdout } = await execFileP(
      cmd,
      [...lead, "search", query, "--limit", "5"],
      {
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        cwd: path.join(os.homedir(), "gbrain"),
      },
    );
    if (!stdout) return [];

    // Parse gbrain search output: "[score] slug -- title...". Search snippets
    // often begin with a markdown H1 ("# Title"); store a clean title so the
    // writer doesn't put "# ..." into related frontmatter.
    const results: GbrainSearchResult[] = [];
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      // Format: [0.1234] slug-name -- Title: description text
      const match = line.match(/^\[?[\d.]+\]?\s+(\S+)\s+--\s+(.+)$/);
      if (match) {
        const rawTitle = match[2]
          .split("\n")[0]
          .replace(/^#+\s*/, "")
          .trim();
        const title = rawTitle || match[1];
        results.push({
          slug: match[1],
          title: title.slice(0, 120),
          snippet: match[2].slice(0, 200),
        });
      }
    }

    return results.filter((r) => r.slug).slice(0, 5);
  } catch {
    // gbrain search unavailable → no related pages
    return [];
  }
}
