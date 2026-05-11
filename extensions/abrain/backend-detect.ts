/**
 * abrain — vault backend detection (pure logic, dependency-injected).
 *
 * v1.4 rewrite (2026-05-09): desktop-bias correction.
 *
 *   v1.0-1.3 prioritized OS keychain (macOS Keychain / Linux Secret Service)
 *   as Tier 1 backends. The alfadb main dev environment is a Linux container
 *   with no desktop session, no secret-tool, and no GPG keyring — so the
 *   priority chain detected `disabled` even though the host had a perfectly
 *   working ssh key. design-from-stereotype error.
 *
 *   v1.4 reorders the chain around portable identity (which most dev users
 *   have) and demotes desktop keychain to optimization tier. See
 *   docs/migration/vault-bootstrap.md §1 for the full matrix.
 *
 * Detection priority (v1.4):
 *
 *   1. $SECRETS_BACKEND env override (user forced; invalid value falls through)
 *
 *   ── Tier 1 primary (covers nearly all dev users) ───────────────────────
 *   2. ssh-key  : ~/.ssh/id_ed25519(.pub) or ~/.ssh/id_rsa(.pub) both exist
 *                 (age natively encrypts to ssh public keys; ssh-agent provides
 *                 cache equivalent to keychain auto-unlock)
 *   3. gpg-file : `gpg` CLI on PATH and user has at least one secret key
 *                 (gpg-agent cache TTL = unlock equivalent)
 *
 *   ── Tier 2 optimization (use if available, more convenient UX) ─────────
 *   4. macos          : platform=darwin (Keychain Services via `security`)
 *   5. secret-service : Linux + (DISPLAY|WAYLAND_DISPLAY) + secret-tool
 *   6. pass           : pass(1) + ~/.password-store/abrain/
 *
 *   ── Tier 1 fallback (always last before disabled) ──────────────────────
 *   7. passphrase-only: age scrypt mode; main pi prompts on /dev/tty at
 *                       startup. sub-pi has no tty but is also barred by
 *                       PI_ABRAIN_DISABLED=1 so this is moot for sub-pi.
 *
 *   8. disabled : (extremely rare — passphrase-only catches almost everyone)
 *
 * Container scenario (alfadb main dev): ssh-key wins via path #2 because
 * the container has ssh keys for `git push` and ssh-agent already unlocked.
 * No desktop session needed.
 *
 * Function is dependency-injected (commandExists / fileExists / platform)
 * so smoke tests can simulate every host shape without subprocess or fs.
 */

export type Backend =
  | "env-override"      // user forced via $SECRETS_BACKEND
  // Tier 1
  | "ssh-key"           // age -R ssh.pub / age -d -i sshkey
  | "gpg-file"          // gpg --encrypt -r <id> / gpg --decrypt
  | "passphrase-only"   // age scrypt (-p) — fallback, requires tty
  // Tier 2 optimization
  | "macos"             // macOS Keychain Services
  | "secret-service"    // Linux desktop libsecret (gnome-keyring / kwallet)
  | "pass"              // pass(1) password-store
  // Final
  | "disabled";         // no backend available, vault off

export interface BackendCapabilities {
  /** keychain auto-unlocks within active OS/desktop session or via agent cache */
  autoUnlock: boolean;
  /** master key rotation supported in current spec (always false for now) */
  canRotate: boolean;
}

export interface BackendInfo {
  backend: Backend;
  /** human-readable reason this backend was selected (for /vault status) */
  reason: string;
  /** if backend is "env-override", the actual underlying backend the user picked */
  overrideTarget?: Exclude<Backend, "env-override" | "disabled">;
  /** for ssh-key: path to the secret key (identity for `age -d -i ...`) */
  identity?: string;
  /** for gpg-file: GPG key id (the recipient passed to `gpg --encrypt -r ...`) */
  gpgRecipient?: string;
  capabilities: BackendCapabilities;
}

export interface DetectDeps {
  /** returns true if `cmd` is on PATH */
  commandExists: (cmd: string) => boolean;
  /** returns true if file/dir exists (no follow) */
  fileExists: (path: string) => boolean;
  /** node platform string ("darwin" | "linux" | "win32" | ...) */
  platform: NodeJS.Platform;
  /** $HOME of the current user (used to resolve ~/...) */
  home: string;
  /** subset of process.env we care about */
  env: {
    SECRETS_BACKEND?: string;
    DISPLAY?: string;
    WAYLAND_DISPLAY?: string;
  };
  /**
   * Returns first GPG key id with a secret key, or null if no secret keys.
   * Equivalent to `gpg --list-secret-keys --with-colons | awk -F: '/^sec/{print $5; exit}'`.
   * Injected so smoke can simulate the GPG keyring without invoking gpg.
   */
  gpgFirstSecretKey?: () => string | null;
}

