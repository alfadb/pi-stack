# 待澄清问题（v7）

基于 [memory-architecture.md](../memory-architecture.md) 重新评估。旧 v6.5 问题中大量 gbrain 相关问题已作废。

---

## ✅ 已拍板（memory-architecture.md）

- **存储架构**: 纯 markdown+git（决策 2）。项目级 = `<project>/.pensieve/`，世界级 = `~/.abrain/`（独立 git repo，决策 3）
- **条目格式**: frontmatter v1 + compiled truth + `## Timeline`（§4.4）
- **知识模型**: 7 种 kind + confidence 0-10 + lifetime 正交（§4）
- **读写分离**: sediment 单写，主会话只读（§8）
- **读工具**: `memory_search/get/list/neighbors`（§6.1）
- **写入 substrate**: 不暴露 LLM-facing 写工具；sediment 内部调用 writer substrate（create/update/merge/archive/supersede/delete/skip，§6.2 + ADR 0016）
- **Facade 模式**: LLM 只看到统一读接口，scope/backend 仅内部可见（§5.4）
- **Sediment pipeline**: extract → sanitize → classify → dedupe → lint → lock → write md → git commit → audit（§8.2）
- **实施路线**: 6 个 Phase（§11）
- **主会话角色**: 只读，不写记忆（§8.1）
- **Multi-agent 定位**: 基础能力（ADR 0009），sediment 不再借用

---

## P0 — 需立即澄清

### Q0. sediment agent prompt 具体写法

memory-architecture.md §8.2 定义了 sediment pipeline 框架，但 single agent 的 prompt 具体内容（如何判断 kind/confidence、何时 SKIP/SKIP_DUPLICATE/write、如何格式化 compiled truth）需要落地。

**依赖**: memory-architecture.md §4（kind 定义、confidence 规则）、§4.3.1（kind→目录映射）、§8.2（写入决策树）。

**建议**: 参考 ADR 0010 的 markdown 终结符协议（SKIP / SKIP_DUPLICATE / ## MEMORY mode=new|update），适配为 new frontmatter + compiled truth + `## Timeline` 格式。

### Q1. 旧 `.pensieve/` 数据迁移策略

`~/.pi/.pensieve/` 现有 6 maxim + 23 decision + ~30 knowledge + 62 short-term。需要迁移到新格式（frontmatter v1 + `## Timeline`）。

**问题**:
- 旧条目不区分 kind（只有 maxim/decision/knowledge/short-term 4 象限）
- 旧条目无 confidence / lifetime / trigger_phrases
- 62 条 short-term 是否全部保留？

**建议**: `pi memory migrate` 自动映射 + confidence 默认值 + 生成初始 timeline。short-term 先 triage。

### Q2. `~/.abrain/` 初始化内容

世界级知识库从零开始，还是从 gbrain default 145 页中提取有价值的跨项目准则？

**建议**: 从零开始。等 sediment world lane（Phase 2）自然积累。旧 gbrain 数据保留为历史档案，不自动迁移。

---

## P1 — 影响实施细节

### Q3. graph.json 增量更新策略

memory-architecture.md §5.6 说"sediment 写入单条目后仅更新该条目 node + 出入边"。增量更新的具体实现：
- 如何识别 frontmatter 中的 relation 变更？
- 如何处理 body wikilink 的增删？
- 增量更新异常时是全量重建还是标记 stale？

**建议**: Phase 1 先全量重建（简单可靠），Phase 4 升级为增量。

### Q4. `_index.md` 格式细节

memory-architecture.md §10.5 定义了 `_index.md` 格式模板。具体实现问题：
- 是否 git tracked？（建议 gitignored，sediment 每次写入后自动重建）
- Orphans 列表的筛选条件？

**建议**: gitignored。Orphans = 零入边的 staging/ 条目。

### Q5. File lock 实现

memory-architecture.md §8.2 提到 file lock。具体实现：
- 用什么 lock 机制？（建议 `proper-lockfile` 或 `fs.writeFileSync(lockPath, pid)` + 轮询）
- Lock 超时后行为？

**建议**: pid-file 方式，超时 5s 后进 pending queue。

---

## P2 — 远期问题

### Q6. 跨设备 ~/.abrain 同步

~/.abrain 是独立 git repo。跨设备同步策略：
- (a) alfadb 手动 push/pull
- (b) session 启动/结束自动 pull/push

**建议**: Phase 2 先用 (b)：session 启动 pull --rebase，结束 push。冲突不自动解决。

### Q7. qmd daemon REST 端点

memory-architecture.md 附录 C.2 提到 daemon 需要补 `POST /search` 和 `POST /query` 端点。谁来做？

**建议**: Phase 3 时评估。如果 daemon 未补端点，先用 CLI `qmd vsearch`（忍受 2-3s 冷启动）。

### Q8. Sediment 写入纪律长期保证

memory-architecture.md §8.2 要求 sediment 按确定性规则 classify（kind→目录映射）。需要定期抽查：
- kind 分布是否合理
- confidence 初始化是否准确
- staging/ 滞留时长

**建议**: `memory doctor`（Phase 4）自动报告。Phase 1-2 期间 alfadb 手动抽查。

---

## 推荐处理顺序

1. **Phase 1 起步**: Q0（sediment prompt）+ Q1（旧数据迁移）+ Q5（file lock）
2. **Phase 2 起步**: Q2（~/.abrain 初始化）+ Q6（跨设备同步）
3. **Phase 3 起步**: Q7（qmd REST 端点）
4. **Phase 4**: Q3（graph 增量更新）+ Q4（_index.md）+ Q8（写入纪律）
