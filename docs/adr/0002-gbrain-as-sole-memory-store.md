# ADR 0002 — gbrain 作为唯一记忆存储

- **状态**: **Superseded by ADR 0012**（2026-05-06）— gbrain v0.27 multi-source 写入与检索均未实现，sediment 回退到 pensieve（项目级文件系统）+ gbrain default（世界级）的双 target 架构。本 ADR 的核心论据（gbrain 能承担项目级 + 世界级双层职责）被实证证伪。
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0001（项目定位）
- **后续**: ADR 0003（主会话只读）/ ADR 0004（sediment 写入）/ ADR 0005（pensieve 退场）

## 背景

历史上 alfadb 同时使用两套记忆基础设施：
- **pensieve**（项目级文件库）：`<project>/.pensieve/{maxims,decisions,knowledge,pipelines}/` + `short-term/`，零依赖文件，原为 claude-code 设计
- **gbrain**（跨项目数据库）：postgres + pgvector + RRF，v0.18 引入 sources 机制

`~/.pi/.pensieve/` 现有 6 maxim + 23 decision + 62 short-term + 4 pipeline，全部关于 ~/.pi dotfiles 仓本身的结论。
`gbrain default source` 已 145 个 concept page，全 federated=true（pi-sediment 历史写入）。

v3-v6 演化过程发现：pensieve 与 gbrain 两套并存有结构性冲突——
- 同一条洞察可能同时落到 ~/.pi/.pensieve/ 和 gbrain default
- pi-sediment 当前同时写两边，去重失效
- 主会话查询时要查两套，结果排序无法统一

经 v6 双 T0 批判验证（gpt-5.5-xhigh + claude-opus-4-7-xhigh 独立结论收敛）：
- pensieve schema → gbrain schema 不是无损映射，但**付得起**：用 frontmatter 强制 schema + readback assert 可补足（详见 ADR 0004）
- pensieve 文件型零依赖的优势在 offline / 跨设备 / 数据可见性上是真实代价，**必须配齐 offline 两件套兜底**（markdown export + read tool fallback；gbrain 部署由 alfadb 自决，详见 ADR 0007）

## 决策

**gbrain 是 pi-astack 唯一记忆存储**。pensieve 项目作为 pi-astack 组件不存在。

### Source 二分

| Source | federated | 用途 | 写入触发 |
|---|---|---|---|
| `pi-astack` | **false** | 项目记忆（事件、具体决策、文件路径、~/.pi 调用链） | sediment 在 ~/.pi 内的 agent_end 触发 |
| `default` | **true** | 跨项目准则（抽象原则、通用 maxim、跨项目模式） | sediment 在任何项目 agent_end 触发 |

`federated=false` 的语义：`pi-astack` source 不参加跨源 search；查询 / 写入 `pi-astack` 必须明确指定 source。交互式 gbrain CLI source 解析完全跟随 gbrain 官方 resolver（优先级链见 ADR 0008）；sediment 写入在 resolver 结果之上增加写入合法性校验与 source trust guard，并最终显式传 `--source <id>`。

### 关键约束

1. **pi-astack 仓内不创建 `.pensieve/` 目录**
2. **~/.pi/.pensieve/ 现有数据迁移**：长期目录全量 dry-run 到临时 source 校验后 import 到 gbrain `source: pi-astack`；62 条 short-term 先 triage 再决定 import / discard / 保留为 short-term tag（详见 ADR 0006、迁移 Slice A/G）
3. **vendor/pensieve 不存在**：pensieve 项目从 .gitmodules 移除，不进 vendor/
4. **sediment 不再写 pensieve**：迁移完成后下线 pensieve writer 路径

## 与 v6 原版的差异

| 项 | v6 原版 | v6.5 当前 |
|---|---|---|
| source 路由 | sediment 不传 --source，依赖 gbrain CWD resolver 自动解析 | sediment 必须显式 --source（详见 ADR 0004） |
| .gbrain-source 配置 | `cd ~/.pi && gbrain sources attach pi-astack`（生成 dotfile） | **必须 commit** 两份 `.gbrain-source`（内容 `pi-astack`）作为跨设备同源主路径；不靠 pi session_start 注入 `GBRAIN_SOURCE` |
| schema 强制 | "用 frontmatter.tags 模拟 maxim" | 强制 page_type + tag(must/want/is/how) + status，readback assert（详见 ADR 0004） |
| offline | 不提 | 配齐两件套：markdown export + read tool fallback；不提供 local docker-compose pgvector（详见 ADR 0007） |

## 后果

### 正面
- 单一记忆基础设施，主会话只查一套
- gbrain 13 PageType + 任意 tags + [[link]] + RRF + 多查询扩展 + backlinks + graph 表达力强
- 沉淀去重统一（dedupe 在 gbrain 层做）
- 跨项目准则与项目记忆有清晰边界

### 负面
- postgres 依赖：offline / 跨设备同步 / 数据可见性都需要配套兜底（详见 ADR 0007）
- pensieve schema 的"路径即语义"被 schema 强制 tag 替代，需要 sediment 写入纪律持续保证（前两月每周抽查写入分布）
- 一次性迁移 ~30 条长期 + 62 条 short-term，需要 triage 工作量（详见 ADR 0006）

## 引用

- brain maxim: `give-main-agents-read-only-knowledge-tools-delegate-all-writes-to-a-sidecar`
- v6 双 T0 批判: gpt-5.5-xhigh + claude-opus-4-7-xhigh 独立验证结果收敛
- gbrain v0.18 sources 机制: `~/gbrain/docs/guides/multi-source-brains.md`
