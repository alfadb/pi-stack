import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sedimentAuditPath } from "../_shared/runtime";

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

export interface LlmAutoWritePolicy {
  autoLlmWriteEnabled: boolean;
  minDryRunSamples: number;
  requiredDryRunPassRate: number;
}

export interface LlmAutoWriteReadiness {
  autoLlmWriteEnabled: boolean;
  ready: boolean;
  policyPassed: boolean;
  sampleCount: number;
  minDryRunSamples: number;
  passRate: number;
  requiredDryRunPassRate: number;
  blockers: string[];
  reasons: Record<string, number>;
}

export function auditPath(projectRoot: string): string {
  return sedimentAuditPath(projectRoot);
}

function parseLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

export interface ReadReportOptions {
  /** Include `operation: "auto_write"` rows alongside `llm_dry_run` rows. */
  includeAutoWrite?: boolean;
  /**
   * Cap on rows scanned regardless of operation type. The reader walks
   * the audit file from the END backwards, stopping once it has
   * collected this many qualifying rows. Default 200 (matches
   * parseLimit ceiling). Set lower for the rolling-window gate
   * (typical 20–50).
   */
  scanLimit?: number;
}

export async function readLlmDryRunReport(
  projectRoot: string,
  limit?: number,
  opts?: ReadReportOptions,
): Promise<LlmDryRunReport> {
  const file = auditPath(projectRoot);
  const max = parseLimit(limit);
  const scanCap = opts?.scanLimit && Number.isFinite(opts.scanLimit) && opts.scanLimit > 0
    ? Math.floor(opts.scanLimit)
    : Number.POSITIVE_INFINITY;
  const includeAutoWrite = !!opts?.includeAutoWrite;
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

  // Scan oldest-to-newest into a flat list, then take the tail when
  // scanCap is finite. We can't easily reverse-scan a JSONL file
  // without seeking; the audit log is bounded enough that O(n) is
  // fine.
  const allLines = raw.split("\n");
  const items: LlmDryRunReportItem[] = [];
  for (const line of allLines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const isDryRun = event.operation === "llm_dry_run";
    const isAutoWrite = includeAutoWrite && event.operation === "auto_write";
    if ((!isDryRun && !isAutoWrite) || !event.llm) continue;
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
  // Apply scanCap to keep only the most recent N qualifying rows.
  // IMPORTANT: when scanCap is infinite or items length <= scanCap we
  // must NOT alias the array — a later `items.length = 0` would clear
  // both. We always copy the slice so subsequent in-place mutation
  // (if any) is local.
  const limited = Number.isFinite(scanCap) && items.length > scanCap
    ? items.slice(items.length - scanCap)
    : items.slice();
  items.length = 0;
  items.push(...limited);

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

export function evaluateLlmAutoWriteReadiness(
  report: LlmDryRunReport,
  policy: LlmAutoWritePolicy,
): LlmAutoWriteReadiness {
  const passRate = report.total === 0 ? 0 : report.passCount / report.total;
  const blockers: string[] = [];
  if (!policy.autoLlmWriteEnabled) blockers.push("auto LLM write disabled");
  if (report.total < policy.minDryRunSamples) blockers.push(`insufficient dry-run samples (${report.total}/${policy.minDryRunSamples})`);
  if (passRate < policy.requiredDryRunPassRate) blockers.push(`pass rate below threshold (${passRate.toFixed(3)} < ${policy.requiredDryRunPassRate})`);

  const policyPassed =
    report.total >= policy.minDryRunSamples &&
    passRate >= policy.requiredDryRunPassRate;

  return {
    autoLlmWriteEnabled: policy.autoLlmWriteEnabled,
    ready: policy.autoLlmWriteEnabled && policyPassed,
    policyPassed,
    sampleCount: report.total,
    minDryRunSamples: policy.minDryRunSamples,
    passRate,
    requiredDryRunPassRate: policy.requiredDryRunPassRate,
    blockers,
    reasons: report.reasons,
  };
}

export interface RollingGateState {
  /** Number of qualifying rows scanned (cap = autoWriteRollingWindowSamples). */
  windowSize: number;
  /** How many rows in the window had quality.passed === true. */
  passCount: number;
  /** passCount / windowSize, or 1.0 when windowSize is 0 (insufficient data => not yet failing). */
  passRate: number;
  /** True when windowSize >= warmup AND passRate < threshold. */
  tripped: boolean;
  /** Per-reason histogram for diagnostic notify. */
  reasons: Record<string, number>;
  /**
   * The minimum windowSize required before the gate is allowed to
   * trip. Mirrors `requiredDryRunPassRate`'s warmup behavior: until
   * we have at least N samples we don't have signal.
   */
  warmup: number;
}

/**
 * Evaluate the rolling-quality circuit breaker for the auto-write
 * lane. Reads the most recent `windowSamples` rows that have a
 * quality gate (llm_dry_run + auto_write). Trips the breaker when the
 * pass rate falls below `passRateThreshold` AND we have enough
 * samples to make that judgment statistically meaningful (warmup =
 * windowSamples).
 *
 * Pure function over an already-fetched report so it composes with
 * any audit reader.
 */
export function evaluateRollingGate(
  report: LlmDryRunReport,
  windowSamples: number,
  passRateThreshold: number,
): RollingGateState {
  const windowSize = report.total;
  const passRate = windowSize === 0 ? 1.0 : report.passCount / windowSize;
  const warmup = Math.max(1, Math.floor(windowSamples));
  const tripped = windowSize >= warmup && passRate < passRateThreshold;
  return {
    windowSize,
    passCount: report.passCount,
    passRate,
    tripped,
    reasons: report.reasons,
    warmup,
  };
}

export function formatLlmAutoWriteReadiness(readiness: LlmAutoWriteReadiness): string {
  const lines: string[] = [
    `Sediment LLM auto-write readiness: ${readiness.ready ? "READY" : "NOT READY"}`,
    `Auto LLM write enabled: ${readiness.autoLlmWriteEnabled}`,
    `Dry-run samples: ${readiness.sampleCount}/${readiness.minDryRunSamples}`,
    `Pass rate: ${readiness.passRate.toFixed(3)} (required ${readiness.requiredDryRunPassRate})`,
    `Policy passed: ${readiness.policyPassed}`,
  ];

  if (readiness.blockers.length > 0) {
    lines.push("");
    lines.push("Blockers:");
    for (const blocker of readiness.blockers) lines.push(`- ${blocker}`);
  }

  const reasonEntries = Object.entries(readiness.reasons).sort((a, b) => b[1] - a[1]);
  if (reasonEntries.length > 0) {
    lines.push("");
    lines.push("Dry-run reasons:");
    for (const [reason, count] of reasonEntries) lines.push(`- ${reason}: ${count}`);
  }

  return lines.join("\n");
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
