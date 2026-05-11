#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0a — backend detection + sub-pi activate guard.
 *
 * v1.4 priority chain (vault-bootstrap.md §1.4):
 *
 *   1. $SECRETS_BACKEND env override
 *   2. ssh-key  (Tier 1 primary)
 *   3. gpg-file (Tier 1 primary)
 *   4. macos    (Tier 2 optimization)
 *   5. secret-service (Tier 2)
 *   6. pass     (Tier 2)
 *   7. passphrase-only (Tier 1 fallback — almost always selected if 2-6 fail)
 *   8. disabled (only via $SECRETS_BACKEND=disabled or ~/.abrain/.state/vault-disabled flag)
 *
 * Container scenario (alfadb main): ssh-key wins via path #2.
 *
 * Strategy: transpile the live TS sources and inject mocked deps.
 * No real subprocess spawns, no real fs reads.
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
function check(name, fn) {
  totalChecks++;
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

const detectSrc = path.join(repoRoot, "extensions/abrain/backend-detect.ts");
const detectCompiled = transpileTsToCjs(detectSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-abrain-"));
const detectModule = loadModuleFromString(
  detectCompiled,
  path.join(tmpDir, "backend-detect.cjs"),
);
const { detectBackend, formatStatus } = detectModule;

console.log("abrain P0a — v1.4 backend detection (portable identity primary)");

// ── Helper: build a deps object with sensible defaults ──────────
// Default = "headless container with nothing" → should select passphrase-only
// in v1.4 (no ssh-key, no gpg, no desktop, no pass).
function deps(overrides = {}) {
  const base = {
    commandExists: () => false,
    fileExists: () => false,
    platform: "linux",
    home: "/home/test",
    env: {},
    gpgFirstSecretKey: () => null,
  };
  return { ...base, ...overrides, env: { ...base.env, ...(overrides.env || {}) } };
}

// ── 1. Tier 1 primary: ssh-key (the alfadb main scenario) ───────

check("ssh-key (ed25519): both id_ed25519 + .pub exist → backend=ssh-key", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.ssh/id_ed25519" || p === "/home/test/.ssh/id_ed25519.pub",
  }));
  if (info.backend !== "ssh-key") throw new Error(`expected ssh-key, got ${info.backend}`);
  if (info.identity !== "/home/test/.ssh/id_ed25519") throw new Error(`expected identity=id_ed25519, got ${info.identity}`);
  if (!info.capabilities.autoUnlock) throw new Error("ssh-key should report autoUnlock=true (ssh-agent cache)");
  if (!info.reason.includes("ed25519")) throw new Error("reason should cite ed25519");
});

check("ssh-key (rsa fallback): only id_rsa exists → backend=ssh-key with rsa identity", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.ssh/id_rsa" || p === "/home/test/.ssh/id_rsa.pub",
  }));
  if (info.backend !== "ssh-key") throw new Error(`expected ssh-key, got ${info.backend}`);
  if (info.identity !== "/home/test/.ssh/id_rsa") throw new Error(`expected identity=id_rsa, got ${info.identity}`);
  if (!info.reason.includes("rsa")) throw new Error("reason should cite rsa");
});

check("ssh-key: ed25519 takes priority over rsa when both exist", () => {
  const info = detectBackend(deps({
    fileExists: () => true, // both ed25519 and rsa "exist"
  }));
  if (info.identity !== "/home/test/.ssh/id_ed25519") throw new Error(`ed25519 should win; got ${info.identity}`);
});

check("ssh-key: secret without .pub → falls through (age needs .pub to encrypt)", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.ssh/id_ed25519", // no .pub
  }));
  if (info.backend === "ssh-key") throw new Error("must require BOTH secret and pub");
});

check("ssh-key: .pub without secret → falls through (no decrypt path)", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p === "/home/test/.ssh/id_ed25519.pub", // no secret
  }));
  if (info.backend === "ssh-key") throw new Error("must require BOTH pub and secret");
});

// ── 2. Tier 1 primary: gpg-file ─────────────────────────────────

