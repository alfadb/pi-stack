/**
 * pi-sediment lookup tools — read-only knowledge probes for the agent loop.
 *
 * The sediment agent (evaluator/writer combined) uses these tools to inspect
 * what's already in Pensieve and gbrain BEFORE deciding to write. All tools
 * are pure reads — no mutation, no shell escape, no network beyond gbrain
 * CLI itself. The agent decides freely how many times to call them; we
 * only enforce a per-call timeout and a global tool-loop budget.
 *
 * Tools exposed:
 *   - gbrain_search(query, limit?)     → list of {slug, title, snippet}
 *   - gbrain_get(slug)                 → full markdown body of a page
 *   - pensieve_grep(pattern, path?)    → ripgrep-style hits in .pensieve/
 *   - pensieve_read(relPath)           → file body within .pensieve/
 *   - pensieve_list(subdir?)           → list of .md files under .pensieve/<subdir>
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "@mariozechner/pi-ai";
import { gbrainCommand } from "./utils.js";

const execFileP = promisify(execFile);

// ── Bounds ─────────────────────────────────────────────────────

const PER_CALL_TIMEOUT_MS = 15_000;
const MAX_GREP_HITS = 80;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_LIST_ENTRIES = 300;

// ── Path safety ────────────────────────────────────────────────

/**
 * Resolve a user-supplied relative path against `<projectRoot>/.pensieve`,
 * rejecting any escape outside that subtree. Returns an absolute path or
 * null if the input tries to break out (../, absolute paths, symlink games).
 *
 * TOCTOU symlink defense
 * ----------------------
 * The lexical check (path.resolve + prefix-string compare) is necessary but
 * not sufficient: a symlink at .pensieve/evil.md → /etc/passwd would pass
 * the prefix check but fs.readFileSync(abs) would follow it and ship
 * arbitrary file contents back to the LLM. A prompt-injected sediment agent
 * is a real threat model here — it controls the relPath argument to
 * pensieve_read / pensieve_grep.
 *
 * Defense: realpath both root and resolved path, then prefix-check. We use
 * sync realpath rather than the async variant because this is on the
 * synchronous tool-handler hot path; the cost is one stat per call.
 * Missing files are still allowed (we only fail if a *resolved* path
 * escapes); creating a non-symlink file inside .pensieve/ never escapes,
 * and a non-existent path simply won't be readable by the caller anyway.
 */
function resolvePensievePath(projectRoot: string, relPath: string): string | null {
  if (typeof relPath !== "string") return null;
  const rootRaw = path.resolve(projectRoot, ".pensieve");
  const trimmed = relPath.trim();
  // Empty / "." / "./" / ".pensieve" all mean "the .pensieve root itself".
  // Returning null on empty was the original behavior, but the agent often
  // omits the path arg when it wants to scope to all of .pensieve/, and a
  // null here surfaces as a confusing 'path escapes' error.
  if (!trimmed || trimmed === "." || trimmed === "./" || trimmed === ".pensieve" || trimmed === "./pensieve") {
    return rootRaw;
  }
  // Reject absolute paths up front (security) so they don't get resolved
  // anywhere relative to root and accidentally pass the prefix check.
  if (path.isAbsolute(trimmed)) return null;
  // Strip leading ".pensieve/" since the tool surface is rooted there.
  const cleaned = trimmed.replace(/^\.?pensieve[/\\]/, "");
  const absRaw = path.resolve(rootRaw, cleaned);

  // realpath both sides. If the path doesn't exist yet, realpath throws
  // ENOENT — fall back to the lexical resolution (a non-existent path
  // can't be a symlink to a secret). If realpath succeeds, use the
  // resolved real paths for containment so symlink-out is caught.
  let root: string;
  let abs: string;
  try { root = fs.realpathSync(rootRaw); } catch { root = rootRaw; }
  try { abs = fs.realpathSync(absRaw); } catch { abs = absRaw; }

  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

// ── Schemas ────────────────────────────────────────────────────

const gbrainSearchSchema = Type.Object({
  query: Type.String({ description: "Free-text search query (semantic + keyword)." }),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default 5, max 20)." })),
});

const gbrainGetSchema = Type.Object({
  slug: Type.String({ description: "gbrain page slug (lowercase-hyphenated)." }),
});

