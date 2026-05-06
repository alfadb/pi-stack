# pi-stack 记忆架构总览

> **状态：本文档主体描述的是 v6.5→v6.7 的演化（单轨 → 双 voter → 单 agent → 双轨 gbrain source）。
> 从 v6.8 起（[ADR 0012](./adr/0012-sediment-pensieve-gbrain-dual-target.md)），sediment 回退到 **pensieve（`.pensieve/` 项目本地文件系统）+ gbrain default（世界级原则）双 target** 架构。
> 废弃项：Source 二分 (pi-stack source 已删除)、`.gbrain-source` dotfile、source-resolver、auto-register、双轨 (project source + world source)。
> 原因：gbrain v0.27 multi-source 写入与检索隔离均未实现（put/sync 不传 source_id；searchKeyword/Vector/listPages 不过滤 source_id）。上游修复后会重新迁移（`gbrain import .pensieve/ --source pi-stack`）。
>
> 以下内容保留作为设计演化记录，不是当前状态。当前架构以 ADR 0012 + `extensions/sediment/index.ts` 为准。

> 本文档是 ADR 0002-0004、0007、0008、0009、0012 的合并视图。如有冲突以 ADR 为准。

## 一图

```
┌─────────────────────────────────────────────────────────────┐
│                       pi (harness)                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 主会话 (read-only)                                    │  │
│  │   gbrain_search / get / query        ← read           │  │
│  │   skills/* (autoplan, qa, review, memory-wand, ...)   │  │
│  │   prompts/* (commit, plan, review, sync-to-main)      │  │
│  │   multi-agent: dispatch_agent / dispatch_agents       │  │
│  │                vision / imagine                       │  │
│  │                multi_dispatch (兼容)                  │  │
│  │   model-curator (capability snapshot 注入)            │  │
│  │   retry-stream-eof (错误重试)                         │  │
│  └────────────────────────┬──────────────────────────────┘  │
│                           │ agent_end 完整上下文             │
│                           ▼                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ pi-sediment (sidecar, 唯一写入者) — v6.6 单 agent 流水线 │  │
│  │   ├─ checkpoint (~/.gbrain-cache/sediment-checkpoint.json)│  │
│  │   │   ↑ lastProcessedEntryId, 增量 window              │  │
│  │   ├─ entry-text + buildRunWindow (≤200K chars)         │  │
│  │   ├─ secret-scanner (pre-LLM redact)                   │  │
│  │   ├─ gbrain-agent (单 agent loop, 默认 deepseek-v4-pro)│  │
│  │   │   ├─ system: 沉淀 rubric + markdown 终结符规范    │  │
│  │   │   ├─ tools: gbrain_search, gbrain_get (只读)      │  │
│  │   │   └─ output: SKIP / SKIP_DUPLICATE / ## GBRAIN    │  │
│  │   ├─ markdown 解析（regex header + __CONTENT__ body） │  │
│  │   ├─ secret-scanner (post-LLM rescan)                 │  │
│  │   ├─ source-router (~/.pi 双重身份, ADR 0008)         │  │
│  │   ├─ pending-queue (parse_failure / write 失败兜底)   │  │
│  │   ├─ audit-logger (sediment.log + dispatch.log)       │  │
│  │   └─ markdown-exporter (offline 兜底)                 │  │
│  └────────────────────────┬──────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                            │ explicit --source <id>
                            ▼
              ┌─────────────────────────────────┐
              │ gbrain (alfadb 自决部署)        │
              │   source: pi-stack (no-fed)     │ ← 项目记忆
              │   source: default (federated)   │ ← 跨项目准则
              │                                 │
              │   导出（sediment 触发，定期）    │
              │   ↓                             │
              │ ~/.pi/.gbrain-cache/markdown/   │ ← offline 兜底
              │   ├─ pi-stack/                  │
              │   └─ default/                   │
              │   (gitignored)                  │
              └─────────────────────────────────┘
```

## 三层心智

### 第 1 层：存储层（gbrain，alfadb 自决部署）

唯一记忆存储 = gbrain（postgres + pgvector）。

**关键**：pi-stack **不**提供 gbrain 安装兜底。alfadb 自行准备 gbrain CLI + postgres + pgvector 实例 + `~/.gbrain/config.toml` 连接配置。详见 ADR 0007。

**Source 二分**：
- `pi-stack`（federated=**false**）：项目记忆（事件、具体决策、文件路径、~/.pi 调用链）
- `default`（federated=**true**）：跨项目准则（抽象原则、通用 maxim、跨项目模式）

**federated=false 的语义**：`pi-stack` source 不参加跨源 search；查询 / 写入 `pi-stack` 必须明确指定 source。交互式 gbrain CLI source 解析完全跟随 gbrain 官方 resolver（优先级链见 ADR 0008）；sediment 写入在 resolver 结果之上增加写入合法性校验与 source trust guard，并最终显式传 `--source <id>`。

