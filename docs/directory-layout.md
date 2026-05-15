# pi-astack 目录布局与所有权

> **v7 更新提示**（[memory-architecture.md](./memory-architecture.md)）：记忆基础设施从 gbrain (postgres+pgvector) 整
> 体替换为纯 markdown+git。本文件反映 **当前实际实现状态**（2026-05-12，含 B1 abrain workflows lane writer + B3+B7 per-file migration substrate 剥离 + B4 `/memory migrate --go`）。标注 `[计划]` 的目录尚未实现。

## 实际文件树

```
alfadb/pi-astack/
│
├── package.json                       # pi-package manifest
├── pi-astack-settings.schema.json     # 扩展配置 schema（~/.pi/agent/pi-astack-settings.json）
├── README.md
├── UPSTREAM.md                        # 上游跟踪（B 类 vendor）+ 三分类说明
├── LICENSE                            # MIT
├── .gitignore
├── scripts/                            # ✅ 15 个 smoke 脚本（全部在 package.json scripts 中声明）
│   ├── smoke-memory-sediment.mjs       # memory + sediment smoke 回归（`npm run smoke:memory`）
│   ├── smoke-dispatch-input-compat.mjs # dispatch input 兼容层
│   ├── smoke-model-fallback-mutation-timing.mjs  # fallback mutation 时序
│   ├── smoke-pi-astack-paths.mjs       # `.pi-astack/<module>/` 路径约定
│   ├── smoke-vault-subpi-isolation.mjs # sub-pi `PI_ABRAIN_DISABLED=1` 零注册
│   ├── smoke-abrain-backend-detect.mjs # backend 探测 + status 文案 + tool/command 注册静态检查
│   ├── smoke-abrain-bootstrap.mjs      # master key 生成 + age envelope + inv1-inv6 事务
│   ├── smoke-abrain-vault-writer.mjs   # writeSecret/listSecrets/forgetSecret + atomic lock
│   ├── smoke-abrain-vault-reader.mjs   # unlock master + per-key decrypt + redaction
│   ├── smoke-abrain-vault-bash.mjs     # `$VAULT_` / `$PVAULT_` / `$GVAULT_` 注入 helper
│   ├── smoke-abrain-active-project.mjs # boot-time active project resolver
│   ├── smoke-abrain-secret-scope.mjs   # `--global` / `--project=<id>` / `--all-projects` flag parser
│   ├── smoke-abrain-i18n.mjs           # 授权 prompt 本地化与 fallback
│   ├── smoke-vision.mjs               # vision 模型选择与端到端分析
│   └── smoke-imagine.mjs              # imagine 图像生成与保存
│                                       # （无 .gitmodules — vendor/gstack 尚未挂载）
│
├── docs/                              # ✅ 已实现
│   ├── memory-architecture.md         # 权威设计规范（v7 记忆架构）
│   ├── directory-layout.md            # 本文件
│   ├── adr/
│   │   ├── 0001-pi-astack-as-personal-pi-workflow.md
│   │   ├── 0002-gbrain-as-sole-memory-store.md          # superseded by memory-architecture.md
│   │   ├── 0003-main-session-read-only.md                # 原则保留，guard 实现过时
│   │   ├── 0004-sediment-write-strategy.md               # superseded by ADR 0010
│   │   ├── 0005-pensieve-deprecated.md                   # superseded by memory-architecture.md
│   │   ├── 0006-component-consolidation.md
│   │   ├── 0007-offline-degraded-mode.md                 # 前提被 memory-architecture.md 改变
│   │   ├── 0008-pi-dotfiles-dual-role.md                 # .gbrain-source 作废
│   │   ├── 0009-multi-agent-as-base-capability.md
│   │   ├── 0010-sediment-single-agent-with-lookup-tools.md # 内核保留，tools 过时
│   │   ├── 0011-sediment-two-track-pipeline.md           # superseded by memory-architecture.md
│   │   ├── 0012-sediment-pensieve-gbrain-dual-target.md  # superseded by memory-architecture.md
│   │   ├── 0013-asymmetric-trust-three-lanes.md          # Lane A/B/C/D trust tier (2026-05-08)；Lane B/D 被 ADR 0014 失效
│   │   ├── 0014-abrain-as-personal-brain.md              # ✅ ~/.abrain 重定位为数字孪生七区结构 (2026-05-09, v1.4)
│   │   ├── 0015-memory-search-llm-driven-retrieval.md    # ✅ memory_search 双阶段 LLM rerank (2026-05-10, Accepted; Phase 0/1 implemented)
│   │   ├── 0016-sediment-as-llm-curator.md               # ✅ sediment 从 gate-heavy extractor 转向 LLM curator (2026-05-10)
│   │   └── 0017-project-binding-strict-mode.md           # ✅ B4.5 已实施：.abrain-project.json + registry + local-map strict binding
│   │   └── 0018-sediment-curator-defense-layers.md       # ✅ curator 防线：三层 prompt+writer+input 门控（body_shrink 部分已 revert）
│   ├── brain-redesign-spec.md         # ✅ ADR 0014/0017 详细规范 — abrain 七区拓扑/vault 双层/Lane G/V + strict project binding
│   └── migration/
│       ├── steps.md                   # 基于 memory-architecture.md Phase 1-6（Phase 2 起部分被 ADR 0014 重新规划）
│       ├── apply-checklist.md         # 单文件 migration apply/restore 操作手册
│       ├── abrain-pensieve-migration.md  # ✅ .pensieve/ → ~/.abrain/projects/<id>/ per-repo 迁移 spec（§1 模型 / §2 precondition / §3 迁移动作 / §4 14 仓 / §5 回滚 / §6 ADR 0014 状态推进路径 / §7 历史注记）
│       ├── vault-bootstrap.md         # ✅ vault unlock 平台支持矩阵 v1.4 (portable-identity 优先)
│       ├── phase-2.3-promotion-gates.md  # promotion gates 1-5 详细设计稿（等 Phase 1.4 burn-in 后实施）
│       ├── memory-search-llm-upgrade.md  # ✅ ADR 0015 Phase 0/1 done；Phase 2 被 ADR 0016 改为 curator lifecycle loop 并已落地
│       └── open-questions.md          # 适配新架构的待澄清问题
│
├── extensions/                        # ✅ pi 行为扩展（alfadb own）
│   ├── dispatch/                      # ✅ 已实现：dispatch_agent + dispatch_parallel（子进程隔离）
│   │   ├── index.ts                   # 注册 dispatch_agent / dispatch_parallel（ADR 0009）；sub-pi env 强制注入 PI_ABRAIN_DISABLED=1
│   │   └── input-compat.ts            # JSON 字符串 unwrap + 类型兑底（ADR 0009 §2.5）
│   ├── vision/                        # ✅ 已实现：vision tool（自动选最佳 vision model）
│   │   └── index.ts
│   ├── imagine/                       # ✅ 已实现：imagine tool（OpenAI Responses API 生图）
│   │   └── index.ts
│   ├── model-curator/                 # ✅ 已实现：模型白名单 + 能力提示注入
│   │   └── index.ts
│   ├── model-fallback/                # ✅ 已实现：多模型 fallback 链（旧名 retry-stream-eof）
│   │   └── index.ts
│   ├── memory/                        # ✅ 已实现：v7 主会话只读工具 Facade（Phase 1.1-1.3b + ADR 0015 Phase 0/1 LLM search）
│   │   ├── index.ts                   # tool/command 注册入口；memory_search 默认路由到 LLM rerank
│   │   ├── settings.ts                # pi-astack memory 配置读取（含 memory.search.*）
│   │   ├── types.ts                   # 共享类型
│   │   ├── utils.ts                   # slug/filter/path helpers
│   │   ├── parser.ts                  # markdown/frontmatter/parser + store scan
│   │   ├── search.ts                  # legacy grep+tf-idf implementation for diagnostics/tests + list/get/neighbors 逻辑
│   │   ├── llm-search.ts              # ADR 0015 双阶段 LLM retrieval（stage1 candidate + stage2 rerank）
│   │   ├── lint.ts                    # T1-T10 lint engine
│   │   ├── doctor.ts                  # doctor-lite aggregate health report
│   │   ├── migrate.ts                 # legacy migration dry-run planner (read-only inventory)
│   │   ├── migrate-go.ts              # B4 per-repo 一次性迁移执行器 (.pensieve → ~/.abrain/projects/<id>/)
│   │   ├── git-times.ts               # git log 时间戳 triangulation（created/updated 从 git/fs/frontmatter 三路交叉）
│   │   ├── legacy-seeds.ts            # 5 条知识 maxim legacy seed（Linus/Ousterhout/Google taste review + derived）
│   │   ├── rewrite-cross-scope.ts     # 跨 scope wikilink 显式 prefix rewriter（D-decision）
│   │   ├── graph.ts                   # graph snapshot + check-backlinks + rebuild writer
│   │   └── index-file.ts              # generated enhanced _index.md rebuild writer
│   ├── sediment/                      # ✅ 实现：project-only writer + direct LLM auto-write + ADR 0016 curator/update substrate + B1 abrain workflows lane writer
│   │   ├── index.ts                   # /sediment 子命令 + agent_end hook + footer status FSM (idle/running/completed/failed) + bg promise tracking
│   │   ├── settings.ts                # sediment 配置读取
│   │   ├── checkpoint.ts              # per-session checkpoint + run window builder + RMW lock
│   │   ├── extractor.ts               # deterministic explicit MEMORY block extractor (fence-aware)
│   │   ├── llm-extractor.ts           # LLM extractor prompt (Trust Boundary + durability test) + model call + parser
│   │   ├── curator.ts                 # ADR 0016 memory_search-powered curator loop (create/update/merge/archive/supersede/delete/skip)
│   │   ├── validation.ts              # schema-only draft runtime validation
│   │   ├── dedupe.ts                  # storage-only slug collision detection（semantic dedupe 由 curator 处理）
│   │   ├── sanitizer.ts               # sensitive-info fail-closed (jwt/pem/aws/url/email/ip/$HOME)
│   │   └── writer.ts                  # create/update/archive/supersede/delete substrate + on-demand .pensieve create + validate/sensitive-info sanitize/dedupe/lint/lock/atomic write/audit/git + writer audit correlation ids + writeAbrainWorkflow (B1：pipeline-型条目路由到 ~/.abrain/workflows/ 或 projects/<id>/workflows/，走独立 abrain-side lock + audit + git commit）
│   ├── compaction-tuner/              # ✅ 实现：计划外落地（2026-05-08）
│   │   ├── index.ts                   # agent_end hook 读 ctx.getContextUsage() 超阈 → ctx.compact()；/compaction-tuner [status|trigger]
│   │   └── settings.ts                # thresholdPercent / rearmMarginPercent
│   ├── abrain/                        # ✅ vault P0a/P0b/P0c.write/P0c.read + P1 全部 ship（2026-05-09 → 2026-05-11, ADR 0014 §D4）
│   │   ├── index.ts                   # /vault status|init + /secret set|list|forget + vault_release LLM tool + bash hook；PI_ABRAIN_DISABLED=1 时 register nothing
│   │   ├── backend-detect.ts          # ssh-key/gpg-file/macos/secret-service/pass/passphrase-only/disabled 优先级探测 + $SECRETS_BACKEND env override（vault-bootstrap §1.4）
│   │   ├── bootstrap.ts               # master key 生成 + install tmp + cleanup（inv1-inv6 事务安全）
│   │   ├── brain-layout.ts            # 七区顶层目录 ensure（identity / skills / habits / workflows / projects / knowledge / vault），0o700 perms
│   │   ├── keychain.ts                # macOS Keychain / secret-service / pass dispatch（Tier 2 optimization）
│   │   ├── i18n.ts                    # 授权 prompt 本地化（最近 3 条 user msg 推语言 + 200 条 cache + 12s timeout + 英文 fallback）
│   │   ├── vault-writer.ts            # writeSecret/listSecrets/forgetSecret/reconcile；transactional + age 公钥加密（不接触 master key 明文）+ atomic lock（`open(... 'wx')` + stale reclaim）+ value buffer zero-out + audit ops closure
│   │   ├── vault-reader.ts            # P0c.read core substrate：unlock master identity + decrypt per-key secret + literal redaction helper（vault_release 的底层）
│   │   └── vault-bash.ts              # boot-aware `$VAULT_` / `$PVAULT_` / `$GVAULT_` 注入（0600 env file + `trap rm -f` 自清理，stdout 默认不回流 LLM）
│   ├── _shared/                       # ✅ 跨扩展 helpers
│   │   ├── footer-status.ts           # 统一 footer status keys（ordered, dispatch state machine, model-curator total count）
│   │   └── runtime.ts                 # local-tz timestamp / .pi-astack/<module>/ path / appendAudit / active-project resolver（B4.5 后迁至 strict manifest+registry+local-map）
│   └── browse/                        # [计划] from pi-gstack
│
├── skills/                            # [计划] pi 技能（19 gstack skills + memory-wand）
├── prompts/                           # [计划] pi 提示模板（5 pipeline prompts）
├── vendor/                            # [计划] READ-ONLY 上游参考源
│   └── gstack/                        # [计划] submodule → garrytan/gstack
└── defaults/                          # [计划] package-local fallback / 文档示例
    └── pi-astack.defaults.json
```

