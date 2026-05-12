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
- [x] 旧格式迁移工具：`/memory migrate --dry-run [path]` 全库 read-only 计划生成 + `/memory migrate --go` per-repo 一次性迁移（2026-05-12 B4 ship：preflight 检查 → frontmatter 归一化 → pipeline routing → 两仓各一个 commit）。per-file apply substrate（`/sediment migrate-one` + `/sediment migration-backups` + restore）于 2026-05-12 随 Phase 1 迁移完成后剥离
- [x] `memory_search` grep-based 实现（Phase 1 baseline；已由 ADR 0015 LLM retrieval 替代为 runtime 路径；grep/tf-idf 保留作 legacy diagnostics）
- [x] `memory_get` / `memory_list` 实现（另含 `memory_neighbors` 只读遍历）
- [x] `_index.md` 自动生成（已实现 `/memory rebuild --index [path]`）
- [x] graph 派生索引：已实现 `buildGraphSnapshot` + `/memory check-backlinks [path]` + `/memory rebuild --graph [path]`
- [x] Sediment project-only pipeline：writer substrate 已实现（validate → sanitize → deterministic dedupe → lint → lock → atomic write md → git best-effort → audit）；explicit `MEMORY:` lane 与 agent_end LLM auto-write curator lane 均已实现
- [x] Project scope 的 file lock + 错误恢复（writer substrate）
- [x] 最小脱敏：credential pattern → 写入拒绝（fail-closed）；$HOME 路径替换

**不包含**：World 层物理迁移、向量搜索、promotion gates、passive nudge；ADR 0016 已明确不做 semantic-dedupe hard gate，语义判断交给 curator

### Phase 1.0 — doctor-lite aggregate status

**实现状态（2026-05-08；2026-05-11 同步）**：`extensions/memory/doctor.ts` 已实现 `/memory doctor-lite [path]`，聚合 Phase 1 关键状态，便于判断 legacy migration / graph / lint / sediment auto-write audit 是否就绪。

汇总范围：
- lint error/warning
- graph/backlink dead links / symmetric backlink
- generated `_index.md` 是否可构建
- migration pending count
- migration backup count / state（`restorable_remove_target`、`target_modified`、`already_restored` 等）
- sediment auto-write audit / curator decision counts

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

**状态**：✅ 完成（2026-05-08）。详细里程数据见 [apply-checklist.md](./apply-checklist.md)（~/.pi 父仓 173 → 0 pending，14 batch，lint errors 547 → 0）。

**当前还在维护的**：`/memory migrate --dry-run [--report] [path]`—— read-only 计划生成，仅列出哪些 legacy entry 仍在、不写 markdown。适用场景：Phase 1 迁移后可能仍有调试仓产生的 legacy entry，或未来 schema bump 时快速扫仓。

**已剥离**（2026-05-12）：per-file apply substrate（`extensions/sediment/migration.ts`、`/sediment migrate-one --plan/--apply --yes/--restore`、`/sediment migration-backups`、backup 子系统）随 Phase 1 迁移完成后剥离。设计动机：per-file workflow 是 Phase 1 为 173 条 legacy entry 定制的临时机械，迁移完成后它就不再服务于任何路径，反而产生两个负担：（1）作为 slash command 出现在提示里，误导 LLM 去调用不需要的备份逻辑；（2）backup 子系统与 git 重复。后续使用场景（例如 ADR 0014 .pensieve → abrain 迁移）全部走 per-repo、不走 per-file。

