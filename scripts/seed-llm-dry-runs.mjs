#!/usr/bin/env node
/**
 * One-shot script to seed sediment LLM extractor dry-run samples toward the
 * auto-write readiness gate (minDryRunSamples=20, requiredDryRunPassRate=0.9).
 *
 * Why this exists: the readiness gate requires N successful dry-runs of the
 * extractor pipeline (prompt + parser + quality gate) before auto-write can be
 * unlocked. Outside a real pi session, the regular `/sediment llm --dry-run`
 * command is unavailable. This script bypasses the pi runtime ModelRegistry by
 * resolving pi-ai's getModel + streamSimple directly, runs the same prompt /
 * parser / summary code paths, and appends `llm_dry_run` events to
 * `.pensieve/.state/sediment-events.jsonl` (the audit log doctor-lite reads).
 *
 * Usage:
 *
 *   cd agent/skills/pi-astack
 *   node scripts/seed-llm-dry-runs.mjs
 *
 * Resolution:
 *   - PROJECT_ROOT defaults to the parent ~/.pi (containing .pensieve/);
 *     override with `PI_PROJECT_ROOT=/path/to/project`.
 *   - PI_AI module is resolved via `import.meta.resolve("@earendil-works/pi-ai")`;
 *     override with `PI_AI_DIST=/path/to/pi-ai/dist/index.js` if needed.
 *   - Model: deepseek/deepseek-v4-pro via sub2api proxy
 *     (https://sub2api.alfadb.cn/v1) using DEEPSEEK_API_KEY env var.
 *
 * This is a one-shot tool. Re-run only when extractor prompts/parser change
 * and you want fresh samples; otherwise `/sediment readiness` and
 * `/memory doctor-lite` already reflect the gate state from the audit log.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(
  process.env.PI_PROJECT_ROOT
    ? process.env.PI_PROJECT_ROOT.replace(/^~(?=$|\/)/, os.homedir())
    : path.resolve(repoRoot, "..", "..", ".."),
);

if (!fs.existsSync(path.join(projectRoot, ".pensieve"))) {
  console.error(`Error: ${projectRoot}/.pensieve not found. Set PI_PROJECT_ROOT to the project that owns .pensieve/`);
  process.exit(1);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("Error: DEEPSEEK_API_KEY env var is required (used by the sub2api proxy).");
  process.exit(1);
}

async function resolvePiAi() {
  if (process.env.PI_AI_DIST) {
    return await import(process.env.PI_AI_DIST);
  }
  try {
    const req = createRequire(import.meta.url);
    const resolved = req.resolve("@earendil-works/pi-ai");
    return await import(resolved);
  } catch {
    // Fallback: try the bundled volta location used by the pi CLI install.
    const volta = "/home/worker/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js";
    if (fs.existsSync(volta)) return await import(volta);
    throw new Error("could not resolve @earendil-works/pi-ai; set PI_AI_DIST=/path/to/pi-ai/dist/index.js");
  }
}

const piAi = await resolvePiAi();
const { getModel, streamSimple } = piAi;

const requireFromRepo = createRequire(`${repoRoot}/package.json`);
const ts = requireFromRepo("typescript");

function transpile(outRoot) {
  for (const dir of ["sediment", "memory"]) {
    const srcDir = `${repoRoot}/extensions/${dir}`;
    for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith(".ts"))) {
      const src = fs.readFileSync(`${srcDir}/${file}`, "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      const outPath = `${outRoot}/${dir}/${file.replace(/\.ts$/, ".js")}`;
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

const outRoot = fs.mkdtempSync(`${os.tmpdir()}/pi-astack-dry-`);
transpile(outRoot);
const req = createRequire(`${outRoot}/runner.cjs`);
const { buildLlmExtractorPrompt, summarizeLlmExtractorDryRun } = req("./sediment/llm-extractor.js");
const { previewExtraction, parseExplicitMemoryBlocks } = req("./sediment/extractor.js");
const { appendAudit } = req("./sediment/writer.js");
const { readLlmDryRunReport, evaluateLlmAutoWriteReadiness, formatLlmAutoWriteReadiness } = req("./sediment/report.js");
const { DEFAULT_SEDIMENT_SETTINGS } = req("./sediment/settings.js");

// 24 transcript windows: ~12 with extractable insights, ~12 that should yield SKIP.
// Mix is intentional — the readiness gate cares about pipeline correctness
// (well-formed output / proper SKIP vs garbage), not the LLM's editorial taste.
const WINDOWS = [
  { id: "fix-deepseek-empty-response", text: `--- ENTRY a1 2026-05-08T10:00Z message ---\nuser: deepseek-v4-pro returns empty content array on long inputs >50KB\n--- ENTRY a2 2026-05-08T10:01Z tool_use ---\nbash: curl -s api -d '{...50KB prompt...}' | jq .\n--- ENTRY a3 2026-05-08T10:02Z tool_result ---\n{"content": []}\n--- ENTRY a4 2026-05-08T10:03Z message ---\nassistant: Confirmed: deepseek-v4-pro silently returns empty content for prompts over 50KB without error. Workaround: chunk inputs above 40KB.\n` },
  { id: "decide-rg-over-find", text: `--- ENTRY b1 message ---\nuser: should we use rg or find for memory file walk?\n--- ENTRY b2 message ---\nassistant: rg is 10x faster on large trees, has built-in --glob, respects .gitignore. find requires manual filtering. Decision: use rg with find as graceful fallback when rg is missing.\n` },
  { id: "decide-prefer-bare-slug", text: `--- ENTRY c1 message ---\nuser: should facade return canonical id (project:pi:foo) or bare slug (foo)?\n--- ENTRY c2 tool_use ---\nrg "id:" .pensieve/decisions\n--- ENTRY c3 message ---\nassistant: Bare slug. Reasons: (1) callers don't know scope prefix, (2) cross-store search collides anyway, (3) users type bare slugs. Facade strips project:/world: prefix on return.\n` },
  { id: "decide-skip-fenced-code-wikilinks", text: `--- ENTRY d1 message ---\nuser: doc files with [[slug]] examples produce dead-link warnings; how to fix?\n--- ENTRY d2 message ---\nassistant: extractBodyWikilinks treats every [[X]] as a graph edge, including those inside code spans. Fix: strip fenced \`\`\`...\`\`\` and inline \`...\` regions before regex scan. Smoke regression test added to lock this in.\n` },
  { id: "fact-deepseek-baseurl-override", text: `--- ENTRY e1 message ---\nuser: standalone Node script can't auth deepseek without sub2api\n--- ENTRY e2 message ---\nassistant: pi-ai's getModel("deepseek","deepseek-v4-pro") returns baseUrl https://api.deepseek.com. To use the sub2api proxy, mutate model.baseUrl to "https://sub2api.alfadb.cn/v1" before passing to streamSimple. The DEEPSEEK_API_KEY env var works as the proxy auth.\n` },
  { id: "fact-pi-skill-loading", text: `--- ENTRY f1 message ---\nassistant: Investigated pi skill loading. Skills declared in pi-astack-settings.json packages array are auto-loaded. The skill's SKILL.md is parsed for description/triggers. Skills are LLM-routed via tool descriptions, not via slash routing.\n` },
  { id: "decide-git-as-safety-net", text: `--- ENTRY g1 message ---\nuser: should migration tooling include batch apply + queue UI?\n--- ENTRY g2 message ---\nassistant: No. Migration is one-shot. git commit-per-batch is sufficient safety. Single-file plan/apply/restore is enough — burn-in proved 20+ applies, 3 restores, 1 verified target_modified rejection. Backup directory pruned post-migration.\n` },
  { id: "decide-sediment-codespan-strip", text: `--- ENTRY h1 message ---\nuser: should the parser preserve code-span [[X]] for human readers?\n--- ENTRY h2 message ---\nassistant: Yes for display, no for graph. Decision: strip code regions only inside extractBodyWikilinks (graph edge construction), not in body text rendering. The MD source stays unchanged.\n` },
  { id: "fact-doctor-lite-orphan-policy", text: `--- ENTRY i1 message ---\nassistant: Confirmed via reading doctor.ts: orphan count does NOT escalate doctor-lite status. Status escalates on lint errors, dead links, build failures, missing index, sediment dry-run problems, migration backup state errors. Orphans are informational only.\n` },
  { id: "smell-ad-hoc-script-vs-test", text: `--- ENTRY j1 message ---\nuser: should we add a unit test for the parser fix?\n--- ENTRY j2 message ---\nassistant: Yes — added regression in scripts/smoke-memory-sediment.mjs. Verified by reverting the fix and confirming the test fails with "code-span/fenced wikilink leaked into graph edges". Standalone scripts that don't survive in CI are not equivalent.\n` },
  { id: "anti-pattern-batch-llm-write", text: `--- ENTRY k1 message ---\nassistant: Anti-pattern observed: enabling auto LLM writes before dry-run sample threshold leads to memory pollution. Each main-session decision became a half-formed candidate. Fix: gate auto-write behind autoLlmWriteEnabled + minDryRunSamples + requiredDryRunPassRate. Default off.\n` },
  { id: "decide-prune-backups", text: `--- ENTRY l1 message ---\nuser: 167 migration backup directories accumulated, 4.6MB. Keep them?\n--- ENTRY l2 message ---\nassistant: Prune. Git history is the canonical undo trail (each batch was committed). Backups are gitignored disk-only artifacts. Doctor-lite escalates to warning when backup count > 0 with target_modified states. Pruning brings status to pass.\n` },

  { id: "skip-ls-output", text: `--- ENTRY m1 tool_use ---\nbash: ls -la\n--- ENTRY m2 tool_result ---\ndrwxr-xr-x 4 worker worker  10 May  8 12:30 .\ndrwxr-xr-x 3 worker worker   3 May  8 11:20 ..\n-rw-r--r-- 1 worker worker 234 May  8 12:25 README.md\n` },
  { id: "skip-greet", text: `--- ENTRY n1 message ---\nuser: 你好\n--- ENTRY n2 message ---\nassistant: 你好。需要做什么？\n` },
  { id: "skip-pwd-only", text: `--- ENTRY o1 tool_use ---\nbash: pwd\n--- ENTRY o2 tool_result ---\n/home/worker/.pi\n` },
  { id: "skip-thinking-noise", text: `--- ENTRY p1 message ---\nassistant: Let me think about this for a moment. I'll need to check several things first before deciding the best approach.\n` },
  { id: "skip-cat-readme", text: `--- ENTRY q1 tool_use ---\nbash: cat README.md\n--- ENTRY q2 tool_result ---\n# pi global\n\nThis is the project root.\n` },
  { id: "skip-status-check", text: `--- ENTRY r1 tool_use ---\nbash: git status\n--- ENTRY r2 tool_result ---\nOn branch main\nnothing to commit, working tree clean\n` },
  { id: "skip-ack", text: `--- ENTRY s1 message ---\nuser: 收到，继续\n--- ENTRY s2 message ---\nassistant: 好。\n` },
  { id: "skip-todo-list", text: `--- ENTRY t1 message ---\nassistant: TODO: (1) read file, (2) parse, (3) save. Doing them in order now.\n` },
  { id: "skip-error-without-fix", text: `--- ENTRY u1 tool_use ---\nbash: nonexistent-command\n--- ENTRY u2 tool_result ---\nbash: nonexistent-command: command not found\n` },
  { id: "skip-progress-msg", text: `--- ENTRY v1 message ---\nassistant: Step 1 done. Moving to step 2.\n` },
  { id: "skip-empty-rg", text: `--- ENTRY w1 tool_use ---\nbash: rg foo .pensieve | head\n--- ENTRY w2 tool_result ---\n(no output)\n` },
  { id: "skip-confirmation", text: `--- ENTRY x1 message ---\nuser: yes do that\n--- ENTRY x2 message ---\nassistant: OK.\n` },
];

const baseModel = getModel("deepseek", "deepseek-v4-pro");
const proxyModel = { ...baseModel, baseUrl: "https://sub2api.alfadb.cn/v1" };

const settings = {
  ...DEFAULT_SEDIMENT_SETTINGS,
  extractorTimeoutMs: 60000,
  extractorMaxRetries: 2,
};

console.log(`Running ${WINDOWS.length} dry-run samples against ${baseModel.provider}/${baseModel.id} via sub2api...`);
console.log(`Audit log: ${path.relative(projectRoot, path.join(projectRoot, ".pensieve", ".state", "sediment-events.jsonl"))}`);
console.log();

const startedAll = Date.now();
let idx = 0;
for (const w of WINDOWS) {
  idx++;
  const t0 = Date.now();
  process.stdout.write(`[${idx}/${WINDOWS.length}] ${w.id}: `);
  let dryResult;
  try {
    const prompt = buildLlmExtractorPrompt(w.text);
    const stream = streamSimple(
      proxyModel,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { apiKey: process.env.DEEPSEEK_API_KEY, timeoutMs: settings.extractorTimeoutMs, maxRetries: settings.extractorMaxRetries },
    );
    const finalMsg = await stream.result();
    if (finalMsg.stopReason === "error" || finalMsg.stopReason === "aborted") {
      dryResult = { ok: false, model: settings.extractorModel, stopReason: finalMsg.stopReason, error: finalMsg.errorMessage || finalMsg.stopReason };
    } else {
      const rawText = (finalMsg.content ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("\n").trim();
      if (!rawText || rawText === "SKIP") {
        dryResult = { ok: true, model: settings.extractorModel, stopReason: finalMsg.stopReason, rawText: rawText || "SKIP", extraction: previewExtraction([]) };
      } else {
        const drafts = parseExplicitMemoryBlocks(rawText);
        dryResult = { ok: true, model: settings.extractorModel, stopReason: finalMsg.stopReason, rawText, extraction: previewExtraction(drafts) };
      }
    }
  } catch (e) {
    dryResult = { ok: false, model: settings.extractorModel, error: e instanceof Error ? e.message : String(e) };
  }
  const llmSummary = summarizeLlmExtractorDryRun(dryResult, {
    maxCandidates: settings.extractorMaxCandidates,
    rawPreviewChars: settings.extractorAuditRawChars,
  });
  await appendAudit(projectRoot, {
    operation: "llm_dry_run",
    window_id: w.id,
    window_chars: w.text.length,
    duration_ms: Date.now() - t0,
    llm: llmSummary,
    checkpoint_advanced: false,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const status = llmSummary.quality.passed ? "PASS" : "FAIL";
  console.log(`${status} (${llmSummary.quality.reason}, ${llmSummary.quality.candidateCount} candidates, ${dt}s)`);
}

console.log(`\n=== Total elapsed: ${((Date.now() - startedAll) / 1000).toFixed(1)}s ===\n`);

const report = await readLlmDryRunReport(projectRoot);
const readiness = evaluateLlmAutoWriteReadiness(report, settings);
console.log(formatLlmAutoWriteReadiness(readiness));

fs.rmSync(outRoot, { recursive: true, force: true });
