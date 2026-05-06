/**
 * gbrain extension for pi-stack — READ-ONLY brain access with write guard.
 *
 * Part of pi-stack Slice A (ADR 0003): the main session reads gbrain but
 * never writes. All writes go through sediment (ADR 0004).
 *
 * Tools (read-only):
 *   gbrain_search  — keyword search across brain pages
 *   gbrain_get     — fetch a specific page by slug
 *   gbrain_query   — hybrid semantic + keyword + graph search
 *
 * Guards (active enforcement, ADR 0003):
 *   Guard 1 — blocks bash commands that call gbrain write CLI
 *   Guard 2 — blocks write/edit/bash to protected memory paths
 *
 * Offline fallback (ADR 0007):
 *   When gbrain CLI is unavailable, falls back to reading from
 *   ~/.pi/.gbrain-cache/markdown/pi-stack/ with `_degraded: true`.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { checkBashCommand } from "./guard-bash";
import { checkPathEvent } from "./guard-path";
import { searchMarkdown, getMarkdownPage, queryMarkdown } from "./markdown-fallback";

// ── gbrain launcher ────────────────────────────────────────────

const GBRAIN_BIN = join(homedir(), ".bun", "bin", "gbrain");
const GBRAIN_CWD = join(homedir(), "gbrain");
const BUN_BIN = join(homedir(), ".bun", "bin", "bun");

function resolveLauncher(): { cmd: string; prefix: string[] } {
  try {
    if (existsSync(BUN_BIN) && existsSync(GBRAIN_BIN)) {
      const real = realpathSync(GBRAIN_BIN);
      return { cmd: BUN_BIN, prefix: ["run", real] };
    }
  } catch { /* fall through */ }
  return { cmd: GBRAIN_BIN, prefix: [] };
}
const LAUNCHER = resolveLauncher();

function runGbrain(
  args: string[],
  opts?: { stdin?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const wantsStdin = typeof opts?.stdin === "string" && opts.stdin.length > 0;
    const stdinSpec: "pipe" | "ignore" = wantsStdin ? "pipe" : "ignore";

    const child = spawn(LAUNCHER.cmd, [...LAUNCHER.prefix, ...args], {
      cwd: GBRAIN_CWD,
      stdio: [stdinSpec, "pipe", "pipe"],
      timeout: opts?.timeout ?? 10000,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const MAX_BUF = 10 * 1024 * 1024;
    let buffered = true;

    child.stdout?.on("data", (d: Buffer) => {
      if (!buffered) return;
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_BUF) { buffered = false; child.kill("SIGTERM"); return; }
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (!buffered) return;
      stderrBytes += d.length;
      if (stderrBytes > MAX_BUF) { buffered = false; child.kill("SIGTERM"); return; }
      stderr += d.toString("utf8");
    });

    if (wantsStdin && child.stdin) {
      child.stdin.write(opts!.stdin!);
      child.stdin.end();
    }

    child.on("error", (e: any) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: typeof e?.code === "number" ? e.code : 1 }));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 }));
  });
}

let gbrainAvailable: boolean | null = null;
async function isGbrainAvailable(): Promise<boolean> {
  if (gbrainAvailable !== null) return gbrainAvailable;
  try {
    const r = await runGbrain(["doctor", "--json"], { timeout: 5000 });
    gbrainAvailable = r.exitCode === 0;
  } catch {
    gbrainAvailable = false;
  }
  return gbrainAvailable;
}

