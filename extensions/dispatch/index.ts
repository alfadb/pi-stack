/**
 * dispatch extension for pi-stack — delegate tasks to sub-agents via subprocess pi.
 *
 * Self-contained rewrite (2026-05-06, v2). Replaces the in-process completeSimple
 * runner with pi subprocess spawning. Each dispatch = an independent pi instance
 * running in print+json mode, providing:
 *
 *   - OS-level process isolation (the runtime context IS the boundary)
 *   - Full pi tool ecosystem (reuses pi's own tool loop, event bus, trace)
 *   - Zero maintenance tool-calling loop (pi runtime handles it)
 *   - Structured JSON event stream (free observability)
 *
 * Registers:
 *   dispatch_agent  — single task
 *   dispatch_agents — parallel tasks (max 16)
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { coerceTasksParam, normalizeTaskSpec } from "./input-compat";

// ── Constants ───────────────────────────────────────────────────

const MAX_PARALLEL = 16;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

// ── Prompt file helper ──────────────────────────────────────────

/**
 * If the prompt is short enough to pass as an argument safely, return it
 * directly. Otherwise write to a temp .md file and return the @file-path.
 * All prompts are passed via @file for safety — no threshold guessing.
 */
function promptArg(
  prompt: string,
  tmpDir: string,
): { arg: string; cleanup?: () => void } {
  const file = path.join(tmpDir, "dispatch-prompt.md");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(file, prompt, "utf-8");
  return {
    arg: `@${file}`,
    cleanup: () => {
      try { fs.unlinkSync(file); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    },
  };
}

// ── Tool validation ─────────────────────────────────────────────

interface ToolValidation {
  ok: boolean;
  reason?: string;
}

function validateTools(toolsStr: string | undefined): ToolValidation {
  if (!toolsStr) return { ok: true };

  const names = toolsStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  for (const name of names) {
    if (name === "dispatch_agent" || name === "dispatch_agents") {
      return { ok: false, reason: `nested dispatch not allowed` };
    }
    if (MUTATING_TOOLS.has(name)) {
      if (process.env.PI_MULTI_AGENT_ALLOW_MUTATING !== "1") {
        return { ok: false, reason: `mutating tool "${name}" requires PI_MULTI_AGENT_ALLOW_MUTATING=1` };
      }
    }
  }

  return { ok: true };
}

// ── Subprocess ──────────────────────────────────────────────────

interface SubprocessResult {
  output: string;
  error?: string;
  stopReason?: string;
  durationMs: number;
  usage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
  };
}

/**
 * Spawn a pi subprocess, consume its JSON event stream, return the
 * final assistant output. pi handles multi-turn tool calling internally.
 *
 * onSpawn is called synchronously with the child PID once the process
 * starts — before any event listeners are set up.
 */
