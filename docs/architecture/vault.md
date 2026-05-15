# Vault Architecture — current spec

## 1. Goal

Vault stores secrets inside the abrain substrate without making plaintext part of memory. The rule is strict:

> Secrets may be used by tools and bash, but plaintext enters LLM context only after explicit user authorization.

## 2. Storage model

| Scope | Path | Notes |
|---|---|---|
| Global vault | `~/.abrain/vault/<key>.age` | cross-project secrets |
| Project vault | `~/.abrain/projects/<id>/vault/<key>.age` | active project only |
| Abrain identity (ADR 0019) | `~/.abrain/.vault-identity/master.age` (secret, 0600, **gitignored**) + `master.age.pub` (public key, enters git) | Tier 1 default backend; abrain self-managed age keypair |
| Master key envelope | `~/.abrain/.vault-master.age` | **Tier 3 only** (ssh-key / gpg-file / passphrase-only). NOT written by abrain-age-key (single-layer keypair, ADR 0019 invariant 6). |
| Public key alias | `~/.abrain/.vault-pubkey` | always written; for abrain-age-key this is a duplicate of `.vault-identity/master.age.pub` (invariant 6). vault-writer reads this. |
| Audit/state | `~/.abrain/.state/vault-events.jsonl` and related state | no plaintext intended |

Project vault scope uses ADR 0017 active project binding. Other projects' vaults are not visible to the current session unless explicitly supported by a metadata-only command such as all-project listing.

## 3. Backend detection (ADR 0019)

`/vault init` chooses a backend. The chain (`extensions/abrain/backend-detect.ts:detectBackend`) is reorganized around **abrain-managed identity** so cross-device behavior is consistent:

1. `SECRETS_BACKEND` env override (invalid values are silently ignored and detection continues; see `extensions/abrain/backend-detect.ts:161-174`).

**Tier 1 default — abrain self-managed:**

2. `abrain-age-key` — if `~/.abrain/.vault-identity/master.age` already exists (initialized) OR `age-keygen` is on PATH (init target). Identity is an age keypair owned by abrain; secret 0600 + gitignored; pubkey enters git.

**Tier 2 keychain optimization (wraps abrain identity):**

3. `macos` — platform=darwin + `security` CLI.
4. `secret-service` — Linux + `$DISPLAY`/`$WAYLAND_DISPLAY` + `secret-tool`.
5. `pass` — `pass` CLI + `~/.password-store/abrain/`.

**Tier 3 explicit-only (legacy):**

- `ssh-key` — reuses `~/.ssh/id_*`. **Not auto-detected**; requires `--backend=ssh-key` and produces a stderr warning. Cross-device unlock requires copying the ssh secret key to every device, which usually conflicts with per-device default ssh keys.
- `gpg-file` — reuses GPG identity. **Not auto-detected**; requires `--backend=gpg-file` and produces a stderr warning. Same cross-device caveat.
- `passphrase-only` — age scrypt mode. **Not auto-detected**; requires `--backend=passphrase-only` and produces a stderr warning. Reader path requires tty pass-through which is not yet implemented (roadmap P0d), so the next pi restart will silently fail to unlock.

**Tier 4 final:**

6. `disabled` — no abrain-age-key prerequisite (no `age-keygen`) and no keychain backend detected. `/vault init` refuses; vault is off. ADR 0019 made this the auto-detect terminator (was `passphrase-only` in v1.4) so bare environments fail loudly with an actionable install hint, not silently into a backend that can't unlock.

`disabled` also becomes active through two **explicit** opt-outs:

- `SECRETS_BACKEND=disabled` env override, or
- `~/.abrain/.state/vault-disabled` flag file present.

Container scenario (alfadb main dev): `abrain-age-key` wins because `age-keygen` is on PATH (already a dependency for the legacy ssh-key path).

Why this ordering: previous v1.4 chain prioritized ssh-key for containers. Multi-model audit + dogfood (2026-05-15) found three root problems with that: (1) default ssh keys at `~/.ssh/id_*` are usually different per device, (2) `.vault-backend` hardcoded the absolute identity path which breaks on path-different machines, (3) passphrase-only could `init` but not `unlock` (reader stdin: 'ignore'). See [ADR 0019](../adr/0019-abrain-self-managed-vault-identity.md) for the full reasoning.

## 4. Commands and tools

### Human slash commands

```text
/vault status
/vault init [--backend=<backend>]
/secret set [--global|--project=<id>] <key>=<value>
/secret list [--global|--project=<id>|--all-projects]
/secret forget [--global|--project=<id>] <key>
```

### LLM tool

```text
vault_release(key, scope?: "global" | "project", reason?: string)
```

