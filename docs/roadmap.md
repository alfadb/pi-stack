# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。历史 phase checklist 已归档，不再作为路线图。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| Lane G / about-me | `/about-me` 或 `MEMORY-ABOUT-ME` 写入 `identity/skills/habits/` | 需要明确 identity/habit/skill classifier 与 writer。 |
| Vault P0d/P1 | masked prompt、`.env` import、backend migration wizard | 保持 fail-closed，不引入 plaintext fallback。 |
| Vault failure surfaces | 所有 read/bash authorization/redaction exception 都应 fail-closed | 安全类问题优先级高于便利性。 |
| Curator scope binding | Curator neighbor scope 与 runtime allowed targets 绑定 | 防止 project/world 同 slug 混淆。 |

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path。 |
| Unknown frontmatter preservation | 更新/迁移时尽量保留用户自定义字段。 |
| Git failure recovery | 所有 writer op 在 git failure 后清理 staged changes。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 避免 model-curator 过滤掉 fallback chain 候选。 |
| Dispatch temp prompt uniqueness | 并发 subagent prompt 临时目录避免 timestamp collision。 |

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 可做诊断/加速实验，但不是 `memory_search` fallback。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
