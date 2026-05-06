/**
 * sediment/entry-text — render session entries to plain text for the LLM.
 *
 * Adapted from pi-sediment/scheduler.ts contentToText / entryToText /
 * buildWindowText. Drops pensieve-specific paths; keeps the proven
 * truncation strategy (per-entry head+tail elide, window builds backward
 * from newest so the triggering turn is never silently omitted).
 */

const MAX_ENTRY_CHARS = 30_000;
const MAX_WINDOW_CHARS = 200_000;

/** Render a content array (text + toolCall + image blocks) to plain text. */
export function contentToText(content: unknown): string {
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
        argsRepr = json.length > 400
          ? JSON.stringify(block.arguments ?? {}, null, 2)
          : json;
      } catch {
        argsRepr = "(unserializable arguments)";
      }
      parts.push(`[tool_call ${name}] ${argsRepr}`);
    } else if (block.type === "image") {
      parts.push(`[image ${block.mimeType ?? "unknown"}]`);
    }
    // Skip thinking blocks intentionally
  }
  return parts.join("\n");
}

function toolResultToText(msg: any): string {
  const name = msg?.toolName ?? "unknown";
  const errFlag = msg?.isError ? " ERROR" : "";
  const body = contentToText(msg?.content).trim();
  return `[tool_result ${name}${errFlag}]\n${body}`;
}

/** Render a single session entry to a labeled text block, or null if empty. */
export function entryToText(entry: any): string | null {
  if (!entry || typeof entry !== "object") return null;

  if (entry.type === "message") {
    const msg = entry.message;
    const role = msg?.role ?? "message";

    if (role === "toolResult") {
      const body = toolResultToText(msg).trim();
      if (!body) return null;
      return `### toolResult (${entry.id})\n${body}`;
    }

    const text = contentToText(msg?.content).trim();
    if (!text) return null;
    return `### ${role} (${entry.id})\n${text}`;
  }

  if (entry.type === "custom_message") {
    const text = contentToText(entry.content).trim();
    if (!text) return null;
    return `### custom_message:${entry.customType ?? "unknown"} (${entry.id})\n${text}`;
  }

  if (entry.type === "compaction") {
    return `### compaction (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  if (entry.type === "branch_summary") {
    return `### branch_summary (${entry.id})\n${entry.summary ?? ""}`.trim();
  }

  return null;
}

/**
 * Build window text from a list of entries. Iterates BACKWARD from newest
 * so the triggering turn is always present; older entries truncated first.
 * Per-entry head+tail elision preserves signal at both ends of large
 * tool results (file reads, bash output).
 */
export function buildWindowText(entries: any[]): { text: string; truncated: boolean; entryCount: number } {
  const reversedChunks: string[] = [];
  let total = 0;
  let truncated = false;
  let included = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    let text = entryToText(entries[i]);
    if (!text) continue;

    if (text.length > MAX_ENTRY_CHARS) {
      const headSize = Math.floor(MAX_ENTRY_CHARS * 0.7);
      const tailSize = MAX_ENTRY_CHARS - headSize - 50;
      text = text.slice(0, headSize) +
        `\n[...${text.length - MAX_ENTRY_CHARS} chars elided...]\n` +
        text.slice(-tailSize);
    }

    if (total + text.length > MAX_WINDOW_CHARS) {
      truncated = true;
      break;
    }

    reversedChunks.push(text);
    total += text.length;
    included += 1;
  }

  reversedChunks.reverse();
  if (truncated) {
    reversedChunks.unshift("[...older window entries truncated due to size...]");
  }

  return {
    text: reversedChunks.join("\n\n---\n\n"),
    truncated,
    entryCount: included,
  };
}