check("gpg-file: gpg cmd + secret key in keyring → backend=gpg-file", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "gpg",
    gpgFirstSecretKey: () => "ABCD1234EF567890",
  }));
  if (info.backend !== "gpg-file") throw new Error(`expected gpg-file, got ${info.backend}`);
  if (info.gpgRecipient !== "ABCD1234EF567890") throw new Error(`expected recipient ABCD..., got ${info.gpgRecipient}`);
  if (!info.capabilities.autoUnlock) throw new Error("gpg-file should report autoUnlock=true (gpg-agent cache)");
});

check("gpg-file: gpg cmd but empty keyring → falls through to passphrase-only", () => {
  // The v1.3 bug: "user has gpg installed" was conflated with "user has GPG identity".
  // v1.4 splits these.
  const info = detectBackend(deps({
    commandExists: (c) => c === "gpg",
    gpgFirstSecretKey: () => null, // no secret keys
  }));
  if (info.backend === "gpg-file") throw new Error("gpg without secret keys should NOT select gpg-file");
  if (info.backend !== "passphrase-only") throw new Error(`expected fallback to passphrase-only, got ${info.backend}`);
});

// ── 3. Priority: ssh-key beats gpg-file (Tier 1 ordering) ───────

check("priority: ssh-key + gpg both available → ssh-key wins (alfadb container)", () => {
  // This is the realistic alfadb container scenario: user has ssh key for git
  // push AND has gpg installed for commit signing. ssh-key wins because it's
  // friendlier in the container (ssh-agent already unlocked from git push).
  const info = detectBackend(deps({
    fileExists: () => true,
    commandExists: () => true,
    gpgFirstSecretKey: () => "FFEE1122",
  }));
  if (info.backend !== "ssh-key") throw new Error(`ssh-key should beat gpg-file in priority; got ${info.backend}`);
});

// ── 4. Tier 2 optimization paths ────────────────────────────────

check("macOS: platform=darwin + security cmd → backend=macos", () => {
  const info = detectBackend(deps({
    platform: "darwin",
    commandExists: (c) => c === "security",
  }));
  if (info.backend !== "macos") throw new Error(`expected macos, got ${info.backend}`);
  if (!info.capabilities.autoUnlock) throw new Error("macOS should report autoUnlock=true");
});

check("macOS: darwin but no security cmd → falls through (impossible in practice but be safe)", () => {
  const info = detectBackend(deps({
    platform: "darwin",
    commandExists: () => false,
  }));
  if (info.backend === "macos") throw new Error("must require security CLI on PATH");
});

check("Linux + DISPLAY + secret-tool → backend=secret-service (Tier 2)", () => {
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("DISPLAY")) throw new Error("reason should cite DISPLAY");
});

check("Linux + WAYLAND_DISPLAY + secret-tool → secret-service cites WAYLAND", () => {
  const info = detectBackend(deps({
    env: { WAYLAND_DISPLAY: "wayland-0" },
    commandExists: (c) => c === "secret-tool",
  }));
  if (info.backend !== "secret-service") throw new Error(`expected secret-service, got ${info.backend}`);
  if (!info.reason.includes("WAYLAND_DISPLAY")) throw new Error("reason should cite WAYLAND_DISPLAY");
});

check("Linux desktop without secret-tool → falls through (CLI required)", () => {
  const info = detectBackend(deps({
    env: { DISPLAY: ":0" },
    commandExists: () => false,
  }));
  if (info.backend === "secret-service") throw new Error("must not select secret-service without secret-tool");
});

check("pass + ~/.password-store/abrain → backend=pass (Tier 2)", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: (p) => p === "/home/test/.password-store/abrain",
  }));
  if (info.backend !== "pass") throw new Error(`expected pass, got ${info.backend}`);
  if (info.capabilities.autoUnlock) throw new Error("pass should report autoUnlock=false (manual gpg-agent)");
});

check("pass: cmd without password-store dir → falls through", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "pass",
    fileExists: () => false,
  }));
  if (info.backend === "pass") throw new Error("must require ~/.password-store/abrain/");
});

// ── 5. Tier 1 priority over Tier 2 ──────────────────────────────

