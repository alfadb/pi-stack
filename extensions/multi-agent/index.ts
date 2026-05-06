/**
 * multi-agent extension for pi-stack — sub-agent dispatch with tool allowlist.
 *
 * Part of pi-stack Slice C (ADR 0009).
 *
 * Registers:
 *   dispatch_agent  — single task dispatch
 *   dispatch_agents — multiple task parallel dispatch
 *
 * Security layers:
 *   - input-compat: prepareArguments hook for stringified/coerced args
 *   - tool allowlist: blocks mutating tools by default, blocks nested dispatch
 *   - strict schema: TypeBox parameters, no Type.Any()
 *
 * Delegates actual model dispatch to the existing pi-multi-agent infrastructure.
 * Import paths are relative to the pi-multi-agent skill package.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { coerceTasksParam, normalizeTaskSpec } from "./input-compat";
import { validateToolAllowlist, isEscalationAttempt, formatAllowlistReport } from "./allowlist";

// ── Import pi-multi-agent internals ─────────────────────────────

const MULTI_AGENT_ROOT = `${process.env.HOME}/.pi/agent/skills/pi-multi-agent/extensions/pi-multi-agent`;

async function getMultiAgentInternals(): Promise<{
  resolveModels: Function;
  executeParallel: Function;
  RunnerCtx: any;
  Task: any;
  DispatchOptions: any;
  ResolvedModel: any;
  DEFAULT_CONFIG: any;
}> {
  const [
    { executeParallel },
    { runTask, missingModelResult, type: _RunnerCtx },
  ] = await Promise.all([
    import(`${MULTI_AGENT_ROOT}/strategies/parallel.js`),
    import(`${MULTI_AGENT_ROOT}/runner.js`),
  ]);

  // resolveModels is defined in index.ts of pi-multi-agent, not exported.
  // We inline a simplified version here instead.
  return { resolveModels: null as any, executeParallel, RunnerCtx: null, Task: null, DispatchOptions: null, ResolvedModel: null, DEFAULT_CONFIG: null };
}

// ── Inline model resolution (simplified from pi-multi-agent) ───

async function resolveModels(
  tasks: Array<{ id: string; model: string }>,
  registry: any,
): Promise<Map<string, any>> {
  const resolved = new Map<string, any>();

  const resolveOne = async (id: string, modelStr: string) => {
    const [provider, modelId] = modelStr.split("/");
    if (!provider || !modelId) {
      console.error(`[pi-stack/multi-agent] Invalid model ref: ${modelStr}`);
      return;
    }
    const model = registry.find(provider, modelId);
    if (!model) {
      console.error(`[pi-stack/multi-agent] Model not found: ${modelStr}`);
      return;
    }
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      console.error(`[pi-stack/multi-agent] Auth failed for ${modelStr}: ${auth.error ?? "no key"}`);
      return;
    }
    resolved.set(id, {
      provider,
      modelId,
      model,
      apiKey: auth.apiKey,
      headers: auth.headers ?? {},
      baseUrl: model.baseUrl,
    });
  };

  await Promise.all(tasks.map((t) => resolveOne(t.id, t.model)));
  return resolved;
}

// ── Execution ───────────────────────────────────────────────────

async function runDispatch(
  tasks: Array<{
    id: string;
    model: string;
    thinking: string;
    prompt: string;
    tools?: string;
    role?: string;
  }>,
  ctx: any,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  try {
    // Resolve models via ctx.modelRegistry (pi's internal registry)
    const resolvedModels = await resolveModels(tasks, ctx.modelRegistry);

    // Import and run executeParallel
    const { executeParallel } = await import(
      `${MULTI_AGENT_ROOT}/strategies/parallel.js`
    );
    const { runTask, missingModelResult } = await import(
      `${MULTI_AGENT_ROOT}/runner.js`
    );

    // Build RunnerCtx
    const rctx = {
      cwd: ctx.cwd ?? process.cwd(),
      modelRegistry: ctx.modelRegistry,
      visionPrefs: [] as string[],
      taskTimeoutMs: timeoutMs,
      signal,
      dispatchId: `pi-stack-${Date.now()}`,
      strategy: "parallel",
    };

    const jobs = tasks.map((task) => {
      const resolved = resolvedModels.get(task.id);
      if (!resolved) return Promise.resolve(missingModelResult(task));
      return runTask(task, resolved, rctx);
    });

    const results = await Promise.all(jobs);

    // Format results
    const lines: string[] = [];
    lines.push(`## dispatch_agents result\n`);
    lines.push(`| Task | Model | Duration | Result |`);
    lines.push(`|------|-------|----------|--------|`);

    for (const r of results) {
      const duration = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : "?";
      const status = r.error ? `❌ ${r.error}` : "✅";
      const preview = r.output ? r.output.slice(0, 200).replace(/\n/g, " ") : "";
      lines.push(`| ${r.taskId} | ${r.model} | ${duration} | ${status} ${preview} |`);
    }

    lines.push("");
    for (const r of results) {
      if (r.output) {
        lines.push(`### ${r.taskId} (${r.model})\n`);
        lines.push(r.output);
        lines.push("");
      }
    }

    return lines.join("\n");
  } catch (e: any) {
    return `dispatch_agents failed: ${e.message ?? e}`;
  }
}

// ── Extension ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════════════════════════════
  // dispatch_agent — single task
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
      "Specify tools='readonly' to grant read, grep, find, ls, gbrain_search, gbrain_get, gbrain_query.",
      "Mutating tools (bash, edit, write) are blocked by default for sub-agents.",
    ],
    parameters: Type.Object({
      model: Type.String({
        description: 'Provider/model e.g. "openai/gpt-5.5"',
      }),
      thinking: Type.String({
        description: "Thinking level: off, minimal, low, medium, high, xhigh",
      }),
      prompt: Type.String({
        description: "Prompt sent to this task",
      }),
      tools: Type.Optional(Type.String({
        description: "Comma-separated tool allowlist or 'readonly'",
      })),
      timeoutMs: Type.Optional(Type.Number({
        description: "Per-task timeout in ms (default 300000)",
      })),
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
      const toolsResult = validateToolAllowlist(params.tools, params.model);
      if (isEscalationAttempt(toolsResult)) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ All requested tools blocked for sub-agent.\n\n${formatAllowlistReport(toolsResult)}`,
          }],
          isError: true,
        };
      }

      const result = await runDispatch(
        [{
          id: `agent-${Date.now()}`,
          model: params.model,
          thinking: params.thinking,
          prompt: params.prompt,
          tools: toolsResult.allowed.join(",") || undefined,
        }],
        ctx,
        signal,
        params.timeoutMs ?? 300_000,
      );

      return {
        content: [{ type: "text" as const, text: result }],
        details: {
          toolsAllowed: toolsResult.allowed,
          toolsBlocked: toolsResult.blocked,
        },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // dispatch_agents — multiple tasks
  // ═══════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "dispatch_agents",
    label: "Dispatch Agents",
    description:
      "Spawn multiple sub-agents in parallel with different models. " +
      "Each task runs independently; results are collected when all complete. " +
      "Sub-agents have no tools by default. Mutating tools blocked by default.",
    promptSnippet: "dispatch_agents(tasks[{model, thinking, prompt, tools?}])",
    promptGuidelines: [
      "Use dispatch_agents for parallel multi-model analysis, review, or voting.",
      "Each task can use a different model and different tools.",
      "For reasoning-only tasks, omit tools.",
      "For tasks needing read access, use tools='readonly'.",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({
            description: 'Provider/model e.g. "openai/gpt-5.5"',
          }),
          thinking: Type.String({
            description: "Thinking level: off, minimal, low, medium, high, xhigh",
          }),
          prompt: Type.String({
            description: "Prompt sent to this task",
          }),
          tools: Type.Optional(Type.String({
            description: "Comma-separated tool allowlist or 'readonly'",
          })),
          timeoutMs: Type.Optional(Type.Number({
            description: "Per-task timeout in ms (default 300000)",
          })),
        }),
        { description: "Array of task specifications (max 16)" },
      ),
      timeoutMs: Type.Optional(Type.Number({
        description: "Per-task timeout in ms (default 300000)",
      })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const raw = coerceTasksParam((args as any).tasks);
      const tasks = raw.map((t: unknown) => {
        const n = normalizeTaskSpec(t);
        return {
          model: n.model,
          thinking: n.thinking,
          prompt: n.prompt,
          tools: n.tools,
          timeoutMs: n.timeoutMs,
        };
      });
      return {
        tasks: tasks.slice(0, 16),
        timeoutMs: (args as any).timeoutMs,
      };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const tasks = params.tasks ?? [];
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks provided." }],
          isError: true,
        };
      }

      const allWarnings: string[] = [];
      const dispatchTasks: Array<{
        id: string;
        model: string;
        thinking: string;
        prompt: string;
        tools?: string;
        role?: string;
      }> = [];

      let blockedCount = 0;
      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const toolsResult = validateToolAllowlist(t.tools, t.model);

        if (isEscalationAttempt(toolsResult)) {
          blockedCount++;
          allWarnings.push(
            `Task ${i} (${t.model}): ALL tools blocked — ${formatAllowlistReport(toolsResult)}`,
          );
          continue;
        }

        if (toolsResult.warnings.length > 0) {
          allWarnings.push(`Task ${i}: ${toolsResult.warnings.join("; ")}`);
        }

        dispatchTasks.push({
          id: `task-${i}-${Date.now()}`,
          model: t.model,
          thinking: t.thinking,
          prompt: t.prompt,
          tools: toolsResult.allowed.join(",") || undefined,
        });
      }

      if (dispatchTasks.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ All ${tasks.length} task(s) blocked.\n\n${allWarnings.join("\n")}`,
          }],
          isError: true,
        };
      }

      const result = await runDispatch(dispatchTasks, ctx, signal, params.timeoutMs ?? 300_000);

      if (allWarnings.length > 0) {
        return {
          content: [{
            type: "text" as const,
            text: result + "\n\n⚠️ " + allWarnings.length + " warning(s):\n" + allWarnings.map((w) => "- " + w).join("\n"),
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: result }],
      };
    },
  });
}
