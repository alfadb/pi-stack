#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0a — backend detection + sub-pi activate guard.
 *
 * Covers:
 *   1. detectBackend() — five priority paths from vault-bootstrap.md §1
 *      (env-override / macos / secret-service / pass / gpg-file / disabled)
 *   2. $SECRETS_BACKEND override behavior (valid vs garbage)
 *   3. formatStatus() — does not crash on any backend shape
 *   4. activate() — when PI_ABRAIN_DISABLED=1, registers ZERO commands
 *      (this is ADR 0014 invariant #6 layer 2 in the runtime)
 *
 * Strategy: transpile the live TS sources and inject mocked deps.
 * No real subprocess spawns, no real fs reads. Same harness pattern
 * as smoke-dispatch-input-compat.
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
function check(name, fn) {
  try {
    fn();
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

// ── Load backend-detect.ts (no relative deps, easy) ─────────────
const detectSrc = path.join(repoRoot, "extensions/abrain/backend-detect.ts");
const detectCompiled = transpileTsToCjs(detectSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-abrain-"));
const detectModule = loadModuleFromString(
  detectCompiled,
  path.join(tmpDir, "backend-detect.cjs"),
);
const { detectBackend, formatStatus } = detectModule;

console.log("abrain P0a — backend detection");

// ── Helper: build a deps object with sensible defaults ──────────
function deps(overrides = {}) {
  const base = {
    commandExists: () => false,
    fileExists: () => false,
    platform: "linux",
    home: "/home/test",
    env: {},
  };
  return { ...base, ...overrides, env: { ...base.env, ...(overrides.env || {}) } };
}

// ── 1. detectBackend priority chain ─────────────────────────────

check("macOS → backend=macos with autoUnlock=true", () => {
  const info = detectBackend(deps({ platform: "darwin" }));
  if (info.backend !== "macos") throw new Error(`expected macos, got ${info.backend}`);
  if (!info.capabilities.autoUnlock) throw new Error("macOS should report autoUnlock=true");
});

check("Linux + DISPLAY + secret-tool → backend=secret-service", () => {
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("DISPLAY")) throw new Error("reason should cite DISPLAY");
});

check("Linux + WAYLAND_DISPLAY + secret-tool → backend=secret-service (cites WAYLAND)", () => {
  const info = detectBackend(deps({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("WAYLAND_DISPLAY")) throw new Error("reason should cite WAYLAND_DISPLAY when present");
});

check("Linux desktop but no secret-tool → falls through (NOT secret-service)", () => {
  // Crucial: $DISPLAY alone without the CLI must not select secret-service —
  // we can't actually call the backend without secret-tool.
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: () => false,
    fileExists: () => false,
  }));
  if (info.backend === "secret-service") {
    throw new Error("must not select secret-service without secret-tool on PATH");
  }
});

check("Linux + pass + ~/.password-store/abrain → backend=pass", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: (p) => p === "/home/test/.password-store/abrain",
  }));
  if (info.backend !== "pass") throw new Error(`expected pass, got ${info.backend}`);
  if (info.capabilities.autoUnlock) throw new Error("pass should report autoUnlock=false");
});

check("Linux + pass cmd but NO password-store dir → falls through", () => {
  // Both conditions are required for pass selection — otherwise the
  // user has pass installed but hasn't set up abrain in it.
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: () => false,
  }));
  if (info.backend === "pass") throw new Error("must not select pass without ~/.password-store/abrain/");
});

check("Linux + ~/.abrain/.vault-master.age → backend=gpg-file", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.abrain/.vault-master.age",
  }));
  if (info.backend !== "gpg-file") throw new Error(`expected gpg-file, got ${info.backend}`);
});

check("Linux headless (no DISPLAY, no pass, no gpg-file) → backend=disabled", () => {
  const info = detectBackend(deps({}));
  if (info.backend !== "disabled") throw new Error(`expected disabled, got ${info.backend}`);
  if (!info.reason.includes("no Linux desktop session")) {
    throw new Error(`reason missing 'no Linux desktop session': ${info.reason}`);
  }
});

// ── 2. $SECRETS_BACKEND env override ────────────────────────────

check("$SECRETS_BACKEND=macos forces macos even on Linux", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "macos" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override, got ${info.backend}`);
  if (info.overrideTarget !== "macos") throw new Error(`expected overrideTarget=macos, got ${info.overrideTarget}`);
});

check("$SECRETS_BACKEND=disabled forces disabled (no overrideTarget)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "disabled" }, platform: "darwin" }));
  if (info.backend !== "env-override") throw new Error(`expected env-override, got ${info.backend}`);
  if (info.overrideTarget !== undefined) throw new Error(`disabled override should have no overrideTarget`);
});

check("$SECRETS_BACKEND=garbage falls through to auto-detect (not silently honored)", () => {
  // Critical security property: invalid override must NOT silently disable
  // the backend (the user might have typo'd 'macos'). Falls through.
  const info = detectBackend(deps({
    env: { SECRETS_BACKEND: "totally-fake-backend" },
    platform: "darwin",
  }));
  if (info.backend !== "macos") throw new Error(`garbage override should fall through to auto-detect; got ${info.backend}`);
});

check("$SECRETS_BACKEND=MACOS (uppercase) is honored (case-insensitive)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "MACOS" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override, got ${info.backend}`);
});