check("priority: ssh-key beats macos (Tier 1 > Tier 2)", () => {
  // macOS user with ssh key still gets ssh-key as default (more portable
  // across machines). User can $SECRETS_BACKEND=macos override if desired.
  const info = detectBackend(deps({
    platform: "darwin",
    fileExists: () => true,
    commandExists: () => true,
  }));
  if (info.backend !== "ssh-key") throw new Error(`Tier 1 ssh-key should beat Tier 2 macos; got ${info.backend}`);
});

check("priority: ssh-key beats secret-service (Tier 1 > Tier 2)", () => {
  const info = detectBackend(deps({
    fileExists: () => true,
    commandExists: () => true,
    env: { DISPLAY: ":0" },
  }));
  if (info.backend !== "ssh-key") throw new Error(`Tier 1 ssh-key should beat Tier 2 secret-service`);
});

// ── 6. Tier 1 fallback: passphrase-only ─────────────────────────

check("v1.4: nothing available → passphrase-only (NOT disabled like v1.3)", () => {
  // The big v1.4 change: container with nothing now gets passphrase-only,
  // not disabled. CI/container scenarios fall here. v1.3 returned 'disabled'.
  const info = detectBackend(deps({}));
  if (info.backend !== "passphrase-only") throw new Error(`v1.4 default fallback should be passphrase-only, not ${info.backend}`);
  if (!info.reason.includes("scrypt")) throw new Error("reason should mention age scrypt");
});

check("passphrase-only: explicit 'will prompt on each pi start' wording", () => {
  const info = detectBackend(deps({}));
  if (!info.reason.includes("prompt")) throw new Error("reason should warn about prompt UX");
  if (info.capabilities.autoUnlock) throw new Error("passphrase-only must report autoUnlock=false");
});

// ── 7. $SECRETS_BACKEND env override ────────────────────────────

check("$SECRETS_BACKEND=ssh-key forces ssh-key (overrides auto)", () => {
  const info = detectBackend(deps({
    env: { SECRETS_BACKEND: "ssh-key" },
    platform: "darwin", // would be macos under auto
  }));
  if (info.backend !== "env-override") throw new Error(`expected env-override, got ${info.backend}`);
  if (info.overrideTarget !== "ssh-key") throw new Error(`expected overrideTarget=ssh-key, got ${info.overrideTarget}`);
});

check("$SECRETS_BACKEND=passphrase-only is honored (was 'disabled' in v1.3)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "passphrase-only" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override`);
  if (info.overrideTarget !== "passphrase-only") throw new Error(`expected overrideTarget=passphrase-only`);
});

check("$SECRETS_BACKEND=disabled forces disabled (no overrideTarget)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "disabled" } }));
  if (info.backend !== "env-override") throw new Error(`expected env-override`);
  if (info.overrideTarget !== undefined) throw new Error(`disabled override should have no overrideTarget`);
});

check("$SECRETS_BACKEND=garbage falls through to auto-detect (security)", () => {
  // Critical: typo'd override must NOT silently do anything weird.
  // In v1.4 fall-through hits passphrase-only (not disabled).
  const info = detectBackend(deps({
    env: { SECRETS_BACKEND: "totally-fake-backend" },
  }));
  if (info.backend === "env-override") throw new Error("garbage override should NOT be honored");
  if (info.backend !== "passphrase-only") throw new Error(`fall-through should hit passphrase-only, got ${info.backend}`);
});

check("$SECRETS_BACKEND case-insensitive (SSH-KEY honored)", () => {
  const info = detectBackend(deps({ env: { SECRETS_BACKEND: "SSH-KEY" } }));
  if (info.backend !== "env-override") throw new Error("uppercase override should be honored");
  if (info.overrideTarget !== "ssh-key") throw new Error(`expected ssh-key, got ${info.overrideTarget}`);
});

// ── 8. formatStatus ─────────────────────────────────────────────

// ── State B: not initialized (initialized=null) ─────────────────

check("formatStatus B (not initialized, ssh-key detected): shows 'ready to init' + identity", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p.includes("id_ed25519"),
  }));
  const out = formatStatus(info, false, null);
  if (!out.includes("not initialized")) throw new Error("output missing 'not initialized'");
  if (!out.includes("ssh-key")) throw new Error("output missing 'ssh-key'");
  if (!out.includes("/home/test/.ssh/id_ed25519")) throw new Error("output missing identity path");
  if (!out.includes("to init:")) throw new Error("output missing 'to init:' hint");
});

