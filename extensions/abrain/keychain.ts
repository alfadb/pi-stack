/**
 * abrain — backend dispatch for master key encryption + persistence (P0b).
 *
 * Per-backend "encrypt the generated master key into its resting place"
 * dispatch, plus the small file format helpers for ~/.abrain/.vault-backend
 * and ~/.abrain/.vault-pubkey.
 *
 * Container scenario (alfadb): only ssh-key path is exercised end-to-end.
 * Other backends are dispatched correctly (commands constructed per
 * vault-bootstrap.md §3) but real-host smoke is deferred until those
 * environments are available.
 *
 * Security invariants (vault-bootstrap §3.1):
 *   - inv2: no secret in argv except where the CLI gives no choice
 *           (macOS `security` is the documented exception).
 *   - secrets passed via stdin pipe or file path otherwise.
 *
 * Dependency-injected: encryptMasterKey takes an `exec` function so smoke
 * can mock subprocess invocations and assert command construction.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Backend } from "./backend-detect";
import { VAULT_IDENTITY_DIR, VAULT_IDENTITY_SECRET, VAULT_IDENTITY_PUBKEY } from "./backend-detect";

// ── exec dependency (injected) ──────────────────────────────────

export interface ExecResult {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
}

export interface ExecFn {
  (cmd: string, args: string[], opts?: { input?: Buffer | string; cwd?: string }): Promise<ExecResult>;
}

// ── encrypt dispatch ────────────────────────────────────────────

export type EncryptableBackend = Exclude<Backend, "env-override" | "disabled">;

export interface EncryptOptions {
  /** absolute path of the plaintext master key file (input) */
  masterSecretPath: string;
  /** age public key string (returned by age-keygen) — for backends that need it */
  masterPublicKey: string;
  /** identity (ssh secret key path / gpg key id), if applicable */
  identity?: string;
  /**
   * absolute path where ssh-key/gpg-file/passphrase backends write the
   * encrypted master. Ignored by keychain backends (macos/secret-service/pass).
   */
  vaultMasterEncryptedPath: string;
  /** $USER for macOS keychain account name (defaults to env USER) */
  user?: string;
}

/**
 * Persist the generated master key according to the selected backend.
 *
 * Per backend (ADR 0019):
 *
 *   abrain-age-key   copy install-tmp secret → ~/.abrain/.vault-identity/master.age (0600);
 *                    write public key → ~/.abrain/.vault-identity/master.age.pub (0644).
 *                    NO subprocess; the secret IS the master.
 *                    `vaultMasterEncryptedPath` (.vault-master.age) is NOT written
 *                    — single-layer keypair (ADR 0019 invariant 6).
 *
 *   ssh-key          age -R <pub> -o <out> <input>     (Tier 3, explicit-only)
 *   gpg-file         gpg --encrypt --batch --recipient <id> --output <out> <input>
 *   passphrase-only  age -p -o <out> <input>           (REQUIRES /dev/tty)
 *   macos            security add-generic-password -s alfadb-abrain-master -a <user>
 *                                                   -w <plaintext> -U
 *                    (KNOWN inv2 exception: argv exposure ~100ms)
 *   secret-service   secret-tool store --label=... service abrain key master
 *                    (plaintext via stdin)
 *   pass             pass insert -m abrain/master
 *                    (plaintext via stdin)
 *
 * Throws on any non-zero exit code with stderr in the message.
 */
