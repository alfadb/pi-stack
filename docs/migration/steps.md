# pi-astack 迁移路径（Phase 路线图）

> 基于 [memory-architecture.md](../memory-architecture.md) §11 实施路线图。
> 替代旧 7 Slice (A→G) 方案（基于 gbrain，已于 2026-05-07 作废）。
>
> 单文件 apply/restore 操作手册见 [apply-checklist.md](./apply-checklist.md)。

## 总览

| Phase | 内容 | 依赖 | MV 目标 |
|---|---|---|---|
| **Phase 1** | Project 层 + 格式标准化 | 无 | 项目级 markdown 知识库可用 |
| **Phase 2** | World 层接入 | Phase 1 | `~/.abrain/` 跨项目知识可用 |
| **Phase 3** | qmd 集成（可选加速） | Phase 1 | 全文/语义搜索加速 |
| **Phase 4** | 派生索引 + Health + 查询反哺 | Phase 2 | graph.json / doctor / passive nudge |
| **Phase 5** | 治理 | Phase 4 | 冲突检测 / promotion gates 完善 |
| **Phase 6** | Session 层（可选探索） | Phase 2+ | 内存 scratchpad |

---

## Phase 1：Project 层 + 格式标准化（MVP）

**验收标准**：
- [x] Markdown 条目格式标准化（frontmatter schema v1 + compiled truth + `## Timeline`）— 真实迁移已完成（~/.pi 父仓 173 → 0 pending，lint 0 errors，dead links 0）
- [x] 10 条 Lint 规则实现（T1-T10；`/memory lint [path]` slash command，CLI wrapper 未实现；另有 `/memory doctor-lite [path]` 聚合报告）
- [x] 旧格式迁移工具：`/memory migrate --dry-run [path]` 全库计划生成 + `/sediment migrate-one --plan <file>` 单文件预览 + `/sediment migrate-one --apply --yes <file>` 单文件 apply + `/sediment migrate-one --restore <backup> --yes` 单文件恢复 + `/sediment migration-backups` 恢复点列表；**batch apply 不再追加**（单文件 + git commit-per-batch 已被验证足够）
- [x] `memory_search` grep-based 实现（rg 文件发现 + per-file tf-idf + title/slug boost；project 层 + 可选 world 只读）
- [x] `memory_get` / `memory_list` 实现（另含 `memory_neighbors` 只读遍历）
- [x] `_index.md` 自动生成（已实现 `/memory rebuild --index [path]`；`/sediment migrate-one` 成功后自动重建）
- [x] graph 派生索引：已实现 `buildGraphSnapshot` + `/memory check-backlinks [path]` + `/memory rebuild --graph [path]`；`/sediment migrate-one` 成功后自动重建 `.pensieve/.index/graph.json`
- [ ] Sediment project-only pipeline：writer substrate 已实现（validate → sanitize → deterministic dedupe → lint → lock → atomic write md → git best-effort → audit）；extract/classify/agent_end 自动写仍待实现
- [x] Project scope 的 file lock + 错误恢复（writer substrate）
- [x] 最小脱敏：credential pattern → 写入拒绝（fail-closed）；$HOME 路径替换

**不包含**：World 层、向量搜索、promotion gates、passive nudge、语义 dedupe

### Phase 1.0 — doctor-lite aggregate status

**实现状态（2026-05-08）**：`extensions/memory/doctor.ts` 已实现 `/memory doctor-lite [path]`，聚合 Phase 1 关键状态，便于判断 legacy migration / graph / lint / sediment dry-run 是否就绪。

汇总范围：
- lint error/warning
- graph/backlink dead links / symmetric backlink
- generated `_index.md` 是否可构建
- migration pending count
- migration backup count / state（`restorable_remove_target`、`target_modified`、`already_restored` 等）
- sediment `llm_dry_run` pass/fail/pass-rate

**验收**：
```text
/memory doctor-lite .pensieve
# → 返回 PASS / WARNING / ERROR 及分项摘要
```

### Phase 1.1 — 条目格式标准化

