#!/usr/bin/env node
/**
 * Smoke test: ADR 0014 P1 step 2 — /secret default scope is the boot-time
 * active project. Pure flag-parsing + scope-resolution coverage; the live
 * write/list/forget paths are still covered by smoke-abrain-vault-writer.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-secret-scope-"));
const sharedTarget = path.join(tmpDir, "_shared");
fs.mkdirSync(sharedTarget, { recursive: true });
fs.writeFileSync(path.join(sharedTarget, "runtime.cjs"), transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")));
fs.copyFileSync(path.join(sharedTarget, "runtime.cjs"), path.join(sharedTarget, "runtime.js"));

for (const file of ["vault-writer", "vault-reader", "vault-bash", "keychain", "bootstrap", "backend-detect"]) {
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), transpile(path.join(repoRoot, "extensions/abrain", `${file}.ts`)));
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}

let indexSrc = fs.readFileSync(path.join(repoRoot, "extensions/abrain/index.ts"), "utf8");
const indexCjs = ts.transpileModule(indexSrc, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  },
}).outputText
  .replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")')
  .replace(/require\("\.\/bootstrap"\)/g, 'require("./bootstrap.cjs")')
  .replace(/require\("\.\/keychain"\)/g, 'require("./keychain.cjs")')
  .replace(/require\("\.\/vault-writer"\)/g, 'require("./vault-writer.cjs")')
  .replace(/require\("\.\/vault-reader"\)/g, 'require("./vault-reader.cjs")')
  .replace(/require\("\.\/vault-bash"\)/g, 'require("./vault-bash.cjs")')
  .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")');
fs.writeFileSync(path.join(tmpDir, "index.cjs"), indexCjs);

const indexModule = require(path.join(tmpDir, "index.cjs"));

console.log("abrain — /secret scope parsing");

check("parseSecretScopeFlags: default scope when no flags", () => {
  const r = indexModule.parseSecretScopeFlags(["token=abc"]);
  if (r.scope !== "default") throw new Error(`scope=${JSON.stringify(r.scope)}`);
  if (r.positional.join(",") !== "token=abc") throw new Error(`positional=${r.positional}`);
  if (r.errors.length) throw new Error(`unexpected errors: ${r.errors}`);
});

check("parseSecretScopeFlags: --global wins as global scope", () => {
  const r = indexModule.parseSecretScopeFlags(["--global", "token=abc"]);
  if (r.scope !== "global") throw new Error(`scope=${JSON.stringify(r.scope)}`);
});

check("parseSecretScopeFlags: --project=<id> yields project scope", () => {
  const r = indexModule.parseSecretScopeFlags(["--project=pi-astack", "token=abc"]);
  if (typeof r.scope !== "object" || r.scope.project !== "pi-astack") throw new Error(`scope=${JSON.stringify(r.scope)}`);
});

check("parseSecretScopeFlags: rejects invalid --project=<id>", () => {
  const r = indexModule.parseSecretScopeFlags(["--project=../escape", "token=abc"]);
  if (r.errors.length === 0) throw new Error("expected error");
});

check("parseSecretScopeFlags: --global + --project=<id> mutually exclusive", () => {
  const r = indexModule.parseSecretScopeFlags(["--global", "--project=alpha", "token=abc"]);
  if (!r.errors.some((e) => e.includes("mutually exclusive"))) throw new Error(`errors=${r.errors}`);
});

check("parseSecretScopeFlags: --all-projects flag captured", () => {
  const r = indexModule.parseSecretScopeFlags(["--all-projects"]);
  if (!r.allProjects) throw new Error("allProjects flag not set");
});

check("parseSecretScopeFlags: --all-projects + scope flag error", () => {
  const r = indexModule.parseSecretScopeFlags(["--all-projects", "--global"]);
  if (!r.errors.some((e) => e.includes("--all-projects"))) throw new Error(`errors=${r.errors}`);
});

check("parseSecretScopeFlags: unknown flag captured as error", () => {
  const r = indexModule.parseSecretScopeFlags(["--what"]);
  if (!r.errors.some((e) => e.includes("unknown flag"))) throw new Error(`errors=${r.errors}`);
});

check("resolveSecretScope: --global passes through", () => {
  const out = indexModule.resolveSecretScope("global", null);
  if (!out.ok || out.scope !== "global") throw new Error(JSON.stringify(out));
});

check("resolveSecretScope: --project=<id> passes through without active project", () => {
  const out = indexModule.resolveSecretScope({ project: "explicit" }, null);
  if (!out.ok || out.scope.project !== "explicit") throw new Error(JSON.stringify(out));
});

check("resolveSecretScope: default with no active project surfaces reason", () => {
  const out = indexModule.resolveSecretScope("default", null);
  if (out.ok) throw new Error("expected refusal");
  if (!out.reason.includes("no active project")) throw new Error(`reason=${out.reason}`);
});

check("resolveSecretScope: default + unbound reason carries actionable hint", () => {
  const stub = { activeProject: null, reason: "unbound", cwd: "/x", bindingsPath: "/y" };
  const out = indexModule.resolveSecretScope("default", stub);
  if (out.ok) throw new Error("expected refusal");
  if (!out.reason.includes("not bound to any project")) throw new Error(`reason=${out.reason}`);
});

check("resolveSecretScope: default + active project routes to that project", () => {
  const stub = { activeProject: { projectId: "alpha", binding: { cwd: "/x", project: "alpha", raw: {} }, matchedBy: "git_root_exact", cwd: "/x", lookupCwd: "/x", bindingsPath: "/y" } };
  const out = indexModule.resolveSecretScope("default", stub);
  if (!out.ok) throw new Error("expected ok");
  if (out.scope.project !== "alpha") throw new Error(`scope=${JSON.stringify(out.scope)}`);
});

check("secretDefaultRejection covers ambiguous_remote / ambiguous_prefix paths", () => {
  const remote = indexModule.secretDefaultRejection("ambiguous_remote");
  if (!remote.includes("multiple bindings share this git remote")) throw new Error(remote);
  const prefix = indexModule.secretDefaultRejection("ambiguous_prefix");
  if (!prefix.includes("multiple bindings share this cwd prefix")) throw new Error(prefix);
});

check("boot-time snapshot helpers expose getter+reset", () => {
  if (typeof indexModule.getBootActiveProject !== "function") throw new Error("getBootActiveProject missing");
  if (typeof indexModule.getBootActiveProjectSnapshotAt !== "function") throw new Error("getBootActiveProjectSnapshotAt missing");
  if (typeof indexModule.__resetBootActiveProjectForTests !== "function") throw new Error("reset helper missing");
});

check("__resetBootActiveProjectForTests round-trips an active project value", () => {
  const stub = { activeProject: { projectId: "alpha", binding: { cwd: "/x", project: "alpha", raw: {} }, matchedBy: "git_root_exact", cwd: "/x", lookupCwd: "/x", bindingsPath: "/y" } };
  indexModule.__resetBootActiveProjectForTests(stub);
  if (indexModule.getBootActiveProject() !== stub) throw new Error("snapshot not stored");
  if (typeof indexModule.getBootActiveProjectSnapshotAt() !== "number") throw new Error("snapshot timestamp missing");
  indexModule.__resetBootActiveProjectForTests(null);
  if (indexModule.getBootActiveProject() !== null) throw new Error("reset to null failed");
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`all ok — /secret scope parsing holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
