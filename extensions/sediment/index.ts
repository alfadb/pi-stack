/**
 * sediment extension for pi-astack — project-only markdown writer skeleton.
 *
 * Phase 1.4 foundation: lock + sanitize + lint + atomic markdown write + audit
 * + best-effort git commit. LLM extraction is intentionally not implemented in
 * this slice; the agent_end hook is disabled by default via settings.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSedimentSettings } from "./settings";
import { buildRunWindow, checkpointSummary, hasPensieve, loadCheckpoint, saveCheckpoint } from "./checkpoint";
import { detectProjectDuplicate } from "./dedupe";
import { parseExplicitMemoryBlocks, previewExtraction } from "./extractor";
import { runLlmExtractorDryRun, summarizeLlmExtractorDryRun } from "./llm-extractor";
import { migrateOne } from "./migration";
import { resolveSettings as resolveMemorySettings } from "../memory/settings";
import { evaluateLlmAutoWriteReadiness, formatLlmAutoWriteReadiness, formatLlmDryRunReport, readLlmDryRunReport } from "./report";
import { appendAudit, writeProjectEntry, type WriteProjectEntryResult } from "./writer";

function shouldAdvanceAfterResults(results: WriteProjectEntryResult[]): boolean {
  const terminalReasons = new Set([
    "duplicate_slug", "duplicate_title", "validation_error", "lint_error",
  ]);
  return results.every((result) => {
    if (result.status === "created" || result.status === "dry_run") return true;
    if (!result.reason) return false;
    return terminalReasons.has(result.reason) || result.reason.startsWith("credential pattern detected");
  });
}

function registerSedimentCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; modelRegistry?: unknown; signal?: AbortSignal; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("sediment", {
    description: "Sediment writer status/window/extract/dedupe/report/readiness/migrate-one and smoke test: /sediment status, /sediment window --dry-run, /sediment extract --dry-run, /sediment llm --dry-run, /sediment llm-report, /sediment readiness, /sediment dedupe --title <title>, /sediment migrate-one --plan <file>, /sediment migrate-one --apply --yes <file>, /sediment smoke --dry-run",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "window --dry-run", "extract --dry-run", "llm --dry-run", "llm-report", "readiness", "dedupe --title ", "migrate-one --plan ", "migrate-one --apply --yes ", "smoke --dry-run"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; modelRegistry?: unknown; signal?: AbortSignal; ui: { notify(message: string, type?: string): void } }) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const settings = resolveSedimentSettings();
      const [subcommand = "status", ...rest] = args.trim() ? args.trim().split(/\s+/) : [];

      if (subcommand === "status") {
        ctx.ui.notify(
          [
            `Sediment enabled: ${settings.enabled}`,
            `Git commit: ${settings.gitCommit}`,
            `Lock timeout: ${settings.lockTimeoutMs}ms`,
            `Window: min=${settings.minWindowChars} chars, max=${settings.maxWindowChars} chars, entries=${settings.maxWindowEntries}`,
            `LLM extractor model: ${settings.extractorModel}`,
            `Auto LLM write enabled: ${settings.autoLlmWriteEnabled}`,
            `Auto LLM write gate: samples>=${settings.minDryRunSamples}, passRate>=${settings.requiredDryRunPassRate}`,
            "Auto LLM extractor: dry-run command only; agent_end uses explicit MEMORY blocks",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "window") {
        if (!rest.includes("--dry-run")) {
          ctx.ui.notify("Usage: /sediment window --dry-run", "warning");
          return;
        }
        if (!ctx.sessionManager?.getBranch) {
          ctx.ui.notify("Session manager unavailable; cannot build sediment window", "error");
          return;
        }
        const checkpoint = await loadCheckpoint(cwd);
        const window = buildRunWindow(ctx.sessionManager.getBranch(), checkpoint, settings);
        ctx.ui.notify(JSON.stringify(checkpointSummary(window), null, 2), window.skipReason ? "warning" : "info");
        return;
      }

      if (subcommand === "extract") {
        if (!rest.includes("--dry-run")) {
          ctx.ui.notify("Usage: /sediment extract --dry-run", "warning");
          return;
        }
        if (!ctx.sessionManager?.getBranch) {
          ctx.ui.notify("Session manager unavailable; cannot build sediment window", "error");
          return;
        }
        const checkpoint = await loadCheckpoint(cwd);
        const window = buildRunWindow(ctx.sessionManager.getBranch(), checkpoint, settings);
        const drafts = window.skipReason ? [] : parseExplicitMemoryBlocks(window.text);
        ctx.ui.notify(JSON.stringify({ window: checkpointSummary(window), extraction: previewExtraction(drafts) }, null, 2), drafts.length > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "llm") {
        if (!rest.includes("--dry-run")) {
          ctx.ui.notify("Usage: /sediment llm --dry-run", "warning");
          return;
        }
        if (!ctx.sessionManager?.getBranch) {
          ctx.ui.notify("Session manager unavailable; cannot build sediment window", "error");
          return;
        }
        if (!ctx.modelRegistry) {
          ctx.ui.notify("Model registry unavailable; cannot run LLM extractor", "error");
          return;
        }
        const checkpoint = await loadCheckpoint(cwd);
        const window = buildRunWindow(ctx.sessionManager.getBranch(), checkpoint, settings);
        if (window.skipReason) {
          ctx.ui.notify(JSON.stringify({ window: checkpointSummary(window), extraction: previewExtraction([]) }, null, 2), "warning");
          return;
        }
        const result = await runLlmExtractorDryRun(window.text, {
          settings,
          modelRegistry: ctx.modelRegistry as Parameters<typeof runLlmExtractorDryRun>[1]["modelRegistry"],
          signal: ctx.signal,
        });
        const llm = summarizeLlmExtractorDryRun(result, {
          maxCandidates: settings.extractorMaxCandidates,
          rawPreviewChars: settings.extractorAuditRawChars,
        });
        if (hasPensieve(cwd)) {
          await appendAudit(cwd, {
            operation: "llm_dry_run",
            ...checkpointSummary(window),
            llm,
            checkpoint_advanced: false,
          });
        }
        ctx.ui.notify(JSON.stringify({ window: checkpointSummary(window), llm }, null, 2), llm.ok ? (llm.quality.passed ? "info" : "warning") : "error");
        return;
      }

      if (subcommand === "llm-report") {
        const limitFlagIndex = rest.indexOf("--limit");
        const limit = limitFlagIndex >= 0 ? Number(rest[limitFlagIndex + 1]) : undefined;
        const report = await readLlmDryRunReport(cwd, limit);
        ctx.ui.notify(formatLlmDryRunReport(report), report.failCount > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "readiness") {
        const report = await readLlmDryRunReport(cwd, settings.minDryRunSamples);
        const readiness = evaluateLlmAutoWriteReadiness(report, settings);
        ctx.ui.notify(formatLlmAutoWriteReadiness(readiness), readiness.ready ? "info" : "warning");
        return;
      }

      if (subcommand === "dedupe") {
        const titleFlagIndex = rest.indexOf("--title");
        const title = titleFlagIndex >= 0 ? rest.slice(titleFlagIndex + 1).join(" ").trim() : rest.join(" ").trim();
        if (!title) {
          ctx.ui.notify("Usage: /sediment dedupe --title <title>", "warning");
          return;
        }
        const result = await detectProjectDuplicate(cwd, title);
        ctx.ui.notify(JSON.stringify(result, null, 2), result.duplicate ? "warning" : "info");
        return;
      }

      if (subcommand === "migrate-one") {
        const plan = rest.includes("--plan");
        const apply = rest.includes("--apply");
        const yes = rest.includes("--yes");
        const fileParts = rest.filter((part) => part !== "--plan" && part !== "--apply" && part !== "--yes");
        const source = fileParts.join(" ").trim();
        if (!source || (plan && apply) || (!plan && !apply)) {
          ctx.ui.notify("Usage: /sediment migrate-one --plan <file> OR /sediment migrate-one --apply --yes <file>", "warning");
          return;
        }
        const result = await migrateOne(source, {
          projectRoot: cwd,
          sedimentSettings: settings,
          memorySettings: resolveMemorySettings(),
          apply,
          yes,
          plan,
        });
        ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "applied" || result.status === "dry_run" ? "info" : "warning");
        return;
      }

      if (subcommand === "smoke") {
        if (!rest.includes("--dry-run")) {
          ctx.ui.notify("Usage: /sediment smoke --dry-run (apply is intentionally not exposed)", "warning");
          return;
        }
        const result = await writeProjectEntry({
          title: "sediment writer smoke test",
          kind: "fact",
          status: "provisional",
          confidence: settings.defaultConfidence,
          compiledTruth: "# Sediment Writer Smoke Test\n\nThis dry-run validates project-only writer plumbing without writing markdown.",
          timelineNote: "dry-run smoke test",
        }, { projectRoot: cwd, settings, dryRun: true });
        ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "rejected" ? "error" : "info");
        return;
      }

      ctx.ui.notify("Usage: /sediment status OR /sediment window --dry-run OR /sediment extract --dry-run OR /sediment llm --dry-run OR /sediment llm-report [--limit N] OR /sediment readiness OR /sediment dedupe --title <title> OR /sediment migrate-one --plan <file> OR /sediment migrate-one --apply --yes <file> OR /sediment smoke --dry-run", "warning");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSedimentCommand(pi);

  pi.on("agent_end", async (_event: unknown, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; ui?: { notify(message: string, type?: string): void } }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;

    const cwd = path.resolve(ctx.cwd || process.cwd());
    if (!hasPensieve(cwd) || !ctx.sessionManager?.getBranch) return;

    const checkpoint = await loadCheckpoint(cwd);
    const window = buildRunWindow(ctx.sessionManager.getBranch(), checkpoint, settings);
    const summary = checkpointSummary(window);

    if (window.skipReason || !window.lastEntryId) {
      if (window.lastEntryId) await saveCheckpoint(cwd, { lastProcessedEntryId: window.lastEntryId });
      await appendAudit(cwd, {
        operation: "skip",
        reason: window.skipReason ?? "no_last_entry",
        ...summary,
        extractor: "explicit_marker",
        checkpoint_advanced: !!window.lastEntryId,
      });
      return;
    }

    const drafts = parseExplicitMemoryBlocks(window.text);
    if (drafts.length === 0) {
      await saveCheckpoint(cwd, { lastProcessedEntryId: window.lastEntryId });
      await appendAudit(cwd, {
        operation: "skip",
        reason: "no_explicit_memory_markers",
        ...summary,
        extractor: "explicit_marker",
        checkpoint_advanced: true,
      });
      return;
    }

    const results: WriteProjectEntryResult[] = [];
    for (const draft of drafts) {
      results.push(await writeProjectEntry({
        ...draft,
        sessionId: "sediment",
        timelineNote: draft.timelineNote || "captured from explicit MEMORY block",
      }, { projectRoot: cwd, settings, dryRun: false }));
    }

    const shouldAdvance = shouldAdvanceAfterResults(results);
    if (shouldAdvance) await saveCheckpoint(cwd, { lastProcessedEntryId: window.lastEntryId });
    await appendAudit(cwd, {
      operation: "explicit_extract",
      ...summary,
      extractor: "explicit_marker",
      candidate_count: drafts.length,
      results: results.map((result) => ({ status: result.status, slug: result.slug, reason: result.reason })),
      checkpoint_advanced: shouldAdvance,
    });

    ctx.ui?.notify?.(
      `Sediment explicit marker extraction: ${results.map((r) => `${r.slug}:${r.status}${r.reason ? `(${r.reason})` : ""}`).join(", ")}`,
      shouldAdvance ? "info" : "warning",
    );
  });
}
