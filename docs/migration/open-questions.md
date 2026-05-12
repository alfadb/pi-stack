# 待澄清问题（v7）

基于 [memory-architecture.md](../memory-architecture.md) 重新评估。旧 v6.5 问题中大量 gbrain 相关问题已作废。

---

## ✅ 已拍板（memory-architecture.md）

- **存储架构**: 纯 markdown+git（决策 2）。项目级 = `<project>/.pensieve/`（Phase 1.4 当前），世界级 = `~/.abrain/`（独立 git repo，v7.1 七区结构 + ADR 0014）
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

### 原 P0/P1 问题中已结案部分（2026-05-11 同步到 git log）

- **Q0 sediment agent prompt** → ✅ **已解决**：ADR 0016 LLM curator 实现完成。`extensions/sediment/llm-extractor.ts` + `extensions/sediment/curator.ts` 落地（commit `f267711` / `4b4432f` 等 Phase 1.4 系列）。kind/confidence 判断、op 决策、compiled truth 格式化全部交 LLM curator；skip/create/update/merge/archive/supersede/delete 七种 op 全部实现。
- **Q1 旧 .pensieve 迁移** → ✅ **已解决**：~/.pi 父仓 173 → 0 pending，14 batch 于 2026-05-08 完成（详 `apply-checklist.md`）。原 per-file 迁移基底（`extensions/sediment/migration.ts`）于 2026-05-12 剥离；per-repo 迁移走 ADR 0014 `/memory migrate --go`（pending B4）。
- **Q4 `_index.md` 格式** → ✅ **已解决**：gitignored，由 `extensions/memory/index-file.ts` rebuild；`/memory rebuild --index` 可手动触发。Orphans 筛选在同文件实现。
- **Q5 File lock** → ✅ **已解决**：pid-file + atomic `open(... 'wx')` + stale reclaim。`extensions/sediment/writer.ts` 与 `extensions/abrain/vault-writer.ts:96-169` 均采用同一模式；sediment 锁文件位 `.pi-astack/sediment/locks/sediment.lock`。

---

## P0 — 需立即澄清

### Q2. `~/.abrain/` 初始化内容

世界级知识库从零开始，还是从 gbrain default 145 页中提取有价值的跨项目准则？

> **2026-05-11 更新**：拓扑已由 [ADR 0014](../adr/0014-abrain-as-personal-brain.md) + [brain-redesign-spec.md](../brain-redesign-spec.md) 重新确定为七区结构（identity / skills / habits / workflows / projects / knowledge / vault）；`brain-layout.ts` 会在 extension activate 时 `ensureBrainLayout()` 创建顶层七个目录（0o700）。原『world knowledge 库』内容需重新考虑在哪些区。

**建议**: 从零开始。等各个 lane writer（特别是 Lane G `/about-me` + identity 区，sediment world lane）逐个落地，自然积累。旧 gbrain 数据保留为历史档案，不自动迁移。

---

## P1 — 影响实施细节

### Q3. graph.json 增量更新策略

memory-architecture.md §5.6 说"sediment 写入单条目后仅更新该条目 node + 出入边"。增量更新的具体实现：
- 如何识别 frontmatter 中的 relation 变更？
- 如何处理 body wikilink 的增删？
- 增量更新异常时是全量重建还是标记 stale？

**建议**: Phase 1 先全量重建（简单可靠），Phase 4 升级为增量。

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

1. ~~**Phase 1 起步**: Q0（sediment prompt）+ Q1（旧数据迁移）+ Q5（file lock）~~ — ✅ 三项均已 ship（见顶部 “已拍板” 区）
2. **Phase 2 起步**: Q2（~/.abrain 初始化 / 七区拓扑已定，仅待各 lane writer）+ Q6（跨设备同步）
3. **Phase 3 起步**: Q7（qmd REST 端点）
4. **Phase 4**: Q3（graph 增量更新）+ ~~Q4（_index.md）~~✅ + Q8（写入纪律）
