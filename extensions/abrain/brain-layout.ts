/**
 * abrain — brain directory layout bootstrap.
 *
 * Ensures the 7-zone directory structure exists under ~/.abrain/.
 * Per brain-redesign-spec.md §1 and ADR 0014 §D1:
 *
 *   ~/.abrain/
 *   ├── identity/     # Lane G: about-me declarations
 *   ├── skills/       # Lane G: skill definitions
 *   ├── habits/       # Lane G: habit/preference tracking
 *   ├── workflows/    # Lane G: workflow definitions
 *   ├── projects/     # Lane C target: per-project memory (migration P5-P6)
 *   ├── knowledge/    # Lane A: cross-project world knowledge
 *   └── vault/        # Lane V: encrypted secrets (created by /vault init)
 *
 * Idempotent: safe to call on every boot; only creates missing dirs.
 * Creates with mode 0o700 (owner-only, consistent with vault security posture).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * All 7 zone directory names (excluding vault, which is created by /vault init).
 * Ordered for readability in ls output.
 */
const BRAIN_ZONES = [
  "identity",
  "skills",
  "habits",
  "workflows",
  "projects",
  "knowledge",
  "vault",
] as const;

/** Per-zone metadata: which lane owns it, whether it holds markdown entries. */
const ZONE_META: Record<string, { lane: string; description: string }> = {
  identity:  { lane: "G (about-me)", description: "user identity declarations, /about-me output" },
  skills:    { lane: "G (about-me)", description: "skill definitions and proficiency" },
  habits:    { lane: "G (about-me)", description: "habit tracking and preferences" },
  workflows: { lane: "G (about-me)", description: "workflow and pipeline definitions" },
  projects:  { lane: "C (curator)", description: "per-project memory (migration target from .pensieve/)" },
  knowledge: { lane: "A (agent)",   description: "cross-project world knowledge" },
  vault:     { lane: "V (vault)",   description: "age-encrypted secrets (managed by /vault init)" },
};

/**
 * Create or verify the 7-zone directory layout under abrainHome.
 *
 * - Idempotent: skips already-existing zones.
 * - Creates with mode 0o700 (rwx------).
 * - Returns the set of zones that were created (empty on subsequent boots).
 * - Does NOT throw for individual mkdir failures; returns them as warnings.
 *   The only hard error is when abrainHome itself cannot be resolved/created.
 *
 * Called from activate() on every boot — cheap (7 stat calls, no mkdir
 * unless first boot or zone was manually deleted).
 */
export function ensureBrainLayout(abrainHome: string): { created: string[]; warnings: string[] } {
  const resolved = path.resolve(abrainHome);
  const created: string[] = [];
  const warnings: string[] = [];

  // Ensure abrain root exists
  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      throw new Error(`cannot create abrain root ${resolved}: ${err.message}`);
    }
  }

  const rootStat = fs.statSync(resolved);
  if (!rootStat.isDirectory()) {
    throw new Error(`abrain root is not a directory: ${resolved}`);
  }

  for (const zone of BRAIN_ZONES) {
    const dir = path.join(resolved, zone);
    if (fs.existsSync(dir)) {
      // Already exists — verify it's a directory
      try {
        const s = fs.statSync(dir);
        if (!s.isDirectory()) {
          warnings.push(`${zone}: exists but is not a directory`);
        }
      } catch (err: any) {
        warnings.push(`${zone}: stat failed: ${err.message}`);
      }
      continue;
    }

    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created.push(zone);
    } catch (err: any) {
      warnings.push(`${zone}: mkdir failed: ${err.message}`);
    }
  }

  return { created, warnings };
}

/**
 * Get lane and description metadata for a zone name.
 * Returns undefined for unknown zone names.
 */
export function zoneMeta(zone: string): { lane: string; description: string } | undefined {
  return ZONE_META[zone];
}
