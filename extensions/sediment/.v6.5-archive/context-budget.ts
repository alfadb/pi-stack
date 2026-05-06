/**
 * context-budget — per-model adaptive prompt construction for sediment voter.
 *
 * Part of pi-stack ADR 0004 § voter context budget (v6.5.2).
 *
 * Principles:
 *   1. Per-model budget = 40% of context window (tokens)
 *   2. Big enough → keep full context (including full tool results)
 *   3. Too big → progressive trimming:
 *      L1: truncate tool results to head+tail 4K chars each
 *      L2: further to 1K chars each
 *      L3: drop earliest tool interactions, keep user + last 2 exchanges
 *      L4: overflow → reject round, send to pending
 *   4. Each model gets its own prompt, sized to its window
 *   5. context_truncated + truncation_level logged to audit
 */

// ── model context windows ──────────────────────────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "openai/gpt-5.5": 272_000,
  "anthropic/claude-opus-4-7": 1_000_000,
  "deepseek/deepseek-v4-pro": 1_000_000,
};

const BUDGET_RATIO = 0.4; // 40% of window for prompt

function getTokenBudget(modelId: string): number {
  const window = MODEL_CONTEXT_WINDOWS[modelId];
  if (!window) {
    // Unknown model — guess 200K
    return Math.floor(200_000 * BUDGET_RATIO);
  }
  return Math.floor(window * BUDGET_RATIO);
}

// ── simple token estimator ─────────────────────────────────────
// Rough heuristic: 1 token ≈ 4 chars for English text.
// Good enough for budget decisions; exact count happens at the provider.

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── message types ──────────────────────────────────────────────

export interface ContextMessage {
  role: string;
  content: string;
  toolName?: string;
  originalLength: number;
  isToolResult: boolean;
}

export interface BudgetedPrompt {
  prompt: string;
  contextTruncated: boolean;
  truncationLevel: number; // 0 = no truncation, 1-4 = truncation applied
  contextTokens: number;
  budget: number;
}

// ── main entry ─────────────────────────────────────────────────

/**
 * Build a vote prompt sized for a specific model.
 *
 * Returns the prompt + metadata about truncation.
 */
export function buildBudgetedPrompt(
  modelId: string,
  votePreamble: string,
  messages: ContextMessage[],
): BudgetedPrompt {
  const budget = getTokenBudget(modelId);
  const preambleTokens = estimateTokens(votePreamble);

  // First pass: try with full content
  const fullText = votePreamble + "\n\n" + formatMessages(messages);
  const fullTokens = estimateTokens(fullText);

  if (fullTokens <= budget) {
    // No truncation needed — model has plenty of room
    return {
      prompt: fullText,
      contextTruncated: false,
      truncationLevel: 0,
      contextTokens: fullTokens,
      budget,
    };
  }

  // Progressive trimming
  let truncatedMessages = messages.map((m) => ({ ...m }));
  let level = 0;

  // L1: truncate tool results to head+tail 4K chars
  if (estimateTokens(votePreamble + "\n\n" + formatMessages(truncatedMessages)) > budget) {
    level = 1;
    truncatedMessages = truncatedMessages.map((m) =>
      m.isToolResult ? { ...m, content: trimToolResult(m.content, 4000) } : m,
    );
  }

  // L2: further to 1K chars
  if (estimateTokens(votePreamble + "\n\n" + formatMessages(truncatedMessages)) > budget) {
    level = 2;
    truncatedMessages = truncatedMessages.map((m) =>
      m.isToolResult ? { ...m, content: trimToolResult(m.content, 1000) } : m,
    );
  }

  // L3: keep only user messages + last 2 tool interactions
  if (estimateTokens(votePreamble + "\n\n" + formatMessages(truncatedMessages)) > budget) {
    level = 3;
    truncatedMessages = keepRecentTurns(truncatedMessages, 2);
  }

  const finalText = votePreamble + "\n\n" + formatMessages(truncatedMessages);
  const finalTokens = estimateTokens(finalText);

  // L4: still over budget → return overflow signal
  if (finalTokens > budget) {
    return {
      prompt: finalText.slice(0, Math.floor(budget * 4)), // hard character cutoff as last resort
      contextTruncated: true,
      truncationLevel: 4,
      contextTokens: finalTokens,
      budget,
    };
  }

  return {
    prompt: finalText,
    contextTruncated: true,
    truncationLevel: level,
    contextTokens: finalTokens,
    budget,
  };
}