// ── 3. formatStatus does not crash on any shape ─────────────────

check("formatStatus(disabled, false) renders without crash", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false);
  if (typeof out !== "string" || out.length === 0) throw new Error("expected non-empty string");
  if (!out.includes("locked")) throw new Error("disabled status should mention 'locked'");
});

check("formatStatus(macos, false) mentions backend + auto-unlock=yes", () => {
  const info = detectBackend(deps({ platform: "darwin" }));
  const out = formatStatus(info, false);
  if (!out.includes("macos")) throw new Error("output missing 'macos'");
  if (!out.includes("auto-unlock: yes")) throw new Error("output missing auto-unlock yes");
});

check("formatStatus(any, vaultDisabledFlag=true) shows user-disabled state", () => {
  const info = detectBackend(deps({ platform: "darwin" }));
  const out = formatStatus(info, true);
  if (!out.includes("disabled")) throw new Error("output missing 'disabled' for user-flag");
  if (!out.includes("vault-disabled")) throw new Error("output missing path hint to remove flag");
});

// ── 4. activate() respects PI_ABRAIN_DISABLED=1 ────────────────────
//
// We load index.ts but it imports backend-detect, so we need to tell
// require() how to resolve that relative import. Easier: write the
// transpiled backend-detect.cjs to disk under a known name, then
// transpile index.ts into the SAME directory with adjusted import path.

const detectFile = path.join(tmpDir, "backend-detect.cjs");
fs.writeFileSync(detectFile, detectCompiled);

const indexSrc = path.join(repoRoot, "extensions/abrain/index.ts");
let indexCompiled = transpileTsToCjs(indexSrc);
// rewrite "./backend-detect" → "./backend-detect.cjs" so CJS resolver finds it
indexCompiled = indexCompiled.replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")');
// drop the @earendil-works/pi-coding-agent require — it's only used as a type
// import, but ts.transpileModule (without checker) keeps it. The ExtensionAPI
// import is type-only at the source level, so the emitted require should
// be already gone for type-only imports — verify by seeing if it survives:
//   `import type { ExtensionAPI } ...` → no emit. We use that form, so OK.

const indexFile = path.join(tmpDir, "index.cjs");
fs.writeFileSync(indexFile, indexCompiled);
const indexModule = require(indexFile);
const activate = indexModule.default;

check("activate is a function (default export)", () => {
  if (typeof activate !== "function") throw new Error(`expected function, got ${typeof activate}`);
});

check("PI_ABRAIN_DISABLED=1 → activate registers ZERO commands", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  try {
    let registerCalls = 0;
    const fakePi = {
      registerCommand: () => { registerCalls += 1; },
    };
    activate(fakePi);
    if (registerCalls !== 0) {
      throw new Error(`sub-pi guard breached: registerCommand called ${registerCalls} time(s)`);
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED unset → activate registers /vault command", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    const registered = [];
    const fakePi = {
      registerCommand: (name, _opts) => { registered.push(name); },
    };
    activate(fakePi);
    if (!registered.includes("vault")) {
      throw new Error(`expected /vault to be registered, got: ${registered.join(", ")}`);
    }
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED=0 (explicitly off) → activate DOES register", () => {
  // Edge case: only the literal string "1" disables. "0" / "false" / "" do not.
  // This matches dispatch's spawn override semantics (which sets "1").
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "0";
  try {
    let registerCalls = 0;
    const fakePi = { registerCommand: () => { registerCalls += 1; } };
    activate(fakePi);
    if (registerCalls === 0) {
      throw new Error("PI_ABRAIN_DISABLED=0 should NOT disable abrain (only '1' does)");
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("activate handles missing registerCommand gracefully", () => {
  // Some pi versions may not have registerCommand. We must not crash.
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    activate({}); // no registerCommand at all — should be no-op, not throw
  } catch (err) {
    throw new Error(`activate threw on missing registerCommand: ${err.message}`);
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

// ── Done ────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain P0a backend detection + sub-pi guard hold (${22 - failures.length} assertions of 22).`);
} else {
  console.log(`FAIL — ${failures.length} of 22 assertions failed.`);
  process.exit(1);
}
