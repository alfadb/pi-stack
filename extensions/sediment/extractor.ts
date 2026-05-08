import type { ProjectEntryDraft } from "./writer";
import { validateProjectEntryDraft } from "./validation";

export interface ExtractedMemoryDraft extends ProjectEntryDraft {
  markerIndex: number;
}

export interface ExtractionPreview {
  count: number;
  drafts: Array<{
    markerIndex: number;
    title: string;
    kind: string;
    status?: string;
    confidence?: number;
    validationErrors: Array<{ field: string; message: string }>;
  }>;
}

function parseHeader(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim().toLowerCase()] = match[2].trim();
  }
  return out;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function parseConfidence(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseBlock(block: string, markerIndex: number): ExtractedMemoryDraft | null {
  const split = block.match(/\n---\s*\n/);
  if (!split || split.index === undefined) return null;

  const headerRaw = block.slice(0, split.index).trim();
  const body = block.slice(split.index + split[0].length).trim();
  const header = parseHeader(headerRaw);

  return {
    markerIndex,
    title: header.title || "",
    kind: (header.kind || "fact") as ProjectEntryDraft["kind"],
    status: header.status as ProjectEntryDraft["status"] | undefined,
    confidence: parseConfidence(header.confidence),
    triggerPhrases: parseList(header.trigger_phrases || header.triggers),
    compiledTruth: body,
    timelineNote: header.note || "explicit MEMORY block",
  };
}

/**
 * Deterministic extractor for explicit user/assistant markers only.
 *
 * Format:
 *
 * MEMORY:
 * title: Example Insight
 * kind: fact
 * confidence: 5
 * ---
 * # Example Insight
 *
 * Compiled truth body...
 * END_MEMORY
 */
export function parseExplicitMemoryBlocks(text: string): ExtractedMemoryDraft[] {
  const out: ExtractedMemoryDraft[] = [];
  const re = /^MEMORY:\s*\n([\s\S]*?)^END_MEMORY\s*$/gm;
  let match: RegExpExecArray | null;
  let markerIndex = 0;
  while ((match = re.exec(text))) {
    markerIndex++;
    const draft = parseBlock(match[1], markerIndex);
    if (draft) out.push(draft);
  }
  return out;
}

export function previewExtraction(drafts: ExtractedMemoryDraft[]): ExtractionPreview {
  return {
    count: drafts.length,
    drafts: drafts.map((draft) => ({
      markerIndex: draft.markerIndex,
      title: draft.title,
      kind: draft.kind,
      status: draft.status,
      confidence: draft.confidence,
      validationErrors: validateProjectEntryDraft(draft),
    })),
  };
}
