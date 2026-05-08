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
import { writeProjectEntry } from "./writer";

function registerSedimentCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("sediment", {
    description: "Sediment writer status and smoke test: /sediment status, /sediment smoke --dry-run",
    getArgumentCompletions(prefix: string) {
      const items = ["status", "smoke --dry-run"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const settings = resolveSedimentSettings();
      const [subcommand = "status", ...rest] = args.trim() ? args.trim().split(/\s+/) : [];

      if (subcommand === "status") {
        ctx.ui.notify(
          [
            `Sediment enabled: ${settings.enabled}`,
            `Git commit: ${settings.gitCommit}`,
            `Lock timeout: ${settings.lockTimeoutMs}ms`,
            "Extractor: not implemented in this slice",
          ].join("\n"),
          "info",
        );
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

      ctx.ui.notify("Usage: /sediment status OR /sediment smoke --dry-run", "warning");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerSedimentCommand(pi);

  pi.on("agent_end", async (_event: unknown, ctx: { cwd?: string; ui?: { notify(message: string, type?: string): void } }) => {
    const settings = resolveSedimentSettings();
    if (!settings.enabled) return;

    // The writer substrate is ready, but automatic extract/classify/dedupe is
    // deliberately deferred to the next slice. Fail closed rather than writing
    // low-confidence memories from an incomplete extractor.
    ctx.ui?.notify?.("Sediment is enabled, but extractor is not implemented yet; no memory write attempted.", "warning");
  });
}
