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
 * Current scope (P0a-P0c shipped as of 2026-05-11):
 *   - extension skeleton + activate() guard
 *   - platform backend detection (backend-detect.ts, pure logic)
 *   - `/vault status` slash command (read-only display)
 *   - `/vault init [--backend=X]` non-interactive bootstrap (P0b)
 *   - master key generation + portable identity encryption (bootstrap.ts, keychain.ts)
 *   - vaultWriter library + atomic lock + per-key _meta (vault-writer.ts, P0c.write)
 *   - vaultReader: unlock master + decrypt per-key secrets (vault-reader.ts, P0c.read)
 *   - vault_release LLM tool + $VAULT_* bash injection (P0c.read)
 *   - `/secret set/list/forget` command with active-project routing (P0c.write)
 *   - reconcile() crash recovery wired into activate() (2026-05-11)
 *   - 7-zone brain layout bootstrap (brain-layout.ts, 2026-05-11)
 *
 * Remaining:
 *   - Lane G /about-me command + ABOUT-ME extractor (P3-P5)
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
  writeSecret, listSecrets, forgetSecret, readVaultEntryMeta, validateKey,
  appendVaultReadAudit, reconcile,
  type VaultEventOp, type VaultScope,
} from "./vault-writer";
import { releaseSecret, vaultFilePath, type ReleaseSecretResult } from "./vault-reader";
import {
  ensureBrainLayout,
} from "./brain-layout";
import {
  authKey,
  prepareBootVaultBashCommand,
  redactVaultBashContent,
  scopeLabel,
  VAULT_BASH_OUTPUT_AUTH_CHOICES,
  withheldVaultBashContent,
  type VaultBashRunRecord,
} from "./vault-bash";
import {
  listAbrainProjects,
  resolveActiveProject,
  validateAbrainProjectId,
  type ResolveActiveProjectResult,
} from "../_shared/runtime";
import { extractUserMessageText, localizePrompt, recordUserMessage } from "./i18n";

// ── ~/.abrain layout constants (single source — referenced from spec §3) ──
// Priority: ABRAIN_ROOT env var > default ~/.abrain (aligned with memory/parser.ts)

const ABRAIN_HOME = process.env.ABRAIN_ROOT
  ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), ".abrain");
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

// ── /secret scope parsing (ADR 0014 P1 step 2) ──────────────────────────

export type SecretScopeArg = "default" | "global" | { project: string };

export interface ParsedSecretFlags {
  scope: SecretScopeArg;
  positional: string[];
  errors: string[];
  allProjects: boolean;
}

export function parseSecretScopeFlags(tokens: ReadonlyArray<string>): ParsedSecretFlags {
  let global = false;
  let projectId: string | undefined;
  let allProjects = false;
  const positional: string[] = [];
  const errors: string[] = [];
  for (const tok of tokens) {
    if (tok === "--global") { global = true; continue; }
    if (tok === "--all-projects") { allProjects = true; continue; }
    const proj = tok.match(/^--project=(.+)$/);
    if (proj) {
      const id = proj[1]!;
      try { validateAbrainProjectId(id); projectId = id; }
      catch (err: any) { errors.push(`invalid --project=<id>: ${err.message}`); }
      continue;
    }
    if (tok.startsWith("--")) { errors.push(`unknown flag: ${tok}`); continue; }
    positional.push(tok);
  }
  if (global && projectId) errors.push("--global and --project=<id> are mutually exclusive");
  if (allProjects && (global || projectId)) errors.push("--all-projects cannot combine with --global / --project=<id>");
  let scope: SecretScopeArg = "default";
  if (global) scope = "global";
  else if (projectId) scope = { project: projectId };
  return { scope, positional, errors, allProjects };
}

export type ResolveSecretScope =
  | { ok: true; scope: VaultScope }
  | { ok: false; reason: string };

