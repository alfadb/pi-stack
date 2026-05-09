/**
 * abrain — vault backend detection (pure logic, dependency-injected).
 *
 * Detects which OS keychain / secret-storage backend this host can use
 * for the abrain master key. Implements the priority order from
 * docs/migration/vault-bootstrap.md §1:
 *
 *   1. $SECRETS_BACKEND env override (user forced)
 *   2. macOS: uname -s = Darwin → Keychain Services
 *   3. Linux + $DISPLAY or $WAYLAND_DISPLAY → Secret Service (libsecret)
 *   4. Linux + `pass` cmd + ~/.password-store/abrain/ → pass
 *   5. ~/.abrain/.vault-master.age exists → GPG-file fallback
 *   6. Otherwise → disabled (vault subsystem off, fail-closed)
 *
 * P0a scope: detection only. No master key generation, no keychain
 * writes, no vault file I/O. Subsequent P0 chunks layer those on top.
 *
 * The function is dependency-injected (commandExists / fileExists / platform)
 * so smoke tests can simulate every host shape without spawning real
 * subprocesses or touching disk.
 */

export type Backend =
  | "env-override"      // user forced via $SECRETS_BACKEND
  | "macos"             // macOS Keychain Services
  | "secret-service"    // Linux desktop libsecret (gnome-keyring / kwallet)
  | "pass"              // pass(1) password-store
  | "gpg-file"          // ~/.abrain/.vault-master.age (GPG-encrypted file)
  | "disabled";         // no backend available, vault off

export interface BackendCapabilities {
  /** keychain auto-unlocks within active OS/desktop session */
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
}

const VALID_BACKENDS_FOR_OVERRIDE: ReadonlySet<string> = new Set([
  "macos",
  "secret-service",
  "pass",
  "gpg-file",
  "disabled",
]);

const CAP_AUTO_UNLOCK: Record<Backend, boolean> = {
  "env-override": false, // resolved via overrideTarget
  "macos": true,
  "secret-service": true,
  "pass": false,         // requires gpg-agent / pass git pull manually
  "gpg-file": false,     // requires user GPG agent unlock
  "disabled": false,
};

/**
 * Run the §1 detection priority chain. Pure function — no side effects,
 * no logging, no I/O outside what `deps` provides.
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
    // invalid override → fall through to auto-detect (don't silently honor garbage)
  }

  // ── 2. macOS ─────────────────────────────────────────────────────────
  if (platform === "darwin") {
    return {
      backend: "macos",
      reason: "platform=darwin (Keychain Services)",
      capabilities: { autoUnlock: true, canRotate: false },
    };
  }

  // ── 3. Linux desktop (Secret Service via secret-tool) ────────────────
  // Require BOTH a desktop session env var AND the secret-tool CLI.
  // Without secret-tool we can't actually call the backend, even with $DISPLAY.
  if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    if (commandExists("secret-tool")) {
      const sessionVar = env.WAYLAND_DISPLAY ? "WAYLAND_DISPLAY" : "DISPLAY";
      return {
        backend: "secret-service",
        reason: `linux desktop (${sessionVar} set, secret-tool available)`,
        capabilities: { autoUnlock: true, canRotate: false },
      };
    }
    // fall through — desktop env but no secret-tool → try pass / gpg-file
  }

  // ── 4. pass(1) ───────────────────────────────────────────────────────
  if (commandExists("pass") && fileExists(`${home}/.password-store/abrain`)) {
    return {
      backend: "pass",
      reason: "pass(1) available + ~/.password-store/abrain/ exists",
      capabilities: { autoUnlock: false, canRotate: false },
    };
  }

  // ── 5. ~/.abrain/.vault-master.age (GPG-file fallback) ───────────────
  if (fileExists(`${home}/.abrain/.vault-master.age`)) {
    return {
      backend: "gpg-file",
      reason: "~/.abrain/.vault-master.age present (GPG-encrypted file)",
      capabilities: { autoUnlock: false, canRotate: false },
    };
  }

  // ── 6. Disabled (no backend available) ───────────────────────────────
  return {
    backend: "disabled",
    reason: buildDisabledReason(deps),
    capabilities: { autoUnlock: false, canRotate: false },
  };
}

function buildDisabledReason(deps: DetectDeps): string {
  const reasons: string[] = [];
  if (deps.platform !== "darwin") reasons.push("not macOS");
  if (deps.platform !== "linux" || (!deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY)) {
    reasons.push("no Linux desktop session");
  } else if (!deps.commandExists("secret-tool")) {
    reasons.push("secret-tool not on PATH");
  }
  if (!deps.commandExists("pass") || !deps.fileExists(`${deps.home}/.password-store/abrain`)) {
    reasons.push("no pass(1) password-store");
  }
  if (!deps.fileExists(`${deps.home}/.abrain/.vault-master.age`)) {
    reasons.push("no GPG-file fallback");
  }
  return `no backend matched (${reasons.join("; ")})`;
}

/** Format backend info for /vault status output. Pure formatter. */
export function formatStatus(info: BackendInfo, vaultDisabledFlag: boolean): string {
  const lines: string[] = [];
  if (vaultDisabledFlag) {
    lines.push("🔒 vault: disabled (~/.abrain/.state/vault-disabled flag set)");
    lines.push(`   detected backend: ${info.backend}`);
    lines.push(`   reason: ${info.reason}`);
    lines.push("   to re-enable: rm ~/.abrain/.state/vault-disabled");
    return lines.join("\n");
  }

  const target = info.backend === "env-override" ? info.overrideTarget : info.backend;
  if (info.backend === "disabled") {
    lines.push("🔒 vault: locked (no backend available)");
    lines.push(`   reason: ${info.reason}`);
    lines.push("   run `pi vault init` to set up");
  } else {
    lines.push(`🗝  vault: backend=${info.backend}${info.overrideTarget ? ` (→ ${info.overrideTarget})` : ""}`);
    lines.push(`   reason: ${info.reason}`);
    lines.push(`   auto-unlock: ${info.capabilities.autoUnlock ? "yes (active session)" : "no (manual unlock required)"}`);
    lines.push(`   key rotation: ${info.capabilities.canRotate ? "supported" : "not supported in current spec"}`);
    if (target && target !== "disabled") {
      lines.push("   note: P0a only detects the backend. master key generation lands in P0b.");
    }
  }
  return lines.join("\n");
}
