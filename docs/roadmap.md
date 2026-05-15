# Roadmap / Backlog

本文只列 current design vision 中仍未完成或有意 deferred 的项。历史 phase checklist 已归档，不再作为路线图。

> **2026-05-15 同步**：roadmap 上一版有几条 debt 已经在 2026-05-14 R5/R6 audit 中落地（dispatch temp prompt uniqueness、vault read/bash fail-closed、writer git rollback、migrate-go frontmatter preservation、Vault P1 active project resolver），本次清理移出 backlog，列入下方 **§ "已落地的旧 backlog（不要再当 debt）"** 防止再被当成未完成项。

## P0/P1 product backlog

| Item | Intent | Notes |
|---|---|---|
| Lane G / about-me | `/about-me` 或 `MEMORY-ABOUT-ME` 写入 `identity/skills/habits/` | 需要明确 identity/habit/skill classifier 与 writer。 |
| Vault P0d | masked input、`.env` import、`/vault migrate-backend` wizard | 保持 fail-closed，不引入 plaintext fallback。Vault P1（active project resolver + `/secret` scope 路由 + `$PVAULT_/$GVAULT_`）已 ship。 |
| `abrain-age-key` identity passphrase wrap | 让 `~/.abrain/.vault-identity/master.age` 能用 passphrase 加密后进 git，实现跨设备仅 `git clone abrain` + 输一次 passphrase。详见 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md) §"P0d 增强"。 | 技术依赖未定：(Y2) `age-encryption` JS lib in-process unwrap · (Y1) `node-pty` 模拟 pseudo-tty 。合并 P0d ADR 决策。 |
| Tier 3 legacy backends reader UX | `ssh-key` / `gpg-file` / `passphrase-only` 在 ADR 0019 后是 explicit-only。`passphrase-only` reader 仍不能解锁（同一 tty pass-through 问题）。 | 上项 abrain-age-key passphrase wrap 落地后该 gap 自动关闭（同一 unwrap 路径）；在那之前 `/vault status` 仍会在旧 backend init 后显示 deprecation 提示。 |
| Curator scope binding（create 分支） | Curator `create` 操作的 scope 判断仍是 prompt-only；非 create 操作（update/merge/archive/supersede/delete）已 runtime enforce。 | 防止 LLM 把 project-specific 内容 create 到 world scope。 |
| Sediment update/merge 路径的 unknown frontmatter preservation 验证 | migrate-go 已保留 raw frontmatter；sediment update path 通过 `{...frontmatter, ...patch}` + `PROTECTED_FRONTMATTER_KEYS` 也基本保留，但**系统化覆盖测试**仍缺。 | 加 smoke fixture：随机 unknown 字段 round-trip update 不丢。 |

## Architecture debt

| Item | Intent |
|---|---|
| Schema evolution | frontmatter/audit/binding schema 的 version upgrade path（当前 `schema_version: 1` 字段已写入，缺多版本兼容/迁移策略）。 |
| Runtime path docs/tests | 避免 `.pensieve`/`.pi-astack`/`.abrain .state` 路径漂移。 |
| Model fallback vs curator whitelist | 当前 model-curator session_start 只 WARN，不阻止 curator 删掉 fallback 候选；需要 curator 在 whitelist 时尊重 fallbackModels 列表，或 fallback 路径自带 whitelist bypass。 |
| Sediment audit candidates.title sanitize | explicit lane 的 audit `candidates[].title` 字段在 R5 之前未走 `sanitizeForMemory`（auto-write lane 同）；2026-05-15 已修，但保留此项提醒未来新加 audit 字段须默认走 `sanitizeAuditText`。 |

## Architecture invariants（已守护，禁止退化）

以下几条曾是 roadmap debt，2026-05-14 R5/R6 audit 已落地为不变量：未来 PR 退化这些行为应视为 regression。

| Invariant | 当前防线 |
|---|---|
| Dispatch temp prompt uniqueness | `extensions/dispatch/index.ts:198` 每次 `runSubprocess` 独立 `fs.mkdtempSync("pi-dispatch-")`；并发 worker 各持独立 tmpDir。 |
| Vault read/bash fail-closed | `extensions/abrain/index.ts:614-704` tool_call inject 失败 `block:true`；tool_result authorization/redaction throw 全 withhold + audit `bash_inject_block` / `bash_output_withhold`。 |
| Writer git rollback | `writer.ts` writeProjectEntry / updateProjectEntry / deleteProjectEntry / writeAbrainWorkflow 在 `gitCommit()===null` 时 `git reset HEAD -- <rel>` + `fs.unlink(target)`。 |
| Vault P1 active project resolver | `extensions/abrain/index.ts:212-249,1075-1101,1145-1185` + `vault-bash.ts:178-211`；`/secret` 默认 active project，`--project=<id>` 必须等于 boot-time 绑定，`$PVAULT_/$GVAULT_` 路由完整。 |
| Curator scope binding（非 create ops） | `extensions/sediment/curator.ts:125-137` `validateScope` 对 update/merge/archive/supersede/delete 强制 neighbor scope 一致；只有 create 仍 prompt-only。 |
| Migrate-go unknown frontmatter preservation | `extensions/memory/migrate-go.ts:690-711,841-855` 迁移路径保留未知 frontmatter raw lines。 |

## Deferred exploration

| Item | Current stance |
|---|---|
| qmd / BM25 optional acceleration | 旧 BM25/tf-idf 仅作为 deprecated dead code 留在 `extensions/memory/search.ts`，不是 `memory_search` fallback；可做离线诊断/加速实验。 |
| Cross-device abrain sync | 等真实多机冲突反馈；不要提前 over-engineer。 |
| Incremental graph rebuild | graph/index 是派生物，当前可 rebuild；增量优化低优先。 |
| Skills/prompts/vendor port | `skills/`、`prompts/`、`vendor/gstack/` 仍是计划，不在 current repo tree。 |

## Design maxim

对 LLM 语义错误，优先改 prompt/curator 反馈，而不是添加 silent mechanical reject gate。例外是 credential/secret 泄漏、path traversal、schema corruption 这类不可逆或存储完整性风险。
