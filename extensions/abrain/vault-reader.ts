/**
 * abrain — vault reader library (P0c.read substrate).
 *
 * This module unlocks the encrypted master age identity and decrypts
 * per-key vault entries. It deliberately does NOT register any LLM-facing
 * tool by itself; `vault_release` / bash injection / TUI authorization are
 * higher layers. This keeps the dangerous plaintext boundary small and
 * smoke-testable.
 *
 * Security invariants:
 *   - sub-pi fails closed when PI_ABRAIN_DISABLED=1;
 *   - `.vault-backend` is the source of truth; no backend re-detection;
 *   - master key plaintext never appears in argv;
 *   - the temporary age identity file is 0600 and removed in finally;
 *   - the in-memory master-key Buffer is zeroed after each decrypt.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { readBackendFile, type BackendFile, type ExecFn } from "./keychain";
import { VAULT_IDENTITY_SECRET } from "./backend-detect";
import { validateKey, vaultDirForScope, type VaultScope } from "./vault-writer";

const VAULT_MASTER = ".vault-master.age";
const PI_ABRAIN_DISABLED = "PI_ABRAIN_DISABLED";

export interface MasterKey {
  backend: BackendFile["backend"];
  secretKey: Buffer;
}

export interface ReleaseSecretResult {
  scope: VaultScope;
  key: string;
  value: string;
  placeholder: string;
}

function scopeLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

export function vaultPlaceholder(scope: VaultScope, key: string): string {
  return `<vault:${scopeLabel(scope)}:${key}>`;
}

export function vaultFilePath(abrainHome: string, scope: VaultScope, key: string): string {
  validateKey(key);
  return path.join(vaultDirForScope(abrainHome, scope), `${key}.md.age`);
}

// Round 9 P1 (deepseek R9 P1-1 fix): default decrypt exec previously
// had no timeout. Backends like gpg / secret-tool / pass / age may
// stall on gpg-agent prompts when GPG_TTY isn't set, or on
// secret-service when D-Bus is wedged. 30s fail-loud beats infinite
// hang on pi main thread.
const VAULT_READ_SUBPROCESS_TIMEOUT_MS = 30_000;

function defaultExec(cmd: string, args: string[], opts?: { input?: Buffer | string; cwd?: string }): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts?.cwd,
      stdio: [opts?.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, VAULT_READ_SUBPROCESS_TIMEOUT_MS);
    child.stdout?.on("data", (b: Buffer) => stdout.push(b));
    child.stderr?.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${cmd} timed out after ${VAULT_READ_SUBPROCESS_TIMEOUT_MS}ms (gpg-agent prompt? D-Bus wedged?)`));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
    });
    if (opts?.input !== undefined && child.stdin) child.stdin.end(opts.input);
  });
}

function assertOk(label: string, result: { stdout: Buffer; stderr: Buffer; code: number | null }): Buffer {
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim() || `exit ${result.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return result.stdout;
}

function parseMasterKey(raw: Buffer, backend: BackendFile["backend"]): MasterKey {
  const text = raw.toString("utf8");
  const secretLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("AGE-SECRET-KEY-"));
  if (!secretLine) {
    throw new Error("unlocked master key is not an age secret identity");
  }
  // age identity files are newline-terminated. Keep only the canonical
  // AGE-SECRET-KEY line; age-keygen files may include leading comments.
  return { backend, secretKey: Buffer.from(`${secretLine}\n`, "utf8") };
}

async function readMasterEnvelope(abrainHome: string, info: BackendFile, exec: ExecFn): Promise<Buffer> {
  const masterPath = path.join(abrainHome, VAULT_MASTER);
  switch (info.backend) {
    case "abrain-age-key": {
      // ADR 0019: single-layer keypair. The on-disk identity secret IS the
      // master — no encryption envelope, no subprocess. Pure fs read.
      // Future P0d enhancement may wrap this file in age scrypt; loader
      // will then sniff for the scrypt header and unwrap with passphrase.
      const identityPath = path.join(abrainHome, VAULT_IDENTITY_SECRET);
      if (!fs.existsSync(identityPath)) {
        throw new Error(
          `abrain identity secret missing at ${identityPath}. ` +
          `If this is a fresh clone on a new device, copy it from your other machine: ` +
          `scp <other-host>:~/.abrain/${VAULT_IDENTITY_SECRET} ~/.abrain/${VAULT_IDENTITY_SECRET} && chmod 0600 ~/.abrain/${VAULT_IDENTITY_SECRET}`,
        );
      }
      return fs.readFileSync(identityPath);
    }
    case "ssh-key": {
      if (!info.identity) throw new Error("ssh-key backend missing identity in .vault-backend");
      if (!fs.existsSync(masterPath)) throw new Error(`${VAULT_MASTER} missing`);
      return assertOk("age -d master", await exec("age", ["-d", "-i", info.identity, masterPath]));
    }
    case "gpg-file": {
      if (!fs.existsSync(masterPath)) throw new Error(`${VAULT_MASTER} missing`);
      return assertOk("gpg --decrypt master", await exec("gpg", ["--decrypt", masterPath]));
    }
    case "passphrase-only": {
      if (!fs.existsSync(masterPath)) throw new Error(`${VAULT_MASTER} missing`);
      return assertOk("age -d master", await exec("age", ["-d", masterPath]));
    }
    case "macos": {
      return assertOk("security find-generic-password", await exec("security", ["find-generic-password", "-s", "alfadb-abrain-master", "-w"]));
    }
    case "secret-service": {
      return assertOk("secret-tool lookup", await exec("secret-tool", ["lookup", "service", "abrain", "key", "master"]));
    }
    case "pass": {
      return assertOk("pass show", await exec("pass", ["show", "abrain/master"]));
    }
  }
}

export async function loadMasterKey(
  abrainHome: string = path.join(os.homedir(), ".abrain"),
  exec: ExecFn = defaultExec,
): Promise<MasterKey | null> {
  // Three legitimate "not loaded" reasons return null without an error:
  // sub-pi disabled, user opted out via flag, or vault was never init'd.
  // Anything else — missing identity file, age subprocess failure,
  // corrupted envelope — propagates so the caller can surface an
  // actionable message. Self-audit 2026-05-15 (opus-4-7 external audit
  // catch): the previous unconditional `try { … } catch { return null }`
  // swallowed readMasterEnvelope's abrain-age-key "copy identity from
  // your other machine via scp …" error and surfaced a generic "vault
  // locked or not initialized" instead, breaking ADR 0019's cross-host
  // UX promise. Errors now bubble; only the three legitimate null cases
  // above stay silent.
  if (process.env[PI_ABRAIN_DISABLED] === "1") return null;
  const disabledFlag = path.join(abrainHome, ".state", "vault-disabled");
  if (fs.existsSync(disabledFlag)) return null;

  const info = readBackendFile(abrainHome);
  if (!info) return null;

  const raw = await readMasterEnvelope(abrainHome, info, exec);
  return parseMasterKey(raw, info.backend);
}

function makeIdentityTempDir(abrainHome: string): string {
  const parent = path.join(abrainHome, ".state");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(parent, "vault-read-"));
}

async function withTempIdentity<T>(abrainHome: string, master: MasterKey, fn: (identityPath: string) => Promise<T>): Promise<T> {
  const tmpDir = makeIdentityTempDir(abrainHome);
  const identityPath = path.join(tmpDir, "master.age");
  try {
    fs.writeFileSync(identityPath, master.secretKey, { mode: 0o600 });
    return await fn(identityPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function decryptSecret(
  opts: { abrainHome: string; scope: VaultScope; key: string; exec?: ExecFn },
): Promise<Buffer> {
  validateKey(opts.key);
  const encryptedPath = vaultFilePath(opts.abrainHome, opts.scope, opts.key);
  if (!fs.existsSync(encryptedPath)) {
    throw new Error(`vault key not found or forgotten: ${scopeLabel(opts.scope)}:${opts.key}`);
  }

  const exec = opts.exec ?? defaultExec;
  const master = await loadMasterKey(opts.abrainHome, exec);
  if (!master) throw new Error("vault locked or not initialized; run /vault init and ensure the backend identity is available");

  try {
    return await withTempIdentity(opts.abrainHome, master, async (identityPath) => {
      const result = await exec("age", ["-d", "-i", identityPath, encryptedPath]);
      return assertOk("age -d secret", result);
    });
  } finally {
    master.secretKey.fill(0);
  }
}

export async function releaseSecret(
  opts: { abrainHome: string; scope: VaultScope; key: string; exec?: ExecFn },
): Promise<ReleaseSecretResult> {
  const plaintext = await decryptSecret(opts);
  try {
    return {
      scope: opts.scope,
      key: opts.key,
      value: plaintext.toString("utf8"),
      placeholder: vaultPlaceholder(opts.scope, opts.key),
    };
  } finally {
    plaintext.fill(0);
  }
}

export function redactWithReleasedSecrets(text: string, releases: Array<Pick<ReleaseSecretResult, "scope" | "key" | "value">>): string {
  let out = text;
  for (const release of releases) {
    if (!release.value) continue;
    out = out.split(release.value).join(vaultPlaceholder(release.scope, release.key));
  }
  return out;
}
