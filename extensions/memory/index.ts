/**
 * memory extension for pi-astack — read-only markdown memory Facade.
 *
 * Phase 1 implementation (2026-05-08): project-level `.pensieve/` read tools
 * plus optional read-only `~/.abrain/` world store when present. Markdown + git
 * remain the source of truth; this extension never writes memory files.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { asBoolean, asNumber, resolveSettings } from "./settings";
import type { GetParams, ListFilters, NeighborsParams, SearchParams } from "./types";
import { loadEntries } from "./parser";
import { findEntry, listEntries, neighbors, searchEntries, serializeEntry } from "./search";
import { formatLintReport, lintTarget } from "./lint";
import { formatMigrationPlan, planMigrationDryRun } from "./migrate";
import { checkBacklinks, formatBacklinkReport, formatGraphRebuildReport, rebuildGraphIndex } from "./graph";
import { formatMarkdownIndexRebuildReport, rebuildMarkdownIndex } from "./index-file";
import { clamp, normalizeBareSlug, normalizeListFilters, normalizeSearchFilters, parseMaybeJson } from "./utils";

function registerMemoryCommand(pi: ExtensionAPI) {
  const maybePi = pi as unknown as {
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
    }) => void;
  };
  if (typeof maybePi.registerCommand !== "function") return;

  maybePi.registerCommand("memory", {
    description: "Memory maintenance commands: /memory lint [path], /memory migrate --dry-run [path], /memory check-backlinks [path], /memory rebuild --graph|--index [path]",
    getArgumentCompletions(prefix: string) {
      const items = [
        "lint", "lint .pensieve",
        "migrate --dry-run", "migrate --dry-run .pensieve",
        "check-backlinks", "check-backlinks .pensieve",
        "rebuild --graph", "rebuild --graph .pensieve",
        "rebuild --index", "rebuild --index .pensieve",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) {
      const cwd = path.resolve(ctx.cwd || process.cwd());
      const trimmed = args.trim();
      const [subcommand = "lint", ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const settings = resolveSettings();

      if (subcommand === "lint") {
        const targetArg = rest.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await lintTarget(target, settings);
        const message = formatLintReport(report, cwd);
        ctx.ui.notify(message, report.errorCount > 0 ? "error" : report.warningCount > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "migrate") {
        const dryRun = rest.includes("--dry-run") || rest.includes("-n");
        if (!dryRun) {
          ctx.ui.notify("Usage: /memory migrate --dry-run [path]. Actual writes are reserved for the sediment/migration writer.", "warning");
          return;
        }
        const targetParts = rest.filter((part) => part !== "--dry-run" && part !== "-n");
        const targetArg = targetParts.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await planMigrationDryRun(target, settings, undefined, cwd);
        ctx.ui.notify(formatMigrationPlan(report), report.migrateCount > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "check-backlinks") {
        const targetArg = rest.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const report = await checkBacklinks(target, settings, undefined, cwd);
        const severity = report.deadLinkCount > 0 ? "error" : report.missingSymmetricCount > 0 ? "warning" : "info";
        ctx.ui.notify(formatBacklinkReport(report), severity);
        return;
      }

      if (subcommand === "rebuild") {
        const graphFlag = rest.includes("--graph");
        const indexFlag = rest.includes("--index");
        if (!graphFlag && !indexFlag) {
          ctx.ui.notify("Usage: /memory rebuild --graph|--index [path]", "warning");
          return;
        }
        const targetParts = rest.filter((part) => part !== "--graph" && part !== "--index");
        const targetArg = targetParts.join(" ").trim();
        const target = targetArg ? path.resolve(cwd, targetArg) : path.join(cwd, ".pensieve");
        const messages: string[] = [];
        let severity: "info" | "warning" = "info";
        if (graphFlag) {
          const report = await rebuildGraphIndex(target, settings, undefined, cwd);
          messages.push(formatGraphRebuildReport(report));
          if (report.deadLinkCount > 0) severity = "warning";
        }
        if (indexFlag) {
          const report = await rebuildMarkdownIndex(target, settings, undefined, cwd);
          messages.push(formatMarkdownIndexRebuildReport(report));
        }
        ctx.ui.notify(messages.join("\n\n"), severity);
        return;
      }

      ctx.ui.notify("Usage: /memory lint [path] OR /memory migrate --dry-run [path] OR /memory check-backlinks [path] OR /memory rebuild --graph|--index [path]", "warning");
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerMemoryCommand(pi);

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description:
      "Search markdown memory using the unified read-only Facade. " +
      "Searches current project .pensieve/ and, when configured/present, ~/.abrain/. " +
      "Returns normalized cards without scope/backend/source_path so the LLM does not choose a backend.",
    promptSnippet: "memory_search(query, filters?: { kinds?, status?, limit? })",
    promptGuidelines: [
      "Use memory_search before planning, designing, reviewing code, or making project-specific decisions.",
      "Do not ask for a project/world/backend selector; the Facade merges and ranks results internally.",
      "Search results are summaries. Call memory_get(slug) when you need the full compiled truth or timeline.",
      "Default results exclude archived entries; pass filters.status if the user explicitly asks for archived/deprecated history.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      filters: Type.Optional(Type.Any({
        description: "Optional filters: { kinds?: string[], status?: string|string[], limit?: number }",
      })),
    }),
    prepareArguments(args: Record<string, unknown>) {
      return {
        query: String(args.query ?? ""),
        filters: normalizeSearchFilters(args.filters ?? args),
      };
    },
    async execute(_id: string, params: SearchParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      return searchEntries(entries, params, settings);
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Get Memory Entry",
    description:
      "Read one markdown memory entry by bare slug. Returns the full canonical entry " +
      "including scope and source_path because this is an exact lookup/debug view, not a ranking surface.",
    promptSnippet: "memory_get(slug, options?: { include_related?: boolean })",
    promptGuidelines: [
      "Call memory_get after memory_search when a result looks relevant and you need details.",
      "Slug is bare (e.g. avoid-long-argv-prompts), not project:/world:-prefixed.",
      "Set include_related=true when nearby decisions/patterns could affect interpretation.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "Bare slug to read" }),
      options: Type.Optional(Type.Any({
        description: "Optional: { include_related?: boolean }",
      })),
    }),
    prepareArguments(args: Record<string, unknown>) {
      const options = (parseMaybeJson(args.options) as Record<string, unknown>) ?? {};
      const includeRelated = asBoolean(
        options.include_related ?? options.includeRelated ?? args.include_related ?? args.includeRelated,
        false,
      );
      return {
        slug: String(args.slug ?? args.id ?? ""),
        options: { include_related: includeRelated },
      };
    },
    async execute(_id: string, params: GetParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      const { entry, alternatives } = findEntry(entries, params.slug);
      if (!entry) {
        return { ok: false, error: `memory entry not found: ${params.slug}`, slug: normalizeBareSlug(params.slug) };
      }
      return serializeEntry(entry, entries, !!params.options?.include_related, alternatives);
    },
  });

  pi.registerTool({
    name: "memory_list",
    label: "List Memory Entries",
    description:
      "List markdown memory metadata with pagination. Mostly for browsing/debugging; " +
      "use memory_search for relevance-ranked retrieval.",
    promptSnippet: "memory_list(filters?: { scope?, kind?, status?, limit?, cursor? })",
    promptGuidelines: [
      "Use memory_list when you need an overview of available memory entries or to browse by kind/status.",
      "Use memory_search for task-specific retrieval; list is not relevance-ranked.",
    ],
    parameters: Type.Object({
      filters: Type.Optional(Type.Any({
        description: "Optional filters: { scope?: 'project'|'world'|'all', kinds?: string[], status?: string|string[], limit?: number, cursor?: string }",
      })),
    }),
    prepareArguments(args: Record<string, unknown>) {
      return { filters: normalizeListFilters(args.filters ?? args) };
    },
    async execute(_id: string, params: { filters?: ListFilters }, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      return listEntries(entries, params.filters ?? {}, settings);
    },
  });

  pi.registerTool({
    name: "memory_neighbors",
    label: "Memory Neighbors",
    description:
      "Read-only graph traversal over frontmatter relations and body [[wikilinks]]. " +
      "Does not create or repair links.",
    promptSnippet: "memory_neighbors(slug, options?: { hop?: number, max?: number })",
    promptGuidelines: [
      "Use memory_neighbors to inspect related decisions/patterns after memory_get, especially when conflict or provenance matters.",
      "This is read-only graph traversal. Do not use it to declare relationships; only sediment may write relations.",
    ],
    parameters: Type.Object({
      slug: Type.String({ description: "Bare slug to traverse from" }),
      options: Type.Optional(Type.Any({
        description: "Optional: { hop?: number, max?: number }",
      })),
    }),
    prepareArguments(args: Record<string, unknown>) {
      const options = (parseMaybeJson(args.options) as Record<string, unknown>) ?? {};
      return {
        slug: String(args.slug ?? args.id ?? ""),
        options: {
          hop: clamp(Math.floor(asNumber(options.hop ?? args.hop, 1)), 1, 3),
          max: clamp(Math.floor(asNumber(options.max ?? args.max, 20)), 1, 100),
        },
      };
    },
    async execute(_id: string, params: NeighborsParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd?: string }) {
      const settings = resolveSettings();
      const entries = await loadEntries(ctx.cwd, settings, signal);
      const target = findEntry(entries, params.slug).entry;
      if (!target) {
        return { ok: false, error: `memory entry not found: ${params.slug}`, slug: normalizeBareSlug(params.slug), neighbors: [] };
      }
      return {
        slug: target.slug,
        neighbors: neighbors(
          entries,
          target.slug,
          params.options?.hop ?? 1,
          params.options?.max ?? 20,
        ),
      };
    },
  });
}
