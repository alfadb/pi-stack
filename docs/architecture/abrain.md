# Abrain Architecture — current spec

## 1. Re-scope

`~/.abrain/` 不再只是“跨项目世界知识库”。当前定义：

> `~/.abrain/` 是 alfadb 的数字孪生 / Jarvis brain：关于这个人的长期身份、技能、习惯、工作流、项目知识、跨项目知识和秘密的统一基底。

## 2. Seven zones

```text
~/.abrain/
├── identity/    # who alfadb is; profile, stable preferences, self-model
├── skills/      # durable abilities / reusable procedures
├── habits/      # recurring behavior and preferences
├── workflows/   # cross-project workflows / task blueprints
├── projects/    # project-scoped memory and vaults
├── knowledge/   # cross-project facts/patterns/decisions/maxims
└── vault/       # encrypted global secrets
```

Current implementation status:

| Zone | Writer/read support | Status |
|---|---|---|
| `projects/` | sediment project writer + memory read | shipped |
| `knowledge/` | sediment world writer + memory read | shipped |
| `workflows/` | workflow writer for pipeline-shaped entries | shipped |
| `vault/` | `/vault`、`/secret`、`vault_release`、bash injection | shipped |
| `identity/` | Lane G planned | pending |
| `skills/` | Lane G planned | pending |
| `habits/` | Lane G planned | pending |

## 3. Project strict binding

Project identity is explicit, not inferred. A project is bound only when these artifacts agree:

```text
<project>/.abrain-project.json
~/.abrain/projects/<id>/_project.json
~/.abrain/.state/projects/local-map.json
```

Commands:

```text
/abrain bind --project=<id>
/abrain status
```

Important properties:

- cwd/git remote alone never grants project-scoped privileges.
- active project is a session/boot-time snapshot; shell `cd` does not silently switch scope.
- project vault scope and project memory writer share the same binding substrate.
- unbound/path-unconfirmed state fails closed for project writes.

## 4. Lane model

| Lane | Trigger | Target | Trust |
|---|---|---|---|
| A — explicit MEMORY | user writes `MEMORY: ... END_MEMORY` | project/world/workflow via sediment | high |
| C — auto-write | `agent_end` LLM extraction + curator | project/world/workflow via sediment | medium |
| G — about-me | `/about-me` or `MEMORY-ABOUT-ME` | `identity/skills/habits/` | planned |
| V — vault | `/secret` / vault commands | encrypted vault | highest |

Lane B/D “project→world promotion” is obsolete in seven-zone abrain: writer should route to the correct zone directly instead of promoting later.

## 5. Relationship to `.pensieve/`

Old project memory lived in `<project>/.pensieve/`. Current state:

- memory facade may still read `.pensieve/` as legacy source.
- `/memory migrate --go` moves entries to `~/.abrain/projects/<id>/`.
- sediment writer never writes `.pensieve/` post-B5.
- no symlink compatibility layer is used; split-brain avoidance wins over transparent legacy path.

## 6. Git and state boundaries

| Path | Git? | Meaning |
|---|---|---|
| `~/.abrain/projects/<id>/*.md` | yes | project memory SOT |
| `~/.abrain/knowledge/*.md` | yes | world knowledge SOT |
| `~/.abrain/workflows/*.md` | yes | cross-project workflows |
| `~/.abrain/vault/*.age` | no | encrypted secrets; never commit plaintext/secret ciphertext metadata policy depends on vault docs |
| `~/.abrain/.state/` | no | local maps, audit, locks, metrics |
| `<project>/.pi-astack/` | no | project-local runtime artifacts |

## 7. Design invariants

1. Every durable memory entry has one home zone.
2. LLM does not choose backend/path; routing is code/prompt-mediated and validated.
3. Project identity must be explicit and reversible via git-visible artifacts.
4. Vault plaintext is not memory and does not enter LLM context by default.
5. Derived artifacts (`_index.md`, `graph.json`) can be rebuilt.
6. Migration is forward-only per repo; rollback uses git/pre-migration SHA, not symlink split-brain.

## 8. Current roadmap

- Implement Lane G (`/about-me`, identity/skills/habits writer).
- Improve cross-device sync UX after real multi-machine feedback.
- Evolve schema/audit/binding version handling.
- Keep archive/ADR history out of current operational docs.

Related: [vault.md](./vault.md), [memory.md](./memory.md), [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md), [../adr/0014-abrain-as-personal-brain.md](../adr/0014-abrain-as-personal-brain.md), [../adr/0017-project-binding-strict-mode.md](../adr/0017-project-binding-strict-mode.md).
