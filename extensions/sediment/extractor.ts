import type { ProjectEntryDraft } from "./writer";
import { validateProjectEntryDraft } from "./validation";
import { LANE_G_ALLOWED_REGIONS, type AboutMeRegion } from "./about-me-router";

export interface ExtractedMemoryDraft extends ProjectEntryDraft {
  markerIndex: number;
}

/**
 * Lane G (ADR 0021) fence-extracted draft. Distinct from
 * ExtractedMemoryDraft because Lane G's frontmatter shape includes
 * routing fields (region/route_candidates/routing_confidence/...) that
 * are NOT part of ProjectEntryDraft. The writer (writeAbrainAboutMe)
 * builds its own AboutMeDraft from these fields.
 *
 * In G1 (this phase), the fence MUST carry an explicit `region:` header
 * (user-attested). G3 will introduce an LLM classifier that produces
 * region + confidence when the fence omits them.
 */
export interface ExtractedAboutMeDraft {
  markerIndex: number;
  title: string;
  body: string;
  /** Region from fence header. Required in G1 (user must attest); G3 will
   * make it optional and call the LLM classifier when missing. */
  region?: AboutMeRegion;
  /** Confidence from fence (0..1). G1 defaults to 1.0 when fence omits
   * (user-attested = highest trust); G3 will use LLM-derived value. */
  routingConfidence?: number;
  triggerPhrases?: string[];
  tags?: string[];
  status?: string;
  timelineNote?: string;
}

