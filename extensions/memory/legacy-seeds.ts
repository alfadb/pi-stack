/**
 * Legacy Pensieve bootstrap seeds.
 *
 * The archived pre-rewrite Pensieve skill seeded these files into every
 * project's `.pensieve/` during `init-project-data.sh` by copying from
 * `archived/pensieve-pre-rewrite/.src/templates/`. They are not project-local
 * knowledge: the canonical copy belongs in abrain's global `knowledge/` or
 * `workflows/` zones. Per-repo migration must therefore prune them from the
 * project-side `.pensieve/` without writing duplicates into
 * `~/.abrain/projects/<id>/`.
 */

export type LegacyPensieveSeedKind = "maxim" | "fact" | "workflow";

export interface LegacyPensieveSeed {
  relPath: string;
  id: string;
  slug: string;
  title: string;
  kind: LegacyPensieveSeedKind;
  globalTarget: string;
}

const LEGACY_PENSIEVE_SEEDS: LegacyPensieveSeed[] = [
  {
    relPath: "knowledge/taste-review/content.md",
    id: "taste-review-content",
    slug: "taste-review-content",
    title: "代码品味审查知识库",
    kind: "fact",
    globalTarget: "knowledge/taste-review-content.md",
  },
  {
    relPath: "maxims/eliminate-special-cases-by-redesigning-data-flow.md",
    id: "eliminate-special-cases-by-redesigning-data-flow",
    slug: "eliminate-special-cases-by-redesigning-data-flow",
    title: "Eliminate special cases by redesigning data flow",
    kind: "maxim",
    globalTarget: "knowledge/eliminate-special-cases-by-redesigning-data-flow.md",
  },
  {
    relPath: "maxims/prefer-pragmatic-solutions-over-theoretical-completeness.md",
    id: "prefer-pragmatic-solutions-over-theoretical-completeness",
    slug: "prefer-pragmatic-solutions-over-theoretical-completeness",
    title: "Prefer pragmatic solutions over theoretical completeness",
    kind: "maxim",
    globalTarget: "knowledge/prefer-pragmatic-solutions-over-theoretical-completeness.md",
  },
  {
    relPath: "maxims/preserve-user-visible-behavior-as-a-hard-rule.md",
    id: "preserve-user-visible-behavior-as-a-hard-rule",
    slug: "preserve-user-visible-behavior-as-a-hard-rule",
    title: "Preserve user-visible behavior as a hard rule",
    kind: "maxim",
    globalTarget: "knowledge/preserve-user-visible-behavior-as-a-hard-rule.md",
  },
  {
    relPath: "maxims/reduce-complexity-before-adding-branches.md",
    id: "reduce-complexity-before-adding-branches",
    slug: "reduce-complexity-before-adding-branches",
    title: "Reduce complexity before adding branches",
    kind: "maxim",
    globalTarget: "knowledge/reduce-complexity-before-adding-branches.md",
  },
  {
    relPath: "pipelines/run-when-committing.md",
    id: "run-when-committing",
    slug: "run-when-committing",
    title: "提交 Pipeline",
    kind: "workflow",
    globalTarget: "workflows/run-when-committing.md",
  },
  {
    relPath: "pipelines/run-when-planning.md",
    id: "run-when-planning",
    slug: "run-when-planning",
    title: "规划前知识检索 Pipeline",
    kind: "workflow",
    globalTarget: "workflows/run-when-planning.md",
  },
  {
    relPath: "pipelines/run-when-reviewing-code.md",
    id: "run-when-reviewing-code",
    slug: "run-when-reviewing-code",
    title: "代码审查 Pipeline",
    kind: "workflow",
    globalTarget: "workflows/run-when-reviewing-code.md",
  },
  {
    relPath: "pipelines/run-when-syncing-to-main.md",
    id: "run-when-syncing-to-main",
    slug: "run-when-syncing-to-main",
    title: "Sync to Main Pipeline",
    kind: "workflow",
    globalTarget: "workflows/run-when-syncing-to-main.md",
  },
];

const LEGACY_PENSIEVE_SEEDS_BY_PATH = new Map(
  LEGACY_PENSIEVE_SEEDS.map((seed) => [seed.relPath, seed]),
);

function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]+/).filter(Boolean).join("/");
}

function frontmatterString(frontmatter: Record<string, unknown>, key: string): string {
  const value = frontmatter[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizeLegacyId(id: string): string {
  return id.replace(/^project:[^:]+:/, "").replace(/^workflow:/, "").trim();
}

export function legacyPensieveSeedFor(
  relSource: string,
  frontmatter: Record<string, unknown>,
): LegacyPensieveSeed | null {
  const seed = LEGACY_PENSIEVE_SEEDS_BY_PATH.get(normalizeRelPath(relSource));
  if (!seed) return null;

  const id = normalizeLegacyId(frontmatterString(frontmatter, "id"));
  const name = frontmatterString(frontmatter, "name");

  // Path alone would be too broad: users can intentionally create a project
  // entry with a formerly-seeded filename. Require the original seed identity
  // (id, or name for legacy pipelines) to avoid pruning user-authored data.
  if (id === seed.id || name === seed.id) return seed;
  return null;
}

export function legacyPensieveSeedDryRunReason(seed: LegacyPensieveSeed): string {
  return `legacy Pensieve seed; extract to global abrain separately (${seed.globalTarget})`;
}

export function legacyPensieveSeedPrunedReason(seed: LegacyPensieveSeed): string {
  return `legacy Pensieve seed pruned; canonical copy belongs in global abrain (${seed.globalTarget})`;
}
