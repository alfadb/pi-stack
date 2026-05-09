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

check("formatStatus(ssh-key) shows identity path", () => {
  const info = detectBackend(deps({
    fileExists: (p) => p.includes("id_ed25519"),
  }));
  const out = formatStatus(info, false);
  if (!out.includes("ssh-key")) throw new Error("output missing 'ssh-key'");
  if (!out.includes("identity:")) throw new Error("output missing identity line");
  if (!out.includes("/home/test/.ssh/id_ed25519")) throw new Error("output missing identity path");
});

check("formatStatus(gpg-file) shows gpg recipient", () => {
  const info = detectBackend(deps({
    commandExists: (c) => c === "gpg",
    gpgFirstSecretKey: () => "DEADBEEF12345678",
  }));
  const out = formatStatus(info, false);
  if (!out.includes("gpg recipient")) throw new Error("output missing gpg recipient line");
  if (!out.includes("0xDEADBEEF12345678")) throw new Error("output missing recipient id");
});

check("formatStatus(passphrase-only, false) renders unlock UX warning", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, false);
  if (!out.includes("passphrase-only")) throw new Error("output missing 'passphrase-only'");
  if (!out.includes("manual unlock")) throw new Error("output should warn about manual unlock");
});

check("formatStatus(any, vaultDisabledFlag=true) shows user-disabled state", () => {
  const info = detectBackend(deps({}));
  const out = formatStatus(info, true);
  if (!out.includes("disabled")) throw new Error("output missing 'disabled'");
  if (!out.includes("vault-disabled")) throw new Error("output missing path hint");
});

// ── 9. activate() respects PI_ABRAIN_DISABLED=1 ─────────────────
//
// Same as before — sub-pi guard still in place.

const detectFile = path.join(tmpDir, "backend-detect.cjs");
fs.writeFileSync(detectFile, detectCompiled);

const indexSrc = path.join(repoRoot, "extensions/abrain/index.ts");
let indexCompiled = transpileTsToCjs(indexSrc);
indexCompiled = indexCompiled.replace(/require\("\.\/backend-detect"\)/g, 'require("./backend-detect.cjs")');
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
    activate({ registerCommand: () => { registerCalls += 1; } });
    if (registerCalls !== 0) throw new Error(`sub-pi guard breached: registerCommand called ${registerCalls} time(s)`);
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

check("PI_ABRAIN_DISABLED unset → activate registers /vault", () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  delete process.env.PI_ABRAIN_DISABLED;
  try {
    const registered = [];
    activate({ registerCommand: (name) => registered.push(name) });
    if (!registered.includes("vault")) throw new Error(`expected /vault, got: ${registered.join(", ")}`);
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

// ── Done ────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain v1.4 backend detection + sub-pi guard hold (${totalChecks} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${totalChecks} assertions failed.`);
  process.exit(1);
}
