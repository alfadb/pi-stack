/**
 * pi-sediment shared types.
 */

import type { Model, Api } from "@mariozechner/pi-ai";

// ── Target descriptors ──────────────────────────────────────────

export interface TargetStatus {
  /** Pensieve available (`.pensieve/` dir exists in project root). */
  pensieve: boolean;
  /** gbrain available (`gbrain doctor --json` exits 0). */
  gbrain: boolean;
  /** gbrain page count, if available (for cold-start logic). */
  gbrainPageCount: number | null;
}

// ── gbrain writer I/O ───────────────────────────────────────────
//
// Note: GbrainEvalResult and GbrainWriteInput were removed when the legacy
// two-stage evaluator+writer pipeline (writer.ts/evaluator.ts) was deleted in
// favor of the agent-loop path (gbrain-agent.ts). See gbrain-agent.ts'
// GbrainAgentResult discriminated union for the current decision shape.

export interface GbrainSearchResult {
  slug: string;
  title: string;
  snippet: string;
}

export interface GbrainWriteOutput {
  title: string;
  tags: string[];
  content: string; // markdown body
  /** Related page titles for gbrain frontmatter auto-link extraction. */
  related?: string[];
  /**
   * Set when the writer chose to UPDATE an existing page in place.
   * gbrain put is upsert by slug, so passing this overrides the
   * sanitizeSlug(title) derivation and overwrites the existing page
   * (preserving its identity and inbound graph links).
   */
  updateSlug?: string;
}

// ── Resolved model ─────────────────────────────────────────────

export interface ResolvedModel {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  display: string;
}
