#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0c.read substrate — vaultReader library.
 *
 * Coverage:
 *   1. loadMasterKey fails closed when uninitialized / sub-pi disabled.
 *   2. ssh-key e2e: .vault-master.age unlocks to age secret identity.
 *   3. decryptSecret decrypts a vault/<key>.md.age written by vaultWriter.
 *   4. releaseSecret returns value + placeholder; redaction replaces plaintext.
 *   5. temporary age identity files are removed after decrypt.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  });
  return out.outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vr-"));
// ADR 0019: vault-reader.ts + keychain.ts now import runtime constants from
// ./backend-detect, so include it in the load set.
for (const file of ["backend-detect", "vault-reader", "vault-writer", "keychain"]) {
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), transpile(path.join(repoRoot, "extensions", "abrain", `${file}.ts`)));
}
// Relative imports in transpiled CommonJS keep the original .ts-free names.
for (const file of ["backend-detect", "vault-reader", "vault-writer", "keychain"]) {
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}

const reader = require(path.join(tmpDir, "vault-reader.cjs"));
const writer = require(path.join(tmpDir, "vault-writer.cjs"));
const keychain = require(path.join(tmpDir, "keychain.cjs"));

console.log("abrain P0c.read — vaultReader library");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r;
}

function freshUnlockedAbrainHome() {
  const home = fs.mkdtempSync(path.join(tmpDir, "abrain-home-"));
  fs.mkdirSync(path.join(home, ".state"), { recursive: true, mode: 0o700 });

  const sshKey = path.join(home, "test_ed25519");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", sshKey]);

  const masterSecret = path.join(home, "master.age");
  const age = run("age-keygen", ["-o", masterSecret]);
  const m = age.stderr.match(/Public key:\s+(\S+)/);
  if (!m) throw new Error("could not parse age public key");
  const masterPub = m[1];

  const encryptedMaster = path.join(home, ".vault-master.age");
  run("age", ["-R", `${sshKey}.pub`, "-o", encryptedMaster, masterSecret]);
  fs.chmodSync(encryptedMaster, 0o600);

  keychain.writeBackendFile(home, { backend: "ssh-key", identity: sshKey });
  keychain.writePubkeyFile(home, masterPub);

  return { home, sshKey, masterSecret, masterPub };
}

function vaultReadTempDirs(home) {
  const state = path.join(home, ".state");
  if (!fs.existsSync(state)) return [];
  return fs.readdirSync(state).filter((name) => name.startsWith("vault-read-"));
}

await check("loadMasterKey: uninitialized returns null", async () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "uninit-"));
  const mk = await reader.loadMasterKey(home);
  if (mk !== null) throw new Error("expected null master key for uninitialized vault");
});

await check("loadMasterKey: PI_ABRAIN_DISABLED=1 fails closed", async () => {
  const { home } = freshUnlockedAbrainHome();
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  try {
    const mk = await reader.loadMasterKey(home);
    if (mk !== null) throw new Error("sub-pi disabled should not unlock master key");
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

await check("ssh-key e2e: loadMasterKey unlocks .vault-master.age", async () => {
  const { home } = freshUnlockedAbrainHome();
  const mk = await reader.loadMasterKey(home);
  if (!mk) throw new Error("master key did not unlock");
  const text = mk.secretKey.toString("utf8");
  if (!text.startsWith("AGE-SECRET-KEY-")) throw new Error("unlocked master is not an age secret key");
  mk.secretKey.fill(0);
});

await check("decryptSecret: vaultWriter encrypted value decrypts byte-exact", async () => {
  const { home } = freshUnlockedAbrainHome();
  const value = "ghp_test_secret_value\nwith newline";
  await writer.writeSecret({ abrainHome: home, scope: "global", key: "github-token", value });
  const out = await reader.decryptSecret({ abrainHome: home, scope: "global", key: "github-token" });
  const got = out.toString("utf8");
  out.fill(0);
  if (got !== value) throw new Error(`decrypt mismatch: ${JSON.stringify(got)}`);
  const leftovers = vaultReadTempDirs(home);
  if (leftovers.length > 0) throw new Error(`temp identity dirs not cleaned: ${leftovers.join(", ")}`);
});

await check("releaseSecret + redactWithReleasedSecrets: returns placeholder and redacts literal value", async () => {
  const { home } = freshUnlockedAbrainHome();
  const value = "super-secret-value";
  await writer.writeSecret({ abrainHome: home, scope: "global", key: "api-token", value });
  const release = await reader.releaseSecret({ abrainHome: home, scope: "global", key: "api-token" });
  if (release.value !== value) throw new Error("release value mismatch");
  if (release.placeholder !== "<vault:global:api-token>") throw new Error(`placeholder mismatch: ${release.placeholder}`);
  const redacted = reader.redactWithReleasedSecrets(`token=${value}`, [release]);
  if (redacted.includes(value)) throw new Error("redaction leaked plaintext value");
  if (!redacted.includes("<vault:global:api-token>")) throw new Error("redaction missing placeholder");
});

await check("decryptSecret: missing or forgotten key fails closed", async () => {
  const { home } = freshUnlockedAbrainHome();
  let threw = false;
  try {
    await reader.decryptSecret({ abrainHome: home, scope: "global", key: "missing-key" });
  } catch (err) {
    threw = true;
    if (!err.message.includes("not found or forgotten")) throw new Error(`unexpected error: ${err.message}`);
  }
  if (!threw) throw new Error("expected missing key to throw");
});

if (failures.length > 0) {
  console.error(`\n${failures.length}/${total} checks failed`);
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`\nall ok — abrain P0c.read vaultReader holds (${total} assertions, ssh-key unlock + decrypt verified).`);