const pensieveGrepSchema = Type.Object({
  pattern: Type.String({ description: "Pattern (regex by default; pass literal=true to disable regex)." }),
  path: Type.Optional(Type.String({ description: "Subpath under .pensieve/ to scope search; default = whole .pensieve/. Pass empty/omit for whole tree." })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string (default false)." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive (default true)." })),
  limit: Type.Optional(Type.Number({ description: "Max matches to return (default 80, max 200)." })),
});

const pensieveReadSchema = Type.Object({
  relPath: Type.String({ description: "Path relative to .pensieve/ (e.g. 'short-term/decisions/2026-05-04-foo.md')." }),
});

const pensieveListSchema = Type.Object({
  subdir: Type.Optional(Type.String({ description: "Subdir under .pensieve/ to list (default: list all of short-term/* and long-term layers)." })),
});

// ── Tool execution ─────────────────────────────────────────────

export type ToolHandler = (args: any) => Promise<{ text: string; isError: boolean }>;

function ok(text: string): { text: string; isError: boolean } { return { text, isError: false }; }
function err(text: string): { text: string; isError: boolean } { return { text, isError: true }; }

async function runGbrainSearch(args: Static<typeof gbrainSearchSchema>): Promise<{ text: string; isError: boolean }> {
  const query = String(args.query ?? "").slice(0, 500);
  if (!query) return err("query is required");
  const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
  try {
    const [cmd, lead] = gbrainCommand();
    const { stdout } = await execFileP(cmd, [...lead, "search", query, "--limit", String(limit)], {
      timeout: PER_CALL_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    const text = (stdout ?? "").trim();
    return ok(text || "(no results)");
  } catch (e: any) {
    return err(`gbrain search failed: ${e?.message ?? String(e)}`);
  }
}

async function runGbrainGet(args: Static<typeof gbrainGetSchema>): Promise<{ text: string; isError: boolean }> {
  const slug = String(args.slug ?? "").trim();
  if (!slug) return err("slug is required");
  if (!/^[a-z0-9-]+$/.test(slug)) return err(`invalid slug shape: ${slug}`);
  try {
    const [cmd, lead] = gbrainCommand();
    const { stdout } = await execFileP(cmd, [...lead, "get", slug], {
      timeout: PER_CALL_TIMEOUT_MS,
      maxBuffer: 512 * 1024,
    });
    const body = (stdout ?? "").trim();
    if (!body) return ok(`(page '${slug}' not found or empty)`);
    if (body.length > MAX_FILE_BYTES) {
      return ok(body.slice(0, MAX_FILE_BYTES) + "\n[...truncated...]");
    }
    return ok(body);
  } catch (e: any) {
    return err(`gbrain get failed: ${e?.message ?? String(e)}`);
  }
}

async function runPensieveGrep(
  projectRoot: string,
  args: Static<typeof pensieveGrepSchema>,
): Promise<{ text: string; isError: boolean }> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return err("pattern is required");
  const literal = args.literal === true;
  const ignoreCase = args.ignoreCase !== false; // default true
  const subpath = typeof args.path === "string" ? args.path : "";
  const limit = Math.max(1, Math.min(200, Number(args.limit ?? MAX_GREP_HITS)));
  const root = resolvePensievePath(projectRoot, subpath);
  if (!root) return err("path escapes .pensieve/ (forbidden)");
  if (!fs.existsSync(root)) return err(`path does not exist: ${subpath || ".pensieve/"}`);

  // Use grep -r so we don't depend on rg being installed; restrict to .md files.
  const grepArgs = ["-r", "-n", "--include=*.md"];
  if (ignoreCase) grepArgs.push("-i");
  if (literal) grepArgs.push("-F");
  else grepArgs.push("-E");
  grepArgs.push("--", pattern, root);

  try {
    const { stdout } = await execFileP("grep", grepArgs, {
      timeout: PER_CALL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const lines = (stdout ?? "").split("\n").filter(Boolean);
    if (lines.length === 0) return ok("(no matches)");
    const truncated = lines.slice(0, limit);
    // Make paths relative for readability.
    const rel = truncated.map((l) => l.replace(projectRoot + path.sep, ""));
    const more = lines.length > limit ? `\n[+${lines.length - limit} more matches truncated]` : "";
    return ok(rel.join("\n") + more);
  } catch (e: any) {
    // grep exits 1 when no matches — that's not an error from the agent's POV.
    if (e?.code === 1) return ok("(no matches)");
    return err(`grep failed: ${e?.message ?? String(e)}`);
  }
}

async function runPensieveRead(
  projectRoot: string,
  args: Static<typeof pensieveReadSchema>,
): Promise<{ text: string; isError: boolean }> {
  const abs = resolvePensievePath(projectRoot, String(args.relPath ?? ""));
  if (!abs) return err("relPath escapes .pensieve/ (forbidden)");
  if (!fs.existsSync(abs)) return err(`file not found: ${args.relPath}`);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return err(`not a file: ${args.relPath}`);
    let body = fs.readFileSync(abs, "utf8");
    if (body.length > MAX_FILE_BYTES) {
      body = body.slice(0, MAX_FILE_BYTES) + "\n[...truncated...]";
    }
    return ok(body);
  } catch (e: any) {
    return err(`read failed: ${e?.message ?? String(e)}`);
  }
}

async function runPensieveList(
  projectRoot: string,
  args: Static<typeof pensieveListSchema>,
): Promise<{ text: string; isError: boolean }> {
  const subdir = typeof args.subdir === "string" ? args.subdir : "";
  const root = resolvePensievePath(projectRoot, subdir);
  if (!root) return err("subdir escapes .pensieve/ (forbidden)");
  if (!fs.existsSync(root)) return ok("(no entries)");

  const out: string[] = [];
  function walk(dir: string): void {
    if (out.length >= MAX_LIST_ENTRIES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(path.relative(path.join(projectRoot, ".pensieve"), full));
      }
    }
  }
  walk(root);
  if (out.length === 0) return ok("(no entries)");
  return ok(out.join("\n"));
}

// ── Public: build tool set bound to projectRoot ────────────────

/**
 * Build the set of read-only lookup tools, bound to a project root for
 * Pensieve scope. The returned (tools, handlers) pair plugs into the
 * agent-loop runner.
 */
export function buildLookupTools(projectRoot: string): {
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Tool[] = [
    {
      name: "gbrain_search",
      description:
        "Search the gbrain cross-project knowledge base by free-text query. " +
        "Returns up to N matching pages as 'score slug -- title: snippet' lines. " +
        "Use this BEFORE deciding to write a new gbrain page so you can find " +
        "and update existing pages on the same topic instead of duplicating.",
      parameters: gbrainSearchSchema as any,
    },
    {
      name: "gbrain_get",
      description:
        "Fetch the full markdown body (including frontmatter and timeline) of a " +
        "gbrain page by slug. Use after gbrain_search to read promising candidates " +
        "in detail before deciding skip/update/new.",
      parameters: gbrainGetSchema as any,
    },
    {
      name: "pensieve_grep",
      description:
        "Search the project's .pensieve/ knowledge base (decisions, knowledge, " +
        "maxims, pipelines, short-term) for a regex (or literal) pattern across " +
        "all .md files. Returns 'relPath:line:match' hits. Use this to find " +
        "existing project-specific entries that may already cover the new insight.",
      parameters: pensieveGrepSchema as any,
    },
    {
      name: "pensieve_read",
      description:
        "Read a single .md file under .pensieve/ by relative path " +
        "(e.g. 'short-term/decisions/2026-05-04-foo.md'). Use after pensieve_grep " +
        "to inspect the full body of a candidate before deciding skip/update/new.",
      parameters: pensieveReadSchema as any,
    },
    {
      name: "pensieve_list",
      description:
        "List .md files under a subdirectory of .pensieve/ (e.g. 'short-term/decisions' " +
        "or 'maxims'). Useful when grep yields nothing but you want to scan recent " +
        "entries by name. Default lists the entire .pensieve/.",
      parameters: pensieveListSchema as any,
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    gbrain_search: (a) => runGbrainSearch(a),
    gbrain_get: (a) => runGbrainGet(a),
    pensieve_grep: (a) => runPensieveGrep(projectRoot, a),
    pensieve_read: (a) => runPensieveRead(projectRoot, a),
    pensieve_list: (a) => runPensieveList(projectRoot, a),
  };

  return { tools, handlers };
}
