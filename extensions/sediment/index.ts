/**
 * sediment extension for pi-astack — project-only markdown writer skeleton.
 *
 * Phase 1.4 foundation: lock + sanitize + lint + atomic markdown write + audit
 * + best-effort git commit. LLM extraction is intentionally not implemented in
 * this slice; the agent_end hook is disabled by default via settings.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveSedimentSettings } from "./settings";
import { buildRunWindow, checkpointSummary, loadCheckpoint } from "./checkpoint";
import { appendAudit, writeProjectEntry } from "./writer";

function registerSedimentCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("sediment", {
    description: "Sediment writer status/window and smoke test: /sediment status, /sediment window --dry-run, /sediment smoke --dry-run",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "window --dry-run", "smoke --dry-run"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; ui: { notify(message: string, type?: string): void } }) {
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
            "Extractor: not implemented in this slice",
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

      ctx.ui.notify("Usage: /sediment status OR /sediment window --dry-run OR /sediment smoke --dry-run", "warning");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSedimentCommand(pi);

  pi.on("agent_end", async (_event: unknown, ctx: { cwd?: string; sessionManager?: { getBranch(): unknown[] }; ui?: { notify(message: string, type?: string): void } }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;

    const cwd = path.resolve(ctx.cwd || process.cwd());
    if (!ctx.sessionManager?.getBranch) return;

    const checkpoint = await loadCheckpoint(cwd);
    const window = buildRunWindow(ctx.sessionManager.getBranch(), checkpoint, settings);
    await appendAudit(cwd, {
      operation: "window",
      ...checkpointSummary(window),
      extractor: "not_implemented",
      checkpoint_advanced: false,
    });

    // The writer substrate and windowing are ready, but automatic
    // extract/classify/dedupe is deliberately deferred to the next slice. Do
    // not advance checkpoint here; future extractor must see this window.
    ctx.ui?.notify?.("Sediment is enabled; window captured/audited, but extractor is not implemented yet. Checkpoint not advanced.", "warning");
  });
}