**实现状态（2026-05-08）**：`extensions/memory/lint.ts` 已实现 T1-T10 lint engine，`extensions/memory/index.ts` 注册 human-facing slash command `/memory lint [path]`。CLI wrapper（`pi memory lint ...`）尚未实现。

- 定义 frontmatter schema v1（scope/kind/status/confidence/created/updated/schema_version）
- 实现 compiled truth + `## Timeline` 格式
- 实现 10 条 Lint 规则（T1-T10）
- 编写 `/memory lint [path]` 命令（slash command，不暴露为 LLM tool）

**验收**：
```text
# 创建示例条目，lint 通过
/memory lint .pensieve/knowledge/test-entry.md
# → "Memory lint: 0 error(s), 0 warning(s), 1 file(s) checked — passed"
```

### Phase 1.2 — 旧格式迁移

**实现状态（2026-05-08）**：`extensions/memory/migrate.ts` 已实现 `/memory migrate --dry-run [--report] [path]` 的计划生成逻辑，`extensions/memory/index.ts` 注册命令入口；只生成迁移计划，不写 markdown 条目。`--report` 仅写 generated report 到 `.pi-astack/memory/migration-report.md`（与 [apply-checklist.md](./apply-checklist.md) §1 一致）。实际条目迁移由 `extensions/sediment/migration.ts` 的 `/sediment migrate-one --plan <file>` / `/sediment migrate-one --apply --yes <file>` / `/sediment migrate-one --restore <backup> --yes` 承接；`/sediment migration-backups [--limit N]` 可列出最近 backup 与 restore 命令。一次只预览、迁移或恢复单文件，以保持 staged/reversible；batch apply 尚未实现。

- 识别旧格式条目：无 `schema_version` 或无 `---` 分隔符
- 自动映射：旧 `short-term/` → 条目移入同级目录 + `lifetime.kind: ttl`
- 缺失 timeline：迁移时生成初始 timeline 行
- 迁移前备份 source；apply/restore 后 best-effort git commit（失败不回滚 markdown）
- 支持 `--dry-run`
- 支持 `--report` 写入 `.pi-astack/memory/migration-report.md`（generated artifact）；report 每个 migration item 都包含推荐的 `/sediment migrate-one --plan ...` 与 `/sediment migrate-one --apply --yes ...` 命令

**当前验收**：
```text
/memory migrate --dry-run .pensieve
# → 显示迁移计划，不修改 markdown 条目

/memory migrate --dry-run --report .pensieve
# → 写入 .pi-astack/memory/migration-report.md，便于人工审查；每项都带 plan/apply 单文件命令
```

**plan/apply/restore 验收（单文件）**：
```text
# 预览单文件迁移结果，不写入、不 audit、不重建 derived artifacts
/sediment migrate-one --plan .pensieve/short-term/maxims/example.md
# → 返回 target/actions/lint/frontmatter/body preview，供人工审计

# 由 sediment/migration writer 执行，非当前 read-only extension
/sediment migrate-one --apply --yes .pensieve/short-term/maxims/example.md
# → 备份 source，写入 schema v1/canonical path，返回 restore_command，并重建 .pensieve/.index/graph.json + .pensieve/_index.md

# 列出最近 migration backups 与对应 restore_command
/sediment migration-backups --limit 20
# → 返回 backup_path/source_path/target_path/state/restore_command

# 从 apply 产生的 backup 恢复原 source；仅在 target 未被手改时自动删除 target
/sediment migrate-one --restore .pensieve/.state/migration-backups/<timestamp>/short-term/maxims/example.md --yes
# → 恢复原 legacy source，删除可验证的迁移 target，并重建 graph/index；若 target 已被手改则拒绝 target_modified
```

**操作手册**：真实项目迁移按 [apply-checklist.md](./apply-checklist.md) 执行。实践中 LLM 在同一会话内调用 `migrateOne({apply:true,yes:true,gitCommit:false})` 批处理并 git commit-per-batch 已足够。

**状态**：迁移完成（2026-05-08）。~/.pi 父仓 173 → 0 pending，14 batch，所有 commit 逆向可追。batch apply CLI 按原计划**不再追加**（详见 [apply-checklist.md](./apply-checklist.md) Status 段）。