详见 [ADR 0002](./adr/0002-gbrain-as-sole-memory-store.md) 与 [ADR 0007](./adr/0007-offline-degraded-mode.md)。

### 第 2 层：访问层（主会话只读）

主会话**只读**记忆，**不写**记忆。

**Read tools**（`extensions/gbrain/index.ts`）：
- `gbrain_search(query, source?)` — 跨源 search（federated）+ 显式 source 查询
- `gbrain_get(slug, source?)` — 按 slug 取 page
- `gbrain_query(natural-language)` — 高级语义查询

**Markdown fallback**：gbrain 不可用时降级到 grep `~/.pi/.gbrain-cache/markdown/`，返回 `_degraded: true` 标志。

主会话**没有**任何写记忆的 tool。**且**通过 `tool_call` guard 阻断 bash/generic file tools 的 gbrain 写入绕道（详见 ADR 0003 v6.5.1 修订）。子代理默认无工具，不能通过 `dispatch_agents` capability escalation。

用户说"记下这条"时 sediment 从 agent_end 完整上下文识别。若要求立刻确认，主会话应指向 `/memory-pending list` 或 sediment.log，而不是承诺"我已经记住"。

详见 [ADR 0003](./adr/0003-main-session-read-only.md)。

### 第 3 层：写入层（sediment 唯一写入者）

sediment 是 pi 的 sidecar agent，监听 `agent_end` event。**当前走 v6.6 单 agent + lookup tools 写入策略**（详见 ADR 0010，替代 v6.5 多 voter 投票方案 ADR 0004）。

#### 3.1 单 agent + lookup tools（ADR 0010）

```
agent_end → ctx.sessionManager.getBranch() → 完整 1700+ entries
  ↓
buildRunWindow(branch, since=lastProcessedEntryId)  ← checkpoint 增量
  ↓
单 agent loop：
  ├─ model: deepseek/deepseek-v4-pro (默认) | claude-opus-4-7 (可选)
  ├─ reasoning: high
  ├─ tools: gbrain_search / gbrain_get  ← 主动查重，代替 quorum dedupe
  └─ output: 4 个终结符之一
        SKIP                    → 无沉淀价值
        SKIP_DUPLICATE: <slug>  → 现有页已覆盖
        ## GBRAIN mode=update   → 在已有页上追加 timeline
        ## GBRAIN mode=new      → 写新页
```

**为什么不多模型投票了**（详 ADR 0010）：

| 问题 | v6.5 多 voter | v6.6 单 agent |
|---|---|---|
| 独立性假设 | 三 voter 共享 prompt 同向漂移（实测为真） | 不假装独立，靠 lookup tools 真实查重 |
| JSON 输出 | typescript 包裹 / prose 前言 / 截断 → 100% parse error | markdown 终结符，regex 提取，0 parse error |
| dedupe | quorum 事后联合（盲投票） | agent 主动 `gbrain_search` + `gbrain_get` |
| 成本 | 3× model × 全历史 ≈ 1M tokens/轮 | 1× model × 增量 window |

**安全性保留**：pre-LLM secret scan / marker scanner / lookup tools 只读 / post-LLM secret rescan / pending queue / scratch repo skip 全部从 v6.5 保留。丢掉的只是：饱含二次注入面的 schema-enforcer（v6.6 不再需要）、quorum 聚合、多模型 dispatch。

**Checkpoint** 机制 (`~/.pi/.gbrain-cache/sediment-checkpoint.json`)：仅在 SKIP / SKIP_DUPLICATE / write success 后推进 `lastProcessedEntryId`。下轮只看新增 entries，充分复用 prefix cache。遭遇 compaction 删除 checkpoint entry 时降级为 head-only。

#### 3.2 三种合法写入策略

同一轮 agent_end 可触发多次写入，但**永远不允许同一洞察被两个 page 完全重复存储**。

- **单写**：一条洞察 → 一个 source → 一个 page
- **分离写**：一轮 N 条独立洞察 → N 个 page，各自 source 不同
- **派生写**：同一条洞察的两个抽象层次（事件 + 原则）→ 通过 frontmatter `derives_from` / `derives_to` 双向字段关联（不靠 [[link]]）

#### 3.3 不写沉淀的判据（重要）

否则 gbrain 变成 LLM 流水账。以下任一条件命中**就不写**：

1. **重述对话本身**："我们今天聊了 X" → 不写
2. **无新颖度**：内容已存在于 gbrain（dedupe miss）或在用户已读文档中
3. **置信度 < 4**：纯猜想没有任何证据支撑
4. **过窄**：只对此刻的临时上下文有用，再不会被检索
5. **可推导**：从 maxim 推一步就能得到，没必要单独存

