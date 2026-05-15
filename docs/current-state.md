# Current State — pi-astack（2026-05-15）

本文是 pi-astack 的当前事实入口。旧路线图、迁移 checklist、历史 ADR 原文可能保留在 `docs/archive/` 或 `docs/adr/` 中，但只要和本文冲突，以本文与 `extensions/` 实现为准。

## 1. 一句话状态

pi-astack 当前是一个 **local pi package**：提供 9 个扩展、9 个 LLM-facing tools、若干 human slash commands，以及基于 `~/.abrain/` 的 markdown+git 记忆/数字孪生系统。

## 2. 当前实现清单

### 2.1 Runtime extensions

| 扩展 | 主要 surface | 状态 |
|---|---|---|
| `extensions/dispatch/` | `dispatch_agent`、`dispatch_parallel` | shipped；子代理是独立 pi 进程；2+ 并行任务必须用 `dispatch_parallel`。 |
| `extensions/memory/` | `memory_search`、`memory_get`、`memory_list`、`memory_neighbors`；`/memory ...` | shipped；只读 facade；ADR 0015 LLM retrieval；legacy `.pensieve/` dual-read。 |
| `extensions/sediment/` | `agent_end` hook；`/sediment status/dedupe` | shipped；唯一 dedicated writer；B5 后写入 abrain。 |
| `extensions/abrain/` | `vault_release`；`/abrain`、`/vault`、`/secret` | shipped；七区 layout、strict binding、vault P0a-P0c。 |
| `extensions/vision/` | `vision(...)` | shipped；图片分析 fallback。 |
| `extensions/imagine/` | `imagine(...)` | shipped；OpenAI Responses API 生图。 |
| `extensions/model-curator/` | 模型能力表注入 | shipped；curated/raw model snapshot。 |
| `extensions/model-fallback/` | error hooks | shipped；初始模型重试耗尽后 fallback。 |
| `extensions/compaction-tuner/` | `/compaction-tuner ...` | shipped；按 context 百分比触发 compaction。 |

### 2.2 Vendor methodology references

| Path | Upstream | 状态 |
|---|---|---|
| `vendor/gstack/` | `https://github.com/garrytan/gstack.git` | read-only submodule；gstack / claude-code workflow methodology reference。 |
| `vendor/pensieve/` | `https://github.com/kingkongshot/Pensieve.git` | read-only submodule；Pensieve memory/workflow methodology reference。 |

Vendor 不属于 runtime surface；不要从 vendor 直接加载 pi 扩展，也不要在 vendor 内直接改端口层代码。

## 3. 记忆与 abrain 状态

| 主题 | 当前事实 |
|---|---|
| Source of truth | markdown 文件 + git history。 |
| gbrain | 已退场；只保留 timeline/graph 方法论影响。 |
| `.pensieve/` | legacy 只读迁移源；sediment 不再写入。 |
| 项目写入 | `~/.abrain/projects/<projectId>/...`。 |
| 世界知识 | `~/.abrain/knowledge/<slug>.md`。 |
| workflows | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/`。 |
| 七区 | `identity/ skills/ habits/ workflows/ projects/ knowledge/ vault/`。 |
| 已有 writer 覆盖 | `projects/`、`knowledge/`、`workflows/`、`vault/`。 |
| 仍待实现 writer | `identity/`、`skills/`、`habits/`（Lane G / about-me）。 |

## 4. Project binding strict mode

Project-scoped memory/vault 权限不再从 cwd、git remote 或旧 `.gbrain-source` 推断。当前必须有三件套一致：

1. 项目仓内：`<project>/.abrain-project.json`
2. abrain 仓内：`~/.abrain/projects/<id>/_project.json`
3. host-local 映射：`~/.abrain/.state/projects/local-map.json`

推荐操作：

```text
/abrain bind --project=<id>
/abrain status
```

active project 是 pi 启动时/会话绑定时的快照；在 shell 中 `cd` 不会自动切换 project scope。

## 5. Memory read path

LLM 只使用：

- `memory_search(query, filters?)`
- `memory_get(slug, options?)`
- `memory_list(filters?)`
- `memory_neighbors(slug, options?)`

`memory_search` 当前语义：

- 查询 active project abrain store、legacy `.pensieve/`（未迁仓只读）和 world knowledge。
- 两阶段 LLM rerank：候选选择 + full-content rerank。
- 默认排除 `status=archived`，除非 filters 显式要求。
- 返回 normalized cards，不暴露 backend/source_path/scope；exact lookup/debug 工具可暴露 provenance。
- LLM search model 不可用时 hard error；没有 grep/BM25 fallback。

## 6. Sediment write path

sediment 是唯一 dedicated writer：

1. `agent_end` 读取 session window。
2. 先解析显式 `MEMORY: ... END_MEMORY` blocks。
3. 没有显式 block 且 `autoLlmWriteEnabled=true` 时，运行 LLM extractor。
4. sanitizer 阻断 credential/secret 风险。
5. curator 通过 `memory_search` 找邻居并决定 `create/update/merge/archive/supersede/delete/skip`。
6. writer 上锁、lint、atomic write、append audit、best-effort git commit。

当前路径：

| scope | 条目路径 | audit 路径 |
|---|---|---|
| project | `~/.abrain/projects/<id>/<kindDir>/<slug>.md` | `<projectRoot>/.pi-astack/sediment/audit.jsonl` |
| world | `~/.abrain/knowledge/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |
| workflow | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/` | `~/.abrain/.state/sediment/audit.jsonl` |

Entry 写锁统一在 `~/.abrain/.state/sediment/locks/`，因为多个项目会写同一个 abrain git repo；project checkpoint/session locks 仍在 `<projectRoot>/.pi-astack/sediment/locks/`。

## 7. Vault 状态

已实现：

- `/vault status`
- `/vault init [--backend=<backend>]`
- `/secret set/list/forget`（global/project scope）
- `vault_release(key, scope?, reason?)`（plaintext 进入 LLM 前要求用户授权）
- `$VAULT_<key>`：project → global fallback
- `$PVAULT_<key>`：project-only
- `$GVAULT_<key>`：global-only
- bash 输出默认 withheld，授权后 release，并对 plaintext 做 literal redaction
- sub-pi 默认无 vault 工具/权限

未实现/roadmap：

- P0d：vault TUI wizard、masked input、`.env` import/migrate-backend
- Lane G：`/about-me` 与 identity/skills/habits writer

## 8. 当前测试入口

`package.json#scripts` 是 smoke 列表 live truth。当前 15 个：

```text
smoke:memory
smoke:dispatch
smoke:fallback-timing
smoke:vision
smoke:imagine
smoke:paths
smoke:vault-subpi-isolation
smoke:abrain
smoke:abrain-bootstrap
smoke:abrain-vault-writer
smoke:abrain-vault-reader
smoke:abrain-vault-bash
smoke:abrain-active-project
smoke:abrain-secret-scope
smoke:abrain-i18n
```

## 9. 历史文档处理原则

- ADR 保留设计推演与取代关系；先读 [adr/INDEX.md](./adr/INDEX.md)。
- 旧 monolith 原文移入 [archive/](./archive/)；不要把 archive 当 current spec。
- 迁移目录只保留仍可执行的操作手册；已完成的 phase plan/checklist 移入 archive。
