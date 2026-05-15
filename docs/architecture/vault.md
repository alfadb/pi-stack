# Vault Architecture — current spec

## 1. Goal

Vault stores secrets inside the abrain substrate without making plaintext part of memory. The rule is strict:

> Secrets may be used by tools and bash, but plaintext enters LLM context only after explicit user authorization.

## 2. Storage model

| Scope | Path | Notes |
|---|---|---|
| Global vault | `~/.abrain/vault/<key>.age` | cross-project secrets |
| Project vault | `~/.abrain/projects/<id>/vault/<key>.age` | active project only |
| Master key | `~/.abrain/.vault-master.age` | encrypted by backend identity |
| Public key | `~/.abrain/.vault-pubkey` | enough for write/encrypt path |
| Audit/state | `~/.abrain/.state/vault-events.jsonl` and related state | no plaintext intended |

Project vault scope uses ADR 0017 active project binding. Other projects' vaults are not visible to the current session unless explicitly supported by a metadata-only command such as all-project listing.

## 3. Backend detection

`/vault init` chooses a portable identity backend. Priority:

1. `SECRETS_BACKEND` override
2. `ssh-key`
3. `gpg-file`
4. `macos`
5. `secret-service`
6. `pass`
7. `passphrase-only`
8. `disabled`

The current design intentionally treats container/devbox environments as first-class: ssh-key / gpg-file / passphrase are primary, desktop keychains are optimizations.

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
- Released output undergoes literal redaction of known plaintext values.
- On failure to safely authorize/redact, the desired direction is fail-closed; audit findings should treat fail-open as security bugs.

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
| masked TUI wizard | pending |
| `.env` import | pending |
| backend migration wizard | pending |

Operational runbook: [../migration/vault-bootstrap.md](../migration/vault-bootstrap.md). Historical decision: [../adr/0014-abrain-as-personal-brain.md](../adr/0014-abrain-as-personal-brain.md).