### Phase 1.3 — memory_search（grep-based）

**实现状态（2026-05-08）**：`extensions/memory/search.ts` + `parser.ts` 已实现检索/读取逻辑，`extensions/memory/index.ts` 注册 `memory_search` / `memory_get` / `memory_list` / `memory_neighbors` 四个只读工具。

- rg 文件发现 + per-file tf-idf 评分 + title/slug boost
- project 层为主；`ABRAIN_ROOT` / `~/.abrain` 存在时可选只读扫描 world 层
- 默认排除 status=archived
- `memory_search` 返回 LLM-facing schema（bare slug, 不含 scope/backend/source_path）

**验收**：
```text
# 写入几条测试条目后，在 pi 会话中调用 LLM-facing tool：
memory_search(query: "dispatch agent prompt")
# → 返回相关条目，含 score / kind / status / confidence
```

> CLI wrapper（`pi memory search ...`）尚未实现；当前完成的是 extension tool surface。

### Phase 1.3a — `_index.md` generated markdown index

**实现状态（2026-05-08）**：`extensions/memory/index-file.ts` 已实现 generated `_index.md` builder，`extensions/memory/index.ts` 注册 human-facing slash command `/memory rebuild --index [path]`。

- 按 kind 分组，组内按 confidence 降序、updated 降序
- Recently Updated top 10
- Orphans 仅列出 staging 中零入/出边条目
- 原子写入 `<target>/_index.md`

**当前验收**：
```text
/memory rebuild --index .pensieve
# → 写入 .pensieve/_index.md（generated artifact）
```

### Phase 1.3b — graph snapshot + check-backlinks（read-only）

**实现状态（2026-05-08）**：`extensions/memory/graph.ts` 已实现 `buildGraphSnapshot()` / `checkBacklinks()` / `rebuildGraphIndex()`，`extensions/memory/index.ts` 注册 human-facing slash commands `/memory check-backlinks [path]` 与 `/memory rebuild --graph [path]`。

- 从 markdown frontmatter relations + body `[[wikilink]]` 构建 graph snapshot
- 统计 node/edge/orphan/dead link
- 检查 symmetric relations（`relates_to` / `contested_with`）是否缺反向边
- `/memory check-backlinks` 只读报告，不写 `.pensieve/.index/graph.json`
- `/memory rebuild --graph` 原子写入 derived index：project → `.pensieve/.index/graph.json`；world → `.state/index/graph.json`

**当前验收**：
```text
/memory check-backlinks .pensieve
# → 返回 dead link / missing symmetric backlink 报告
```

**当前验收**：
```text
/memory rebuild --graph .pensieve
# → 写入 .pensieve/.index/graph.json（derived artifact）
```

### Phase 1.4 — Sediment project-only pipeline

**实现状态（2026-05-08）**：`extensions/sediment/writer.ts` 已实现 project-only writer substrate；`extensions/sediment/checkpoint.ts` 已实现 per-session checkpoint + RMW 锁 + run window builder；`extensions/sediment/extractor.ts` 已实现 fence-aware deterministic explicit `MEMORY:` block extractor；`extensions/sediment/llm-extractor.ts` 已实现 prompt (含 Trust Boundary role-aware 指令) + model call + parser；`extensions/sediment/index.ts` 注册 全部 `/sediment` 子命令 + `agent_end` hook。底层走 deterministic explicit `MEMORY:` lane；**LLM auto-write lane 已接入 hook**（Phase 1.4 A2，2026-05-08），在显式 miss 后、`autoLlmWriteEnabled=true` 且 readiness/rolling/rate/sampling 全部放行后调用 LLM。

已完成 checkpoint/window substrate：
- checkpoint path：`.pi-astack/sediment/checkpoint.json`
- `buildRunWindow(branch, checkpoint)`：从 `ctx.sessionManager.getBranch()` 取 checkpoint 之后的新 entries
- compaction/branch fallback：checkpoint entry 找不到时只取最新 entry，避免重放全历史
- window budget：`minWindowChars` / `maxWindowChars` / `maxWindowEntries`
- agent_end enabled 时：无新窗口/无显式 `MEMORY:` marker → audit skip 并推进 checkpoint；有显式 marker → 走 deterministic extractor + writer；无 marker + auto-write 诺动与 gates 放行 → 调度 bg LLM lane（fire-and-forget，见 A2/A3）