## 已实现 vs 计划对照

| 目录 | 状态 | Phase 依赖 |
|------|------|-----------|
| `extensions/dispatch/` | ✅ 已实现 | — |
| `extensions/vision/` | ✅ 已实现 | — |
| `extensions/imagine/` | ✅ 已实现 | — |
| `extensions/model-curator/` | ✅ 已实现 | — |
| `extensions/model-fallback/` | ✅ 已实现 | — |
| `extensions/memory/` | ✅ 已实现（只读 Facade + ADR 0015 LLM search Phase 0/1 + lint/migrate dry-run/check-backlinks + B4/B4.5 strict per-repo migrate） | Phase 1.1-1.3b + ADR 0015 + ADR 0017 |
| `extensions/sediment/` | ✅ 实现（explicit extractor + direct LLM auto-write LIVE + status FSM + memory_search-powered create/update/merge/archive/supersede/delete/skip curator + B1 abrain workflows lane writer；writer 按需创建 `.pensieve/`；bg 在飞时不推进 checkpoint/不写 skip audit；无 dry-run/readiness/rate/sampling/rolling/G2-G13 机械门控。原 per-file `migration.ts` 基底于 2026-05-12 剥离；per-repo 迁移工具 `/memory migrate --go` 于 2026-05-12 ship（B4 ✅，`extensions/memory/migrate-go.ts`）；ADR 0017 strict binding guard 已拒绝未 bound 项目的 sediment hook 写入。） | Phase 1.4 A1+A2+A3 + ADR 0016 + ADR 0017 |
| `extensions/compaction-tuner/` | ✅ 实现（percent-based ctx.compact() trigger + hysteresis） | 计划外（2026-05-08） |
| `extensions/abrain/` | ✅ vault P0a-c + B4.5 strict binding ship： backend-detect + master-key bootstrap + vaultWriter + vaultReader + /vault + /secret （default = strict-bound active project，--global opt-out，--project=<id> 仅允许等于 bound project，--all-projects 枚举） + `/abrain bind/status` + `vault_release(key, scope?, reason?)` （pre-flight + deny-first + i18n + description rendering） + boot-aware `$VAULT_*` / `$PVAULT_*` / `$GVAULT_*` bash injection 与 default-withheld + literal redaction + read-path audit closure（release / release_denied / release_blocked / bash_inject / bash_inject_block / bash_output_release / bash_output_withhold） | ADR 0014 §D4 P0a/P0b/P0c.write/P0c.read + ADR 0017 strict project binding |
| `extensions/browse/` | [计划] | Slice F（旧路线图） |
| `skills/` | [计划] | Slice F |
| `prompts/` | [计划] | Slice F |
| `vendor/gstack/` | [计划] | Slice F |
| `defaults/` | [计划] | 低优先级 |

