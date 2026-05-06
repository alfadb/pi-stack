/**
 * multi-agent extension for pi-stack — sub-agent dispatch.
 *
 * Self-contained rewrite (2026-05-06). No external dependencies beyond pi SDK.
 *
 * Registers:
 *   dispatch_agent  — single task dispatch
 *   dispatch_agents — parallel multi-task dispatch
 *
 * Security:
 *   - input-compat layer (stringified args, task normalization)
 *   - tool allowlist (mutating tools blocked by default)
 *   - no nested dispatch
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { coerceTasksParam, normalizeTaskSpec } from "./input-compat";
import { validateToolAllowlist, isEscalationAttempt, formatAllowlistReport } from "./allowlist";
import { runSingleTask, runParallel, type TaskSpec, type RunnerCtx } from "./runner";

// ── Result formatting ───────────────────────────────────────────

function formatSingleResult(r: { taskId: string; model: string; durationMs: number; output: string; error?: string }): string {
  const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
  if (r.error) {
    return `## ${r.model}\n❌ Error (${duration}): ${r.error}`;
  }
  const preview = r.output.length > 300
    ? r.output.slice(0, 300).replace(/\n/g, " ") + "..."
    : r.output.replace(/\n/g, " ");
  return `## ${r.model} ✅ (${duration})\n${preview}`;
}

function formatResults(results: Awaited<ReturnType<typeof runParallel>>): string {
  const lines: string[] = ["## Dispatch Results\n"];

  // Summary table
  lines.push("| # | Model | Duration | Status | Preview |");
  lines.push("|---|-------|----------|--------|---------|");
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const status = r.error ? "❌" : "✅";
    const preview = r.output.slice(0, 80).replace(/\n/g, " ").replace(/\|/g, "\\|") || "-";
    lines.push(`| ${i + 1} | ${r.model} | ${dur} | ${status} | ${preview} |`);
  }
  lines.push("");

  // Full outputs
  for (const r of results) {
    lines.push(`### ${r.model}`);
    if (r.error) {
      lines.push(`❌ ${r.error}`);
    } else {
      lines.push(r.output);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════
  // dispatch_agent
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_agent",
    label: "Dispatch Agent",
    description:
      "Spawn a single sub-agent with a specific model and thinking level. " +
      "Sub-agents have no tools by default; specify `tools` to grant access. " +
      "Mutating tools (bash, edit, write) are blocked unless PI_MULTI_AGENT_ALLOW_MUTATING=1.",
    promptSnippet: "dispatch_agent(model, thinking, prompt, tools?, timeoutMs?)",
    promptGuidelines: [
      "Use dispatch_agent to delegate single analysis/reasoning tasks to a specific model.",
      "Specify tools='readonly' to grant read, grep, find, ls.",
      "Mutating tools (bash, edit, write) are blocked by default for sub-agents.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
      thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
      prompt: Type.String({ description: "Prompt sent to this task" }),
      tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist or 'readonly'" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 300000)" })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const n = normalizeTaskSpec(args);
      return {
        model: n.model,
        thinking: n.thinking,
        prompt: n.prompt,
        tools: n.tools,
        timeoutMs: n.timeoutMs,
      };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      // Validate tool allowlist
      const toolsResult = validateToolAllowlist(params.tools, params.model);
      if (isEscalationAttempt(toolsResult)) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ All requested tools blocked.\n\n${formatAllowlistReport(toolsResult)}`,
          }],
          details: { toolsBlocked: toolsResult.blocked },
          isError: true,
        };
      }

      const task: TaskSpec = {
        id: `task-${Date.now()}`,
        model: params.model,
        thinking: params.thinking,
        prompt: params.prompt,
        tools: toolsResult.allowed.join(",") || undefined,
        timeoutMs: params.timeoutMs ?? 300_000,
      };

      const rctx: RunnerCtx = {
        cwd: ctx.cwd ?? process.cwd(),
        modelRegistry: ctx.modelRegistry,
        signal,
      };

      const result = await runSingleTask(task, rctx);
      const text = formatSingleResult(result);

      return {
        content: [{ type: "text" as const, text }],
        details: {
          toolsAllowed: toolsResult.allowed,
          toolsBlocked: toolsResult.blocked,
          warnings: toolsResult.warnings,
          ...(result.usage ? { usage: result.usage } : {}),
        },
        ...(result.error ? { isError: true } : {}),
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_agents
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_agents",
    label: "Dispatch Agents",
    description:
      "Spawn multiple sub-agents in parallel with different models. " +
      "Each task runs independently; results are collected when all complete. " +
      "Sub-agents have no tools by default. Mutating tools blocked by default.",
    promptSnippet: "dispatch_agents(tasks[{model, thinking, prompt, tools?}], timeoutMs?)",
    promptGuidelines: [
      "Use dispatch_agents for parallel multi-model analysis, review, or voting.",
      "Each task can use a different model and different tools.",
      "For reasoning-only tasks, omit tools.",
      "For tasks needing read access, use tools='readonly'.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
          thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
          prompt: Type.String({ description: "Prompt sent to this task" }),
          tools: Type.Optional(Type.String({ description: "Comma-separated tool allowlist or 'readonly' })),
          timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 300000)" })),
        }),
        { description: "Array of task specifications (max 16)" },
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 300000)" })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const raw = coerceTasksParam((args as any).tasks);
      const tasks = raw.slice(0, 16).map((t: unknown) => {
        const n = normalizeTaskSpec(t);
        return {
          model: n.model,
          thinking: n.thinking,
          prompt: n.prompt,
          tools: n.tools,
          timeoutMs: n.timeoutMs,
        };
      });
      return { tasks, timeoutMs: (args as any).timeoutMs };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const rawTasks = params.tasks ?? [];
      if (rawTasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks provided." }],
          isError: true,
        };
      }

      const taskSpecs: TaskSpec[] = [];
      const allWarnings: string[] = [];
      const timeoutMs = params.timeoutMs ?? 300_000;

      for (let i = 0; i < rawTasks.length; i++) {
        const t = rawTasks[i];
        const toolsResult = validateToolAllowlist(t.tools, t.model);

        if (isEscalationAttempt(toolsResult)) {
          allWarnings.push(
            `Task ${i + 1} (${t.model}): ALL tools blocked — ${formatAllowlistReport(toolsResult)}`,
          );
          continue;
        }

        if (toolsResult.warnings.length > 0) {
          allWarnings.push(`Task ${i + 1}: ${toolsResult.warnings.join("; ")}`);
        }

        taskSpecs.push({
          id: `task-${i}`,
          model: t.model,
          thinking: t.thinking,
          prompt: t.prompt,
          tools: toolsResult.allowed.join(",") || undefined,
          timeoutMs: t.timeoutMs ?? timeoutMs,
        });
      }

      if (taskSpecs.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ All ${rawTasks.length} task(s) blocked.\n\n${allWarnings.join("\n")}`,
          }],
          isError: true,
        };
      }

      const rctx: RunnerCtx = {
        cwd: ctx.cwd ?? process.cwd(),
        modelRegistry: ctx.modelRegistry,
        signal,
      };

      const results = await runParallel(taskSpecs, rctx);
      let text = formatResults(results);

      if (allWarnings.length > 0) {
        text += "\n⚠️ Warnings:\n" + allWarnings.map((w) => "- " + w).join("\n");
      }

      const hasErrors = results.some((r) => r.error);
      return {
        content: [{ type: "text" as const, text }],
        ...(hasErrors ? { isError: true } : {}),
      };
    },
  });
}
