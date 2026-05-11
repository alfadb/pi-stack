#!/usr/bin/env node
/**
 * Smoke test: ADR 0014 active-project resolver.
 *
 * Read-only: parses ~/.abrain/projects/_bindings.md, resolves cwd → project id
 * via git root → canonical remote → longest cwd prefix, and surfaces the
 * boot-time match kind. /secret and bash injection are NOT changed yet; this
 * smoke locks the resolver contract before later commits flip default scope.
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
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-active-project-"));
const compiled = path.join(tmpDir, "runtime.cjs");
fs.writeFileSync(compiled, transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")));
const runtime = require(compiled);

console.log("abrain — active project resolver");

const abrainHome = fs.mkdtempSync(path.join(tmpDir, "abrain-"));
fs.mkdirSync(path.join(abrainHome, "projects"), { recursive: true });
const bindingsPath = path.join(abrainHome, "projects", "_bindings.md");

function writeBindings(text) {
  fs.writeFileSync(bindingsPath, text);
}

function makeOpts({ existsSync, readFileSync, execFileSync } = {}) {
  return { abrainHome, existsSync, readFileSync, execFileSync };
}

function fakeExec(map) {
  return (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, value] of Object.entries(map)) {
      if (key.startsWith(pattern)) {
        if (value === null) throw new Error("ENOENT");
        return value;
      }
    }
    throw new Error(`unmocked exec: ${key}`);
  };
}

// ── path / id helpers ─────────────────────────────────────────
check("abrainProjectBindingsPath resolves under projects/_bindings.md", () => {
  const got = runtime.abrainProjectBindingsPath(abrainHome);
  const want = path.join(abrainHome, "projects", "_bindings.md");
  if (got !== want) throw new Error(`got ${got}, want ${want}`);
});

check("resolveBrainPaths returns project + vault paths", () => {
  const paths = runtime.resolveBrainPaths(abrainHome, "pi-astack");
  if (!paths.projectDir.endsWith(path.join("projects", "pi-astack"))) throw new Error(`bad projectDir: ${paths.projectDir}`);
  if (!paths.projectVaultDir.endsWith(path.join("projects", "pi-astack", "vault"))) throw new Error(`bad vault dir: ${paths.projectVaultDir}`);
});

check("validateAbrainProjectId rejects unsafe ids", () => {
  for (const bad of ["", "..", "../escape", ".hidden", "with/slash", "with\\slash", "spaces here", "weird*"]) {
    let threw = false;
    try { runtime.validateAbrainProjectId(bad); } catch { threw = true; }
    if (!threw) throw new Error(`expected reject for ${JSON.stringify(bad)}`);
  }
  runtime.validateAbrainProjectId("pi-astack");
  runtime.validateAbrainProjectId("work.uamp_full");
});

// ── canonical remote ──────────────────────────────────────────
check("canonicalizeGitRemote folds scp-like and https forms", () => {
  const target = "github.com/alfadb/pi-astack";
  const inputs = [
    "git@github.com:alfadb/pi-astack.git",
    "https://github.com/alfadb/pi-astack",
    "https://github.com/alfadb/pi-astack.git",
    "ssh://git@github.com/alfadb/pi-astack.git",
    "git+https://github.com/alfadb/pi-astack.git",
  ];
  for (const url of inputs) {
    const got = runtime.canonicalizeGitRemote(url);
    if (got !== target) throw new Error(`canonicalize(${url}) = ${got}, want ${target}`);
  }
  if (runtime.canonicalizeGitRemote("") !== null) throw new Error("empty must be null");
});

// ── parse bindings markdown ───────────────────────────────────
check("parseProjectBindingsMarkdown skips invalid entries", () => {
  const text = [
    "# header ignored",
    "- cwd: /a",
    "  project: alpha",
    "  bound_at: 2026-05-01",
    "- cwd: /b",
    "  project: ../escape",
    "- cwd:",
    "  project: gamma",
    "- cwd: /c",
    "  project: charlie",
    "  git_remote: 'git@github.com:alfadb/pi-astack.git'",
  ].join("\n");
  const bindings = runtime.parseProjectBindingsMarkdown(text);
  const ids = bindings.map((b) => b.project);
  if (!ids.includes("alpha") || !ids.includes("charlie")) throw new Error(`unexpected ids: ${ids.join(",")}`);
  if (ids.includes("../escape")) throw new Error("must drop traversal id");
  if (ids.includes("gamma")) throw new Error("must drop binding without cwd");
});

// ── resolution table ──────────────────────────────────────────
const projectsRoot = fs.mkdtempSync(path.join(tmpDir, "projects-"));
const alphaRoot = path.join(projectsRoot, "alpha");
const alphaSub = path.join(alphaRoot, "src/lib");
const betaRoot = path.join(projectsRoot, "beta");
const orphanRoot = path.join(projectsRoot, "orphan");
fs.mkdirSync(alphaSub, { recursive: true });
fs.mkdirSync(betaRoot, { recursive: true });
fs.mkdirSync(orphanRoot, { recursive: true });

function withBindings(rows) {
  const lines = rows.map((r) => {
    const block = [`- cwd: ${r.cwd}`, `  project: ${r.project}`];
    if (r.gitRemote) block.push(`  git_remote: '${r.gitRemote}'`);
    if (r.boundAt) block.push(`  bound_at: ${r.boundAt}`);
    return block.join("\n");
  });
  writeBindings(lines.join("\n") + "\n");
}

check("returns bindings_missing when _bindings.md does not exist", () => {
  fs.rmSync(bindingsPath, { force: true });
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts());
  if (r.activeProject || r.reason !== "bindings_missing") throw new Error(JSON.stringify(r));
});

check("returns bindings_empty when file exists but has no bindings", () => {
  writeBindings("# only a header\n");
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts());
  if (r.activeProject || r.reason !== "bindings_empty") throw new Error(JSON.stringify(r));
});

check("returns unbound when no binding matches", () => {
  withBindings([{ cwd: betaRoot, project: "beta" }]);
  const r = runtime.resolveActiveProject(orphanRoot, makeOpts({
    execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }),
  }));
  if (r.activeProject || r.reason !== "unbound") throw new Error(JSON.stringify(r));
});

check("git_root_exact wins over cwd prefix", () => {
  withBindings([
    { cwd: alphaRoot, project: "alpha", gitRemote: "git@github.com:alfadb/alpha.git" },
    { cwd: projectsRoot, project: "monorepo" },
  ]);
  const exec = fakeExec({
    [`git rev-parse --show-toplevel`]: `${alphaRoot}\n`,
    [`git config --get remote.origin.url`]: `git@github.com:alfadb/alpha.git\n`,
  });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (!r.activeProject) throw new Error("expected match");
  if (r.activeProject.matchedBy !== "git_root_exact") throw new Error(`matchedBy=${r.activeProject.matchedBy}`);
  if (r.activeProject.projectId !== "alpha") throw new Error(`projectId=${r.activeProject.projectId}`);
  if (r.activeProject.gitRoot !== alphaRoot) throw new Error(`gitRoot=${r.activeProject.gitRoot}`);
});

check("git_remote canonicalization matches different URL forms", () => {
  withBindings([
    { cwd: "/elsewhere/alpha", project: "alpha-mirror", gitRemote: "https://github.com/alfadb/alpha" },
  ]);
  const exec = fakeExec({
    [`git rev-parse --show-toplevel`]: `${alphaRoot}\n`,
    [`git config --get remote.origin.url`]: `git@github.com:alfadb/alpha.git\n`,
  });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (!r.activeProject || r.activeProject.matchedBy !== "git_remote") throw new Error(JSON.stringify(r));
  if (r.activeProject.projectId !== "alpha-mirror") throw new Error(`projectId=${r.activeProject.projectId}`);
});

check("longest cwd prefix wins when no git data is available", () => {
  withBindings([
    { cwd: projectsRoot, project: "outer" },
    { cwd: alphaRoot, project: "alpha" },
  ]);
  const exec = fakeExec({ [`git rev-parse --show-toplevel`]: null });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (!r.activeProject || r.activeProject.matchedBy !== "cwd_prefix") throw new Error(JSON.stringify(r));
  if (r.activeProject.projectId !== "alpha") throw new Error(`projectId=${r.activeProject.projectId}`);
});

check("ambiguous remote returns ambiguous_remote and does not pick a project", () => {
  withBindings([
    { cwd: "/x/one", project: "one", gitRemote: "git@github.com:org/repo.git" },
    { cwd: "/x/two", project: "two", gitRemote: "https://github.com/org/repo" },
  ]);
  const exec = fakeExec({
    [`git rev-parse --show-toplevel`]: `${alphaRoot}\n`,
    [`git config --get remote.origin.url`]: `git@github.com:org/repo.git\n`,
  });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (r.activeProject || r.reason !== "ambiguous_remote") throw new Error(JSON.stringify(r));
});

check("ambiguous cwd prefix returns ambiguous_prefix", () => {
  withBindings([
    { cwd: projectsRoot, project: "one" },
    { cwd: projectsRoot, project: "two" },
  ]);
  const exec = fakeExec({ [`git rev-parse --show-toplevel`]: null });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (r.activeProject || r.reason !== "ambiguous_prefix") throw new Error(JSON.stringify(r));
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`all ok — active-project resolver holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