// ── extension ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════
  // Guard 1: block gbrain write CLI via bash
  // ═══════════════════════════════════════════════════════════════
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "bash") {
      const command = String((event.input as any)?.command ?? "");
      const result = checkBashCommand(command);
      if (result.blocked) {
        return { block: true, reason: result.reason };
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Guard 2: block writes to protected memory paths
  // ═══════════════════════════════════════════════════════════════
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "bash") {
      const result = checkPathEvent(event);
      if (result.blocked) {
        return { block: true, reason: result.reason };
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // gbrain_search — keyword search with markdown fallback
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gbrain_search",
    label: "GBrain Search",
    description:
      "Search your personal brain for relevant context. " +
      "Use BEFORE any external API call or when you need background knowledge. " +
      "Returns scored matches with page slugs and content snippets. " +
      "Use 2-4 specific English keywords for best results (brain content is English-only).",
    promptSnippet: "Search brain pages: gbrain_search(query)",
    promptGuidelines: [
      "Use gbrain_search to check the brain for relevant context before calling external APIs.",
      "Provide 2-4 specific keywords, not full sentences.",
      "Always use English keywords — brain content is stored in English.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "2-4 search keywords (e.g. 'auth middleware N+1')",
      }),
    }),
    async execute(_id, params) {
      const available = await isGbrainAvailable();

      if (!available) {
        // Markdown fallback
        const { results, degraded } = searchMarkdown("pi-stack", params.query);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "(no results — gbrain unavailable, markdown cache empty)" }],
            details: { degraded },
          };
        }
        const text = results
          .map((r) => `**${r.title}** (${r.slug})\n${r.snippet}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `⚠️ Offline mode (markdown cache, may be stale)\n\n${text}` }],
          details: { degraded, resultCount: results.length },
        };
      }

      const r = await runGbrain(["search", params.query]);
      if (r.exitCode !== 0 && !r.stdout) {
        // CLI failed — try fallback
        const { results, degraded } = searchMarkdown("pi-stack", params.query);
        if (results.length > 0) {
          const text = results.map((r) => `**${r.title}** (${r.slug})\n${r.snippet}`).join("\n\n");
          return {
            content: [{ type: "text", text: `⚠️ gbrain error, using markdown cache\n\n${text}` }],
            details: { degraded, gbrainError: r.stderr, resultCount: results.length },
          };
        }
        return {
          content: [{ type: "text", text: `gbrain search failed: ${r.stderr || "unknown error"}` }],
          details: { exitCode: r.exitCode },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: r.stdout || "(no results)" }],
        details: { exitCode: r.exitCode },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // gbrain_get — fetch a specific page with markdown fallback
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gbrain_get",
    label: "GBrain Get Page",
    description:
      "Fetch a specific brain page by slug for full context. " +
      "Use after gbrain_search to read matching pages in detail.",
    promptSnippet: "Read brain page: gbrain_get(slug)",
    promptGuidelines: [
      "Use gbrain_get to read full pages found by gbrain_search.",
      "Read the top 3 matching pages before synthesizing an answer.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "Page slug from gbrain_search results" }),
    }),
    async execute(_id, params) {
      const available = await isGbrainAvailable();

      if (!available) {
        const { content, degraded } = getMarkdownPage("pi-stack", params.slug);
        if (!content) {
          return {
            content: [{ type: "text", text: `Page "${params.slug}" not found in markdown cache.` }],
            details: { degraded },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `⚠️ From markdown cache (may be stale)\n\n${content}` }],
          details: { degraded },
        };
      }

      const r = await runGbrain(["get", params.slug]);
      if (r.exitCode !== 0 && !r.stdout) {
        // Try fallback
        const { content, degraded } = getMarkdownPage("pi-stack", params.slug);
        if (content) {
          return {
            content: [{ type: "text", text: `⚠️ gbrain error, from markdown cache\n\n${content}` }],
            details: { degraded },
          };
        }
        return {
          content: [{ type: "text", text: `Page "${params.slug}" not found.` }],
          details: { exitCode: r.exitCode },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: r.stdout }],
        details: { exitCode: r.exitCode },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // gbrain_query — deep query with markdown fallback
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "gbrain_query",
    label: "GBrain Query",
    description:
      "Hybrid semantic + keyword + graph search for complex questions. " +
      "Slower but deeper than gbrain_search. " +
      'Use for questions like "what patterns do I use for auth?" or "who worked on this module?". ' +
      "Ask in English for best results — brain content is English-only.",
    promptSnippet: "Deep brain query: gbrain_query(question)",
    promptGuidelines: [
      "Use gbrain_query for open-ended or conceptual questions, not keyword lookups.",
      "gbrain_search is faster; prefer it for known entities or specific terms.",
      "Always ask in English — brain content is stored in English.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Natural language question" }),
    }),
    async execute(_id, params) {
      const available = await isGbrainAvailable();

      if (!available) {
        const { results, degraded } = queryMarkdown("pi-stack", params.question);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "(no results — gbrain unavailable, markdown cache empty)" }],
            details: { degraded },
          };
        }
        const text = results
          .map((r) => `**${r.title}** (${r.slug})\n${r.snippet}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text: `⚠️ Offline mode (markdown cache)\n\n${text}` }],
          details: { degraded, resultCount: results.length },
        };
      }

      const r = await runGbrain(["query", params.question], { timeout: 15000 });
      if (r.exitCode !== 0 && !r.stdout) {
        const { results, degraded } = queryMarkdown("pi-stack", params.question);
        if (results.length > 0) {
          const text = results.map((r) => `**${r.title}** (${r.slug})\n${r.snippet}`).join("\n\n");
          return {
            content: [{ type: "text", text: `⚠️ gbrain error, using markdown cache\n\n${text}` }],
            details: { degraded, gbrainError: r.stderr },
          };
        }
        return {
          content: [{ type: "text", text: `gbrain query failed: ${r.stderr || "unknown error"}` }],
          details: { exitCode: r.exitCode },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: r.stdout || "(no results)" }],
        details: { exitCode: r.exitCode },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // Health status in footer (cached 60s)
  // ═══════════════════════════════════════════════════════════════
  const STATUS_TTL_MS = 60_000;
  let lastScore = "?";
  let lastStatusFetchAt = 0;

  const updateStatus = async (ctx: any, opts?: { force?: boolean }) => {
    const now = Date.now();
    const cacheValid = !opts?.force && now - lastStatusFetchAt < STATUS_TTL_MS;
    if (cacheValid) {
      ctx.ui.setStatus("gbrain", `🧠 gb:${lastScore}`);
      return;
    }
    try {
      const r = await runGbrain(["doctor", "--json"], { timeout: 15000 });
      if (r.exitCode === 0 && r.stdout) {
        const doc = JSON.parse(r.stdout) as { status?: string; health_score?: number };
        lastScore = doc.health_score != null ? String(doc.health_score) : (doc.status ?? "?");
      }
      if (r.exitCode === 0) lastStatusFetchAt = now;
      ctx.ui.setStatus("gbrain", `🧠 gb:${lastScore}`);
    } catch {
      ctx.ui.setStatus("gbrain", `🧠 gb:${lastScore}`);
    }
  };

  pi.on("session_start", async (_event, ctx) => { await updateStatus(ctx, { force: true }); });
  pi.on("before_agent_start", async (_event, ctx) => { await updateStatus(ctx); });
}
