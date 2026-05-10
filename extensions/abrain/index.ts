/**
 * abrain extension for pi-astack — alfadb digital twin / personal brain.
 *
 * Implements ADR 0014 (abrain-as-personal-brain). This file is the
 * extension entry point.
 *
 * Sub-pi enforcement (ADR 0014 invariant #6, vault-bootstrap §5 layer (b)):
 * the FIRST thing activate() does is check PI_ABRAIN_DISABLED. If set
 * to "1", we skip all registration — the sub-pi has no /vault command,
 * no abrain tools, nothing. This is the second of three enforcement
 * layers (the first is dispatch's spawn env override at
 * extensions/dispatch/index.ts; the third is the offline smoke
 * `smoke:vault-subpi-isolation`).
 *
 * P0a scope (this commit):
 *   - extension skeleton + activate() guard
 *   - platform backend detection (backend-detect.ts, pure logic)
 *   - `/vault status` slash command (read-only display)
 *
 * Out of scope for P0a (subsequent P0 chunks):
 *   - master key generation / OS keychain integration (P0b)
 *   - vaultWriter library + flock + per-key _meta (P0c)
 *   - onboarding TUI flow / `pi vault init` (P0d)
 *   - `/secret` command + Lane V wiring (after P0c)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectBackend, formatStatus, type BackendInfo, type DetectDeps, type InitializedState } from "./backend-detect";
import {
  createInstallTmpDir, generateMasterKey, cleanupInstallDir, execCapture,
} from "./bootstrap";
import {
  encryptMasterKey, writeBackendFile, writePubkeyFile, readBackendFile,
  type EncryptableBackend, type ExecFn,
} from "./keychain";
import {
  writeSecret, listSecrets, forgetSecret, validateKey,
  type VaultScope,
} from "./vault-writer";

// ── ~/.abrain layout constants (single source — referenced from spec §3) ──

const ABRAIN_HOME = path.join(os.homedir(), ".abrain");
const STATE_DIR = path.join(ABRAIN_HOME, ".state");
const VAULT_DISABLED_FLAG = path.join(STATE_DIR, "vault-disabled");

// ── Sub-pi enforce constants ────────────────────────────────────────────

const PI_ABRAIN_DISABLED = "PI_ABRAIN_DISABLED";

// ── Runtime helpers (the dependencies detectBackend needs) ──────────────

function realCommandExists(cmd: string): boolean {
  // `command -v` is shell built-in; use `which` via execFile. POSIX `which`
  // returns 0 with the path on stdout when found, non-zero otherwise.
  // execFileSync throws on non-zero — wrap in try/catch.
  try {
    execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function realFileExists(p: string): boolean {
  try {
    fs.statSync(p); // follows symlinks; ok for our use cases
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up the first GPG secret key id by parsing
 * `gpg --list-secret-keys --with-colons`. Returns null if no secret keys
 * or gpg fails. Used by detectBackend's Tier 1 gpg-file path.
 *
 * Output format ref: gpg(1) --with-colons. We grab the `sec:` line and
 * field 5 (long key id, e.g. ABCD1234EF567890).
 */
