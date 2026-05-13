import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import { checkBacklinks, buildGraphSnapshot } from "./graph";
import { buildMarkdownIndex } from "./index-file";
import { lintTarget } from "./lint";
import { planMigrationDryRun } from "./migrate";
import { prettyPath } from "./utils";

import {
  ABRAIN_PROJECT_REGISTRY,
  abrainSedimentAuditPath,
  sedimentAuditPath,
  validateAbrainProjectId,
} from "../_shared/runtime";

export type DoctorLiteTargetKind = "legacy_pensieve" | "abrain_project" | "markdown_tree";

export interface DoctorLiteReport {
  target: string;
  targetKind: DoctorLiteTargetKind;
  projectId?: string;
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
    /** Wikilinks resolved against global abrain (knowledge/ + workflows/)
     *  when target is an abrain project. NOT counted as dead links. */
    crossScopeLinkCount: number;
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
    applicable: boolean;
    filesScanned: number;
    pendingCount: number;
    skippedCount: number;
    reason?: string;
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
    const anchor = stat.isFile() ? path.dirname(abs) : abs;
    const parts = anchor.split(path.sep);
    const idx = parts.lastIndexOf(".pensieve");
    if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
    return anchor;
  } catch {
    return abs;
  }
}

interface AbrainProjectTargetInfo {
  kind: "abrain_project";
  projectId: string;
  projectRoot: string;
  abrainHome: string;
}