check("formatStatus B (gpg-file detected) shows gpg recipient + 'ready to init'", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "gpg",
    gpgFirstSecretKey: () => "DEADBEEF12345678",
  }));
  const out = formatStatus(info, false, null);
  if (!out.includes("not initialized")) throw new Error("output missing 'not initialized'");
  if (!out.includes("gpg recipient")) throw new Error("output missing gpg recipient line");
  if (!out.includes("0xDEADBEEF12345678")) throw new Error("output missing recipient id");
});

check("formatStatus B (passphrase-only fall-through) renders unlock UX warning", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, null);
  if (!out.includes("passphrase-only")) throw new Error("output missing 'passphrase-only'");
  if (!out.includes("manual unlock")) throw new Error("output should warn about manual unlock");
});

// ── State C: user-disabled flag set ─────────────────────────────

check("formatStatus C (vaultDisabledFlag=true, no init record) shows user-disabled state", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, true, null);
  if (!out.includes("disabled")) throw new Error("output missing 'disabled'");
  if (!out.includes("vault-disabled")) throw new Error("output missing path hint");
});

check("formatStatus C with init record: shows 'was initialized as'", () => {
  // edge case: user disabled vault AFTER initializing — make it explicit
  const info = detectBackend(deps({ fileExists: () => true }));
  const out = formatStatus(info, true, {
    backend: "ssh-key", identity: "/test", vaultMasterPresent: true,
  });
  if (!out.includes("was initialized as")) throw new Error("missing 'was initialized as'");
});

// ── State A: initialized (the dogfood-flagged case) ────────────────

check("★ formatStatus A (initialized): NO 'P0a' or 'P0b not delivered' wording", () => {
  // The dogfood discovery: previous status said 'P0a only detects' even after
  // user successfully ran /vault init. Verify we never regress to that wording.
  const info = detectBackend(deps({ fileExists: () => true }));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/home/worker/.ssh/id_rsa",
    publicKey: "age1zu6pzj7",
    vaultMasterPresent: true,
    vaultMasterMode: 0o600,
  });
  if (out.includes("P0a only detects")) throw new Error("REGRESSION: P0a wording in initialized status");
  if (out.includes("master key generation lands in P0b")) throw new Error("REGRESSION: 'P0b lands' wording");
  if (!out.includes("initialized")) throw new Error("missing 'initialized'");
  if (!out.includes("ssh-key")) throw new Error("missing backend");
  if (!out.includes("/home/worker/.ssh/id_rsa")) throw new Error("missing identity");
  if (!out.includes("age1zu6pzj7")) throw new Error("missing public key");
});

check("formatStatus A with file backend missing master file: warns inconsistent", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/x",
    vaultMasterPresent: false, // ← simulates corrupted state
  });
  if (!out.includes("MISSING")) throw new Error("missing 'MISSING' warning");
  if (!out.includes("inconsistent")) throw new Error("missing 'inconsistent' warning");
});

check("formatStatus A with permissive .vault-master.age mode: warns group/other readable", () => {
  // Regression for the dogfood-flagged 0664 issue (v1.4.1 fix): if for some
  // reason a future bug puts .vault-master.age back at 0664, status surfaces it.
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key",
    identity: "/x",
    vaultMasterPresent: true,
    vaultMasterMode: 0o664,
  });
  if (!out.includes("⚠")) throw new Error("missing warning marker for permissive mode");
  if (!out.includes("group/other readable")) throw new Error("missing mode warning text");
});

check("formatStatus A with keychain backend: shows 'master stored in: macOS Keychain'", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "macos",
    vaultMasterPresent: false, // keychain backends don't write file
  });
  if (out.includes("MISSING")) throw new Error("keychain backend should NOT trigger MISSING warning");
  if (!out.includes("master stored in:")) throw new Error("missing 'master stored in:' line");
  if (!out.includes("macOS Keychain")) throw new Error("missing 'macOS Keychain' description");
});