已完成 writer substrate：
- validate：runtime 检查 title/kind/status/confidence/compiledTruth
- sanitize：credential pattern 命中 fail-closed；`$HOME` 路径替换；IP/email redact
- deterministic dedupe：
  - **HARD signal**（无条件 reject）：slug 精确相等 OR 标题 word-trigram Jaccard ≥ 0.7
  - **SOFT signal G13**（`policy.disallowNearDuplicate` 控制）：char-trigram Jaccard ≥ 0.20 AND 共享 rare token (df ≤ 2，长度过滤后) AND 同 kind
    - 校准：vs 真实 .pensieve/ (177 entries) flag 率 2/15576，零误伤
    - LLM auto-write lane 默认开启 (`autoWriteDisallowNearDuplicate: true`)；explicit `MEMORY:` lane 默认关闭（用户亲手输入可记录改述）
    - 触发理由：今天首批 auto-writes 出现 `normalizebareslug` 同义双 entry（word-trigram = 0.000，char-trigram = 0.267，shared rare token `normalizebareslug`）
  - 命中 hard reject duplicate；命中 soft + 策略开 reject `near_duplicate`；都返回 `DedupeResult` 含 match metadata
- lint：写前调用 T1-T10 lint，error 阻断写入
- lock：`.pi-astack/sediment/locks/sediment.lock`，超时可配置
- write：tmp → rename 原子写入 markdown
- git：best-effort `git add` + `git commit`，失败不回滚 markdown
- audit：追加 `.pi-astack/sediment/audit.jsonl`（v2 schema：本地 TZ 时间戳 + audit_version + pid + project_root + settings_snapshot + entry_breakdown + parser_version + stage_ms；从 `.pensieve/.state/sediment-events.jsonl` 在首次 appendAudit 调用时自动迁移）

已完成 deterministic extractor stub：
- 仅识别显式 block，不从普通对话中猜测
- 格式：`MEMORY:` header + `---` + compiled truth body + `END_MEMORY`
- no marker → SKIP 并推进 checkpoint
- created / duplicate / validation/lint/credential terminal reject → 推进 checkpoint
- transient writer error → 不推进 checkpoint，留待下轮重试

已完成 LLM extractor dry-run：
- `/sediment llm --dry-run` 调用 `sediment.extractorModel`（默认 `deepseek/deepseek-v4-pro`）
- 输出仅解析 `MEMORY:` blocks / `SKIP`
- 不写 markdown，不推进 checkpoint
- 写入 audit：`.pi-astack/sediment/audit.jsonl` 的 `llm_dry_run` 事件
- quality gate：`skip` / `valid_candidates` pass；`model_error` / `unparseable_output` / `validation_errors` / `too_many_candidates` fail/warn
- raw output 只存 SHA-256 + 截断 preview（默认 1000 chars）
- `/sediment llm-report [--limit N]` 汇总最近 `llm_dry_run` 质量样本
- `/sediment readiness` 根据 `autoLlmWriteEnabled` / `minDryRunSamples` / `requiredDryRunPassRate` 评估未来自动 LLM 写入是否可放行（当前仍不自动写）
- **Readiness gate 样本已太期**（2026-05-08）：`scripts/seed-llm-dry-runs.mjs` 一次性脚本跨过 24 个样本（`deepseek-v4-pro` via sub2api）。结果：23/24 PASS（`pass rate 0.958` ≥ 0.9，samples 24 ≥ 20，`policyPassed: true`）。唯一 blocker为 `autoLlmWriteEnabled: false` 这个显式闸门。脚本是一次性 evidence-collection 工具，不是长期运行的 subsystem；类似 migration apply，不要扩展为 queue/dashboard。