sediment 在每次 agent_end 必须能回答"为什么不写"，记录到审计日志。

详见 [ADR 0004](./adr/0004-sediment-write-strategy.md)。

## Schema 强制（M4，pensieve 4 象限 + gstack 字段融合）

每个 page frontmatter 必填：

```yaml
---
slug: <unique-within-source>
page_type: <concept|architecture|guide|code|...>     # gbrain 13 类
tier: <maxim|decision|knowledge|short-term>          # pensieve 4 象限
tags: [<one-of-must-want-is-how>, ...]
status: <active|draft|superseded>
confidence: <1-10>                                    # gstack
source: <observed|documented|tested|derived>          # gstack
evidence_files: [<file-paths>]                        # gstack
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
derives_from: <source>:<slug>?    # 派生写：原则页指向事件页
derives_to: <source>:<slug>?      # 派生写：事件页指向原则页
supersedes: <slug>?
superseded_by: <slug>?
---
```

| `tier` | `tags` 含 | pensieve 对应 | 含义 |
|---|---|---|---|
| `maxim` | `must` | maxim | 跨项目硬规则 |
| `decision` | `want` | decision | 项目长期决策 |
| `knowledge` | `is` | knowledge | 事实记录 |
| `short-term` | `short-term` | short-term | 7 天暂存 |

**Readback assert** 流程：
1. 投票通过 → 生成 page
2. 调 `gbrain put`
3. 调 `gbrain get` 读回
4. 校验所有强制字段 + tier ↔ tag 对应 + confidence/source 合法 + 派生写对侧字段
5. 失败 → `gbrain delete` 回滚 → 进 pending queue

## 显式 source（M3）

sediment 写入**必须** `--source <id>`，**禁止**依赖 gbrain CWD resolver。详见 ADR 0008。

## Source 配置（完全跟随 gbrain 官方 resolver，ADR 0008）

pi-stack **不**重复实现 source 路由，完全依赖 gbrain v0.18 官方 resolver 优先级链：

| 优先级 | 来源 | pi-stack 用法 |
|---|---|---|
| 1 | `--source <id>` flag | sediment 内部写入显式传 |
| 2 | `GBRAIN_SOURCE` env | CI / 一次性脚本临时覆盖 |
| 3 | **`.gbrain-source` dotfile (walk-up)** | **alfadb commit 进 git，跨设备同源** |
| 4 | `local_path` 注册 | 本机便利 |
| 5/6 | brain default / seeded `default` | 兜底 |

### 跨设备同源关键：dotfile commit

`.gbrain-source` 内容是 source id 字符串（如 `pi-stack`），跨设备可移植；`local_path` 是绝对路径，跨设备失效。alfadb 可能同一 pi-stack 在不同设备路径不同（`~/.pi` / `/data/alfadb/.pi` / `~/dotfiles/pi`），dotfile 是唯一随 git 同步的同源机制。

两份必须 commit：
```
~/.pi/.gbrain-source                              ← 内容: pi-stack
~/.pi/agent/skills/pi-stack/.gbrain-source        ← 内容: pi-stack
```

两份内容相同，覆盖 cwd 落在 ~/.pi 或独立 clone pi-stack 的两种起点。

### Default 写入合法性校验（关键约束）

resolver 落到 `default`（未注册仓 fallback）不意味着 sediment 可以写。sediment agent 输出的 page tier/scope 进一步决定：

| resolver | scope=project | scope=cross-project | scope=derivation |
|---|---|---|---|
| 项目 source | ✅ 写项目 | ✅ 写 default¹ | ✅ 拆双写¹ |
| `default`（未注册仓） | ⛔ **拒写**，pending | ✅ 写 default¹ | ⛔ **整条 pending** |

¹ default 写入门槛：confidence ≥ 7 + 3/3 全票（项目写入仅需 ≥ 4 + 2/3）

该约束保证 default source（federated=true）永远只是高价值跨项目准则，federated search 不会被某项目具体事件污染。详见 ADR 0004 § 3。

### .gbrain-scratch marker

临时实验仓 `touch .gbrain-scratch` → sediment 在 agent_end **完全跳过**该仓写入决策。

### .gitignore 修订

```
.gbrain-cache/         # markdown export 输出
.gbrain-scratch        # 临时仓 marker
# 不加 .gbrain-source —— 该文件必须 commit
```

### `defaults/pi-stack.defaults.json` 字段的辅助用途

```json
{ "piStack": { "memory": { "projectSource": "pi-stack" } } }
```

`defaults/pi-stack.defaults.json` **不被 pi 自动加载**。它只提供 package-local fallback / 文档示例。运行时配置必须从官方 pi settings chain 读取。

