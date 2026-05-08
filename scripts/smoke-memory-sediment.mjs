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
  const dirs = ["_shared", "memory", "sediment"];
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
    const { listMigrationBackups, migrateOne, restoreMigrationBackup } = req("./sediment/migration.js");
    const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");
    const { buildRunWindow, saveCheckpoint, loadCheckpoint, loadSessionCheckpoint, saveSessionCheckpoint } = req("./sediment/checkpoint.js");
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

    // Regression: code-span / fenced-block [[X]] tokens must NOT become graph edges.
    // Only the real wikilink to `beta` should yield a body_wikilink edge from `gamma`.
    writeFile(path.join(root, ".pensieve", "knowledge", "gamma.md"), makeEntry({
      title: "Gamma Wikilink Cases",
      body: [
        "Real link: [[beta]].",
        "",
        "Inline example: `[[example-in-code]]` should not become an edge.",
        "",
        "Another inline: `[[wikilink]]` is a placeholder.",
        "",
        "Fenced sample (must be skipped):",
        "",
        "```",
        "see also [[fence-link-1]] and [[fence-link-2]]",
        "```",
      ].join("\n"),
    }));
    const graph2 = await rebuildGraphIndex(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(graph2.nodeCount === 3, `graph rebuild should pick up gamma (got ${graph2.nodeCount})`);
    const graphJson = JSON.parse(fs.readFileSync(path.join(root, ".pensieve", ".index", "graph.json"), "utf-8"));
    const gammaEdges = graphJson.edges.filter((e) => e.from === "gamma");
    const gammaWikilinkTargets = gammaEdges.filter((e) => e.source === "body_wikilink").map((e) => e.to);
    assert(
      gammaWikilinkTargets.length === 1 && gammaWikilinkTargets[0] === "beta",
      `gamma should have exactly one body_wikilink edge to beta, got: ${JSON.stringify(gammaWikilinkTargets)}`,
    );
    for (const banned of ["example-in-code", "wikilink", "fence-link-1", "fence-link-2"]) {
      assert(!gammaWikilinkTargets.includes(banned), `code-span/fenced wikilink "${banned}" leaked into graph edges`);
    }
    fs.unlinkSync(path.join(root, ".pensieve", "knowledge", "gamma.md"));

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
    const legacyPlan = migration.items.find((item) => item.source_path === ".pensieve/short-term/maxims/legacy.md");
    assert(legacyPlan?.plan_command === "/sediment migrate-one --plan .pensieve/short-term/maxims/legacy.md", "migration plan command missing");
    assert(legacyPlan?.apply_command === "/sediment migrate-one --apply --yes .pensieve/short-term/maxims/legacy.md", "migration apply command missing");
    const migrationReport = await writeMigrationReport(path.join(root, ".pensieve"), migration, root);
    const migrationReportText = fs.readFileSync(path.join(root, ".pi-astack", "memory", "migration-report.md"), "utf-8");
    assert(fs.existsSync(path.join(root, ".pi-astack", "memory", "migration-report.md")), "migration report not written");
    assert(migrationReportText.includes("Suggested Single-File Workflow"), "migration report missing workflow guidance");
    assert(migrationReportText.includes("/sediment migrate-one --plan .pensieve/short-term/maxims/legacy.md"), "migration report missing plan command");
    assert(migrationReportText.includes("/sediment migrate-one --apply --yes .pensieve/short-term/maxims/legacy.md"), "migration report missing apply command");
    assert(migrationReport.migrateCount === migration.migrateCount, "migration report count mismatch");

    const migratePlanned = await migrateOne(".pensieve/short-term/maxims/legacy.md", {
      projectRoot: root,
      sedimentSettings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      memorySettings: DEFAULT_SETTINGS,
      apply: false,
      yes: false,
      plan: true,
    });
    assert(migratePlanned.status === "dry_run", `migrate-one plan failed: ${migratePlanned.reason}`);
    assert(migratePlanned.target_path === ".pensieve/maxims/legacy.md", "migrate-one plan target mismatch");
    assert(migratePlanned.preview?.frontmatter.includes("schema_version: 1"), "migrate-one plan preview missing schema_version");
    assert(!fs.existsSync(path.join(root, ".pensieve", "maxims", "legacy.md")), "migrate-one plan should not write target");

    const migrateApplied = await migrateOne(".pensieve/short-term/maxims/legacy.md", {
      projectRoot: root,
      sedimentSettings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      memorySettings: DEFAULT_SETTINGS,
      apply: true,
      yes: true,
    });
    assert(migrateApplied.status === "applied", `migrate-one failed: ${migrateApplied.reason}`);
    assert(migrateApplied.restore_command === `/sediment migrate-one --restore ${migrateApplied.backup_path} --yes`, "migrate-one restore command missing");
    assert(!migrateApplied.derived?.error, `migrate-one derived rebuild failed: ${migrateApplied.derived?.error}`);
    assert(fs.existsSync(path.join(root, ".pensieve", "maxims", "legacy.md")), "migrate-one target not written");
    assert(fs.existsSync(path.join(root, migrateApplied.backup_path)), "migrate-one backup not written");
    assert(fs.existsSync(path.join(root, ".pensieve", ".index", "graph.json")), "migrate-one graph index not rebuilt");
    assert(fs.existsSync(path.join(root, ".pensieve", "_index.md")), "migrate-one markdown index not rebuilt");

    const backups = await listMigrationBackups(root, DEFAULT_SETTINGS, 10);
    const listedBackup = backups.items.find((item) => item.backup_path === migrateApplied.backup_path);
    assert(listedBackup, "migration-backups should list applied backup");
    assert(listedBackup.restore_command === migrateApplied.restore_command, "migration-backups restore command mismatch");
    assert(listedBackup.state === "restorable_remove_target", `migration-backups state mismatch: ${listedBackup.state}`);

    const migratedTarget = path.join(root, ".pensieve", "maxims", "legacy.md");
    const migratedTargetText = fs.readFileSync(migratedTarget, "utf-8");
    fs.writeFileSync(migratedTarget, `${migratedTargetText}\nmanual edit after migration\n`);
    const restoreConflict = await restoreMigrationBackup(migrateApplied.backup_path, {
      projectRoot: root,
      sedimentSettings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      memorySettings: DEFAULT_SETTINGS,
      yes: true,
    });
    assert(restoreConflict.status === "rejected" && restoreConflict.reason === "target_modified", `restore conflict should reject target_modified, got ${restoreConflict.reason}`);
    assert(!fs.existsSync(path.join(root, ".pensieve", "short-term", "maxims", "legacy.md")), "restore conflict should not restore source");
    assert(fs.readFileSync(migratedTarget, "utf-8").includes("manual edit after migration"), "restore conflict should preserve modified target");
    const conflictBackups = await listMigrationBackups(root, DEFAULT_SETTINGS, 10);
    const listedConflict = conflictBackups.items.find((item) => item.backup_path === migrateApplied.backup_path);
    assert(listedConflict?.state === "target_modified", `migration-backups conflict state mismatch: ${listedConflict?.state}`);
    fs.writeFileSync(migratedTarget, migratedTargetText);

    const restored = await restoreMigrationBackup(migrateApplied.backup_path, {
      projectRoot: root,
      sedimentSettings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      memorySettings: DEFAULT_SETTINGS,
      yes: true,
    });
    assert(restored.status === "restored", `restore migration backup failed: ${restored.reason}`);
    assert(restored.removed_target, "restore should remove migrated target");
    assert(fs.existsSync(path.join(root, ".pensieve", "short-term", "maxims", "legacy.md")), "restore did not restore original source");
    assert(!fs.existsSync(path.join(root, ".pensieve", "maxims", "legacy.md")), "restore did not remove migrated target");
    assert(fs.readFileSync(path.join(root, ".pensieve", "short-term", "maxims", "legacy.md"), "utf-8").includes("type: maxim"), "restore source content mismatch");
    assert(!restored.derived?.error, `restore derived rebuild failed: ${restored.derived?.error}`);

    const doctor = await runDoctorLite(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(["pass", "warning", "error"].includes(doctor.status), "doctor-lite invalid status");
    assert(doctor.migrationBackups.total >= 1, "doctor-lite should report migration backups");
    assert(doctor.migrationBackups.stateCounts.already_restored >= 1, "doctor-lite should report restored backup state");

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

    // Regression: per-session checkpoint isolation. Two sessions sharing
    // the same project root must NOT clobber each other's last-processed
    // entry id. Subprocess / ephemeral pi (sessionId=undefined) MUST NOT
    // persist any state.
    const concRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-conc-"));
    fs.mkdirSync(path.join(concRoot, ".pensieve"), { recursive: true });
    await saveSessionCheckpoint(concRoot, "session-A", { lastProcessedEntryId: "entryA-99" });
    await saveSessionCheckpoint(concRoot, "session-B", { lastProcessedEntryId: "entryB-42" });
    const cpA = await loadSessionCheckpoint(concRoot, "session-A");
    const cpB = await loadSessionCheckpoint(concRoot, "session-B");
    assert(cpA.lastProcessedEntryId === "entryA-99", `session A checkpoint corrupted by session B: ${cpA.lastProcessedEntryId}`);
    assert(cpB.lastProcessedEntryId === "entryB-42", `session B checkpoint corrupted by session A: ${cpB.lastProcessedEntryId}`);
    const cpUnknown = await loadSessionCheckpoint(concRoot, "session-C-never-saved");
    assert(!cpUnknown.lastProcessedEntryId, "unknown session must return empty checkpoint, not steal another session's slot");
    // Ephemeral mode: undefined sessionId is no-op for both load and save.
    await saveSessionCheckpoint(concRoot, undefined, { lastProcessedEntryId: "ephemeral-leak" });
    const cpAAfterEphemeral = await loadSessionCheckpoint(concRoot, "session-A");
    assert(cpAAfterEphemeral.lastProcessedEntryId === "entryA-99", "ephemeral save must not affect any persisted session slot");
    const cpEph = await loadSessionCheckpoint(concRoot, undefined);
    assert(!cpEph.lastProcessedEntryId, "ephemeral load must return empty checkpoint regardless of file content");
    // Verify on-disk shape: schema_version 2 + sessions map with both keys.
    const cpDiskRaw = JSON.parse(fs.readFileSync(path.join(concRoot, ".pi-astack", "sediment", "checkpoint.json"), "utf-8"));
    assert(cpDiskRaw.schema_version === 2, `expected checkpoint schema_version=2, got ${cpDiskRaw.schema_version}`);
    assert(cpDiskRaw.sessions && cpDiskRaw.sessions["session-A"]?.lastProcessedEntryId === "entryA-99", "on-disk session A slot missing");
    assert(cpDiskRaw.sessions["session-B"]?.lastProcessedEntryId === "entryB-42", "on-disk session B slot missing");

    // Regression: v1 schema (raw {lastProcessedEntryId}) auto-upgrades on
    // first read. v1 with no sessionId lands in the LEGACY slot and is
    // adopted by the first session that writes (then cleared).
    const v1Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-v1-"));
    fs.mkdirSync(path.join(v1Root, ".pi-astack", "sediment"), { recursive: true });
    fs.mkdirSync(path.join(v1Root, ".pensieve"), { recursive: true });
    fs.writeFileSync(
      path.join(v1Root, ".pi-astack", "sediment", "checkpoint.json"),
      JSON.stringify({ lastProcessedEntryId: "legacy-77", updatedAt: "2026-05-08T10:00:00.000+08:00" }, null, 2),
    );
    const v1Loaded = await loadSessionCheckpoint(v1Root, "new-session");
    assert(v1Loaded.lastProcessedEntryId === "legacy-77", `v1 LEGACY slot not adopted by new session, got ${v1Loaded.lastProcessedEntryId}`);
    await saveSessionCheckpoint(v1Root, "new-session", { lastProcessedEntryId: "new-78" });
    const v1AfterAdoption = JSON.parse(fs.readFileSync(path.join(v1Root, ".pi-astack", "sediment", "checkpoint.json"), "utf-8"));
    assert(!v1AfterAdoption.sessions["_legacy"], "_legacy slot must be cleared after adoption");
    assert(v1AfterAdoption.sessions["new-session"]?.lastProcessedEntryId === "new-78", "v1 carry-over not persisted under new session");

    const marker = `MEMORY:
title: Explicit Candidate
kind: fact
confidence: 4
---
# Explicit Candidate

This is a valid explicit marker body.
END_MEMORY`;
    assert(parseExplicitMemoryBlocks(marker).length === 1, "explicit marker parse failed");

    // Regression: MEMORY: blocks inside fenced code (``` or ~~~) must be
    // skipped — those are docs/demos, not directives. Bare top-level blocks
    // are still captured. A legitimate body MAY contain code samples without
    // corrupting the parse.
    const fencedDemo = [
      "Here is the format I'd document for users:",
      "",
      "```",
      "MEMORY:",
      "title: Demo Inside Fence",
      "kind: fact",
      "confidence: 3",
      "---",
      "# Demo Inside Fence",
      "This must NOT be captured.",
      "END_MEMORY",
      "```",
      "",
      "And same with tildes:",
      "",
      "~~~",
      "MEMORY:",
      "title: Demo Inside Tildes",
      "kind: fact",
      "---",
      "# Demo Inside Tildes",
      "Also NOT captured.",
      "END_MEMORY",
      "~~~",
      "",
      "But this real one at top level should be captured, even though",
      "its body contains a fenced code sample:",
      "",
      "MEMORY:",
      "title: Real Insight With Code Body",
      "kind: fact",
      "confidence: 4",
      "---",
      "# Real Insight With Code Body",
      "",
      "Example usage:",
      "",
      "```python",
      "print('hello')",
      "```",
      "",
      "That is the gist.",
      "END_MEMORY",
    ].join("\n");
    const fencedDrafts = parseExplicitMemoryBlocks(fencedDemo);
    assert(
      fencedDrafts.length === 1 && fencedDrafts[0].title === "Real Insight With Code Body",
      `expected exactly one captured draft ("Real Insight With Code Body"), got ${fencedDrafts.length}: ${fencedDrafts.map(d=>d.title).join(", ")}`,
    );
    for (const banned of ["Demo Inside Fence", "Demo Inside Tildes"]) {
      assert(!fencedDrafts.some(d => d.title === banned), `fenced MEMORY block "${banned}" leaked into drafts`);
    }

    const llmSummary = summarizeLlmExtractorDryRun({ ok: true, model: "x/y", rawText: "SKIP", extraction: { count: 0, drafts: [] } }, { maxCandidates: 3, rawPreviewChars: 10 });
    assert(llmSummary.quality.reason === "skip" && llmSummary.quality.passed, "llm summary skip gate failed");

    writeFile(path.join(root, ".pi-astack", "sediment", "audit.jsonl"), JSON.stringify({
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