check("formatStatus A distinguishes shipped P0c read/write from pending project routing", () => {
  // Verify status text does not mislead users: /secret write/list/forget,
  // vault_release, and global $VAULT_* bash injection are shipped; project
  // vault routing remains pending.
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false, {
    backend: "ssh-key", identity: "/x", vaultMasterPresent: true, vaultMasterMode: 0o600,
  });
  if (!out.includes("P0c.write implemented")) throw new Error("missing shipped P0c.write note");
  if (!out.includes("vault_release + $VAULT_* bash injection are implemented")) throw new Error("missing shipped P0c.read note");
  if (!out.includes("project vault routing remains pending")) throw new Error("missing pending project routing note");
  if (out.includes("cannot write")) throw new Error("stale cannot-write wording leaked");
});

// ── 9. activate() respects PI_ABRAIN_DISABLED=1 ─────────────────
//
// Same as before — sub-pi guard still in place.

const detectFile = path.join(tmpDir, "backend-detect.cjs");
fs.writeFileSync(detectFile, detectCompiled);

// index.ts imports ./bootstrap, ./keychain, ./vault-writer, ./vault-reader.
// Relative imports must be rewritten to .cjs paths so the transpiled CJS
// module can resolve them in the smoke tmp dir.
const bootstrapSrc = path.join(repoRoot, "extensions/abrain/bootstrap.ts");
const keychainSrc = path.join(repoRoot, "extensions/abrain/keychain.ts");
const vaultWriterSrc = path.join(repoRoot, "extensions/abrain/vault-writer.ts");
const vaultReaderSrc = path.join(repoRoot, "extensions/abrain/vault-reader.ts");
const vaultBashSrc = path.join(repoRoot, "extensions/abrain/vault-bash.ts");
fs.writeFileSync(path.join(tmpDir, "bootstrap.cjs"), transpileTsToCjs(bootstrapSrc));
fs.writeFileSync(path.join(tmpDir, "keychain.cjs"), transpileTsToCjs(keychainSrc));
fs.writeFileSync(path.join(tmpDir, "vault-writer.cjs"), transpileTsToCjs(vaultWriterSrc));
fs.writeFileSync(path.join(tmpDir, "vault-reader.cjs"), transpileTsToCjs(vaultReaderSrc));
fs.writeFileSync(path.join(tmpDir, "vault-bash.cjs"), transpileTsToCjs(vaultBashSrc));
fs.writeFileSync(path.join(tmpDir, "i18n.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/abrain/i18n.ts")));
// vault-reader.cjs keeps its own relative imports (./keychain, ./vault-writer),
// so provide extensionless .js companions in the tmp dir as well.
fs.copyFileSync(path.join(tmpDir, "keychain.cjs"), path.join(tmpDir, "keychain.js"));
fs.copyFileSync(path.join(tmpDir, "vault-writer.cjs"), path.join(tmpDir, "vault-writer.js"));
fs.copyFileSync(path.join(tmpDir, "vault-reader.cjs"), path.join(tmpDir, "vault-reader.js"));
// _shared/runtime is required by index.ts via ../_shared/runtime; mirror that layout.
const sharedTargetDir = path.join(tmpDir, "_shared");
fs.mkdirSync(sharedTargetDir, { recursive: true });
fs.writeFileSync(path.join(sharedTargetDir, "runtime.cjs"), transpileTsToCjs(path.join(repoRoot, "extensions/_shared/runtime.ts")));
fs.copyFileSync(path.join(sharedTargetDir, "runtime.cjs"), path.join(sharedTargetDir, "runtime.js"));

const indexSrc = path.join(repoRoot, "extensions/abrain/index.ts");
let indexCompiled = transpileTsToCjs(indexSrc);
indexCompiled = indexCompiled
  .replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")')
  .replace(/require\("\.\/bootstrap"\)/g, 'require("./bootstrap.cjs")')
  .replace(/require\("\.\/keychain"\)/g, 'require("./keychain.cjs")')
  .replace(/require\("\.\/vault-writer"\)/g, 'require("./vault-writer.cjs")')
  .replace(/require\("\.\/vault-reader"\)/g, 'require("./vault-reader.cjs")')
  .replace(/require\("\.\/vault-bash"\)/g, 'require("./vault-bash.cjs")')
  .replace(/require\("\.\/i18n"\)/g, 'require("./i18n.cjs")')
  .replace(/require\("\.\.\/_shared\/runtime"\)/g, 'require("./_shared/runtime.cjs")');
