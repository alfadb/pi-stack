# ADR 0006 — 组件合并清单

- **状态**: Accepted
- **日期**: 2026-05-05
- **决策者**: alfadb
- **依赖**: ADR 0001（项目定位）/ 0002（gbrain）/ 0005（pensieve 退场）

## 背景

ADR 0001 决定建立 pi-stack 单一仓。本 ADR 列出每个组件的**目标位置**与**合并动作**，同时说明**上游关系三分类**。

## 6 组件目标形态

| 组件 | 现状 | 目标位置 | 自带工具/能力 | 关键变更 |
|---|---|---|---|---|
| **pi-sediment** | 独立 npm 包，写 gbrain default | `pi-stack/extensions/sediment/` | sidecar agent | 全面改造：单写/分离/派生策略（ADR 0004）/ 显式 source / schema enforcer / triage 一次性脚本 / markdown exporter |
| **pi-multi-agent** | 独立 npm 包 | `pi-stack/extensions/multi-agent/` | `dispatch_agent` + `dispatch_agents`（基础能力） + `multi_dispatch`（兼容） + `vision` + `imagine` | 源码迁入；按 ADR 0009 自由化重构；sediment 借 `dispatch_agents` 做投票 |
| **pi-model-curator** | 独立 npm 包 | `pi-stack/extensions/model-curator/` | capability snapshot 注入 | 源码迁入，行为不变 |
| **gbrain extension** | `~/.pi/agent/extensions/gbrain/` | `pi-stack/extensions/gbrain/` | `gbrain_search/get/query` | 加 markdown fallback（ADR 0007） |
| **retry-stream-eof** | `~/.pi/agent/extensions/retry-stream-eof.ts` | `pi-stack/extensions/retry-stream-eof/` | 流错误重试 | 直接迁入，无变更（**自有功能，永久 own，不向上游 PR**） |
| **pi-gstack（自写 skills）** | 独立 npm 包，19 skills | `pi-stack/skills/{autoplan,canary,cso,...}` | autoplan/qa/review/health 等 | 19 个 skills 全部迁入 |
| **garrytan/gstack** | 上游开源 | `pi-stack/vendor/gstack/` | 移植参考 | read-only submodule |
| **pensieve-wand skill** | `~/.pi/agent/skills/pensieve/pi/skills/pensieve-wand/` | `pi-stack/skills/memory-wand/` | 检索助手 | 改名 + 重写为 `gbrain_*` tool 包装 |
| **pensieve（项目）** | submodule + vendor 计划中 | **彻底消失** | — | submodule 移除；vendor 不建；4 pipelines 提取为 prompts；详见 ADR 0005 |
| **~/.pi/.pensieve/ 数据** | 6 maxim + 23 decision + 62 short-term + 4 pipeline | gbrain `source: pi-stack` | — | triage + import；物理目录删除 |

## 上游关系三分类

UPSTREAM.md 按以下三类组织。

### 类 A: 自有功能（permanent in-house）

不向上游 PR 的 alfadb 自有产权。

| 组件 | 理由 |
|---|---|
| **retry-stream-eof** | alfadb 自己的功能，上游对 PR 态度大多直接关闭 |
| **memory-wand** (pensieve-wand 改写) | pi-stack 自有产权，重写后非 pensieve 派生物 |
| **memory architecture 整套** | sediment 改造 / source-router / schema-enforcer / markdown-exporter 全是自有设计 |
| **prompts/{commit,plan,review,sync-to-main}** | 从 pensieve pipelines 提取后是 pi-stack 私有 prompts；gbrain guide 节点延后到核心链路稳定后 |
| **defaults/pi-stack.defaults.json** | package-local fallback / 文档示例；运行时仍走官方 pi settings chain |
| **multi-agent input-compat + tool allowlist** | model-facing API 兼容与子代理权限边界，pi-stack 自有设计 |
| **main-session write guard** | 阻断 bash/generic file tools 绕过 sediment 写 gbrain / cache |
| **source trust guard** | 防 `.gbrain-source` dotfile 被第三方仓伪造 source id |

**UPSTREAM.md 处理**：不进 UPSTREAM.md。本 ADR 已作为决策记录。

