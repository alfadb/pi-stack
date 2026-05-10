import * as path from "node:path";
import { DEFAULT_SETTINGS } from "../memory/settings";
import { scanStore } from "../memory/parser";
import { slugify } from "../memory/utils";

export interface DedupeMatch {
  slug: string;
  title: string;
  kind: string;
  status: string;
  source_path: string;
}

export interface DedupeResult {
  /** Storage-level duplicate only: exact slug collision. */
  duplicate: boolean;
  reason?: "slug_exact";
  score: number;
  match?: DedupeMatch;
}

export interface DetectDuplicateOpts {
  slug?: string;
  signal?: AbortSignal;
  /** Kept for call-site compatibility; ignored after ADR 0016. */
  kind?: string;
}

/**
 * Storage-only duplicate detection.
 *
 * ADR 0016 removed mechanical semantic dedupe (title trigram / rare-token
 * near-duplicate). Semantic similarity is now handled by the memory_search
 * powered curator loop, which can update/skip/merge instead of hard rejecting.
 * The writer still needs a deterministic storage guard for exact slug
 * collisions, because two markdown files cannot occupy the same path.
 */
export async function detectProjectDuplicate(
  projectRoot: string,
  title: string,
  opts?: DetectDuplicateOpts,
): Promise<DedupeResult> {
  const pensieveRoot = path.join(projectRoot, ".pensieve");
  const slug = opts?.slug ?? slugify(title);
  const entries = await scanStore(
    { scope: "project", root: pensieveRoot, label: "project" },
    projectRoot,
    DEFAULT_SETTINGS,
    opts?.signal,
  );

  for (const entry of entries) {
    if (entry.slug === slug) {
      return {
        duplicate: true,
        reason: "slug_exact",
        score: 1,
        match: {
          slug: entry.slug,
          title: entry.title,
          kind: entry.kind,
          status: entry.status,
          source_path: entry.displayPath,
        },
      };
    }
  }

  return { duplicate: false, score: 0 };
}