## 已实现扩展详情

### extensions/memory/

v7 markdown+git 记忆架构的只读 Facade。注册 4 个 LLM-facing 工具：

| 工具 | 说明 |
|------|------|
| `memory_search(query, filters?)` | ADR 0015 双阶段 LLM retrieval；query 是自然语言检索 prompt；返回 bare slug/title/summary/score/kind/status/confidence/created/updated/rank_reason/timeline_tail，不暴露 backend/source_path/scope，不降级到 grep |
| `memory_get(slug, options?)` | bare slug 精确读取；返回完整 canonical entry（含 timeline/source_path/scope） |
| `memory_list(filters?)` | 分页浏览条目 metadata，主要用于人工/debug |
| `memory_neighbors(slug, options?)` | 只读遍历 frontmatter relations + `[[wikilink]]`，不写关系 |

读取范围：当前项目 `.pensieve/` + 可选 `ABRAIN_ROOT`（默认 `~/.abrain`，存在才扫描）。写入由 `extensions/sediment/` 独占；主会话不暴露写工具。

Human-facing 命令：
- `/memory lint [path]`：执行 T1-T10 Timeline/frontmatter lint，不注册为 LLM tool
- `/memory doctor-lite [path]`：汇总 lint / graph / index / migration / sediment auto-write audit 状态
- `/memory migrate --dry-run [--report] [path]`：生成 legacy `.pensieve/` → schema v1 的迁移计划；`--report` 写 `.pi-astack/memory/migration-report.md`。迁移必须先 `/abrain bind --project=<id>`，`/memory migrate` 不再接受 `--project`。
- `/memory check-backlinks [path]`：in-memory 构建 graph snapshot，报告 dead links 与缺失 symmetric backlinks
- `/memory rebuild --graph [path]`：写入 derived graph index（project: `.index/graph.json`；world: `.state/index/graph.json`）
- `/memory rebuild --index [path]`：写入 generated markdown index（`_index.md`）