export async function encryptMasterKey(
  backend: EncryptableBackend,
  opts: EncryptOptions,
  exec: ExecFn,
): Promise<void> {
  switch (backend) {
    case "abrain-age-key": {
      // ADR 0019: abrain self-managed identity. The generated age secret
      // IS the vault master (single-layer keypair). We copy it to its
      // canonical location with strict 0600 mode and write the public
      // key alongside. No encryption subprocess — the on-disk identity
      // is the trust anchor; protection is the 0600 file mode + .gitignore.
      //
      // P0d will add an optional passphrase wrap that re-encrypts this
      // file with age scrypt, allowing the secret to enter git. For now
      // (P0c.write/read MVP) the secret stays gitignored and crosses
      // devices via user-managed secure transport.
      const abrainHome = path.dirname(opts.vaultMasterEncryptedPath);
      const identityDir = path.join(abrainHome, VAULT_IDENTITY_DIR);
      fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
      // Tighten the dir mode in case mkdirSync was a no-op (existing dir
      // with looser perms).
      try { fs.chmodSync(identityDir, 0o700); } catch { /* best-effort */ }

      const identitySecretPath = path.join(abrainHome, VAULT_IDENTITY_SECRET);
      const identityPubkeyPath = path.join(abrainHome, VAULT_IDENTITY_PUBKEY);

      // Atomic copy via tmp + rename so a partial write never leaves a
      // half-written secret file.
      const tmpSecret = `${identitySecretPath}.tmp.${process.pid}`;
      try {
        // Read source fully then write with explicit 0600 (avoids umask).
        const secretBuf = fs.readFileSync(opts.masterSecretPath);
        fs.writeFileSync(tmpSecret, secretBuf, { mode: 0o600 });
        fs.renameSync(tmpSecret, identitySecretPath);
        // Belt-and-suspenders: enforce 0600 even if rename target had wider perms.
        fs.chmodSync(identitySecretPath, 0o600);
      } catch (e) {
        try { fs.unlinkSync(tmpSecret); } catch { /* best-effort */ }
        throw e;
      }

      // Public key file: plain text, group/world readable is fine (not a secret).
      const tmpPub = `${identityPubkeyPath}.tmp.${process.pid}`;
      try {
        fs.writeFileSync(tmpPub, opts.masterPublicKey + "\n", { mode: 0o644 });
        fs.renameSync(tmpPub, identityPubkeyPath);
      } catch (e) {
        try { fs.unlinkSync(tmpPub); } catch { /* best-effort */ }
        throw e;
      }
      return;
    }

    case "ssh-key": {
      if (!opts.identity) throw new Error("ssh-key backend requires identity (path to ssh secret key)");
      const sshPub = `${opts.identity}.pub`;
      if (!fs.existsSync(sshPub)) {
        throw new Error(`ssh public key not found: ${sshPub} (cannot encrypt without it)`);
      }
      const { code, stderr } = await exec("age", [
        "-R", sshPub,
        "-o", opts.vaultMasterEncryptedPath,
        opts.masterSecretPath,
      ]);
      if (code !== 0) throw new Error(`age -R failed: ${stderr.toString("utf8")}`);
      // v1.4.1 dogfood fix: age -o respects umask (container umask=0002 → 0664
      // group-readable). Force 0600 — vault-bootstrap §3.1 inv5 requires it.
      fs.chmodSync(opts.vaultMasterEncryptedPath, 0o600);
      return;
    }

    case "gpg-file": {
      if (!opts.identity) throw new Error("gpg-file backend requires identity (gpg key id)");
      const { code, stderr } = await exec("gpg", [
        "--encrypt", "--batch", "--yes",
        "--recipient", opts.identity,
        "--output", opts.vaultMasterEncryptedPath,
        opts.masterSecretPath,
      ]);
      if (code !== 0) throw new Error(`gpg --encrypt failed: ${stderr.toString("utf8")}`);
      // v1.4.1: same umask issue as ssh-key path
      fs.chmodSync(opts.vaultMasterEncryptedPath, 0o600);
      return;
    }

    case "passphrase-only": {
      // age -p reads passphrase from /dev/tty interactively. Caller MUST
      // invoke with stdio: 'inherit' so user can type. This codepath is
      // smoke'd via mock only; real exercise requires interactive run.
      const { code, stderr } = await exec("age", [
        "-p",
        "-o", opts.vaultMasterEncryptedPath,
        opts.masterSecretPath,
      ]);
      if (code !== 0) throw new Error(`age -p failed: ${stderr.toString("utf8")}`);
      // v1.4.1: same umask issue as ssh-key path
      fs.chmodSync(opts.vaultMasterEncryptedPath, 0o600);
      return;
    }

    case "macos": {
      // KNOWN inv2 exception: macOS `security` has no stdin mode for
      // add-generic-password. The plaintext briefly appears in argv.
      // Documented in vault-bootstrap §3.1 inv2.
      const plaintext = fs.readFileSync(opts.masterSecretPath, "utf8");
      const user = opts.user ?? process.env.USER ?? "abrain";
      const { code, stderr } = await exec("security", [
        "add-generic-password",
        "-s", "alfadb-abrain-master",
        "-a", user,
        "-w", plaintext,
        "-U", // update if exists
      ]);
      if (code !== 0) throw new Error(`security add-generic-password failed: ${stderr.toString("utf8")}`);
      return;
    }

    case "secret-service": {
      const plaintext = fs.readFileSync(opts.masterSecretPath);
      const { code, stderr } = await exec(
        "secret-tool",
        ["store", "--label=alfadb abrain master", "service", "abrain", "key", "master"],
        { input: plaintext },
      );
      if (code !== 0) throw new Error(`secret-tool store failed: ${stderr.toString("utf8")}`);
      return;
    }

    case "pass": {
      const plaintext = fs.readFileSync(opts.masterSecretPath);
      const { code, stderr } = await exec(
        "pass",
        ["insert", "-m", "abrain/master"],
        { input: plaintext },
      );
      if (code !== 0) throw new Error(`pass insert failed: ${stderr.toString("utf8")}`);
      return;
    }
  }
}