### 类 B: vendor 移植参考（上游只读引用，pi 端口在 pi-stack 内）

| 组件 | 上游 | 用途 |
|---|---|---|
| **garrytan/gstack** | github.com/garrytan/gstack | 19 skills 已迁入 pi-stack/skills/，vendor 仅作未来移植参考 |

**UPSTREAM.md 处理**：进 UPSTREAM.md 主体，10 步 LLM 协作工作流（diff 阅读 / 分类 / 与作者讨论 / 端口层修改）适用。

**注**：v6 之前曾计划 `vendor/pensieve` 也属此类，**v6.5 删除**——pensieve 项目已退场（ADR 0005）。

### 类 C: pi 内部组件迁入（曾经独立 npm 包，alfadb 自有）

| 组件 | 原状 | 关系 |
|---|---|---|
| **pi-multi-agent** | 独立 npm 包 | alfadb 自家代码迁入合并 |
| **pi-sediment** | 独立 npm 包 | alfadb 自家代码迁入合并 |
| **pi-model-curator** | 独立 npm 包 | alfadb 自家代码迁入合并 |
| **pi-gstack** | 独立 npm 包 | alfadb 自家代码迁入合并 |

**UPSTREAM.md 处理**：不进 UPSTREAM.md（同一作者迁入，不是上游协作）。本 ADR 已作为决策记录，原仓 archive 时 README 指向 pi-stack。

## pi-multi-agent 工具内聚

`vision` 和 `imagine` 是 pi-multi-agent 自带的工具：

- 共用 sub2api 调用
- 共用 `visionModelPreferences` 配置
- 共用 `.pi-multi-agent-output/` 目录
- 子代理可通过 `Task.tools` 显式委托（默认 deny-all；readonly/vision 需 allowlist；mutating tools 默认拒绝，详见 ADR 0009）

**不**在 pi-stack 里把 vision/imagine 单独拆出来，整体随 pi-multi-agent 迁入。

## multi-agent 调用模式重构（ADR 0009）

原 `multi_dispatch(strategy, tasks)` 固定 4 strategy（parallel/debate/chain/ensemble）API 降级处理：

- `multi_dispatch` 保留作为兼容层，内部转发 `dispatch_agents`
- 新增 `dispatch_agent(opts)` / `dispatch_agents(opts[])` 基础能力，主会话与 sediment 自由组合
- 4 种 strategy 作为 cookbook 模板放在 `extensions/multi-agent/templates/`，主会话参考但不被绑定

详见 ADR 0009。

## ~/.pi/.pensieve/ 数据迁移

详见迁移文档 P3 阶段。摘要：

| 类别 | 数量 | 处理 |
|---|---|---|
| `maxims/` | 6 | 全量 import 到 gbrain `source: pi-stack`，tag 加 `must` |
| `decisions/` | 23 | 全量 import，tag 加 `want`，保留 status 字段 |
| `knowledge/` | ~30 | 全量 import，tag 加 `is` |
| `pipelines/` | 4 | 提取为 `prompts/*.md`（可执行）；gbrain page_type=guide 节点延后到核心链路稳定后，tag 加 `how` |
| `short-term/` | 62 | **先 triage**：promote / discard / 保留 short-term tag，再决定是否 import |

物理删除时机：迁移验证通过 + 1 周观察期后。

## 后果

### 正面
- 6 组件单仓维护
- 上游关系三分类清晰
- 自有功能（retry-stream-eof、memory architecture）永久 own，无上游协作开销
- 原仓废弃后 README 重定向，外部用户能找到 pi-stack

### 负面
- subtree merge 历史进入 pi-stack（pi-multi-agent / pi-sediment）
- 一次性迁移工作量集中

## 引用

- ADR 0001: pi-stack 项目定位
- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0004: sediment 写入策略（含 pensieve 4 象限 + gstack 字段 + 不写判据）
- ADR 0005: pensieve 退场
- ADR 0007: offline 降级与 gbrain 部署边界
- ADR 0008: ~/.pi 双重身份与 source 路由
- ADR 0009: multi-agent 作为基础能力
- 迁移文档: `docs/migration/steps.md`