配置：`pi-astack-settings.json → memory.{includeWorld, defaultLimit, maxLimit, maxEntries, projectBoost, shortTermTtlDays}`

### extensions/dispatch/

子进程隔离的 `dispatch_agent` / `dispatch_parallel`。每个子 agent = 独立 pi 进程，通过 JSON 事件流通信。

| 文件 | 说明 |
|------|------|
| `index.ts` | 注册 dispatch_agent + dispatch_parallel；子进程 spawn + JSON 事件流解析 |
| `input-compat.ts` | JSON 字符串 unwrap（最多 2 层）+ tools array→CSV + timeoutMs string→number |

工具签名（与 ADR 0009 一致）：
- `dispatch_agent(model, thinking, prompt, tools?, timeoutMs?)`
- `dispatch_parallel(tasks[{model, thinking, prompt, timeoutMs?}], timeoutMs?)`

### extensions/vision/

自动选择最强 vision-capable model（排除调用者自身），进程内 `streamSimple` 调用。

配置：`pi-astack-settings.json → vision.modelPreferences`

### extensions/imagine/

OpenAI Responses API 生图。复用用户已有的 openai provider 配置（key + baseUrl），零额外配置。

输出：`.pi-astack/imagine/`（PNG）

### extensions/model-curator/

两职责：
1. **白名单**：过滤 pi-ai 数百模型 → 精选 keep-list
2. **能力提示**：每轮 `before_agent_start` 注入 markdown 能力表到 system prompt