interface DoctorTargetInfo {
  kind: DoctorLiteTargetKind;
  root: string;
  projectId?: string;
  abrainProjectRoot?: string;
  abrainHome?: string;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function findAbrainProjectTarget(absTarget: string): Promise<AbrainProjectTargetInfo | null> {
  let cursor = absTarget;
  try {
    const stat = await fs.stat(absTarget);
    if (stat.isFile()) cursor = path.dirname(absTarget);
  } catch {
    cursor = path.dirname(absTarget);
  }

  while (true) {
    const registryPath = path.join(cursor, ABRAIN_PROJECT_REGISTRY);
    try {
      const raw = await fs.readFile(registryPath, "utf-8");
      const registry = jsonObject(JSON.parse(raw));
      const projectId = typeof registry?.project_id === "string" ? registry.project_id : "";
      validateAbrainProjectId(projectId);
      if (
        registry?.schema_version === 1 &&
        projectId === path.basename(cursor) &&
        path.basename(path.dirname(cursor)) === "projects"
      ) {
        return {
          kind: "abrain_project",
          projectId,
          projectRoot: cursor,
          abrainHome: path.dirname(path.dirname(cursor)),
        };
      }
    } catch {
      // Keep walking; most ancestor directories are not abrain project roots.
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

async function classifyDoctorTarget(absTarget: string): Promise<DoctorTargetInfo> {
  const abrain = await findAbrainProjectTarget(absTarget);
  if (abrain) {
    return {
      kind: "abrain_project",
      root: abrain.projectRoot,
      projectId: abrain.projectId,
      abrainProjectRoot: abrain.projectRoot,
      abrainHome: abrain.abrainHome,
    };
  }

  const root = await targetRoot(absTarget);
  return {
    kind: path.basename(root) === ".pensieve" ? "legacy_pensieve" : "markdown_tree",
    root,
  };
}

function abrainAuditEventMatchesProject(event: Record<string, unknown>, projectId: string, projectRoot: string): boolean {
  if (event.projectId === projectId || event.project_id === projectId) return true;
  if (typeof event.abrainProjectDir === "string" && path.resolve(event.abrainProjectDir) === path.resolve(projectRoot)) return true;
  if (typeof event.target === "string") {
    if (event.target.startsWith(`projects/${projectId}/`) || event.target.includes(`project:${projectId}:`)) return true;
    if (path.isAbsolute(event.target)) {
      const absTarget = path.resolve(event.target);
      const absProjectRoot = path.resolve(projectRoot);
      return absTarget === absProjectRoot || absTarget.startsWith(`${absProjectRoot}${path.sep}`);
    }
  }
  return false;
}

async function readSedimentAuditStats(target: DoctorTargetInfo) {
  let file: string;
  if (target.kind === "abrain_project" && target.abrainHome) {
    file = abrainSedimentAuditPath(target.abrainHome);
  } else {
    // root may be either a `.pensieve` directory or a project root; resolve
    // to the project root before computing the .pi-astack/sediment audit path.
    const projectRoot = path.basename(target.root) === ".pensieve" ? path.dirname(target.root) : target.root;
    file = sedimentAuditPath(projectRoot);
  }
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
    if (
      target.kind === "abrain_project" &&
      target.projectId &&
      target.abrainProjectRoot &&
      !abrainAuditEventMatchesProject(event, target.projectId, target.abrainProjectRoot)
    ) {
      continue;
    }
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

export async function runDoctorLite(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<DoctorLiteReport> {
  const absTarget = path.resolve(target);
  const targetInfo = await classifyDoctorTarget(absTarget);

  const lint = await lintTarget(absTarget, settings, signal);
  const migration = targetInfo.kind === "abrain_project"
    ? {
        dryRun: true as const,
        writeAvailable: false as const,
        target: prettyPath(absTarget, cwd),
        filesScanned: 0,
        migrateCount: 0,
        skippedCount: 0,
        items: [],
        skipped: [],
      }
    : await planMigrationDryRun(absTarget, settings, signal, cwd);
  const sediment = await readSedimentAuditStats(targetInfo);

  let graph: DoctorLiteReport["graph"];
  try {
    const snapshot = await buildGraphSnapshot(absTarget, settings, signal, cwd);
    const backlinks = await checkBacklinks(absTarget, settings, signal, cwd);
    graph = {
      nodeCount: snapshot.stats.node_count,
      edgeCount: snapshot.stats.edge_count,
      orphanCount: snapshot.stats.orphans.length,
      deadLinkCount: backlinks.deadLinkCount,
      crossScopeLinkCount: snapshot.stats.cross_scope_links.length,
      missingSymmetricCount: backlinks.missingSymmetricCount,
      buildOk: true,
    };
  } catch (e: unknown) {
    graph = {
      nodeCount: 0,
      edgeCount: 0,
      orphanCount: 0,
      deadLinkCount: 0,
      crossScopeLinkCount: 0,
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
    (targetInfo.kind !== "abrain_project" && migration.migrateCount > 0) ||
    index.stagingOrphanCount > 0
  ) {
    status = "warning";
  }

  return {
    target: prettyPath(absTarget, cwd),
    targetKind: targetInfo.kind,
    ...(targetInfo.projectId ? { projectId: targetInfo.projectId } : {}),
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
      applicable: targetInfo.kind !== "abrain_project",
      filesScanned: migration.filesScanned,
      pendingCount: migration.migrateCount,
      skippedCount: migration.skippedCount,
      ...(targetInfo.kind === "abrain_project"
        ? { reason: `target is abrain project ${targetInfo.projectId}; legacy .pensieve migration is not applicable` }
        : {}),
    },
    sediment,
  };
}

export function formatDoctorLiteReport(report: DoctorLiteReport): string {
  const targetKind = report.projectId
    ? `${report.targetKind} (${report.projectId})`
    : report.targetKind;
  const migrationLines = report.migration.applicable
    ? [
        `- Files scanned: ${report.migration.filesScanned}`,
        `- Pending migrations: ${report.migration.pendingCount}`,
        `- Skipped: ${report.migration.skippedCount}`,
      ]
    : [`- Not applicable: ${report.migration.reason || "target is not a legacy .pensieve tree"}`];

  const lines: string[] = [
    `Memory doctor-lite: ${report.status.toUpperCase()}`,
    `Target: ${report.target}`,
    `Target kind: ${targetKind}`,
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
    `- Cross-scope links (resolved against global abrain): ${report.graph.crossScopeLinkCount}`,
    `- Missing symmetric backlinks: ${report.graph.missingSymmetricCount}`,
    "",
    "## Generated Index",
    `- Build: ${report.index.buildOk ? "ok" : `failed (${report.index.error})`}`,
    `- Entries: ${report.index.entryCount}`,
    `- Kind groups: ${report.index.kindCount}`,
    `- Staging orphans: ${report.index.stagingOrphanCount}`,
    "",
    "## Migration",
    ...migrationLines,
    "",
    "## Sediment Auto-Write Audit",
    `- Auto-write events: ${report.sediment.autoWriteCount}`,
    `- Applied: ${report.sediment.autoWriteApplied}`,
    `- Skipped: ${report.sediment.autoWriteSkipped}`,
    `- Failed/error-like: ${report.sediment.autoWriteFailed}`,
    `- Explicit extracts: ${report.sediment.explicitExtractCount}`,
  ];

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
