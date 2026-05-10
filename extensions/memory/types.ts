export type Scope = "project" | "world";

export type Jsonish = string | number | boolean | null | Jsonish[] | { [k: string]: Jsonish };

export interface StoreRef {
  scope: Scope;
  root: string;
  label: string;
}

export interface MemoryEntry {
  slug: string;
  id?: string;
  scope: Scope;
  kind: string;
  status: string;
  confidence: number;
  title: string;
  summary: string;
  created?: string;
  updated?: string;
  sourcePath: string;
  displayPath: string;
  storeRoot: string;
  frontmatter: Record<string, Jsonish>;
  compiledTruth: string;
  timeline: string[];
  relatedSlugs: string[];
  relations: RelationEdge[];
  tokenCounts: Map<string, number>;
  tokenTotal: number;
}

export interface RelationEdge {
  to: string;
  type: string;
  source: "frontmatter" | "body_wikilink";
}

export interface SearchParams {
  query: string;
  filters?: SearchFilters;
}

export interface SearchFilters {
  kinds?: string[];
  status?: string[];
  limit?: number;
}

export interface ListFilters extends SearchFilters {
  // scope intentionally not exposed to LLM (Facade per memory-architecture.md §3 +
  // brain-redesign-spec.md §4.3): list is a browse/debug surface, not a routing
  // selector. Internal callers needing scope routing should slice the loaded
  // entries array directly.
  cursor?: string;
}

export interface GetParams {
  slug: string;
  options?: { include_related?: boolean };
}

export interface NeighborsParams {
  slug: string;
  options?: { hop?: number; max?: number };
}
