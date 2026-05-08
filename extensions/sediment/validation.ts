export const ENTRY_KINDS = [
  "maxim", "decision", "anti-pattern", "pattern", "fact", "preference", "smell",
] as const;

export const ENTRY_STATUSES = [
  "provisional", "active", "contested", "deprecated", "superseded", "archived",
] as const;

export type EntryKind = typeof ENTRY_KINDS[number];
export type EntryStatus = typeof ENTRY_STATUSES[number];

export interface DraftValidationIssue {
  field: string;
  message: string;
}

export interface DraftLike {
  title?: unknown;
  kind?: unknown;
  compiledTruth?: unknown;
  status?: unknown;
  confidence?: unknown;
}

/**
 * Optional policy overlay applied on top of the standard schema check.
 * Designed for the Phase 1.4 LLM auto-write path which runs the same
 * `writeProjectEntry` plumbing as explicit-marker extraction but wants
 * stricter content gates:
 *
 *   - `disallowMaxim`     bans `kind: "maxim"`. Maxims are the highest
 *                         authority entry kind in the memory ontology;
 *                         we do NOT trust an LLM to mint them. Human
 *                         curation only.
 *   - `maxConfidence`     caps `confidence` at the given value.
 *                         Auto-written entries should not start at 10
 *                         ("absolute truth") just because the LLM
 *                         sounded confident in its prose.
 *   - `disallowArchived`  prevents auto-write from setting
 *                         `status: archived`/`deprecated`/`superseded`.
 *                         These are sediment-state transitions that
 *                         should follow citation/curation flows, not
 *                         appear at first creation.
 *   - `disallowNearDuplicate`  rejects writes that the dedupe layer
 *                         flags as near-duplicates (char-trigram +
 *                         shared rare token + same kind). Hard
 *                         duplicates (slug_exact, word-trigram >=
 *                         threshold) are ALWAYS rejected; this flag
 *                         only controls the SOFT signal. Default
 *                         off; the LLM auto-write lane turns it on
 *                         because the LLM is more likely to mint a
 *                         paraphrased restatement of an existing
 *                         entry than the explicit-marker lane.
 *
 * The shape is intentionally a subset of `validateProjectEntryDraft`
 * concerns; nothing here changes default (no-opts) behavior. The
 * dedupe overlay is enforced by the writer (which has the store
 * scan), not by `validateProjectEntryDraft` (which is pure).
 */
export interface DraftPolicy {
  disallowMaxim?: boolean;
  maxConfidence?: number;
  disallowArchived?: boolean;
  disallowNearDuplicate?: boolean;
}

const NON_INITIAL_STATUSES: ReadonlySet<EntryStatus> = new Set([
  "archived", "deprecated", "superseded",
]);

export function validateProjectEntryDraft(draft: DraftLike, policy?: DraftPolicy): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];

  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  }

  if (typeof draft.kind !== "string" || !(ENTRY_KINDS as readonly string[]).includes(draft.kind)) {
    issues.push({ field: "kind", message: `kind must be one of: ${ENTRY_KINDS.join(", ")}` });
  } else if (policy?.disallowMaxim && draft.kind === "maxim") {
    issues.push({ field: "kind", message: "maxim kind is not allowed for auto-written entries" });
  }

  if (typeof draft.compiledTruth !== "string" || draft.compiledTruth.trim().length < 20) {
    issues.push({ field: "compiledTruth", message: "compiledTruth must be at least 20 characters" });
  }

  if (draft.status !== undefined) {
    if (typeof draft.status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(draft.status)) {
      issues.push({ field: "status", message: `status must be one of: ${ENTRY_STATUSES.join(", ")}` });
    } else if (policy?.disallowArchived && NON_INITIAL_STATUSES.has(draft.status as EntryStatus)) {
      issues.push({ field: "status", message: `status "${draft.status}" is not allowed for auto-written entries; use provisional/active/contested for new entries` });
    }
  }

  if (draft.confidence !== undefined) {
    const n = typeof draft.confidence === "number" ? draft.confidence : Number(draft.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      issues.push({ field: "confidence", message: "confidence must be a number between 0 and 10" });
    } else if (typeof policy?.maxConfidence === "number" && n > policy.maxConfidence) {
      issues.push({ field: "confidence", message: `confidence must be <= ${policy.maxConfidence} for auto-written entries` });
    }
  }

  return issues;
}