已完成 migration apply 安全入口：
- `/sediment migrate-one --plan <file>`：只预览单文件迁移结果，不写入、不 audit、不重建 derived artifacts
- `/sediment migrate-one --apply --yes <file>`：只允许单文件迁移
- `/sediment migrate-one --restore <backup> --yes`：只允许从 `.pensieve/.state/migration-backups/` 恢复单文件；若 target 已被手改则拒绝 `target_modified`，不恢复 source、不删除 target
- `/sediment migration-backups [--limit N]`：只读列出最近 backup、restore command 与当前 state（restorable / target_modified / already_restored 等）
- source 必须位于 `.pensieve/` 内且不是 `.state/.index/pipelines`
- target 已存在则拒绝
- 迁移前 backup 到 `.pi-astack/sediment/migration-backups/<timestamp>/...`
- apply 成功返回可复制的 `restore_command: /sediment migrate-one --restore <backup> --yes`
- 生成 schema v1 markdown 后先 lint，error 则拒绝
- tmp → rename 原子写入；移动场景写 target 后删除 source；不删除空目录
- audit 到 `.pi-astack/sediment/audit.jsonl`
- 成功后自动重建 `.pensieve/.index/graph.json` 与 `.pensieve/_index.md`；derived rebuild 失败不会回滚已完成迁移/恢复，但会写入返回值/audit

已完成 LLM auto-write lane（A1 + A2 + A3，2026-05-08）：
- A1（安全前置 G2-G8）：`writeProjectEntry.opts.policy` + `forceProvisional`；`validateProjectEntryDraft(draft, policy)` overlay（`disallowMaxim` / `disallowArchived` / `maxConfidence`）；sanitizer 扩 4 pattern（JWT / PEM / AWS / connection URL）；`normalizeCompiledTruth` 对 `^---$` body 行退转；triggerPhrases 过 sanitizer；extractor prompt 加 Trust Boundary 指令。
- A2（接入 + G9-G12）：`agent_end` 在 `parseExplicitMemoryBlocks(window) === []` 之后调用 `tryAutoWriteLane`。闸门顺序：
  1. modelRegistry 存在 → `evaluateLlmAutoWriteReadiness(report, policy)` → `evaluateRollingGate(rollingReport, ...)` → `decideAutoWriteEligibility({sessionId, settings, readiness, rolling})`
  2. 全部放行后：`runLlmExtractorDryRun()` → `parseExplicitMemoryBlocks(rawText)` → `previewExtraction(drafts, policy)` → 过滤违反项 → `writeProjectEntry({...draft, policy, forceProvisional})`
  3. 写后重新 `evaluateRollingGate` 跳闸检查；跳闸后该 sessionId 本进程不再调 LLM（`autoWriteDisabledBySession` Map）。
- G9 audit：`operation: "auto_write"` 含 candidate_count / candidates / results / **raw_text 全文** (cap `autoWriteRawAuditChars` 默认 8000) / rolling / stage_ms.llm_total。如果 LLM 打一鱼三天这些都够复现。
- G10 rolling 闸门：`autoWriteRollingWindowSamples`/`autoWriteRollingPassRate` 两个 settings；跳闸是 **进程内** 状态，pi 重启重置（不改 settings.json，避免 “不可逆” 问题）。
- G11 独立模型：复用现有 `extractorModel` settings（默认 deepseek-v4-pro）；不强制隔离主会话模型，仅靠 settings 表达意图。
- G12 速率闸门：`autoWriteMaxPerHour` (默认 6) 滑动 1 小时窗口；`autoWriteSampleEveryNRuns` (默认 1) 确定性采样步进。两者进程内 Map，pi 重启重置。

