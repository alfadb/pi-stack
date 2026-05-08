# pi-astack 迁移路径（Phase 路线图）

> 基于 [memory-architecture.md](../memory-architecture.md) §11 实施路线图。
> 替代旧 7 Slice (A→G) 方案（基于 gbrain，已于 2026-05-07 作废）。

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
- [ ] Markdown 条目格式标准化（frontmatter schema v1 + compiled truth + `## Timeline`）
- [x] 10 条 Lint 规则实现（T1-T10；`/memory lint [path]` slash command，CLI wrapper 未实现）
- [ ] 旧格式迁移工具：已实现 `/memory migrate --dry-run [path]` 计划生成；实际写入迁移仍待 sediment/migration writer
- [x] `memory_search` grep-based 实现（rg 文件发现 + per-file tf-idf + title/slug boost；project 层 + 可选 world 只读）
- [x] `memory_get` / `memory_list` 实现（另含 `memory_neighbors` 只读遍历）
- [ ] `_index.md` 自动生成（sediment 写入后重建）
- [x] graph 派生索引：已实现 `buildGraphSnapshot` + `/memory check-backlinks [path]` + `/memory rebuild --graph [path]` 写入 gitignored derived index
- [ ] Sediment project-only pipeline：writer substrate 已实现（validate → sanitize → deterministic dedupe → lint → lock → atomic write md → git best-effort → audit）；extract/classify/agent_end 自动写仍待实现
- [x] Project scope 的 file lock + 错误恢复（writer substrate）
- [x] 最小脱敏：credential pattern → 写入拒绝（fail-closed）；$HOME 路径替换

**不包含**：World 层、向量搜索、promotion gates、passive nudge、语义 dedupe

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

**实现状态（2026-05-08）**：`extensions/memory/migrate.ts` 已实现 `/memory migrate --dry-run [path]` 的计划生成逻辑，`extensions/memory/index.ts` 注册命令入口；只生成迁移计划，不写文件。实际写入迁移仍需后续 sediment/migration writer 承接，以保持主会话只读边界。

- 识别旧格式条目：无 `schema_version` 或无 `---` 分隔符
- 自动映射：旧 `short-term/` → 条目移入同级目录 + `lifetime.kind: ttl`
- 缺失 timeline：迁移时生成初始 timeline 行
- 迁移前自动 git commit 当前状态（可回滚）
- 支持 `--dry-run`

**当前验收**：
```text
/memory migrate --dry-run .pensieve
# → 显示迁移计划，不修改文件
```

**待实现验收**：
```text
# 由 sediment/migration writer 执行，非当前 read-only extension
/memory migrate --apply .pensieve
# → 完成迁移，report 输出到 .state/migration-report.md
```

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

**实现状态（2026-05-08）**：`extensions/sediment/writer.ts` 已实现 project-only writer substrate；`extensions/sediment/checkpoint.ts` 已实现 checkpoint + run window builder；`extensions/sediment/extractor.ts` 已实现 deterministic explicit `MEMORY:` block extractor；`extensions/sediment/index.ts` 注册 `/sediment status`、`/sediment window --dry-run`、`/sediment extract --dry-run`、`/sediment dedupe --title` 与 `/sediment smoke --dry-run`。`agent_end` hook 默认 disabled；启用后仅处理显式 `MEMORY:` block，成功/terminal skip 后推进 checkpoint。

已完成 checkpoint/window substrate：
- checkpoint path：`.pensieve/.state/sediment-checkpoint.json`
- `buildRunWindow(branch, checkpoint)`：从 `ctx.sessionManager.getBranch()` 取 checkpoint 之后的新 entries
- compaction/branch fallback：checkpoint entry 找不到时只取最新 entry，避免重放全历史
- window budget：`minWindowChars` / `maxWindowChars` / `maxWindowEntries`
- agent_end enabled 时 audit window stats，但 extractor 未实现所以不推进 checkpoint

已完成 writer substrate：
- validate：runtime 检查 title/kind/status/confidence/compiledTruth
- sanitize：credential pattern 命中 fail-closed；`$HOME` 路径替换；IP/email redact
- deterministic dedupe：slug 精确相等 + 标题 trigram Jaccard ≥ 0.7，命中则 reject duplicate
- lint：写前调用 T1-T10 lint，error 阻断写入
- lock：`.pensieve/.state/locks/sediment.lock`，超时可配置
- write：tmp → rename 原子写入 markdown
- git：best-effort `git add` + `git commit`，失败不回滚 markdown
- audit：追加 `.pensieve/.state/sediment-events.jsonl`

已完成 deterministic extractor stub：
- 仅识别显式 block，不从普通对话中猜测
- 格式：`MEMORY:` header + `---` + compiled truth body + `END_MEMORY`
- no marker → SKIP 并推进 checkpoint
- created / duplicate / validation/lint/credential terminal reject → 推进 checkpoint
- transient writer error → 不推进 checkpoint，留待下轮重试

待实现完整 pipeline：
- LLM extract + classify（单 agent + lookup tools，继承 ADR 0010 内核）
- 自动从普通对话候选中写入 project 条目

**当前验收**：
```text
/sediment window --dry-run
# → 返回 checkpoint/run-window stats，不推进 checkpoint

/sediment extract --dry-run
# → 对当前 checkpoint window 解析显式 MEMORY blocks，但不写 markdown/不推进 checkpoint

/sediment dedupe --title "Some Insight Title"
# → 返回 deterministic duplicate 检查结果

/sediment smoke --dry-run
# → 返回将写入的 slug/path/lint/dedupe 结果，但不写 markdown
```

**待实现验收**：
- sediment 在 agent_end 后自动运行
- 新洞察写入 `.pensieve/knowledge/` 或 `.pensieve/staging/`
- 重复洞察被 SKIP_DUPLICATE
- audit log 记录完整 pipeline

---

## Phase 2：World 层接入

**验收标准**：
- [ ] `~/.abrain/` 目录结构落地，独立 git repo
- [ ] `ABRAIN_ROOT` 环境变量支持，默认 `~/.abrain`
- [ ] Memory Facade 跨 store dispatch + graceful degradation
- [ ] `memory_search` 同时检索 project + world
- [ ] Sediment world lane（world 写入路径，决策树 logic）
- [ ] World scope 的 file lock
- [ ] Promotion gate 1-5 基础版（keyword-based）
- [ ] 跨机器同步脚本

### Phase 2.1 — ~/.abrain 初始化

```bash
mkdir -p ~/.abrain/{maxims,patterns,anti-patterns,facts,staging,archive,schemas,.state/locks}
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
