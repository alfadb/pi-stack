/**
 * abrain — vault backend detection (pure logic, dependency-injected).
 *
 * ADR 0019 rewrite (2026-05-15): abrain self-managed vault identity.
 *
 *   v1.4 (2026-05-09) put ssh-key auto-detect at Tier 1 because containers
 *   have ssh keys for git push. But dogfood + multi-model audit exposed
 *   three root problems:
 *
 *   1. Default ssh keys at `~/.ssh/id_*` are usually DIFFERENT keys per
 *      device (each machine ran its own ssh-keygen) — cross-device unlock
 *      requires physically copying the ssh secret, which conflicts with
 *      git push / ssh login on the second device.
 *   2. `.vault-backend` hardcoded `identity=/absolute/path` which doesn't
 *      survive cross-device sync.
 *   3. `passphrase-only` fallback could `init` but not `unlock` (reader
 *      path stdin: 'ignore' means age scrypt can't reach a tty).
 *
 *   ADR 0019 fixes this by giving abrain its OWN age keypair, not
 *   parasitic on system ssh / gpg / keychain state.
 *
 * Detection priority (ADR 0019 / Tier 1–Tier 4):
 *
 *   1. $SECRETS_BACKEND env override (user forced; invalid value falls through)
 *
 *   ── Tier 1 default (abrain self-managed) ───────────────────────────────
 *   2. abrain-age-key : `~/.abrain/.vault-identity/master.age` already
 *                       exists (already-initialized), OR `age-keygen` on
 *                       PATH (auto-detect target for first /vault init).
 *                       Identity is an age keypair owned by abrain;
 *                       secret 0600 + gitignored; pubkey enters git.
 *
 *   ── Tier 2 optimization (keychain-wrapped abrain identity) ────────────
 *   3. macos          : platform=darwin (Keychain Services via `security`)
 *   4. secret-service : Linux + (DISPLAY|WAYLAND_DISPLAY) + secret-tool
 *   5. pass           : pass(1) + ~/.password-store/abrain/
 *
 *   Tier 2 backends auto-detect but are SECOND priority — abrain-age-key
 *   covers cross-device + container + headless scenarios uniformly, while
 *   keychain only helps the specific desktop session.
 *
 *   ── Tier 3 explicit-only (legacy, requires manual --backend=) ─────────
 *   - ssh-key  : reuses ~/.ssh/id_* — problematic for cross-device.
 *                Must pass `/vault init --backend=ssh-key` AND knowingly
 *                accept the cross-device transport burden.
 *   - gpg-file : reuses GPG identity — same caveats as ssh-key.
 *   - passphrase-only : reader path requires tty pass-through which is
 *                       not yet implemented (roadmap P0d). Init flow
 *                       works but unlock will silently fail at next pi
 *                       restart. Stays as `--backend=passphrase-only`
 *                       explicit choice with a stderr warning.
 *
 *   ── Tier 4 final ───────────────────────────────────────────────────────
 *   6. disabled : no abrain-age-key candidate and no keychain backend
 *                 detected. /vault init refuses; vault is off.
 *
 * Container scenario (alfadb main dev): abrain-age-key wins because
 * `age-keygen` is on PATH (age v1.0+ is the only binary required for
 * this whole subsystem; it's already a dep for ssh-key path anyway).
 *
 * Function is dependency-injected (commandExists / fileExists / platform)
 * so smoke tests can simulate every host shape without subprocess or fs.
 */

