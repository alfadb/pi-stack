import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import {
  defaultConfidence,
  extractTitle,
  inferKindFromPath,
  parseFrontmatter,
  scalarNumber,
  scalarString,
  splitCompiledTruth,
  splitFrontmatter,
} from "./parser";
import { isEmptyFrontmatterValue, markdownFilesForTarget, REQUIRED_FRONTMATTER_FIELDS } from "./lint";
import { clamp, normalizeBareSlug, prettyPath, stableUnique, titleFromSlug, throwIfAborted } from "./utils";

export interface MigrationPlanItem {
  source_path: string;
  target_path: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  reasons: string[];
  actions: string[];
}

export interface MigrationSkipItem {
  source_path: string;
  reason: string;
}

export interface MigrationPlanReport {
  target: string;
  filesScanned: number;
  migrateCount: number;
  skippedCount: number;
  items: MigrationPlanItem[];
  skipped: MigrationSkipItem[];
  dryRun: true;
  writeAvailable: false;
}

export interface MigrationReportWriteResult {
  report_path: string;
  migrateCount: number;
  skippedCount: number;
}

function addDaysIso(dateLike: string | undefined, days: number): string {
  const base = dateLike && /^\d{4}-\d{2}-\d{2}/.test(dateLike)
    ? new Date(`${dateLike.slice(0, 10)}T00:00:00Z`)
    : new Date();
  if (Number.isNaN(base.getTime())) return addDaysIso(undefined, days);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizeLegacyKind(kindOrType: string): string {
  const k = kindOrType.toLowerCase();
  if (k === "maxim") return "maxim";
  if (k === "decision") return "decision";
  if (k === "pattern") return "pattern";
  if (k === "anti-pattern" || k === "antipattern") return "anti-pattern";
  if (k === "preference") return "preference";
  if (k === "smell") return "smell";
  if (k === "knowledge") return "fact";
  if (k === "pipeline") return "pipeline";
  return k || "fact";
}

function inferLegacyArea(relPath: string): { area: string; shortTerm: boolean; unsupported?: string } {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  const shortTerm = parts[0] === "short-term";
  const head = shortTerm ? parts[1] : parts[0];

  if (!head || head === "state.md") return { area: "", shortTerm, unsupported: "support file outside memory entry directories" };
  if (head === "pipelines") return { area: head, shortTerm, unsupported: "pipeline resources are not migrated by memory schema v1" };
  if (["maxims", "decisions", "knowledge", "staging", "archive"].includes(head)) {
    return { area: head, shortTerm };
  }
  return { area: head, shortTerm, unsupported: `unsupported memory directory: ${head}` };
}

function legacyTargetPath(sourcePath: string, projectRoot: string, relPath: string, slug: string): string {
  const { area, shortTerm } = inferLegacyArea(relPath);
  if (!area) return sourcePath;
  const targetDir = path.join(projectRoot, area);
  const basename = path.basename(sourcePath);

  if (basename === "content.md") return path.join(targetDir, `${slug}.md`);
  if (shortTerm) return path.join(targetDir, `${slug}.md`);
  return sourcePath;
}

async function planMigrationForFile(
  file: string,
  projectRoot: string,
  cwd: string,
  settings: MemorySettings,
): Promise<{ item?: MigrationPlanItem; skipped?: MigrationSkipItem }> {
  const relPath = path.relative(projectRoot, file);
  const area = inferLegacyArea(relPath);
  if (area.unsupported) {
    return { skipped: { source_path: prettyPath(file, cwd), reason: area.unsupported } };
  }

  const raw = await fs.readFile(file, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { timeline } = splitCompiledTruth(body);

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id || pathSlug || extractTitle(body) || "entry");
  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const kind = normalizeLegacyKind(
    scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relPath),
  );
  const status = scalarString(frontmatter.status) || "active";
  const confidence = clamp(
    scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind),
    0,
    10,
  );
  const created = scalarString(frontmatter.created);
  const targetPath = legacyTargetPath(file, projectRoot, relPath, slug);

  const reasons: string[] = [];
  const actions: string[] = [];

  if (!frontmatterText) reasons.push("missing frontmatter");
  if (isEmptyFrontmatterValue(frontmatter.schema_version)) reasons.push("missing schema_version");
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (isEmptyFrontmatterValue(frontmatter[field])) reasons.push(`missing ${field}`);
  }
  if (timeline.length === 0) reasons.push("missing Timeline entries");
  if (!/^##\s+Timeline\s*$/m.test(body)) reasons.push("missing ## Timeline heading");
  if (targetPath !== file) reasons.push("legacy path layout");

  if (reasons.length === 0) {
    return { skipped: { source_path: prettyPath(file, cwd), reason: "already schema_version v1-compatible" } };
  }

  actions.push(`write frontmatter schema_version: 1, scope: project, kind: ${kind}, confidence: ${confidence}`);
  if (targetPath !== file) actions.push(`move/rename to ${prettyPath(targetPath, cwd)}`);
  if (area.shortTerm) {
    const expires = addDaysIso(created, settings.shortTermTtlDays);
    actions.push(`add lifetime.kind: ttl, lifetime.expires_at: ${expires} (${settings.shortTermTtlDays}d)`);
  }
  if (!/^##\s+Timeline\s*$/m.test(body)) {
    actions.push("append ## Timeline with migrated-from-legacy entry");
  } else if (timeline.length === 0) {
    actions.push("append initial migrated-from-legacy timeline entry");
  }

  return {
    item: {
      source_path: prettyPath(file, cwd),
      target_path: prettyPath(targetPath, cwd),
      slug,
      title,
      kind,
      status,
      confidence,
      reasons: stableUnique(reasons),
      actions,
    },
  };
}