配置：`pi-astack-settings.json → modelCurator.{providers, hints, imageGen}`

### extensions/model-fallback/

非对称多模型 fallback：
- 初始模型走 pi 内建指数退避重试（自动读 `settings.json#retry.maxRetries`）
- 耗尽后按 `fallbackModels` 列表切下一个，每个仅尝试 1 次
- 全部失败才停

配置：`pi-astack-settings.json → modelFallback.fallbackModels`

旧名：`retry-stream-eof` → `retry-all-errors` → `model-fallback`

## 运行态产出布局（`.pi-astack/` + `~/.abrain/.state/`）

> **B5 cutover (2026-05-13)：** sediment 的 audit、locks 已迁移到 `~/.abrain/.state/sediment/`（`audit.jsonl` + `locks/sediment.lock`）。只有 session-local 状态（checkpoint.json）和 module-specific 产出（imagine/compaction-tuner/model-fallback）保留在 `<projectRoot>/.pi-astack/<module>/` 下。

**B5 后实际布局：**

```
项目侧 (<projectRoot>):                      Abrain 全局侧 (~/.abrain):
─────────────────────────                  ────────────────────────
.pi-astack/                                .state/
├── imagine/            (PNG 生成品)        └── sediment/
├── compaction-tuner/   (触达审计)              ├── audit.jsonl       ★ B5 迁移
│   └── audit.jsonl                          └── locks/
├── model-fallback/     (canary 日志)             └── sediment.lock   ★ B5 迁移
│   └── canary.log
└── sediment/
    └── checkpoint.json  (单 session state)

(旧路径不再写入，仅 legacy rename):
.pensieve/.state/sediment-events.jsonl   → rename → ~/.abrain/.state/sediment/audit.jsonl (一次性)
```