const VALID_BACKENDS_FOR_OVERRIDE: ReadonlySet<string> = new Set([
  "ssh-key",
  "gpg-file",
  "passphrase-only",
  "macos",
  "secret-service",
  "pass",
  "disabled",
]);

const CAP_AUTO_UNLOCK: Record<Exclude<Backend, "env-override">, boolean> = {
  "ssh-key": true,         // ssh-agent cache (or already-unlocked from git push)
  "gpg-file": true,        // gpg-agent cache TTL (assumes user-tuned ≥ 8h)
  "passphrase-only": false, // user types every pi start
  "macos": true,
  "secret-service": true,
  "pass": false,           // requires gpg-agent / pass git pull manually
  "disabled": false,
};

/**
 * Run the v1.4 detection priority chain. Pure function — no side effects,
 * no logging, no I/O outside what `deps` provides.
 */
export function detectBackend(deps: DetectDeps): BackendInfo {
  const { env, platform, home, commandExists, fileExists, gpgFirstSecretKey } = deps;

  // ── 1. $SECRETS_BACKEND env override ─────────────────────────────────
  const override = (env.SECRETS_BACKEND ?? "").trim().toLowerCase();
  if (override) {
    if (VALID_BACKENDS_FOR_OVERRIDE.has(override)) {
      const target = override as Exclude<Backend, "env-override">;
      return {
        backend: "env-override",
        overrideTarget: target === "disabled" ? undefined : target,
        reason: `$SECRETS_BACKEND=${override}`,
        capabilities: {
          autoUnlock: CAP_AUTO_UNLOCK[target],
          canRotate: false,
        },
      };
    }
    // invalid override → fall through (don't silently honor garbage)
  }

  // ── 2. ssh-key (Tier 1 primary, container-friendly) ──────────────────
  // Require BOTH the secret key AND the .pub. age needs the .pub to encrypt
  // (age -R sshkey.pub) and the secret to decrypt (age -d -i sshkey).
  // Try ed25519 first (modern), then rsa (legacy fallback).
  const sshCandidates = [
    `${home}/.ssh/id_ed25519`,
    `${home}/.ssh/id_rsa`,
  ];
  for (const sshSecret of sshCandidates) {
    if (fileExists(sshSecret) && fileExists(`${sshSecret}.pub`)) {
      const keyType = sshSecret.endsWith("ed25519") ? "ed25519" : "rsa";
      return {
        backend: "ssh-key",
        identity: sshSecret,
        reason: `ssh ${keyType} key at ${sshSecret} (age native ssh recipient support)`,
        capabilities: { autoUnlock: true, canRotate: false },
      };
    }
  }

  // ── 3. gpg-file (Tier 1 primary) ─────────────────────────────────────
  // Require BOTH gpg CLI AND a secret key in the user's keyring. Just having
  // gpg installed isn't enough — many systems have it without any keys.
  if (commandExists("gpg") && gpgFirstSecretKey) {
    const recipient = gpgFirstSecretKey();
    if (recipient) {
      return {
        backend: "gpg-file",
        gpgRecipient: recipient,
        reason: `gpg secret key 0x${recipient} (gpg-agent cache for unlock)`,
        capabilities: { autoUnlock: true, canRotate: false },
      };
    }
  }

  // ── 4. macOS Keychain (Tier 2 optimization) ──────────────────────────
  if (platform === "darwin" && commandExists("security")) {
    return {
      backend: "macos",
      reason: "macOS Keychain Services via security CLI",
      capabilities: { autoUnlock: true, canRotate: false },
    };
  }

  // ── 5. Linux Secret Service (Tier 2 optimization) ────────────────────
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (commandExists("secret-tool")) {
      const sessionVar = env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : "DISPLAY";
      return {
        backend: "secret-service",
        reason: `linux desktop (${sessionVar} set, secret-tool available)`,
        capabilities: { autoUnlock: true, canRotate: false },
      };
    }
  }

  // ── 6. pass(1) (Tier 2 optimization) ─────────────────────────────────
  if (commandExists("pass") && fileExists(`${home}/.password-store/abrain`)) {
    return {
      backend: "pass",
      reason: "pass(1) available + ~/.password-store/abrain/ exists",
      capabilities: { autoUnlock: false, canRotate: false },
    };
  }

  // ── 7. passphrase-only (Tier 1 fallback) ─────────────────────────────
  // Always selectable as long as abrain extension is loaded (we ARE running,
  // so by definition main pi can prompt on /dev/tty when needed). sub-pi
  // never reaches loadMasterKey because PI_ABRAIN_DISABLED=1 short-circuits
  // earlier. So passphrase-only is a safe universal fallback.
  return {
    backend: "passphrase-only",
    reason: "no portable identity / keychain backend matched; falling back to age scrypt (will prompt on each pi start)",
    capabilities: { autoUnlock: false, canRotate: false },
  };

  // Note: "disabled" is no longer reached via auto-detection in v1.4 —
  // passphrase-only catches everyone. "disabled" only happens via:
  //   - $SECRETS_BACKEND=disabled
  //   - ~/.abrain/.state/vault-disabled flag (handled in index.ts, not here)
}

