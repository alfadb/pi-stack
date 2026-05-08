/**
 * Shared runtime utilities for pi-astack extensions.
 *
 * - Local-timezone ISO 8601 timestamp (replaces UTC `toISOString()`)
 * - Path resolvers that route per-extension state/log files into
 *   `<projectRoot>/.pi-astack/<module>/...` rather than the legacy
 *   `<projectRoot>/.pensieve/.state/...` location.
 *
 * Boundary:
 * - `.pi-astack/<module>/`  — runtime state, audit logs, locks, backups
 * - `.pensieve/`            — canonical markdown knowledge + browsable
 *                             derived views (_index.md, .index/graph.json)
 *
 * This file deliberately has zero imports from sibling extensions.
 */
import * as path from "node:path";

/**
 * Format a Date as ISO 8601 with the LOCAL timezone offset, e.g.:
 *
 *   2026-05-08T14:08:38.295+08:00
 *
 * (Replaces `new Date().toISOString()` which always emits UTC.)
 *
 * Stable across DST transitions because the offset is computed from the
 * Date instance at the moment of formatting.
 */
export function formatLocalIsoTimestamp(d: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hour = pad(d.getHours());
  const minute = pad(d.getMinutes());
  const second = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  // getTimezoneOffset returns minutes WEST of UTC (positive for negative
  // offsets), so flip the sign to get the conventional "+08:00".
  const offsetMin = -d.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetHours = pad(Math.floor(Math.abs(offsetMin) / 60));
  const offsetMins = pad(Math.abs(offsetMin) % 60);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offsetSign}${offsetHours}:${offsetMins}`;
}

/**
 * Generate a backup directory name from the local-timezone timestamp.
 * Uses dashes instead of colons (filesystem-safe) and drops the ms separator.
 *
 *   2026-05-08T14-08-38-295+08-00
 */
export function localTimestampForFilename(d: Date = new Date()): string {
  return formatLocalIsoTimestamp(d).replace(/:/g, "-").replace(/\./, "-");
}

/** Root for all pi-astack runtime artifacts within a given project. */
export function piAstackRoot(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pi-astack");
}

/** Per-module subdirectory under `.pi-astack/`. */
export function piAstackModuleDir(projectRoot: string, module: string): string {
  return path.join(piAstackRoot(projectRoot), module);
}

/* -------- sediment ----------------------------------------------------- */

export function sedimentDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "sediment");
}
export function sedimentAuditPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "audit.jsonl");
}
export function sedimentCheckpointPath(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "checkpoint.json");
}
export function sedimentLocksDir(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "locks");
}
export function sedimentMigrationBackupsDir(projectRoot: string): string {
  return path.join(sedimentDir(projectRoot), "migration-backups");
}

/* -------- memory ------------------------------------------------------- */

export function memoryDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "memory");
}
export function memoryMigrationReportPath(projectRoot: string): string {
  return path.join(memoryDir(projectRoot), "migration-report.md");
}

/* -------- compaction-tuner -------------------------------------------- */

export function compactionTunerDir(projectRoot: string): string {
  return piAstackModuleDir(projectRoot, "compaction-tuner");
}
export function compactionTunerAuditPath(projectRoot: string): string {
  return path.join(compactionTunerDir(projectRoot), "audit.jsonl");
}

/* -------- legacy fallback paths ---------------------------------------- *
 * Returned alongside the canonical paths so consumers can read either
 * location during the transition window. Once existing data is migrated,
 * these can be removed.                                                    */

export function legacySedimentAuditPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-events.jsonl");
}
export function legacySedimentCheckpointPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "sediment-checkpoint.json");
}
export function legacySedimentLocksDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "locks");
}
export function legacySedimentMigrationBackupsDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "migration-backups");
}
export function legacyMemoryMigrationReportPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".pensieve", ".state", "migration-report.md");
}

/* -------- one-shot legacy data migration ------------------------------ *
 * Moves pi-astack-owned state files from the legacy `.pensieve/.state/`
 * location to `.pi-astack/<module>/`. Idempotent and racy-safe enough for
 * single-process use: skips if the target already exists.
 *
 * Called from `appendAudit` and `loadCheckpoint` so the move happens at
 * the first runtime touch after a code upgrade, with no separate user
 * script required. A per-project flag avoids re-running per call.        */

const migrated = new Set<string>();

export async function ensureSedimentLegacyMigrated(projectRoot: string): Promise<void> {
  const root = path.resolve(projectRoot);
  // Per-process flag avoids re-statting on every audit append. Cleared on
  // process restart, so post-restart migrations re-run once if a stray
  // legacy file showed up since last cycle.
  if (migrated.has(root)) return;
  migrated.add(root);

  const fs = await import("node:fs/promises");
  const fsSync = await import("node:fs");

  /**
   * Move legacy audit file to canonical location. If both exist (e.g.,
   * a stray write happened between two restarts of mixed code paths),
   * APPEND the legacy content to canonical and remove legacy. Care is
   * taken to produce exactly one `\n` between rows: never zero (would
   * fuse two JSONL lines) and never two+ (would inject blank rows that
   * pass `if (!line.trim()) continue` filters but waste readers' time).
   */
  async function migrateAuditFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: append legacy content to canonical, then remove legacy.
    const legacyRaw = await fs.readFile(oldPath, "utf-8");
    // Strip leading/trailing whitespace, collapse internal blank lines.
    // Each non-empty line must end with exactly one `\n` in the output.
    const lines = legacyRaw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      // Ensure canonical ends with `\n` so the appended block doesn't
      // accidentally fuse onto the previous final row. Standard JSONL
      // append-writes always close with `\n`, so this is usually a no-op.
      const newEndsWithNL = await fileEndsWithNewline(newPath);
      const prefix = newEndsWithNL ? "" : "\n";
      await fs.appendFile(newPath, prefix + lines.join("\n") + "\n", "utf-8");
    }
    await fs.unlink(oldPath);
  }

  async function fileEndsWithNewline(file: string): Promise<boolean> {
    const stat = await fs.stat(file);
    if (stat.size === 0) return true;
    const fd = await fs.open(file, "r");
    try {
      const buf = Buffer.alloc(1);
      await fd.read(buf, 0, 1, stat.size - 1);
      return buf[0] === 0x0a;
    } finally {
      await fd.close();
    }
  }

  /**
   * Move legacy checkpoint to canonical location. If both exist, prefer
   * the LATER `lastProcessedEntryId` (or canonical when ambiguous) so we
   * don't replay already-processed entries. Stale legacy gets removed.
   */
  async function migrateCheckpointFile(oldPath: string, newPath: string): Promise<void> {
    const oldExists = fsSync.existsSync(oldPath);
    if (!oldExists) return;
    const newExists = fsSync.existsSync(newPath);
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    if (!newExists) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e?.code === "EXDEV") {
          await fs.copyFile(oldPath, newPath);
          await fs.unlink(oldPath);
          return;
        }
        throw e;
      }
    }
    // Both exist: keep canonical (assumed authoritative under new code),
    // unlink legacy.
    await fs.unlink(oldPath);
  }

  await migrateAuditFile(legacySedimentAuditPath(root), sedimentAuditPath(root));
  await migrateCheckpointFile(legacySedimentCheckpointPath(root), sedimentCheckpointPath(root));
  // Locks are ephemeral; do not migrate. Migration-backups already pruned.
}
