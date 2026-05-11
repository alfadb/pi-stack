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
  const dirs = ["_shared", "memory", "sediment", "compaction-tuner"];
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

  // Minimal pi-ai subset for ADR 0015 memory_search LLM-path smoke. Dynamic
  // import('@earendil-works/pi-ai') from transpiled CommonJS sees these named
  // exports; no real model call is made.
  writeFile(path.join(outRoot, "node_modules", "@earendil-works", "pi-ai", "index.js"), `
exports.__calls = [];
exports.__configs = [];
exports.streamSimple = (_model, opts, config) => {
  exports.__configs.push(config || {});
  const prompt = opts && opts.messages && opts.messages[0] && opts.messages[0].content && opts.messages[0].content[0] && opts.messages[0].content[0].text || '';
  let text;
  if (prompt.includes('MEMORY_SEARCH_CANDIDATES')) {
    exports.__calls.push('memory-search-stage2');
    text = '[{"slug":"alpha","score":10,"why":"direct match"}]';
  } else if (prompt.includes('MEMORY_SEARCH_INDEX')) {
    exports.__calls.push('memory-search-stage1');
    text = '[{"slug":"alpha","reason":"title and summary match"}]';
  } else if (globalThis.__A2_RESPONSES__) {
    // Later A2 tests overwrite the stub file, but dynamic import may have
    // cached this module already. Honor the A2 globals here too.
    text = (globalThis.__A2_RESPONSES__ || [])[globalThis.__A2_INVOCATIONS__++] || 'SKIP';
    globalThis.__A2_LAST_PROMPT__ = prompt;
  } else {
    text = 'SKIP';
  }
  return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text }] }) };
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
    const { archiveProjectEntry, deleteProjectEntry, mergeProjectEntries, supersedeProjectEntry, writeProjectEntry, updateProjectEntry } = req("./sediment/writer.js");
    const { listMigrationBackups, migrateOne, restoreMigrationBackup } = req("./sediment/migration.js");
    const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");
    const { buildRunWindow, saveCheckpoint, loadCheckpoint, loadSessionCheckpoint, saveSessionCheckpoint } = req("./sediment/checkpoint.js");
    const { detectProjectDuplicate } = req("./sediment/dedupe.js");
    const { parseExplicitMemoryBlocks } = req("./sediment/extractor.js");
    const { summarizeLlmExtractorResult } = req("./sediment/llm-extractor.js");
    const { sanitizeForMemory } = req("./sediment/sanitizer.js");
    const compactionTunerExt = req("./compaction-tuner/index.js").default;
    const { classifyDecision, DEFAULT_COMPACTION_TUNER_SETTINGS } = req("./compaction-tuner/index.js");
    const { resolveCompactionTunerSettings } = req("./compaction-tuner/settings.js");

    const tools = new Map();
    const commands = new Map();
    memoryExt({ registerTool(t) { tools.set(t.name, t); }, registerCommand(n, o) { commands.set(n, o); } });
    sedimentExt({ registerCommand(n, o) { commands.set(n, o); }, on() {} });
    compactionTunerExt({ registerCommand(n, o) { commands.set(n, o); }, on() {} });
    assert(tools.size === 4, `expected 4 memory tools, got ${tools.size}`);
    assert(commands.has("memory") && commands.has("sediment") && commands.has("compaction-tuner"), "expected memory, sediment, and compaction-tuner commands");

    // === compaction-tuner: settings parsing + decision logic ===
    {
      // Defaults
      const def = DEFAULT_COMPACTION_TUNER_SETTINGS;
      assert(def.enabled === false, "compaction-tuner default enabled must be false (opt-in)");
      assert(def.thresholdPercent === 75, "compaction-tuner default thresholdPercent must be 75");

      // classifyDecision: percent null -> skip
      assert(classifyDecision(null, 75, true, 5).decision === "skip", "null percent must skip");

      // Below threshold while armed: skip with reason below_threshold
      assert(classifyDecision(50, 75, true, 5).decision === "skip", "50% with threshold 75 must skip");

      // At/above threshold while armed: trigger
      assert(classifyDecision(75, 75, true, 5).decision === "trigger", "exactly threshold must trigger");
      assert(classifyDecision(80, 75, true, 5).decision === "trigger", "above threshold must trigger");

      // Above threshold but disarmed (already triggered, still hot): skip
      // with reason that distinguishes "already triggered" from below-threshold.
      const aboveDisarmed = classifyDecision(80, 75, false, 5);
      assert(aboveDisarmed.decision === "skip" && aboveDisarmed.reason === "already_triggered_awaiting_rearm",
        `disarmed at 80 must skip with awaiting_rearm, got ${JSON.stringify(aboveDisarmed)}`);

      // In-between band (threshold-margin <= percent < threshold) while disarmed:
      // skip with reason "below_threshold" (rearm only fires when usage drops
      // BELOW the floor, otherwise we hover indefinitely).
      const inBand = classifyDecision(72, 75, false, 5);
      assert(inBand.decision === "skip" && inBand.reason === "below_threshold",
        `72%/threshold75/disarmed should skip with below_threshold, got ${JSON.stringify(inBand)}`);

      // Below rearm floor while disarmed: rearm
      assert(classifyDecision(69, 75, false, 5).decision === "rearm", "below rearm floor (75-5=70) must rearm");
      assert(classifyDecision(50, 75, false, 5).decision === "rearm", "way below threshold while disarmed must rearm");

      // Settings clamping: out-of-range thresholdPercent should be clamped
      // (driven via env-pointed settings file).
      const tunerSettingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-tuner-"));
      const tunerSettingsPath = path.join(tunerSettingsRoot, "pi-astack-settings.json");
      const HOME = os.homedir();
      const fakeHome = path.join(tunerSettingsRoot, "home");
      fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(fakeHome, ".pi", "agent", "pi-astack-settings.json"),
        JSON.stringify({
          compactionTuner: {
            enabled: true,
            thresholdPercent: 200,    // out of range, must clamp to 95
            rearmMarginPercent: -3,    // negative, must clamp to 0
            customInstructions: "keep memory architecture details",
          },
        }),
      );
      const origHome = process.env.HOME;
      process.env.HOME = fakeHome;
      // settings.ts reads os.homedir() at call time only inside the function body via
      // path.join(os.homedir(), ...). require'd module re-evaluates os.homedir() each
      // call to loadPiStackSettings() because the path is computed inside fsSync.readFile.
      // BUT our settings.ts captures PI_STACK_SETTINGS_PATH at module load time as a
      // const — so we must re-load via fresh require (delete cache).
      const settingsModulePath = require.resolve(path.join(outRoot, "compaction-tuner", "settings.js"));
      delete require.cache[settingsModulePath];
      const { resolveCompactionTunerSettings: freshResolve } = req("./compaction-tuner/settings.js");
      const clamped = freshResolve();
      assert(clamped.enabled === true, "settings file should yield enabled=true");
      assert(clamped.thresholdPercent === 95, `out-of-range thresholdPercent must clamp to 95, got ${clamped.thresholdPercent}`);
      assert(clamped.rearmMarginPercent === 0, `negative rearmMarginPercent must clamp to 0, got ${clamped.rearmMarginPercent}`);
      assert(clamped.customInstructions === "keep memory architecture details", "customInstructions must round-trip");
      process.env.HOME = origHome;
      // restore caches for any later tests
      delete require.cache[settingsModulePath];
    }

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
    const mockModelRegistry = {
      find(provider, id) {
        return {
          provider,
          id,
          reasoning: true,
          thinkingLevelMap: { off: "", high: "high", xhigh: "xhigh", minimal: null, low: null, medium: null },
        };
      },
      async getApiKeyAndHeaders() { return { ok: true, apiKey: "smoke-key" }; },
    };

    // memory tools wrap results in ToolResult envelope { content: [{ type, text }], isError? }
    // since commit 7f2b5d8 (fix(memory): wrap tool results in ToolResult shape).
    // smoke must unwrap to access the business payload (plain JSON array/object).
    // ADR 0015: memory_search has no grep degradation path; it requires LLM
    // modelRegistry and should return a hard error when modelRegistry is missing.
    const missingRegistryRaw = await search.execute("smoke-no-registry", search.prepareArguments({ query: "find memory about dispatch facade", limit: 2 }), new AbortController().signal, null, { cwd: root });
    assert(missingRegistryRaw.isError, `memory_search without modelRegistry must hard-error, got: ${JSON.stringify(missingRegistryRaw)}`);
    const missingRegistryPayload = JSON.parse(missingRegistryRaw.content[0].text);
    assert(String(missingRegistryPayload.error || "").includes("modelRegistry"), `missing-registry error should mention modelRegistry: ${JSON.stringify(missingRegistryPayload)}`);
    assert(String(missingRegistryPayload.hint || "").includes("does not degrade to grep"), `missing-registry hint should reject grep degradation: ${JSON.stringify(missingRegistryPayload)}`);

    // ADR 0015 smoke: default memory_search path should call the two-stage LLM
    // reranker when a modelRegistry is available, and return the same normalized
    // ToolResult envelope shape.
    const llmSearchRaw = await search.execute("smoke-llm", search.prepareArguments({ query: "找关于 dispatch facade 的 memory entry", limit: 2 }), new AbortController().signal, null, { cwd: root, modelRegistry: mockModelRegistry });
    assert(!llmSearchRaw.isError, `memory_search LLM path returned isError envelope: ${JSON.stringify(llmSearchRaw)}`);
    assert(Array.isArray(llmSearchRaw?.content) && llmSearchRaw.content[0]?.type === "text", "memory_search envelope shape regressed (expected { content: [{type:'text', text}] })");
    const llmSearchRes = JSON.parse(llmSearchRaw.content[0].text);
    assert(Array.isArray(llmSearchRes) && llmSearchRes.length === 1 && llmSearchRes[0].slug === "alpha" && llmSearchRes[0].score === 1, `memory_search LLM path failed: ${JSON.stringify(llmSearchRes)}`);
    assert(llmSearchRes[0].degraded === undefined, "memory_search LLM result must not expose degraded flag when no degradation path exists");
    assert(llmSearchRes[0].created === "2026-05-08", "memory_search LLM result should expose created freshness signal");
    assert(Array.isArray(llmSearchRes[0].timeline_tail) && llmSearchRes[0].timeline_tail.length === 1, "memory_search LLM result should expose timeline_tail freshness signal");
    assert(llmSearchRes[0].rank_reason === "direct match", "memory_search LLM result should expose stage2 rank_reason");
    const piAiStub = req("@earendil-works/pi-ai");
    assert(JSON.stringify(piAiStub.__calls) === JSON.stringify(["memory-search-stage1", "memory-search-stage2"]), `memory_search should call stage1+stage2, got ${JSON.stringify(piAiStub.__calls)}`);
    assert(piAiStub.__configs[0]?.reasoning === "off" && piAiStub.__configs[1]?.reasoning === "high", `memory_search thinking config mismatch: ${JSON.stringify(piAiStub.__configs)}`);

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

    const missingPensieveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-no-pensieve-"));
    const createdRootWrite = await writeProjectEntry({
      title: "Writer Creates Pensieve Root",
      kind: "fact",
      confidence: 5,
      compiledTruth: "The sediment writer creates the project .pensieve directory on demand when it is missing.",
    }, { projectRoot: missingPensieveRoot, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
    assert(createdRootWrite.status === "created", `writer should create missing .pensieve root: ${createdRootWrite.reason}`);
    assert(fs.existsSync(path.join(missingPensieveRoot, ".pensieve")), "writer did not create .pensieve root on demand");

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

    // Regression: legacy audit file merge produces exactly one `\n`
    // between rows, not zero (which would fuse JSONL lines) and not two
    // (which would inject blank rows). Specifically reproduces the bug
    // where ensureSedimentLegacyMigrated added an unconditional `\n`
    // separator on top of canonical's existing trailing `\n`.
    const mergeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-merge-"));
    fs.mkdirSync(path.join(mergeRoot, ".pensieve", ".state"), { recursive: true });
    fs.mkdirSync(path.join(mergeRoot, ".pi-astack", "sediment"), { recursive: true });
    // Canonical already has a row (terminated by \n).
    fs.writeFileSync(
      path.join(mergeRoot, ".pi-astack", "sediment", "audit.jsonl"),
      JSON.stringify({ timestamp: "2026-05-08T15:00:00.000+08:00", operation: "canonical" }) + "\n",
    );
    // Legacy has one row (also terminated by \n).
    fs.writeFileSync(
      path.join(mergeRoot, ".pensieve", ".state", "sediment-events.jsonl"),
      JSON.stringify({ timestamp: "2026-05-08T14:55:00.000+08:00", operation: "legacy" }) + "\n",
    );
    // Trigger migration via any audit-touching call.
    await req("./sediment/writer.js").appendAudit(mergeRoot, { operation: "new", timestamp: "2026-05-08T15:01:00.000+08:00" });
    const mergedRaw = fs.readFileSync(path.join(mergeRoot, ".pi-astack", "sediment", "audit.jsonl"), "utf-8");
    const mergedLines = mergedRaw.split("\n");
    // Expect exactly: canonical, legacy, new, "" (trailing) — total 4.
    assert(mergedLines.length === 4, `expected 4 lines (3 rows + trailing newline), got ${mergedLines.length}: ${JSON.stringify(mergedLines)}`);
    assert(mergedLines[3] === "", `last element after split should be empty (trailing newline), got: ${JSON.stringify(mergedLines[3])}`);
    for (let i = 0; i < 3; i++) {
      assert(mergedLines[i].length > 0, `merged line ${i} should be non-empty, got: ${JSON.stringify(mergedLines[i])}`);
      const parsed = JSON.parse(mergedLines[i]);
      assert(parsed.operation, `merged line ${i} should be parseable JSONL with operation`);
    }
    assert(JSON.parse(mergedLines[0]).operation === "canonical", "merged: existing canonical row preserved at top");
    assert(JSON.parse(mergedLines[1]).operation === "legacy", "merged: legacy row appended after canonical");
    assert(JSON.parse(mergedLines[2]).operation === "new", "merged: new appendAudit landed after migration");
    assert(!fs.existsSync(path.join(mergeRoot, ".pensieve", ".state", "sediment-events.jsonl")), "legacy audit file removed after merge");

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

    // Regression: fence state must reset at transcript entry boundaries.
    // A prior message may contain an unmatched code fence; that must not
    // flip the fence parity for a later assistant message and cause a
    // fenced MEMORY format example to be written as a real memory.
    const crossEntryFenceDrift = [
      "--- ENTRY old 2026-05-11T00:00:00Z message/assistant ---",
      "```",
      "an older message left a fence unmatched in the run window",
      "--- ENTRY new 2026-05-11T00:00:01Z message/assistant ---",
      "This is documentation only:",
      "",
      "```text",
      "MEMORY:",
      "title: Fenced Example Must Not Persist",
      "kind: fact",
      "confidence: 7",
      "---",
      "# Fenced Example Must Not Persist",
      "This example must not be captured.",
      "END_MEMORY",
      "```",
      "",
      "But this real top-level block should be captured:",
      "",
      "MEMORY:",
      "title: Cross Entry Real Insight",
      "kind: fact",
      "confidence: 4",
      "---",
      "# Cross Entry Real Insight",
      "This real top-level memory should still be captured.",
      "END_MEMORY",
    ].join("\n");
    const crossEntryDrafts = parseExplicitMemoryBlocks(crossEntryFenceDrift);
    assert(crossEntryDrafts.length === 1 && crossEntryDrafts[0].title === "Cross Entry Real Insight", `entry-local fence reset failed: ${crossEntryDrafts.map(d => d.title).join(", ")}`);

    const llmSummary = summarizeLlmExtractorResult({ ok: true, model: "x/y", rawText: "SKIP", extraction: { count: 0, drafts: [] } }, { maxCandidates: 3, rawPreviewChars: 10 });
    assert(llmSummary.quality.reason === "skip" && llmSummary.quality.passed, "llm summary skip gate failed");

    // === Safety/storage checks retained after ADR 0016 ==================
    // Only sensitive-info and storage-integrity checks remain hard gates.

    // Sensitive-info sanitizer patterns — JWT, PEM, AWS access key, conn URL.
    {
      const jwt = sanitizeForMemory("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
      assert(!jwt.ok && /jwt_token/.test(jwt.error || ""), `jwt_token must reject: ${JSON.stringify(jwt)}`);
      const pem = sanitizeForMemory("-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAL...\n-----END RSA PRIVATE KEY-----");
      assert(!pem.ok && /pem_private_key/.test(pem.error || ""), `pem_private_key must reject: ${JSON.stringify(pem)}`);
      const aws = sanitizeForMemory("AKIAIOSFODNN7EXAMPLE is the access key");
      assert(!aws.ok && /aws_access_key/.test(aws.error || ""), `aws_access_key must reject: ${JSON.stringify(aws)}`);
      const dbUrl = sanitizeForMemory("db: mongodb://user:p4ssw0rd@host.example/dbname");
      assert(!dbUrl.ok && /connection_url/.test(dbUrl.error || ""), `connection_url must reject: ${JSON.stringify(dbUrl)}`);
      // Negative: ordinary IP/email/$HOME paths still must not match credential rules.
      const benign = sanitizeForMemory("user@example.com on 127.0.0.1 at /home/worker/projects");
      assert(benign.ok, `benign content should pass: ${JSON.stringify(benign)}`);
    }

    // compiledTruth body containing a bare `---` line gets escaped
    //     so it no longer matches the frontmatter delimiter regex on read.
    {
      const g6Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-g6-"));
      fs.mkdirSync(path.join(g6Root, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: g6Root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: g6Root });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: g6Root });
      const r = await writeProjectEntry({
        title: "Frontmatter Break Out",
        kind: "fact",
        confidence: 5,
        compiledTruth: [
          "Body section A.",
          "",
          "---",
          "",
          "Body section B (after bare hr).",
        ].join("\n"),
      }, { projectRoot: g6Root, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(r.status === "created", `frontmatter breakout write failed: ${r.reason}`);
      const written = fs.readFileSync(r.path, "utf-8");
      // Re-parse the file: the surviving frontmatter must have exactly
      // ONE closing `---` (the real one), and the second body-side hr
      // must be the escaped form (" ---" with a leading space).
      const fm2 = splitFrontmatter(written);
      assert(fm2.frontmatterText.length > 0, "frontmatter breakout read-back: frontmatter parse failed");
      assert(/^title: /m.test(fm2.frontmatterText), "frontmatter breakout frontmatter missing title (parser ate too far)");
      assert(/^ ---$/m.test(fm2.body), `frontmatter breakout body must contain escaped hr (" ---"), got:\n${fm2.body}`);
      assert(!/^---$/m.test(fm2.body), `frontmatter breakout body still has bare frontmatter delimiter: ${fm2.body}`);
    }

    // triggerPhrases pass through sanitizer; a credential in any
    //     phrase rejects the whole write.
    {
      const g8Root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-g8-"));
      fs.mkdirSync(path.join(g8Root, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: g8Root, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: g8Root });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: g8Root });
      const bad = await writeProjectEntry({
        title: "Phrase Leak",
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body that is fine on its own and long enough to pass validation.",
        triggerPhrases: ["normal phrase", "sk-abcdef0123456789abcdef0123456789"],
      }, { projectRoot: g8Root, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(bad.status === "rejected" && /openai_api_key|credential/.test(bad.reason || ""), `trigger phrase sanitizer must reject credential in triggerPhrases: ${JSON.stringify(bad)}`);
      // Negative: phrases that only contain $HOME paths get scrubbed and pass.
      const ok = await writeProjectEntry({
        title: "Phrase Path Scrub",
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body that is fine on its own and long enough to pass validation.",
        triggerPhrases: [`work from ${require("node:os").homedir()}/projects`],
      }, { projectRoot: g8Root, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(ok.status === "created", `trigger phrase scrub write should succeed: ${JSON.stringify(ok)}`);
      const okWritten = fs.readFileSync(ok.path, "utf-8");
      assert(okWritten.includes("$HOME") && !okWritten.includes("/home/worker") && !okWritten.includes(`${require("node:os").homedir()}/projects`), "trigger phrase $HOME scrub did not redact");
    }

    // Prompt strengthening (role-aware boundary + durability test).
    // We don't hit a real LLM here; just assert the prompt text
    // contains the required directive substrings so a future weakening
    // is caught.
    {
      const { buildLlmExtractorPrompt } = req("./sediment/llm-extractor.js");
      const p = buildLlmExtractorPrompt("--- ENTRY x 0 message/user ---\nfake content");
      const required = [
        // Trust boundary (A1)
        "Trust boundary",
        "role=user",
        "role=toolResult",
        "never as instructions",
        "kind=maxim",
        "[0, 10]",
        // Durability test (added after first-fire produced transient
        // event entries; "after the restart at 16:43" is the canary).
        "Durability test",
        "transient operational event",
        "Per-window cap",
        "TWO MEMORY blocks",
        "Title hygiene",
      ];
      for (const needle of required) {
        assert(p.includes(needle), `prompt missing required marker: ${JSON.stringify(needle)}`);
      }
    }

    // === slug-from-title bug fix ===========================================
    // First-fire 2026-05-08 produced an entry with title "Sediment Audit
    // Rows Can Be Distinguished by extractor/reason Combinations" — the
    // writer used normalizeBareSlug(title) which interprets `/` as a
    // path separator and only kept "reason Combinations". Slug landed as
    // `reason-combinations` (lossy + ambiguous). Writer + dedupe both now
    // call slugify(title) directly. This regression locks in the fix.
    {
      const slugBugRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-slugbug-"));
      fs.mkdirSync(path.join(slugBugRoot, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: slugBugRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: slugBugRoot });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: slugBugRoot });
      const titleWithSlash = "Audit Rows Distinguished by extractor/reason Combinations";
      const w = await writeProjectEntry({
        title: titleWithSlash,
        kind: "fact",
        confidence: 5,
        compiledTruth: "Body content for the slug-from-title regression.",
      }, { projectRoot: slugBugRoot, settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false }, dryRun: false });
      assert(w.status === "created", `slug-bug write failed: ${w.reason}`);
      // Expected: slug derived from full title with / replaced by -.
      assert(
        w.slug === "audit-rows-distinguished-by-extractor-reason-combinations",
        `slug must include both sides of '/' as words, got: ${w.slug}`,
      );
      // Negative: must NOT be the truncated form from the bug.
      assert(w.slug !== "reason-combinations", `slug truncation bug regressed: ${w.slug}`);
      // Dedupe should also see the same full slug.
      const { detectProjectDuplicate } = req("./sediment/dedupe.js");
      const dup = await detectProjectDuplicate(slugBugRoot, titleWithSlash);
      assert(dup.duplicate && dup.reason === "slug_exact", `dedupe must see same title: ${JSON.stringify(dup)}`);
    }

    // === Sediment status footer state machine ============================
    // The user-spec'd FSM:
    //   session_start -> idle
    //   agent_start in (completed|failed) -> idle
    //   agent_start in running -> running (unchanged)
    //   agent_end transitions running -> completed/failed.
    //
    // We can exercise the helper functions directly via the test
    // export. The hooks themselves are pi-runtime-bound and tested
    // live (smoke can't fake pi.on); here we lock in the helper logic.
    {
      const sedimentMod = req("./sediment/index.js");
      // Internal helpers aren't exported individually — we test via
      // the public reset and the rendered status string format.
      const { renderSedimentStatus } = sedimentMod;
      // renderSedimentStatus may not be exported; verify by rendering
      // through the public path instead. Skip if not exported.
      if (typeof renderSedimentStatus === "function") {
        const idle = renderSedimentStatus("idle");
        const running = renderSedimentStatus("running", "auto-write");
        const completed = renderSedimentStatus("completed", "3 entries");
        const failed = renderSedimentStatus("failed", "LLM error");
        assert(idle.includes("idle"), `idle render missing keyword: ${idle}`);
        assert(running.includes("running") && running.includes("auto-write"), `running render: ${running}`);
        assert(completed.includes("completed") && completed.includes("3 entries"), `completed render: ${completed}`);
        assert(failed.includes("failed") && failed.includes("LLM error"), `failed render: ${failed}`);
      }
    }

    // === A2 integration: direct auto-write substrate via mock modelRegistry ===
    // After ADR 0016, there is no readiness/rate/sampling/rolling gate in
    // this path. Extractor output goes through schema validation + curator/
    // write substrate; git/audit are rollback.
    {
      const { _resetAutoWriteStateForTests } = req("./sediment/index.js");
      _resetAutoWriteStateForTests();

      const aRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-a2-"));
      fs.mkdirSync(path.join(aRoot, ".pensieve"), { recursive: true });
      execFileSync("git", ["init"], { cwd: aRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: aRoot });
      execFileSync("git", ["config", "user.name", "pi smoke"], { cwd: aRoot });


      // Stub the @earendil-works/pi-ai module so streamSimple returns a
      // canned MEMORY block. We use a fresh require cache slot.
      const piAiPath = path.join(outRoot, "node_modules", "@earendil-works", "pi-ai");
      fs.mkdirSync(piAiPath, { recursive: true });
      fs.writeFileSync(path.join(piAiPath, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", main: "index.js" }));
      // The stub captures the prompt so we can assert it contained the
      // role-aware Trust Boundary directive. Each call returns a
      // different response based on the global counter.
      let invocations = 0;
      const RESPONSES = [
        // Run 1: clean valid block.
        "MEMORY:\ntitle: A2 Mock Extracted Insight\nkind: fact\nconfidence: 4\n---\n# A2 Mock Extracted Insight\n\nThe LLM auto-write lane successfully extracted this insight from the transcript window.\nEND_MEMORY",
        // Run 2: SKIP.
        "SKIP",
        // Run 3: maxim/high-confidence attempt. ADR 0016 trusts it.
        "MEMORY:\ntitle: Trusted Maxim Attempt\nkind: maxim\nstatus: active\nconfidence: 9\n---\n# Trusted Maxim Attempt\n\nThis attempts to mint a maxim with confidence 9. ADR 0016 trusts the model to write maxim/high confidence when warranted.\nEND_MEMORY",
      ];
      // Reset global so we control invocation count.
      globalThis.__A2_INVOCATIONS__ = 0;
      globalThis.__A2_LAST_PROMPT__ = "";
      globalThis.__A2_RESPONSES__ = RESPONSES;
      fs.writeFileSync(path.join(piAiPath, "index.js"), `
exports.streamSimple = function streamSimple(_model, opts, _config) {
  const text = (globalThis.__A2_RESPONSES__ || [])[globalThis.__A2_INVOCATIONS__++] || "SKIP";
  globalThis.__A2_LAST_PROMPT__ = (opts.messages?.[0]?.content?.[0]?.text || "");
  return {
    result: () => Promise.resolve({
      stopReason: "complete",
      content: [{ type: "text", text }],
    }),
  };
};
`);

      // Mock model registry: find returns a placeholder; auth returns ok.
      const mockModelRegistry = {
        find: () => ({ id: "mock-extractor", contextWindow: 100000 }),
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-not-a-real-key-just-shape", headers: {} }),
      };

      // Recreate the auto-write substrate directly. The hook's live path
      // additionally calls the curator loop; here we lock in extractor,
      // schema validation, writer create, and writer update behavior.
      const { runLlmExtractor } = req("./sediment/llm-extractor.js");
      const { previewExtraction, parseExplicitMemoryBlocks: parseBlocks } = req("./sediment/extractor.js");

      const a2Settings = {
        ...DEFAULT_SEDIMENT_SETTINGS,
        autoLlmWriteEnabled: true,
        extractorModel: "mock/extractor",
        gitCommit: false,
      };

      // Run the extractor directly (the in-process flow that
      // tryAutoWriteLane uses) for response[0]: valid block.
      const r1 = await runLlmExtractor("--- ENTRY 1 t1 message/assistant ---\nWe figured out X.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r1.ok && r1.rawText && r1.rawText.includes("A2 Mock Extracted Insight"), `r1 mock should return valid block: ${JSON.stringify(r1)}`);
      // Verify the prompt contained the Trust Boundary directive.
      assert(globalThis.__A2_LAST_PROMPT__.includes("Trust boundary"), "prompt to mock LLM missing Trust boundary directive");
      // Parse + schema-only validation. Semantic hard gates are gone.
      const drafts1 = parseBlocks(r1.rawText);
      const preview1 = previewExtraction(drafts1);
      assert(preview1.drafts[0].validationErrors.length === 0, `r1 should pass schema validation: ${JSON.stringify(preview1)}`);
      // Write through the production path.
      const w1 = await writeProjectEntry({
        ...drafts1[0],
        sessionId: "smoke-a2",
        timelineNote: "smoke A2 e2e",
      }, { projectRoot: aRoot, settings: a2Settings, dryRun: false });
      assert(w1.status === "created", `r1 write failed: ${w1.reason}`);
      const r1Written = fs.readFileSync(w1.path, "utf-8");
      assert(/^status: provisional$/m.test(r1Written), `r1 omitted status should default to provisional, got:\n${r1Written}`);
      assert(/^confidence: 4$/m.test(r1Written), `r1 confidence preserved at 4`);
      assert(/^created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/m.test(r1Written), `r1 created must be ISO datetime, got:\n${r1Written}`);
      assert(/^updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/m.test(r1Written), `r1 updated must be ISO datetime, got:\n${r1Written}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| captured \| smoke A2 e2e$/m.test(r1Written), `r1 timeline must use ISO datetime, got:\n${r1Written}`);

      // Response[1]: SKIP. Caller should treat as no candidates.
      const r2 = await runLlmExtractor("--- ENTRY 2 t2 message/assistant ---\nNothing notable.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r2.ok && r2.rawText === "SKIP", `r2 SKIP path: ${JSON.stringify(r2)}`);

      // Response[2]: maxim+confidence=9. Schema-only validation allows it.
      const r3 = await runLlmExtractor("--- ENTRY 3 t3 message/assistant ---\nWe should ALWAYS do X.", {
        settings: a2Settings,
        modelRegistry: mockModelRegistry,
      });
      assert(r3.ok && r3.rawText.includes("Trusted Maxim Attempt"), "r3 should return maxim attempt");
      const drafts3 = parseBlocks(r3.rawText);
      const preview3 = previewExtraction(drafts3);
      assert(preview3.drafts[0].validationErrors.length === 0, `r3 must pass schema-only validation: ${JSON.stringify(preview3)}`);
      const w3 = await writeProjectEntry({
        ...drafts3[0],
        sessionId: "smoke-a2",
        timelineNote: "trusted maxim smoke",
      }, { projectRoot: aRoot, settings: a2Settings, dryRun: false });
      assert(w3.status === "created", `r3 default llm mode must create: ${JSON.stringify(w3)}`);
      const r3Written = fs.readFileSync(w3.path, "utf-8");
      assert(/^kind: maxim$/m.test(r3Written) && /^status: active$/m.test(r3Written) && /^confidence: 9$/m.test(r3Written), `r3 maxim/status/confidence not preserved:\n${r3Written}`);

      // ADR 0016 update substrate: existing memory can evolve instead of
      // append-only duplicate creation. Update compiled truth, status,
      // confidence, and append an ISO timestamped timeline row.
      const update = await updateProjectEntry(w1.slug, {
        status: "active",
        confidence: 8,
        compiledTruth: "# A2 Mock Extracted Insight\n\nThe curator updated this existing memory instead of creating a parallel duplicate.",
        sessionId: "smoke-a2",
        timelineNote: "curator update smoke",
      }, { projectRoot: aRoot, settings: a2Settings, dryRun: false });
      assert(update.status === "updated", `updateProjectEntry should update existing entry: ${JSON.stringify(update)}`);
      const updatedWritten = fs.readFileSync(update.path, "utf-8");
      assert(/^status: active$/m.test(updatedWritten), `update should preserve patched status active:\n${updatedWritten}`);
      assert(/^confidence: 8$/m.test(updatedWritten), `update should preserve patched confidence 8:\n${updatedWritten}`);
      assert(updatedWritten.includes("curator updated this existing memory") || updatedWritten.includes("The curator updated this existing memory"), `update compiled truth missing:\n${updatedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| updated \| curator update smoke$/m.test(updatedWritten), `update timeline must append ISO updated row:\n${updatedWritten}`);

      const merged = await mergeProjectEntries(w1.slug, [w1.slug, w3.slug], {
        compiledTruth: "# A2 Mock Extracted Insight\n\nThe curator merged two related memories into one best current compiled truth.",
        reason: "merge substrate smoke",
        sessionId: "smoke-a2",
      }, { projectRoot: aRoot, settings: a2Settings, dryRun: false });
      assert(merged.length === 2 && merged[0].status === "merged" && merged[1].status === "archived", `mergeProjectEntries should update target and archive non-target source: ${JSON.stringify(merged)}`);
      const mergedWritten = fs.readFileSync(merged[0].path, "utf-8");
      assert(/^derives_from:\n  - trusted-maxim-attempt$/m.test(mergedWritten), `merge should set derives_from relation:\n${mergedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| merged \| merge substrate smoke$/m.test(mergedWritten), `merge timeline missing:\n${mergedWritten}`);

      const archived = await archiveProjectEntry(w1.slug, { projectRoot: aRoot, settings: a2Settings, dryRun: false, reason: "archive substrate smoke", sessionId: "smoke-a2" });
      assert(archived.status === "archived", `archiveProjectEntry should archive existing entry: ${JSON.stringify(archived)}`);
      const archivedWritten = fs.readFileSync(archived.path, "utf-8");
      assert(/^status: archived$/m.test(archivedWritten), `archive should mark status archived:\n${archivedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| archived \| archive substrate smoke$/m.test(archivedWritten), `archive timeline missing:\n${archivedWritten}`);

      const superseded = await supersedeProjectEntry(w1.slug, { projectRoot: aRoot, settings: a2Settings, dryRun: false, newSlug: w3.slug, reason: "supersede substrate smoke", sessionId: "smoke-a2" });
      assert(superseded.status === "superseded", `supersedeProjectEntry should supersede existing entry: ${JSON.stringify(superseded)}`);
      const supersededWritten = fs.readFileSync(superseded.path, "utf-8");
      assert(/^status: superseded$/m.test(supersededWritten), `supersede should mark status superseded:\n${supersededWritten}`);
      assert(/^superseded_by:\n  - trusted-maxim-attempt$/m.test(supersededWritten), `supersede should set superseded_by relation:\n${supersededWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| superseded \| superseded by trusted-maxim-attempt: supersede substrate smoke$/m.test(supersededWritten), `supersede timeline missing:\n${supersededWritten}`);

      const softDeleted = await deleteProjectEntry(w3.slug, { projectRoot: aRoot, settings: a2Settings, dryRun: false, reason: "delete substrate smoke", sessionId: "smoke-a2" });
      assert(softDeleted.status === "deleted" && softDeleted.deleteMode === "soft" && fs.existsSync(softDeleted.path), `soft delete should archive existing entry without unlinking it: ${JSON.stringify(softDeleted)}`);
      const softDeletedWritten = fs.readFileSync(softDeleted.path, "utf-8");
      assert(/^status: archived$/m.test(softDeletedWritten), `soft delete should mark status archived:\n${softDeletedWritten}`);
      assert(/^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2} \| smoke-a2 \| deleted \| soft delete: delete substrate smoke$/m.test(softDeletedWritten), `soft delete timeline missing:\n${softDeletedWritten}`);

      const hardDeleted = await deleteProjectEntry(w3.slug, { projectRoot: aRoot, settings: a2Settings, dryRun: false, mode: "hard", reason: "hard delete substrate smoke" });
      assert(hardDeleted.status === "deleted" && hardDeleted.deleteMode === "hard" && !fs.existsSync(hardDeleted.path), `hard delete should unlink existing entry: ${JSON.stringify(hardDeleted)}`);

      _resetAutoWriteStateForTests();
    }

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