该字段**不**用于路由（路由交给 gbrain resolver + ADR 0008 source trust guard）。仅二项辅助：
1. 初始化提示：no dotfile 时提示 alfadb 创建
2. pending review UX：resolver 返 default 但 sediment agent 判定 scope=project 时，提示 alfadb 该仓 source id 应该是什么

## Offline 两件套（ADR 0007）

**pi-stack 不提供 gbrain 安装兜底**——alfadb 自行准备 gbrain CLI + postgres + pgvector + 在 `~/.gbrain/config.toml` 配置连接。

offline（gbrain 本身挂了 / 跨设备 / 数据可见性场景）由以下两件套兜底：

1. **markdown export** — sediment 在每次 agent_end 后顺手 `gbrain export`，输出到 `~/.pi/.gbrain-cache/markdown/{pi-stack,default}/`
2. **read tool fallback** — `extensions/gbrain/` 在 gbrain 不可用时降级 grep markdown，返回 `_degraded: true`

两件**必须配齐**。

## 安全与完整性 guard（v6.5.1 新增）

- **双重 secret scan**：(a) **pre-LLM redact**——发送到外部 provider 之前纯本地扫描+隐去；(b) **post-LLM rescan**——agent 输出的 page 在 `gbrain put` 前再扫一次。命中整条 pending。
- **Voter prompt-injection 防御**：vote prompt 的 `agent_end` 上下文用 `<UNTRUSTED_AGENT_END_CONTEXT>` 包住，明确标注为 data 不是 instructions。注入 signal marker 命中卡 vote。
- **主会话写入绕道拦截**：`tool_call` guard 阻断 bash/generic file tools 对 gbrain CLI、`.gbrain-source`、`~/.pi/.gbrain-cache/` 的写入。
- **子代理默认 deny-all**：`dispatch_agent(s)` 默认 tools=∅。sediment agent 只能用 lookup tools (`gbrain_search`/`gbrain_get`)，写入 audit log。
- **Source trust guard**：background write 前验证 resolver 结果来自可信路径，防第三方仓伪造 `.gbrain-source`。

详见 ADR 0003（v6.5.1 修订）/ ADR 0004 § 一 / ADR 0008 § source trust guard / ADR 0009 § 子代理安全边界。

## 审计与可追溯

每次 agent_end 后 sediment 产出一行 JSON 日志（写了什么 / 没写什么 / 为何不写 / 投票结果），写入 `~/.pi/.gbrain-cache/sediment.log`（gitignored）。alfadb 可随时查阅。

## 与 v6 原版的差异

| 项 | v6 原版 | v6.5 当前 |
|---|---|---|
| 主会话写记忆 intent tool | `memory_remember/refine/promote` | **删除** |
| 双写定义 | "项目事件 + 跨项目准则双写互链" | **三策略**：单写 / 分离写 / 派生写（frontmatter 关联，禁止重复写） |
| source resolver | 依赖 CWD 自动解析 | **完全跟随 gbrain 官方 resolver**，sediment 写入显式 `--source`；resolver 之上加 default 写入合法性校验 |
| .gbrain-source dotfile | 用 vs 不用反复 | **必须用且 commit 进 git**（跨设备同源关键） |
| Default 污染防护 | 不提 | **项目事件永远不得写 default**，未注册仓 + scope=project → pending |
| Default 写入门槛 | 不提 | **confidence ≥ 7 + 3/3 全票** |
| schema 约束 | "用 frontmatter.tags 模拟" | **强制 tier + tags + status + confidence + source + readback assert，pensieve 4 象限 + gstack 字段融合** |
| offline | 不提 | **两件套（gbrain 部署 alfadb 自决）** |
| sediment 判断哲学 | "安静不写就好" | **完整继承 pensieve 4 象限判据 + gstack confidence/source + 不写判据** |
| multi-agent 调用 | "借 multi_dispatch ensemble" | **v6.5 dispatch_agents quorum → v6.6 单 agent loop**（ADR 0010 替代） |

## 引用

- ADR 0002: gbrain 作为唯一记忆存储
- ADR 0003: 主会话只读
- ADR 0004: sediment 写入策略
- ADR 0007: Offline 降级模式与 gbrain 部署边界
- ADR 0008: ~/.pi 双重身份与 source 路由
- ADR 0009: multi-agent 作为基础能力
- pensieve references（提取为 sediment 内部 rubric）
- gstack learnings.jsonl schema
- brain maxim: `give-main-agents-read-only-knowledge-tools-delegate-all-writes-to-a-sidecar`
- v6 双 T0 批判: gpt-5.5-xhigh + claude-opus-4-7-xhigh 独立结论收敛
