# ADR 0005 — pensieve 项目作为 pi-astack 组件退场

- **状态**: **Superseded by [memory-architecture.md](../memory-architecture.md)**（2026-05-07）— `.pensieve/` 被复活为项目级 markdown+git 存储（非文件系统 target，而是 source of truth）。本 ADR 的前提 "gbrain 可以接管 pensieve 的项目级职责" 不再成立，因为 gbrain 本身已被整体替换为纯 markdown+git 架构（memory-architecture.md 决策 2）。
- **历史链**：原被 ADR 0012 取代（pensieve 作为 sediment 文件系统 target 复活）→ ADR 0012 被 memory-architecture.md 附录 B.2 宣布取代。
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0002（gbrain 唯一记忆存存储）

## 背景

历史上 pi-astack 计划包含 pensieve 项目的 vendor + 端口层（`vendor/pensieve` submodule + `runtime/pensieve/` 完整 own）。v3-v6 演化后发现：

1. **基础设施重复**：pensieve 与 gbrain 都是知识/记忆基础设施，pi-astack 不需要两套
2. **数据重复**：pi-sediment 历史上同时写两边，去重失效
3. **维护成本**：pensieve 作为 claude-code 设计，移植到 pi 需要持续 adapter 工作
4. **gbrain 已能覆盖 pensieve schema**：用 frontmatter + tags + status + derives_from/to 可以表达 maxim/decision/knowledge/pipeline 四象限（详见 ADR 0004）

## alfadb 与 pensieve 上游的关系

alfadb 是 pensieve 项目的**维护成员之一**（不是作者，不是 fork 拥有者）。

v6 双 T0 批判指出：
> alfadb 不是作者也不是 fork owner，对 pensieve 的实际权重主要靠 PR/review 质量和 issue 触觉支撑。这两者都建立在持续 dogfooding 之上。pi-astack 是 alfadb 唯一会高频踩 pensieve 的场所——一旦 pi-astack 完全不用 pensieve，alfadb 对 pensieve 的认知会在 3-6 个月内退化成"读 PR 描述"水平。

对此 v6.5 接受这一现实，要求 alfadb 在上游**身份明牌**：
- alfadb 在 pensieve 上游同步表态：从 maintainer+user 退到 maintainer-only，再到事实上的 alumni maintainer
- 不挂名继续 review PR 但不 dogfood
- 表态形式：在 pensieve 上游开 issue 或更新 CONTRIBUTORS.md，说明 alfadb 不再是日常用户

## 决策

pi-astack **彻底不依赖** pensieve 项目。

### 具体处置

1. **不建立** `vendor/pensieve` submodule
2. **不建立** `runtime/pensieve/` 目录
3. **从 ~/.pi/.gitmodules 移除** `agent/skills/pensieve` submodule
4. **清理** `~/.pi/.git/modules/agent/skills/pensieve/` 残留物
5. **删除** `kingkongshot/Pensieve@feature/auto-sediment-hook` 与 `kingkongshot/Pensieve@pi` 两个长寿命私有分支（这些是 brain maxim 明确反对的形态）
6. **物理删除** `~/.pi/.pensieve/` 目录（数据已迁移到 gbrain，详见 ADR 0006 与迁移 P3）

### 从 pensieve 提取的有用资产

pensieve `pi` 分支里有部分 alfadb 自己写的内容是 pi-astack 仍想保留的，按以下分类处理：

| 来源 | 处置 |
|---|---|
| 4 个 pipelines (`pipeline.run-when-{committing,planning,reviewing-code,syncing-to-main}.md`) | 提取为 `pi-astack/prompts/{commit,plan,review,sync-to-main}.md`（M10：同时在 gbrain 写一个 page_type=guide 节点，可被反向引用） |
| `pensieve-wand` skill | 改名为 `memory-wand`，重写为 `gbrain_*` tool 包装 |
| `references/{maxims,decisions,knowledge,pipelines,short-term,...}.md` 写入规范 | 进入 `extensions/sediment/prompts/`，主会话不可见，sediment 内部使用 |
| install.sh / hook 脚本 / lib.sh / 模板 / loop / tools | **全部丢弃**（pensieve 退场后无对应运行时） |
| superproject 探测逻辑 | **不需要**（gbrain source 通过 commit `.gbrain-source` dotfile + walk-up resolver 确定） |

### alfadb 的上游表态

执行迁移时同步在 pensieve 上游做以下之一（择一）：

- **(a)** 主动找新 user-maintainer 替补，alfadb 保留 contributor 身份
- **(b)** self-demote 到 contributor（不再 review PR）
- **(c)** 保留 maintainer 但承认 6 个月内可能退化为 alumni（透明告知）

不允许：挂名继续维护但实际不 dogfood。

## 后果

### 正面
- 单一记忆基础设施（gbrain），符合 ADR 0002
- 删除两个长寿命私有分支，符合 brain maxim
- pi-astack 仓体积缩小（无 vendor/pensieve + runtime/pensieve）
- 沉淀去重统一

### 负面
- alfadb 失去 pensieve 主要 dogfooding 场所
- pensieve 上游 contribution 质量下降（已接受）
- 一次性迁移工作量（~30 条长期 + 62 条 short-term triage）

### 不可逆性
此 ADR 是单向退场决定。若未来发现 gbrain 不能完全替代 pensieve，回归路径是：
1. 重新评估 gbrain schema 不足之处
2. 决定补丁 gbrain（加新 PageType / 关系语义）vs 重新引入 pensieve
3. 不直接回滚此 ADR，而是写新 ADR 替代

## 引用

- ADR 0001: pi-astack 项目定位
- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0006: 组件合并清单
- v6 双 T0 批判: claude-opus-4-7-xhigh 关于 pensieve 上游身份的判断
- brain maxim: `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`