已完成 LLM auto-write lane A3（实战 burn-in + 修复，2026-05-08）：
- 首日 6 次 fire 共 14 候选，落盘 12，被新 G13 + 手动 prune 后留存 7。
- **Slug bug fix**：`writer.ts` + `dedupe.ts` 把 `normalizeBareSlug(title)` 换成 `slugify(title)`，因前者把 `/` 当 path 分隔符（看到 “by extractor/reason Combinations” 把 slug 截成 `reason-combinations`）。`normalizeBareSlug` 仅用于 path/wikilink/id 输入。
- **Stale-ctx fix**：`agent_end` 在所有 await 之前同步快照 `cwd / branch / sessionId / notify / modelRegistry / signal`；late ctx invalidation 不再触发 “stale-ctx” 假警报。
- **Fire-and-forget UX**：pi awaits hook handlers synchronously；同步等 LLM (~30s+) 主会话被 “Working” 卡死。改方案：drafts=0 时 optimistic advance checkpoint → 调度 bg promise 入 `autoWriteInFlight` Map → agent_end 立即返回 (<100ms)；bg 内部 try/catch 兜底所有错误（unhandled Promise rejection 在 pi 会 crash session）。
- **Footer status FSM**（4 态：idle / running / completed / failed）：
  - `session_start` 永远 → idle
  - `agent_start` 当上轮终态 (completed/failed) → 重置 idle；当 running/idle 不动
  - `agent_end` 进入 running，bg 完成后 → completed（`N entries` / `LLM returned skip` / `ineligible`）或 failed（`LLM error` / `bg threw`）
  - 用户感知：`💪 sediment idle` / `📝 sediment running: auto-write (model=...)` / `✅ sediment completed: N entries` / `⚠️ sediment failed: <reason>`
- **Rolling gate de-tuning**：`extractorMaxCandidates` 3→5（prompt 已 cap 2，3-4 是 benign overshoot 不算 runaway）；`autoWriteRollingWindowSamples` 20→30（单行影响 5%→3.3%，跨"半天"smooth）。
- **G13 soft near-duplicate**：见 dedupe substrate 节；阻止 LLM 重复改述同一洞察（首日撞了 `normalizebareslug` 双 entry）。
- **Extractor model 临时切换**（settings.json）：`deepseek/deepseek-v4-pro` → `openai/gpt-5.4-mini`，因 deepseek API 当日 hang（flash 和 pro 都 30s+ 无输出）；hot-reload 即刻生效。deepseek 恢复后回切。

剩余待实现 pipeline：
- batch migration apply（当前只支持单文件；设计上不加）
- LLM extract 的 lookup tools 版本（ADR 0010 描述的内核）— 当前是 single-shot prompt + parser，未引入 lookup tools loop

**当前验收**：
```text
/sediment window --dry-run
# → 返回 checkpoint/run-window stats，不推进 checkpoint

/sediment extract --dry-run
# → 对当前 checkpoint window 解析显式 MEMORY blocks，但不写 markdown/不推进 checkpoint

/sediment llm --dry-run
# → 调用 LLM extractor，返回候选 preview；不写 markdown/不推进 checkpoint

/sediment llm-report --limit 20
# → 汇总 llm_dry_run pass/fail、reason 分布、候选数量和最近 preview/hash

/sediment readiness
# → 检查 dry-run 样本数/通过率/autoLlmWriteEnabled 是否满足 LLM auto-write lane 门禁

/sediment dedupe --title "Some Insight Title"
# → 返回 deterministic duplicate 检查结果

/sediment smoke --dry-run
# → 返回将写入的 slug/path/lint/dedupe 结果，但不写 markdown

/sediment migrate-one --plan .pensieve/short-term/maxims/example.md
# → 预览单个 legacy 文件将生成的 target/actions/lint/frontmatter/body preview，不写入

/sediment migrate-one --apply --yes .pensieve/short-term/maxims/example.md
# → 备份 source，迁移单个 legacy 文件到 schema v1/canonical path，并重建 graph/index derived artifacts

/sediment migration-backups --limit 20
# → 列出最近 backup、当前 state 与可复制 restore_command

/sediment migrate-one --restore .pensieve/.state/migration-backups/<timestamp>/short-term/maxims/example.md --yes
# → 从 backup 恢复原 source；若 target 与迁移生成内容一致则删除 target，并重建 graph/index
```

**待实现验收**：
- sediment 在 agent_end 后自动运行
- 新洞察写入 `.pensieve/knowledge/` 或 `.pensieve/staging/`
- 重复洞察被 SKIP_DUPLICATE
- audit log 记录完整 pipeline

