/**
 * ADR 0022 INV-K: cross-extension defer check for compaction-tuner.
 *
 * compaction-tuner is a separate extension from abrain; we deliberately
 * couple them through a single `globalThis.__abrainPromptUserGetPending`
 * hook (published by `abrain/index.ts` activate()) rather than through
 * the pi API. The runtime lookup keeps the coupling EXPLICIT and
 * BREAKABLE in smoke (mutate globalThis, observe behavior).
 *
 * This file exists as its OWN module — separate from index.ts —
 * specifically so it can be smoke-tested in isolation without staging
 * the rest of compaction-tuner's cross-extension dependency chain
 * (`../_shared/runtime`, `../memory/settings`, etc.). The defer
 * decision is pure logic over globalThis; a 50-LOC file is the
 * smallest module that lets us assert all branches.
 *
 * Why a function returning boolean (not the count itself):
 *   - Encapsulates the "what counts as blocking" decision in one place.
 *     Future tweaks (e.g. "block only on type:secret pending") edit one
 *     line here without touching the trigger path.
 *   - Defense-in-depth: hook can throw / return wrong type without
 *     breaking compaction. Returning a bool means callers can't
 *     accidentally use a poisoned number.
 */

/**
 * Returns true iff at least one `prompt_user` dialog is currently
 * pending in the abrain extension. Used by `compaction-tuner` to defer
 * compaction during a paused turn (ADR 0022 §D11 / INV-K).
 *
 * Semantics:
 *   - Hook absent          → false (abrain not loaded; compaction proceeds)
 *   - Hook returns 0       → false (no pending dialog)
 *   - Hook returns N > 0   → true  (defer compaction)
 *   - Hook returns ≤ 0     → false (corruption / negative; don't trust)
 *   - Hook returns non-num → false (corruption / type drift; don't trust)
 *   - Hook throws          → false (defense-in-depth; user-visible
 *                                   compaction failures are WORSE than
 *                                   missing a single INV-K defer)
 *
 * The hook itself is wired by `abrain/index.ts` activate() as:
 *
 *   (globalThis as any).__abrainPromptUserGetPending =
 *     () => promptManagerModule.getPendingPromptCount();
 */
export function isPendingPromptUserBlocking(): boolean {
  const hook = (globalThis as { __abrainPromptUserGetPending?: () => number })
    .__abrainPromptUserGetPending;
  if (typeof hook !== "function") return false;
  try {
    const n = hook();
    return typeof n === "number" && n > 0;
  } catch {
    return false;
  }
}
