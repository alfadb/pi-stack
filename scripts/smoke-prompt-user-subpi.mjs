#!/usr/bin/env node
/**
 * Smoke test: prompt_user sub-pi isolation (ADR 0022 INV-A layer 3).
 *
 * Sub-pi guard is enforced at THREE layers:
 *
 *   Layer 1: dispatch sets `PI_ABRAIN_DISABLED=1` when spawning sub-pi
 *            (existing guarantee from ADR 0014 §6; covered by
 *            smoke-vault-subpi-isolation.mjs).
 *
 *   Layer 2: abrain/index.ts activate() early-return on
 *            `PI_ABRAIN_DISABLED=1`, so NO tool is registered at all.
 *            (covered by smoke-abrain-backend-detect §sub-pi).
 *
 *   Layer 3: handler.executePromptUserTool() FIRST line refuses with
 *            `subagent-blocked` if the env is set. Defense in depth.
 *            ← this smoke verifies layer 3.
 *
 * Also verifies the audit lane records `prompt_user_blocked` with
 * `reason: "subagent"` so post-hoc analysis can see attempts.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    await fn();
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-prompt-user-subpi-"));
const promptUserDir = path.join(tmpDir, "prompt-user");
fs.mkdirSync(path.join(promptUserDir, "ui"), { recursive: true });
fs.writeFileSync(path.join(tmpDir, "redact.cjs"), transpile(path.join(repoRoot, "extensions/abrain/redact.ts")));
fs.writeFileSync(path.join(tmpDir, "redact.js"), `module.exports = require("./redact.cjs");\n`);
for (const m of ["types", "schema", "manager", "service", "handler"]) {
  const cjs = path.join(promptUserDir, `${m}.cjs`);
  fs.writeFileSync(cjs, transpile(path.join(repoRoot, "extensions/abrain/prompt-user", `${m}.ts`)));
  fs.copyFileSync(cjs, path.join(promptUserDir, `${m}.js`));
  // Rewrite ../redact since CJS resolver won't find redact.js parent without
  // help (we have .js but the runtime cache may have loaded .cjs first).
  let src = fs.readFileSync(cjs, "utf8");
  src = src.replace(/require\(["']\.\.\/redact["']\)/g, 'require("../redact.cjs")');
  fs.writeFileSync(cjs, src);
}
fs.writeFileSync(
  path.join(promptUserDir, "ui", "PromptDialog.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/prompt-user/ui/PromptDialog.ts")),
);
fs.copyFileSync(
  path.join(promptUserDir, "ui", "PromptDialog.cjs"),
  path.join(promptUserDir, "ui", "PromptDialog.js"),
);

console.log(`Smoke: prompt_user sub-pi isolation (ADR 0022 INV-A layer 3)`);
console.log(`tmpDir=${tmpDir}\n`);

const handlerMod = require(path.join(promptUserDir, "handler"));
const manager = require(path.join(promptUserDir, "manager"));

// Per-test audit recorder.
const blocked = [];
const askEvents = [];
const resultEvents = [];
const deps = {
  dialog: { buildDialog: () => { throw new Error("dialog should not be invoked in sub-pi mode"); } },
  audit: {
    recordAsk: (ev) => askEvents.push(ev),
    recordResult: (ev) => resultEvents.push(ev),
  },
  recordBlocked: (ev) => blocked.push(ev),
};

async function withEnv(value, fn) {
  const prev = process.env.PI_ABRAIN_DISABLED;
  if (value === undefined) delete process.env.PI_ABRAIN_DISABLED;
  else process.env.PI_ABRAIN_DISABLED = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
}

// ── 1. Sub-pi env reject path (INV-A layer 3) ─────────────────────

const validParams = {
  reason: "test sub-pi guard",
  questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
};

await asyncCheck("PI_ABRAIN_DISABLED=1 → reason: subagent-blocked", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  await withEnv("1", async () => {
    const json = await handlerMod.executePromptUserTool(
      validParams, undefined, { ui: {}, hasUI: true }, deps,
    );
    const r = JSON.parse(json);
    if (r.ok) throw new Error("expected reject");
    if (r.reason !== "subagent-blocked") throw new Error(`reason=${r.reason}`);
    if (!r.detail?.includes("sub-pi")) throw new Error(`detail=${r.detail}`);
  });
});

await asyncCheck("PI_ABRAIN_DISABLED=1 → recordBlocked(subagent) called exactly once", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  await withEnv("1", async () => {
    await handlerMod.executePromptUserTool(validParams, undefined, { ui: {}, hasUI: true }, deps);
  });
  const subagentRows = blocked.filter((b) => b.reason === "subagent");
  if (subagentRows.length !== 1) throw new Error(`recordBlocked(subagent) count=${subagentRows.length}`);
});

await asyncCheck("PI_ABRAIN_DISABLED=1 → handler does NOT touch dialog buildDialog", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  // deps.dialog.buildDialog throws if invoked. The handler's sub-pi
  // reject path must NOT reach buildDialog — if it does, we get a
  // throw upstream of the JSON-stringify and the smoke explodes.
  await withEnv("1", async () => {
    const json = await handlerMod.executePromptUserTool(
      validParams, undefined, { ui: {}, hasUI: true }, deps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "subagent-blocked") throw new Error(`reason=${r.reason}`);
  });
});

await asyncCheck("PI_ABRAIN_DISABLED=1 → no pending-prompt slot acquired", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  await withEnv("1", async () => {
    await handlerMod.executePromptUserTool(validParams, undefined, { ui: {}, hasUI: true }, deps);
  });
  if (manager.getPendingPromptCount() !== 0) {
    throw new Error(`subagent reject leaked a pending slot, count=${manager.getPendingPromptCount()}`);
  }
});

await asyncCheck("PI_ABRAIN_DISABLED=1 → askEvents / resultEvents NOT recorded", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  askEvents.length = 0;
  resultEvents.length = 0;
  await withEnv("1", async () => {
    await handlerMod.executePromptUserTool(validParams, undefined, { ui: {}, hasUI: true }, deps);
  });
  if (askEvents.length !== 0) throw new Error(`askEvents leaked: ${askEvents.length}`);
  if (resultEvents.length !== 0) throw new Error(`resultEvents leaked: ${resultEvents.length}`);
});

// ── 2. Only literal "1" disables (matches abrain index.ts contract) ──

await asyncCheck("PI_ABRAIN_DISABLED='0' → handler does NOT block (only literal '1' disables)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  await withEnv("0", async () => {
    // hasUI:false will produce ui-unavailable, not subagent-blocked.
    const json = await handlerMod.executePromptUserTool(
      validParams, undefined, { ui: {}, hasUI: false }, deps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "ui-unavailable") throw new Error(`reason=${r.reason} (expected ui-unavailable, NOT subagent-blocked)`);
  });
});

await asyncCheck("PI_ABRAIN_DISABLED='true' → handler does NOT block (truthy string isn't literal '1')", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  await withEnv("true", async () => {
    const json = await handlerMod.executePromptUserTool(
      validParams, undefined, { ui: {}, hasUI: false }, deps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "ui-unavailable") throw new Error(`reason=${r.reason}`);
  });
});

await asyncCheck("PI_ABRAIN_DISABLED unset → handler does NOT block", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  await withEnv(undefined, async () => {
    const json = await handlerMod.executePromptUserTool(
      validParams, undefined, { ui: {}, hasUI: false }, deps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "ui-unavailable") throw new Error(`reason=${r.reason}`);
  });
});

// ── 3. Sub-pi reject is FIRST priority (precedes schema-invalid) ──

await asyncCheck("Sub-pi guard runs BEFORE schema validation (sub-pi wins over bad params)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  blocked.length = 0;
  await withEnv("1", async () => {
    // Pass deliberately invalid params; handler should STILL return
    // subagent-blocked rather than schema-invalid, because layer 3
    // runs first.
    const json = await handlerMod.executePromptUserTool(
      { totally: "wrong" }, undefined, { ui: {}, hasUI: true }, deps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "subagent-blocked") {
      throw new Error(`expected subagent-blocked priority, got ${r.reason}`);
    }
  });
});

// ── Summary ───────────────────────────────────────────────────────

console.log("");
console.log(`Total: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  - ${name}\n    ${err.stack || err.message}`);
  }
  process.exit(1);
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(0);