function inferProjectRoot(absTarget: string): string {
  if (path.basename(absTarget) === ".pensieve") return absTarget;
  const parts = absTarget.split(path.sep);
  const idx = parts.lastIndexOf(".pensieve");
  if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
  return absTarget;
}

export async function planMigrationDryRun(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<MigrationPlanReport> {
  const absTarget = path.resolve(target);
  const files = await markdownFilesForTarget(absTarget, settings, signal);
  const projectRoot = inferProjectRoot(absTarget);

  const items: MigrationPlanItem[] = [];
  const skipped: MigrationSkipItem[] = [];

  for (const file of files) {
    throwIfAborted(signal);
    try {
      const planned = await planMigrationForFile(file, projectRoot, cwd, settings);
      if (planned.item) items.push(planned.item);
      if (planned.skipped) skipped.push(planned.skipped);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      skipped.push({ source_path: prettyPath(file, cwd), reason: `failed to inspect: ${message}` });
    }
  }

  return {
    target: prettyPath(absTarget, cwd),
    filesScanned: files.length,
    migrateCount: items.length,
    skippedCount: skipped.length,
    items,
    skipped,
    dryRun: true,
    writeAvailable: false,
  };
}

function countValues(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function formatMigrationReportMarkdown(report: MigrationPlanReport): string {
  const kindCounts = countValues(report.items.map((item) => item.kind));
  const reasonCounts = countValues(report.items.flatMap((item) => item.reasons));
  const lines: string[] = [
    "# Memory Migration Dry-Run Report",
    "",
    `> Generated ${new Date().toISOString()} | target: \`${report.target}\``,
    "",
    "## Summary",
    "",
    `- Files scanned: ${report.filesScanned}`,
    `- Need migration: ${report.migrateCount}`,
    `- Skipped: ${report.skippedCount}`,
    `- Dry run: ${report.dryRun}`,
    `- Writes available: ${report.writeAvailable}`,
    "",
    "## By Kind",
    "",
  ];

  for (const [kind, count] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${kind}: ${count}`);
  }
  if (Object.keys(kindCounts).length === 0) lines.push("- None");

  lines.push("", "## By Reason", "");
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${reason}: ${count}`);
  }
  if (Object.keys(reasonCounts).length === 0) lines.push("- None");

  lines.push("", "## Migration Items", "");
  if (report.items.length === 0) {
    lines.push("- None");
  } else {
    lines.push("| Source | Target | Title | Kind | Confidence | Reasons | Actions |");
    lines.push("|---|---|---|---:|---:|---|---|");
    for (const item of report.items) {
      lines.push([
        markdownCell(item.source_path),
        markdownCell(item.target_path),
        markdownCell(item.title),
        markdownCell(item.kind),
        String(item.confidence),
        markdownCell(item.reasons.join(", ")),
        markdownCell(item.actions.join("; ")),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  lines.push("", "## Skipped", "");
  if (report.skipped.length === 0) {
    lines.push("- None");
  } else {
    lines.push("| Source | Reason |");
    lines.push("|---|---|");
    for (const item of report.skipped) {
      lines.push(`| ${markdownCell(item.source_path)} | ${markdownCell(item.reason)} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

export async function writeMigrationReport(
  target: string,
  report: MigrationPlanReport,
  cwd = process.cwd(),
): Promise<MigrationReportWriteResult> {
  const projectRoot = inferProjectRoot(path.resolve(target));
  const reportPath = path.join(projectRoot, ".state", "migration-report.md");
  await atomicWrite(reportPath, formatMigrationReportMarkdown(report));
  return {
    report_path: prettyPath(reportPath, cwd),
    migrateCount: report.migrateCount,
    skippedCount: report.skippedCount,
  };
}

export function formatMigrationPlan(report: MigrationPlanReport, maxItems = 12): string {
  const lines: string[] = [
    `Memory migrate dry-run: ${report.migrateCount} file(s) need migration, ${report.skippedCount} skipped, ${report.filesScanned} scanned`,
    "Actual writes are intentionally not available in this read-only extension; sediment/migration writer must apply the plan.",
  ];

  if (report.items.length === 0) return lines.join("\n");

  lines.push("");
  for (const item of report.items.slice(0, maxItems)) {
    lines.push(`- ${item.source_path} -> ${item.target_path}`);
    lines.push(`  slug=${item.slug} kind=${item.kind} status=${item.status} confidence=${item.confidence}`);
    lines.push(`  reasons: ${item.reasons.join(", ")}`);
    lines.push(`  actions: ${item.actions.join("; ")}`);
  }
  if (report.items.length > maxItems) {
    lines.push(`- ... ${report.items.length - maxItems} more migration item(s) omitted`);
  }
  return lines.join("\n");
}
