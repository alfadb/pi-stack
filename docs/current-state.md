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
| Lane G writer G1 ✅ shipped | `identity/` / `skills/` / `habits/` 三区 writeAbrainAboutMe + parseExplicitAboutMeBlocks fence + validateRouteDecision（[ADR 0021](./adr/0021-lane-g-identity-skills-habits-writer.md)）。端到端：G2 `/about-me` slash、G3 LLM classifier、G4 review-staging、G5 region-aware ranking hint仍在 backlog。 |
| 跨设备同步 | [ADR 0020](./adr/0020-abrain-auto-sync-to-remote.md)：sediment commit 后后台 `git push origin HEAD:main`；pi 启动 `git fetch + merge --ff-only`。冲突 ff 不可能 → `/abrain status` 提示 + `/abrain sync` 产出运行本。LLM 自动解冲突被明确拒绝（知识库幻觉风险）。 |

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

- 查询 active project abrain store、legacy `<cwd>/.pensieve/`（仅在存在时只读接入，不再写入）和 world store。
- World store 扫描范围是整个 `~/.abrain/`，只排除 `projects/**` 与 `vault/**`；因此 `knowledge/`、`workflows/` 下有 frontmatter 的 md 都可检索（`extensions/memory/parser.ts:72-74,526-538`）。
- 两阶段 LLM rerank：候选选择 + full-content rerank。
- 默认排除 `status=archived`（`search.ts:12-16`）；**`superseded`/`deprecated` 仍然会进入默认结果**，需要 active-only 可显式 `filters.status=active`。
- 返回 normalized cards，字段：`slug/title/summary/score/kind/status/confidence/created/updated/rank_reason/timeline_tail/related_slugs`；不暴露 backend/source_path/scope（`memory_get` exact lookup 作为 debug 接口可暴露）。
- LLM search model 不可用时 hard error（包装为 `isError` tool result）；没有 grep/BM25 fallback。

## 6. Sediment write path

sediment 是唯一 dedicated writer：

1. `agent_end` 读取 session window。
2. 先解析显式 `MEMORY: ... END_MEMORY` blocks。
3. 在进入 LLM / audit / writer 前运行 sanitizer：credential/secret-like strings 被替换为 `[SECRET:<type>]`，不再因 pattern 命中阻断整轮。
4. 没有显式 block 且 `autoLlmWriteEnabled=true` 时，LLM extractor 只接收 redacted transcript，并在 prompt 中被要求保留 typed placeholders、不得还原 raw secret。
5. curator 通过已 redacted 的 `memory_search` query 找邻居并决定 `create/update/merge/archive/supersede/delete/skip`。
6. writer 上锁、lint、atomic write、append audit、best-effort git commit；audit raw text / error / candidates[].title 均存 redacted form（candidates.title 的 sanitizer 覆盖于 2026-05-15 补，之前 explicit/auto-write 两条 lane 的 audit candidates 数组中 title 未走 sanitizer）。
7. git commit 失败时 writer 会 `git reset HEAD -- <rel>` 并 `unlink` 刚刚写入的文件，避免孤儿 staged changes（2026-05-14 R5/R6 audit 落实）。

当前路径：

| scope | 条目路径 | audit 路径 |
|---|---|---|
| project | `~/.abrain/projects/<id>/<kindDir>/<slug>.md` | `<projectRoot>/.pi-astack/sediment/audit.jsonl` |
| world | `~/.abrain/knowledge/<slug>.md` | `~/.abrain/.state/sediment/audit.jsonl` |
| workflow | `~/.abrain/workflows/` 或 `~/.abrain/projects/<id>/workflows/` | `~/.abrain/.state/sediment/audit.jsonl` |

Entry 写锁统一在 `~/.abrain/.state/sediment/locks/`，因为多个项目会写同一个 abrain git repo；project checkpoint/session locks 仍在 `<projectRoot>/.pi-astack/sediment/locks/`。

## 7. Vault 状态

Backend 架构按 [ADR 0019](./adr/0019-abrain-self-managed-vault-identity.md)：abrain 自管 age keypair 为 Tier 1 默认，ssh-key / gpg-file / passphrase-only 降为 Tier 3 explicit-only。