---

## Phase 2：World 层接入

> ⚠️ **拓扑被 [ADR 0014](../adr/0014-abrain-as-personal-brain.md)（2026-05-09）重新规划**。`~/.abrain/` 从「跨项目 world knowledge 仓库」重定位为 alfadb 数字孪生 / Jarvis 大脑，采用七区结构（identity / skills / habits / workflows / projects / knowledge / vault）且吃掉 `.pensieve/`。下面 Phase 2.1 列出的 v7.0 旧 layout（`maxims/patterns/anti-patterns/...`）仅作历史参考。**新迁移计划走 [migration/abrain-pensieve-migration.md](./abrain-pensieve-migration.md) P1-P7**；七区拓扑详见 [brain-redesign-spec.md §1](../brain-redesign-spec.md)。Lane B/D 失效后 Phase 2.3 promotion gates 也被重新思考（详 [phase-2.3-promotion-gates.md](./phase-2.3-promotion-gates.md)）。读侧（resolve / search / get / list / neighbors）不受影响。

**验收标准**：
- [x] `~/.abrain/` 目录结构落地，独立 git repo【2026-05-08 完成；layout：`maxims/ decisions/ knowledge/ staging/ archive/ pipelines/ .state/ .index/`，独立 `.git/`，README.md + .gitignore，1 init commit；目前空，等 promotion gates 落地后通过 sediment 填充。**ADR 0014 后七区拓扑未启用，走 abrain-pensieve-migration.md 重新规划】
- [x] `ABRAIN_ROOT` 环境变量支持，默认 `~/.abrain`【`extensions/memory/parser.ts::resolveStores`】
- [x] Memory Facade 跨 store dispatch + graceful degradation【`resolveStores` 在 world 不存在时仅返回 project store，不报错；scope 是 internal routing concern，对 LLM 不暴露（§5.4 Facade）】
- [x] `memory_search` 同时检索 project + world【smoke 覆盖 `ABRAIN_ROOT` 路径】
- [x] **Parser frontmatter requirement**【`parseEntry` 在 `frontmatterText.trim() === ""` 时返回 null；通过 ~/.abrain/ 初始化时发现 README.md 被当 degraded entry 索引；2026-05-08 修复（`a49aed4`）】
- [ ] Sediment world lane（world 写入路径，决策树 logic）【依赖 Phase 1.4 burn-in 数周稳定后开】
- [ ] World scope 的 file lock【同上，sediment 写入路径依赖】
- [ ] Promotion gate 1-5 基础版（keyword-based）【同上】
- [ ] 跨机器同步脚本【运维脚本，路线漏洞，未设计】

**状态（2026-05-08）**：读侧（resolve / search / get / list / neighbors）全部落地，且被 smoke 覆盖。`~/.abrain/` 已初始化（独立 git repo，empty），`memory_search` / `memory_get` / `memory_list` / `memory_neighbors` 自动合并 project + world 层结果——但 scope 字段不返回给 LLM（per memory-architecture.md §5.4 Facade 模式：scope/backend 是 internal routing concern）。写侧（sediment world lane / promotion gate / sync）依然挡在 Phase 1.4 burn-in 之后，本 phase 不推进。

### Phase 2.1 — ~/.abrain 初始化

> **v7.0 旧命令仅作历史参考**。ADR 0014 下七区拓扑初始化走 [abrain-pensieve-migration.md](./abrain-pensieve-migration.md) P1（生成 layout + `.gitignore` whitelist vault 不上 git）。

```bash
# v7.0 旧 layout (仅参考)
mkdir -p ~/.abrain/{maxims,patterns,anti-patterns,facts,staging,archive,schemas,.state/locks}
cd ~/.abrain && git init
echo "ABRAIN_ROOT=~/.abrain" >> ~/.bashrc
```

```bash
# v7.1 七区拓扑 (ADR 0014 §D1)——该走 abrain-pensieve-migration.md P1
mkdir -p ~/.abrain/{identity,skills,habits,workflows,projects,knowledge,vault}
mkdir -p ~/.abrain/{staging,archive,.state}
cd ~/.abrain && git init
echo "ABRAIN_ROOT=~/.abrain" >> ~/.bashrc
```

