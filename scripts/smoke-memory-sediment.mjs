#!/usr/bin/env node
/**
 * Smoke test for pi-astack memory + sediment extensions.
 *
 * This intentionally avoids pi runtime dependencies: TypeScript sources are
 * transpiled to a temp CommonJS tree and `typebox` is stubbed with the tiny
 * subset used by the tool schemas. The test exercises parser/search/lint/
 * graph/index/migration/sediment writer/checkpoint/dedupe/extractor/report
 * paths without touching the real project `.pensieve/`.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function assertNoLegacyPackageScope() {
  const legacyScope = ["@mariozechner", "pi-"].join("/");
  const roots = ["extensions", "docs", "package.json", "README.md"];
  const offenders = [];
  function visit(file) {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(file)) visit(path.join(file, child));
      return;
    }
    if (!/\.(ts|md|json)$/.test(file)) return;
    const raw = fs.readFileSync(file, "utf-8");
    if (raw.includes(legacyScope)) offenders.push(path.relative(repoRoot, file));
  }
  for (const root of roots) visit(path.join(repoRoot, root));
  assert(offenders.length === 0, `legacy pi package scope remains: ${offenders.join(", ")}`);
}

function transpileExtensions(outRoot) {
  const extRoot = path.join(repoRoot, "extensions");
  const dirs = ["memory", "sediment"];
  let count = 0;
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const srcPath = path.join(srcDir, file);
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      const src = fs.readFileSync(srcPath, "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      });
      writeFile(outPath, out.outputText);
      count++;
    }
  }

  // Minimal typebox subset for registerTool schemas.
  writeFile(path.join(outRoot, "node_modules", "typebox", "index.js"), `
exports.Type = {
  Object: (properties, opts = {}) => ({ type: 'object', properties, ...opts }),
  String: (opts = {}) => ({ type: 'string', ...opts }),
  Optional: (schema) => ({ ...schema, optional: true }),
  Any: (opts = {}) => ({ ...opts }),
};
`);

  return count;
}

function makeEntry({ title, kind = "fact", status = "active", confidence = 5, body = "Body.", extraFrontmatter = "" }) {
  return `---
title: ${title}
scope: project
kind: ${kind}
status: ${status}
confidence: ${confidence}
created: 2026-05-08
schema_version: 1
${extraFrontmatter}---
# ${title}

${body}

## Timeline

- 2026-05-08 | smoke | captured | ok
`;
}

async function main() {
  assertNoLegacyPackageScope();
  const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-"));
  const count = transpileExtensions(outRoot);
  const req = createRequire(path.join(outRoot, "runner.cjs"));

  try {
    const memoryExt = req("./memory/index.js").default;
    const sedimentExt = req("./sediment/index.js").default;
    const { splitFrontmatter } = req("./memory/parser.js");
    const { lintMarkdown } = req("./memory/lint.js");
    const { rebuildGraphIndex } = req("./memory/graph.js");
    const { rebuildMarkdownIndex } = req("./memory/index-file.js");
    const { planMigrationDryRun, writeMigrationReport } = req("./memory/migrate.js");
    const { runDoctorLite } = req("./memory/doctor.js");
    const { DEFAULT_SETTINGS } = req("./memory/settings.js");
    const { writeProjectEntry } = req("./sediment/writer.js");
    const { migrateOne } = req("./sediment/migration.js");
    const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");
    const { buildRunWindow, saveCheckpoint, loadCheckpoint } = req("./sediment/checkpoint.js");
    const { detectProjectDuplicate } = req("./sediment/dedupe.js");
    const { parseExplicitMemoryBlocks } = req("./sediment/extractor.js");
    const { summarizeLlmExtractorDryRun } = req("./sediment/llm-extractor.js");
    const { readLlmDryRunReport, evaluateLlmAutoWriteReadiness } = req("./sediment/report.js");
    const { sanitizeForMemory } = req("./sediment/sanitizer.js");

    const tools = new Map();
    const commands = new Map();
    memoryExt({ registerTool(t) { tools.set(t.name, t); }, registerCommand(n, o) { commands.set(n, o); } });
    sedimentExt({ registerCommand(n, o) { commands.set(n, o); }, on() {} });
    assert(tools.size === 4, `expected 4 memory tools, got ${tools.size}`);
    assert(commands.has("memory") && commands.has("sediment"), "expected memory and sediment commands");

    const fm = splitFrontmatter("---\ntitle: EOF\n---");
    assert(fm.frontmatterText.trim() === "title: EOF" && fm.body === "", "EOF frontmatter parse failed");

    const valid = makeEntry({ title: "Alpha" });
    assert(lintMarkdown(valid).length === 0, "valid entry should lint cleanly");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-project-"));
    fs.mkdirSync(path.join(root, ".pensieve", "knowledge"), { recursive: true });
    fs.mkdirSync(path.join(root, ".pensieve", "staging"), { recursive: true });
    writeFile(path.join(root, ".pensieve", "knowledge", "alpha.md"), makeEntry({ title: "Alpha Memory", body: "Dispatch prompt memory architecture facade." }));
    writeFile(path.join(root, ".pensieve", "staging", "beta.md"), makeEntry({ title: "Beta Smell", kind: "smell", status: "provisional", confidence: 2 }));

    const search = tools.get("memory_search");
    const searchRes = await search.execute("smoke", search.prepareArguments({ query: "dispatch facade", limit: 2 }), new AbortController().signal, null, { cwd: root });
    assert(searchRes.length >= 1 && searchRes[0].slug === "alpha", "memory_search failed");

    const graph = await rebuildGraphIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(fs.existsSync(path.join(root, ".pensieve", ".index", "graph.json")), "graph.json not written");
    assert(graph.nodeCount === 2, "graph node count mismatch");

    const idx = await rebuildMarkdownIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(fs.existsSync(path.join(root, ".pensieve", "_index.md")), "_index.md not written");
    assert(idx.orphanCount === 1, "index orphan count mismatch");

    fs.mkdirSync(path.join(root, ".pensieve", "short-term", "maxims"), { recursive: true });
    writeFile(path.join(root, ".pensieve", "short-term", "maxims", "legacy.md"), `---
type: maxim
title: Legacy Rule
status: active
created: 2026-05-08
---
# Legacy Rule

Body.
`);
    const migration = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(migration.migrateCount >= 1, "migration dry-run found no pending entries");
    const migrationReport = await writeMigrationReport(path.join(root, ".pensieve"), migration, root);
    assert(fs.existsSync(path.join(root, ".pensieve", ".state", "migration-report.md")), "migration report not written");
    assert(migrationReport.migrateCount === migration.migrateCount, "migration report count mismatch");

    const migrateApplied = await migrateOne(".pensieve/short-term/maxims/legacy.md", {
      projectRoot: root,
      sedimentSettings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      memorySettings: DEFAULT_SETTINGS,
      apply: true,
      yes: true,
    });
    assert(migrateApplied.status === "applied", `migrate-one failed: ${migrateApplied.reason}`);
    assert(!migrateApplied.derived?.error, `migrate-one derived rebuild failed: ${migrateApplied.derived?.error}`);
    assert(fs.existsSync(path.join(root, ".pensieve", "maxims", "legacy.md")), "migrate-one target not written");
    assert(fs.existsSync(path.join(root, migrateApplied.backup_path)), "migrate-one backup not written");
    assert(fs.existsSync(path.join(root, ".pensieve", ".index", "graph.json")), "migrate-one graph index not rebuilt");
    assert(fs.existsSync(path.join(root, ".pensieve", "_index.md")), "migrate-one markdown index not rebuilt");

    const doctor = await runDoctorLite(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(["pass", "warning", "error"].includes(doctor.status), "doctor-lite invalid status");

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: root });

    const sanitize = sanitizeForMemory("/home/worker a@example.com 127.0.0.1");
    assert(sanitize.ok && sanitize.replacements.includes("home_path") && sanitize.replacements.includes("email") && sanitize.replacements.includes("ip_address"), "sanitize replacements failed");

    const write = await writeProjectEntry({
      title: "Writer Fixture",
      kind: "fact",
      confidence: 5,
      compiledTruth: "This validates the sediment writer substrate with enough content.",
    }, { projectRoot: root, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
    assert(write.status === "created", `writer failed: ${write.reason}`);

    const duplicate = await detectProjectDuplicate(root, "Writer Fixture");
    assert(duplicate.duplicate, "dedupe failed to detect written entry");

    const branch = [
      { type: "message", id: "a1", timestamp: "2026-05-08T00:00:00Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "b2", timestamp: "2026-05-08T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
    ];
    await saveCheckpoint(root, { lastProcessedEntryId: "a1" });
    const window = buildRunWindow(branch, await loadCheckpoint(root), { ...DEFAULT_SEDIMENT_SETTINGS, minWindowChars: 0 });
    assert(window.candidateEntries === 1 && window.lastEntryId === "b2", "checkpoint window failed");

    const marker = `MEMORY:
title: Explicit Candidate
kind: fact
confidence: 4
---
# Explicit Candidate

This is a valid explicit marker body.
END_MEMORY`;
    assert(parseExplicitMemoryBlocks(marker).length === 1, "explicit marker parse failed");

    const llmSummary = summarizeLlmExtractorDryRun({ ok: true, model: "x/y", rawText: "SKIP", extraction: { count: 0, drafts: [] } }, { maxCandidates: 3, rawPreviewChars: 10 });
    assert(llmSummary.quality.reason === "skip" && llmSummary.quality.passed, "llm summary skip gate failed");

    writeFile(path.join(root, ".pensieve", ".state", "sediment-events.jsonl"), JSON.stringify({
      timestamp: "2026-05-08T00:00:00Z",
      operation: "llm_dry_run",
      llm: { ok: true, model: "x/y", quality: { passed: true, reason: "skip", candidateCount: 0, validationErrorCount: 0, invalidCandidateCount: 0 } },
    }) + "\n");
    const report = await readLlmDryRunReport(root, 10);
    assert(report.total === 1 && report.passCount === 1, "llm report failed");
    const readiness = evaluateLlmAutoWriteReadiness(report, { autoLlmWriteEnabled: true, minDryRunSamples: 1, requiredDryRunPassRate: 1 });
    assert(readiness.ready, "readiness should be true");

    const world = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-abrain-"));
    process.env.ABRAIN_ROOT = world;
    fs.mkdirSync(path.join(world, "facts"), { recursive: true });
    writeFile(path.join(world, "facts", "w.md"), makeEntry({ title: "World Fact", extraFrontmatter: "scope: world\n" }).replace("scope: project\n", ""));
    const worldGraph = await rebuildGraphIndex(path.join(world, "facts", "w.md"), DEFAULT_SETTINGS, undefined, world);
    assert(worldGraph.graph_path === ".state/index/graph.json", "world graph path mismatch");

    console.log(JSON.stringify({ ok: true, transpiledFiles: count, tools: [...tools.keys()], commands: [...commands.keys()] }, null, 2));
  } finally {
    if (process.env.PI_ASTACK_KEEP_SMOKE_TMP !== "1") fs.rmSync(outRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
