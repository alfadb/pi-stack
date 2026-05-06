/**
 * classifier — light-weight candidate extraction without LLM voter.
 *
 * Used in Slice B dry-run mode. Analyzes agent_end context heuristically
 * to produce candidate entries with rough confidence/tier/scope estimates.
 * All candidates go to pending queue (reason: dry_run).
 *
 * NOT a replacement for the LLM voter — it's intentionally conservative.
 * When LLM voter is enabled (Slice D), this classifier is replaced entirely.
 */

export interface CandidateEntry {
  title: string;
  tier: "maxim" | "decision" | "knowledge" | "short-term" | "skip";
  confidence: number; // 1-10, always ≤ 5 in dry-run mode
  evidence_source: "observed" | "documented" | "tested" | "derived";
  scope: "project" | "cross-project" | "derivation";
  reason: string;
  evidence_quote: string; // ≤ 500 chars from context
  evidence_files: string[];
}

export interface ClassifyResult {
  candidates: CandidateEntry[];
  summary: string;
}

/**
 * Extract candidate insights from agent_end context using heuristics.
 *
 * Look for signals of durable insight:
 * - User asks to "remember" / "save" / "note this"
 * - Assistant makes architectural decisions (ADR, decision, rule)
 * - New file patterns / module boundaries discovered
 * - Explicit "this is important" markers
 */
export function classifyAgentEnd(
  messages: Array<{ role: string; content: string }>,
): ClassifyResult {
  const fullText = messages.map((m) => `[${m.role}]: ${m.content}`).join("\n\n");
  const candidates: CandidateEntry[] = [];

  // ── Signal 1: User explicitly asks to remember ───────────────
  const rememberMatches = fullText.match(
    /remember\s+(?:this|that|it)\b|note\s+this\s+(?:down|for\s+later)|save\s+this|记住|记下|沉淀/gi,
  );
  if (rememberMatches) {
    candidates.push({
      title: extractTitle(fullText) || "User-requested memory",
      tier: "short-term",
      confidence: 3,
      evidence_source: "observed",
      scope: "project",
      reason: "User explicitly requested to remember this",
      evidence_quote: getContextSnippet(fullText, 400),
      evidence_files: extractFiles(fullText),
    });
  }

  // ── Signal 2: Assistant produced a decision / rule ───────────
  const decisionMatches = fullText.match(
    /ADR\s*\d{4}|architectural\s+decision|design\s+decision|编码规范|best\s+practice|原则|rule\s+of\s+thumb/gi,
  );
  if (decisionMatches) {
    candidates.push({
      title: extractTitle(fullText) || "Design decision",
      tier: "decision",
      confidence: 4,
      evidence_source: "observed",
      scope: "project",
      reason: `Detected decision-making pattern: ${decisionMatches.slice(0, 3).join(", ")}`,
      evidence_quote: getContextSnippet(fullText, 400),
      evidence_files: extractFiles(fullText),
    });
  }

  // ── Signal 3: New file / module created ─────────────────────
  const fileMatches = fullText.match(
    /created?\s+(?:file|module|component|extension)\b|wrote\s+\S+\.(?:ts|tsx|js|py|rs|go)/gi,
  );
  if (fileMatches) {
    candidates.push({
      title: extractTitle(fullText) || "File created",
      tier: "knowledge",
      confidence: 4,
      evidence_source: "observed",
      scope: "project",
      reason: `New file/module creation detected`,
      evidence_quote: getContextSnippet(fullText, 400),
      evidence_files: extractFiles(fullText),
    });
  }

  // ── Summary ──────────────────────────────────────────────────
  const summary =
    candidates.length > 0
      ? `Dry-run classifier found ${candidates.length} candidate(s). All → pending.`
      : "No durable insights detected by light classifier.";

  return { candidates, summary };
}

// ── helpers ────────────────────────────────────────────────────

function extractTitle(text: string): string {
  // Look for a title-like line: "# Title", "## Decision: ...", "ADR NNNN: ..."
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 120);
  const h2 = text.match(/^##\s+(.+)$/m);
  if (h2) return h2[1].trim().slice(0, 120);
  const adr = text.match(/ADR\s*\d{4}\s*[:\-]\s*(.+)/i);
  if (adr) return `ADR: ${adr[1].trim().slice(0, 100)}`;
  return "Untitled insight";
}

function getContextSnippet(text: string, maxLen: number): string {
  // Get a representative snippet from the middle of the context
  const start = Math.floor(text.length * 0.3);
  const snippet = text.slice(start, start + maxLen * 2);
  if (snippet.length <= maxLen) return snippet;
  return snippet.slice(0, maxLen) + "...";
}

function extractFiles(text: string): string[] {
  const files = new Set<string>();
  // Match file paths mentioned in the text
  const matches = text.matchAll(
    /(?:^|\s)((?:~\/|\.\.?\/|\/)[\w./-]+\.\w{1,5})/g,
  );
  for (const m of matches) {
    if (m[1].length < 80) files.add(m[1]);
  }
  return [...files].slice(0, 10);
}