export function resolveSecretScope(
  scopeArg: SecretScopeArg,
  activeProject: ResolveActiveProjectResult | null,
): ResolveSecretScope {
  if (scopeArg === "global") return { ok: true, scope: "global" };
  if (typeof scopeArg === "object" && scopeArg && "project" in scopeArg) {
    return { ok: true, scope: { project: scopeArg.project } };
  }
  if (!activeProject || activeProject.activeProject === null) {
    const reason = activeProject?.reason ?? "bindings_missing";
    return { ok: false, reason: secretDefaultRejection(reason) };
  }
  return { ok: true, scope: { project: activeProject.activeProject.projectId } };
}

export function secretDefaultRejection(reason: string): string {
  switch (reason) {
    case "bindings_missing":
      return "no active project: ~/.abrain/projects/_bindings.md does not exist. Re-run with --global, or bind this cwd first.";
    case "bindings_empty":
      return "no active project: ~/.abrain/projects/_bindings.md has no entries. Re-run with --global, or bind this cwd first.";
    case "unbound":
      return "no active project: current cwd is not bound to any project. Re-run with --global, --project=<id>, or bind this cwd first.";
    case "ambiguous_remote":
      return "active project ambiguous: multiple bindings share this git remote. Pass --project=<id> or --global.";
    case "ambiguous_prefix":
      return "active project ambiguous: multiple bindings share this cwd prefix. Pass --project=<id> or --global.";
    case "invalid_cwd":
      return "active project unresolved: cwd is invalid. Re-run with --global or --project=<id>.";
    default:
      return `no active project (reason=${reason}). Re-run with --global or --project=<id>.`;
  }
}

let bootActiveProject: ResolveActiveProjectResult | null = null;
let bootActiveProjectAt: number | null = null;

function snapshotBootActiveProject(): ResolveActiveProjectResult {
  return resolveActiveProject(process.cwd(), { abrainHome: ABRAIN_HOME });
}

export function getBootActiveProject(): ResolveActiveProjectResult | null {
  return bootActiveProject;
}

export function getBootActiveProjectSnapshotAt(): number | null {
  return bootActiveProjectAt;
}

export function __resetBootActiveProjectForTests(value: ResolveActiveProjectResult | null): void {
  bootActiveProject = value;
  bootActiveProjectAt = value ? Date.now() : null;
}


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

// Truncate text to N chars so the TUI title stays readable. We keep the head
// and the tail because vault-relevant info is often at both ends of a command.
function truncateForPrompt(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const head = Math.floor((max - 5) * 0.7);
  const tail = max - 5 - head;
  return `${oneLine.slice(0, head)} ... ${oneLine.slice(-tail)}`;
}

export function formatBashAuthorizationTitle(
  record: { releases: ReleaseSecretResult[]; originalCommand?: string },
  descriptions?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [`Release bash output to the LLM?`];
  if (record.releases.length === 0) {
    lines.push(`vault keys used: <none>`);
  } else {
    lines.push(`vault keys used:`);
    for (const r of record.releases) {
      const label = authKey(r.scope, r.key);
      const desc = descriptions?.get(label);
      lines.push(`  ${label}${desc ? ` — ${truncateForPrompt(desc, 200)}` : ""}`);
    }
  }
  const cmd = record.originalCommand ? truncateForPrompt(record.originalCommand) : "<unknown command>";
  lines.push(`command: ${cmd}`);
  lines.push(`⚠ The output may still contain encoded forms of the secret (base64/hex/xxd/xor) that literal redaction cannot catch.`);
  return lines.join("\n");
}

export function formatReleaseAuthorizationTitle(
  scope: VaultScope,
  key: string,
  reason: string | undefined,
  description?: string,
): string {
  const lines: string[] = [`Release vault secret ${authKey(scope, key)} to the LLM?`];
  if (description) lines.push(`description: ${truncateForPrompt(description, 240)}`);
  lines.push(reason ? `LLM reason: ${truncateForPrompt(reason, 320)}` : `LLM reason: (none supplied)`);
  lines.push(`⚠ Plaintext will enter this model context. Redaction is best-effort and does not cover base64/hex/xxd/xor transformations.`);
  return lines.join("\n");
}

function scopeAuditLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

