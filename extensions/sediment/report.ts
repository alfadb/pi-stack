import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface LlmDryRunReportItem {
  timestamp?: string;
  model?: string;
  ok?: boolean;
  passed?: boolean;
  reason?: string;
  candidateCount?: number;
  validationErrorCount?: number;
  invalidCandidateCount?: number;
  rawTextSha256?: string;
  rawTextPreview?: string;
}

export interface LlmDryRunReport {
  auditPath: string;
  total: number;
  passCount: number;
  failCount: number;
  candidateTotal: number;
  validationErrorTotal: number;
  invalidCandidateTotal: number;
  reasons: Record<string, number>;
  recent: LlmDryRunReportItem[];
}

export function auditPath(projectRoot: string): string {
  return path.join(projectRoot, ".pensieve", ".state", "sediment-events.jsonl");
}

function parseLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

export async function readLlmDryRunReport(projectRoot: string, limit?: number): Promise<LlmDryRunReport> {
  const file = auditPath(projectRoot);
  const max = parseLimit(limit);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return {
      auditPath: file,
      total: 0,
      passCount: 0,
      failCount: 0,
      candidateTotal: 0,
      validationErrorTotal: 0,
      invalidCandidateTotal: 0,
      reasons: {},
      recent: [],
    };
  }

  const items: LlmDryRunReportItem[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.operation !== "llm_dry_run" || !event.llm) continue;
    const quality = event.llm.quality ?? {};
    items.push({
      timestamp: event.timestamp,
      model: event.llm.model,
      ok: event.llm.ok,
      passed: quality.passed,
      reason: quality.reason,
      candidateCount: quality.candidateCount ?? 0,
      validationErrorCount: quality.validationErrorCount ?? 0,
      invalidCandidateCount: quality.invalidCandidateCount ?? 0,
      rawTextSha256: quality.rawTextSha256,
      rawTextPreview: quality.rawTextPreview,
    });
  }

  const reasons: Record<string, number> = {};
  let passCount = 0;
  let failCount = 0;
  let candidateTotal = 0;
  let validationErrorTotal = 0;
  let invalidCandidateTotal = 0;

  for (const item of items) {
    if (item.passed) passCount++;
    else failCount++;
    const reason = item.reason || "unknown";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    candidateTotal += item.candidateCount ?? 0;
    validationErrorTotal += item.validationErrorCount ?? 0;
    invalidCandidateTotal += item.invalidCandidateCount ?? 0;
  }

  return {
    auditPath: file,
    total: items.length,
    passCount,
    failCount,
    candidateTotal,
    validationErrorTotal,
    invalidCandidateTotal,
    reasons,
    recent: items.slice(-max).reverse(),
  };
}

export function formatLlmDryRunReport(report: LlmDryRunReport): string {
  const lines: string[] = [
    `Sediment LLM dry-run report: ${report.total} run(s), ${report.passCount} pass, ${report.failCount} fail`,
    `Candidates: ${report.candidateTotal}; validation errors: ${report.validationErrorTotal}; invalid candidates: ${report.invalidCandidateTotal}`,
    `Audit path: ${report.auditPath}`,
  ];

  const reasonEntries = Object.entries(report.reasons).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    lines.push("");
    lines.push("Reasons:");
    for (const [reason, count] of reasonEntries) lines.push(`- ${reason}: ${count}`);
  }

  if (report.recent.length > 0) {
    lines.push("");
    lines.push(`Recent (${report.recent.length}):`);
    for (const item of report.recent) {
      const status = item.passed ? "pass" : "fail";
      const hash = item.rawTextSha256 ? ` hash=${item.rawTextSha256.slice(0, 12)}` : "";
      lines.push(`- ${item.timestamp ?? "unknown"} ${status} reason=${item.reason ?? "unknown"} candidates=${item.candidateCount ?? 0} model=${item.model ?? "unknown"}${hash}`);
      if (item.rawTextPreview) {
        const preview = item.rawTextPreview.replace(/\s+/g, " ").slice(0, 160);
        lines.push(`  preview: ${preview}`);
      }
    }
  }

  if (report.total === 0) {
    lines.push("");
    lines.push("No llm_dry_run events found yet. Run `/sediment llm --dry-run` first.");
  }

  return lines.join("\n");
}
