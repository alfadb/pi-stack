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

export function validateProjectEntryDraft(draft: DraftLike): DraftValidationIssue[] {
  const issues: DraftValidationIssue[] = [];

  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  }

  if (typeof draft.kind !== "string" || !(ENTRY_KINDS as readonly string[]).includes(draft.kind)) {
    issues.push({ field: "kind", message: `kind must be one of: ${ENTRY_KINDS.join(", ")}` });
  }

  if (typeof draft.compiledTruth !== "string" || draft.compiledTruth.trim().length < 20) {
    issues.push({ field: "compiledTruth", message: "compiledTruth must be at least 20 characters" });
  }

  if (draft.status !== undefined && (typeof draft.status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(draft.status))) {
    issues.push({ field: "status", message: `status must be one of: ${ENTRY_STATUSES.join(", ")}` });
  }

  if (draft.confidence !== undefined) {
    const n = typeof draft.confidence === "number" ? draft.confidence : Number(draft.confidence);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      issues.push({ field: "confidence", message: "confidence must be a number between 0 and 10" });
    }
  }

  return issues;
}