function safeAuditAppend(ev: Parameters<typeof appendVaultReadAudit>[1]): void {
  // Audit failures must never break vault read paths — they're observability,
  // not enforcement. Swallow + best-effort log via stderr if anything throws.
  appendVaultReadAudit(ABRAIN_HOME, ev).catch((err) => {
    try { process.stderr.write(`abrain vault audit append failed: ${err?.message ?? err}\n`); } catch {}
  });
}

function auditReleaseDecision(op: VaultEventOp, scope: VaultScope, key: string, extras: { reason?: string } = {}): void {
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(scope),
    key,
    lane: "vault_release",
    ...(extras.reason ? { reason: extras.reason } : {}),
  });
}

function auditBashInject(record: VaultBashRunRecord): void {
  if (record.releases.length === 0) return;
  const firstScope = record.releases[0]!.scope;
  safeAuditAppend({
    ts: new Date().toISOString(),
    op: "bash_inject",
    scope: scopeAuditLabel(firstScope),
    lane: "bash_inject",
    keys: record.releases.map((r) => authKey(r.scope, r.key)),
    variables: record.variables,
    command_preview: record.originalCommand ? truncateForPrompt(record.originalCommand, 240) : undefined,
  });
}

function auditBashInjectBlock(originalCommand: string, reason: string): void {
  safeAuditAppend({
    ts: new Date().toISOString(),
    op: "bash_inject_block",
    scope: "global", // scope is unknown at block time; lane marks the row
    lane: "bash_inject",
    reason,
    command_preview: truncateForPrompt(originalCommand, 240),
  });
}

function auditBashOutput(op: "bash_output_release" | "bash_output_withhold", record: VaultBashRunRecord): void {
  if (record.releases.length === 0) return;
  const firstScope = record.releases[0]!.scope;
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(firstScope),
    lane: "bash_output",
    keys: record.releases.map((r) => authKey(r.scope, r.key)),
    command_preview: record.originalCommand ? truncateForPrompt(record.originalCommand, 240) : undefined,
  });
}

function collectReleaseDescriptions(releases: ReleaseSecretResult[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of releases) {
    try {
      const meta = readVaultEntryMeta(ABRAIN_HOME, r.scope, r.key);
      if (meta?.description) out.set(authKey(r.scope, r.key), meta.description);
    } catch { /* ignore unreadable meta */ }
  }
  return out;
}

function readReleaseDescription(scope: VaultScope, key: string): string | undefined {
  try { return readVaultEntryMeta(ABRAIN_HOME, scope, key)?.description; }
  catch { return undefined; }
}

