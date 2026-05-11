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
import { releaseSecret, type ReleaseSecretResult } from "./vault-reader";
import {
  authKey,
  prepareGlobalVaultBashCommand,
  redactVaultBashContent,
  scopeLabel,
  VAULT_BASH_OUTPUT_AUTH_CHOICES,
  withheldVaultBashContent,
  type VaultBashRunRecord,
} from "./vault-bash";

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

interface EventRegistry {
  on?: (event: string, handler: (event: any, ctx: { ui?: VaultReleaseUi; signal?: AbortSignal }) => Promise<unknown> | unknown) => void;
}

interface ToolRegistry {
  registerTool?: (tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: { ui?: VaultReleaseUi }) => Promise<unknown> | unknown;
  }) => void;
}

interface VaultReleaseUi {
  notify?(message: string, type?: string): void;
  select?(title: string, items: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
  confirm?(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
}

export const VAULT_RELEASE_AUTH_CHOICES = ["No", "Deny + remember", "Yes once", "Session"] as const;

const releaseSessionGrants = new Set<string>();
const releaseRememberDenies = new Set<string>();
const bashOutputSessionGrants = new Set<string>();
const vaultBashRuns = new Map<string, VaultBashRunRecord>();

function vaultReleaseChoiceReason(choice: string | undefined): string {
  if (!choice) return "cancelled";
  return choice.toLowerCase().replace(/\s*\+\s*/g, "_").replace(/\s+/g, "_");
}

function toolJson(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

async function authorizeVaultBashOutput(ui: VaultReleaseUi | undefined, grantKey: string, releases: ReleaseSecretResult[], signal?: AbortSignal): Promise<"release" | "withhold"> {
  if (bashOutputSessionGrants.has(grantKey)) return "release";
  if (!ui?.select) return "withhold";
  const keyList = releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  // Fail closed in non-interactive/API runners that may auto-return the first
  // select item: put the deny option first. Interactive users can still move to
  // an explicit release choice.
  const choice = await ui.select(
    "Release vault-protected bash output?",
    [...VAULT_BASH_OUTPUT_AUTH_CHOICES],
    { signal },
  );
  if (choice === "Yes once") return "release";
  if (choice === "Session") {
    bashOutputSessionGrants.add(grantKey);
    return "release";
  }
  ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
  return "withhold";
}

async function authorizeVaultRelease(ui: VaultReleaseUi | undefined, scope: VaultScope, key: string, reason: string | undefined, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gate = authKey(scope, key);
  if (releaseRememberDenies.has(gate)) return { ok: false, reason: "denied_remembered" };
  if (releaseSessionGrants.has(gate)) return { ok: true };
  if (!ui) return { ok: false, reason: "ui_unavailable" };

  const warning = [
    `Release vault secret ${gate} to the LLM?`,
    reason ? `Reason: ${reason}` : undefined,
    "⚠ Plaintext will enter this model context. Redaction is best-effort and does not cover base64/hex/xxd/xor transformations.",
  ].filter(Boolean).join("\n");

  if (typeof ui.select === "function") {
    // Fail closed in non-interactive/API runners that may auto-return the first
    // select item: put deny choices before explicit release choices.
    const choice = await ui.select("Vault release authorization", [...VAULT_RELEASE_AUTH_CHOICES], { signal });
    if (choice === "Yes once") return { ok: true };
    if (choice === "Session") {
      releaseSessionGrants.add(gate);
      return { ok: true };
    }
    if (choice === "Deny + remember") releaseRememberDenies.add(gate);
    return { ok: false, reason: vaultReleaseChoiceReason(choice) };
  }

  if (typeof ui.confirm === "function") {
    const ok = await ui.confirm("Vault release authorization", warning, { signal });
    return ok ? { ok: true } : { ok: false, reason: "denied" };
  }

  ui.notify?.("vault_release denied: no UI authorization method available", "warning");
  return { ok: false, reason: "ui_authorization_unavailable" };
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
  const toolRegistry = pi as unknown as ToolRegistry;
  const eventRegistry = pi as unknown as EventRegistry;

  if (typeof eventRegistry.on === "function") {
    eventRegistry.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      const command = String(event.input?.command ?? "");
      const prepared = await prepareGlobalVaultBashCommand(command, { abrainHome: ABRAIN_HOME, stateDir: STATE_DIR });
      if (prepared.kind === "none") return;
      if (prepared.kind === "block") return { block: true, reason: prepared.reason };
      event.input.command = prepared.command;
      vaultBashRuns.set(event.toolCallId, prepared.record);
    });

    eventRegistry.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      const record = vaultBashRuns.get(event.toolCallId);
      if (!record) return;
      vaultBashRuns.delete(event.toolCallId);
      try { fs.rmSync(record.envFile, { force: true }); } catch {}

      const decision = await authorizeVaultBashOutput(ctx.ui, record.grantKey, record.releases, ctx.signal);
      if (decision !== "release") {
        return {
          content: withheldVaultBashContent(record),
          details: { ...(event.details ?? {}), vault: { outputWithheld: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
        };
      }
      return {
        content: redactVaultBashContent(event.content, record.releases),
        details: { ...(event.details ?? {}), vault: { outputReleased: true, redacted: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
      };
    });
  }

  if (typeof toolRegistry.registerTool === "function") {
    toolRegistry.registerTool({
      name: "vault_release",
      label: "Release Vault Secret",
      description:
        "Request user-authorized release of a global vault secret into the LLM context. " +
        "This is the P0c.read LLM-facing path: it prompts the user (Yes once / Session / No / Deny+remember) before decrypting. " +
        "Only global scope is implemented until ADR 0014 active-project routing lands; sub-pi processes register no vault tools.",
      promptSnippet: "vault_release(key, options?: { scope?: 'global', reason?: string })",
      promptGuidelines: [
        "Use vault_release only when plaintext is strictly necessary for the current task.",
        "Always provide a concise reason explaining why the secret must enter model context.",
        "Do not use vault_release for bash commands; future $VAULT_<key> injection is the safer execution path.",
        "Never ask for project scope yet; current P0c.read only supports global vault secrets.",
      ],
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Vault key name to release, e.g. github-token." },
          options: {
            type: "object",
            properties: {
              scope: { type: "string", enum: ["global"], description: "Only 'global' is implemented in P0c.read." },
              reason: { type: "string", description: "Why plaintext must be released into the LLM context." },
            },
          },
        },
        required: ["key"],
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const key = String(params.key ?? "").trim();
        const options = (params.options && typeof params.options === "object") ? params.options as Record<string, unknown> : params;
        const scopeRaw = String(options.scope ?? "global");
        const reason = typeof options.reason === "string" ? options.reason : undefined;
        if (scopeRaw !== "global") {
          return toolJson({ ok: false, error: "vault_release currently supports only scope='global'; project vault routing is ADR 0014 P1." });
        }
        try { validateKey(key); }
        catch (err: any) { return toolJson({ ok: false, error: `invalid vault key: ${err.message}` }); }

        const scope: VaultScope = "global";
        const auth = await authorizeVaultRelease(ctx.ui, scope, key, reason, signal);
        if (!auth.ok) return toolJson({ ok: false, key, scope, denied: true, reason: auth.reason });

        try {
          const released = await releaseSecret({ abrainHome: ABRAIN_HOME, scope, key });
          return toolJson({
            ok: true,
            key,
            scope,
            value: released.value,
            placeholder: released.placeholder,
            warning: "Plaintext is now in model context. Redaction is best-effort and does not cover encoded/transformed values.",
          });
        } catch (err: any) {
          return toolJson({ ok: false, key, scope, error: err?.message ?? String(err) });
        }
      },
    });
  }

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
      // v1.4.4 dogfood: when forgotten, show `forgotten <ts>` not `since <created>`.
      // The latter was confusing — user expects to see when the key was forgotten,
      // not when it was originally created.
      let timeAnnotation = "";
      if (item.forgotten && item.forgottenAt) {
        timeAnnotation = ` forgotten ${item.forgottenAt}`;
      } else if (item.created) {
        timeAnnotation = ` (since ${item.created})`;
      }
      lines.push(`  ${item.key}${status}${timeAnnotation}${desc}`);
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