### Phase 2.2 — Facade 跨 store

- 并发查询 ProjectStore + WorldStore
- project boost：scope=project 且属于当前 project → ×1.5
- 混合排序后截断 top-20
- WorldStore 不存在 → degraded 标注，不报错

### Phase 2.3 — Promotion gates 基础版

- Gate 1: 去上下文化检查（关键词替换）
- Gate 2: 跨实例验证（≥2 project 中出现）
- Gate 3: 反例检查（仅检查已有 contested 关系）
- Gate 4: 冷却期（≥3 天）
- Gate 5: 冲突检查（trigram Jaccard ≥0.7）

**状态（2026-05-08）**：详细设计稿落在 [`phase-2.3-promotion-gates.md`](./phase-2.3-promotion-gates.md)，含 5 gate 算法 / 命令 surface / 文件流 / frontmatter / audit schema / 锁 / 工作量 / 10 个开放问题 + 顺序建议。等 Phase 1.4 burn-in 数周稳定后 + Q1-Q10 用户拍板后实施。

---

## Phase 3：qmd 集成

**验收标准**：
- [ ] QmdBackend 接入 `memory_search` Facade
- [ ] BM25 关键词搜索 via CLI 直读 db
- [ ] 语义搜索 via daemon REST（需 daemon 补端点）
- [ ] Collection 配置 + fail-closed
- [ ] Graceful degradation：qmd 不可用 → 自动降级到 GrepBackend

详见 memory-architecture.md 附录 C。

---

## Phase 4：派生索引 + Health + 查询反哺

**验收标准**：
- [ ] qmd 语义搜索接入
- [ ] `memory doctor` 健康评分（5 指标，cron 每周）
- [ ] 查询反哺闭环：sediment 检测知识应用 → 追加 `[applied]` timeline 行
- [ ] Trigger phrases + passive nudge 机制
- [ ] Sediment-events.jsonl 可观测性面板

---

## Phase 5：治理

**验收标准**：
- [ ] 冲突检测 + contested 状态自动标记
- [ ] graph.json 引用热度参与 search ranking（citationBoost）
- [ ] 安全脱敏完整 pipeline
- [ ] Promotion gates 1-5 完善版（LLM judge）
- [ ] 审计 dashboard（sediment-events 可视化）

---

## Phase 6：Session 层（可选探索）

- [ ] Session scratchpad API（内存，零摩擦写入，会话结束蒸发）
- [ ] Cross-session 分析 pass

---

## 必补测试

### Smoke 回归入口

**实现状态（2026-05-08）**：新增 `scripts/smoke-memory-sediment.mjs`，package script：

```bash
npm run smoke:memory
```

覆盖 memory + sediment 的关键路径：tool/command 注册、frontmatter EOF parsing、lint、search、graph/index rebuild、migration dry-run report、doctor-lite、sanitize、writer、dedupe、checkpoint window、explicit extractor、LLM dry-run summary/report/readiness、world `ABRAIN_ROOT` generated paths。

### 安全测试
- memory_write/update/deprecate 工具仅 sediment 可见
- 主会话调 memory_write → 工具不存在
- credential pattern 命中 → 写入拒绝
- $HOME 路径被替换为 `$HOME/...`
- 脱敏规则误伤 → fail-closed

### 格式测试
- 10 条 Lint 规则全部通过 fixtures
- `## Timeline` 为最后一个 H2
- Timeline bullet 格式正确（`- YYYY-MM-DD | ...`）
- 无 code fence / table 在 Timeline 内

### 生命周期测试
- sediment file lock 获取/释放正常
- 并发写入不冲突
- markdown 原子写入（tmp → rename）
- git commit 失败不回滚 md（best-effort）
- graph.json 构建异常不阻塞写入

### Facade 测试
- project boost 正确（×1.5）
- confidence 因子正确（max(0.1, confidence/10)）
- WorldStore 不存在 → 降级不报错
- 两 store 结果混合排序正确
- LLM-facing schema 不含 scope/backend/source_path
