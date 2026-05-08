import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { SedimentSettings } from "./settings";

export interface SedimentCheckpoint {
  lastProcessedEntryId?: string;
  updatedAt?: string;
  sessionId?: string;
}

export interface RunWindow {
  entries: unknown[];
  text: string;
  chars: number;
  totalBranchEntries: number;
  candidateEntries: number;
  includedEntries: number;
  checkpointFound: boolean;
  lastProcessedEntryId?: string;
  lastEntryId?: string;
  skipReason?: "no_new_entries" | "window_too_small";
}

export function checkpointPath(projectRoot: string): string {
  return path.join(projectRoot, ".pensieve", ".state", "sediment-checkpoint.json");
}

export async function loadCheckpoint(projectRoot: string): Promise<SedimentCheckpoint> {
  try {
    return JSON.parse(await fs.readFile(checkpointPath(projectRoot), "utf-8"));
  } catch {
    return {};
  }
}

export async function saveCheckpoint(projectRoot: string, checkpoint: SedimentCheckpoint): Promise<void> {
  const file = checkpointPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify({ ...checkpoint, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  await fs.rename(tmp, file);
}

function entryId(entry: unknown): string | undefined {
  if (entry && typeof entry === "object" && "id" in entry) {
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") return p.text;
    if (p.type === "thinking" && typeof p.thinking === "string") return `[thinking]\n${p.thinking}`;
    if (p.type === "toolCall") return `[toolCall ${String(p.name ?? "unknown")}] ${JSON.stringify(p.arguments ?? {})}`;
    if (p.type === "image") return "[image]";
    return "";
  }).filter(Boolean).join("\n");
}

export function entryToText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const e = entry as Record<string, unknown>;
  const id = typeof e.id === "string" ? e.id : "no-id";
  const type = typeof e.type === "string" ? e.type : "unknown";
  const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";

  if (type === "message" && e.message && typeof e.message === "object") {
    const msg = e.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    if (role === "toolResult") {
      return `--- ENTRY ${id} ${timestamp} message/toolResult:${String(msg.toolName ?? "unknown")} ---\n${textFromContent(msg.content)}`;
    }
    if (role === "bashExecution") {
      return `--- ENTRY ${id} ${timestamp} message/bashExecution ---\ncommand: ${String(msg.command ?? "")}\nexitCode: ${String(msg.exitCode ?? "")}\n${String(msg.output ?? "")}`;
    }
    return `--- ENTRY ${id} ${timestamp} message/${role} ---\n${textFromContent(msg.content)}`;
  }

  if (type === "compaction" || type === "branch_summary") {
    return `--- ENTRY ${id} ${timestamp} ${type} ---\n${String(e.summary ?? "")}`;
  }

  if (type === "custom_message") {
    return `--- ENTRY ${id} ${timestamp} custom_message:${String(e.customType ?? "unknown")} ---\n${textFromContent(e.content)}`;
  }

  return `--- ENTRY ${id} ${timestamp} ${type} ---\n${JSON.stringify(e)}`;
}

export function buildRunWindow(
  branch: unknown[],
  checkpoint: SedimentCheckpoint,
  settings: SedimentSettings,
): RunWindow {
  const lastProcessed = checkpoint.lastProcessedEntryId;
  const ids = branch.map(entryId);
  const lastIndex = lastProcessed ? ids.indexOf(lastProcessed) : -1;
  const checkpointFound = !lastProcessed || lastIndex >= 0;

  let candidates: unknown[];
  if (!lastProcessed) {
    candidates = branch;
  } else if (lastIndex >= 0) {
    candidates = branch.slice(lastIndex + 1);
  } else {
    // Compaction/branch fallback: avoid replaying an entire old branch if the
    // checkpoint disappeared. Keep only the latest entry as a conservative window.
    candidates = branch.length > 0 ? [branch[branch.length - 1]] : [];
  }

  if (candidates.length === 0) {
    return {
      entries: [],
      text: "",
      chars: 0,
      totalBranchEntries: branch.length,
      candidateEntries: 0,
      includedEntries: 0,
      checkpointFound,
      lastProcessedEntryId: lastProcessed,
      skipReason: "no_new_entries",
    };
  }

  const maxEntries = Math.max(1, settings.maxWindowEntries);
  const limitedByCount = candidates.slice(-maxEntries);
  const selectedNewestFirst: unknown[] = [];
  let chars = 0;

  for (let i = limitedByCount.length - 1; i >= 0; i--) {
    const rendered = entryToText(limitedByCount[i]);
    if (selectedNewestFirst.length > 0 && chars + rendered.length > settings.maxWindowChars) break;
    selectedNewestFirst.push(limitedByCount[i]);
    chars += rendered.length;
    if (chars >= settings.maxWindowChars) break;
  }

  const entries = selectedNewestFirst.reverse();
  const text = entries.map(entryToText).join("\n\n");
  const lastEntryId = entryId(entries[entries.length - 1]);
  const finalChars = text.length;

  return {
    entries,
    text,
    chars: finalChars,
    totalBranchEntries: branch.length,
    candidateEntries: candidates.length,
    includedEntries: entries.length,
    checkpointFound,
    lastProcessedEntryId: lastProcessed,
    lastEntryId,
    skipReason: finalChars < settings.minWindowChars ? "window_too_small" : undefined,
  };
}

export function checkpointSummary(window: RunWindow) {
  return {
    totalBranchEntries: window.totalBranchEntries,
    candidateEntries: window.candidateEntries,
    includedEntries: window.includedEntries,
    chars: window.chars,
    checkpointFound: window.checkpointFound,
    lastProcessedEntryId: window.lastProcessedEntryId,
    lastEntryId: window.lastEntryId,
    skipReason: window.skipReason,
  };
}

export function hasPensieve(projectRoot: string): boolean {
  return fsSync.existsSync(path.join(projectRoot, ".pensieve"));
}