**B5 前（已过时，仅供参考）：**

```
<projectRoot>/
├── .pi-astack/
│   ├── imagine/                     # 生成的 PNG（gpt-image-2 输出）
│   ├── sediment/
│   │   ├── audit.jsonl              # JSONL；v2 schema：本地 TZ + audit_version + pid + project_root + lane/session_id/correlation_id/candidate_id + settings_snapshot + entry_breakdown + parser_version + stage_ms
│   │   ├── checkpoint.json          # 上次处理过的 entry_id
│   │   └── locks/                   # ephemeral 文件锁
│   ├── memory/
│   │   └── migration-report.md      # /memory migrate --dry-run --report 输出
│   ├── compaction-tuner/
│   │   └── audit.jsonl              # percent-trigger 事件 + hysteresis state
│   └── model-fallback/
│       └── canary.log               # provider error / fallback 触发记录
└── .pensieve/
    ├── decisions/ knowledge/ maxims/ pipelines/  # canonical markdown
    ├── _index.md                                  # auto-generated TOC
    └── .index/graph.json                          # auto-generated graph
```

> **2026-05-11 补充**：`imagine/` `compaction-tuner/` `model-fallback/` 三个子树最初漏在上表外，现补全。`~/.pi-extensions/model-fallback.log` 是 pre-pi-astack 时代的旧路径，`scripts/smoke-pi-astack-paths.mjs:legacyModelFallbackCanaryPath` 仍作为迁移 regression 检查点保留。

**迁移**（一次性）：首次 `appendAudit` / `loadCheckpoint` 调用会检测 legacy `.pensieve/.state/sediment-events.jsonl` / `sediment-checkpoint.json`，如存在则 `rename` 到新位置。两边都存在时 audit 按追加合并，checkpoint 保留 canonical。

**时间戳**：所有 audit / checkpoint / generated report 的时间戳都是带本地时区偏移的 ISO 8601（例 `2026-05-08T14:23:19.436+08:00`），不再用 UTC `Z` 后缀。

### 并发模型（多 pi 实例 / 子进程 / ephemeral）

Checkpoint v2 格式：

```json
{
  "schema_version": 2,
  "sessions": {
    "<sessionId-uuid>": {
      "lastProcessedEntryId": "...",
      "updatedAt": "2026-05-08T14:43:07.080+08:00"
    }
  }
}
```

- **多个 pi 实例在同一 `<projectRoot>/`**：每个会话有独立的 sessionId slot，互不覆盖。`saveSessionCheckpoint` 用文件锁（`.pi-astack/sediment/locks/checkpoint.lock`）串行化 read-modify-write，避免并发丢更新。锁隐含 30s 偏移后可被偷 (steal) 以防会话崩溃后死锁。
- **子进程 pi / `pi --print --no-session` / dispatch_agent 生成的 ephemeral session**：`getSessionFile()` 返回 undefined 时被识别为 ephemeral，agent_end hook **early-return**，不跑 `parseExplicitMemoryBlocks`、不写 `.pensieve/`、不存 checkpoint。仅追加一行 audit `operation: skip / reason: ephemeral_session / ephemeral_session: true` 用于 observability。

  设计意图：
  - dispatch_agent 子任务输出会作为 tool_result 返回主会话，主会话的 sediment 会看到并决定是否记录；子进程再跳一次是冗余。
  - `--no-session` 是用户显式的 "throwaway" 信号，在 `.pensieve/` 里写入并 git commit 违背其语义。
  - 归因：`session_id: undefined` 的条目无 session JSONL 可追溯，事后调试 "这条哪来的" 答不出。
