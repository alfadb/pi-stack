import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import { checkBacklinks, buildGraphSnapshot } from "./graph";
import { buildMarkdownIndex } from "./index-file";
import { lintTarget } from "./lint";
import { planMigrationDryRun } from "./migrate";
import { prettyPath } from "./utils";
import { listMigrationBackups, type MigrationBackupItem } from "../sediment/migration";
import { sedimentAuditPath } from "../_shared/runtime";

export interface DoctorLiteReport {
  target: string;
  status: "pass" | "warning" | "error";
  lint: {
    filesChecked: number;
    errorCount: number;
    warningCount: number;
    filesWithErrors: number;
  };
  graph: {
    nodeCount: number;
    edgeCount: number;
    orphanCount: number;
    deadLinkCount: number;
    missingSymmetricCount: number;
    buildOk: boolean;
    error?: string;
  };
  index: {
    buildOk: boolean;
    entryCount: number;
    kindCount: number;
    stagingOrphanCount: number;
    error?: string;
  };
  migration: {
    filesScanned: number;
    pendingCount: number;
    skippedCount: number;
  };
  migrationBackups: {
    total: number;
    returned: number;
    stateCounts: Record<string, number>;
    recent: Array<Pick<MigrationBackupItem, "backup_path" | "state" | "restore_command" | "source_path" | "target_path" | "reason">>;
    error?: string;
  };
  sediment: {
    autoWriteCount: number;
    autoWriteApplied: number;
    autoWriteSkipped: number;
    autoWriteFailed: number;
    explicitExtractCount: number;
    operationCounts: Record<string, number>;
    reasons: Record<string, number>;
  };
}

async function targetRoot(target: string): Promise<string> {
  const abs = path.resolve(target);
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile()) {
      const parts = abs.split(path.sep);
      const idx = parts.lastIndexOf(".pensieve");
      if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
      return path.dirname(abs);
    }
  } catch {
    return abs;
  }
  return abs;
}

function projectRootForPensieveRoot(root: string): string | undefined {
  return path.basename(root) === ".pensieve" ? path.dirname(root) : undefined;
}

async function readSedimentAuditStats(root: string) {
  // root may be either a `.pensieve` directory or a project root; resolve
  // to the project root before computing the .pi-astack/sediment audit path.
  const projectRoot = path.basename(root) === ".pensieve" ? path.dirname(root) : root;
  const file = sedimentAuditPath(projectRoot);
  const stats: DoctorLiteReport["sediment"] = {
    autoWriteCount: 0,
    autoWriteApplied: 0,
    autoWriteSkipped: 0,
    autoWriteFailed: 0,
    explicitExtractCount: 0,
    operationCounts: {},
    reasons: {},
  };

  let raw = "";
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return stats;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    const operation = String(event.operation || "unknown");
    stats.operationCounts[operation] = (stats.operationCounts[operation] ?? 0) + 1;

    if (operation === "explicit_extract") stats.explicitExtractCount++;
    const isAutoWrite = event.lane === "auto_write" || operation === "auto_write";
    if (!isAutoWrite) continue;

    stats.autoWriteCount++;
    if (operation === "auto_write") stats.autoWriteApplied++;
    else if (operation === "skip") stats.autoWriteSkipped++;

    const reason = event.reason || event.llm?.quality?.reason || event.llm?.error;
    if (reason) stats.reasons[String(reason)] = (stats.reasons[String(reason)] ?? 0) + 1;

    const failed = event.llm?.ok === false || /error|failed|abort|unavailable|exception/i.test(String(event.reason || event.llm?.error || ""));
    if (failed) stats.autoWriteFailed++;
  }
  return stats;
}

function uniqueFilesWithError(issues: Array<{ severity: string; file?: string }>): number {
  const files = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    files.add(issue.file || "(target)");
  }
  return files.size;
}

function countBackupStates(items: MigrationBackupItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.state] = (counts[item.state] ?? 0) + 1;
  return counts;
}

