/**
 * abrain — vault-backed bash injection helpers (P0c.read).
 *
 * Keeps plaintext out of bash tool-call argv by writing a short-lived 0600
 * env file and rewriting the command to source it. Tool-result output is
 * withheld by default by index.ts; when the user explicitly releases it,
 * literal redaction is applied via redactVaultBashContent().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateKey, type VaultScope } from "./vault-writer";
import { releaseSecret, redactWithReleasedSecrets, type ReleaseSecretResult } from "./vault-reader";

export const VAULT_BASH_OUTPUT_AUTH_CHOICES = ["No", "Yes once", "Session"] as const;

export interface VaultBashRunRecord {
  releases: ReleaseSecretResult[];
  envFile: string;
  grantKey: string;
}

export interface VaultBashEnvVar {
  varName: string;
  value: string;
}

export interface VaultBashPrepareDeps {
  keyForVar(varName: string): string | undefined;
  releaseKey(key: string): Promise<ReleaseSecretResult>;
  writeEnvFile(vars: VaultBashEnvVar[]): string;
}

export type VaultBashPrepareResult =
  | { kind: "none" }
  | { kind: "block"; reason: string }
  | { kind: "prepared"; command: string; record: VaultBashRunRecord };

export function scopeLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

export function authKey(scope: VaultScope, key: string): string {
  return `${scopeLabel(scope)}:${key}`;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function vaultVarRefs(command: string): string[] {
  const refs = new Set<string>();
  const re = /\$(?:\{((?:GVAULT|PVAULT|VAULT)_[A-Za-z0-9_]+)\}|((?:GVAULT|PVAULT|VAULT)_[A-Za-z0-9_]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) refs.add(match[1] || match[2]);
  return [...refs];
}

export function keyCandidatesFromVaultVar(varName: string): string[] {
  const suffix = varName.replace(/^(?:GVAULT|PVAULT|VAULT)_/, "");
  return Array.from(new Set([
    suffix,
    suffix.replace(/_/g, "-"),
    suffix.toLowerCase(),
    suffix.toLowerCase().replace(/_/g, "-"),
  ].filter(Boolean)));
}

export function existingGlobalVaultKey(abrainHome: string, varName: string): string | undefined {
  for (const key of keyCandidatesFromVaultVar(varName)) {
    try { validateKey(key); } catch { continue; }
    if (fs.existsSync(path.join(abrainHome, "vault", `${key}.md.age`))) return key;
  }
  return undefined;
}

export function writeVaultEnvFile(stateDir: string, vars: VaultBashEnvVar[]): string {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `vault-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
  const body = vars.map(({ varName, value }) => `export ${varName}=${shellSingleQuote(value)}`).join("\n") + "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export async function prepareVaultBashCommand(command: string, deps: VaultBashPrepareDeps): Promise<VaultBashPrepareResult> {
  const refs = vaultVarRefs(command);
  if (refs.length === 0) return { kind: "none" };

  const releases: ReleaseSecretResult[] = [];
  const envVars: VaultBashEnvVar[] = [];
  for (const varName of refs) {
    if (varName.startsWith("PVAULT_")) {
      return { kind: "block", reason: "$PVAULT_* requires ADR 0014 active-project routing; only global vault injection is implemented." };
    }
    const key = deps.keyForVar(varName);
    if (!key) return { kind: "block", reason: `vault key for $${varName} not found in global vault` };
    try {
      const release = await deps.releaseKey(key);
      releases.push(release);
      envVars.push({ varName, value: release.value });
    } catch (err: any) {
      return { kind: "block", reason: `vault injection failed for $${varName}: ${err?.message ?? String(err)}` };
    }
  }

  const envFile = deps.writeEnvFile(envVars);
  const quoted = shellSingleQuote(envFile);
  return {
    kind: "prepared",
    command: `__pi_vault_env=${quoted}; trap 'rm -f "$__pi_vault_env"' EXIT; . "$__pi_vault_env"; ${command}`,
    record: {
      releases,
      envFile,
      grantKey: releases.map((r) => authKey(r.scope, r.key)).sort().join(","),
    },
  };
}

export async function prepareGlobalVaultBashCommand(command: string, opts: { abrainHome: string; stateDir: string }): Promise<VaultBashPrepareResult> {
  return prepareVaultBashCommand(command, {
    keyForVar: (varName) => existingGlobalVaultKey(opts.abrainHome, varName),
    releaseKey: (key) => releaseSecret({ abrainHome: opts.abrainHome, scope: "global", key }),
    writeEnvFile: (vars) => writeVaultEnvFile(opts.stateDir, vars),
  });
}

export function redactVaultBashContent(content: unknown, releases: ReleaseSecretResult[]): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const obj = part as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      return { ...obj, text: redactWithReleasedSecrets(obj.text, releases) };
    }
    return part;
  });
}

export function withheldVaultBashContent(record: { releases: ReleaseSecretResult[] }) {
  const keys = record.releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  return [{ type: "text", text: `(vault-protected bash output withheld from LLM context; keys: ${keys}. Ask the user to release this command's output if needed.)` }];
}
