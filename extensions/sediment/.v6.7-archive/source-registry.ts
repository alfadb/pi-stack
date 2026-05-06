/**
 * sediment/source-registry — gbrain sources list/add wrapper.
 *
 * Auto-registration policy (Q3 decision):
 *   - first time we see source id S that isn't registered, register with
 *     `gbrain sources add S --path <rootPath> --no-federated`
 *   - emit audit log entry: { type: "source:auto_registered", id, path }
 *   - caller bumps a footer flag so the user gets a one-time toast
 *
 * federation=false is hard-coded for project-track sources. Cross-project
 * principles always live in `default` (federation=true), which is owned
 * separately and never auto-registered.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const TIMEOUT_MS = 10_000;

function gbrainCmd(): { cmd: string; args: string[]; cwd: string } {
  const home = process.env.HOME ?? "/tmp";
  return {
    cmd: "bun",
    args: ["run", `${home}/gbrain/src/cli.ts`],
    cwd: `${home}/gbrain`,
  };
}

interface SourcesListEntry {
  id: string;
  federated?: boolean;
  pageCount?: number;
}

/**
 * Returns the set of registered source ids, or null if gbrain is unavailable
 * (the caller should treat this as "can't register" and skip project-track).
 */
export async function listSources(): Promise<Set<string> | null> {
  try {
    const { cmd, args, cwd } = gbrainCmd();
    const { stdout } = await execFileP(
      cmd,
      [...args, "sources", "list", "--json"],
      { timeout: TIMEOUT_MS, maxBuffer: 256 * 1024, cwd },
    );
    const parsed = JSON.parse(stdout || "[]");
    const ids = new Set<string>();
    if (Array.isArray(parsed)) {
      for (const e of parsed as SourcesListEntry[]) {
        if (e?.id) ids.add(e.id);
      }
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).sources)) {
      for (const e of (parsed as any).sources as SourcesListEntry[]) {
        if (e?.id) ids.add(e.id);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Register a new source. federation=false is forced for project-track.
 * Returns ok with whether we actually created it (false = already existed).
 */
export async function addSource(args: {
  id: string;
  rootPath: string;
  displayName?: string;
}): Promise<{ ok: boolean; created: boolean; error?: string }> {
  try {
    const { cmd, args: lead, cwd } = gbrainCmd();
    const cliArgs = [...lead, "sources", "add", args.id, "--path", args.rootPath, "--no-federated"];
    if (args.displayName) cliArgs.push("--name", args.displayName);
    const result = await execFileP(cmd, cliArgs, {
      timeout: TIMEOUT_MS, maxBuffer: 256 * 1024, cwd,
    });
    return { ok: true, created: true };
  } catch (e: any) {
    // Distinguish "already exists" (non-fatal, treat as ok) from real errors.
    const stderr = (e?.stderr ?? e?.message ?? "").toString();
    if (/already (exists|registered)/i.test(stderr)) {
      return { ok: true, created: false };
    }
    return { ok: false, created: false, error: stderr.slice(0, 500) };
  }
}

/**
 * Ensure the given source id is registered; auto-create if missing.
 * Returns:
 *   - { ok: true, created: bool }     — registered (created if needed)
 *   - { ok: false, error }            — gbrain unavailable or refused
 */
export async function ensureSourceRegistered(args: {
  id: string;
  rootPath: string;
}): Promise<{ ok: boolean; created: boolean; error?: string }> {
  const existing = await listSources();
  if (existing === null) {
    return { ok: false, created: false, error: "gbrain sources list failed" };
  }
  if (existing.has(args.id)) {
    return { ok: true, created: false };
  }
  return addSource({ id: args.id, rootPath: args.rootPath });
}