已实现：

- `/vault status`
- `/vault init [--backend=<backend>]` — 不传 flag 默认走 `abrain-age-key`（`age-keygen` 生成专属 keypair，不复用系统 ssh key）。明示 `--backend=ssh-key/gpg-file/passphrase-only` 仍可用，但 stderr warning 提示跨设备负担。
- `/secret set/list/forget`（global/project scope，默认 active project）
- `vault_release(key, scope?, reason?)`（plaintext 进入 LLM 前要求用户授权；prompt 经当前 session model 翻译为用户语言）
- `$VAULT_<key>`：project → global fallback
- `$PVAULT_<key>`：project-only
- `$GVAULT_<key>`：global-only
- bash 输出默认 withheld，授权后 release，并对 plaintext 做 literal redaction（仅覆盖 text part）
- tool_call inject 错误 `block:true`；tool_result authorization/redaction throw 全 withhold + audit `bash_inject_block`/`bash_output_withhold`（2026-05-14 R6 audit fix）
- sub-pi 默认无 vault 工具/权限（三层：dispatch spawn env override + abrain extension activate guard + vault-reader 二次 guard）

**abrain-age-key 路径详情**（ADR 0019）：

- `~/.abrain/.vault-identity/master.age`：abrain 专属私钥、0600、**gitignore**。2026-05-15 后不再寄生 `~/.ssh/id_*`。
- `~/.abrain/.vault-identity/master.age.pub`：公钥，进 git。
- `~/.abrain/.vault-pubkey`：与 `master.age.pub` 同内容，保留以兼容 vault-writer（ADR 0019 invariant 6）。
- `~/.abrain/.vault-master.age`：**abrain-age-key 不生成此文件**（单层 keypair）；仅 Tier 3 backend 使用。
- 跨设备同步：用户手动 `scp ~/.abrain/.vault-identity/master.age …` + `chmod 0600`。误操作失败时 reader 报 actionable error（含 `scp` / `chmod 0600` 提示）而不是 silent "vault locked"。

**旧 backend 用户**（如果 `.vault-backend` 是 `ssh-key`/`gpg-file`/`passphrase-only`）：

- `ssh-key` 与 `gpg-file`：reader 仍 fail-soft 正常解锁（分别调 `ssh-keygen`/`gpg --decrypt`）。
- `passphrase-only`：**reader 已知不能解锁** — `vault-reader.ts::defaultExec` 为避免子进程 prompt 坏 main pi，在未显式传 `input` 时把 `stdio[0]` 设为 `ignore`，age scrypt 拿不到 tty 输入 → 30s 后超时 SIGKILL。该 gap 在 ADR 0019 + roadmap “Tier 3 legacy backends reader UX” 中已记录，**需等 P0d `abrain-age-key` passphrase wrap 落地后一并关闭**（同一 unwrap 路径）。

在所有三种旧 backend 上，`/vault status` 都会显示 `⚠ DEPRECATED backend (ADR 0019)` + 重 init 指令（`backend-detect.ts::formatBackendDeprecation` ~L346）。

未实现/roadmap：

- P0d：`abrain-age-key` identity passphrase wrap（让 `.vault-identity/master.age` 可进 git，跨设备仅 `git clone abrain` + 输一次 passphrase）、masked input、`.env` import、`/vault migrate-backend` wizard。技术依赖选型（`age-encryption` JS lib vs `node-pty`）未定。
- Lane G：`/about-me` 与 identity/skills/habits writer

## 8. 当前测试入口

`package.json#scripts` 是 smoke 列表 live truth。当前 17 个：

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
smoke:abrain-vault-identity
smoke:abrain-git-sync
smoke:abrain-active-project
smoke:abrain-secret-scope
smoke:abrain-i18n
```

## 9. 历史文档处理原则

- ADR 保留设计推演与取代关系；先读 [adr/INDEX.md](./adr/INDEX.md)。
- 旧 monolith 原文移入 [archive/](./archive/)；不要把 archive 当 current spec。
- 迁移目录只保留仍可执行的操作手册；已完成的 phase plan/checklist 移入 archive。