const indexFile = path.join(tmpDir, "index.cjs");
fs.writeFileSync(indexFile, indexCompiled);
const indexModule = require(indexFile);
const activate = indexModule.default;

check("activate is a function", () => {
  if (typeof activate !== "function") throw new Error(`expected function, got ${typeof activate}`);
});

check("PI_ABRAIN_DISABLED=1 → activate registers ZERO commands (sub-pi guard)", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  try {
    let registerCalls = 0;
    let toolCalls = 0;
    let eventCalls = 0;
    activate({ registerCommand: () => { registerCalls += 1; }, registerTool: () => { toolCalls += 1; }, on: () => { eventCalls += 1; } });
    if (registerCalls !== 0) throw new Error(`sub-pi guard breached: registerCommand called ${registerCalls} time(s)`);
    if (toolCalls !== 0) throw new Error(`sub-pi guard breached: registerTool called ${toolCalls} time(s)`);
    if (eventCalls !== 0) throw new Error(`sub-pi guard breached: event handler registered ${eventCalls} time(s)`);
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED unset → activate registers /vault, vault_release, and bash vault hooks", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    const registered = [];
    const tools = [];
    const events = [];
    const toolDefs = [];
    activate({ registerCommand: (name) => registered.push(name), registerTool: (tool) => { tools.push(tool.name); toolDefs.push(tool); }, on: (event) => events.push(event) });
    if (!registered.includes("vault")) throw new Error(`expected /vault, got: ${registered.join(", ")}`);
    if (!tools.includes("vault_release")) throw new Error(`expected vault_release tool, got: ${tools.join(", ")}`);
    if (!events.includes("tool_call") || !events.includes("tool_result")) throw new Error(`expected bash vault hooks, got: ${events.join(", ")}`);
    if (!events.includes("message_start")) throw new Error(`expected message_start hook for i18n language tracking, got: ${events.join(", ")}`);
    const release = toolDefs.find((t) => t.name === "vault_release");
    if (!release || !release.parameters || !release.parameters.properties) throw new Error("vault_release tool definition missing parameters.properties");
    if (!release.parameters.properties.scope) throw new Error("vault_release schema must declare top-level scope (LLMs cannot reliably emit nested options object)");
    if (!release.parameters.properties.reason) throw new Error("vault_release schema must declare top-level reason");
    if (release.parameters.properties.options) throw new Error("vault_release schema should not declare nested options (callers must use flat scope/reason)");
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED=0 → activate DOES register (only literal '1' disables)", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "0";
  try {
    let registerCalls = 0;
    activate({ registerCommand: () => { registerCalls += 1; } });
    if (registerCalls === 0) throw new Error("only literal '1' should disable");
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("activate handles missing registerCommand gracefully", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    activate({}); // no registerCommand at all
  } catch (err) {
    throw new Error(`activate threw: ${err.message}`);
  } finally {
    if (prev !== undefined) process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("authorization prompt titles disclose key + scope + reason + description (so the user knows what they're approving)", () => {
  // formatReleaseAuthorizationTitle: scope:key + LLM reason + description + plaintext warning.
  const releaseTitle = indexModule.formatReleaseAuthorizationTitle("global", "github-token", "push to main", "GitHub PAT for the release pipeline");
  if (!releaseTitle.includes("global:github-token")) throw new Error(`release title missing scope:key — ${releaseTitle}`);
  if (!releaseTitle.includes("push to main")) throw new Error(`release title missing LLM reason — ${releaseTitle}`);
  if (!releaseTitle.includes("GitHub PAT for the release pipeline")) throw new Error(`release title missing description — ${releaseTitle}`);
  if (!releaseTitle.toLowerCase().includes("plaintext")) throw new Error(`release title missing plaintext warning — ${releaseTitle}`);
  // Description omitted: prompt still renders without a phantom line.
  const noDescTitle = indexModule.formatReleaseAuthorizationTitle("global", "github-token", "reason", undefined);
  if (noDescTitle.includes("description:")) throw new Error(`should omit description line when none — ${noDescTitle}`);
  // No LLM reason supplied: prompt annotates that explicitly.
  const noReasonTitle = indexModule.formatReleaseAuthorizationTitle({ project: "pi-global" }, "db-password", undefined);
  if (!noReasonTitle.includes("project:pi-global:db-password")) throw new Error(`project scope label missing — ${noReasonTitle}`);
  if (!noReasonTitle.toLowerCase().includes("none supplied")) throw new Error(`missing fallback reason annotation — ${noReasonTitle}`);

  // formatBashAuthorizationTitle: keys list (with optional per-key description) + command preview.
  const descriptions = new Map([
    ["global:github-token", "GitHub PAT for the release pipeline"],
  ]);
  const bashTitle = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "github-token", value: "<x>", placeholder: "<vault:global:github-token>" }],
    originalCommand: "curl -H \"Authorization: token $VAULT_github_token\" https://api.github.com/user",
  }, descriptions);
  if (!bashTitle.includes("global:github-token")) throw new Error(`bash title missing keys — ${bashTitle}`);
  if (!bashTitle.includes("GitHub PAT for the release pipeline")) throw new Error(`bash title missing description — ${bashTitle}`);
  if (!bashTitle.includes("curl -H")) throw new Error(`bash title missing command preview — ${bashTitle}`);
  if (!bashTitle.toLowerCase().includes("encoded")) throw new Error(`bash title missing encoded-secret warning — ${bashTitle}`);
  // Without descriptions, the keys line still renders cleanly.
  const bashTitleNoDesc = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "github-token", value: "<x>", placeholder: "<vault:global:github-token>" }],
    originalCommand: "echo ok",
  });
  if (!bashTitleNoDesc.includes("global:github-token")) throw new Error(`bash title (no descriptions) missing key — ${bashTitleNoDesc}`);
  if (bashTitleNoDesc.includes(" — ")) throw new Error(`bash title should not render empty description dash — ${bashTitleNoDesc}`);

  // Very long values should be truncated so the prompt stays usable.
  const longCmd = "echo " + "x".repeat(2000) + " tail-marker";
  const truncated = indexModule.formatBashAuthorizationTitle({
    releases: [{ scope: "global", key: "k", value: "v", placeholder: "<vault:global:k>" }],
    originalCommand: longCmd,
  });
  if (truncated.length > 1000) throw new Error(`bash title not truncated, length=${truncated.length}`);
  if (!truncated.includes("tail-marker")) throw new Error(`truncation should keep tail (last meaningful chars)`);
});

