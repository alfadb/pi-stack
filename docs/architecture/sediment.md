# Sediment Architecture — current spec

## 1. Role

sediment 是 pi-astack 的唯一 dedicated memory writer。主会话不会获得 `memory_write` 之类的 LLM-facing 工具；长期记忆写入由以下路径完成：

- 明确 `MEMORY: ... END_MEMORY` block（Lane A）。
- `agent_end` 背景 LLM auto-write（Lane C，需配置启用）。
- human slash commands 触发的 maintenance/migration。
- vault Lane V（由 abrain/vault 子系统同步处理，不是 ordinary memory）。

## 2. Pipeline

```text
agent_end
  ├── checkpoint / run-window
  ├── explicit MEMORY extractor（fence-aware）
  ├── if no explicit block and autoLlmWriteEnabled:
  │     └── LLM extractor（transcript → candidates）
  ├── sanitizer（credential/secret hard gate）
  ├── memory_search lookup（ADR 0015）
  ├── curator LLM（create/update/merge/archive/supersede/delete/skip）
  ├── writer validation / lint / lock / atomic write
  ├── audit JSONL
  └── best-effort git commit
```

## 3. Curator operation set

- `create`
- `update`
- `merge`
- `archive`
- `supersede`
- `delete`
- `skip`

ADR 0016 后，curator 是主要语义判断者。旧的 readiness/rate/sampling/rolling/G2-G13 机械 gate 已删除；它们会制造 silent reject 和死条目。

仍然 hard-fail 的内容主要是：

- credential/secret sanitizer。
- schema/kind/status validation。
- slug/path traversal/collision。
- file lock / atomic write / audit consistency。
- git index cleanup best-effort。

## 4. Write targets

B5 cutover 后，sediment 不再写 `<project>/.pensieve/`。

| scope/lane | Target | Audit |
|---|---|---|
| project entry | `~/.abrain/projects/<projectId>/<kindDir>/<slug>.md` | `<projectRoot>/.pi-astack/sediment/audit.jsonl` |
| world entry | `~/.abrain/knowledge/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |
| cross-project workflow | `~/.abrain/workflows/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |
| project workflow | `~/.abrain/projects/<projectId>/workflows/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |

### 4.1 Project kind directory mapping

| kind | Directory |
|---|---|
| `maxim` | `maxims/` |
| `decision` | `decisions/` |
| `smell` | `staging/` |
| `anti-pattern` / `pattern` / `fact` / `preference` | `knowledge/` |
| any archived entry | `archive/` |

World knowledge is flat under `~/.abrain/knowledge/`.

## 5. Locks and runtime state

- Entry write lock：`~/.abrain/.state/sediment/locks/sediment.lock`。
- Project checkpoint：`<projectRoot>/.pi-astack/sediment/checkpoint.json`。
- Project checkpoint/session locks：`<projectRoot>/.pi-astack/sediment/locks/`。
- Project audit：`<projectRoot>/.pi-astack/sediment/audit.jsonl`。
- Abrain/world/workflow audit：`~/.abrain/.state/sediment/audit.jsonl`。

Entry 写锁在 abrain 侧，是因为多个项目会并发写同一个 `~/.abrain` git repo；checkpoint 锁留在 project side，因为它只保护本项目 session 状态。

## 6. Git behavior

sediment 的 markdown write 是 source-of-truth；git commit 是 best-effort audit trail：

- 成功：提交到 `~/.abrain`，commit message 类似 `sediment: update <slug> (project:<id>)` 或 `(world)`。
- 失败：不会回滚已写 markdown；会尽力清理 git index，避免下次 commit 携带 ghost changes。
- 读者应以文件内容 + audit 为准，git 作为回滚/审计网。

## 7. Sub-pi / ephemeral behavior

通过 dispatch 产生的 sub-pi 默认设置 `PI_ABRAIN_DISABLED=1`。沉淀、memory、vault 等扩展在 sub-pi 中不注册或 early return，避免子进程获得长期记忆/secret 写能力。ephemeral session 不推进 checkpoint，也不写长期记忆。

## 8. Prompt-first policy

历史上曾尝试 body shrink / section loss 等 mechanical gates。它们会 silent reject curator 的修复，让条目永久 stale。当前原则：

- 对 LLM 语义错误，优先修 curator/extractor prompt 与 examples。
- 对不可逆安全事故（credential leakage），保留 sanitizer hard gate。
- 对存储完整性，保留 schema/path/lock/atomic write hard gates。

## 9. 相关文档

- [memory.md](./memory.md)
- [abrain.md](./abrain.md)
- [../migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)
- [../adr/0016-sediment-as-llm-curator.md](../adr/0016-sediment-as-llm-curator.md)
- [../adr/0018-sediment-curator-defense-layers.md](../adr/0018-sediment-curator-defense-layers.md)
