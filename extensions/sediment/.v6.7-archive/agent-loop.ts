/**
 * sediment/agent-loop — multi-turn LLM with tool use.
 *
 * Wraps `completeSimple` with a tool-call → tool-result → continue loop.
 * No turn cap: the model decides when it's done by emitting stopReason="stop".
 * Bounded only by:
 *   - per-call timeout via AbortController (the agent's existing budget)
 *   - tool dispatch failures surfaced as tool errors (model can recover)
 *
 * The model's final assistant TEXT is returned for protocol parsing
 * (SKIP / SKIP_DUPLICATE / ## GBRAIN ...).
 *
 * Adapted from pi-sediment/agent-loop.ts.
 */

import { completeSimple } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { ToolHandler } from "./lookup-tools";

export interface AgentLoopArgs {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
  signal?: AbortSignal;
  maxTokens?: number;
  reasoning?: "off" | "high" | "xhigh";
  onEvent?: (event: AgentLoopEvent) => void;
}

export type AgentLoopEvent =
  | { kind: "llm_call"; turn: number; messageCount: number }
  | { kind: "llm_done"; turn: number; stopReason: string; toolCalls: number }
  | { kind: "tool_call"; turn: number; name: string; argSummary: string }
  | { kind: "tool_result"; turn: number; name: string; ok: boolean; bytes: number }
  | { kind: "abort"; reason: string };

export interface AgentLoopResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  stopReason: string;
  ok: boolean;
  errorMessage?: string;
}

function summarizeArgs(args: any): string {
  try {
    const j = JSON.stringify(args);
    return j.length > 200 ? j.slice(0, 200) + "..." : j;
  } catch {
    return "(unserializable)";
  }
}

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

export async function runAgentLoop(args: AgentLoopArgs): Promise<AgentLoopResult> {
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: args.userPrompt }],
      timestamp: Date.now(),
    },
  ];

  let turn = 0;
  let toolCalls = 0;
  let lastStopReason = "";

  while (true) {
    if (args.signal?.aborted) {
      args.onEvent?.({ kind: "abort", reason: "external signal" });
      return {
        finalText: "",
        turns: turn,
        toolCalls,
        stopReason: "aborted",
        ok: false,
        errorMessage: "aborted before LLM call",
      };
    }

    turn += 1;
    args.onEvent?.({ kind: "llm_call", turn, messageCount: messages.length });

    const ctx: Context = {
      systemPrompt: args.systemPrompt,
      messages,
      tools: args.tools,
    };

    let assistant: AssistantMessage;
    try {
      assistant = await completeSimple(args.model, ctx, {
        apiKey: args.apiKey,
        headers: args.headers,
        signal: args.signal,
        maxTokens: args.maxTokens ?? 16384,
        ...(args.reasoning && args.reasoning !== "off" ? { reasoning: args.reasoning } : {}),
      } as any);
    } catch (e: any) {
      return {
        finalText: "",
        turns: turn,
        toolCalls,
        stopReason: "error",
        ok: false,
        errorMessage: e?.message ?? String(e),
      };
    }

    lastStopReason = assistant.stopReason;
    const calls = extractToolCalls(assistant);
    args.onEvent?.({
      kind: "llm_done",
      turn,
      stopReason: assistant.stopReason,
      toolCalls: calls.length,
    });

    messages.push(assistant);

    if (assistant.stopReason === "error") {
      return {
        finalText: extractText(assistant),
        turns: turn,
        toolCalls,
        stopReason: "error",
        ok: false,
        errorMessage: (assistant as any).errorMessage,
      };
    }
    if (assistant.stopReason === "aborted") {
      return {
        finalText: extractText(assistant),
        turns: turn,
        toolCalls,
        stopReason: "aborted",
        ok: false,
        errorMessage: (assistant as any).errorMessage ?? "aborted",
      };
    }
    if (assistant.stopReason === "length") {
      return {
        finalText: extractText(assistant),
        turns: turn,
        toolCalls,
        stopReason: "length",
        ok: false,
        errorMessage: "max tokens reached",
      };
    }

    if (calls.length === 0) {
      return {
        finalText: extractText(assistant),
        turns: turn,
        toolCalls,
        stopReason: assistant.stopReason,
        ok: assistant.stopReason === "stop",
      };
    }

    for (const call of calls) {
      const handler = args.handlers[call.name];
      toolCalls += 1;
      args.onEvent?.({
        kind: "tool_call",
        turn,
        name: call.name,
        argSummary: summarizeArgs(call.arguments),
      });
      let resultText: string;
      let isError: boolean;
      if (!handler) {
        resultText = `unknown tool: ${call.name}`;
        isError = true;
      } else {
        try {
          const r = await handler(call.arguments ?? {});
          resultText = r.text;
          isError = r.isError;
        } catch (e: any) {
          resultText = `tool '${call.name}' threw: ${e?.message ?? String(e)}`;
          isError = true;
        }
      }
      args.onEvent?.({
        kind: "tool_result",
        turn,
        name: call.name,
        ok: !isError,
        bytes: resultText.length,
      });
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: resultText }],
        isError,
        timestamp: Date.now(),
      } as ToolResultMessage;
      messages.push(toolResult);
    }
  }
}