This is the P0c.read path: pi prompts the user before decrypting plaintext into LLM context. The user can allow once/session or deny.

### Bash injection

```bash
$VAULT_<key>   # active project first, then global fallback
$PVAULT_<key>  # active project only
$GVAULT_<key>  # global only
```

Bash injection is preferred for commands that only need the secret in a subprocess. Do not call `vault_release` merely to pass a token to `curl`/`npm`/`git`; use env injection.

## 5. Output handling

Bash secret injection has two distinct risks:

1. Secret enters subprocess environment.
2. Subprocess stdout/stderr may echo the secret back into LLM context.

Current policy:

- Injected run output is default-withheld when needed.
- User authorization is required before releasing potentially secret-bearing output.
- Released output undergoes literal redaction of known plaintext values **in text parts only**. `extensions/abrain/vault-bash.ts:217-225` `redactVaultBashContent` iterates `Array<{type: "text", text: string}>` entries; non-text parts (e.g. future inline `image` blobs) pass through unredacted. The bash tool currently only emits text parts, so this is a known shape constraint, not an active leak. If future tool output schemas add non-text parts, the redaction loop must be extended.
- Per-row audit `command_preview` captures the **LLM-original** command text (before vault env injection is prepended). It is guaranteed not to contain vault-decrypted plaintext (rewrite runs after preview is captured), but it can still contain any secret-shaped string the LLM itself hard-coded into argv. This is a documented hygiene limit, not a vault leak.
- On failure to safely authorize/redact, the desired direction is fail-closed; tool_call inject errors return `block:true`, tool_result authorization/redaction throws withhold output and audit `bash_inject_block` / `bash_output_withhold` (2026-05-14 R6 audit fix).

### `$VAULT_<key>` suffix matching

`extensions/abrain/vault-bash.ts:97-104` `keyCandidatesFromVaultVar` expands a single `$VAULT_<suffix>` reference to up to four lookup candidates and picks the first present `.md.age`:

1. raw suffix as written
2. underscores `_` → dashes `-`
3. lower-cased raw suffix
4. lower-cased + underscores → dashes

So `$VAULT_GitHub_Token` resolves against `GitHub_Token`, `GitHub-Token`, `github_token`, `github-token` in order. Behavior is deterministic but **not configurable**; storing both `GitHub-Token.md.age` and `github-token.md.age` will always pick the first per the order above. Prefer one canonical casing per key.

## 6. Sub-pi isolation

Dispatch sub-agents run independent pi processes. By default they receive `PI_ABRAIN_DISABLED=1`, so abrain/vault tools are not registered. This prevents child agents from reading project/global secrets through the main session's trust boundary.

## 7. Fail-closed principles

- Missing/locked master key → no decrypt, no plaintext fallback.
- Secret files are per-key encrypted; one damaged file does not corrupt the whole vault.
- Vault files are not ordinary memory and should not be committed as plaintext.
- Metadata may be visible; values are not.
- Read-path actions are audited.

## 8. Current shipped vs pending

| Capability | Status |
|---|---|
| `/vault status/init` | shipped |
| `/secret set/list/forget` | shipped |
| global + project scopes | shipped |
| `vault_release` | shipped |
| bash env injection | shipped |
| output withheld + redaction | shipped |
| startup reconcile/cleanup | shipped |
| `abrain-age-key` backend (ADR 0019, Tier 1 default) | shipped |
| `ssh-key` / `gpg-file` backends (Tier 3 explicit-only) | shipped, deprecated for new users (`/vault status` shows deprecation notice; reader stays fail-soft) |
| `passphrase-only` backend init | shipped (init writes file); **unlock unimplemented** (reader needs tty pass-through, roadmap P0d) |
| Cross-device identity transport | manual (user `scp ~/.abrain/.vault-identity/master.age` between devices); P0d will add passphrase wrap so identity can enter git |
| Cross-device knowledge + encrypted vault sync | shipped via [ADR 0020](../adr/0020-abrain-auto-sync-to-remote.md): sediment commit → background `git push origin HEAD:main`; pi startup → background `git fetch + merge --ff-only`. `vault/<scope>/*.md.age` (encrypted secrets) and `.vault-identity/master.age.pub` ride this transport. Identity secret stays gitignored. |
| masked TUI wizard | pending (roadmap P0d) |
| `.env` import | pending (roadmap P0d) |
| backend migration wizard | pending (roadmap P0d) |

Operational runbook: [../migration/vault-bootstrap.md](../migration/vault-bootstrap.md). Historical decision: [../adr/0014-abrain-as-personal-brain.md](../adr/0014-abrain-as-personal-brain.md).
