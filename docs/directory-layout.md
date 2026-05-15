# Directory Layout — current reference（2026-05-15）

> 原含 pre-B5 说明的长版已归档到 [archive/directory-layout-pre-2026-05-15.md](./archive/directory-layout-pre-2026-05-15.md)。本文只描述当前实际布局。

## 1. Repository layout

```text
pi-astack/
├── README.md
├── UPSTREAM.md
├── package.json
├── pi-astack-settings.schema.json
├── .gitmodules
├── vendor/
│   ├── gstack/                    # read-only submodule: garrytan/gstack methodology reference
│   └── pensieve/                  # read-only submodule: kingkongshot/Pensieve methodology reference
├── extensions/
│   ├── _shared/
│   ├── abrain/
│   ├── compaction-tuner/
│   ├── dispatch/
│   ├── imagine/
│   ├── memory/
│   ├── model-curator/
│   ├── model-fallback/
│   ├── sediment/
│   └── vision/
├── scripts/
│   └── smoke-*.mjs
└── docs/
    ├── current-state.md
    ├── memory-architecture.md          # current summary / pointer
    ├── brain-redesign-spec.md          # current summary / pointer
    ├── directory-layout.md             # this file
    ├── architecture/
    ├── reference/
    ├── migration/
    ├── adr/
    ├── audits/
    └── archive/
```

Planned but not present as current repo directories: `skills/`, `prompts/`, `defaults/`, `extensions/browse/`. `vendor/` exists, but is read-only methodology/reference material, not runtime package surface.

## 2. Vendor references

| Directory | Upstream | Purpose |
|---|---|---|
| `vendor/gstack/` | `https://github.com/garrytan/gstack.git` | gstack / claude-code workflow methodology reference. |
| `vendor/pensieve/` | `https://github.com/kingkongshot/Pensieve.git` | Pensieve memory/workflow methodology reference. |

Vendor dirs are git submodules. Treat them as read-only source material; port ideas into owned pi-astack paths instead of editing vendor files.

## 3. Extensions

| Directory | Purpose |
|---|---|
| `extensions/dispatch/` | `dispatch_agent` / `dispatch_parallel` subprocess multi-agent tools. |
| `extensions/memory/` | read-only memory facade, LLM search, lint/doctor/migrate commands. |
| `extensions/sediment/` | explicit/auto sediment pipeline and writer substrate. |
| `extensions/abrain/` | seven-zone layout, project binding, vault. |
| `extensions/vision/` | image analysis fallback tool. |
| `extensions/imagine/` | image generation tool. |
| `extensions/model-curator/` | model whitelist + capability prompt injection. |
| `extensions/model-fallback/` | retry/fallback chain after model errors. |
| `extensions/compaction-tuner/` | context percent compaction trigger. |
| `extensions/_shared/` | shared runtime path, timestamp, binding utilities. |

## 4. Runtime paths

### 4.1 Project-local runtime artifacts

```text
<projectRoot>/.pi-astack/
├── sediment/
│   ├── audit.jsonl
│   ├── checkpoint.json
│   └── locks/                 # checkpoint/session locks; entry write lock is in ~/.abrain/.state/sediment/locks/
├── memory/
│   ├── migration-report.md
│   └── search-metrics.jsonl
├── model-fallback/
│   └── canary.log
├── compaction-tuner/
│   └── audit.jsonl
└── imagine/
    └── image-<timestamp>-<hex>.png
```

`.pi-astack/` 是 runtime state/log/output，应该 gitignored。sediment project-scope audit 与 checkpoint/locks 仍保留在 project side，因为它们记录本项目 session/window/candidate 事件；跨项目 entry write lock 在 abrain side。

### 4.2 Abrain repository

```text
~/.abrain/
├── identity/
├── skills/
├── habits/
├── workflows/
├── projects/
│   └── <projectId>/
│       ├── _project.json
│       ├── maxims/
│       ├── decisions/
│       ├── knowledge/
│       ├── staging/
│       ├── archive/
│       ├── workflows/
│       └── vault/
├── knowledge/
├── vault/
├── .vault-master.age
├── .vault-pubkey
└── .state/
    ├── projects/
    │   └── local-map.json
    ├── sediment/
    │   ├── audit.jsonl
    │   └── locks/
    └── vault-events.jsonl
```

Notes:

- `~/.abrain/projects/<id>/` is current project memory SOT.
- `~/.abrain/knowledge/` is world/cross-project knowledge.
- `~/.abrain/workflows/` is cross-project workflows.
- `~/.abrain/.state/` is local runtime state, not memory truth.
- Vault encrypted files are not ordinary memory entries.

### 4.3 Legacy `.pensieve/`

```text
<projectRoot>/.pensieve/
```

Current role: legacy read-only migration source. It may be read by memory facade before migration, and consumed by `/memory migrate --go`; sediment writer no longer creates or writes it.

## 5. Settings

```text
~/.pi/agent/pi-astack-settings.json
```

Schema: [../pi-astack-settings.schema.json](../pi-astack-settings.schema.json).

The settings file uses top-level module keys (`sediment`, `memory`, `modelFallback`, `modelCurator`, `vision`, ...). It is not wrapped under `piStack`.

## 6. Smoke scripts

Live source: `package.json#scripts`.

Current files under `scripts/`:

```text
smoke-abrain-active-project.mjs
smoke-abrain-backend-detect.mjs
smoke-abrain-bootstrap.mjs
smoke-abrain-i18n.mjs
smoke-abrain-secret-scope.mjs
smoke-abrain-vault-bash.mjs
smoke-abrain-vault-reader.mjs
smoke-abrain-vault-writer.mjs
smoke-dispatch-input-compat.mjs
smoke-imagine.mjs
smoke-memory-sediment.mjs
smoke-model-fallback-mutation-timing.mjs
smoke-pi-astack-paths.mjs
smoke-vault-subpi-isolation.mjs
smoke-vision.mjs
```

See [reference/smoke-tests.md](./reference/smoke-tests.md).

## 7. Dependency boundary

- `extensions/_shared/` may be imported by extensions.
- Feature extensions should avoid importing each other unless explicitly designed; shared helpers go to `_shared`.
- Storage topology should stay behind runtime/path helpers and memory facade; LLM prompts should not depend on concrete paths except for user-facing docs.
- Archive docs are historical records and must not be used as implementation guidance.