- **Audit 并发追加**：依赖 Linux `O_APPEND` 原子性（< PIPE_BUF=4KB 单次写入原子），JSONL 行 < 4KB 不会擕裂；多会话的行会交错但每行 `session_id` 可区分。
- **v1 schema 迁移**：旧版 `{ lastProcessedEntryId, updatedAt }` 装进 `sessions._legacy` slot，被首个保存的 session 收养后清除。
- **冗余会话清理**：`updatedAt > 90 天` 的 session slot 在下一次 RMW 时自动 prune，避免 sessions map 无限生长。

## 配置

pi-astack 使用独立配置文件 `~/.pi/agent/pi-astack-settings.json`，schema 定义在本仓 `pi-astack-settings.schema.json`。

不被 pi 官方 settings chain 加载——各扩展自行 `fs.readFileSync` 读取。

| 扩展 | 配置键 |
|------|--------|
| modelCurator | `providers`, `hints`, `imageGen` |
| modelFallback | `fallbackModels` |
| memory | `includeWorld`, `defaultLimit`, `maxLimit`, `maxEntries`, `projectBoost`, `shortTermTtlDays`, `search.{stage1Model,stage1Limit,stage1Thinking,stage2Model,stage2Limit,stage2Thinking}` |
| sediment | `enabled`, `gitCommit`, `lockTimeoutMs`, `defaultConfidence`, `minWindowChars`, `maxWindowChars`, `maxWindowEntries`, `maxEntryChars`, `extractorModel`, `extractorTimeoutMs`, `extractorMaxRetries`, `extractorMaxCandidates`, `extractorAuditRawChars`, `curatorModel`, `curatorTimeoutMs`, `curatorMaxRetries`, `autoLlmWriteEnabled`, `autoWriteRawAuditChars` |
| compactionTuner | `enabled`, `thresholdPercent`, `rearmMarginPercent`, `notifyOnTrigger`, `customInstructions` |
| vision | `modelPreferences` |

## 所有权矩阵

| 目录 | 所有者 | 状态 | 是否可修改 |
|------|--------|------|-----------|
| `extensions/dispatch/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/vision/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/imagine/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/model-curator/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/model-fallback/` | alfadb（A 类永久 own） | ✅ 已实现 | ✅ |
| `extensions/memory/` | alfadb（v7 新建） | ✅ 已实现（只读 Facade） | ✅ |
| `extensions/sediment/` | alfadb（A 类改造） | ✅ 实现（explicit extractor + LLM auto-write LIVE + LLM semantic policy/update substrate + B1 abrain workflows lane writer） | ✅ |
| `extensions/browse/` | alfadb（C 类迁入） | [计划] | ✅ |
| `skills/` | alfadb（B 类端口） | [计划] | ✅ |
| `prompts/` | alfadb（A 类 + B 类） | [计划] | ✅ |
| `vendor/gstack/` | garrytan | [计划] | ❌ 只读 |
| `defaults/` | alfadb | [计划] | ✅ |
| `docs/` | alfadb | ✅ 已实现 | ✅ |

## 单向依赖图

```
                    pi 加载机制
                       │
        ┌──────────────┼─────────────┐
        ▼              ▼             ▼
  pi.extensions  pi.skills   pi.prompts
        │            │            │
        ▼            ▼            ▼
  extensions/    skills/    prompts/
  (9 已实现)    (待迁入)   (待迁入)

  dispatch/ ─── 子进程 spawn ─── pi（独立实例，OS 级隔离）
  vision/   ─── 进程内 streamSimple
  imagine/  ─── OpenAI Responses API（复用 openai provider 配置）
  model-curator/ ─── pi.registerProvider() + before_agent_start 注入
  model-fallback/ ─── agent_end 拦截 + pi 内建 retry 对齐

  memory/   ──→ markdown + git (source of truth, read-only)
                 ├── <project>/.pensieve/     (项目级)
                 └── ~/.abrain/               (世界级，可选)
  sediment/ ──→ markdown + git (唯一写入者；explicit extractor + LLM auto-write LIVE；ADR 0016 转向 curator/update)
```

**严禁的引用关系**:
1. `extensions/* → vendor/*`（端口层不能依赖 vendor）
2. `skills/* / prompts/* → 任何代码`（声明式资源）
3. `vendor/* → 任何 pi-astack 内容`（vendor 是 read-only 上游快照）
