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
      // ts.transpileModule() is the *fast* path: it strips TypeScript
      // syntax but does NOT run the full parser's diagnostics. In
      // particular, malformed JavaScript template literals (e.g. an
      // unescaped inner backtick inside a `${...}` string) will be
      // emitted as-is and only blow up when pi tries to actually load
      // the extension via its production parser (swc/babel/v8). That's
      // exactly how the 2026-05-12 regression in extensions/memory/
      // index.ts:170 (`Run \`/memory migrate --go\` ...`) slipped past
      // 5 rounds of multi-model audits + every smoke run before it.
      //
      // Workaround: after transpiling, parse the emitted JS through
      // Node's vm.Script with the strict parser to catch syntax errors
      // that transpileModule lets through. This costs ~5ms per file but
      // makes smoke a true gatekeeper for `pi load extension`.
      const transpiled = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      });
      try {
        // vm.Script(...) only parses, doesn't execute. Throws SyntaxError
        // on malformed JS, which is the failure mode we want to surface.
        // eslint-disable-next-line no-new
        new (require("node:vm").Script)(transpiled.outputText, { filename: srcPath });
      } catch (err) {
        throw new Error(
          `Strict parse of ${path.relative(repoRoot, srcPath)} failed — ` +
            `pi will refuse to load this extension at runtime even though ` +
            `ts.transpileModule accepted it. Root cause is almost always ` +
            `unescaped backtick inside a template literal, or an unbalanced ` +
            `\${...} interpolation.\n` +
            `Original error: ${err && err.stack ? err.stack : err}`,
        );
      }
      writeFile(outPath, transpiled.outputText);
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
    const { runMigrationGo, formatMigrationGoSummary } = req("./memory/migrate-go.js");
    const { bindAbrainProject } = req("./_shared/runtime.js");
    const { runDoctorLite } = req("./memory/doctor.js");
    const { DEFAULT_SETTINGS } = req("./memory/settings.js");
    const { archiveProjectEntry, deleteProjectEntry, mergeProjectEntries, supersedeProjectEntry, writeProjectEntry, updateProjectEntry, writeAbrainWorkflow } = req("./sediment/writer.js");
    const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");
    const { buildRunWindow, saveCheckpoint, loadCheckpoint, loadSessionCheckpoint, saveSessionCheckpoint } = req("./sediment/checkpoint.js");
    const { detectProjectDuplicate } = req("./sediment/dedupe.js");
    const { parseExplicitMemoryBlocks } = req("./sediment/extractor.js");
    const { summarizeLlmExtractorResult } = req("./sediment/llm-extractor.js");
    const { sanitizeForMemory } = req("./sediment/sanitizer.js");
    const compactionTunerExt = req("./compaction-tuner/index.js").default;
    const { classifyDecision, DEFAULT_COMPACTION_TUNER_SETTINGS } = req("./compaction-tuner/index.js");
    const { resolveCompactionTunerSettings } = req("./compaction-tuner/settings.js");

    function gitCommitIfChanged(repo, paths, message) {
      const status = execFileSync("git", ["-C", repo, "status", "--porcelain", "--", ...paths], { encoding: "utf-8" });
      if (!status.trim()) return;
      execFileSync("git", ["-C", repo, "add", ...paths]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", message]);
    }

    async function bindMigrationProject(projectRoot, abrainHome, projectId) {
      await bindAbrainProject({
        abrainHome,
        cwd: projectRoot,
        projectId,
        now: "2026-05-12T10:00:00.000+08:00",
      });
      gitCommitIfChanged(projectRoot, [".abrain-project.json"], `bind ${projectId}`);
      const gitignorePath = path.join(abrainHome, ".gitignore");
      const existingGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
      if (!/(^|\n)\.state\/(\n|$)/.test(existingGitignore)) {
        fs.writeFileSync(gitignorePath, `${existingGitignore}${existingGitignore && !existingGitignore.endsWith("\n") ? "\n" : ""}.state/\n`);
      }
      gitCommitIfChanged(abrainHome, [".gitignore", path.join("projects", projectId, "_project.json")], `bind ${projectId}`);
    }

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
    // ADR 0015 D3 (2026-05-11 modification): Stage 2 reasoning lowered from
    // "high" to "off" — rerank is reading comprehension + relevance judgment,
    // not a reasoning task. settings.ts default was updated in commit 4b4432f
    // but this smoke assertion was missed; now restored.
    assert(piAiStub.__configs[0]?.reasoning === "off" && piAiStub.__configs[1]?.reasoning === "off", `memory_search thinking config mismatch (expected both stages off per ADR 0015 D3): ${JSON.stringify(piAiStub.__configs)}`);

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
    // === Memory migrate dry-run (read-only planner) ========================
    // Round 7 P0-C (opus audit fix): dry-run now reflects --go's actual
    // routing in target_path, including pipelines (previously lied about
    // as "unsupported"). Without --project=<id>, target_path renders an
    // explicit `<unresolved>` sentinel; with --project=<id> it resolves
    // to the abrain projects/workflows substrate path.
    const migrationNoProj = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(migrationNoProj.migrateCount >= 1, "migration dry-run found no pending entries");
    const legacyPlanNoProj = migrationNoProj.items.find((item) => item.source_path === ".pensieve/short-term/maxims/legacy.md");
    assert(legacyPlanNoProj, "migration plan should include legacy.md");
    assert(
      /^<unresolved/.test(legacyPlanNoProj.target_path),
      `dry-run without --project should render <unresolved> sentinel, got: ${legacyPlanNoProj.target_path}`,
    );
    assert(legacyPlanNoProj.plan_command === undefined && legacyPlanNoProj.apply_command === undefined, "plan/apply command fields must be retired");

    // With --project=<id>, target_path resolves to the abrain destination.
    const fakeAbrainHome = path.join(root, ".abrain-fake");
    const migration = await planMigrationDryRun(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root, {
      abrainHome: fakeAbrainHome,
      projectId: "smoke-proj",
    });
    assert(migration.migrateCount >= 1, "migration dry-run with --project found no pending entries");
    const legacyPlan = migration.items.find((item) => item.source_path === ".pensieve/short-term/maxims/legacy.md");
    assert(legacyPlan, "migration plan should include legacy.md (with --project)");
    // legacy.md is kind=maxim, status=active → abrain projects/<id>/maxims/<slug>.md
    assert(
      /\.abrain-fake\/projects\/smoke-proj\/maxims\/legacy\.md$/.test(legacyPlan.target_path),
      `legacy plan target should be abrain projects path, got: ${legacyPlan.target_path}`,
    );
    // Round 7 P0-C: pipelines must NOT be in `skipped` with reason "unsupported".
    // (The fixture in this section may not have pipelines; the migrate-go
    // section already tests pipeline routing. We verify here only that
    // the schema flag is gone.)
    const stillUnsupported = migration.skipped.find((s) => /pipeline.*not migrated/i.test(s.reason));
    assert(!stillUnsupported, `pipelines must no longer be flagged 'unsupported' in dry-run, found: ${stillUnsupported?.reason}`);
    const migrationReport = await writeMigrationReport(path.join(root, ".pensieve"), migration, root);
    const migrationReportText = fs.readFileSync(path.join(root, ".pi-astack", "memory", "migration-report.md"), "utf-8");
    assert(fs.existsSync(path.join(root, ".pi-astack", "memory", "migration-report.md")), "migration report not written");
    assert(!migrationReportText.includes("migrate-one") && !migrationReportText.includes("migration-backups"), "migration report must not reference retired per-file substrate");
    assert(migrationReport.migrateCount === migration.migrateCount, "migration report count mismatch");

    const doctor = await runDoctorLite(path.join(root, ".pensieve"), DEFAULT_SETTINGS, undefined, root);
    assert(["pass", "warning", "error"].includes(doctor.status), "doctor-lite invalid status");
    assert(doctor.migrationBackups === undefined, "doctor-lite migrationBackups field must be retired");
    assert(doctor.migration.pendingCount >= 1, "doctor-lite should still surface pending migrations");

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

    const correlatedWrite = await writeProjectEntry({
      title: "Writer Correlation Fixture",
      kind: "fact",
      confidence: 5,
      sessionId: "session-smoke",
      compiledTruth: "This validates that writer-level audit rows carry lane, session, correlation, and candidate identifiers.",
    }, {
      projectRoot: root,
      settings: { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false },
      dryRun: false,
      auditContext: {
        lane: "auto_write",
        sessionId: "session-smoke",
        correlationId: "corr-smoke",
        candidateId: "corr-smoke:c1",
      },
    });
    assert(correlatedWrite.status === "created", `correlated writer failed: ${correlatedWrite.reason}`);
    assert(correlatedWrite.correlationId === "corr-smoke" && correlatedWrite.candidateId === "corr-smoke:c1", "writer result should echo audit correlation ids");
    const auditRows = fs.readFileSync(path.join(root, ".pi-astack", "sediment", "audit.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    const correlatedAudit = auditRows.find((row) => row.operation === "create" && row.target === "project:writer-correlation-fixture");
    assert(correlatedAudit?.lane === "auto_write", "writer audit row should include lane");
    assert(correlatedAudit?.session_id === "session-smoke", "writer audit row should include session_id");
    assert(correlatedAudit?.correlation_id === "corr-smoke", "writer audit row should include correlation_id");
    assert(correlatedAudit?.candidate_id === "corr-smoke:c1", "writer audit row should include candidate_id");

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
    // R9: mergeRoot needs .git/ so the R9 gitignore-ensure assertion below
    // can verify .gitignore auto-append on git repos. ensureProjectGitignoredOnce
    // checks `<root>/.git` existence (no need for full repo).
    fs.mkdirSync(path.join(mergeRoot, ".git"), { recursive: true });
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

    // Round 9 P0 (sonnet R9-5 fix): appendAudit must auto-append
    // `.pi-astack/` to project .gitignore on first touch (only when
    // projectRoot is a git repo). mergeRoot is git init'd above for
    // this test fixture, so a .gitignore must now exist with the entry.
    const mergeGitignore = path.join(mergeRoot, ".gitignore");
    assert(
      fs.existsSync(mergeGitignore),
      `R9 P0: appendAudit on git repo must auto-create .gitignore with .pi-astack/ entry`,
    );
    const giContent = fs.readFileSync(mergeGitignore, "utf-8");
    assert(
      /\n?\.pi-astack\/?\n/.test(giContent) || /^\.pi-astack\/?$/m.test(giContent),
      `R9 P0: .gitignore must contain .pi-astack/ entry, got:\n${giContent}`,
    );

    // R9 P0 negative: non-git repo must NOT have .gitignore created.
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-nongit-audit-"));
    fs.mkdirSync(path.join(nonGitRoot, ".pensieve", ".state"), { recursive: true });
    await req("./sediment/writer.js").appendAudit(nonGitRoot, { operation: "probe" });
    assert(
      !fs.existsSync(path.join(nonGitRoot, ".gitignore")),
      `R9 P0: appendAudit on non-git project must NOT create .gitignore`,
    );
    fs.rmSync(nonGitRoot, { recursive: true, force: true });

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

      // Round 8 P1 (opus R8 audit): credential pattern coverage gaps.
      // Each of these used to bypass the gate — now must hard-reject.
      const bearer = sanitizeForMemory("curl -H 'Authorization: Bearer ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxxx'");
      assert(!bearer.ok && /bearer_token/.test(bearer.error || ""), `bearer_token must reject: ${JSON.stringify(bearer)}`);
      const slackToken = "xox" + "b-12345678901-1234567890-AbCdEfGhIjKlMnOpQrStUvWx";
      const slack = sanitizeForMemory(`slackbot config: ${slackToken}`);
      assert(!slack.ok && /slack_token/.test(slack.error || ""), `slack_token must reject: ${JSON.stringify(slack)}`);
      const google = sanitizeForMemory("GOOGLE_API_KEY=AIzaSyB1234567890ABCDEFGHIJKLMNOPQRSTUV");
      assert(!google.ok && /(google_api_key|generic_secret_assignment)/.test(google.error || ""), `google_api_key must reject: ${JSON.stringify(google)}`);
      const stripeKey = "sk" + "_live_4eC39HqLyjWDarjtT1zdp7dc";
      const stripeLive = sanitizeForMemory(`STRIPE_SECRET_KEY=${stripeKey}`);
      assert(!stripeLive.ok && /(stripe_key|generic_secret_assignment)/.test(stripeLive.error || ""), `stripe_key must reject: ${JSON.stringify(stripeLive)}`);
      const httpAuth = sanitizeForMemory("clone: https://admin:hunter2@private.git.example.com/repo.git");
      assert(!httpAuth.ok && /http_basic_auth_url/.test(httpAuth.error || ""), `http_basic_auth_url must reject: ${JSON.stringify(httpAuth)}`);
      const passwd = sanitizeForMemory("server config: passwd: superSecretPassword12345");
      assert(!passwd.ok && /generic_secret_assignment/.test(passwd.error || ""), `passwd keyword must reject: ${JSON.stringify(passwd)}`);

      // Round 8 P1 (opus R8 audit): zero-width / bidi-control bypass
      // forms must NOT defeat keyword scanning. Insert U+200B between
      // "pass" and "word" — the original gate would lexically miss
      // "password" because of the invisible char.
      const zwsp = sanitizeForMemory("config\u200B: pass\u200Bword: superSecretPassword12345");
      assert(!zwsp.ok && /generic_secret_assignment/.test(zwsp.error || ""), `zero-width-space bypass must still reject: ${JSON.stringify(zwsp)}`);
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
        // commit 9700de5 (2026-05-12 refactor: compact footer status display)
        // simplified prefixes from "💤 sediment idle" → "💤 sediment" etc.,
        // letting emoji convey the state instead of an English word. State is
        // now distinguished by emoji + detail field, not by literal state name.
        // Smoke assertions updated to match the new contract.
        assert(idle.includes("💤") && idle.includes("sediment"), `idle render missing emoji+sediment: ${idle}`);
        assert(running.includes("📝") && running.includes("auto-write"), `running render: ${running}`);
        assert(completed.includes("✅") && completed.includes("3 entries"), `completed render: ${completed}`);
        assert(failed.includes("⚠️") && failed.includes("LLM error"), `failed render: ${failed}`);
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
      // Round 9 P0 (sonnet R9-1 fix): sanitizer must run as an INPUT
      // gate. windowText containing a credential MUST NOT reach the LLM
      // provider; runLlmExtractor must short-circuit before streamSimple.
      // Failure mode: bug case would call mockLLM and r.ok=true; here
      // the mock is observable via globalThis.__A2_LAST_PROMPT__ —
      // assert that AFTER the pre-sanitize call, the mock prompt cache
      // does NOT change.
      const promptBefore = globalThis.__A2_LAST_PROMPT__;
      const rSecret = await runLlmExtractor(
        "--- ENTRY X t1 message/user ---\nMy github token is ghp_1234567890abcdefghijklmnopqrstuv. Help me debug.",
        { settings: a2Settings, modelRegistry: mockModelRegistry },
      );
      assert(
        rSecret.ok === false && rSecret.preSanitizeAborted === true,
        `R9 P0: window with credential must abort BEFORE LLM call, got: ${JSON.stringify(rSecret)}`,
      );
      assert(
        /github_token/.test(rSecret.preSanitizeReason || "") || /credential/.test(rSecret.preSanitizeReason || ""),
        `R9 P0: preSanitizeReason should identify credential pattern, got: ${rSecret.preSanitizeReason}`,
      );
      assert(
        globalThis.__A2_LAST_PROMPT__ === promptBefore,
        `R9 P0: mock LLM was called despite credential in window — sanitize gate is leaking the conversation`,
      );
      // R9 P0 sonnet R9-3: summarize must mark quality.reason="credential_in_window"
      const sumSecret = summarizeLlmExtractorResult(rSecret, { maxCandidates: 3, rawPreviewChars: 100 });
      assert(
        sumSecret.quality.reason === "credential_in_window" && sumSecret.quality.passed === false,
        `R9 P0: summary should classify pre-sanitize abort, got: ${JSON.stringify(sumSecret.quality)}`,
      );

      // Round 9 P0 (sonnet R9-3 fix): rawTextPreview on an LLM response
      // that echoes back a credential must redact (replace whole preview
      // with placeholder), not store the secret in audit.jsonl.
      const sumEcho = summarizeLlmExtractorResult(
        { ok: true, model: "x/y", rawText: "I see your key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", extraction: { count: 0, drafts: [] } },
        { maxCandidates: 3, rawPreviewChars: 200 },
      );
      assert(
        sumEcho.quality.rawTextPreview && /^\[redacted:/.test(sumEcho.quality.rawTextPreview),
        `R9 P0: rawTextPreview echoing a credential must be replaced with [redacted: ...], got: ${sumEcho.quality.rawTextPreview}`,
      );
      // Benign preview is preserved (no false positive)
      const sumBenign = summarizeLlmExtractorResult(
        { ok: true, model: "x/y", rawText: "MEMORY:\ntitle: ok\n---\nnothing secret here at all\nEND_MEMORY", extraction: { count: 0, drafts: [] } },
        { maxCandidates: 3, rawPreviewChars: 100 },
      );
      assert(
        sumBenign.quality.rawTextPreview && !/^\[redacted:/.test(sumBenign.quality.rawTextPreview),
        `R9 P0: benign preview must NOT be redacted (false positive), got: ${sumBenign.quality.rawTextPreview}`,
      );
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

    // === abrain workflows lane writer (B1) ==================================
    // Strategy: use a fresh fake abrain home (already git-inited here), exercise
    // writeAbrainWorkflow for: cross-project route, project-specific route,
    // validation failures, sanitize fail-closed, dedupe collision, audit row,
    // git commit observation. Stays offline (no real network / LLM).
    {
      const wfHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-"));
      // abrain repo must be a git repo for gitCommitAbrain.
      execFileSync("git", ["-C", wfHome, "init", "-q"]);
      execFileSync("git", ["-C", wfHome, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", wfHome, "config", "user.name", "pi-astack smoke"]);
      const wfSettings = DEFAULT_SEDIMENT_SETTINGS;

      // 1) cross-project workflow → ~/.abrain/workflows/<slug>.md
      const wfX = await writeAbrainWorkflow(
        {
          title: "Run when reviewing code",
          trigger: "用户说 review / 代码审查 / 检查代码",
          body: "## Task Blueprint\n\n### Task 1: Identify hotspots\n- Read recent commits\n- Spot signal/noise\n\n### Task 2: Produce review notes\n- Reference taste-review knowledge",
          crossProject: true,
          tags: ["workflow", "review"],
          sessionId: "smoke-wf-1",
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(wfX.status === "created", `cross-project workflow should create, got ${JSON.stringify(wfX)}`);
      assert(wfX.crossProject === true, `wfX.crossProject must be true`);
      assert(wfX.lane === "workflow", `wfX.lane must be 'workflow', got ${wfX.lane}`);
      assert(wfX.path === path.join(wfHome, "workflows", "run-when-reviewing-code.md"), `unexpected cross-project path: ${wfX.path}`);
      assert(fs.existsSync(wfX.path), `cross-project workflow file missing: ${wfX.path}`);
      const wfXText = fs.readFileSync(wfX.path, "utf-8");
      assert(/^id: workflow:run-when-reviewing-code$/m.test(wfXText), `cross-project id missing:\n${wfXText}`);
      assert(/^cross_project: true$/m.test(wfXText), `cross_project: true missing`);
      assert(/^scope: workflow$/m.test(wfXText), `scope: workflow missing`);
      assert(/^kind: workflow$/m.test(wfXText), `kind: workflow missing`);
      assert(/## Timeline\s*\n- .* smoke-wf-1/m.test(wfXText), `Timeline session id missing`);

      // 2) project-specific workflow → ~/.abrain/projects/<id>/workflows/<slug>.md
      // Note: writer does not auto-create projects/<id>/, mkdir -p inside atomicWrite handles it.
      const wfP = await writeAbrainWorkflow(
        {
          title: "Update Claude plugins",
          trigger: "用户要求更新插件 / upgrade plugins",
          body: "Run `claude plugins marketplace update`; verify success message.",
          projectId: "home-dot-claude",
          tags: ["workflow", "claude", "plugins"],
          sessionId: "smoke-wf-2",
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(wfP.status === "created", `project workflow should create, got ${JSON.stringify(wfP)}`);
      assert(wfP.crossProject === false, `wfP.crossProject must be false, got ${wfP.crossProject}`);
      assert(wfP.projectId === "home-dot-claude", `wfP.projectId mismatch`);
      assert(wfP.path === path.join(wfHome, "projects", "home-dot-claude", "workflows", "update-claude-plugins.md"), `unexpected project path: ${wfP.path}`);
      const wfPText = fs.readFileSync(wfP.path, "utf-8");
      assert(/^id: project:home-dot-claude:workflow:update-claude-plugins$/m.test(wfPText), `project-scoped id missing:\n${wfPText}`);
      assert(/^cross_project: false$/m.test(wfPText), `cross_project: false missing`);
      assert(/^project_id: home-dot-claude$/m.test(wfPText), `project_id field missing`);

      // 3) validation: missing trigger
      const v1 = await writeAbrainWorkflow(
        { title: "x", trigger: "", body: "x".repeat(50), crossProject: true },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v1.status === "rejected" && v1.reason === "validation_error", `empty trigger must reject: ${JSON.stringify(v1)}`);
      assert(v1.validationErrors.some((e) => e.field === "trigger"), `validationErrors must include trigger`);

      // 4) validation: missing projectId when crossProject=false (default)
      const v2 = await writeAbrainWorkflow(
        { title: "y", trigger: "t", body: "y".repeat(50) },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v2.status === "rejected" && v2.reason === "validation_error", `missing projectId must reject`);
      assert(v2.validationErrors.some((e) => e.field === "projectId"), `validationErrors must include projectId`);

      // 5) validation: body too short
      const v3 = await writeAbrainWorkflow(
        { title: "z", trigger: "t", body: "short", crossProject: true },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(v3.status === "rejected" && v3.validationErrors.some((e) => e.field === "body"), `short body must reject`);

      // 6) sanitize fail-closed: AWS access key in body → reject
      const sec = await writeAbrainWorkflow(
        {
          title: "leaks aws key",
          trigger: "never",
          body: "Run with AKIAIOSFODNN7EXAMPLE which is a fake-looking AWS key pattern.",
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(sec.status === "rejected", `sanitize should reject AWS-pattern body: ${JSON.stringify(sec)}`);
      assert(sec.reason && sec.reason !== "validation_error", `sanitize rejection should not be validation_error: ${sec.reason}`);

      // 7) dedupe: writing same slug twice → second rejected with duplicate_slug
      const dup = await writeAbrainWorkflow(
        {
          title: "Run when reviewing code",
          trigger: "same as wf1",
          body: "A different body that's long enough to pass validation.",
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings },
      );
      assert(dup.status === "rejected" && dup.reason === "duplicate_slug", `duplicate slug must reject: ${JSON.stringify(dup)}`);

      // 8) dry-run: does not write
      const dr = await writeAbrainWorkflow(
        {
          title: "Sync upstream",
          trigger: "upstream sync request",
          body: "Pull, rebase, push. Verify CI green before promoting.",
          crossProject: true,
        },
        { abrainHome: wfHome, settings: wfSettings, dryRun: true },
      );
      assert(dr.status === "dry_run", `dry-run status mismatch: ${JSON.stringify(dr)}`);
      assert(!fs.existsSync(dr.path), `dry-run should not write file: ${dr.path}`);

      // 9) audit rows: ~/.abrain/.state/sediment/audit.jsonl exists and contains expected ops
      const auditPath = path.join(wfHome, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(auditPath), `audit jsonl missing: ${auditPath}`);
      const auditRows = fs.readFileSync(auditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      const ops = auditRows.map((r) => r.operation);
      assert(ops.includes("create"), `audit must include create op, got ${ops.join(",")}`);
      assert(ops.includes("reject"), `audit must include reject op (validation/sanitize/dedupe)`);
      assert(ops.includes("dry_run"), `audit must include dry_run op`);
      assert(auditRows.every((r) => r.lane === "workflow"), `every audit row must have lane=workflow, got: ${[...new Set(auditRows.map((r) => r.lane))].join(",")}`);
      const createRow = auditRows.find((r) => r.operation === "create" && r.cross_project === true);
      assert(createRow, `expected at least one create row with cross_project=true`);
      assert(createRow.git_commit && /^[0-9a-f]{40}$/.test(createRow.git_commit), `create row should carry git_commit sha, got ${createRow.git_commit}`);

      // 10) git history: at least 2 workflow: commits in abrain repo
      const gitLog = execFileSync("git", ["-C", wfHome, "log", "--pretty=%s"], { encoding: "utf-8" });
      const workflowCommits = gitLog.split("\n").filter((s) => s.startsWith("workflow: ")).length;
      assert(workflowCommits >= 2, `expected ≥2 workflow commits in abrain git log, got ${workflowCommits}:\n${gitLog}`);
    }

    // === per-repo migration --go (B4) ====================================
    // End-to-end: build a fake parent repo with .pensieve mix (modern entry,
    // legacy short-term entry without schema_version, project-specific
    // pipeline, cross-project pipeline, derived index file to skip), build
    // a fake abrain repo, run runMigrationGo, assert routing + normalization
    // + commits + preflight rejection on dirty parent. Stays offline.
    {
      const goParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-go-parent-"));
      execFileSync("git", ["-C", goParent, "init", "-q"]);
      execFileSync("git", ["-C", goParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", goParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", goParent, "config", "commit.gpgsign", "false"]);

      // modern v1 maxim
      writeFile(
        path.join(goParent, ".pensieve", "maxims", "test-rule.md"),
        makeEntry({ title: "Test Rule", kind: "maxim" }),
      );
      // legacy short-term entry: no schema_version, no kind, weird path
      writeFile(
        path.join(goParent, ".pensieve", "short-term", "maxims", "legacy.md"),
        `---
type: maxim
title: Legacy Rule
status: active
created: 2026-05-08
---
# Legacy Rule

Body.
`,
      );
      // pipeline: project-specific (no cross_project flag)
      writeFile(
        path.join(goParent, ".pensieve", "pipelines", "run-when-coding.md"),
        `---
title: Run when coding
trigger: 用户要求写代码
status: active
created: 2026-05-08
---
# Run when coding

**Trigger**: 用户要求写代码

## Task Blueprint

1. Read the request carefully.
2. Plan, then implement.
`,
      );
      // pipeline: cross-project (cross_project: true)
      writeFile(
        path.join(goParent, ".pensieve", "pipelines", "run-when-reviewing.md"),
        `---
title: Run when reviewing
trigger: review request
cross_project: true
status: active
created: 2026-05-08
---
# Run when reviewing

This is a cross-project review pipeline body with enough content.
`,
      );
      // derived index/state files: markdownFilesForTarget already filters
      // them via IGNORE_DIRS + rg --glob exclusions, so they don't show up
      // as either migrated or skipped. We seed both anyway to lock in that
      // they never appear in the migration entry list.
      writeFile(path.join(goParent, ".pensieve", ".index", "graph.json"), "{}");
      writeFile(path.join(goParent, ".pensieve", ".state", "checkpoint.md"), "derived state file (not user content)");

      execFileSync("git", ["-C", goParent, "add", "-A"]);
      execFileSync("git", ["-C", goParent, "commit", "-q", "-m", "init pensieve"]);

      const goAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-go-abrain-"));
      execFileSync("git", ["-C", goAbrain, "init", "-q"]);
      execFileSync("git", ["-C", goAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", goAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", goAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(goAbrain, "README.md"), "# abrain home (smoke)\n");
      execFileSync("git", ["-C", goAbrain, "add", "-A"]);
      execFileSync("git", ["-C", goAbrain, "commit", "-q", "-m", "init abrain"]);
      await bindMigrationProject(goParent, goAbrain, "test-project");

      const goOpts = {
        pensieveTarget: path.join(goParent, ".pensieve"),
        abrainHome: goAbrain,
        projectId: "test-project",
        cwd: goParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      };

      // 1) Preflight rejects dirty parent
      fs.writeFileSync(path.join(goParent, "dirty-file.txt"), "oops");
      const dirty = await runMigrationGo(goOpts);
      assert(dirty.ok === false, `dirty parent must fail preflight, got ok=${dirty.ok}`);
      assert(
        dirty.preconditionFailures.some((f) => /not clean/.test(f)),
        `dirty parent failure must mention 'not clean': ${dirty.preconditionFailures.join("; ")}`,
      );
      assert(dirty.movedCount === 0 && dirty.workflowCount === 0, `dirty preflight must not migrate anything`);
      fs.unlinkSync(path.join(goParent, "dirty-file.txt"));

      // 2) Preflight rejects when abrain dirty
      fs.writeFileSync(path.join(goAbrain, "dirty-file.txt"), "oops");
      const abrainDirty = await runMigrationGo(goOpts);
      assert(abrainDirty.ok === false, `dirty abrain must fail preflight`);
      assert(
        abrainDirty.preconditionFailures.some((f) => /abrain.*not clean/i.test(f)),
        `dirty abrain failure should mention abrain: ${abrainDirty.preconditionFailures.join("; ")}`,
      );
      fs.unlinkSync(path.join(goAbrain, "dirty-file.txt"));

      // 3) Happy path migration
      const result = await runMigrationGo(goOpts);
      assert(result.ok, `migration should succeed, got failures: ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.projectId === "test-project", `projectId mismatch: ${result.projectId}`);
      assert(result.projectIdSource === "strict-binding", `projectIdSource should be strict-binding, got ${result.projectIdSource}`);
      assert(result.movedCount === 2, `expected 2 knowledge entries moved, got ${result.movedCount} (entries=${JSON.stringify(result.entries)})`);
      assert(result.workflowCount === 2, `expected 2 workflows routed, got ${result.workflowCount}`);
      assert(result.failedCount === 0, `expected 0 failures, got ${result.failedCount}`);
      // Derived index/state files are pre-filtered by markdownFilesForTarget
      // (parser.ts IGNORE_DIRS + listFilesWithRg --glob), so they're invisible
      // to migrate-go and never show up as migrated OR skipped.
      assert(result.skippedCount === 0, `derived files must be pre-filtered, got ${result.skippedCount} skips`);
      assert(
        !result.entries.some((e) => /\.state|\.index/.test(e.source)),
        `no entry should reference .state/.index source: ${JSON.stringify(result.entries)}`,
      );
      // Both derived files remain in .pensieve/ (untouched by migration).
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", ".index", "graph.json")),
        `.index/graph.json should remain in .pensieve (not touched by migration)`,
      );
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", ".state", "checkpoint.md")),
        `.state/checkpoint.md should remain in .pensieve (not touched by migration)`,
      );

      // 4) Knowledge entries moved to abrain projects dir
      const modernTarget = path.join(goAbrain, "projects", "test-project", "maxims", "test-rule.md");
      const legacyTarget = path.join(goAbrain, "projects", "test-project", "maxims", "legacy.md");
      assert(fs.existsSync(modernTarget), `modern entry should land at ${modernTarget}`);
      assert(fs.existsSync(legacyTarget), `legacy entry should land at ${legacyTarget}`);
      assert(!fs.existsSync(path.join(goParent, ".pensieve", "maxims", "test-rule.md")), `source should be removed from .pensieve`);
      assert(!fs.existsSync(path.join(goParent, ".pensieve", "short-term", "maxims", "legacy.md")), `legacy source should be removed`);

      // 5) Legacy entry normalized: gained schema_version, scope, kind,
      // confidence, schema_version line; gained migrated-from-legacy timeline.
      const legacyText = fs.readFileSync(legacyTarget, "utf-8");
      assert(/^schema_version: 1$/m.test(legacyText), `legacy missing schema_version:1\n${legacyText}`);
      assert(/^scope: project$/m.test(legacyText), `legacy missing scope: project`);
      assert(/^kind: maxim$/m.test(legacyText), `legacy kind should be maxim (mapped from type)`);
      assert(/^id: project:test-project:legacy$/m.test(legacyText), `legacy id mismatch`);
      assert(/migrated-from-legacy/.test(legacyText), `legacy missing migration timeline note`);
      assert(/^## Timeline$/m.test(legacyText), `legacy missing ## Timeline heading`);

      // 6) Modern entry preserved (re-normalized) and still has a migration
      // timeline entry, but original frontmatter values survived.
      const modernText = fs.readFileSync(modernTarget, "utf-8");
      assert(/^id: project:test-project:test-rule$/m.test(modernText), `modern id mismatch:\n${modernText}`);
      assert(/^kind: maxim$/m.test(modernText), `modern kind preserved`);
      assert(/migrated-from-legacy/.test(modernText), `modern entry should also gain migration timeline marker`);
      // Round 7 P0-B (sonnet audit fix): legacy timeline rows must appear
      // BEFORE the migration meta-row (chronological order). The modern
      // fixture (makeEntry) has a single legacy row `- 2026-05-08 | smoke
      // | captured | ok` followed by the migration row; verify ordering.
      {
        const tlSection = modernText.split(/^## Timeline\s*$/m)[1] || "";
        const lines = tlSection.split("\n").filter((l) => l.startsWith("- "));
        assert(lines.length >= 2, `modern entry should have at least 2 timeline rows after migration, got: ${JSON.stringify(lines)}`);
        // First non-empty timeline row must be the legacy smoke row (oldest).
        assert(
          /smoke \| captured \| ok/.test(lines[0]),
          `legacy timeline row should come FIRST (oldest), got: ${lines[0]}`,
        );
        // Last timeline row must be the migration meta-row (newest).
        assert(
          /migrated-from-legacy/.test(lines[lines.length - 1]),
          `migration meta-row should come LAST (newest), got: ${lines[lines.length - 1]}`,
        );
      }

      // 7) Pipeline routing: project-specific → ~/.abrain/projects/<id>/workflows/
      const wfProj = path.join(goAbrain, "projects", "test-project", "workflows", "run-when-coding.md");
      assert(fs.existsSync(wfProj), `project workflow should land at ${wfProj}`);
      const wfProjText = fs.readFileSync(wfProj, "utf-8");
      assert(/^kind: workflow$/m.test(wfProjText), `workflow kind missing`);
      assert(/^cross_project: false$/m.test(wfProjText), `project workflow should have cross_project: false`);

      // 8) Pipeline routing: cross-project → ~/.abrain/workflows/
      const wfCross = path.join(goAbrain, "workflows", "run-when-reviewing.md");
      assert(fs.existsSync(wfCross), `cross-project workflow should land at ${wfCross}`);
      const wfCrossText = fs.readFileSync(wfCross, "utf-8");
      assert(/^cross_project: true$/m.test(wfCrossText), `cross-project workflow should have cross_project: true`);

      // 9) Parent repo commit: "chore: migrate .pensieve → ~/.abrain/projects/..."
      const parentLog = execFileSync("git", ["-C", goParent, "log", "--pretty=%s"], { encoding: "utf-8" });
      assert(/^chore: migrate \.pensieve → ~\/\.abrain\/projects\/test-project/m.test(parentLog), `parent commit message mismatch:\n${parentLog}`);
      assert(result.parentCommitSha && /^[0-9a-f]{40}$/.test(result.parentCommitSha), `parent commit sha invalid: ${result.parentCommitSha}`);

      // Round 8 P1 (sonnet R8 audit fix): a single migrate_go audit row
      // must be written to ~/.abrain/.state/sediment/audit.jsonl with
      // per-entry source→target mapping (first 200 entries), so crash
      // mid-migration leaves forensic trail.
      const migAuditPath = path.join(goAbrain, ".state", "sediment", "audit.jsonl");
      assert(fs.existsSync(migAuditPath), `migrate_go audit log must exist at ${migAuditPath}`);
      const migAuditRows = fs.readFileSync(migAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const migRow = migAuditRows.find((r) => r.operation === "migrate_go" && r.projectId === "test-project");
      assert(migRow, `migrate_go audit row missing; rows=${migAuditRows.map((r) => r.operation).join(",")}`);
      assert(migRow.movedCount === result.movedCount, `audit movedCount mismatch: ${migRow.movedCount} vs result ${result.movedCount}`);
      assert(migRow.workflowCount === result.workflowCount, `audit workflowCount mismatch: ${migRow.workflowCount} vs result ${result.workflowCount}`);
      assert(Array.isArray(migRow.entries) && migRow.entries.length > 0, `audit entries array missing`);
      assert(migRow.entries.every((e) => e.source && e.action), `audit entries must each carry source+action; got=${JSON.stringify(migRow.entries[0])}`);
      assert(migRow.parentPreSha === result.parentPreSha, `audit parentPreSha mismatch`);
      assert(migRow.lane === "system", `audit lane should be 'system' for migration meta event, got: ${migRow.lane}`);

      // 10) Abrain repo commit: workflows commit themselves individually +
      // the migrate(in) commit captures knowledge entries.
      const abrainLog = execFileSync("git", ["-C", goAbrain, "log", "--pretty=%s"], { encoding: "utf-8" });
      assert(/^migrate\(in\): test-project/m.test(abrainLog), `abrain commit message missing:\n${abrainLog}`);
      assert(/^workflow: run-when-coding$/m.test(abrainLog), `project workflow commit missing:\n${abrainLog}`);
      assert(/^workflow: run-when-reviewing$/m.test(abrainLog), `cross-project workflow commit missing:\n${abrainLog}`);

      // 11) Summary string sanity
      const summary = formatMigrationGoSummary(result, goParent);
      assert(/Migration complete/.test(summary), `summary should announce completion`);
      assert(/projectId=test-project/.test(summary), `summary should include projectId`);
      assert(/Rollback/.test(summary), `summary should mention rollback`);

      // 11a) Spec §3 step 6 — index rebuild on abrain projects/<id>/ side
      // must run before the abrain commit, so memory_list / facade see the
      // freshly-migrated entries without manual /memory rebuild.
      assert(result.graphRebuilt && typeof result.graphRebuilt.nodeCount === "number", `result.graphRebuilt must be populated, got ${JSON.stringify(result.graphRebuilt)}`);
      // 3 nodes = 2 knowledge entries + 1 project-specific workflow under
      // projects/<id>/workflows/. Cross-project workflow lives outside the
      // project at ~/.abrain/workflows/ and is not counted here.
      assert(result.graphRebuilt.nodeCount === 3, `expected 3 graph nodes (2 knowledge + 1 project workflow), got ${result.graphRebuilt.nodeCount}`);
      assert(result.markdownIndexRebuilt && typeof result.markdownIndexRebuilt.entryCount === "number", `result.markdownIndexRebuilt must be populated`);
      assert(result.markdownIndexRebuilt.entryCount === 3, `expected 3 markdown index entries, got ${result.markdownIndexRebuilt.entryCount}`);
      assert(fs.existsSync(path.join(goAbrain, "projects", "test-project", ".index", "graph.json")), `abrain graph.json must exist after migration`);
      assert(fs.existsSync(path.join(goAbrain, "projects", "test-project", "_index.md")), `abrain _index.md must exist after migration`);
      assert(/graph index rebuilt/.test(summary), `summary should mention graph rebuild`);
      assert(/markdown index rebuilt/.test(summary), `summary should mention markdown index rebuild`);

      // 11b) Rollback hint uses pre-migration SHAs (not HEAD~1) so it works
      // even with N+1 abrain commits (N workflow + 1 migrate-in).
      assert(result.parentPreSha && /^[0-9a-f]{40}$/.test(result.parentPreSha), `parentPreSha must be a valid SHA: ${result.parentPreSha}`);
      assert(result.abrainPreSha && /^[0-9a-f]{40}$/.test(result.abrainPreSha), `abrainPreSha must be a valid SHA: ${result.abrainPreSha}`);
      assert(summary.includes(result.parentPreSha), `summary rollback must reference parentPreSha ${result.parentPreSha}`);
      assert(summary.includes(result.abrainPreSha), `summary rollback must reference abrainPreSha ${result.abrainPreSha}`);
      assert(!/HEAD~1(?!.*pre-migration SHA not captured)/.test(summary), `summary must not use HEAD~1 in rollback (it's wrong for N+1 abrain commits):\n${summary}`);

      // 11c) The captured pre-SHAs must actually be the pre-migration HEAD,
      // i.e. the commit immediately before the migrate-in commit chain. Reset
      // to those SHAs must restore the original .pensieve layout.
      const abrainHeadAfter = execFileSync("git", ["-C", goAbrain, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
      assert(abrainHeadAfter !== result.abrainPreSha, `abrain HEAD should have advanced past pre-sha`);
      // Simulate rollback and verify .pensieve content comes back on parent side
      execFileSync("git", ["-C", goParent, "reset", "--hard", result.parentPreSha]);
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", "maxims", "test-rule.md")),
        `rollback to parentPreSha must restore .pensieve/maxims/test-rule.md`,
      );
      assert(
        fs.existsSync(path.join(goParent, ".pensieve", "pipelines", "run-when-coding.md")),
        `rollback must restore .pensieve/pipelines/run-when-coding.md`,
      );
      execFileSync("git", ["-C", goAbrain, "reset", "--hard", result.abrainPreSha]);
      assert(
        fs.existsSync(path.join(goAbrain, "projects", "test-project", "_project.json")),
        `rollback to abrainPreSha must preserve the pre-existing B4.5 project registry`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "maxims", "test-rule.md")),
        `rollback to abrainPreSha must remove migrated knowledge entries`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "projects", "test-project", "workflows", "run-when-coding.md")),
        `rollback to abrainPreSha must remove project workflow added by migration`,
      );
      assert(
        !fs.existsSync(path.join(goAbrain, "workflows", "run-when-reviewing.md")),
        `rollback must remove cross-project workflow added by migration`,
      );

      // 12) Idempotency / Forward-only protection.
      //
      // After 11c rollback, both repos are back at pre-migration state, so
      // we re-run migration to get back to migrated state — then verify a
      // *third* run fails preflight cleanly because .pensieve no longer has
      // user entries (only derived .index/.state files remain, which
      // migrate-go ignores). This protects against accidental empty-migration
      // commits.
      const reapply = await runMigrationGo(goOpts);
      assert(reapply.ok, `re-apply after rollback must succeed, got: ${JSON.stringify(reapply.preconditionFailures)}`);
      const second = await runMigrationGo(goOpts);
      assert(second.ok === false, `second run must not succeed`);
      assert(
        second.preconditionFailures.some((f) => /no user entries to migrate/.test(f)),
        `second run should fail with no-user-entries: ${second.preconditionFailures.join("; ")}`,
      );
    }

    // === per-repo migration --go: boundary scenarios (sonnet audit P2) ====
    //
    // Extra scenarios on top of the main happy/preflight/idempotency
    // assertions: (a) slug collision on the abrain side surfaces in
    // failedCount + a clear reason, (b) ADR 0017 strict binding refuses
    // an unbound repo even when a git remote exists, and (c) strict-bound
    // projectId migrates successfully.

    // (a) slug collision: abrain already has a maxim with the same slug.
    {
      const cParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-collide-parent-"));
      execFileSync("git", ["-C", cParent, "init", "-q"]);
      execFileSync("git", ["-C", cParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", cParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", cParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(cParent, ".pensieve", "maxims", "shared-rule.md"), makeEntry({ title: "Shared Rule", kind: "maxim" }));
      execFileSync("git", ["-C", cParent, "add", "-A"]);
      execFileSync("git", ["-C", cParent, "commit", "-q", "-m", "init"]);

      const cAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-collide-abrain-"));
      execFileSync("git", ["-C", cAbrain, "init", "-q"]);
      execFileSync("git", ["-C", cAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", cAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", cAbrain, "config", "commit.gpgsign", "false"]);
      // Seed abrain with a pre-existing entry at the migration target path.
      writeFile(
        path.join(cAbrain, "projects", "collide-test", "maxims", "shared-rule.md"),
        makeEntry({ title: "Shared Rule (existing)", kind: "maxim" }),
      );
      execFileSync("git", ["-C", cAbrain, "add", "-A"]);
      execFileSync("git", ["-C", cAbrain, "commit", "-q", "-m", "init w/ collision"]);
      await bindMigrationProject(cParent, cAbrain, "collide-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(cParent, ".pensieve"),
        abrainHome: cAbrain,
        projectId: "collide-test",
        cwd: cParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `collision-case migration should still complete (one failure inside): ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.failedCount === 1, `expected 1 failure on collision, got ${result.failedCount} (entries=${JSON.stringify(result.entries)})`);
      const failed = result.entries.find((e) => e.action === "failed");
      assert(failed, `must have a failed entry report`);
      assert(/already exists|exists/i.test(failed.reason || ""), `collision reason should mention existing target: ${failed.reason}`);
      assert(result.movedCount === 0, `no entry should move when its sole entry collides`);
      // Pre-existing entry is untouched (no overwrite of existing data).
      const existingText = fs.readFileSync(path.join(cAbrain, "projects", "collide-test", "maxims", "shared-rule.md"), "utf-8");
      assert(/Shared Rule \(existing\)/.test(existingText), `pre-existing entry must not be overwritten by collision case`);
    }

    // (b) ADR 0017: unbound repo refuses even with SSH remote
    {
      const rParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-remote-parent-"));
      execFileSync("git", ["-C", rParent, "init", "-q"]);
      execFileSync("git", ["-C", rParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rParent, "config", "commit.gpgsign", "false"]);
      // SSH-form remote is deliberately present; it must NOT be used for
      // project identity after B4.5.
      execFileSync("git", ["-C", rParent, "remote", "add", "origin", "git@github.com:alfadb/uamp.git"]);
      writeFile(path.join(rParent, ".pensieve", "maxims", "remote-test.md"), makeEntry({ title: "Remote ID Test", kind: "maxim" }));
      execFileSync("git", ["-C", rParent, "add", "-A"]);
      execFileSync("git", ["-C", rParent, "commit", "-q", "-m", "init"]);

      const rAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-remote-abrain-"));
      execFileSync("git", ["-C", rAbrain, "init", "-q"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(rAbrain, "README.md"), "# abrain (remote-id smoke)\n");
      execFileSync("git", ["-C", rAbrain, "add", "-A"]);
      execFileSync("git", ["-C", rAbrain, "commit", "-q", "-m", "init"]);

      // ADR 0017 / B4.5: no projectId means migration MUST refuse even
      // when a git remote exists. Migration is data movement; identity
      // selection belongs to /abrain bind and active-project strict binding.
      const result = await runMigrationGo({
        pensieveTarget: path.join(rParent, ".pensieve"),
        abrainHome: rAbrain,
        cwd: rParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(!result.ok, `unbound repo must fail, got ok=true`);
      assert(
        result.preconditionFailures.some((f) => /project binding status=manifest_missing/.test(f)),
        `missing binding failure must mention manifest_missing, got: ${result.preconditionFailures.join("; ")}`,
      );
      assert(
        !fs.existsSync(path.join(rAbrain, "projects", "alfadb-uamp", "maxims", "remote-test.md")),
        `entry must NOT be migrated via git-remote inference`,
      );
    }

    // (c) strict-bound projectId succeeds; HTTPS remote is ignored
    {
      const rParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-https-parent-"));
      execFileSync("git", ["-C", rParent, "init", "-q"]);
      execFileSync("git", ["-C", rParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rParent, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", rParent, "remote", "add", "origin", "https://github.com/alfadb/kihh.git"]);
      writeFile(path.join(rParent, ".pensieve", "maxims", "https-test.md"), makeEntry({ title: "HTTPS Remote ID Test", kind: "maxim" }));
      execFileSync("git", ["-C", rParent, "add", "-A"]);
      execFileSync("git", ["-C", rParent, "commit", "-q", "-m", "init"]);

      const rAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-https-abrain-"));
      execFileSync("git", ["-C", rAbrain, "init", "-q"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", rAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", rAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(rAbrain, "README.md"), "# abrain (https-remote-id smoke)\n");
      execFileSync("git", ["-C", rAbrain, "add", "-A"]);
      execFileSync("git", ["-C", rAbrain, "commit", "-q", "-m", "init"]);
      await bindMigrationProject(rParent, rAbrain, "alfadb-kihh");

      const result = await runMigrationGo({
        pensieveTarget: path.join(rParent, ".pensieve"),
        abrainHome: rAbrain,
        projectId: "alfadb-kihh",
        cwd: rParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `strict-bound projectId case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.projectIdSource === "strict-binding", `projectIdSource must be strict-binding, got ${result.projectIdSource}`);
      assert(result.projectId === "alfadb-kihh", `projectId from strict binding should be 'alfadb-kihh', got '${result.projectId}'`);
      assert(
        fs.existsSync(path.join(rAbrain, "projects", "alfadb-kihh", "maxims", "https-test.md")),
        `entry must land under projects/alfadb-kihh/`,
      );
    }

    // (d) parent-side commit narrowing (pathspec=".pensieve"): unrelated
    //     `.pi-astack/` working-tree changes (mimics sediment auto-commit
    //     staging that's been gitignored) must NOT be swept into the
    //     migration commit. This is the regression guard for the
    //     gitCommitAll pathspec parameter (was missing in 37f03a6).
    {
      const dParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-narrow-parent-"));
      execFileSync("git", ["-C", dParent, "init", "-q"]);
      execFileSync("git", ["-C", dParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dParent, "config", "commit.gpgsign", "false"]);
      // `.pi-astack/` is normally gitignored in real repos (per pi convention).
      // Match that here so parent preflight stays clean.
      writeFile(path.join(dParent, ".gitignore"), ".pi-astack/\n");
      writeFile(path.join(dParent, ".pensieve", "maxims", "narrow.md"), makeEntry({ title: "Narrow Add Test", kind: "maxim" }));
      execFileSync("git", ["-C", dParent, "add", "-A"]);
      execFileSync("git", ["-C", dParent, "commit", "-q", "-m", "init"]);

      const dAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-narrow-abrain-"));
      execFileSync("git", ["-C", dAbrain, "init", "-q"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", dAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", dAbrain, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(dAbrain, "README.md"), "# abrain (narrow-add smoke)\n");
      execFileSync("git", ["-C", dAbrain, "add", "-A"]);
      execFileSync("git", ["-C", dAbrain, "commit", "-q", "-m", "init"]);
      await bindMigrationProject(dParent, dAbrain, "narrow-test");

      // Write `.pi-astack/` noise AFTER binding and before migration — it's
      // gitignored so preflight `git status --porcelain` returns clean.
      // With the old `git add -A`, this would have been silently ignored
      // by gitignore too; the regression value here is that the migration
      // commit's file list comes from a pathspec-narrowed `git add --
      // .pensieve`, not a wide `add -A` that *could* sweep newly added
      // files. We assert that property directly.
      writeFile(path.join(dParent, ".pi-astack", "sediment", "concurrent-noise.jsonl"), `{"unrelated":true}\n`);

      const result = await runMigrationGo({
        pensieveTarget: path.join(dParent, ".pensieve"),
        abrainHome: dAbrain,
        projectId: "narrow-test",
        cwd: dParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `narrow-add case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      // Parent migration commit must only touch .pensieve/.
      const parentCommitFiles = execFileSync("git", ["-C", dParent, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf-8" }).trim().split(/\n+/).filter(Boolean);
      assert(
        parentCommitFiles.length > 0 && parentCommitFiles.every((f) => f.startsWith(".pensieve")),
        `parent migration commit must only touch .pensieve/, got: ${JSON.stringify(parentCommitFiles)}`,
      );
      // `.pi-astack/` content still exists on disk but is unstaged / untracked.
      assert(
        fs.existsSync(path.join(dParent, ".pi-astack", "sediment", "concurrent-noise.jsonl")),
        `.pi-astack noise file should still exist on disk after migration`,
      );
    }

    // (e) abrain side starts as brand-new `git init`; ADR 0017 binding
    //     bootstrap creates the first abrain HEAD (registry commit) before
    //     migration, so preflight must capture a concrete abrainPreSha.
    {
      const eParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-empty-abrain-parent-"));
      execFileSync("git", ["-C", eParent, "init", "-q"]);
      execFileSync("git", ["-C", eParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", eParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", eParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(eParent, ".pensieve", "maxims", "empty-abrain.md"), makeEntry({ title: "Empty Abrain Test", kind: "maxim" }));
      execFileSync("git", ["-C", eParent, "add", "-A"]);
      execFileSync("git", ["-C", eParent, "commit", "-q", "-m", "init"]);

      const eAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-empty-abrain-abrain-"));
      execFileSync("git", ["-C", eAbrain, "init", "-q"]);
      execFileSync("git", ["-C", eAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", eAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", eAbrain, "config", "commit.gpgsign", "false"]);
      // NO initial commit on abrain side before binding — brand-new repo with no HEAD.
      await bindMigrationProject(eParent, eAbrain, "empty-abrain-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(eParent, ".pensieve"),
        abrainHome: eAbrain,
        projectId: "empty-abrain-test",
        cwd: eParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      // Migration itself should still succeed (the abrain commit creates
      // the first HEAD on that side).
      assert(result.ok, `empty-abrain case should succeed: ${JSON.stringify(result.preconditionFailures)}`);
      // Binding bootstrap created a registry commit before migration, so
      // abrainPreSha is now concrete under B4.5 strict binding.
      assert(typeof result.abrainPreSha === "string" && /^[0-9a-f]{40}$/.test(result.abrainPreSha), `abrainPreSha should be a valid SHA after binding bootstrap, got ${result.abrainPreSha}`);
      assert(typeof result.parentPreSha === "string" && /^[0-9a-f]{40}$/.test(result.parentPreSha), `parentPreSha should still be a valid SHA, got ${result.parentPreSha}`);
      const summary = formatMigrationGoSummary(result, eParent);
      assert(!/pre-migration SHA not captured|HEAD~1.*⚠|⚠.*HEAD~1|abrain.*not captured/i.test(summary), `summary should not warn about missing abrainPreSha after binding, got: ${summary}`);
    }

    // (f) mixed batch: 2 entries where 1 collides on abrain side and 1
    //     succeeds. Verify movedCount=1 / failedCount=1 simultaneously,
    //     parent commit still happens (the survivor was git rm'd), and
    //     the colliding entry stays in .pensieve untouched (sonnet C7 #3).
    {
      const fParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-mixed-parent-"));
      execFileSync("git", ["-C", fParent, "init", "-q"]);
      execFileSync("git", ["-C", fParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", fParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", fParent, "config", "commit.gpgsign", "false"]);
      writeFile(path.join(fParent, ".pensieve", "maxims", "will-collide.md"), makeEntry({ title: "Will Collide", kind: "maxim" }));
      writeFile(path.join(fParent, ".pensieve", "maxims", "will-succeed.md"), makeEntry({ title: "Will Succeed", kind: "maxim" }));
      execFileSync("git", ["-C", fParent, "add", "-A"]);
      execFileSync("git", ["-C", fParent, "commit", "-q", "-m", "init"]);

      const fAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-mixed-abrain-"));
      execFileSync("git", ["-C", fAbrain, "init", "-q"]);
      execFileSync("git", ["-C", fAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", fAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", fAbrain, "config", "commit.gpgsign", "false"]);
      // Plant ONE colliding entry on abrain side (matches will-collide).
      writeFile(
        path.join(fAbrain, "projects", "mixed-test", "maxims", "will-collide.md"),
        makeEntry({ title: "Will Collide (existing)", kind: "maxim" }),
      );
      execFileSync("git", ["-C", fAbrain, "add", "-A"]);
      execFileSync("git", ["-C", fAbrain, "commit", "-q", "-m", "init w/ one collision"]);
      await bindMigrationProject(fParent, fAbrain, "mixed-test");

      const result = await runMigrationGo({
        pensieveTarget: path.join(fParent, ".pensieve"),
        abrainHome: fAbrain,
        projectId: "mixed-test",
        cwd: fParent,
        settings: DEFAULT_SETTINGS,
        migrationTimestamp: "2026-05-12T10:00:00.000+08:00",
      });
      assert(result.ok, `mixed case should still complete: ${JSON.stringify(result.preconditionFailures)}`);
      assert(result.movedCount === 1, `expected movedCount=1, got ${result.movedCount}`);
      assert(result.failedCount === 1, `expected failedCount=1, got ${result.failedCount}`);
      assert(result.parentCommitSha, `parent commit must still happen for the survivor, got ${result.parentCommitSha}`);
      assert(result.abrainCommitSha, `abrain commit must still happen for the survivor, got ${result.abrainCommitSha}`);
      // Survivor: removed from .pensieve, present in abrain.
      assert(
        !fs.existsSync(path.join(fParent, ".pensieve", "maxims", "will-succeed.md")),
        `will-succeed.md should be git-rm'd from .pensieve`,
      );
      assert(
        fs.existsSync(path.join(fAbrain, "projects", "mixed-test", "maxims", "will-succeed.md")),
        `will-succeed.md should land under abrain/projects/mixed-test/maxims/`,
      );
      // Collider: still in .pensieve (NOT removed since write failed),
      // and the pre-existing abrain copy is unchanged.
      assert(
        fs.existsSync(path.join(fParent, ".pensieve", "maxims", "will-collide.md")),
        `will-collide.md should remain in .pensieve when its target collides (no destructive cleanup)`,
      );
      const existingText = fs.readFileSync(path.join(fAbrain, "projects", "mixed-test", "maxims", "will-collide.md"), "utf-8");
      assert(/Will Collide \(existing\)/.test(existingText), `pre-existing colliding entry must not be overwritten: ${existingText.slice(0, 120)}`);
    }

    // (g) Stale-lock reclaim: verify both writer locks recover when the
    //     previous holder crashed without releasing. Round 5 audit
    //     (deepseek-v4-pro) found that acquireLock + acquireAbrainWorkflow-
    //     Lock had no reclaim path — a kill -9 mid-write caused permanent
    //     deadlock until manual `rm sediment.lock`.
    //
    //     Test matrix (each lock):
    //       - stale lock (mtime > SEDIMENT_LOCK_STEAL_AFTER_MS=30s) → reclaimed, write succeeds
    //       - fresh lock (mtime < 30s) → NOT reclaimed, write times out
    {
      const gParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-stale-lock-parent-"));
      execFileSync("git", ["-C", gParent, "init", "-q"]);
      execFileSync("git", ["-C", gParent, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", gParent, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", gParent, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", gParent, "commit", "-q", "--allow-empty", "-m", "init"]);

      const gAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-stale-lock-abrain-"));
      execFileSync("git", ["-C", gAbrain, "init", "-q"]);
      execFileSync("git", ["-C", gAbrain, "config", "user.email", "smoke@pi-astack.local"]);
      execFileSync("git", ["-C", gAbrain, "config", "user.name", "pi-astack smoke"]);
      execFileSync("git", ["-C", gAbrain, "config", "commit.gpgsign", "false"]);
      execFileSync("git", ["-C", gAbrain, "commit", "-q", "--allow-empty", "-m", "init"]);

      const lockSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false, lockTimeoutMs: 1000 };

      // --- Case g.1: stale sediment.lock (project side) gets reclaimed ---
      {
        const sedimentLockPath = path.join(gParent, ".pi-astack", "sediment", "locks", "sediment.lock");
        fs.mkdirSync(path.dirname(sedimentLockPath), { recursive: true });
        fs.writeFileSync(sedimentLockPath, JSON.stringify({ pid: 999999, created_at: "2026-05-12T00:00:00.000+08:00" }));
        // Set mtime to 60s ago (well past the 30s SEDIMENT_LOCK_STEAL_AFTER_MS).
        const past = (Date.now() - 60_000) / 1000;
        fs.utimesSync(sedimentLockPath, past, past);

        const w = await writeProjectEntry(
          { title: "Stale Lock Reclaim Test", kind: "maxim", confidence: 5, compiledTruth: "This validates that a crashed-holder sediment.lock is reclaimed after the steal-after threshold." },
          { projectRoot: gParent, settings: lockSettings, dryRun: false },
        );
        assert(w.status === "created" || w.status === "updated", `stale sediment.lock should be reclaimed, got status=${w.status} reason=${w.reason}`);
      }

      // --- Case g.2: fresh sediment.lock blocks write (timeout) ---
      // Note: writeProjectEntry catches lock-timeout internally and returns
      // status:"rejected" + reason containing the timeout message, rather
      // than throwing. We assert on that shape, not on a thrown exception.
      {
        const gParent2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fresh-lock-parent-"));
        execFileSync("git", ["-C", gParent2, "init", "-q"]);
        execFileSync("git", ["-C", gParent2, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gParent2, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gParent2, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gParent2, "commit", "-q", "--allow-empty", "-m", "init"]);

        const sedimentLockPath = path.join(gParent2, ".pi-astack", "sediment", "locks", "sediment.lock");
        fs.mkdirSync(path.dirname(sedimentLockPath), { recursive: true });
        fs.writeFileSync(sedimentLockPath, JSON.stringify({ pid: process.pid, created_at: "2026-05-12T10:00:00.000+08:00" }));
        // Leave mtime fresh (just now). acquireLock should refuse to steal
        // and the outer try/catch in writeProjectEntry should surface a
        // status:"rejected" with reason="sediment lock timeout".

        const r = await writeProjectEntry(
          { title: "Fresh Lock Block Test", kind: "maxim", confidence: 5, compiledTruth: "This validates that a fresh sediment.lock is NOT stolen and write reports a lock timeout in result.reason." },
          { projectRoot: gParent2, settings: lockSettings, dryRun: false },
        );
        assert(r.status === "rejected", `fresh sediment.lock must NOT be reclaimed; expected rejected, got status=${r.status}`);
        assert(/sediment lock timeout/i.test(r.reason || ""), `expected sediment lock timeout in reason, got: ${r.reason}`);
        // Lock file is still on disk (we didn't crash, we just blocked).
        assert(
          fs.existsSync(sedimentLockPath),
          `fresh sediment.lock should remain on disk after a blocked write attempt`,
        );
        fs.rmSync(gParent2, { recursive: true, force: true });
      }

      // --- Case g.3: stale workflow.lock (abrain side) gets reclaimed ---
      {
        const workflowLockPath = path.join(gAbrain, ".state", "sediment", "locks", "workflow.lock");
        fs.mkdirSync(path.dirname(workflowLockPath), { recursive: true });
        fs.writeFileSync(workflowLockPath, JSON.stringify({ pid: 999999, created_at: "2026-05-12T00:00:00.000+08:00" }));
        const past = (Date.now() - 60_000) / 1000;
        fs.utimesSync(workflowLockPath, past, past);

        const w = await writeAbrainWorkflow(
          {
            title: "Stale Workflow Lock Reclaim",
            trigger: "smoke trigger phrase",
            body: "## Task Blueprint\n\nValidate stale workflow.lock reclaim.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-stale-workflow",
          },
          { abrainHome: gAbrain, settings: lockSettings },
        );
        assert(w.status === "created" || w.status === "updated", `stale workflow.lock should be reclaimed, got status=${w.status} reason=${w.reason}`);
      }

      // --- Case g.4: fresh workflow.lock blocks write (timeout) ---
      // Same shape as g.2: writeAbrainWorkflow surfaces lock timeout as
      // status:"rejected" with reason, not as a thrown exception.
      {
        const gAbrain2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fresh-workflow-abrain-"));
        execFileSync("git", ["-C", gAbrain2, "init", "-q"]);
        execFileSync("git", ["-C", gAbrain2, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gAbrain2, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gAbrain2, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gAbrain2, "commit", "-q", "--allow-empty", "-m", "init"]);

        const workflowLockPath = path.join(gAbrain2, ".state", "sediment", "locks", "workflow.lock");
        fs.mkdirSync(path.dirname(workflowLockPath), { recursive: true });
        fs.writeFileSync(workflowLockPath, JSON.stringify({ pid: process.pid, created_at: "2026-05-12T10:00:00.000+08:00" }));

        const r = await writeAbrainWorkflow(
          {
            title: "Fresh Workflow Lock Block",
            trigger: "smoke trigger phrase",
            body: "## Task Blueprint\n\nValidate that fresh workflow.lock blocks.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-fresh-workflow-block",
          },
          { abrainHome: gAbrain2, settings: lockSettings },
        );
        assert(r.status === "rejected", `fresh workflow.lock must NOT be reclaimed; expected rejected, got status=${r.status}`);
        assert(/workflow lock timeout|abrain workflow lock timeout/i.test(r.reason || ""), `expected workflow lock timeout in reason, got: ${r.reason}`);
        assert(
          fs.existsSync(workflowLockPath),
          `fresh workflow.lock should remain on disk after a blocked write attempt`,
        );
        fs.rmSync(gAbrain2, { recursive: true, force: true });
      }

      // --- Case g.5: writeAbrainWorkflow TOCTOU race — lock-held dedupe re-check ---
      // Round 6 deepseek-v4-pro P0: simulate two concurrent writers that both
      // pass the pre-lock existsSync, then the file is created before the
      // second writer takes the lock. The second writer MUST detect the
      // duplicate inside the lock and reject with reason="duplicate_slug_race",
      // not silently overwrite via atomicWrite → fs.rename.
      {
        const gAbrain3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-workflow-toctou-abrain-"));
        execFileSync("git", ["-C", gAbrain3, "init", "-q"]);
        execFileSync("git", ["-C", gAbrain3, "config", "user.email", "smoke@pi-astack.local"]);
        execFileSync("git", ["-C", gAbrain3, "config", "user.name", "pi-astack smoke"]);
        execFileSync("git", ["-C", gAbrain3, "config", "commit.gpgsign", "false"]);
        execFileSync("git", ["-C", gAbrain3, "commit", "-q", "--allow-empty", "-m", "init"]);

        // Pre-create target so the lock-held existsSync trips on entry.
        const slug = "run-when-toctou-race";
        const wfDir = path.join(gAbrain3, "workflows");
        fs.mkdirSync(wfDir, { recursive: true });
        const target = path.join(wfDir, `${slug}.md`);
        const preExisting = `---\nid: ${slug}\nkind: pipeline\n---\n# pre-existing\n`;
        fs.writeFileSync(target, preExisting);

        // To exercise the *lock-held* path (not the cheap pre-lock check),
        // we patch writer-internal file existence visibility by removing the
        // target *just before* the pre-lock check sees it, then putting it
        // back. The simplest way to do that in a JS smoke is to use a slug
        // the pre-lock check won't see: we re-rename pre and post.
        const stash = target + ".stash";
        fs.renameSync(target, stash);

        // Schedule re-creation right at lock-acquire time. Since writer's
        // pre-lock existsSync runs synchronously before any awaits in this
        // smoke loop, we manually re-create the target right after kicking
        // off the write but before the lock-held check by yielding once.
        const writePromise = writeAbrainWorkflow(
          {
            title: "TOCTOU race second writer",
            slug,
            trigger: "smoke trigger phrase for race",
            body: "## Task Blueprint\n\nSecond writer for TOCTOU race.",
            crossProject: true,
            tags: ["smoke"],
            sessionId: "smoke-workflow-toctou",
          },
          { abrainHome: gAbrain3, settings: { ...lockSettings, gitCommit: false } },
        );
        // Yield to the microtask queue so writer reaches lint/normalize
        // phase, then place the file back so the lock-held existsSync trips.
        await new Promise((r) => setImmediate(r));
        fs.renameSync(stash, target);

        const r = await writePromise;
        assert(
          r.status === "rejected",
          `writeAbrainWorkflow TOCTOU race must reject second writer; got status=${r.status}`,
        );
        // The reason may be either "duplicate_slug" (pre-lock check caught it)
        // or "duplicate_slug_race" (lock-held re-check caught it). Both are
        // correct — dedupe MUST trigger somewhere. What we explicitly assert
        // against is silent overwrite.
        // Either "duplicate_slug" (pre-lock check caught it) or
        // "duplicate_slug_race" (lock-held re-check caught it) is correct.
        // In practice this smoke exercises the *race* path because the
        // target is renamed away before the pre-lock existsSync and put
        // back during the lock-acquire await window. The byte-identical
        // file assert below is the canonical guarantee.
        assert(
          /duplicate_slug/.test(r.reason || ""),
          `TOCTOU race rejection should mention duplicate_slug, got reason=${r.reason}`,
        );
        // Verify the pre-existing file is byte-identical — i.e., NOT overwritten.
        const onDisk = fs.readFileSync(target, "utf-8");
        assert(
          onDisk === preExisting,
          `TOCTOU race: pre-existing workflow file was overwritten! diff length original=${preExisting.length} after=${onDisk.length}`,
        );
        fs.rmSync(gAbrain3, { recursive: true, force: true });
      }
    }

    // === h: smoke gaps surfaced in Round 6 sonnet coverage audit =========
    //
    // sonnet's 14-command smoke matrix flagged two user-facing paths with
    // ZERO smoke coverage:
    //   - /memory check-backlinks  — checkBacklinks + formatBacklinkReport
    //   - migrate-go frontmatter-unparseable branch (migrate-go.ts:597)
    // Both are reachable by users today; either silently regressing means
    // "the assert that catches it doesn't exist". Fill the gaps.
    {
      const { checkBacklinks, formatBacklinkReport } = req("./memory/graph.js");
      const { DEFAULT_SETTINGS: memSettings } = req("./memory/settings.js");
      const { runMigrationGo } = req("./memory/migrate-go.js");

      // --- Case h.1: checkBacklinks reports dead [[wikilink]] correctly ---
      // Fixture: one entry that links to a non-existent slug — the report
      // must surface deadLinkCount > 0 and formatBacklinkReport must mention
      // the missing slug.
      {
        const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-backlinks-"));
        const decisionsDir = path.join(tgt, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        const fm = [
          "---",
          "id: live-entry",
          "scope: project",
          "kind: decision",
          "status: live",
          "confidence: 7",
          "schema_version: 1",
          "title: Live entry pointing at a ghost",
          "created: '2026-05-12T12:00:00.000+08:00'",
          "updated: '2026-05-12T12:00:00.000+08:00'",
          "---",
          "",
          "# Live entry pointing at a ghost",
          "",
          "## Compiled Truth",
          "",
          "See [[ghost-entry-does-not-exist]] for context.",
          "",
          "## Timeline",
          "",
          "- 2026-05-12: created",
          "",
        ].join("\n");
        fs.writeFileSync(path.join(decisionsDir, "live-entry.md"), fm);

        const report = await checkBacklinks(tgt, memSettings, undefined, tgt);
        assert(
          report.deadLinkCount > 0,
          `checkBacklinks should report deadLinkCount > 0 for [[ghost-entry-does-not-exist]], got ${report.deadLinkCount}`,
        );
        assert(
          Array.isArray(report.issues) && report.issues.some((i) => i.problem === "dead_link" && /ghost-entry/.test(i.to)),
          `checkBacklinks issues should include dead_link to ghost-entry, got ${JSON.stringify(report.issues)}`,
        );
        const formatted = formatBacklinkReport(report);
        assert(
          /ghost-entry-does-not-exist/.test(formatted),
          `formatBacklinkReport output should mention the dead slug, got: ${formatted.slice(0, 200)}`,
        );
        fs.rmSync(tgt, { recursive: true, force: true });
      }

      // --- Case h.2: checkBacklinks zero-dead-links baseline ---
      // Same fixture shape but link points at an existing entry —
      // deadLinkCount must be 0. Catches false-positive regressions.
      {
        const tgt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-backlinks-clean-"));
        const decisionsDir = path.join(tgt, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        const writeEntry = (slug, body) =>
          fs.writeFileSync(
            path.join(decisionsDir, `${slug}.md`),
            [
              "---",
              `id: ${slug}`,
              "scope: project",
              "kind: decision",
              "status: live",
              "confidence: 7",
              "schema_version: 1",
              `title: ${slug}`,
              "created: '2026-05-12T12:00:00.000+08:00'",
              "updated: '2026-05-12T12:00:00.000+08:00'",
              "---",
              "",
              `# ${slug}`,
              "",
              "## Compiled Truth",
              "",
              body,
              "",
              "## Timeline",
              "",
              "- 2026-05-12: created",
              "",
            ].join("\n"),
          );
        writeEntry("alpha", "See [[beta]] for context.");
        writeEntry("beta", "References [[alpha]] back.");

        const report = await checkBacklinks(tgt, memSettings, undefined, tgt);
        assert(
          report.deadLinkCount === 0,
          `checkBacklinks clean fixture should report deadLinkCount=0, got ${report.deadLinkCount}`,
        );
        fs.rmSync(tgt, { recursive: true, force: true });
      }

      // --- Case h.3: migrate-go frontmatter-unparseable note path ---
      // Fixture: a .pensieve entry with frontmatter that's structurally
      // present (delimited by ---) but where parseFrontmatter returns an
      // empty object (e.g. lines that aren't `key: value` scalars). The
      // migration must NOT skip the entry — it must migrate with notes
      // containing "frontmatter-unparseable", per migrate-go.ts:597.
      {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fm-unparse-parent-"));
        const abrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fm-unparse-abrain-"));
        for (const r of [parent, abrain]) {
          execFileSync("git", ["-C", r, "init", "-q"]);
          execFileSync("git", ["-C", r, "config", "user.email", "smoke@pi-astack.local"]);
          execFileSync("git", ["-C", r, "config", "user.name", "pi-astack smoke"]);
          execFileSync("git", ["-C", r, "config", "commit.gpgsign", "false"]);
          execFileSync("git", ["-C", r, "commit", "-q", "--allow-empty", "-m", "init"]);
        }
        const pensieve = path.join(parent, ".pensieve");
        const decisionsDir = path.join(pensieve, "decisions");
        fs.mkdirSync(decisionsDir, { recursive: true });
        // Frontmatter delimiters present, but body between them does not
        // yield key:value pairs (just a stray non-scalar comment line).
        const badYaml = [
          "---",
          "# stray comment, no key:value pairs at all",
          "---",
          "",
          "# An entry with intact body but blank parseable frontmatter",
          "",
          "## Compiled Truth",
          "",
          "This should still migrate; analyzeEntry must flag the note.",
          "",
          "## Timeline",
          "",
          "- 2026-05-12: created",
          "",
        ].join("\n");
        fs.writeFileSync(path.join(decisionsDir, "unparseable-frontmatter.md"), badYaml);
        execFileSync("git", ["-C", parent, "add", "."]);
        execFileSync("git", ["-C", parent, "commit", "-q", "-m", "seed unparseable entry"]);
        await bindMigrationProject(parent, abrain, "smoke-fm-unparseable");

        const result = await runMigrationGo({
          pensieveTarget: pensieve,
          abrainHome: abrain,
          projectId: "smoke-fm-unparseable",
          cwd: parent,
          settings: DEFAULT_SETTINGS,
          migrationTimestamp: "2026-05-12T12:00:00.000+08:00",
        });
        assert(result.ok === true, `migrate-go should succeed despite unparseable frontmatter, got: ${JSON.stringify(result, null, 2).slice(0, 400)}`);
        const entry = (result.entries || []).find((e) => /unparseable-frontmatter/.test(e.source || ""));
        assert(entry, `migrate-go should report the unparseable entry; entry sources=${JSON.stringify(result.entries?.map((e) => e.source))}`);
        assert(
          Array.isArray(entry.normalizationNotes) && entry.normalizationNotes.includes("frontmatter-unparseable"),
          `unparseable entry must carry normalizationNotes=['frontmatter-unparseable'], got=${JSON.stringify(entry.normalizationNotes)}`,
        );
        assert(entry.action === "migrated", `unparseable entry should still be migrated (notes is informational), got action=${entry.action}`);
        fs.rmSync(parent, { recursive: true, force: true });
        fs.rmSync(abrain, { recursive: true, force: true });
      }

      // --- Case h.4: post-migration guard blocks sediment writes ---
      //
      // Round 7 P0-D (opus audit fix): after `/memory migrate --go` succeeds,
      // writeProjectEntry / updateProjectEntry / deleteProjectEntry must
      // refuse to write into `.pensieve/` until B5 cutover ships. Verify:
      //   (1) migrate-go writes `.pensieve/MIGRATED_TO_ABRAIN` flag with
      //       { migratedAt, projectId } JSON
      //   (2) flag is captured in the parent migration commit (so rollback
      //       via `git reset --hard parentPreSha` removes it atomically)
      //   (3) writeProjectEntry on a flagged repo returns
      //       status="rejected", reason="post_migration_pensieve_writes_disabled",
      //       writes an audit row with the same reason + post_migration_guard
      //       field, and does NOT create the entry file
      {
        const gParent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-guard-parent-"));
        const gAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-guard-abrain-"));
        for (const r of [gParent, gAbrain]) {
          execFileSync("git", ["-C", r, "init", "-q"]);
          execFileSync("git", ["-C", r, "config", "user.email", "smoke@pi-astack.local"]);
          execFileSync("git", ["-C", r, "config", "user.name", "pi-astack smoke"]);
          execFileSync("git", ["-C", r, "config", "commit.gpgsign", "false"]);
          execFileSync("git", ["-C", r, "commit", "-q", "--allow-empty", "-m", "init"]);
        }
        // Seed a real user entry so preflight passes.
        const pensieve = path.join(gParent, ".pensieve");
        fs.mkdirSync(path.join(pensieve, "maxims"), { recursive: true });
        fs.writeFileSync(path.join(pensieve, "maxims", "x.md"), makeEntry({ title: "X", kind: "maxim" }));
        execFileSync("git", ["-C", gParent, "add", "."]);
        execFileSync("git", ["-C", gParent, "commit", "-q", "-m", "seed"]);
        await bindMigrationProject(gParent, gAbrain, "guard-proj");
        const goRes = await runMigrationGo({
          pensieveTarget: pensieve,
          abrainHome: gAbrain,
          projectId: "guard-proj",
          cwd: gParent,
          settings: DEFAULT_SETTINGS,
          migrationTimestamp: "2026-05-12T12:00:00.000+08:00",
        });
        assert(goRes.ok === true, `guard setup migrate-go must succeed: ${JSON.stringify(goRes.preconditionFailures)}`);

        // (1) Flag file exists with expected JSON shape
        const flagPath = path.join(gParent, ".pensieve", "MIGRATED_TO_ABRAIN");
        assert(fs.existsSync(flagPath), `post-migration flag must exist at ${flagPath}`);
        const flag = JSON.parse(fs.readFileSync(flagPath, "utf-8"));
        assert(flag.projectId === "guard-proj", `flag.projectId mismatch: ${flag.projectId}`);
        assert(flag.migratedAt === "2026-05-12T12:00:00.000+08:00", `flag.migratedAt mismatch: ${flag.migratedAt}`);

        // (2) Flag is git-tracked in the parent commit (so rollback wipes it)
        const trackedLs = execFileSync("git", ["-C", gParent, "ls-files", ".pensieve/MIGRATED_TO_ABRAIN"], { encoding: "utf-8" }).trim();
        assert(trackedLs === ".pensieve/MIGRATED_TO_ABRAIN", `flag must be git-tracked, got ls-files: '${trackedLs}'`);

        // (3) writeProjectEntry on flagged repo rejects with structured reason
        const guardRes = await writeProjectEntry(
          {
            title: "Post-migration probe",
            kind: "maxim",
            status: "provisional",
            confidence: 5,
            compiledTruth: "# Post-migration probe\n\nshould be rejected.",
            timelineNote: "smoke-guard",
            sessionId: "smoke-guard",
          },
          { projectRoot: gParent, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(guardRes.status === "rejected", `writeProjectEntry on flagged repo must be rejected, got: ${guardRes.status}`);
        assert(
          guardRes.reason === "post_migration_pensieve_writes_disabled",
          `rejection reason mismatch: ${guardRes.reason}`,
        );
        // Entry file must NOT exist (writer did not even reach buildMarkdown).
        assert(
          !fs.existsSync(path.join(gParent, ".pensieve", "maxims", "post-migration-probe.md")),
          `flagged write must not create entry file on disk`,
        );
        // Audit row was written with the same reason + post_migration_guard payload.
        const auditRows = fs.readFileSync(path.join(gParent, ".pi-astack", "sediment", "audit.jsonl"), "utf-8")
          .trim().split("\n").map(JSON.parse);
        const guardAudit = auditRows.find((r) => r.operation === "reject" && r.reason === "post_migration_pensieve_writes_disabled");
        assert(guardAudit, `expected reject audit row with reason=post_migration_pensieve_writes_disabled; got ${auditRows.length} rows`);
        assert(
          guardAudit.post_migration_guard?.projectId === "guard-proj",
          `guard audit row should embed flag info, got post_migration_guard=${JSON.stringify(guardAudit.post_migration_guard)}`,
        );

        fs.rmSync(gParent, { recursive: true, force: true });
        fs.rmSync(gAbrain, { recursive: true, force: true });
      }

      // --- Case h.5: compareTimestamps TZ-aware semantics ---
      //
      // Round 7 P1 (sonnet audit fix): three call sites (parser dedup
      // tiebreak, llm-search sortForIndex, lint T5) used to lexicographically
      // compare timestamp strings. That breaks across two common cases:
      //   (a) mixed precision: "2026-05-13" (date-only, UTC midnight) vs
      //       "2026-05-13T00:30:00.000+08:00" (= UTC 2026-05-12T16:30,
      //       actually OLDER). String compare returns date-only < full-ISO
      //       => abrain entry wins, but it's actually 7.5h older.
      //   (b) cross-TZ: "2026-05-13T12:00:00.000+08:00" (= UTC 04:00) vs
      //       "2026-05-13T06:00:00.000-05:00" (= UTC 11:00, newer).
      //       String compare puts the +08:00 first; UTC time says -05:00
      //       is newer.
      //
      // Verify compareTimestamps fixes both, and that lexicographic compare
      // would have given the wrong answer (so we know the test is
      // actually exercising the fix path).
      {
        const { compareTimestamps } = req("./memory/utils.js");
        // Case (a): date-only is UTC midnight, full-ISO with +08:00
        // at 00:30 local is UTC 16:30 prior day — older.
        const a1 = "2026-05-13";
        const a2 = "2026-05-13T00:30:00.000+08:00";
        assert(a1.localeCompare(a2) < 0, `precondition: string compare should sort date-only < full-ISO`);
        assert(compareTimestamps(a1, a2) > 0, `compareTimestamps should know date-only UTC midnight > UTC 16:30 prior day, got: ${compareTimestamps(a1, a2)}`);

        // Case (b): cross-TZ — +08:00 noon vs -05:00 morning.
        const b1 = "2026-05-13T12:00:00.000+08:00";  // UTC 04:00
        const b2 = "2026-05-13T06:00:00.000-05:00";  // UTC 11:00 (newer)
        assert(b1.localeCompare(b2) > 0, `precondition: string compare should sort +08:00 noon > -05:00 morning`);
        assert(compareTimestamps(b1, b2) < 0, `compareTimestamps should know -05:00 morning is newer, got: ${compareTimestamps(b1, b2)}`);

        // Identity / undefined handling
        assert(compareTimestamps("2026-05-13", "2026-05-13") === 0, `equal timestamps should compare 0`);
        assert(compareTimestamps(undefined, "2026-05-13") > 0, `undefined should sort last (positive)`);
        assert(compareTimestamps("2026-05-13", undefined) < 0, `defined < undefined`);
        assert(compareTimestamps(undefined, undefined) === 0, `both undefined equal`);
        // Unparseable garbage shouldn't NaN-pollute the sort — garbage should sort last.
        assert(compareTimestamps("not-a-date", "2026-05-13") > 0, `unparseable should sort last (positive)`);
      }

      // --- Case h.6: updateProjectEntry RMW lock-scope (Round 8 P0 fix) ---
      //
      // gpt-5.5 R8 audit P0: updateProjectEntry used to do find+read+merge+lint
      // OUTSIDE the sediment lock and only atomicWrite INSIDE the lock. A
      // concurrent hard-delete in between would unlink the target, then the
      // late atomicWrite would resurrect the entry from a stale raw snapshot.
      // Verify that running with a hard-delete pre-staged to fire "during" the
      // update (we simulate this with sequential async ops in the same
      // process; the lock semantics are validated by the fact that delete
      // commits while update is blocked on acquireLock) does NOT resurrect
      // the entry.
      {
        const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-rmw-race-"));
        // Seed an entry.
        const seedRes = await writeProjectEntry(
          { title: "RMW Race Probe", kind: "fact", status: "active", confidence: 5, compiledTruth: "# RMW Race Probe\n\noriginal body content for race test.", timelineNote: "smoke seed", sessionId: "smoke-rmw" },
          { projectRoot: raceRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(seedRes.status === "created", `seed write should create, got: ${seedRes.status} / ${seedRes.reason}`);
        const targetPath = seedRes.path;
        assert(fs.existsSync(targetPath), `seed entry file should exist at ${targetPath}`);

        // Schedule both update + hard-delete concurrently. The first to
        // acquire the lock proceeds; the second observes the post-state.
        // With the R8 fix, hard-delete-then-update outcome: target gone
        // AND update returns rejected entry_not_found (lookup under lock
        // sees no file). Without the fix, update would resurrect the file.
        const updatePromise = updateProjectEntry(
          "rmw-race-probe",
          { compiledTruth: "# RMW Race Probe\n\nNEW BODY — should not resurrect a deleted entry.", sessionId: "smoke-rmw", timelineNote: "smoke update" },
          { projectRoot: raceRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        const deletePromise = deleteProjectEntry(
          "rmw-race-probe",
          { projectRoot: raceRoot, settings: DEFAULT_SEDIMENT_SETTINGS, mode: "hard", reason: "smoke race", sessionId: "smoke-rmw", auditContext: { lane: "explicit" } },
        );
        const [updRes, delRes] = await Promise.all([updatePromise, deletePromise]);

        // Whichever wins the lock first, the post-state MUST be consistent:
        //   Scenario A (delete wins lock first): file gone + update rejected
        //   Scenario B (update wins lock first): file present with NEW BODY +
        //                                         delete then sees file gone or hard-deletes
        // Round 9 P0 (opus R9-3 fix): the original h.6 assertion was
        // too loose. It accepted `updRes.status === "updated"` whenever
        // the file existed at end-of-race — BUT the bug fingerprint is
        // exactly that: when delete reports deleted, file should NOT
        // exist. Resurrection bug: delete unlinks → update lock acquired
        // after delete → atomicWrite reapplies stale-read merge → file
        // reappears with NEW BODY. The old smoke read "NEW BODY present"
        // as proof of "update won lock first", but it's equally
        // consistent with resurrection. Tighten: enforce that delete
        // status and file existence are MUTUALLY EXCLUSIVE.
        const fileExists = fs.existsSync(targetPath);
        const onDisk = fileExists ? fs.readFileSync(targetPath, "utf-8") : null;

        // Invariant 1: delete reporting "deleted" + file existing = resurrection
        if (delRes.status === "deleted" && fileExists) {
          throw new Error(
            `RMW resurrection: delete reported status=deleted but file STILL EXISTS at ${targetPath}\n` +
            `disk content: ${onDisk?.slice(0, 300)}\n` +
            `updRes=${JSON.stringify(updRes)}\ndelRes=${JSON.stringify(delRes)}`,
          );
        }

        // Invariant 2: when file deleted, update must have status "rejected"
        // (delete-won-first; update saw missing file inside lock) OR
        // "updated" (update-won-first; lock-internal atomicWrite happened
        // before delete grabbed lock and unlinked).
        if (!fileExists) {
          if (updRes.status !== "rejected" && updRes.status !== "updated") {
            throw new Error(`unexpected update status when file deleted: ${updRes.status}/${updRes.reason}`);
          }
          // Stronger: if updRes is "rejected", reason must be entry_not_found
          if (updRes.status === "rejected" && updRes.reason !== "entry_not_found") {
            throw new Error(
              `update rejected for unexpected reason in race: ${updRes.reason} ` +
              `(expected entry_not_found when delete-won-first)`,
            );
          }
        } else {
          // File exists. Two valid cases:
          //   (a) update-won-first, then delete saw missing file in its
          //       merge step — delete should be status="absent" or have
          //       not reached its lock yet. delRes.status === "deleted"
          //       with file present is invariant-1 violation, already caught.
          //   (b) update-won-first, delete genuinely failed (e.g. lock
          //       contention timed out). Body must be NEW (merge applied).
          assert(
            /NEW BODY/.test(onDisk),
            `file exists post-race but body is not the merged NEW BODY: ${onDisk.slice(0, 300)}`,
          );
          assert(
            !/original body content for race test/.test(onDisk),
            `file exists with original (pre-update) body — update never ran: ${onDisk.slice(0, 200)}`,
          );
          assert(
            updRes.status === "updated",
            `if file exists with NEW BODY, update must have status=updated, got: ${updRes.status}`,
          );
          // R9: delete should NOT report "deleted" — file is there.
          assert(
            delRes.status !== "deleted",
            `file present but delete reported status=deleted: invariant violation`,
          );
        }

        fs.rmSync(raceRoot, { recursive: true, force: true });
      }

      // --- Case h.7: writeAbrainWorkflow status enum validation (R8 P1) ---
      //
      // gpt-5.5 R8 audit: validateWorkflowDraft only checked
      // `typeof status === "string"`, letting arbitrary strings land in
      // the workflow's frontmatter. Now must reject status NOT in
      // ENTRY_STATUSES.
      {
        const wfRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-enum-"));
        // R9 P1 (opus P2-5 + deepseek P1-3 surface): smoke fixture needs
        // either git init OR settings.gitCommit=false. The new R9 P1
        // orphan-cleanup behavior rejects writes whose gitCommit returns
        // null (orphan file is unlinked + audit row written), so wfRoot
        // without .git was previously "created" with gitCommit=null and
        // now correctly returns rejected/git_commit_failed.
        const wfSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: false };
        const wfBad = await writeAbrainWorkflow(
          {
            title: "Bad Status Workflow",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "deleted",  // not in ENTRY_STATUSES
          },
          { abrainHome: wfRoot, settings: wfSettings, auditContext: { lane: "workflow" } },
        );
        assert(wfBad.status === "rejected", `bad workflow status must reject, got: ${wfBad.status}`);
        assert(
          /status/i.test(wfBad.reason || "") || /validation/i.test(wfBad.reason || ""),
          `bad workflow status rejection should mention validation, got: ${wfBad.reason}`,
        );

        // Positive: legitimate status enum value must succeed.
        const wfOk = await writeAbrainWorkflow(
          {
            title: "Good Status Workflow",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "active",
          },
          { abrainHome: wfRoot, settings: wfSettings, auditContext: { lane: "workflow" } },
        );
        assert(wfOk.status === "created", `good workflow status should create: ${wfOk.status} / ${wfOk.reason}`);

        // --- R9 P1 (deepseek P1-3): gitCommit null -> orphan cleanup ---
        // Init wfRoot as a git repo so gitCommit attempts run. But there
        // is no remote and the repo is fresh, so git commit will succeed.
        // To force gitCommitAbrain to return null, point gitCommit to a
        // non-git path — simulate by writing into a directory missing .git
        // BUT enabling gitCommit so gitCommitAbrain's `git add` will fail.
        const wfFailRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-wf-orphan-"));
        // do NOT git init: gitCommitAbrain's `git -C <root> add ...` will
        // fail because <root> is not a git repo.
        const wfFailSettings = { ...DEFAULT_SEDIMENT_SETTINGS, gitCommit: true };
        const wfOrphan = await writeAbrainWorkflow(
          {
            title: "Orphan Cleanup Probe",
            trigger: "on test",
            body: "this body is long enough for workflow validation gate",
            crossProject: true,
            status: "active",
          },
          { abrainHome: wfFailRoot, settings: wfFailSettings, auditContext: { lane: "workflow" } },
        );
        assert(
          wfOrphan.status === "rejected" && wfOrphan.reason === "git_commit_failed",
          `R9 P1: gitCommit-null path must reject + cleanup, got: ${JSON.stringify(wfOrphan)}`,
        );
        // R9 P1: file must be unlinked (no orphan on disk)
        const orphanTarget = path.join(wfFailRoot, "workflows", "orphan-cleanup-probe.md");
        assert(
          !fs.existsSync(orphanTarget),
          `R9 P1: orphan file must be cleaned, but still exists: ${orphanTarget}`,
        );
        // R9 P1: audit row must record the orphan cleanup
        const wfAuditPath = path.join(wfFailRoot, ".state", "sediment", "audit.jsonl");
        if (fs.existsSync(wfAuditPath)) {
          const rows = fs.readFileSync(wfAuditPath, "utf-8").trim().split("\n").filter(Boolean).map(JSON.parse);
          const orphanRow = rows.find((r) => r.reason === "git_commit_failed_orphan_cleaned");
          assert(orphanRow, `R9 P1: audit must contain git_commit_failed_orphan_cleaned row, got: ${rows.map((r) => r.operation + "/" + (r.reason || "")).join(",")}`);
        }
        fs.rmSync(wfFailRoot, { recursive: true, force: true });
        fs.rmSync(wfRoot, { recursive: true, force: true });
      }

      // --- Case h.8: frontmatterPatch protected key denylist (R8 P1) ---
      //
      // gpt-5.5 R8 audit: updateProjectEntry used to let frontmatterPatch
      // overwrite system-managed keys (id/scope/kind/status/confidence/etc).
      // Now must throw an Error mentioning the protected key.
      {
        const denyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-smoke-fmpatch-deny-"));
        const seed = await writeProjectEntry(
          { title: "Patch Denylist Probe", kind: "fact", status: "active", confidence: 5, compiledTruth: "# Patch Denylist Probe\n\nsome body content here.", timelineNote: "seed", sessionId: "smoke-deny" },
          { projectRoot: denyRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(seed.status === "created", `seed write should create: ${seed.status}`);

        // Attempt to override `kind` (a protected key) via frontmatterPatch.
        // The throw inside mergeUpdateMarkdown is caught by updateProjectEntry's
        // lock-internal try/catch which converts it to status="rejected" +
        // reason carrying the error message — NOT an awaited throw.
        const denyKind = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { kind: "workflow" } },
          { projectRoot: denyRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(denyKind.status === "rejected", `frontmatterPatch protected key 'kind' must be rejected, got: ${denyKind.status}`);
        assert(
          /protected key 'kind'/.test(denyKind.reason || ""),
          `protected key rejection should mention 'kind', got reason: ${denyKind.reason}`,
        );

        // Bad key shape (newline injection attempt) must also be rejected.
        const denyBadKey = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { "good\ninjected": "x" } },
          { projectRoot: denyRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(denyBadKey.status === "rejected", `frontmatterPatch bad key shape must be rejected, got: ${denyBadKey.status}`);
        assert(
          /invalid characters/.test(denyBadKey.reason || ""),
          `bad key shape rejection should mention invalid characters, got reason: ${denyBadKey.reason}`,
        );

        // Non-protected key still works (positive case).
        const okPatch = await updateProjectEntry(
          "patch-denylist-probe",
          { compiledTruth: "# Patch Denylist Probe\n\nupdated body content here.", sessionId: "smoke-deny", frontmatterPatch: { tags: ["r8-smoke"] } },
          { projectRoot: denyRoot, settings: DEFAULT_SEDIMENT_SETTINGS, auditContext: { lane: "explicit" } },
        );
        assert(okPatch.status === "updated", `non-protected frontmatterPatch should succeed: ${okPatch.status} / ${okPatch.reason}`);
        const onDisk = fs.readFileSync(okPatch.path, "utf-8");
        assert(/^tags:/m.test(onDisk), `non-protected patch should write 'tags:' to frontmatter; got: ${onDisk.slice(0, 400)}`);
        fs.rmSync(denyRoot, { recursive: true, force: true });
      }
    }

    console.log(JSON.stringify({ ok: true, transpiledFiles: count, tools: [...tools.keys()], commands: [...commands.keys()] }, null, 2));
  } finally {
    if (process.env.PI_ASTACK_KEEP_SMOKE_TMP !== "1") fs.rmSync(outRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
