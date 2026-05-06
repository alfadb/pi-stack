/**
 * runner.ts — self-contained sub-agent task executor.
 *
 * Uses pi SDK's `completeSimple` for in-process LLM calls. No external
 * dependencies beyond pi bundled packages (@mariozechner/pi-ai,
 * @mariozechner/pi-coding-agent).
 *
 * Per-task safety:
 *   - timeout via AbortController (linked to parent signal)
 *   - MAX_TOOL_TURNS=50 cap on tool-calling loops
 *   - tool allowlist enforced by caller (this module just executes)
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  ToolCall,
  ToolResultMessage,
  ToolUsage,
} from "@mariozechner/pi-ai";

// ── Tool factory imports (from pi SDK) ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const piSdk = require("@mariozechner/pi-coding-agent");

const BUILTIN_FACTORIES: Record<string, (cwd: string) => any> = {
  read: piSdk.createReadTool,
  grep: piSdk.createGrepTool,
  find: piSdk.createFindTool,
  ls: piSdk.createLsTool,
  bash: piSdk.createBashTool,
  edit: piSdk.createEditTool,
  write: piSdk.createWriteTool,
};

// ── Types ───────────────────────────────────────────────────────

export interface TaskSpec {
  id: string;
  model: string;            // "provider/modelId"
  thinking: string;         // "off" | "low" | "medium" | "high" | "xhigh"
  prompt: string;
  tools?: string;           // comma-separated allowlist or "readonly"
  timeoutMs?: number;
}

export interface TaskResult {
  taskId: string;
  model: string;
  output: string;
  error?: string;
  durationMs: number;
  usage?: {
    input: number;
    output: number;
    total: number;
  };
}

export interface RunnerCtx {
  cwd: string;
  modelRegistry: any;
  signal?: AbortSignal;
}

// ── Constants ───────────────────────────────────────────────────

const MAX_TOOL_TURNS = 50;
const DEFAULT_TIMEOUT_MS = 300_000;

// ── Helpers ─────────────────────────────────────────────────────

function extractText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function extractToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((c): c is ToolCall => c.type === "toolCall");
}

function totalUsage(u: ToolUsage | undefined): TaskResult["usage"] | undefined {
  if (!u) return undefined;
  return {
    input: u.input ?? 0,
    output: u.output ?? 0,
    total: u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0),
  };
}

// ── Model resolution ────────────────────────────────────────────

async function resolveModel(
  modelRef: string,
  registry: any,
): Promise<{
  model: Model<Api>;
  apiKey: string;
  headers: Record<string, string>;
  baseUrl?: string;
} | null> {
  const [provider, modelId] = modelRef.split("/");
  if (!provider || !modelId) return null;

  const model = registry.find(provider, modelId);
  if (!model) return null;

  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  return {
    model,
    apiKey: auth.apiKey,
    headers: auth.headers ?? {},
    baseUrl: model.baseUrl,
  };
}

// ── Tool building ───────────────────────────────────────────────

function buildTools(toolNames: string[], cwd: string): any[] {
  const tools: any[] = [];
  for (const name of toolNames) {
    const factory = BUILTIN_FACTORIES[name];
    if (factory) {
      tools.push(factory(cwd));
    }
    // Unknown tool names are silently skipped — allowlist validation
    // happens in the caller (allowlist.ts) before we get here.
  }
  return tools;
}

// ── Single task execution ───────────────────────────────────────

export async function runSingleTask(
  task: TaskSpec,
  rctx: RunnerCtx,
): Promise<TaskResult> {
  const start = Date.now();
  const modelRef = task.model;

  // Resolve model
  const resolved = await resolveModel(modelRef, rctx.modelRegistry);
  if (!resolved) {
    return {
      taskId: task.id,
      model: modelRef,
      output: "",
      error: `Model not found: ${modelRef}`,
      durationMs: Date.now() - start,
    };
  }

  // Setup abort controller linked to parent signal
  const ac = new AbortController();
  if (rctx.signal?.aborted) ac.abort();
  const onParentAbort = () => ac.abort();
  rctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();

  try {
    // Parse tool allowlist
    const toolNames = parseToolsCsv(task.tools);
    const tools = buildTools(toolNames, rctx.cwd);

    const messages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: task.prompt }],
        timestamp: Date.now(),
      },
    ];

    let lastUsage: TaskResult["usage"];
    let turn = 0;

    while (true) {
      if (ac.signal.aborted) {
        return {
          taskId: task.id,
          model: modelRef,
          output: extractText(messages[messages.length - 1] as any || {} as any),
          error: "timeout or aborted",
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      turn += 1;
      if (turn > MAX_TOOL_TURNS) {
        return {
          taskId: task.id,
          model: modelRef,
          output: "",
          error: `Tool loop exceeded MAX_TOOL_TURNS=${MAX_TOOL_TURNS}`,
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      const ctx: Context = {
        systemPrompt: "",
        messages,
        ...(tools.length > 0 ? { tools: tools as any } : {}),
      };

      let assistant: AssistantMessage;
      try {
        assistant = await completeSimple(resolved.model, ctx, {
          apiKey: resolved.apiKey,
          headers: resolved.headers,
          signal: ac.signal,
          maxTokens: 16384,
          ...(task.thinking !== "off" ? { reasoning: task.thinking } : {}),
        } as any);
      } catch (e: any) {
        return {
          taskId: task.id,
          model: modelRef,
          output: "",
          error: e?.message ?? String(e),
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      if (assistant.usage) lastUsage = totalUsage(assistant.usage);
      messages.push(assistant);

      // Terminal stop reasons
      if (assistant.stopReason === "error" || assistant.stopReason === "aborted" || assistant.stopReason === "length") {
        return {
          taskId: task.id,
          model: modelRef,
          output: extractText(assistant),
          error: assistant.errorMessage ?? assistant.stopReason,
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      const toolCalls = extractToolCalls(assistant);
      if (toolCalls.length === 0) {
        return {
          taskId: task.id,
          model: modelRef,
          output: extractText(assistant),
          durationMs: Date.now() - start,
          usage: lastUsage,
        };
      }

      // Execute tool calls sequentially
      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.name);
        let resultContent: any[];
        let isError = false;

        if (!tool) {
          resultContent = [{ type: "text", text: `unknown tool: ${call.name}` }];
          isError = true;
        } else {
          try {
            const r: any = await tool.execute(call.id, call.arguments ?? {}, ac.signal);
            resultContent = r.content ?? [];
            isError = !!r.isError;
          } catch (e: any) {
            resultContent = [
              { type: "text", text: `tool '${call.name}' threw: ${e?.message ?? String(e)}` },
            ];
            isError = true;
          }
        }

        messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: resultContent,
          isError,
          timestamp: Date.now(),
        } as ToolResultMessage);
      }
    }
  } catch (e: any) {
    return {
      taskId: task.id,
      model: modelRef,
      output: "",
      error: e?.message ?? String(e),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
    rctx.signal?.removeEventListener("abort", onParentAbort);
  }
}

// ── Parallel execution ──────────────────────────────────────────

export async function runParallel(
  tasks: TaskSpec[],
  rctx: RunnerCtx,
): Promise<TaskResult[]> {
  return Promise.all(tasks.map((t) => runSingleTask(t, rctx)));
}

// ── Parse tools CSV ─────────────────────────────────────────────

function parseToolsCsv(csv: string | undefined): string[] {
  if (!csv || csv.trim() === "") return [];

  // "readonly" alias
  const trimmed = csv.trim().toLowerCase();
  if (trimmed === "readonly") {
    return ["read", "grep", "find", "ls"];
  }

  return trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