export type Backend =
  | "env-override"      // user forced via $SECRETS_BACKEND
  // Tier 1 (ADR 0019 default)
  | "abrain-age-key"    // abrain self-managed age keypair at ~/.abrain/.vault-identity/
  // Tier 2 optimization (keychain-wrapped abrain identity)
  | "macos"             // macOS Keychain Services
  | "secret-service"    // Linux desktop libsecret (gnome-keyring / kwallet)
  | "pass"              // pass(1) password-store
  // Tier 3 explicit-only (legacy)
  | "ssh-key"           // age -R ssh.pub / age -d -i sshkey
  | "gpg-file"          // gpg --encrypt -r <id> / gpg --decrypt
  | "passphrase-only"   // age scrypt (-p); reader unimplemented (roadmap P0d)
  // Tier 4 final
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
  /** for ssh-key: path to the secret key (identity for `age -d -i ...`);
   *  for abrain-age-key: path to abrain's own identity secret */
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
   * NOTE (ADR 0019): only consulted when env override picks gpg-file;
   * auto-detect no longer prefers gpg-file over abrain-age-key.
   */
  gpgFirstSecretKey?: () => string | null;
}

const VALID_BACKENDS_FOR_OVERRIDE: ReadonlySet<string> = new Set([
  "abrain-age-key",
  "ssh-key",
  "gpg-file",
  "passphrase-only",
  "macos",
  "secret-service",
  "pass",
  "disabled",
]);

const CAP_AUTO_UNLOCK: Record<Exclude<Backend, "env-override">, boolean> = {
  "abrain-age-key": true,  // identity secret on disk 0600 — instant unlock
  "ssh-key": true,         // ssh-agent cache (or already-unlocked from git push)
  "gpg-file": true,        // gpg-agent cache TTL (assumes user-tuned ≥ 8h)
  "passphrase-only": false, // user types every pi start (reader unimplemented)
  "macos": true,
  "secret-service": true,
  "pass": false,           // requires gpg-agent / pass git pull manually
  "disabled": false,
};

/**
 * Path of the abrain-managed age identity files relative to abrain home.
 * Used both by detection (file existence → already initialized) and by
 * bootstrap/reader as the canonical location.
 */
export const VAULT_IDENTITY_DIR = ".vault-identity";
export const VAULT_IDENTITY_SECRET = ".vault-identity/master.age";
export const VAULT_IDENTITY_PUBKEY = ".vault-identity/master.age.pub";

/**
 * Run the ADR 0019 detection priority chain. Pure function — no side effects,
 * no logging, no I/O outside what `deps` provides.
 *
 * NOTE: ssh-key / gpg-file are NOT auto-detected anymore (ADR 0019). They
 * remain available via `$SECRETS_BACKEND=ssh-key` env override or
 * `/vault init --backend=ssh-key` explicit flag, both of which produce a
 * stderr warning about cross-device transport burden. Auto-detect defaults
 * to abrain-age-key so cross-device behavior is consistent.
 */
export function detectBackend(deps: DetectDeps): BackendInfo {
  const { env, platform, home, commandExists, fileExists } = deps;

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

  // ── 2. abrain-age-key (Tier 1 default, ADR 0019) ─────────────────────
  // If already initialized (identity secret on disk) — obviously chosen.
  // Otherwise check that `age-keygen` is available so /vault init can run.
  const identitySecret = `${home}/.abrain/${VAULT_IDENTITY_SECRET}`;
  if (fileExists(identitySecret)) {
    return {
      backend: "abrain-age-key",
      identity: identitySecret,
      reason: `abrain self-managed identity at ${identitySecret} (already initialized)`,
      capabilities: { autoUnlock: true, canRotate: false },
    };
  }
  if (commandExists("age-keygen")) {
    return {
      backend: "abrain-age-key",
      reason: "age-keygen available; /vault init will generate ~/.abrain/.vault-identity/ (abrain self-managed, ADR 0019)",
      capabilities: { autoUnlock: true, canRotate: false },
    };
  }

  // ── 3. macOS Keychain (Tier 2 optimization) ──────────────────────────
  // Wraps the abrain identity secret in macOS Keychain instead of on-disk.
  if (platform === "darwin" && commandExists("security")) {
    return {
      backend: "macos",
      reason: "macOS Keychain Services via security CLI (Tier 2 — wraps abrain identity in keychain)",
      capabilities: { autoUnlock: true, canRotate: false },
    };
  }

  // ── 4. Linux Secret Service (Tier 2 optimization) ────────────────────
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (commandExists("secret-tool")) {
      const sessionVar = env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : "DISPLAY";
      return {
        backend: "secret-service",
        reason: `linux desktop (${sessionVar} set, secret-tool available; Tier 2 — wraps abrain identity)`,
        capabilities: { autoUnlock: true, canRotate: false },
      };
    }
  }

  // ── 5. pass(1) (Tier 2 optimization) ─────────────────────────────────
  if (commandExists("pass") && fileExists(`${home}/.password-store/abrain`)) {
    return {
      backend: "pass",
      reason: "pass(1) available + ~/.password-store/abrain/ exists (Tier 2 — wraps abrain identity)",
      capabilities: { autoUnlock: false, canRotate: false },
    };
  }

  // ── 6. disabled (Tier 4 final) ───────────────────────────────────────
  // ADR 0019: no longer falls back to passphrase-only. Bare environments
  // without age-keygen / keychain present → vault stays disabled, user must
  // install age (apt install age / brew install age) or pick a Tier 3
  // explicit backend via /vault init --backend=ssh-key / gpg-file /
  // passphrase-only with the documented caveats.
  return {
    backend: "disabled",
    reason: "no abrain-age-key prerequisites (age-keygen missing) and no keychain backend detected; install age (`apt install age` / `brew install age`) and re-run /vault status, or pick a Tier 3 backend via /vault init --backend=<name>",
    capabilities: { autoUnlock: false, canRotate: false },
  };
}

