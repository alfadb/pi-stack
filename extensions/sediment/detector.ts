/**
 * pi-sediment detector — auto-detect available targets.
 *
 * Pensieve:  .pensieve/ dir exists in project root → true
 * gbrain:    `gbrain doctor --json` exits 0 → true
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TargetStatus } from "./types.js";
import { gbrainCommand } from "./utils.js";

const execFileP = promisify(execFile);

// ── Pensieve detection ─────────────────────────────────────────

function detectPensieve(projectRoot: string): boolean {
  const dir = path.join(projectRoot, ".pensieve");
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// ── gbrain detection ───────────────────────────────────────────

interface GbrainDoctor {
  schema_version?: number;
  status?: string;
  health_score?: number;
  page_count?: number;
  checks?: Array<{ name?: string; status?: string; message?: string }>;
}

/**
 * Schema-v1 returned a top-level `page_count`. Schema-v2 (gbrain v0.25+)
 * dropped it; the count now only appears inside the connection check's
 * message text, e.g. "Connected, 68 pages". Parse both shapes so the
 * status-bar page count keeps working across upstream versions.
 */
function extractPageCount(doc: GbrainDoctor): number | null {
  if (doc.page_count != null) return Number(doc.page_count);
  const msg = doc.checks?.find((c) => c.name === "connection")?.message;
  const m = msg?.match(/(\d+)\s+pages?/);
  return m ? Number(m[1]) : null;
}

async function detectGbrain(): Promise<{ available: boolean; pageCount: number | null }> {
  try {
    const [cmd, lead] = gbrainCommand();
    const { stdout } = await execFileP(cmd, [...lead, "doctor", "--json"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      cwd: `${process.env.HOME}/gbrain`,
    });
    if (!stdout) return { available: false, pageCount: null };
    const doc = JSON.parse(stdout.trim()) as GbrainDoctor;
    return { available: true, pageCount: extractPageCount(doc) };
  } catch {
    return { available: false, pageCount: null };
  }
}

// ── Public ─────────────────────────────────────────────────────

export async function detectTargets(projectRoot: string): Promise<TargetStatus> {
  const pensieve = detectPensieve(projectRoot);
  const gbrain = await detectGbrain();

  return {
    pensieve,
    gbrain: gbrain.available,
    gbrainPageCount: gbrain.pageCount,
  };
}