**per-repo 迁移（2026-05-12 B4 + B4.5 ✅ shipped）**：`/memory migrate --go`——`extensions/memory/migrate-go.ts`，git working tree clean 作为 precondition，不做 backup，不留 symlink。正确流程是先 `/abrain bind --project=<id>`，再 `/memory migrate --dry-run` / `--go`；迁移命令不再接受 `--project`，也不再用 git remote / cwd 推断 project id。**Rollback 用 preflight 阶段捕获的 `parentPreSha` / `abrainPreSha`**（summary 末尾直接打印 `git reset --hard <sha>` 命令）——不要用 `HEAD~1`，因为 abrain 一侧有 N workflow commit + 1 migrate-in commit = N+1，且 sediment 可能在迁移期间并发 commit。详 [abrain-pensieve-migration.md §5](./abrain-pensieve-migration.md#5-回滚)。9 项 preflight（B4.5 后用户可见项：strict binding bound / 父仓 git clean / `.pensieve` tracked / 有用户 entry / abrain 仓 git clean；+ 4 项隐藏 sanity guard：pensieveTarget 路径存在 / abrainHome 路径存在 / 父仓 root 存在 / abrainHome 是 git repo；详 [abrain-pensieve-migration.md §2](./abrain-pensieve-migration.md#2-precondition)）。Pipeline 路由走 `writeAbrainWorkflow`，其余 7 kind atomic write 到 `~/.abrain/projects/<id>/<kind-dir>/`。14 仓手动逐个触发，优先级表见 [abrain-pensieve-migration.md §4](./abrain-pensieve-migration.md#4-14-仓迁移建议顺序)。

### Phase 1.3 — memory_search（ADR 0015 LLM-driven；无 grep 降级）

**实现状态（2026-05-08 grep baseline；2026-05-10 ADR 0015 Phase 0/1；2026-05-10 fallback removal）**：`extensions/memory/search.ts` + `parser.ts` 保留 legacy grep+tf-idf implementation 供 diagnostics/tests 与 list/get/neighbors 共享逻辑；`extensions/memory/llm-search.ts` 实现双阶段 LLM retrieval；`extensions/memory/index.ts` 注册 `memory_search` / `memory_get` / `memory_list` / `memory_neighbors` 四个只读工具，且 `memory_search` runtime 只走 LLM 路径，失败 hard error。详见 [ADR 0015](../adr/0015-memory-search-llm-driven-retrieval.md) + [memory-search-llm-upgrade.md](./memory-search-llm-upgrade.md)。

- runtime：stage1 从内存生成的 enhanced index 选 top-K 候选；stage2 读取候选完整 compiled_truth + timeline 精排
- no fallback：LLM/model/auth/network/JSON 失败直接返回 error，不用 grep 结果替代
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

**实现状态（2026-05-08 baseline；2026-05-10 enhanced for ADR 0015）**：`extensions/memory/index-file.ts` 已实现 generated `_index.md` builder，`extensions/memory/index.ts` 注册 human-facing slash command `/memory rebuild --index [path]`。ADR 0015 Phase 0 增强每条 entry 输出 kind/status/confidence/updated/trigger/summary，供 LLM 浏览；runtime search 为避免物理 `_index.md` 过期，直接从 parsed entries 内存生成同形态 index。

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

**实现状态（2026-05-10）**：`extensions/sediment/writer.ts` 已实现 project-only create/update/merge/archive/supersede/delete substrate；`extensions/sediment/checkpoint.ts` 已实现 per-session checkpoint + RMW 锁 + run window builder；`extensions/sediment/extractor.ts` 已实现 fence-aware deterministic explicit `MEMORY:` block extractor；`extensions/sediment/llm-extractor.ts` 已实现 prompt (含 Trust Boundary role-aware 指令) + model call + parser；`extensions/sediment/curator.ts` 已接入 ADR 0015 `memory_search` lookup loop；`extensions/sediment/index.ts` 注册 `/sediment` 子命令 + `agent_end` hook。底层走 deterministic explicit `MEMORY:` lane；**LLM auto-write lane 已接入 hook并按 ADR 0016 删除 readiness/rolling/rate/sampling/G2-G13 机械门控**：显式 miss 后直接调用 LLM extractor + curator，git/audit 作为回滚面。

已完成 checkpoint/window substrate：
- checkpoint path：`.pi-astack/sediment/checkpoint.json`
- `buildRunWindow(branch, checkpoint)`：从 `ctx.sessionManager.getBranch()` 取 checkpoint 之后的新 entries
- compaction/branch fallback：checkpoint entry 找不到时只取最新 entry，避免重放全历史
- window budget：`minWindowChars` / `maxWindowChars` / `maxWindowEntries`
- agent_end enabled 时：不要求 `.pensieve/` 预先存在；写入时 writer 会按需创建项目 `.pensieve/`。无新窗口/窗口太小 → audit skip（有 last entry 时推进 checkpoint）；有显式 `MEMORY:` marker → 走 deterministic extractor + writer；无 marker 且无在飞后台任务 → 乐观推进 checkpoint 后调度 bg LLM lane（fire-and-forget，见 A2/A3）；若同 session 上一轮 bg sediment 仍在飞 → 静默返回，不写 audit、不推进 checkpoint，下次触发从上一轮 sediment 已推进的 checkpoint 继续。

已完成 writer substrate：
- validate：runtime 检查 title/kind/status/confidence/compiledTruth
- sanitize：credential pattern 命中 fail-closed；`$HOME` 路径替换；IP/email redact
- storage-only dedupe：仅 slug 精确相等无条件 reject，防止同一路径覆盖。旧 word-trigram / G13 rare-token 机械语义 dedupe 已按 ADR 0016 删除；语义重复交给 `memory_search` + curator 决定 update/skip/merge/create。
- lint：写前调用 T1-T10 lint，error 阻断写入
- lock：`.pi-astack/sediment/locks/sediment.lock`，超时可配置
- write：缺失 `.pensieve/` 时按需创建；tmp → rename 原子写入 markdown
- git：best-effort `git add` + `git commit`，失败不回滚 markdown
- audit：追加 `.pi-astack/sediment/audit.jsonl`（v2 schema：本地 TZ 时间戳 + audit_version + pid + project_root；agent_end 汇总行额外带 lane + session_id + correlation_id + settings_snapshot + entry_breakdown + parser_version + stage_ms + candidates/results/curator/llm；writer-level create/update/merge/archive/supersede/delete/reject rows 带 lane + session_id + correlation_id + candidate_id，可追踪到对应 summary candidate/result；从 `.pensieve/.state/sediment-events.jsonl` 在首次 appendAudit 调用时自动迁移）。auto-write / explicit write 不暴露 human dry-run 命令，故障诊断由 LLM 读取 audit + git history 完成。

已完成 deterministic extractor stub：
- 仅识别显式 block，不从普通对话中猜测
- 格式：`MEMORY:` header + `---` + compiled truth body + `END_MEMORY`
- no marker → 显式 lane miss；若 auto-write 开启则进入 LLM curator lane，若 auto-write 不可用则 skip 并推进 checkpoint
- created / duplicate / validation/lint/credential terminal reject → 推进 checkpoint
- 新写入的 `created` / `updated` / timeline 首行使用本地 ISO datetime（精确到毫秒 + 时区），避免一天几十条 entry 时 date-only 无法排序
- transient writer error → 不推进 checkpoint，留待下轮重试

已删除 LLM extractor dry-run/readiness 链：
- **ADR 0016 更新（2026-05-10）**：`/sediment llm --dry-run`、`/sediment llm-report`、`/sediment readiness`、`scripts/seed-llm-dry-runs.mjs` 与 `llm_dry_run` readiness gate 已删除。auto-write 不再需要 dry-run 样本；git + audit 是回滚面。

原 migration apply 安全入口（`/sediment migrate-one --plan/--apply --yes/--restore` + `/sediment migration-backups`）随 Phase 1 迁移完成于 2026-05-12 剥离。详见 Phase 1.2 中「已剥离」说明。per-repo 迁移走 `/memory migrate --go`（2026-05-12 B4 ✅ shipped），在 `extensions/memory/migrate-go.ts`，不继承 per-file substrate 任何代码

已完成 LLM auto-write lane（A1 + A2 + A3，2026-05-08）：
- A1（历史实现）：早期曾用 `writeProjectEntry.opts.policy`、`forceProvisional`、`disallowMaxim`、`maxConfidence`、G13 near-duplicate 等机械 gates 保护 LLM auto-write。
  - **ADR 0016 更新（2026-05-10）**：G2-G13 / readiness / rolling / rate / sampling 机械门控已删除；不再强制 provisional、不禁 maxim、不 cap confidence、不用 G13 hard reject 代替语义判断。hard gate 收敛为敏感信息 + 存储完整性。
  - 当前实现新增 `updateProjectEntry(slug, patch, ...)` / `mergeProjectEntries()` / `archiveProjectEntry()` / `supersedeProjectEntry()` / `deleteProjectEntry()` writer substrate；`extensions/sediment/curator.ts` 已接入 `memory_search` lookup loop，当前支持 create/update/merge/archive/supersede/delete/skip，避免 append-only 新增。
- A2（接入 + G9-G12）：`agent_end` 在 `parseExplicitMemoryBlocks(window) === []` 之后调用 `tryAutoWriteLane`。闸门顺序：
  1. modelRegistry 存在 + `autoLlmWriteEnabled=true`
  2. `runLlmExtractor()` → `parseExplicitMemoryBlocks(rawText)` → `previewExtraction(drafts)` schema-only 过滤
  3. `curateProjectDraft()` 调 `memory_search` 找近邻 → curator LLM 输出 create/update/merge/archive/supersede/delete/skip
  4. `writeProjectEntry()` / `updateProjectEntry()` / `mergeProjectEntries()` / `archiveProjectEntry()` / `supersedeProjectEntry()` / `deleteProjectEntry()` 写盘；git/audit 负责回滚与追踪。
- audit：`operation: "auto_write"` 含 correlation_id / candidate_count / candidates(candidate_id) / results(candidate_id) / curator decisions / **raw_text 全文** (cap `autoWriteRawAuditChars` 默认 8000) / stage_ms.llm_total；writer-level rows 复用同一 correlation_id + candidate_id。如果 LLM 打一鱼三天这些都够复现。
- 独立模型：复用现有 `extractorModel` settings（默认 deepseek-v4-pro）；不强制隔离主会话模型，仅靠 settings 表达意图。

已完成 LLM auto-write lane A3（实战 burn-in + 修复，2026-05-08）：
- 首日 6 次 fire 共 14 候选，落盘 12，被新 G13 + 手动 prune 后留存 7。
- **Slug bug fix**：`writer.ts` + `dedupe.ts` 把 `normalizeBareSlug(title)` 换成 `slugify(title)`，因前者把 `/` 当 path 分隔符（看到 “by extractor/reason Combinations” 把 slug 截成 `reason-combinations`）。`normalizeBareSlug` 仅用于 path/wikilink/id 输入。
- **Stale-ctx fix**：`agent_end` 在所有 await 之前同步快照 `cwd / branch / sessionId / notify / modelRegistry / signal`；late ctx invalidation 不再触发 “stale-ctx” 假警报。
- **Fire-and-forget UX**：pi awaits hook handlers synchronously；同步等 LLM (~30s+) 主会话被 “Working” 卡死。改方案：drafts=0 且没有同 session 在飞 bg worker 时 optimistic advance checkpoint → 调度 bg promise 入 `autoWriteInFlight` Map → agent_end 立即返回 (<100ms)；bg 内部 try/catch 兜底所有错误（unhandled Promise rejection 在 pi 会 crash session）。若上一轮 bg worker 仍在飞，新 agent_end 静默返回，不推进 checkpoint、不写 audit；worker drain 后下一次 agent_end 从上一轮已推进 checkpoint 继续处理期间累积内容。
- **Footer status FSM**（4 态：idle / running / completed / failed）：
  - `session_start` 永远 → idle
  - `agent_start` 当上轮终态 (completed/failed) → 重置 idle；当 running/idle 不动
  - `agent_end` 进入 running，bg 完成后 → completed（`N entries` / `LLM returned skip` / `ineligible`）或 failed（`LLM error` / `bg threw`）
  - 用户感知：`💪 sediment idle` / `📝 sediment running: auto-write (model=...)` / `✅ sediment completed: N entries` / `⚠️ sediment failed: <reason>`
- **历史注记**：Rolling/G13 曾在 burn-in 期存在，ADR 0016 后已删除；重复改述由 curator update/archive/supersede/delete/skip/merge 处理。
- **Extractor model 临时切换**（settings.json）：`deepseek/deepseek-v4-pro` → `openai/gpt-5.4-mini`，因 deepseek API 当日 hang（flash 和 pro 都 30s+ 无输出）；hot-reload 即刻生效。deepseek 恢复后回切。

剩余待实现 pipeline：
- batch migration apply（当前只支持单文件；设计上不加）
- LLM extract 的 lookup tools 版本（ADR 0010 描述的内核）— 当前是 single-shot prompt + parser，未引入 lookup tools loop

**当前验收**：
```text
# auto-write / explicit write 的诊断不再暴露 human dry-run 命令；
# 出问题后由 LLM 读取 .pi-astack/sediment/audit.jsonl + git history 诊断。

/sediment dedupe --title "Some Insight Title"
# → 返回 deterministic duplicate 检查结果

# /sediment migrate-one / /sediment migration-backups 于 2026-05-12 剥离。
# per-repo 迁移走 `/memory migrate --go`（2026-05-12 B4 ✅ shipped，详 abrain-pensieve-migration.md §3）。
```

**当前 live 验收**：
- sediment 在 agent_end 后自动运行
- 新洞察 create 到 `.pensieve/knowledge/` 或 `.pensieve/staging/`
- 重复/旧洞察由 curator 输出 update/merge/archive/supersede/delete/skip（当前实现 create/update/merge/archive/supersede/delete/skip）
- audit log 记录完整 pipeline + curator decisions

---

## Phase 2：World 层接入

> ⚠️ **拓扑被 [ADR 0014](../adr/0014-abrain-as-personal-brain.md)（2026-05-09）重新规划**。`~/.abrain/` 从「跨项目 world knowledge 仓库」重定位为 alfadb 数字孪生 / Jarvis 大脑，采用七区结构（identity / skills / habits / workflows / projects / knowledge / vault）且吃掉 `.pensieve/`。下面 Phase 2.1 列出的 v7.0 旧 layout（`maxims/patterns/anti-patterns/...`）仅作历史参考。**新迁移计划走 [migration/abrain-pensieve-migration.md](./abrain-pensieve-migration.md) §1-§7**；七区拓扑详见 [brain-redesign-spec.md §1](../brain-redesign-spec.md)。Lane B/D 失效后 Phase 2.3 promotion gates 也被重新思考（详 [phase-2.3-promotion-gates.md](./phase-2.3-promotion-gates.md)）。读侧（resolve / search / get / list / neighbors）不受影响。

**验收标准**：
- [x] `~/.abrain/` 目录结构落地，独立 git repo【2026-05-08 完成；layout：`maxims/ decisions/ knowledge/ staging/ archive/ pipelines/ .state/ .index/`，独立 `.git/`，README.md + .gitignore，1 init commit；目前空，等 promotion gates 落地后通过 sediment 填充。**ADR 0014 后七区拓扑未启用，走 abrain-pensieve-migration.md 重新规划】
- [x] `ABRAIN_ROOT` 环境变量支持，默认 `~/.abrain`【`extensions/memory/parser.ts::resolveStores`】
- [x] Memory Facade 跨 store dispatch + graceful degradation【`resolveStores` 在 world 不存在时仅返回 project store，不报错；scope 是 internal routing concern，对 LLM 不暴露（§5.4 Facade）】
- [x] `memory_search` 同时检索 project + world【smoke 覆盖 `ABRAIN_ROOT` 路径】
- [x] **Parser frontmatter requirement**【`parseEntry` 在 `frontmatterText.trim() === ""` 时返回 null；通过 ~/.abrain/ 初始化时发现 README.md 被当 degraded entry 索引；2026-05-08 修复（`a49aed4`）】
- [ ] Sediment world lane（world 写入路径，决策树 logic）【ADR 0016 后不再依赖 burn-in；待 world write substrate 设计】
- [ ] World scope 的 file lock【同上，sediment 写入路径依赖】
- [ ] Promotion gate 1-5 基础版（keyword-based）【待 Phase 1.4+ 路线规划】
- [ ] 跨机器同步脚本【运维脚本，路线漏洞，未设计】

**状态（2026-05-11）**：读侧全部落地且被 smoke 覆盖。写侧（sediment world lane / promotion gate / sync）待 world write substrate 设计，不再依赖 burn-in（ADR 0016 已删除机械门控）。

### Phase 2.1 — ~/.abrain 初始化

> **v7.0 旧命令仅作历史参考**。ADR 0014 下七区拓扑初始化走 [abrain-pensieve-migration.md](./abrain-pensieve-migration.md) P1（生成 layout + `.gitignore` whitelist vault 不上 git）。

```bash
# v7.0 旧 layout (仅参考)
mkdir -p ~/.abrain/{maxims,patterns,anti-patterns,facts,staging,archive,schemas,.state/locks}
cd ~/.abrain && git init
echo "ABRAIN_ROOT=~/.abrain" >> ~/.bashrc
```

```bash
# v7.1 七区拓扑 (ADR 0014 §D1)——该走 abrain-pensieve-migration.md §1 模型 + §3 迁移动作
mkdir -p ~/.abrain/{identity,skills,habits,workflows,projects,knowledge,vault}
mkdir -p ~/.abrain/{staging,archive,.state}
cd ~/.abrain && git init
echo "ABRAIN_ROOT=~/.abrain" >> ~/.bashrc
```

### Phase 2.2 — Facade 跨 store

- 并发查询 ProjectStore + WorldStore
- project boost：scope=project 且属于当前 project → ×1.5
- 混合排序后截断 top-20
- WorldStore 不存在 → 空结果并继续；ADR 0015 `memory_search` result card 不暴露 degraded 字段，LLM/model/auth/network/JSON 失败 hard error

### ~~Phase 2.3 — Promotion gates 基础版~~ （已取消）

> ⚠️ **已被 [ADR 0014](../adr/0014-abrain-as-personal-brain.md) §D3（2026-05-09）取消**。abrain 七区拓扑下不再有 "project → world promotion" 概念——sediment writer 直接将条目路由到七区（identity / skills / habits / workflows / projects / knowledge / vault）中一个，kind 决定子目录。Promotion gates 1-5 不在路线图上；原设计动机记录仅作历史保留于 [`phase-2.3-promotion-gates.md`](./phase-2.3-promotion-gates.md)（顶部已标 SUPERSEDED）。Lane B/D 同期在 [ADR 0013](../adr/0013-asymmetric-trust-three-lanes.md) 中失效。

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

覆盖 memory + sediment 的关键路径：tool/command 注册、frontmatter EOF parsing、lint、search、graph/index rebuild、migration dry-run report、doctor-lite、sanitize、writer create/update、storage-only dedupe、checkpoint window、explicit extractor、LLM extractor summary、world `ABRAIN_ROOT` generated paths。

### 安全测试
- 主会话只注册 `memory_search/get/list/neighbors` 读工具；不注册 LLM-facing `memory_write/update/deprecate/promote/relate`
- sediment 写入能力仅作为 sidecar 内部 writer substrate 暴露（`writeProjectEntry` / update / merge / archive / supersede / delete）
- credential pattern 命中 → 写入拒绝
- $HOME 路径被替换为 `$HOME/...`
- 脱敏规则误伤 → fail-closed

### 格式测试
- 10 条 Lint 规则全部通过 fixtures
- `## Timeline` 为最后一个 H2
- Timeline bullet 格式正确（旧 `- YYYY-MM-DD | ...` 兼容；新 sediment 写入用 ISO datetime）
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
