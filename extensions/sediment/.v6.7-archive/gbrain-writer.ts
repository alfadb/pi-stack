/**
 * gbrain-writer — spawn gbrain CLI for put/get/export operations.
 *
 * Part of pi-stack Slice D (ADR 0004).
 *
 * Uses the same launcher resolution as extensions/gbrain/index.ts:
 * resolves bun + gbrain cli.ts, spawns with appropriate args.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Launcher resolution (mirrors extensions/gbrain/index.ts) ───

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

// ── spawn helper ────────────────────────────────────────────────

function runGbrain(
  args: string[],
  opts?: { stdin?: string; timeout?: number; source?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const wantsStdin = typeof opts?.stdin === "string" && opts.stdin.length > 0;
    const stdinSpec: "pipe" | "ignore" = wantsStdin ? "pipe" : "ignore";

    // gbrain put/get/delete don't have a --source flag (it's not in put's
    // option list). Source routing goes through GBRAIN_SOURCE env var,
    // which gbrain's source-resolver picks up as priority 2 (after the
    // global --source flag, which only sync/extract/reindex-code parse).
    // Setting --source as a put argv silently no-ops and falls back to
    // dotfile / default — see
    // gbrain-cli-silently-drops-invalid-source-on-put-writing-to-default-instead
    const env = { ...process.env };
    if (opts?.source) env.GBRAIN_SOURCE = opts.source;

    const child = spawn(LAUNCHER.cmd, [...LAUNCHER.prefix, ...args], {
      cwd: GBRAIN_CWD,
      stdio: [stdinSpec, "pipe", "pipe"],
      timeout: opts?.timeout ?? 30000,
      env,
    });

    let stdout = "";
    let stderr = "";
    const MAX_BUF = 10 * 1024 * 1024;
    let buffered = true;

    child.stdout?.on("data", (d: Buffer) => {
      if (!buffered) return;
      if (stdout.length + d.length > MAX_BUF) {
        buffered = false;
        child.kill("SIGTERM");
        return;
      }
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (!buffered) return;
      if (stderr.length + d.length > MAX_BUF) {
        buffered = false;
        child.kill("SIGTERM");
        return;
      }
      stderr += d.toString("utf8");
    });

    if (wantsStdin && child.stdin) {
      child.stdin.write(opts!.stdin!);
      child.stdin.end();
    }

    child.on("error", (e: any) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: typeof e?.code === "number" ? e.code : 1 }),
    );
    child.on("close", (code) =>
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 }),
    );
  });
}

// ── operations ──────────────────────────────────────────────────

export interface GbrainPage {
  title: string;
  slug: string;
  content: string;
  tags: string[];
  tier: string;
  confidence: number;
  evidence_source: string;
  scope: string;
  status: string;
}

/**
 * Write a page to gbrain.
 */
export async function gbrainPut(
  source: string,
  page: GbrainPage,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // Build frontmatter as YAML-like content
    const fullContent = [
      "---",
      `title: "${page.title.replace(/"/g, '\\"')}"`,
      `tags: [${page.tags.join(", ")}]`,
      `tier: ${page.tier}`,
      `confidence: ${page.confidence}`,
      `evidence_source: ${page.evidence_source}`,
      `scope: ${page.scope}`,
      `status: ${page.status}`,
      "---",
      "",
      page.content,
    ].join("\n");

    const r = await runGbrain(
      ["put", page.slug, "--title", page.title, "--tags", page.tags.join(",")],
      { stdin: fullContent, timeout: 30000, source },
    );

    return { ok: r.exitCode === 0, error: r.exitCode !== 0 ? r.stderr : undefined };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Read a page from gbrain for readback verification.
 */
export async function gbrainGet(
  source: string,
  slug: string,
): Promise<{ ok: boolean; page?: Record<string, any>; error?: string }> {
  try {
    const r = await runGbrain(["get", slug], { timeout: 15000, source });

    if (r.exitCode !== 0 || !r.stdout) {
      return { ok: false, error: r.stderr || "Page not found" };
    }

    // gbrain get returns YAML frontmatter + markdown body; extract frontmatter
    const fmMatch = r.stdout.match(/^---\n([\s\S]*?)\n---/);
    const page: Record<string, any> = { raw: r.stdout };
    if (fmMatch) {
      for (const line of fmMatch[1].split("\n")) {
        const kv = line.match(/^(\w+):\s*(.+)$/);
        if (kv) {
          const key = kv[1];
          let val: any = kv[2].trim();
          // Parse list values: [a, b, c]
          if (val.startsWith("[") && val.endsWith("]")) {
            val = val.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^"|"$/g, ""));
          }
          page[key] = val;
        }
      }
    }
    return { ok: true, page };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Delete a page from gbrain (rollback on readback failure).
 */
export async function gbrainDelete(
  source: string,
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await runGbrain(["delete", slug], { timeout: 15000, source });
    return { ok: r.exitCode === 0, error: r.exitCode !== 0 ? r.stderr : undefined };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Export pages to markdown cache for offline fallback.
 */
export async function gbrainExport(
  source: string,
): Promise<{ ok: boolean; pageCount: number; error?: string }> {
  try {
    const r = await runGbrain(
      ["export", "--format", "markdown"],
      { timeout: 120_000, source },
    );

    if (r.exitCode !== 0) {
      return { ok: false, pageCount: 0, error: r.stderr };
    }

    // Count exported pages from stdout
    const pageCount = (r.stdout.match(/\n/g)?.length ?? 0) + 1;
    return { ok: true, pageCount: Math.max(1, pageCount) };
  } catch (e: any) {
    return { ok: false, pageCount: 0, error: e.message };
  }
}
