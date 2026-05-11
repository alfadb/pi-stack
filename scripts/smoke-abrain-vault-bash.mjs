#!/usr/bin/env node
/**
 * Smoke test: abrain P0c.read — vault-backed bash injection helpers.
 *
 * This stays library-level: no real vault unlock required. It verifies parsing,
 * project-scope blocking, no plaintext in rewritten command argv, temp env-file
 * permissions, output withholding payloads, and literal redaction.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-bash-"));
for (const file of ["vault-bash", "vault-reader", "vault-writer", "keychain"]) {
  fs.writeFileSync(path.join(tmpDir, `${file}.cjs`), transpile(path.join(repoRoot, "extensions", "abrain", `${file}.ts`)));
  // Relative imports in transpiled CJS keep the original .ts-free names.
  fs.copyFileSync(path.join(tmpDir, `${file}.cjs`), path.join(tmpDir, `${file}.js`));
}

const bash = require(path.join(tmpDir, "vault-bash.cjs"));

console.log("abrain P0c.read — vault-backed bash helper");

const release = {
  scope: "global",
  key: "api-key",
  value: "secret-VALUE-123",
  placeholder: "<vault:global:api-key>",
};

await check("vaultVarRefs parses bare/braced VAULT and GVAULT refs", () => {
  const refs = bash.vaultVarRefs("echo $VAULT_api_key ${GVAULT_API_KEY} $PVAULT_local $NOT_VAULT");
  for (const expected of ["VAULT_api_key", "GVAULT_API_KEY", "PVAULT_local"]) {
    if (!refs.includes(expected)) throw new Error(`missing ${expected}: ${refs.join(",")}`);
  }
  if (refs.includes("NOT_VAULT")) throw new Error("matched non-vault variable");
});

await check("keyCandidatesFromVaultVar maps underscores to dash fallback", () => {
  const candidates = bash.keyCandidatesFromVaultVar("VAULT_GitHub_Token");
  for (const expected of ["GitHub_Token", "GitHub-Token", "github_token", "github-token"]) {
    if (!candidates.includes(expected)) throw new Error(`missing ${expected}: ${candidates.join(",")}`);
  }
});

await check("prepareVaultBashCommand returns none when command has no vault refs", async () => {
  const result = await bash.prepareVaultBashCommand("echo plain", {
    keyForVar: () => { throw new Error("should not resolve key"); },
    releaseKey: async () => { throw new Error("should not release"); },
    writeEnvFile: () => { throw new Error("should not write env file"); },
  });
  if (result.kind !== "none") throw new Error(`expected none, got ${result.kind}`);
});

await check("prepareVaultBashCommand blocks $PVAULT_* until project routing lands", async () => {
  const result = await bash.prepareVaultBashCommand("echo $PVAULT_api_key", {
    keyForVar: () => "api-key",
    releaseKey: async () => release,
    writeEnvFile: () => "/tmp/unused",
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("active-project routing")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("prepareVaultBashCommand blocks missing global key", async () => {
  const result = await bash.prepareVaultBashCommand("echo $VAULT_missing_key", {
    keyForVar: () => undefined,
    releaseKey: async () => release,
    writeEnvFile: () => "/tmp/unused",
  });
  if (result.kind !== "block") throw new Error(`expected block, got ${result.kind}`);
  if (!result.reason.includes("not found in global vault")) throw new Error(`unexpected reason: ${result.reason}`);
});

await check("prepareVaultBashCommand rewrites command without plaintext in argv", async () => {
  let capturedVars;
  const envFile = "/tmp/pi vault env 'quoted.sh";
  const result = await bash.prepareVaultBashCommand("printf '%s' \"$VAULT_api_key\"", {
    keyForVar: (varName) => varName === "VAULT_api_key" ? "api-key" : undefined,
    releaseKey: async (key) => ({ ...release, key }),
    writeEnvFile: (vars) => { capturedVars = vars; return envFile; },
  });
  if (result.kind !== "prepared") throw new Error(`expected prepared, got ${result.kind}`);
  if (!capturedVars || capturedVars.length !== 1) throw new Error("expected one injected env var");
  if (capturedVars[0].varName !== "VAULT_api_key") throw new Error(`bad varName: ${capturedVars[0].varName}`);
  if (capturedVars[0].value !== release.value) throw new Error("env writer did not receive plaintext value");
  if (result.command.includes(release.value)) throw new Error("rewritten command leaks plaintext");
  if (!result.command.includes(bash.shellSingleQuote(envFile))) throw new Error(`env file path not shell-quoted: ${result.command}`);
  if (!result.command.includes("trap 'rm -f")) throw new Error("missing cleanup trap");
  if (result.record.grantKey !== "global:api-key") throw new Error(`bad grantKey: ${result.record.grantKey}`);
});

await check("writeVaultEnvFile creates 0600 env file with shell-escaped value", () => {
  const stateDir = fs.mkdtempSync(path.join(tmpDir, "state-"));
  const file = bash.writeVaultEnvFile(stateDir, [{ varName: "VAULT_quote", value: "a'b" }]);
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`expected 0600, got ${mode.toString(8)}`);
  const body = fs.readFileSync(file, "utf8");
  if (!body.includes("export VAULT_quote='a'\\''b'")) throw new Error(`unexpected env file body: ${body}`);
});

await check("withheldVaultBashContent mentions key but not plaintext", () => {
  const content = bash.withheldVaultBashContent({ releases: [release] });
  const text = content[0].text;
  if (!text.includes("global:api-key")) throw new Error(`missing key label: ${text}`);
  if (text.includes(release.value)) throw new Error("withheld content leaked plaintext");
});

await check("redactVaultBashContent replaces literal secret with placeholder", () => {
  const content = bash.redactVaultBashContent([{ type: "text", text: `before ${release.value} after` }], [release]);
  const text = content[0].text;
  if (text.includes(release.value)) throw new Error(`redaction missed plaintext: ${text}`);
  if (!text.includes(release.placeholder)) throw new Error(`missing placeholder: ${text}`);
});

await check("authorization choice order is deny-first for bash output", () => {
  if (bash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0] !== "No") throw new Error(`first choice is ${bash.VAULT_BASH_OUTPUT_AUTH_CHOICES[0]}`);
});

console.log("");
if (failures.length === 0) {
  console.log(`all ok — vault-backed bash helper holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