async function readMigrationBackupStats(
  root: string,
  settings: MemorySettings,
): Promise<DoctorLiteReport["migrationBackups"]> {
  const projectRoot = projectRootForPensieveRoot(root);
  if (!projectRoot) return { total: 0, returned: 0, stateCounts: {}, recent: [] };
  try {
    const backups = await listMigrationBackups(projectRoot, settings, 20);
    return {
      total: backups.total,
      returned: backups.returned,
      stateCounts: countBackupStates(backups.items),
      recent: backups.items.slice(0, 5).map((item) => ({
        backup_path: item.backup_path,
        state: item.state,
        restore_command: item.restore_command,
        ...(item.source_path ? { source_path: item.source_path } : {}),
        ...(item.target_path ? { target_path: item.target_path } : {}),
        ...(item.reason ? { reason: item.reason } : {}),
      })),
    };
  } catch (e: unknown) {
    return {
      total: 0,
      returned: 0,
      stateCounts: {},
      recent: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function backupProblemCount(stateCounts: Record<string, number>): number {
  return ["target_modified", "source_exists", "source_modified", "source_missing", "invalid"]
    .reduce((sum, state) => sum + (stateCounts[state] ?? 0), 0);
}

export async function runDoctorLite(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<DoctorLiteReport> {
  const absTarget = path.resolve(target);
  const root = await targetRoot(absTarget);

  const lint = await lintTarget(absTarget, settings, signal);
  const migration = await planMigrationDryRun(absTarget, settings, signal, cwd);
  const migrationBackups = await readMigrationBackupStats(root, settings);
  const sediment = await readSedimentAuditStats(root);

  let graph: DoctorLiteReport["graph"];
  try {
    const snapshot = await buildGraphSnapshot(absTarget, settings, signal, cwd);
    const backlinks = await checkBacklinks(absTarget, settings, signal, cwd);
    graph = {
      nodeCount: snapshot.stats.node_count,
      edgeCount: snapshot.stats.edge_count,
      orphanCount: snapshot.stats.orphans.length,
      deadLinkCount: backlinks.deadLinkCount,
      missingSymmetricCount: backlinks.missingSymmetricCount,
      buildOk: true,
    };
  } catch (e: unknown) {
    graph = {
      nodeCount: 0,
      edgeCount: 0,
      orphanCount: 0,
      deadLinkCount: 0,
      missingSymmetricCount: 0,
      buildOk: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let index: DoctorLiteReport["index"];
  try {
    const built = await buildMarkdownIndex(absTarget, settings, signal, cwd);
    const kinds = new Set(built.entries.map((entry) => entry.kind));
    index = {
      buildOk: true,
      entryCount: built.entries.length,
      kindCount: kinds.size,
      stagingOrphanCount: built.orphanSlugs.length,
    };
  } catch (e: unknown) {
    index = {
      buildOk: false,
      entryCount: 0,
      kindCount: 0,
      stagingOrphanCount: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  let status: DoctorLiteReport["status"] = "pass";
  if (lint.errorCount > 0 || graph.deadLinkCount > 0 || !graph.buildOk || !index.buildOk) {
    status = "error";
  } else if (
    lint.warningCount > 0 ||
    graph.missingSymmetricCount > 0 ||
    migration.migrateCount > 0 ||
    index.stagingOrphanCount > 0 ||
    backupProblemCount(migrationBackups.stateCounts) > 0 ||
    !!migrationBackups.error
  ) {
    status = "warning";
  }

  return {
    target: prettyPath(absTarget, cwd),
    status,
    lint: {
      filesChecked: lint.filesChecked,
      errorCount: lint.errorCount,
      warningCount: lint.warningCount,
      filesWithErrors: uniqueFilesWithError(lint.issues),
    },
    graph,
    index,
    migration: {
      filesScanned: migration.filesScanned,
      pendingCount: migration.migrateCount,
      skippedCount: migration.skippedCount,
    },
    migrationBackups,
    sediment,
  };
}

export function formatDoctorLiteReport(report: DoctorLiteReport): string {
  const lines: string[] = [
    `Memory doctor-lite: ${report.status.toUpperCase()}`,
    `Target: ${report.target}`,
    "",
    "## Lint",
    `- Files checked: ${report.lint.filesChecked}`,
    `- Errors: ${report.lint.errorCount} (${report.lint.filesWithErrors} file(s))`,
    `- Warnings: ${report.lint.warningCount}`,
    "",
    "## Graph / Backlinks",
    `- Build: ${report.graph.buildOk ? "ok" : `failed (${report.graph.error})`}`,
    `- Nodes: ${report.graph.nodeCount}`,
    `- Edges: ${report.graph.edgeCount}`,
    `- Orphans: ${report.graph.orphanCount}`,
    `- Dead links: ${report.graph.deadLinkCount}`,
    `- Missing symmetric backlinks: ${report.graph.missingSymmetricCount}`,
    "",
    "## Generated Index",
    `- Build: ${report.index.buildOk ? "ok" : `failed (${report.index.error})`}`,
    `- Entries: ${report.index.entryCount}`,
    `- Kind groups: ${report.index.kindCount}`,
    `- Staging orphans: ${report.index.stagingOrphanCount}`,
    "",
    "## Migration",
    `- Files scanned: ${report.migration.filesScanned}`,
    `- Pending migrations: ${report.migration.pendingCount}`,
    `- Skipped: ${report.migration.skippedCount}`,
    "",
    "## Migration Backups",
    `- Total: ${report.migrationBackups.total}`,
    `- Returned: ${report.migrationBackups.returned}`,
    `- Build: ${report.migrationBackups.error ? `failed (${report.migrationBackups.error})` : "ok"}`,
    "",
    "## Sediment Auto-Write Audit",
    `- Auto-write events: ${report.sediment.autoWriteCount}`,
    `- Applied: ${report.sediment.autoWriteApplied}`,
    `- Skipped: ${report.sediment.autoWriteSkipped}`,
    `- Failed/error-like: ${report.sediment.autoWriteFailed}`,
    `- Explicit extracts: ${report.sediment.explicitExtractCount}`,
  ];

  const backupStateEntries = Object.entries(report.migrationBackups.stateCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (backupStateEntries.length > 0) {
    const insertAt = lines.indexOf("## Sediment Auto-Write Audit") - 1;
    const backupLines = ["- States:", ...backupStateEntries.map(([state, count]) => `  - ${state}: ${count}`)];
    if (report.migrationBackups.recent.length > 0) {
      backupLines.push("- Recent:");
      for (const item of report.migrationBackups.recent) {
        backupLines.push(`  - ${item.state}: ${item.backup_path}`);
      }
    }
    lines.splice(insertAt, 0, ...backupLines, "");
  }

  const operationEntries = Object.entries(report.sediment.operationCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (operationEntries.length > 0) {
    lines.push("- Operations:");
    for (const [operation, count] of operationEntries) lines.push(`  - ${operation}: ${count}`);
  }

  const reasonEntries = Object.entries(report.sediment.reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (reasonEntries.length > 0) {
    lines.push("- Reasons:");
    for (const [reason, count] of reasonEntries) lines.push(`  - ${reason}: ${count}`);
  }

  return lines.join("\n");
}
