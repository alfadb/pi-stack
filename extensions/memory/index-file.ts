import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import type { MemoryEntry, Scope } from "./types";
import { scanStore } from "./parser";
import { buildGraphSnapshot } from "./graph";
import { prettyPath } from "./utils";
import { formatLocalIsoTimestamp } from "../_shared/runtime";

export interface MarkdownIndexRebuildReport {
  target: string;
  index_path: string;
  entryCount: number;
  kindCount: number;
  orphanCount: number;
}

function abrainRoot(): string {
  return path.resolve(
    process.env.ABRAIN_ROOT
      ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".abrain"),
  );
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function inferScope(root: string): Scope {
  return isInside(abrainRoot(), path.resolve(root)) ? "world" : "project";
}

function pensieveRootForFile(abs: string): string | null {
  const parts = path.resolve(abs).split(path.sep);
  const idx = parts.lastIndexOf(".pensieve");
  if (idx < 0) return null;
  return parts.slice(0, idx + 1).join(path.sep) || path.sep;
}

async function targetRoot(target: string): Promise<string> {
  const abs = path.resolve(target);
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile()) {
      const abrain = abrainRoot();
      if (isInside(abrain, abs)) return abrain;
      return pensieveRootForFile(abs) ?? path.dirname(abs);
    }
  } catch {
    return abs;
  }
  return abs;
}

function mdLink(title: string, relPath: string): string {
  const safeTitle = title.replace(/\]/g, "\\]");
  const safePath = relPath.split(path.sep).join("/");
  return `[${safeTitle}](${safePath})`;
}

function entryDate(entry: MemoryEntry): string {
  return entry.updated || entry.created || "";
}

function sortByConfidenceThenDate(a: MemoryEntry, b: MemoryEntry): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const ad = entryDate(a);
  const bd = entryDate(b);
  if (ad !== bd) return bd.localeCompare(ad);
  return a.slug.localeCompare(b.slug);
}

function sortByDateThenConfidence(a: MemoryEntry, b: MemoryEntry): number {
  const ad = entryDate(a);
  const bd = entryDate(b);
  if (ad !== bd) return bd.localeCompare(ad);
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return a.slug.localeCompare(b.slug);
}

function groupByKind(entries: MemoryEntry[]): Map<string, MemoryEntry[]> {
  const map = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const arr = map.get(entry.kind) ?? [];
    arr.push(entry);
    map.set(entry.kind, arr);
  }
  return map;
}

function kindLabel(kind: string): string {
  if (kind.endsWith("s")) return kind;
  if (kind === "maxim") return "maxims";
  if (kind === "decision") return "decisions";
  if (kind === "smell") return "staging";
  if (kind === "anti-pattern") return "anti-patterns";
  return `${kind}s`;
}

export async function buildMarkdownIndex(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<{ root: string; content: string; entries: MemoryEntry[]; orphanSlugs: string[] }> {
  const root = await targetRoot(target);
  const entries = (await scanStore({ scope: inferScope(root), root, label: "index" }, cwd, settings, signal))
    .filter((entry) => entry.status.toLowerCase() !== "archived");
  const graph = await buildGraphSnapshot(root, settings, signal, cwd);
  const orphanSet = new Set(graph.stats.orphans);
  const stagingOrphans = entries
    .filter((entry) => entry.kind === "smell" || entry.sourcePath.split(path.sep).includes("staging"))
    .filter((entry) => orphanSet.has(entry.slug))
    .sort(sortByConfidenceThenDate);

  const lines: string[] = [
    inferScope(root) === "world" ? "# World Knowledge Index" : "# Project Knowledge Index",
    "",
    `> Auto-generated ${formatLocalIsoTimestamp()} | ${entries.length} entries`,
    "",
    "## By Kind",
    "",
  ];

  const groups = groupByKind(entries);
  const sortedKinds = [...groups.keys()].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)));
  for (const kind of sortedKinds) {
    const group = (groups.get(kind) ?? []).sort(sortByConfidenceThenDate);
    const links = group
      .slice(0, 20)
      .map((entry) => mdLink(entry.title, path.relative(root, entry.sourcePath)));
    const suffix = group.length > 20 ? `, ... +${group.length - 20}` : "";
    lines.push(`- **${kindLabel(kind)}** (${group.length}): ${links.join(", ")}${suffix}`);
  }

  lines.push("", "## Recently Updated", "");
  for (const entry of [...entries].sort(sortByDateThenConfidence).slice(0, 10)) {
    const date = entryDate(entry) || "unknown";
    lines.push(`- ${date} | ${mdLink(entry.title, path.relative(root, entry.sourcePath))} | confidence:${entry.confidence}`);
  }

  lines.push("", "## Orphans", "");
  if (stagingOrphans.length === 0) {
    lines.push("- None");
  } else {
    for (const entry of stagingOrphans) {
      lines.push(`- ${mdLink(entry.title, path.relative(root, entry.sourcePath))} — no incoming or outgoing links`);
    }
  }

  lines.push("");
  return { root, content: lines.join("\n"), entries, orphanSlugs: stagingOrphans.map((entry) => entry.slug) };
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

export async function rebuildMarkdownIndex(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<MarkdownIndexRebuildReport> {
  const built = await buildMarkdownIndex(target, settings, signal, cwd);
  const outPath = path.join(built.root, "_index.md");
  await atomicWrite(outPath, built.content);
  return {
    target: prettyPath(path.resolve(target), cwd),
    index_path: prettyPath(outPath, cwd),
    entryCount: built.entries.length,
    kindCount: groupByKind(built.entries).size,
    orphanCount: built.orphanSlugs.length,
  };
}

export function formatMarkdownIndexRebuildReport(report: MarkdownIndexRebuildReport): string {
  return [
    `Memory markdown index rebuilt: ${report.entryCount} entry(s), ${report.kindCount} kind group(s), ${report.orphanCount} staging orphan(s)`,
    `Index path: ${report.index_path}`,
  ].join("\n");
}