function realGpgFirstSecretKey(): string | null {
  try {
    const out = execFileSync("gpg", ["--list-secret-keys", "--with-colons"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000, // gpg-agent slowness should not block pi start
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("sec:")) {
        const fields = line.split(":");
        const keyId = fields[4]; // 5th field (1-indexed: keyid)
        if (keyId && keyId.length > 0) return keyId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildRealDeps(): DetectDeps {
  return {
    commandExists: realCommandExists,
    fileExists: realFileExists,
    platform: process.platform,
    home: os.homedir(),
    env: {
      SECRETS_BACKEND: process.env.SECRETS_BACKEND,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    },
    gpgFirstSecretKey: realGpgFirstSecretKey,
  };
}

// ── Public API: pure status query (no side effects) ─────────────────────

export interface VaultStatus {
  /** sub-pi guard fired — abrain is fully disabled in this process */
  subPiDisabled: boolean;
  /** ~/.abrain/.state/vault-disabled flag is present (user opted out) */
  userDisabledFlag: boolean;
  /** detected backend info (always populated, even when disabled) */
  backend: BackendInfo;
}

export function getVaultStatus(deps: DetectDeps = buildRealDeps()): VaultStatus {
  return {
    subPiDisabled: process.env[PI_ABRAIN_DISABLED] === "1",
    userDisabledFlag: realFileExists(VAULT_DISABLED_FLAG),
    backend: detectBackend(deps),
  };
}

// ── Extension activation ────────────────────────────────────────────────

interface CommandRegistry {
  registerCommand?: (name: string, options: {
    description?: string;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
    handler: (args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
  }) => void;
}

export default function activate(pi: ExtensionAPI): void {
  // ── Sub-pi enforce: vault-bootstrap.md §5 layer (b) ───────────────────
  // If PI_ABRAIN_DISABLED=1, register nothing. Sub-pi sees no /vault
  // command, no abrain tool, nothing — this is the runtime invariant
  // backing ADR 0014 invariant #6 layer 2. The dispatch extension
  // (extensions/dispatch/index.ts) sets this env var when spawning
  // sub-pi; the `smoke:vault-subpi-isolation` smoke verifies that.
  if (process.env[PI_ABRAIN_DISABLED] === "1") return;

  const registry = pi as unknown as CommandRegistry;
  if (typeof registry.registerCommand !== "function") return;

  // /secret command — vault write/list/forget (P0c.write).
  // Read paths (release / bash injection) are P0c.read.
  registry.registerCommand("secret", {
    description: "Vault secrets (write only): /secret set --global <key>=<value> | /secret list --global | /secret forget --global <key>",
    getArgumentCompletions(prefix: string) {
      const items = [
        "set --global ",
        "list --global",
        "forget --global ",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { ui: { notify(message: string, type?: string): void } }): Promise<void> {
      try {
        await handleSecret(args.trim(), ctx.ui);
      } catch (err: any) {
        ctx.ui.notify(`/secret: ${err.message}`, "warning");
      }
    },
  });

  registry.registerCommand("vault", {
    description: "Vault status / control: /vault status | /vault init [--backend=<name>]",
    getArgumentCompletions(prefix: string) {
      const items = [
        "status",
        "init",
        "init --backend=ssh-key",
        "init --backend=gpg-file",
        "init --backend=passphrase-only",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { ui: { notify(message: string, type?: string): void } }): Promise<void> {
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] || "status";
      switch (sub) {
        case "status":
          handleStatus(ctx.ui);
          return;
        case "init":
          await handleInit(trimmed.slice("init".length).trim(), ctx.ui);
          return;
        default:
          ctx.ui.notify(`/vault: unknown subcommand '${sub}'. Available: status, init`, "warning");
      }
    },
  });
}

// ── /vault init ─────────────────────────────────────────────────
//
// P0b non-interactive form: `/vault init --backend=<name>`. Picks the
// first auto-detected backend if no --backend flag, but only if that
// backend is in {ssh-key, gpg-file} (we don't auto-pick passphrase-only
// or keychain backends — those need explicit user choice).
// Full TUI onboarding wizard (vault-bootstrap §4) is P0d.

interface InitOptions {
  backend?: EncryptableBackend;
  force?: boolean;
}

function parseInitArgs(args: string): InitOptions {
  const opts: InitOptions = {};
  for (const tok of args.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^--backend=(.+)$/);
    if (m) {
      const v = m[1] as EncryptableBackend;
      const valid: ReadonlySet<string> = new Set([
        "ssh-key", "gpg-file", "passphrase-only",
        "macos", "secret-service", "pass",
      ]);
      if (!valid.has(v)) throw new Error(`invalid backend: ${v}`);
      opts.backend = v;
      continue;
    }
    if (tok === "--force") { opts.force = true; continue; }
    throw new Error(`unknown init flag: ${tok}`);
  }
  return opts;
}

async function handleInit(rawArgs: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Idempotent guard: if vault already initialized, refuse without --force.
  const existing = readBackendFile(ABRAIN_HOME);
  if (existing) {
    ui.notify(
      `vault already initialized (backend=${existing.backend}). Use \`/vault init --force\` to re-init.`,
      "warning",
    );
    // Note: --force not yet supported; intentional minimum scope for P0b.
    return;
  }

  let opts: InitOptions;
  try {
    opts = parseInitArgs(rawArgs);
  } catch (err: any) {
    ui.notify(`/vault init: ${err.message}`, "warning");
    return;
  }

  // Resolve backend + identity
  let backend: EncryptableBackend;
  let identity: string | undefined;
  if (opts.backend) {
    backend = opts.backend;
    // For ssh-key / gpg-file, fill identity from detection if user didn't override
    const detected = detectBackend(buildRealDeps());
    if (backend === "ssh-key") {
      if (detected.backend === "ssh-key") identity = detected.identity;
      else if (detected.backend === "env-override" && detected.overrideTarget === "ssh-key") identity = detected.identity;
      else identity = `${os.homedir()}/.ssh/id_ed25519`; // best guess
    } else if (backend === "gpg-file") {
      if (detected.backend === "gpg-file") identity = detected.gpgRecipient;
      else throw new Error("gpg-file requested but no GPG secret key detected. install / import GPG identity first.");
    }
  } else {
    // No --backend flag: auto-pick from detection, but only ssh-key or gpg-file
    const detected = detectBackend(buildRealDeps());
    if (detected.backend === "ssh-key") {
      backend = "ssh-key";
      identity = detected.identity;
    } else if (detected.backend === "gpg-file") {
      backend = "gpg-file";
      identity = detected.gpgRecipient;
    } else {
      ui.notify(
        `/vault init: cannot auto-pick backend (detected '${detected.backend}'). ` +
        `Pass --backend=<name> explicitly. P0b non-interactive form supports ssh-key / gpg-file auto-pick.`,
        "warning",
      );
      return;
    }
  }

  await runInit(backend, identity, ui);
}

/**
 * Execute the §3 transactional flow. Used by handleInit but exported as a
 * pure function so smoke can drive it without TUI ceremony.
 */
export async function runInit(
  backend: EncryptableBackend,
  identity: string | undefined,
  ui: { notify(message: string, type?: string): void },
  exec: ExecFn = realExec,
  abrainHome: string = ABRAIN_HOME,
): Promise<{ publicKey: string; warnings: string[] }> {
  // (0) install tmp
  fs.mkdirSync(abrainHome, { recursive: true });
  const installTmp = createInstallTmpDir(abrainHome);
  let warnings: string[] = [];
  let publicKey = "";

  try {
    // (1) age-keygen
    ui.notify("generating age master keypair...", "info");
    const { secretKeyPath, publicKey: pub } = await generateMasterKey(installTmp);
    publicKey = pub;
    ui.notify(`master public key: ${pub}`, "info");

    // (2) backend.encrypt
    const vaultMasterEncryptedPath = path.join(abrainHome, ".vault-master.age");
    const isFileBackend = backend === "ssh-key" || backend === "gpg-file" || backend === "passphrase-only";

    // Defense: file-backend output must not pre-exist (avoid silent overwrite)
    if (isFileBackend && fs.existsSync(vaultMasterEncryptedPath)) {
      throw new Error(
        `${vaultMasterEncryptedPath} already exists. Refusing to overwrite. ` +
        `Run \`rm ${vaultMasterEncryptedPath}\` first if you really want to re-init.`,
      );
    }

    ui.notify(`encrypting master key via backend=${backend}...`, "info");
    await encryptMasterKey(backend, {
      masterSecretPath: secretKeyPath,
      masterPublicKey: publicKey,
      identity,
      vaultMasterEncryptedPath,
      user: process.env.USER,
    }, exec);

    // (3) write .vault-pubkey + .vault-backend (atomic, both files)
    writePubkeyFile(abrainHome, publicKey);
    writeBackendFile(abrainHome, { backend, identity });
  } finally {
    // (4) cleanup ALWAYS — secret must not survive an error
    warnings = await cleanupInstallDir(installTmp);
  }

  for (const w of warnings) ui.notify(`vault init warning: ${w}`, "warning");
  ui.notify(`vault initialized (backend=${backend}). Run /vault status to verify.`, "info");
  return { publicKey, warnings };
}

// Real exec impl wrapping execCapture from bootstrap (re-exported for runInit default)
const realExec: ExecFn = async (cmd, args, opts) => {
  return execCapture(cmd, args, opts);
};

// ── /secret command handler ─────────────────────────────────────
//
// MVP P0c.write supports ONLY --global. Project-level vault depends on
// resolveActiveProject(cwd) (ADR 0014 P1) which is not yet implemented.
// Without --global the command refuses with an actionable message.

async function handleSecret(args: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Pre-flight: vault must be initialized
  const backend = readBackendFile(ABRAIN_HOME);
  if (!backend) {
    ui.notify("vault not initialized. run `/vault init` first.", "warning");
    return;
  }

  // First token determines the subcommand
  const tokens = args.split(/\s+/).filter(Boolean);
  const sub = tokens[0] || "";

  // ── set ───────────────────────────────────────────────────────
  if (sub === "set") {
    // Parse remaining tokens — must include --global and a `key=value` pair
    const rest = tokens.slice(1);
    let globalFlag = false;
    const positional: string[] = [];
    for (const t of rest) {
      if (t === "--global") globalFlag = true;
      else positional.push(t);
    }
    if (!globalFlag) {
      ui.notify(
        "/secret set: P0c.write MVP requires explicit --global flag. " +
        "Project-level scope needs resolveActiveProject (ADR 0014 P1, not implemented yet).",
        "warning",
      );
      return;
    }
    // join positional back into the value spec — value may contain spaces
    // e.g. `/secret set --global token=abc def ghi` → key=token, value="abc def ghi"
    const valueSpec = positional.join(" ");
    const eqIdx = valueSpec.indexOf("=");
    if (eqIdx <= 0) {
      ui.notify("/secret set: expected `<key>=<value>` after --global", "warning");
      return;
    }
    const key = valueSpec.slice(0, eqIdx).trim();
    let value: string | null = valueSpec.slice(eqIdx + 1);
    try {
      validateKey(key);
    } catch (err: any) {
      ui.notify(`/secret set: invalid key: ${err.message}`, "warning");
      value = null;
      return;
    }
    if (!value) {
      ui.notify("/secret set: value cannot be empty", "warning");
      return;
    }

    try {
      const result = await writeSecret({
        abrainHome: ABRAIN_HOME,
        scope: "global",
        key,
        value,
      });
      // best-effort: clear the local reference (V8 may still have copies)
      value = null;
      ui.notify(`/secret set: wrote global:${key} → ${path.relative(ABRAIN_HOME, result.encryptedPath)}`, "info");
    } catch (err: any) {
      value = null; // clear before reporting error
      ui.notify(`/secret set failed: ${err.message}`, "warning");
    }
    return;
  }

  // ── list ──────────────────────────────────────────────────────
  if (sub === "list") {
    const rest = tokens.slice(1);
    let globalFlag = false;
    for (const t of rest) {
      if (t === "--global") globalFlag = true;
    }
    if (!globalFlag) {
      ui.notify(
        "/secret list: P0c.write MVP requires explicit --global flag. " +
        "Project-level listing needs resolveActiveProject (ADR 0014 P1).",
        "warning",
      );
      return;
    }
    const items = listSecrets(ABRAIN_HOME, "global");
    if (items.length === 0) {
      ui.notify("/secret list (global): no secrets yet", "info");
      return;
    }
    const lines: string[] = [`global vault — ${items.length} key(s):`];
    for (const item of items) {
      const status = item.forgotten ? "  [forgotten]" : "";
      const desc = item.description ? `  — ${item.description}` : "";
      const created = item.created ? ` (since ${item.created})` : "";
      lines.push(`  ${item.key}${status}${created}${desc}`);
    }
    ui.notify(lines.join("\n"), "info");
    return;
  }

  // ── forget ────────────────────────────────────────────────────
  if (sub === "forget") {
    const rest = tokens.slice(1);
    let globalFlag = false;
    let key: string | null = null;
    for (const t of rest) {
      if (t === "--global") globalFlag = true;
      else if (!key) key = t;
    }
    if (!globalFlag) {
      ui.notify(
        "/secret forget: P0c.write MVP requires explicit --global flag.",
        "warning",
      );
      return;
    }
    if (!key) {
      ui.notify("/secret forget --global <key>: missing key", "warning");
      return;
    }
    try {
      validateKey(key);
    } catch (err: any) {
      ui.notify(`/secret forget: invalid key: ${err.message}`, "warning");
      return;
    }
    try {
      const result = await forgetSecret(ABRAIN_HOME, "global", key);
      if (result.removed) {
        ui.notify(`/secret forget: removed global:${key}`, "info");
      } else {
        ui.notify(`/secret forget: global:${key} was not present (no-op, audit row recorded)`, "info");
      }
    } catch (err: any) {
      ui.notify(`/secret forget failed: ${err.message}`, "warning");
    }
    return;
  }

  ui.notify(
    `/secret: unknown subcommand '${sub}'. ` +
    `available: set / list / forget (all require --global in P0c.write MVP)`,
    "warning",
  );
}

function handleStatus(ui: { notify(message: string, type?: string): void }): void {
  const status = getVaultStatus();
  if (status.subPiDisabled) {
    // Should never happen — we returned early in activate(). Belt-and-suspenders.
    ui.notify("🔒 vault: disabled (PI_ABRAIN_DISABLED=1, sub-pi context)", "info");
    return;
  }

  // v1.4.2: prefer .vault-backend (init record) over detection. Detection
  // is only used when vault is not yet initialized. See vault-bootstrap §4.1.
  const initialized = readInitializedState(ABRAIN_HOME);
  ui.notify(formatStatus(status.backend, status.userDisabledFlag, initialized), "info");
}

/**
 * Read everything formatStatus needs to render the 'initialized' state.
 * Returns null if .vault-backend doesn't exist (= vault not yet initialized).
 * Best-effort on optional bits (.vault-pubkey, .vault-master.age) — a
 * missing optional doesn't make the state unreadable.
 */
function readInitializedState(abrainHome: string): InitializedState | null {
  const backendInfo = readBackendFile(abrainHome);
  if (!backendInfo) return null;

  const result: InitializedState = {
    backend: backendInfo.backend,
    identity: backendInfo.identity,
    vaultMasterPresent: false,
  };

  // .vault-pubkey is best-effort
  try {
    const pkPath = path.join(abrainHome, ".vault-pubkey");
    if (fs.existsSync(pkPath)) {
      result.publicKey = fs.readFileSync(pkPath, "utf8").trim();
    }
  } catch { /* ignore */ }

  // .vault-master.age existence + mode (file backends only)
  try {
    const mkPath = path.join(abrainHome, ".vault-master.age");
    if (fs.existsSync(mkPath)) {
      result.vaultMasterPresent = true;
      result.vaultMasterMode = fs.statSync(mkPath).mode;
    }
  } catch { /* ignore */ }

  return result;
}