// ── message formatting ─────────────────────────────────────────

function formatMessages(messages: ContextMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.toolName
        ? `[${m.role}:${m.toolName}]`
        : `[${m.role}]`;
      // Escape XML-like content to prevent prompt injection via boundary breaking
      const safe = escapeXml(m.content);
      return `${prefix}: ${safe}`;
    })
    .join("\n\n");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── trimming helpers ───────────────────────────────────────────

function trimToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = maxChars - headLen;
  const head = content.slice(0, headLen);
  const tail = content.slice(-tailLen);
  const skipped = content.length - maxChars;
  return `${head}\n\n[... ${skipped} chars trimmed ...]\n\n${tail}`;
}

function keepRecentTurns(
  messages: ContextMessage[],
  recentTurns: number,
): ContextMessage[] {
  // Keep all user messages + the N most recent tool interactions
  const userMessages = messages.filter((m) => m.role === "user");
  const toolMessages = messages.filter((m) => m.isToolResult);

  // Take the last N tool interactions
  const recentTools = toolMessages.slice(-recentTurns);

  // Combine: all user messages + recent tool results, sorted by original order
  const kept = [...userMessages, ...recentTools].sort((a, b) => {
    const aIdx = messages.indexOf(a);
    const bIdx = messages.indexOf(b);
    return aIdx - bIdx;
  });

  return kept;
}

// ── extract messages from agent_end event ──────────────────────

// Convert pi message content blocks to plain text
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as any[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "toolCall") {
      const name = block.name ?? "unknown";
      let argsRepr: string;
      try {
        const json = JSON.stringify(block.arguments ?? {});
        argsRepr = json.length > 400 ? JSON.stringify(block.arguments ?? {}, null, 2) : json;
      } catch { argsRepr = "(unserializable arguments)"; }
      parts.push(`[tool_call ${name}] ${argsRepr}`);
    } else if (block.type === "image") {
      parts.push(`[image ${block.mimeType ?? "unknown"}]`);
    }
    // Skip thinking blocks
  }
  return parts.join("\n");
}

export function parseAgentEndMessages(eventOrCtx: any): ContextMessage[] {
  // Prefer full conversation branch (session entries with type=message|tool|etc)
  let entries: any[] = [];
  if (eventOrCtx?.sessionManager?.getBranch) {
    try { entries = eventOrCtx.sessionManager.getBranch(); } catch {}
  }
  // Fall back to event.messages (raw messages, no entry wrapping)
  let useEntries = entries.length > 0;
  if (!useEntries) {
    entries = eventOrCtx?.messages ?? eventOrCtx?.context ?? [];
  }

  const result: ContextMessage[] = [];

  for (const entry of entries) {
    // If from getBranch(): entry has .type and .message
    // If from event.messages: entry IS the message
    const msg = useEntries && entry.type === "message" ? entry.message :
                useEntries ? null : entry;

    // Skip non-message entries (compaction, branch_summary, custom_message, etc.)
    if (!msg) continue;

    const role = msg.role;
    const isAssistant = role === "assistant";
    const isToolResult = role === "toolResult" || role === "tool_result";

    let content = "";
    let toolName: string | undefined;

    if (isToolResult) {
      toolName = msg.toolName ?? msg.tool_name ?? "unknown";
      content = contentToText(msg.content);
      if (!content && msg.output) {
        content = typeof msg.output === "string" ? msg.output : JSON.stringify(msg.output);
      }
      if (content.length > 50000) content = content.slice(0, 50000);
    } else if (isAssistant) {
      // Skip assistant text/thinking; tool calls already captured via tool_call blocks rendered above
      // (but assistant messages do NOT contain tool results — those are separate toolResult messages)
      continue;
    } else if (role === "user") {
      content = contentToText(msg.content);
    }

    if (content.trim()) {
      result.push({
        role: role ?? "unknown",
        content: content.trim(),
        toolName,
        originalLength: content.length,
        isToolResult: !!toolName,
      });
    }
  }

  return result;
}