/**
 * Initialized vault state — caller passes when ~/.abrain/.vault-backend
 * exists. Disambiguates 'system already set up' from 'system would set up
 * to ssh-key if you ran /vault init now'.
 */
export interface InitializedState {
  /** value of `backend=` from .vault-backend (one of EncryptableBackend) */
  backend: string;
  /** value of `identity=` from .vault-backend, if applicable */
  identity?: string;
  /** contents of ~/.abrain/.vault-pubkey, if readable */
  publicKey?: string;
  /** does ~/.abrain/.vault-master.age exist? (file backends only) */
  vaultMasterPresent: boolean;
  /** mode bits of .vault-master.age, if present (for hygiene check display) */
  vaultMasterMode?: number;
}

/**
 * Format /vault status output (v1.4.2).
 *
 * Priority (matches vault-bootstrap.md §4.1 table):
 *   sub-pi disabled  > user-disabled flag  > initialized  > detection
 *
 * Pure formatter — no I/O. Caller (index.ts handleStatus) reads files and
 * passes everything in.
 */
export function formatStatus(
  info: BackendInfo,
  vaultDisabledFlag: boolean,
  initialized: InitializedState | null = null,
): string {
  const lines: string[] = [];

  if (vaultDisabledFlag) {
    lines.push("🔒 vault: disabled (~/.abrain/.state/vault-disabled flag set)");
    if (initialized) {
      lines.push(`   was initialized as: backend=${initialized.backend}`);
    } else {
      lines.push(`   detected backend: ${info.backend}`);
      lines.push(`   reason: ${info.reason}`);
    }
    lines.push("   to re-enable: rm ~/.abrain/.state/vault-disabled");
    return lines.join("\n");
  }

  // ── State A: initialized (vault-backend file exists) ────────────────
  if (initialized) {
    lines.push(`🗝  vault: initialized   backend=${initialized.backend}`);
    if (initialized.identity) lines.push(`   identity: ${initialized.identity}`);
    if (initialized.publicKey) lines.push(`   public key: ${initialized.publicKey}`);

    const isFileBackend =
      initialized.backend === "ssh-key" ||
      initialized.backend === "gpg-file" ||
      initialized.backend === "passphrase-only";
    if (isFileBackend) {
      if (initialized.vaultMasterPresent) {
        const modeStr = initialized.vaultMasterMode != null
          ? `0${(initialized.vaultMasterMode & 0o777).toString(8)}`
          : "unknown";
        const modeWarn = initialized.vaultMasterMode != null
          && (initialized.vaultMasterMode & 0o077) !== 0
          ? "  ⚠ group/other readable"
          : "";
        lines.push(`   master encrypted: ~/.abrain/.vault-master.age (${modeStr})${modeWarn}`);
      } else {
        lines.push("   ⚠ master encrypted file MISSING (~/.abrain/.vault-master.age)");
        lines.push("   vault is in inconsistent state. consider re-running /vault init");
      }
    } else {
      lines.push(`   master stored in: ${describeKeychainLocation(initialized.backend)}`);
    }

    lines.push("   note: P0c.write / P0c.read / vault_release LLM tool / $VAULT_* bash injection / project vault routing all implemented.");
    return lines.join("\n");
  }

  // ── State B/D: not initialized; show detection result ──────────────
  const target = info.backend === "env-override" ? info.overrideTarget : info.backend;
  if (info.backend === "disabled") {
    lines.push("🔒 vault: not initialized; no backend available");
    lines.push(`   reason: ${info.reason}`);
    lines.push("   run `/vault init` to set up");
  } else {
    lines.push(`🔒 vault: not initialized; ready to init`);
    lines.push(`   detected backend: ${info.backend}${info.overrideTarget ? ` (→ ${info.overrideTarget})` : ""}`);
    lines.push(`   reason: ${info.reason}`);
    if (info.identity) lines.push(`   identity: ${info.identity}`);
    if (info.gpgRecipient) lines.push(`   gpg recipient: 0x${info.gpgRecipient}`);
    lines.push(`   auto-unlock: ${info.capabilities.autoUnlock ? "yes (agent cache or active session)" : "no (manual unlock required)"}`);
    if (target && target !== "disabled") {
      lines.push(`   to init: \`/vault init\`  (will use detected backend) or \`/vault init --backend=<name>\``);
    }
  }
  return lines.join("\n");
}

function describeKeychainLocation(backend: string): string {
  switch (backend) {
    case "macos": return "macOS Keychain (service=alfadb-abrain-master)";
    case "secret-service": return "Secret Service (service=abrain key=master)";
    case "pass": return "pass (abrain/master)";
    default: return `[${backend} backend]`;
  }
}