check("vault_release pre-flight existence check runs BEFORE user authorization (no phantom prompts)", () => {
  const src = fs.readFileSync(indexSrc, "utf8");
  if (!src.includes("checkedBeforeAuthorization")) throw new Error("pre-flight branch missing — vault_release would prompt for nonexistent keys");
  if (!src.includes("vaultFilePath(ABRAIN_HOME, scope, key)")) throw new Error("vault_release must consult vaultFilePath() pre-flight");
  const preFlightIdx = src.indexOf("checkedBeforeAuthorization");
  const authorizeIdx = src.indexOf("authorizeVaultRelease(ctx.ui");
  if (preFlightIdx < 0 || authorizeIdx < 0 || preFlightIdx >= authorizeIdx) {
    throw new Error("pre-flight must precede authorizeVaultRelease() in execute() to avoid phantom prompts");
  }
});

check("vault authorization menus are default-deny for non-interactive runners", () => {
  const src = fs.readFileSync(indexSrc, "utf8");
  if (!indexModule.VAULT_RELEASE_AUTH_CHOICES || indexModule.VAULT_RELEASE_AUTH_CHOICES[0] !== "No") throw new Error("vault_release authorization should put No first");
  const vaultBash = require(path.join(tmpDir, "vault-bash.cjs"));
  if (!vaultBash.VAULT_BASH_OUTPUT_AUTH_CHOICES || vaultBash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0] !== "No") throw new Error("bash output authorization should put No first");
});

// ── Done ────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain v1.4 backend detection + sub-pi guard hold (${totalChecks} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${totalChecks} assertions failed.`);
  process.exit(1);
}