// ── small file persistence helpers (inv1 step 3) ────────────────

export interface BackendFile {
  backend: EncryptableBackend;
  /** identity for ssh-key (secret key path) or gpg-file (key id); undefined for keychain backends */
  identity?: string;
}

const BACKEND_FILE = ".vault-backend";
const PUBKEY_FILE = ".vault-pubkey";

/**
 * Write ~/.abrain/.vault-backend in `key=value\n` format. Mode 0600.
 * Atomic: writes to .vault-backend.tmp then renames, so partial writes
 * never leave a malformed file.
 *
 * ADR 0019: for `abrain-age-key` backend, `identity` is intentionally
 * omitted because the path is fixed (`.vault-identity/master.age`). For
 * legacy ssh-key / gpg-file the absolute identity path is still recorded
 * for backwards compatibility, but those backends are also recommended
 * for re-init via /vault init (default abrain-age-key).
 */
export function writeBackendFile(abrainHome: string, info: BackendFile): void {
  const lines = [`backend=${info.backend}`];
  if (info.identity) lines.push(`identity=${info.identity}`);
  lines.push(""); // trailing newline

  const final = path.join(abrainHome, BACKEND_FILE);
  const tmp = `${final}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, lines.join("\n"), { mode: 0o600 });
  try {
    fs.renameSync(tmp, final);
  } catch (e: unknown) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

/** Read ~/.abrain/.vault-backend. Returns null if missing or malformed. */
export function readBackendFile(abrainHome: string): BackendFile | null {
  const p = path.join(abrainHome, BACKEND_FILE);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const obj: Record<string, string> = {};
  for (const ln of raw.split("\n")) {
    const m = ln.match(/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/);
    if (m) obj[m[1]!] = m[2]!;
  }
  if (!obj.backend) return null;
  // Validate backend value
  const valid: ReadonlySet<string> = new Set([
    "abrain-age-key", "ssh-key", "gpg-file", "passphrase-only", "macos", "secret-service", "pass",
  ]);
  if (!valid.has(obj.backend)) return null;
  return {
    backend: obj.backend as EncryptableBackend,
    identity: obj.identity,
  };
}

/**
 * Write ~/.abrain/.vault-pubkey containing the age public key (one line).
 * Mode 0644 — public key is not secret. Atomic.
 */
export function writePubkeyFile(abrainHome: string, publicKey: string): void {
  const final = path.join(abrainHome, PUBKEY_FILE);
  const tmp = `${final}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, publicKey + "\n", { mode: 0o644 });
  try {
    fs.renameSync(tmp, final);
  } catch (e: unknown) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

export function readPubkeyFile(abrainHome: string): string | null {
  const p = path.join(abrainHome, PUBKEY_FILE);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8").trim();
}