export interface AboutMeExtractionPreview {
  count: number;
  drafts: Array<{
    markerIndex: number;
    title: string;
    region?: AboutMeRegion;
    bodyLength: number;
    headerFields: string[];
  }>;
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
 * Returns true iff the position `charIndex` falls inside an open fenced
 * code block (``` or ~~~). Used to skip MEMORY: markers that the agent or
 * user wrote as a literal example rather than as an explicit memory directive.
 *
 * Deliberately does NOT strip code regions before regex scanning (unlike
 * extractBodyWikilinks): a legitimate top-level MEMORY: block may include
 * fenced code samples in its body, and we must preserve that body intact.
 * Instead, we only check whether the MEMORY: line itself sits inside a
 * fence.
 */
function isInsideCodeFence(text: string, charIndex: number): boolean {
  // Fence state is local to a rendered transcript entry. Counting fences
  // from the beginning of the whole run window lets an unmatched fence in
  // an older message flip the state for later messages, which can turn a
  // fenced documentation example into a false explicit MEMORY write. Reset
  // the scan at the latest entry delimiter emitted by checkpoint.entryToText.
  const before = text.slice(0, charIndex);
  const entryStartAtZero = before.startsWith("--- ENTRY ") ? 0 : -1;
  const lastEntryAfterNewline = before.lastIndexOf("\n--- ENTRY ");
  const start = Math.max(entryStartAtZero, lastEntryAfterNewline >= 0 ? lastEntryAfterNewline + 1 : -1);
  const localBefore = start >= 0 ? text.slice(start, charIndex) : before;
  const fences = localBefore.match(/^(?:```|~~~)/gm) || [];
  return fences.length % 2 === 1;
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
 *
 * MEMORY: markers that appear inside fenced code blocks (``` or ~~~) are
 * skipped — those are documentation/demonstration of the format, not
 * directives to write memory.
 */
export function parseExplicitMemoryBlocks(text: string): ExtractedMemoryDraft[] {
  const out: ExtractedMemoryDraft[] = [];
  const re = /^MEMORY:\s*\n([\s\S]*?)^END_MEMORY\s*$/gm;
  let match: RegExpExecArray | null;
  let markerIndex = 0;
  while ((match = re.exec(text))) {
    if (isInsideCodeFence(text, match.index)) continue;
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

// ── Lane G fence extractor (ADR 0021) ────────────────────────────────────
//
// Mirrors parseExplicitMemoryBlocks but:
//   - fence header is MEMORY-ABOUT-ME: (not MEMORY:)
//   - terminator is END_MEMORY (shared with Lane A, intentional: same
//     visual landmark for users; lane is implied by the opener)
//   - frontmatter carries Lane G routing fields
//
// Format:
//
//   MEMORY-ABOUT-ME:
//   title: I prefer fail-closed designs over fail-open
//   region: identity
//   confidence: 0.9
//   trigger_phrases: fail-closed, fail-open
//   ---
//   I consistently choose designs that refuse to operate on missing
//   inputs rather than silently degrading. Examples: vault unlock,
//   sediment write rejection on validation_error, ...
//   END_MEMORY
//
// In G1 the `region:` header is REQUIRED. In G3 the LLM classifier fills
// it in when absent. The extractor itself only parses; validation of
// region against the lane allowlist happens downstream via
// validateRouteDecision in about-me-router.ts.

// Single source of truth for the region enum (ADR 0021 P1-A audit fix
// 2026-05-16). Same set used by writer.ts::validateAboutMeDraft and
// router.ts::validateRouteDecision rule 1.
const ABOUT_ME_VALID_REGIONS = new Set<AboutMeRegion>(LANE_G_ALLOWED_REGIONS);

function parseAboutMeBlock(block: string, markerIndex: number): ExtractedAboutMeDraft | null {
  const split = block.match(/\n---\s*\n/);
  if (!split || split.index === undefined) return null;

  const headerRaw = block.slice(0, split.index).trim();
  const body = block.slice(split.index + split[0].length).trim();
  const header = parseHeader(headerRaw);

  // Parse region: case-insensitive match against the lane allowlist.
  // Reject unknown regions at extractor level so a typo ("identitiy")
  // becomes a parse failure rather than landing in the writer as a
  // RouterError later — the fence syntax is itself a contract.
  let region: AboutMeRegion | undefined;
  if (header.region) {
    const r = header.region.toLowerCase() as AboutMeRegion;
    if (ABOUT_ME_VALID_REGIONS.has(r)) region = r;
    else return null; // unknown region → skip the entire block
  }

  // Parse routing_confidence: optional, [0,1]. Bare number, no %.
  let routingConfidence: number | undefined;
  if (header.confidence) {
    const n = Number(header.confidence);
    if (Number.isFinite(n) && n >= 0 && n <= 1) routingConfidence = n;
    // else silently drop — writer/router will use its default for missing field
  }

  return {
    markerIndex,
    title: header.title || "",
    body,
    region,
    routingConfidence,
    triggerPhrases: parseList(header.trigger_phrases || header.triggers),
    tags: parseList(header.tags),
    status: header.status,
    timelineNote: header.note || "explicit MEMORY-ABOUT-ME block",
  };
}

/**
 * Deterministic Lane G extractor for explicit user-attested about-me
 * blocks. Fence-aware (skips MEMORY-ABOUT-ME: that appear inside fenced
 * code blocks, same defense as parseExplicitMemoryBlocks).
 *
 * In G1 the caller (sediment agent_end pipeline) consumes the output
 * via writeAbrainAboutMe; in G2 the /about-me slash injects fences
 * into the transcript so the same parser handles both entry paths.
 */
export function parseExplicitAboutMeBlocks(text: string): ExtractedAboutMeDraft[] {
  const out: ExtractedAboutMeDraft[] = [];
  const re = /^MEMORY-ABOUT-ME:\s*\n([\s\S]*?)^END_MEMORY\s*$/gm;
  let match: RegExpExecArray | null;
  let markerIndex = 0;
  while ((match = re.exec(text))) {
    if (isInsideCodeFence(text, match.index)) continue;
    markerIndex++;
    const draft = parseAboutMeBlock(match[1], markerIndex);
    if (draft) out.push(draft);
  }
  return out;
}

export function previewAboutMeExtraction(drafts: ExtractedAboutMeDraft[]): AboutMeExtractionPreview {
  return {
    count: drafts.length,
    drafts: drafts.map((draft) => ({
      markerIndex: draft.markerIndex,
      title: draft.title,
      region: draft.region,
      bodyLength: draft.body.length,
      headerFields: [
        ...(draft.region ? ["region"] : []),
        ...(draft.routingConfidence !== undefined ? ["confidence"] : []),
        ...(draft.triggerPhrases ? ["trigger_phrases"] : []),
        ...(draft.tags ? ["tags"] : []),
        ...(draft.status ? ["status"] : []),
      ],
    })),
  };
}
