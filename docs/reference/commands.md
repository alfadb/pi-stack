# Commands and Tools Reference

## 1. LLM-facing tools

These tools may be visible to the assistant depending on pi settings and sub-pi isolation.

| Tool | Purpose | Notes |
|---|---|---|
| `dispatch_agent(model, thinking, prompt, tools?, timeoutMs?)` | Spawn one independent pi subprocess. | Use only for a single task. |
| `dispatch_parallel({tasks}, timeoutMs?)` | Spawn multiple independent pi subprocesses in parallel. | Use for 2+ independent tasks; per-task tools allowlist supported. |
| `memory_search(query, filters?)` | Semantic retrieval over project + world memory. | ADR 0015 LLM retrieval; hard error if model unavailable. |
| `memory_get(slug, options?)` | Exact entry lookup. | May expose scope/source_path for debug/provenance. |
| `memory_list(filters?)` | Metadata browsing. | Not relevance-ranked. |
| `memory_neighbors(slug, options?)` | Read-only graph traversal. | Relations + wikilinks. |
| `vault_release(key, scope?, reason?)` | Release secret plaintext into LLM context after user authorization. | Do not use for shell commands; prefer `$VAULT_*` injection. |
| `vision(imageBase64? | path?, prompt, mimeType?)` | Analyze image with best available vision model. | For screenshots/photos/diagrams when current model cannot see images. |
| `imagine(prompt, size?, quality?, style?, model?)` | Generate image via OpenAI image model. | `style` is encoded as prompt suffix; output saved under `.pi-astack/imagine/`. |

## 2. Human slash command groups

### `/abrain`

```text
/abrain bind --project=<id>
/abrain status
```

Manages ADR 0017 strict project binding. Required before project-scoped sediment/vault writes.

### `/memory`

```text
/memory migrate --dry-run
/memory migrate --go
/memory lint [target]
/memory doctor-lite [target]
/memory check-backlinks [target]
/memory rebuild --index
/memory rebuild --graph
```

Notes:

- `/memory migrate --project=<id>` is deprecated and rejected.
- Migration reads active project binding from `/abrain bind` artifacts.
- `_index.md` and graph are derived artifacts.

### `/sediment`

```text
/sediment status
/sediment dedupe --title <title>
```

Sediment writing normally happens on `agent_end`; these commands are diagnostics/maintenance, not general write tools.

### `/vault` and `/secret`

```text
/vault status
/vault init [--backend=<backend>]
/secret set [--global|--project=<id>] <key>=<value>
/secret list [--global|--project=<id>|--all-projects]
/secret forget [--global|--project=<id>] <key>
```

`/secret` defaults to active project scope when bound; `--global` opts into global vault.

### `/compaction-tuner`

```text
/compaction-tuner status
/compaction-tuner trigger
```

Reads settings from `~/.pi/agent/pi-astack-settings.json#compactionTuner`.

## 3. Bash secret injection

```bash
$VAULT_<key>   # project first, then global fallback
$PVAULT_<key>  # project only
$GVAULT_<key>  # global only
```

Use this instead of `vault_release` when plaintext only needs to reach a subprocess.

## 4. Pending / not current commands

The following names may appear in archived docs but are not current command surface:

| Old/pending command | Status |
|---|---|
| `pi memory migrate ...` | Use slash `/memory migrate ...` in pi session. |
| `/memory migrate --project=<id>` | Deprecated/rejected; use `/abrain bind --project=<id>` first. |
| `pi project switch <id>` | Not a current pi-astack command. |
| `pi brain rebuild-index` | Use `/memory rebuild --index`. |
| `pi brain review-staging` | Roadmap idea, not implemented. |
| `/about-me` | Lane G roadmap, not implemented. |
| `/vault import-env` / `/vault migrate-backend` | Vault P0d/P1 roadmap, not implemented. |
| `/sediment migrate-one` / `/sediment migration-backups` | Removed with per-file migration substrate. |
