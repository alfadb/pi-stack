/**
 * sediment/lookup-tools — read-only knowledge probes for the sediment agent.
 *
 * The sediment agent uses these tools to inspect what's already in gbrain
 * BEFORE deciding to write. All tools are pure reads — no mutation, no
 * shell escape, no network beyond the gbrain CLI itself. The agent
 * decides freely how many times to call them; we enforce a per-call
 * timeout only.
 *
 * Tools exposed:
 *   - gbrain_search(query, limit?)   → list of {slug, title, snippet}
 *   - gbrain_get(slug)               → full markdown body of a page
 *
 * Pensieve tools removed — pensieve is being deprecated (ADR 0005).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import type { Tool } from "@mariozechner/pi-ai";

const execFileP = promisify(execFile);

const PER_CALL_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 32 * 1024;

// Mirror gbrain-writer.ts launch convention (bun run cli.ts in ~/gbrain)
function gbrainCommand(): { cmd: string; args: string[]; cwd: string } {
  const home = process.env.HOME ?? "/tmp";
  return {
    cmd: "bun",
    args: ["run", `${home}/gbrain/src/cli.ts`],
    cwd: `${home}/gbrain`,
  };
}

// ── Schemas ────────────────────────────────────────────────────

const gbrainSearchSchema = Type.Object({
  query: Type.String({ description: "Free-text search query (semantic + keyword). Use 2-4 specific keywords." }),
  limit: Type.Optional(Type.Number({ description: "Max results (default 5, max 20)." })),
});

const gbrainGetSchema = Type.Object({
  slug: Type.String({ description: "gbrain page slug (lowercase-hyphenated)." }),
});

// ── Handlers ───────────────────────────────────────────────────

export type ToolHandler = (args: any) => Promise<{ text: string; isError: boolean }>;
const ok = (text: string) => ({ text, isError: false });
const err = (text: string) => ({ text, isError: true });

async function runGbrainSearch(args: Static<typeof gbrainSearchSchema>) {
  const query = String(args.query ?? "").slice(0, 500);
  if (!query) return err("query is required");
  const limit = Math.max(1, Math.min(20, Number(args.limit ?? 5)));
  try {
    const { cmd, args: lead, cwd } = gbrainCommand();
    const { stdout } = await execFileP(
      cmd,
      [...lead, "search", query, "--limit", String(limit)],
      { timeout: PER_CALL_TIMEOUT_MS, maxBuffer: 256 * 1024, cwd },
    );
    const text = (stdout ?? "").trim();
    return ok(text || "(no results)");
  } catch (e: any) {
    return err(`gbrain search failed: ${e?.message ?? String(e)}`);
  }
}

async function runGbrainGet(args: Static<typeof gbrainGetSchema>) {
  const slug = String(args.slug ?? "").trim();
  if (!slug) return err("slug is required");
  if (!/^[a-z0-9-]+$/.test(slug)) return err(`invalid slug shape: ${slug}`);
  try {
    const { cmd, args: lead, cwd } = gbrainCommand();
    const { stdout } = await execFileP(
      cmd,
      [...lead, "get", slug],
      { timeout: PER_CALL_TIMEOUT_MS, maxBuffer: 512 * 1024, cwd },
    );
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

// ── Tool definitions ───────────────────────────────────────────

export function buildLookupTools(): { tools: Tool[]; handlers: Record<string, ToolHandler> } {
  const tools: Tool[] = [
    {
      label: "gbrain_search",
      name: "gbrain_search",
      description:
        "Search the gbrain knowledge base (cross-project engineering principles). " +
        "Use this BEFORE deciding to write a new page — if a similar page exists, " +
        "prefer SKIP_DUPLICATE or update the existing slug. Returns matching slugs " +
        "with snippets.",
      parameters: gbrainSearchSchema,
    } as any,
    {
      label: "gbrain_get",
      name: "gbrain_get",
      description:
        "Fetch the full body of a gbrain page by slug. Use after gbrain_search " +
        "to inspect a candidate page in detail before deciding update vs new.",
      parameters: gbrainGetSchema,
    } as any,
  ];

  const handlers: Record<string, ToolHandler> = {
    gbrain_search: runGbrainSearch,
    gbrain_get: runGbrainGet,
  };

  return { tools, handlers };
}
