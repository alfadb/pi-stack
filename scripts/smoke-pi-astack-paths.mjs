#!/usr/bin/env node
/**
 * Path-routing regression for pi-astack runtime artifacts.
 *
 * Verifies that every per-module helper in extensions/_shared/runtime.ts
 * routes through the single root `<projectRoot>/.pi-astack/<module>/...`
 * and that the per-module subdirectory matches the public name. This
 * guards against a reviewer accidentally splitting one module's outputs
 * across multiple roots (the bug this script was added to prevent
 * happened to model-fallback, which used to write to
 * `~/.pi-extensions/model-fallback.log` instead of
 * `<projectRoot>/.pi-astack/model-fallback/canary.log`).
 *
 * Also exercises the actual mkdir + appendFile path of model-fallback's
 * canaryLog by replaying its logic against a tmp project root, then
 * asserts the file lives at the expected canonical location.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpileTsToCjs(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  });
  return out.outputText;
}

function loadModuleFromString(code, fakePath) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  m._compile(code, fakePath);
  return m.exports;
}

const runtimeSrc = path.join(repoRoot, "extensions/_shared/runtime.ts");
const compiled = transpileTsToCjs(runtimeSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-"));
const tmpFile = path.join(tmpDir, "runtime.cjs");
fs.writeFileSync(tmpFile, compiled);

const r = loadModuleFromString(compiled, tmpFile);

console.log("pi-astack runtime path-routing regression");

// ── canonical root ─────────────────────────────────────────────
const projectRoot = path.join(tmpDir, "fake-project");

check("piAstackRoot is <projectRoot>/.pi-astack", () => {
  const got = r.piAstackRoot(projectRoot);
  const want = path.join(projectRoot, ".pi-astack");
  if (got !== want) throw new Error(`got ${got}, want ${want}`);
});

// ── per-module subdirs and canonical files ─────────────────────
const cases = [
  ["sediment",         "sedimentDir",            r.sedimentDir,                ""],
  ["sediment",         "sedimentAuditPath",      r.sedimentAuditPath,          "audit.jsonl"],
  ["sediment",         "sedimentCheckpointPath", r.sedimentCheckpointPath,     "checkpoint.json"],
  ["sediment",         "sedimentLocksDir",       r.sedimentLocksDir,           "locks"],
  ["memory",           "memoryDir",              r.memoryDir,                  ""],
  ["memory",           "memoryMigrationReportPath", r.memoryMigrationReportPath, "migration-report.md"],
  ["compaction-tuner", "compactionTunerDir",     r.compactionTunerDir,         ""],
  ["compaction-tuner", "compactionTunerAuditPath", r.compactionTunerAuditPath, "audit.jsonl"],
  ["model-fallback",   "modelFallbackDir",       r.modelFallbackDir,           ""],
  ["model-fallback",   "modelFallbackCanaryPath", r.modelFallbackCanaryPath,   "canary.log"],
];

for (const [module, name, fn, leaf] of cases) {
  check(`${name} routes to .pi-astack/${module}${leaf ? "/" + leaf : ""}`, () => {
    const got = fn(projectRoot);
    const want = path.join(projectRoot, ".pi-astack", module, leaf);
    if (got !== want) throw new Error(`got ${got}, want ${want}`);
  });
}

// ── legacy paths point to OLD location, not new ────────────────
check("legacyModelFallbackCanaryPath points to old ~/.pi-extensions/", () => {
  const home = "/fake-home";
  const got = r.legacyModelFallbackCanaryPath(home);
  const want = path.join(home, ".pi-extensions", "model-fallback.log");
  if (got !== want) throw new Error(`got ${got}, want ${want}`);
  // Sanity: must NOT be inside .pi-astack
  if (got.includes(".pi-astack")) throw new Error("legacy path leaked into .pi-astack");
});

check("legacySedimentAuditPath stays inside .pensieve/.state (pre-pi-astack era)", () => {
  const got = r.legacySedimentAuditPath(projectRoot);
  if (!got.includes(".pensieve") || !got.includes(".state")) {
    throw new Error(`expected legacy .pensieve/.state path, got ${got}`);
  }
});

// ── e2e: replay model-fallback canaryLog logic against tmp root ──
check("model-fallback canaryLog writes to expected canonical file", () => {
  const fsLocal = require("node:fs");
  const dir = r.modelFallbackDir(projectRoot);
  const file = r.modelFallbackCanaryPath(projectRoot);
  fsLocal.mkdirSync(dir, { recursive: true });
  fsLocal.appendFileSync(file, "test-line-1\n");
  fsLocal.appendFileSync(file, "test-line-2\n");
  if (!fsLocal.existsSync(file)) throw new Error("canary.log not created");
  const content = fsLocal.readFileSync(file, "utf-8");
  if (!content.includes("test-line-1") || !content.includes("test-line-2")) {
    throw new Error(`content missing: ${content}`);
  }
  // The file must be inside .pi-astack/model-fallback/, not anywhere else
  if (!file.includes(path.join(".pi-astack", "model-fallback"))) {
    throw new Error(`file outside expected dir: ${file}`);
  }
});

// ── no per-module helper accidentally points outside .pi-astack ──
check("all per-module dir helpers stay inside .pi-astack/", () => {
  const dirHelpers = [
    r.sedimentDir,
    r.memoryDir,
    r.compactionTunerDir,
    r.modelFallbackDir,
  ];
  for (const fn of dirHelpers) {
    const got = fn(projectRoot);
    const want = path.join(projectRoot, ".pi-astack");
    if (!got.startsWith(want + path.sep)) {
      throw new Error(`${fn.name || "helper"} returned ${got} which escapes ${want}`);
    }
  }
});

// ── ensureProjectGitignoredOnce (R9 P0 sonnet R9-5) ─────────────
// audit/log writers MUST auto-append `.pi-astack/` to project
// .gitignore so accidental `git add .` doesn't stage audit.jsonl
// (which contains LLM raw response that may echo secrets).
check("ensureProjectGitignoredOnce: skip when not a git repo", async () => {
  const noGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-nogit-"));
  try {
    const result = await r.ensureProjectGitignoredOnce(noGitRoot);
    if (result.added !== false || result.reason !== "not_a_git_repo") {
      throw new Error(`should skip non-git repo, got: ${JSON.stringify(result)}`);
    }
    if (fs.existsSync(path.join(noGitRoot, ".gitignore"))) {
      throw new Error(`should NOT create .gitignore in non-git repo`);
    }
  } finally {
    fs.rmSync(noGitRoot, { recursive: true, force: true });
  }
});

check("ensureProjectGitignoredOnce: append when git repo without .gitignore", async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-git-"));
  try {
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    const result = await r.ensureProjectGitignoredOnce(gitRoot);
    if (result.added !== true) throw new Error(`should add, got: ${JSON.stringify(result)}`);
    const content = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
    if (!content.includes(".pi-astack/")) throw new Error(`gitignore should include .pi-astack/, got:\n${content}`);
    if (!content.includes("# pi-astack runtime state")) throw new Error(`gitignore should include header comment, got:\n${content}`);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

check("ensureProjectGitignoredOnce: append when .gitignore exists without entry", async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-existing-"));
  try {
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(gitRoot, ".gitignore"), "node_modules/\nbuild/\n");
    const result = await r.ensureProjectGitignoredOnce(gitRoot);
    if (result.added !== true) throw new Error(`should add, got: ${JSON.stringify(result)}`);
    const content = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
    if (!content.includes("node_modules/")) throw new Error(`pre-existing entries lost: ${content}`);
    if (!content.includes(".pi-astack/")) throw new Error(`new entry missing: ${content}`);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

check("ensureProjectGitignoredOnce: skip when entry already present (`.pi-astack/`)", async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-already-"));
  try {
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(gitRoot, ".gitignore"), "node_modules/\n.pi-astack/\n");
    const result = await r.ensureProjectGitignoredOnce(gitRoot);
    if (result.added !== false || result.reason !== "already_present") {
      throw new Error(`should not re-add, got: ${JSON.stringify(result)}`);
    }
    const content = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
    if (content.split(/\r?\n/).filter((l) => l.trim() === ".pi-astack/").length !== 1) {
      throw new Error(`should not duplicate entry, got:\n${content}`);
    }
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

check("ensureProjectGitignoredOnce: skip when entry already present (`.pi-astack` no slash)", async () => {
  // Test the equivalence: `.pi-astack` and `.pi-astack/` both ignore
  // the directory in git semantics. Helper must recognize both.
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-noslash-"));
  try {
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(gitRoot, ".gitignore"), ".pi-astack\n");
    const result = await r.ensureProjectGitignoredOnce(gitRoot);
    if (result.added !== false || result.reason !== "already_present") {
      throw new Error(`should treat .pi-astack (no slash) as equivalent, got: ${JSON.stringify(result)}`);
    }
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

check("ensureProjectGitignoredOnce: idempotent on repeat calls (per-process cache)", async () => {
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-paths-idem-"));
  try {
    fs.mkdirSync(path.join(gitRoot, ".git"), { recursive: true });
    const r1 = await r.ensureProjectGitignoredOnce(gitRoot);
    const r2 = await r.ensureProjectGitignoredOnce(gitRoot);
    if (r1.added !== true) throw new Error(`first call should add: ${JSON.stringify(r1)}`);
    if (r2.added !== false || r2.reason !== "cached") {
      throw new Error(`second call should be cached, got: ${JSON.stringify(r2)}`);
    }
    // Verify no double-append: only one .pi-astack/ entry
    const content = fs.readFileSync(path.join(gitRoot, ".gitignore"), "utf-8");
    const count = content.split(/\r?\n/).filter((l) => l.trim() === ".pi-astack/").length;
    if (count !== 1) throw new Error(`expected 1 entry, got ${count}:\n${content}`);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

// ── cleanup ────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
