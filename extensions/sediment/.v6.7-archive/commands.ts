/**
 * commands — slash-command handlers for sediment memory management.
 *
 * Part of pi-stack Slice E (ADR 0004 § 6).
 *
 * Registered as pi tools. The LLM calls them when the user types
 * /memory-pending, /memory-source, /memory-short-term, /memory-log-level.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readPending, countPending } from "./pending-queue";
import { writeLogEntry } from "./audit-logger";
import { existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PENDING_PATH = join(homedir(), ".pi", ".gbrain-cache", "sediment-pending.jsonl");
const TRUST_PATH = join(homedir(), ".pi", ".gbrain-cache", "source-trust.json");

// ── helpers ────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ── memory_pending ─────────────────────────────────────────────

export function registerMemoryPendingCommands(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_pending",
    label: "Memory Pending",
    description:
      "Review and manage sediment pending queue. Actions: list, review <id>, discard <id>, " +
      "discard-all (clear entire queue), force-default <id>, mark-scratch <id>.",
    promptSnippet: "/memory-pending list|review <id>|discard <id>|discard-all|mark-scratch <id>",
    promptGuidelines: [
      "Use /memory-pending list to see all pending memory candidates.",
      "Use /memory-pending review <id> to inspect a specific pending entry.",
      "Use /memory-pending discard <id> to remove a candidate.",
      "Use /memory-pending discard-all to clear the entire pending queue.",
      "Use /memory-pending mark-scratch <id> to create .gbrain-scratch in the candidate's repo.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | review <id> | discard <id> | discard-all | force-default <id> | mark-scratch <id>" }),
    }),
    async execute(_id: string, params: any) {
      const action = params.action?.trim() ?? "";

      // list
      if (action === "list") {
        const pending = readPending();
        if (pending.length === 0) {
          return { content: [{ type: "text" as const, text: "Pending queue is empty." }] };
        }
        const lines = pending.map((p, i) => {
          const reason = p.reason || "unknown";
          const preview = (p as any).candidatePreview || (p as any).contextHint || "(no preview)";
          return `[${i}] **${p.id}** (${reason})\n   ${preview.slice(0, 120)}`;
        });
        return {
          content: [{
            type: "text" as const,
            text: `## Pending queue (${pending.length} entries)\n\n${lines.join("\n\n")}`,
          }],
        };
      }

      // review <id>
      if (action.startsWith("review ")) {
        const id = action.slice(7).trim();
        const pending = readPending();
        const entry = pending.find((p) => p.id === id);
        if (!entry) {
          return { content: [{ type: "text" as const, text: `Pending entry "${id}" not found.` }], isError: true };
        }
        return {
          content: [{
            type: "text" as const,
            text: `## Pending: ${id}\n\n\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``,
          }],
        };
      }

      // discard <id>
      if (action.startsWith("discard ") && !action.startsWith("discard-all")) {
        const id = action.slice(8).trim();
        return removePendingItem(id);
      }

      // discard-all
      if (action === "discard-all") {
        try {
          writeFileSync(PENDING_PATH, "", "utf8");
          writeLogEntry({ type: "pending" as any, ts: new Date().toISOString(), jobId: "manual", reason: "discard-all" } as any);
          return { content: [{ type: "text" as const, text: "✅ Pending queue cleared." }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed: ${e.message}` }], isError: true };
        }
      }

      // mark-scratch <id>
      if (action.startsWith("mark-scratch ")) {
        const id = action.slice(13).trim();
        const pending = readPending();
        const entry = pending.find((p) => p.id === id);
        if (!entry) {
          return { content: [{ type: "text" as const, text: `Pending entry "${id}" not found.` }], isError: true };
        }
        // Write .gbrain-scratch to the repo dir (use cwd as hint)
        const scratchPath = join(process.cwd(), ".gbrain-scratch");
        try {
          writeFileSync(scratchPath, "# sediment scratch marker\n", "utf8");
          return { content: [{ type: "text" as const, text: `✅ Created .gbrain-scratch at ${scratchPath}. Sediment will skip this repo.` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed: ${e.message}` }], isError: true };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Unknown action: "${action}". Use: list | review <id> | discard <id> | discard-all | mark-scratch <id>`,
        }],
        isError: true,
      };
    },
  });
}

// ── memory_source ──────────────────────────────────────────────

export function registerMemorySourceCommands(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_source",
    label: "Memory Source",
    description:
      "Manage gbrain source registrations and trust. Actions: list, trust <path>, attach <source> [--path <path>].",
    promptSnippet: "/memory-source list|trust <path>|attach <source> [--path <path>]",
    promptGuidelines: [
      "Use /memory-source list to see registered sources and trust status.",
      "Use /memory-source trust <path> to add a trusted path to the trust registry.",
      "Use /memory-source attach <source> to register a new gbrain source.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | trust <path> | attach <source> [--path <path>]" }),
    }),
    async execute(_id: string, params: any) {
      const action = params.action?.trim() ?? "";

      // list
      if (action === "list") {
        try {
          const trustData = existsSync(TRUST_PATH) ? readFileSync(TRUST_PATH, "utf8") : "[]";
          const entries = JSON.parse(trustData);
          if (entries.length === 0) {
            return { content: [{ type: "text" as const, text: "No trusted sources registered." }] };
          }
          const lines = entries.map((e: any) =>
            `- **${e.source_id}** → \`${e.trusted_root}\` (added ${e.added_at ?? "unknown"})`,
          );
          return {
            content: [{ type: "text" as const, text: `## Trusted sources\n\n${lines.join("\n")}` }],
          };
        } catch {
          return { content: [{ type: "text" as const, text: "No trust registry found." }] };
        }
      }

      // trust <path>
      if (action.startsWith("trust ")) {
        const path = action.slice(6).trim();
        // Add to source-trust.json
        try {
          const { realpathSync } = await import("node:fs");
          const resolved = realpathSync(path);
          const trustData = existsSync(TRUST_PATH) ? JSON.parse(readFileSync(TRUST_PATH, "utf8")) : [];
          const sourceId = "pi-stack"; // default for now
          trustData.push({
            source_id: sourceId,
            trusted_root: resolved,
            added_at: new Date().toISOString(),
            added_by: "user",
          });
          writeFileSync(TRUST_PATH, JSON.stringify(trustData, null, 2), "utf8");
          return { content: [{ type: "text" as const, text: `✅ Trusted path ${resolved} added for source "${sourceId}".` }] };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Failed: ${e.message}` }], isError: true };
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Unknown action: "${action}". Use: list | trust <path> | attach <source>`,
        }],
        isError: true,
      };
    },
  });
}

// ── memory_log_level ───────────────────────────────────────────

let currentLogLevel = "verbose";

export function registerMemoryLogLevelCommand(pi: ExtensionAPI) {
  pi.registerTool({
    name: "memory_log_level",
    label: "Memory Log Level",
    description: "Switch sediment log detail level: verbose, normal, quiet.",
    promptSnippet: "/memory-log-level verbose|normal|quiet",
    promptGuidelines: [
      "Use /memory-log-level to change sediment log verbosity.",
    ],
    parameters: Type.Object({
      level: Type.String({ description: "verbose | normal | quiet" }),
    }),
    async execute(_id: string, params: any) {
      const level = params.level?.trim().toLowerCase();
      if (!["verbose", "normal", "quiet"].includes(level)) {
        return {
          content: [{ type: "text" as const, text: `Invalid level: "${level}". Use verbose, normal, or quiet.` }],
          isError: true,
        };
      }
      currentLogLevel = level;
      return { content: [{ type: "text" as const, text: `✅ Sediment log level set to "${level}".` }] };
    },
  });
}

export { currentLogLevel };

// ── utility ────────────────────────────────────────────────────

function removePendingItem(id: string) {
  try {
    const pending = readPending();
    const idx = pending.findIndex((p) => p.id === id);
    if (idx === -1) {
      return { content: [{ type: "text" as const, text: `Pending entry "${id}" not found.` }], isError: true };
    }
    pending.splice(idx, 1);
    // Rewrite the file
    const lines = pending.map((p) => JSON.stringify(p)).join("\n") + (pending.length > 0 ? "\n" : "");
    writeFileSync(PENDING_PATH, lines, "utf8");
    writeLogEntry({ type: "pending" as any, ts: new Date().toISOString(), jobId: "manual", reason: `discard ${id}` } as any);
    return { content: [{ type: "text" as const, text: `✅ Discarded pending entry "${id}".` }] };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Failed: ${e.message}` }], isError: true };
  }
}