/**
 * Initialized vault state — caller passes when ~/.abrain/.vault-backend
 * exists. Disambiguates 'system already set up' from 'system would set up
 * to abrain-age-key if you ran /vault init now'.
 */
export interface InitializedState {
  /** value of `backend=` from .vault-backend (one of EncryptableBackend) */
  backend: string;
  /** value of `identity=` from .vault-backend, if applicable */
  identity?: string;
  /** contents of ~/.abrain/.vault-pubkey, if readable */
  publicKey?: string;
  /** does ~/.abrain/.vault-master.age exist? (file backends only; not used for abrain-age-key) */
  vaultMasterPresent: boolean;
  /** mode bits of .vault-master.age, if present (for hygiene check display) */
  vaultMasterMode?: number;
  /** does ~/.abrain/.vault-identity/master.age exist? (abrain-age-key only) */
  identitySecretPresent?: boolean;
  /** mode bits of .vault-identity/master.age, if present */
  identitySecretMode?: number;
}

/**
 * Format /vault status output.
 *
 * Priority:
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

    if (initialized.backend === "abrain-age-key") {
      if (initialized.identitySecretPresent) {
        const modeStr = initialized.identitySecretMode != null
          ? `0${(initialized.identitySecretMode & 0o777).toString(8)}`
          : "unknown";
        const modeWarn = initialized.identitySecretMode != null
          && (initialized.identitySecretMode & 0o077) !== 0
          ? "  ⚠ group/other readable"
          : "";
        lines.push(`   identity secret: ~/.abrain/${VAULT_IDENTITY_SECRET} (${modeStr})${modeWarn}`);
      } else {
        lines.push("   ⚠ identity secret MISSING (~/.abrain/" + VAULT_IDENTITY_SECRET + ")");
        lines.push("   if this is a fresh clone on a new device, copy the identity from your other machine:");
        lines.push("     scp <other-host>:~/.abrain/" + VAULT_IDENTITY_SECRET + " ~/.abrain/" + VAULT_IDENTITY_SECRET);
        lines.push("   then chmod 0600 the file.");
      }
      lines.push("   note: vault writer/reader/release/$VAULT_* injection all live on this single identity.");
      return lines.join("\n");
    }

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
      lines.push("   ⚠ DEPRECATED backend (ADR 0019). Recommended migration:");
      lines.push("     rm -rf ~/.abrain/.vault-* ~/.abrain/.vault-identity ~/.abrain/vault/ ~/.abrain/projects/*/vault/");
      lines.push("     pi → /vault init  (default backend is now abrain-age-key)");
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
