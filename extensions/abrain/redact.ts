/**
 * Credential / secret redaction primitives, promoted from
 * `git-sync.ts` so they can be shared by `prompt_user` (ADR 0022) and
 * any future caller that must keep raw secrets out of audit / UI /
 * sediment / log surfaces.
 *
 * Why this lives in `abrain/redact.ts` (not `_shared/`):
 * ADR 0022 §D6.2 — `_shared/` promotion would need a separate
 * cross-extension API security review; we only have one consumer beyond
 * abrain today (sediment, via its own sanitizer.ts). Promote later when
 * a second extension legitimately needs it.
 *
 * Invariant trace:
 *   ADR 0020 INV 7 — `redactCredentials` must remain available for
 *     `getStatus().remote`, `formatSyncStatus()`, and sync audit error
 *     fields. `git-sync.ts` re-exports it so existing imports do not
 *     break.
 *   ADR 0022 INV-J — `redactCredentials` MUST be defined here; the
 *     `git-sync.ts` re-export is a compat shim, not a second definition.
 *     Smoke verifies `import from "./git-sync"` and `import from
 *     "./redact"` yield the SAME function reference (no drift).
 *   ADR 0022 INV-C — `redactSecretAnswer` is how `type:"secret"` raw
 *     answers are replaced before the value crosses any audit / LLM /
 *     log boundary.
 */

/**
 * Redact userinfo from a URL so credentials don't leak into logs or UI.
 *
 * Originally added by Round 2 git-sync audit (opus M1 + deepseek m2):
 * `git remote get-url origin` returns the URL verbatim. If a user
 * configured `https://alice:ghp_xxx@git.example.com/repo.git` (a common
 * antipattern), the token would flow into `getStatus().remote`,
 * `formatSyncStatus()` UI output, and any push stderr captured into the
 * audit `error` field (e.g. `fatal: unable to access
 * 'https://alice:ghp_xxx@...'`). The audit log is on disk forever.
 * Invariant 4 ("No secrets in argv") was symmetric-asymmetric: argv-in
 * was locked down but the output side leaked. This redactor closes that
 * gap. SSH-style URLs (`git@host:path`) are not touched — they have no
 * embedded secret.
 *
 * ADR 0022 promoted this from git-sync.ts unchanged. Behavior is identical;
 * git-sync.ts now re-exports for backward compat.
 */
export function redactCredentials(s: string): string {
  return s.replace(/(https?:\/\/)[^@\s\/]+@/gi, "$1***@");
}

/**
 * Replace a `type:"secret"` raw answer with a stable placeholder before
 * it crosses any LLM / audit / log boundary.
 *
 * ADR 0022 INV-C: tool result returns `[REDACTED_SECRET:<id>]`; audit
 * stores only `lengthBucket(raw)` — never `raw`, never a hash, never
 * char count.
 *
 * `id` is taken from `PromptUserQuestion.id` (snake_case, schema-
 * validated). It MUST NOT be a user-supplied string at this layer:
 * by the time `redactSecretAnswer` is called the handler has already
 * validated the id regex `/^[a-z][a-z0-9_]{0,31}$/`.
 */
export function redactSecretAnswer(_raw: string, id: string): string {
  return `[REDACTED_SECRET:${id}]`;
}

/**
 * Coarse length bucket for `type:"secret"` answers, used in audit
 * metadata so operators can answer "did the user enter anything?"
 * without ever storing length on disk.
 *
 * Buckets are intentionally coarse (3 levels) so they leak less entropy
 * than a numeric length. Empty string falls into "1-8" by convention —
 * smoke verifies this so future "0 length" handling doesn't drift.
 *
 * ADR 0022 §D6.3: audit metadata row carries `lengthBucket(raw)`, never
 * `raw.length` and never `raw`.
 */
export function lengthBucket(s: string): "1-8" | "9-32" | ">32" {
  const n = s.length;
  if (n <= 8) return "1-8";
  if (n <= 32) return "9-32";
  return ">32";
}