function runSubprocess(
  model: string,
  thinking: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs: number,
  onSpawn?: (pid: number) => void,
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tmpDir = path.join(os.tmpdir(), `pi-dispatch-${Date.now()}`);
    const { arg: promptArgValue, cleanup: cleanupTemp } = promptArg(prompt, tmpDir);

    const args = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--model", model,
    ];

    // pi's --thinking flag
    if (thinking !== "off") {
      args.push("--thinking", thinking);
    }

    // The prompt as the positional argument
    args.push(promptArgValue);

    let child: ChildProcess | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child?.kill("SIGTERM");
      // Force kill after 5s grace
      setTimeout(() => child?.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      cleanupTemp?.();
    };

    const onAbort = () => {
      child?.kill("SIGTERM");
    };

    if (signal.aborted) {
      cleanup();
      resolve({
        output: "",
        error: "aborted before start",
        durationMs: Date.now() - start,
      });
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      child = spawn("pi", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      if (child.pid) onSpawn?.(child.pid);
    } catch (e: any) {
      cleanup();
      resolve({
        output: "",
        error: `spawn failed: ${e.message}`,
        durationMs: Date.now() - start,
      });
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    const messages: any[] = [];
    let finalOutput = "";
    let lastAssistant: any = null;

    const processLines = (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
            if (event.message.role === "assistant") {
              lastAssistant = event.message;

              // Accumulate usage
              if (event.message.usage) {
                // usage is accumulated across turns by pi
              }

              // Final text — taken from the LAST assistant message
              // (earlier ones are intermediate tool-calling turns)
              finalOutput = "";
              if (event.message.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") finalOutput += part.text;
                }
              }
            }
          }
          if (event.type === "tool_result_end" && event.message) {
            messages.push(event.message);
          }
        } catch {
          // Non-JSON line (banner, warning) — ignore in -p mode
        }
      }
    };

    child.stdout.on("data", processLines);

    child.stderr.on("data", (data) => {
      stderrBuf += data.toString();
    });

    child.on("close", (code) => {
      // Flush remaining buffer
      if (stdoutBuf.trim()) {
        try {
          const event = JSON.parse(stdoutBuf.trim());
          if (event.type === "message_end" && event.message) {
            messages.push(event.message);
            if (event.message.role === "assistant") {
              lastAssistant = event.message;
              finalOutput = "";
              if (event.message.content) {
                for (const part of event.message.content) {
                  if (part.type === "text") finalOutput += part.text;
                }
              }
            }
          }
        } catch { /* ignore */ }
      }

      cleanup();

      const durationMs = Date.now() - start;

      if (timedOut) {
        resolve({ output: finalOutput, error: `timeout after ${timeoutMs}ms`, durationMs });
        return;
      }

      if (signal.aborted) {
        resolve({ output: finalOutput, error: "aborted", durationMs });
        return;
      }

      // Extract usage from last assistant message
      let usage: SubprocessResult["usage"] | undefined;
      if (lastAssistant?.usage) {
        usage = {
          input: lastAssistant.usage.input ?? 0,
          output: lastAssistant.usage.output ?? 0,
          total: lastAssistant.usage.totalTokens ?? 0,
          cost: lastAssistant.usage.cost?.total ?? 0,
        };
      }

      if (code !== 0) {
        resolve({
          output: finalOutput,
          error: `pi exited code ${code}${stderrBuf ? ": " + stderrBuf.slice(0, 200) : ""}`,
          stopReason: lastAssistant?.stopReason,
          durationMs,
          usage,
        });
        return;
      }

      if (lastAssistant?.stopReason === "error") {
        resolve({
          output: finalOutput,
          error: lastAssistant.errorMessage ?? "pi reported error",
          stopReason: "error",
          durationMs,
          usage,
        });
        return;
      }

      resolve({
        output: finalOutput || "(no output)",
        stopReason: lastAssistant?.stopReason,
        durationMs,
        usage,
      });
    });

    child.on("error", (err) => {
      cleanup();
      resolve({
        output: "",
        error: `pi process error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });
  });
}

// ── Result formatting ───────────────────────────────────────────

function formatResult(
  label: string,
  model: string,
  result: SubprocessResult,
): string {
  const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
  const usageStr = result.usage
    ? ` ↑${result.usage.input} ↓${result.usage.output} $${result.usage.cost.toFixed(4)}`
    : "";

  if (result.error) {
    return `## ${label} (${model}) ❌ ${dur}\n${result.error}${usageStr ? `\n_${usageStr}_` : ""}`;
  }

  const preview = result.output.length > 500
    ? result.output.slice(0, 500) + "..."
    : result.output;

  return `## ${label} (${model}) ✅ ${dur}${usageStr ? ` _${usageStr}_` : ""}\n\n${preview}`;
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
      "The sub-agent runs as an independent pi process, capable of multi-turn " +
      "tool calling (read, grep, find, ls). Mutating tools (bash, edit, write) " +
      "are blocked by default.",
    promptSnippet: "dispatch_agent(model, thinking, prompt, tools?, timeoutMs?)",
    promptGuidelines: [
      "Use dispatch_agent to delegate single analysis/reasoning tasks to a specific model.",
      "Sub-agents CAN use read, grep, find, ls. Mutating tools require PI_MULTI_AGENT_ALLOW_MUTATING=1.",
      "The sub-agent is an independent pi process — its context does NOT count against your token budget.",
    ],
    parameters: Type.Object({
      model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
      thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
      prompt: Type.String({ description: "Prompt sent to this task" }),
      tools: Type.Optional(Type.String({ description: "Ignored in subprocess mode — sub-pi uses built-in tools" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout in ms (default 300000)" })),
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
      // Validate tools if specified
      const toolCheck = validateTools(params.tools);
      if (!toolCheck.ok) {
        return {
          content: [{ type: "text" as const, text: `❌ ${toolCheck.reason}` }],
          isError: true,
        };
      }

      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      ctx.ui.setStatus("Dp", "⏳");
      const result = await runSubprocess(params.model, params.thinking, params.prompt, signal, timeoutMs);
      ctx.ui.setStatus("Dp", undefined);

      const text = formatResult("dispatch", params.model, result);

      return {
        content: [{ type: "text" as const, text }],
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
      "Each is an independent pi process. Mutating tools blocked by default.",
    promptSnippet: "dispatch_agents(tasks[{model, thinking, prompt}], timeoutMs?)",
    promptGuidelines: [
      "Use dispatch_agents for parallel multi-model analysis, review, or voting.",
      "Each task uses a different model. Results collected when all complete.",
      "For reasoning-only tasks, omit tools (sub-pi uses built-in read/grep/find/ls).",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          model: Type.String({ description: 'Provider/model e.g. "openai/gpt-5.5"' }),
          thinking: Type.String({ description: "Thinking level: off, minimal, low, medium, high, xhigh" }),
          prompt: Type.String({ description: "Prompt sent to this task" }),
          timeoutMs: Type.Optional(Type.Number({ description: "Per-task timeout in ms (default 300000)" })),
        }),
        { description: `Array of task specifications (max ${MAX_PARALLEL})` },
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Default per-task timeout in ms (default 300000)" })),
    }),

    prepareArguments(args: Record<string, unknown>) {
      const raw = coerceTasksParam((args as any).tasks);
      const tasks = raw.slice(0, MAX_PARALLEL).map((t: unknown) => {
        const n = normalizeTaskSpec(t);
        return {
          model: n.model,
          thinking: n.thinking,
          prompt: n.prompt,
          timeoutMs: n.timeoutMs,
        };
      });
      return { tasks, timeoutMs: (args as any).timeoutMs };
    },

    async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
      const tasks = params.tasks ?? [];
      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks provided." }],
          isError: true,
        };
      }

      const dispatchStart = Date.now();
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      // Concurrency-limited worker pool with status bar progress
      const results: SubprocessResult[] = new Array(tasks.length);
      let nextIdx = 0;
      let done = 0;
      let running = 0;
      const total = tasks.length;

      const updateStatus = () => ctx.ui.setStatus("Dp", `${running}/${done}/${total}`);
      updateStatus();

      const worker = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= total) return;
          const t = tasks[i];
          results[i] = await runSubprocess(
            t.model, t.thinking, t.prompt, signal,
            t.timeoutMs ?? timeoutMs,
            (pid) => { running++; updateStatus(); },
          );
          running--;
          done++;
          updateStatus();
        }
      };

      const workers = new Array(Math.min(MAX_CONCURRENCY, total)).fill(null).map(() => worker());
      await Promise.allSettled(workers);
      ctx.ui.setStatus("Dp", undefined);
      const totalWall = ((Date.now() - dispatchStart) / 1000).toFixed(1);

      // Log parallelism: serial time estimate vs actual
      const serialEstimate = results.reduce((s, r) => s + r.durationMs, 0);
      const maxSingle = Math.max(...results.map((r) => r.durationMs));

      // Build summary table
      const lines: string[] = [
        `## Dispatch Results (${tasks.length} tasks, ${totalWall}s total)`,
      ];
      if (tasks.length > 1) {
        const parallelRatio = (serialEstimate / (maxSingle || 1)).toFixed(1);
        lines.push(
          `_serial sum: ${(serialEstimate / 1000).toFixed(1)}s → ` +
          `parallel actual: ${totalWall}s (${parallelRatio}× speedup)_\n`,
        );
      }
      lines.push("");
      lines.push(`| # | Model | Duration | Status |`);
      lines.push(`|---|-------|----------|--------|`);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const status = r.error ? "❌" : "✅";
        lines.push(`| ${i + 1} | ${tasks[i].model} | ${dur} | ${status} |`);
      }
      lines.push("");

      // Full outputs
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
        const usageStr = r.usage
          ? ` ↑${r.usage.input} ↓${r.usage.output} $${r.usage.cost.toFixed(4)}`
          : "";

        lines.push(`### ${i + 1}. ${tasks[i].model} (${dur}${usageStr ? ` — ${usageStr}` : ""})`);

        if (r.error) {
          lines.push(`❌ ${r.error}`);
        } else {
          lines.push(r.output);
        }
        lines.push("");
      }

      const hasErrors = results.some((r) => r.error);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        ...(hasErrors ? { isError: true } : {}),
      };
    },
  });
}