async function authorizeVaultBashOutput(
  ui: VaultReleaseUi | undefined,
  record: VaultBashRunRecord,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<"release" | "withhold"> {
  if (bashOutputSessionGrants.has(record.grantKey)) return "release";
  if (!ui?.select) return "withhold";
  const descriptions = collectReleaseDescriptions(record.releases);
  const englishTitle = formatBashAuthorizationTitle(record, descriptions);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Also push the full context into the message stream so it survives any TUI
  // truncation of the select title.
  ui.notify?.(title, "warning");
  // Fail closed in non-interactive/API runners that may auto-return the first
  // select item: put the deny option first. Interactive users can still move to
  // an explicit release choice.
  const choice = await ui.select(title, [...VAULT_BASH_OUTPUT_AUTH_CHOICES], { signal });
  if (choice === "Yes once") return "release";
  if (choice === "Session") {
    bashOutputSessionGrants.add(record.grantKey);
    return "release";
  }
  const keyList = record.releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
  return "withhold";
}

async function authorizeVaultRelease(
  ui: VaultReleaseUi | undefined,
  scope: VaultScope,
  key: string,
  reason: string | undefined,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gate = authKey(scope, key);
  if (releaseRememberDenies.has(gate)) return { ok: false, reason: "denied_remembered" };
  if (releaseSessionGrants.has(gate)) return { ok: true };
  if (!ui) return { ok: false, reason: "ui_unavailable" };

  const description = readReleaseDescription(scope, key);
  const englishTitle = formatReleaseAuthorizationTitle(scope, key, reason, description);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Mirror the full context into the message stream so the user always sees
  // what is about to be released, even if the TUI select clips long titles.
  ui.notify?.(title, "warning");

  if (typeof ui.select === "function") {
    // Fail closed in non-interactive/API runners that may auto-return the first
    // select item: put deny choices before explicit release choices.
    const choice = await ui.select(title, [...VAULT_RELEASE_AUTH_CHOICES], { signal });
    if (choice === "Yes once") return { ok: true };
    if (choice === "Session") {
      releaseSessionGrants.add(gate);
      return { ok: true };
    }
    if (choice === "Deny + remember") releaseRememberDenies.add(gate);
    return { ok: false, reason: vaultReleaseChoiceReason(choice) };
  }

  if (typeof ui.confirm === "function") {
    const ok = await ui.confirm("Vault release authorization", title, { signal });
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

  // Boot-time snapshot per ADR 0014 §5.4: active project must not
  // dynamically change with bash `cd`. Resolve once at activate.
  bootActiveProject = snapshotBootActiveProject();
  bootActiveProjectAt = Date.now();

  // ── Crash recovery ────────────────────────────────────────────
  // reconcile scans vault dirs for encrypted files missing audit rows
  // (crash between atomic rename and vault-events append) and inserts
  // recovered_missing_audit entries. Safe no-op when vault not yet init'd.
  reconcile(ABRAIN_HOME)
    .then(({ recovered, scanned }) => {
      if (recovered > 0) {
        console.error(`[abrain] reconcile: recovered ${recovered} missing audit rows (${scanned} files scanned)`);
      }
    })
    .catch((err) => {
      console.error(`[abrain] reconcile failed:`, err);
    });

  // ── 7-zone layout bootstrap ──────────────────────────────────
  // Ensure brain directory structure exists (idempotent). Vault zone
  // is created here so it's available before /vault init runs.
  try {
    const layout = ensureBrainLayout(ABRAIN_HOME);
    if (layout.created.length > 0) {
      console.error(`[abrain] brain layout: created ${layout.created.join(", ")}`);
    }
    for (const w of layout.warnings) {
      console.error(`[abrain] brain layout warning: ${w}`);
    }
  } catch (err: any) {
    console.error(`[abrain] brain layout failed:`, err);
  }

  const registry = pi as unknown as CommandRegistry;
  const toolRegistry = pi as unknown as ToolRegistry;
  const eventRegistry = pi as unknown as EventRegistry;

  if (typeof eventRegistry.on === "function") {
    // Track the user's current conversation language by sampling recent user
    // messages. Used by i18n.localizePrompt to translate vault authorization
    // prompts into the language the user is speaking.
    eventRegistry.on("message_start", async (event) => {
      const message = (event as { message?: unknown })?.message;
      const text = extractUserMessageText(message);
      if (text) recordUserMessage(text);
    });

    eventRegistry.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      const command = String(event.input?.command ?? "");
      const activeProjectId = bootActiveProject?.activeProject?.projectId ?? null;
      const prepared = await prepareBootVaultBashCommand(command, { abrainHome: ABRAIN_HOME, stateDir: STATE_DIR, activeProjectId });
      if (prepared.kind === "none") return;
      if (prepared.kind === "block") {
        auditBashInjectBlock(command, prepared.reason);
        return { block: true, reason: prepared.reason };
      }
      event.input.command = prepared.command;
      // Stash the original (pre-wrap) command so the post-run authorization
      // prompt can show the user exactly what ran.
      prepared.record.originalCommand = command;
      vaultBashRuns.set(event.toolCallId, prepared.record);
      auditBashInject(prepared.record);
    });

    eventRegistry.on("tool_result", async (event, ctx) => {
      if (event.toolName !== "bash") return;
      const record = vaultBashRuns.get(event.toolCallId);
      if (!record) return;
      vaultBashRuns.delete(event.toolCallId);
      try { fs.rmSync(record.envFile, { force: true }); } catch {}

      const decision = await authorizeVaultBashOutput(ctx.ui, record, ctx.signal, ctx);
      if (decision !== "release") {
        auditBashOutput("bash_output_withhold", record);
        return {
          content: withheldVaultBashContent(record),
          details: { ...(event.details ?? {}), vault: { outputWithheld: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
        };
      }
      auditBashOutput("bash_output_release", record);
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
        "Request user-authorized release of a vault secret into the LLM context. " +
        "This is the P0c.read LLM-facing path: it prompts the user (Yes once / Session / No / Deny+remember) before decrypting. " +
        "Scope='global' targets the global vault; scope='project' targets the boot-time active project's vault (rejected when no active project is bound). Sub-pi processes register no vault tools.",
      promptSnippet: "vault_release(key, scope?: 'global'|'project', reason?: string)",
      promptGuidelines: [
        "Use vault_release only when plaintext is strictly necessary for the current task.",
        "Always provide a concise reason explaining why the secret must enter model context.",
        "Do not use vault_release for bash commands; $VAULT_<key> injection is the safer execution path.",
        "Project scope binds to the boot-time active project; restart pi (or use `pi project switch`) to change it.",
      ],
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Vault key name to release, e.g. github-token." },
          scope: { type: "string", enum: ["global", "project"], description: "'global' = ~/.abrain/vault; 'project' = boot-time active project's vault. Defaults to 'global'." },
          reason: { type: "string", description: "Why plaintext must be released into the LLM context." },
        },
        required: ["key"],
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const key = String(params.key ?? "").trim();
        // Accept both flat (scope/reason at top level — preferred) and legacy
        // nested options.{scope,reason}. The flat form is the canonical schema;
        // the nested fallback covers callers that emit the older shape.
        const nested = (params.options && typeof params.options === "object") ? params.options as Record<string, unknown> : undefined;
        const scopeRaw = String((params.scope ?? nested?.scope ?? "global"));
        const reasonRaw = params.reason ?? nested?.reason;
        const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;

        let scope: VaultScope;
        if (scopeRaw === "global") {
          scope = "global";
        } else if (scopeRaw === "project") {
          const projectId = bootActiveProject?.activeProject?.projectId;
          if (!projectId) {
            const reasonCode = bootActiveProject?.reason ?? "bindings_missing";
            return toolJson({
              ok: false,
              error: `vault_release(scope='project') refused: ${secretDefaultRejection(reasonCode)}`,
            });
          }
          scope = { project: projectId };
        } else {
          return toolJson({ ok: false, error: `vault_release: unsupported scope='${scopeRaw}'. Use 'global' or 'project'.` });
        }

        try { validateKey(key); }
        catch (err: any) { return toolJson({ ok: false, error: `invalid vault key: ${err.message}` }); }

        // Pre-flight: avoid spending a user authorization prompt on a key that
        // does not exist. The encrypted file's mere existence is already
        // visible via `/secret list` metadata, so this check leaks no new
        // information but saves the user from approving phantom releases.
        try {
          if (!fs.existsSync(vaultFilePath(ABRAIN_HOME, scope, key))) {
            auditReleaseDecision("release_blocked", scope, key, { reason: "key_not_found" });
            return toolJson({
              ok: false,
              key,
              scope,
              error: `vault key not found or forgotten: ${scopeLabel(scope)}:${key}`,
              checkedBeforeAuthorization: true,
            });
          }
        } catch (err: any) {
          auditReleaseDecision("release_blocked", scope, key, { reason: "preflight_error" });
          return toolJson({ ok: false, key, scope, error: `vault key pre-flight failed: ${err?.message ?? String(err)}` });
        }

        const auth = await authorizeVaultRelease(ctx.ui, scope, key, reason, signal, ctx);
        if (!auth.ok) {
          auditReleaseDecision("release_denied", scope, key, { reason: auth.reason });
          return toolJson({ ok: false, key, scope, denied: true, reason: auth.reason });
        }

        try {
          const released = await releaseSecret({ abrainHome: ABRAIN_HOME, scope, key });
          auditReleaseDecision("release", scope, key);
          return toolJson({
            ok: true,
            key,
            scope,
            value: released.value,
            placeholder: released.placeholder,
            warning: "Plaintext is now in model context. Redaction is best-effort and does not cover encoded/transformed values.",
          });
        } catch (err: any) {
          auditReleaseDecision("release_blocked", scope, key, { reason: `release_error: ${err?.message ?? "unknown"}` });
          return toolJson({ ok: false, key, scope, error: err?.message ?? String(err) });
        }
      },
    });
  }

  if (typeof registry.registerCommand !== "function") return;

  // /secret command — vault write/list/forget (P0c.write).
  // Read paths (release / bash injection) are P0c.read.
  registry.registerCommand("secret", {
    description: "Vault secrets: /secret set <key>=<value> [--global | --project=<id>] | /secret list [--global | --project=<id> | --all-projects] | /secret forget <key> [--global | --project=<id>]. Default scope is the boot-time active project.",
    getArgumentCompletions(prefix: string) {
      const items = [
        "set ",
        "set --global ",
        "set --project=",
        "list",
        "list --global",
        "list --all-projects",
        "list --project=",
        "forget ",
        "forget --global ",
        "forget --project=",
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
      // Keep aligned with parseInitArgs() backend whitelist below.
      const items = [
        "status",
        "init",
        "init --backend=ssh-key",
        "init --backend=gpg-file",
        "init --backend=passphrase-only",
        "init --backend=macos",
        "init --backend=secret-service",
        "init --backend=pass",
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
    // No `--force` flag: vault re-init is intentionally hard-blocked. To
    // switch backends, wait for `/vault migrate-backend` (P0d) or manually
    // move `~/.abrain/.vault-master.age` aside and rerun /vault init. A
    // historical `--force` no-op flag was accepted but never read; removed
    // in Round 5 audit (gpt-5.5 P2) to stop misleading the CLI surface.
    throw new Error(`unknown init flag: ${tok}`);
  }
  return opts;
}

async function handleInit(rawArgs: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Idempotent guard: if vault already initialized, refuse re-init.
  //
  // No `--force` escape hatch: actually wiping a live vault requires
  // migrating existing secrets and reseating the master key, which is the
  // `vault migrate-backend` flow (P0d, pending). Until that lands, the
  // user-facing instruction is to manually move `~/.abrain/.vault-master.age`
  // aside and rerun /vault init. The historical `--force` no-op flag was
  // removed in Round 5 audit (gpt-5.5 P2): it accepted but never honored,
  // so it gave a false promise to anyone who tried it.
  const existing = readBackendFile(ABRAIN_HOME);
  if (existing) {
    ui.notify(
      `vault already initialized (backend=${existing.backend}). To switch backends, wait for \`/vault migrate-backend\` (P0d) or manually move ~/.abrain/.vault-master.age and rerun.`,
      "warning",
    );
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
// ADR 0014 P1 step 2: default scope is the boot-time active project; users
// opt into global with --global, or into a specific project with
// --project=<id>. When no active project can be resolved, default-scope
// operations refuse with an actionable reason instead of guessing.

function scopeReadableLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

function renderListing(scope: VaultScope): string {
  const items = listSecrets(ABRAIN_HOME, scope);
  const label = scopeReadableLabel(scope);
  if (items.length === 0) return `${label} vault — no secrets yet`;
  const lines: string[] = [`${label} vault — ${items.length} key(s):`];
  for (const item of items) {
    const status = item.forgotten ? "  [forgotten]" : "";
    const desc = item.description ? `  — ${item.description}` : "";
    let timeAnnotation = "";
    if (item.forgotten && item.forgottenAt) timeAnnotation = ` forgotten ${item.forgottenAt}`;
    else if (item.created) timeAnnotation = ` (since ${item.created})`;
    lines.push(`  ${item.key}${status}${timeAnnotation}${desc}`);
  }
  return lines.join("\n");
}

async function handleSecret(args: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Pre-flight: vault must be initialized
  const backend = readBackendFile(ABRAIN_HOME);
  if (!backend) {
    ui.notify("vault not initialized. run `/vault init` first.", "warning");
    return;
  }

  const tokens = args.split(/\s+/).filter(Boolean);
  const sub = tokens[0] || "";
  const rest = tokens.slice(1);
  const parsed = parseSecretScopeFlags(rest);
  if (parsed.errors.length > 0) {
    ui.notify(`/secret ${sub || "?"}: ${parsed.errors.join("; ")}`, "warning");
    return;
  }

  if (sub === "set") {
    if (parsed.allProjects) {
      ui.notify("/secret set: --all-projects is not a valid target for writes", "warning");
      return;
    }
    const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
    if (!resolved.ok) {
      ui.notify(`/secret set: ${resolved.reason}`, "warning");
      return;
    }
    const valueSpec = parsed.positional.join(" ");
    const eqIdx = valueSpec.indexOf("=");
    if (eqIdx <= 0) {
      ui.notify("/secret set: expected `<key>=<value>` (use --global or --project=<id> for non-default scope)", "warning");
      return;
    }
    const key = valueSpec.slice(0, eqIdx).trim();
    let value: string | null = valueSpec.slice(eqIdx + 1);
    try { validateKey(key); }
    catch (err: any) {
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
        scope: resolved.scope,
        key,
        value,
      });
      value = null;
      ui.notify(
        `/secret set: wrote ${scopeReadableLabel(resolved.scope)}:${key} → ${path.relative(ABRAIN_HOME, result.encryptedPath)}`,
        "info",
      );
    } catch (err: any) {
      value = null;
      ui.notify(`/secret set failed: ${err.message}`, "warning");
    }
    return;
  }

  if (sub === "list") {
    if (parsed.allProjects) {
      if (parsed.positional.length > 0) {
        ui.notify(`/secret list: unexpected positional arg(s): ${parsed.positional.join(" ")}`, "warning");
        return;
      }
      const sections: string[] = [renderListing("global")];
      const projectIds = listAbrainProjects(ABRAIN_HOME);
      if (projectIds.length === 0) {
        sections.push("(no project vaults under ~/.abrain/projects/)");
      } else {
        for (const projectId of projectIds) sections.push(renderListing({ project: projectId }));
      }
      ui.notify(sections.join("\n\n"), "info");
      return;
    }
    if (parsed.positional.length > 0) {
      ui.notify(`/secret list: unexpected positional arg(s): ${parsed.positional.join(" ")}`, "warning");
      return;
    }
    if (parsed.scope !== "default") {
      const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
      if (!resolved.ok) { ui.notify(`/secret list: ${resolved.reason}`, "warning"); return; }
      ui.notify(renderListing(resolved.scope), "info");
      return;
    }
    // Default: list global PLUS active project (if any).
    const sections: string[] = [renderListing("global")];
    if (bootActiveProject && bootActiveProject.activeProject) {
      sections.push(renderListing({ project: bootActiveProject.activeProject.projectId }));
    } else if (bootActiveProject?.reason) {
      sections.push(`(no active project: ${secretDefaultRejection(bootActiveProject.reason)})`);
    }
    ui.notify(sections.join("\n\n"), "info");
    return;
  }

  if (sub === "forget") {
    if (parsed.allProjects) {
      ui.notify("/secret forget: --all-projects is not a valid target", "warning");
      return;
    }
    const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
    if (!resolved.ok) {
      ui.notify(`/secret forget: ${resolved.reason}`, "warning");
      return;
    }
    const key = parsed.positional[0];
    if (!key) {
      ui.notify("/secret forget <key>: missing key", "warning");
      return;
    }
    if (parsed.positional.length > 1) {
      ui.notify(`/secret forget: unexpected extra args: ${parsed.positional.slice(1).join(" ")}`, "warning");
      return;
    }
    try { validateKey(key); }
    catch (err: any) {
      ui.notify(`/secret forget: invalid key: ${err.message}`, "warning");
      return;
    }
    try {
      const result = await forgetSecret(ABRAIN_HOME, resolved.scope, key);
      const label = scopeReadableLabel(resolved.scope);
      if (result.removed) ui.notify(`/secret forget: removed ${label}:${key}`, "info");
      else ui.notify(`/secret forget: ${label}:${key} was not present (no-op, audit row recorded)`, "info");
    } catch (err: any) {
      ui.notify(`/secret forget failed: ${err.message}`, "warning");
    }
    return;
  }

  ui.notify(
    `/secret: unknown subcommand '${sub}'. available: set / list / forget. Default scope is the boot-time active project; pass --global or --project=<id> to override.`,
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
