# Pi 知识管理架构设计

> 基于 2026-05-06 用户原始架构想法，通过四轮 T0 深度讨论逐步细化而成。
> 讨论参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

---

## 1. 用户的原始 9 点框架（2026-05-06）

关于知识沉淀，用户提出以下框架性想法，作为本设计的出发点：

1. 知识分为两层：**项目级知识**和**世界级知识**
2. 项目级知识提取原则来自 pensieve 的 maxims / decisions / knowledge 三个维度
3. 世界级知识提取原则目前没有具体原则，一般来说属于跨项目成立的知识，或者更像"默会"（tacit knowledge）这个概念
4. 只有 sidecar 可以写知识，其它会话包括子进程都只能读取知识
5. 抽象出 `memory_list` / `memory_search` / `memory_get` 几个工具用于知识查询、读取；sidecar 写知识有专门的工具并且不对外暴露
6. 上述工具暴露给 LLM 使用，具体后端实现可根据具体情况替换：项目级用本地 markdown 文档存储，世界级用 gbrain 存储，或者两者都用 md 存储
7. 工具返回的结果应该是当前项目内容和世界知识混合的，对 LLM 来说查询到的知识不需要区分是世界级还是项目级——区分是噪音
8. 上述工具中只有 sidecar 使用的写入工具需要区分项目级写入还是世界级写入
9. 以上是粗略想法，需要进一步补充和完善

---

## 2. 用户的关键设计决策（2026-05-06，四轮讨论）

基于原始 9 点，用户在四轮 T0 讨论中做了以下关键决策：

### 决策 1：short-term 不作为 scope 层，作为 lifetime 属性

**用户追问**：旧的 pensieve 体系中有一个"short-term"分类。在新架构中它应该是 scope 的一层、还是任意层的属性？

**决策**：short-term 不做 scope 第四层。改为任意持久层上的 **lifetime 属性**（`ttl` / `expires_at` / `expire_on: branch_merged`），与 scope 正交。世界级也需要短期（staging 未经验证的洞察，90 天 TTL 等第二次验证）。

> 分析详见附录 B.1

### 决策 2：暂时不上 gbrain，统一用 markdown + git 作为 source of truth

**用户追问**：从检索质量、版本控制、离线可用、人类可编辑、搭建复杂度、维护负担、跨机器同步、扩展性、成本、锁定风险等多个维度，全面评估 gbrain 与纯 markdown 存储的优劣。

**用户最终意见**："可以暂时不上 gbrain，但是 gbrain 中的 timeline、图谱等方法论可以借鉴。"

**决策**：
- 世界级知识与项目级知识统一使用 **markdown + git** 作为 source of truth
- gbrain 暂时不作为存储后端，但借鉴其 **timeline 双段格式**和**图关系**方法论，在纯 markdown 层面实现等价能力
- gbrain 未来可作为"从 md 派生的可重建索引层"接入（Facade 模式允许）

> 分析详见附录 B.2（gbrain vs md 多维度对比）、附录 B.3（gbrain 方法论借鉴）

### 决策 3：~/.abrain 作为世界级知识库

**用户追问**：如果世界级也用 markdown + git 存储，放在 `~/.abrain/` 作为独立版本化仓库是否可行？

**决策**：
- `~/.abrain/` 作为世界级知识的独立 git 仓库（private），与 `~/.pi` 完全平行
- 通过 `ABRAIN_ROOT` 环境变量引用（不用 submodule，不用 symlink）
- 与 `.pensieve/` 的边界：pensieve = 项目特定，abrain = 跨项目通用
- 多机器通过 git push/pull 同步

> 分析详见附录 B.2.4

### 决策 4：参考 Karpathy LLM Wiki 方法论，补齐 Lint 和查询反哺

**用户方向**：研究 Karpathy 的 LLM Wiki 方法论，看与我们的方案是否契合。

**决策**：
- 我们的架构与 Karpathy 在核心哲学上完全一致（markdown=源真、LLM=维护者），验证了方向正确
- 补齐三个 Karpathy 有而我们缺失的组件：
  - **Lint & Maintain** 阶段（sediment 第二个角色：断链/重复/过期/scope 污染检测）
  - **查询反哺闭环**（知识被实际应用 → timeline 追加 `[applied]` 记录）
  - **Index 文件**（sediment 自动维护 `_index.md` 作为导航）
- 采用 qmd（已有 pi-qmd 扩展）作为可选本地搜索后端
- 向量索引降为可选加速层（2,000 条目以下标注"不需要"）

> 分析详见附录 B.4

### 决策 5：借鉴 gbrain 的 Timeline + Graph 方法论，纯 markdown 实现

**用户意见**："gbrain 中的 timeline、图谱等方法论可以借鉴，继续讨论。"

**决策**：
- **Compiled Truth + Timeline 双段格式**：以 `---`（triple-hr）分隔，compiled truth 可重写，timeline append-only
- **7 条确定性 Lint 规则**（T1-T7）：零 LLM 调用，纯 grep + awk 校验
- **图作为派生 JSON 索引**（`graph.json`）：从 markdown 确定性构建，gitignored 可重建
- **三种关系对称性**：symmetric / asymmetric / body_links
- **Brain Health 评分**：5 指标加权，纯脚本计算

> 详细设计见 §5.5 和附录 B.3

---

## 3. 核心架构原则

1. **读写分离**：只有 sediment sidecar 可以写持久知识。
2. **读接口统一**：对 LLM 暴露的查询工具不区分项目级/世界级。
3. **写入显式 scoped**：只有 sidecar 的写入工具需要区分目标层级。
4. **Scope × Lifetime 正交**：适用范围和失效时间是独立维度。
5. **Markdown 为唯一 source of truth**：索引是 view，文本是 table。
6. **Facade 模式隔离**：LLM 只看到统一接口，底层可替换。
7. **默认永久，显式临时**：只有真正临时的条目显式声明 lifetime。
8. **Graceful degradation**：索引不可用时降级到 grep。
9. **拒绝完备性**：默会知识入库的是投影，不是本体。

---

## 4. 知识模型

### 4.1 三层 Scope

| 层 | 生命周期 | 存储位置 | 写入者 |
|---|---|---|---|
| **Session** | 当前会话 | 内存 scratchpad | 主 agent（零摩擦） |
| **Project** | 项目存活期 | `<project>/.pensieve/`（md + git） | sediment sidecar |
| **World** | 跨项目持久 | `~/.abrain/`（md + git） | sediment sidecar（with gates） |

### 4.2 正交属性

```yaml
scope: session | project | world       # 空间边界
kind: maxim | decision | anti-pattern | pattern | fact | preference | smell
status: provisional | active | contested | deprecated | superseded | archived
confidence: 0-10

lifetime:                              # 时间边界（决策 1）
  kind: permanent | ttl | event | review
  expires_at: 2026-05-14               # kind=ttl
  expire_on: branch_merged:feat/x      # kind=event
  review_after: 2026-05-10             # kind=review
```

### 4.3 Kind 定义

| kind | 权威性 | 说明 |
|---|---|---|
| **maxim** | MUST | 硬约束，不可违反 |
| **decision** | WANT | 时效性约束 |
| **anti-pattern** | WARN | 已知陷阱（复用价值最高） |
| **pattern** | SUGGEST | 经过验证的良好模式 |
| **fact** | IS | 事实陈述 |
| **preference** | PREFER | 用户/项目偏好 |
| **smell** | MAYBE | 刚浮现的模式，confidence < 5 |

### 4.4 默会知识管道

```
smell (staging)  ──验证──→  pattern (project)  ──promotion gates──→  maxim (world)
confidence < 5              confidence 5-7                       confidence 8-10
随意捕获，低承诺              半形式化，有边界                   跨项目验证，高承诺
```

**边界**：可写的是"当 X 出现时做 Y"的规则。必须保持默会的是"从 200 行 diff 中 2 秒定位 bug"的注意力机制。

### 4.5 条目内部结构：Compiled Truth + Timeline（决策 5）

```markdown
---
id: avoid-long-argv-prompts
scope: world
kind: pattern
status: active
created: 2026-05-06
updated: 2026-05-06
relates_to: [world:use-at-file-input]
derives_from: [project:dispatch-agent-input-compat-contract]
---

# Avoid Long argv Prompts

## Principle
详细论述、边界条件。这是知识的**当前最佳结论**，可随新证据被整体重写。

---

## Timeline

- 2026-05-05 | sess-abc | captured | 在 dispatch_agent 长 prompt 失败中首次发现
- 2026-05-07 | sess-def | validated | 在另一个 CLI wrapper 中再次验证 [+1]
```

| 区域 | 含义 | 可重写？ |
|---|---|---|
| frontmatter | 结构化元数据、关系 | 可更新 |
| compiled truth | `---` 之前的正文 | 可被 sidecar 完全重写 |
| timeline | `---` 之后的 append-only 事件日志 | 只能追加 |

### 4.6 关系类型与对称性（决策 5）

```yaml
symmetric:                         # lint 检测缺失对
  - relates_to
  - contested_with

asymmetric:                        # 反向边只在派生索引
  derives_from:    derived_into
  superseded_by:   supersedes
  applied_in:      cited_by

body_links:                        # wikilink 默认关系
  references:      referenced_by
```

---

## 5. 存储架构

### 5.1 核心决策：Markdown + Git 统一 SoT（决策 2）

世界级与项目级统一用 markdown + git。gbrain 的优势可通过从 md 派生的索引层获得，离线/版本控制/人类可编辑/md 的结构性优势是 gbrain 换不回来的。

### 5.2 存储拓扑

```
源真层（SoT，git tracked）                派生索引层（gitignored，可重建）
─────────────────────────────          ──────────────────────────────

project/                                .pensieve/.index/
  <project>/.pensieve/                    ├── graph.json
    ├── maxims/                           ├── vectors.db (optional)
    ├── decisions/                        └── fulltext.db (optional)
    ├── knowledge/
    ├── staging/                        ~/.abrain/.state/index/
    ├── archive/                          ├── graph.json
    ├── raw/                              ├── vectors.db (optional)
    ├── _index.md                         └── fulltext.db (optional)
    └── schemas/relations.yaml

world/
  ~/.abrain/
    ├── maxims/
    ├── patterns/
    ├── anti-patterns/
    ├── facts/
    ├── staging/
    ├── archive/
    ├── raw/
    ├── _index.md
    └── schemas/relations.yaml
```

### 5.3 Facade 模式

```
                        LLM Tools
                  memory_search | memory_get | memory_list
                              │
                        Memory Facade
                    (路由、归并、排序、去重、degrade)
                     /                    \
            ProjectStore               WorldStore
    (rg + optional index)         (rg + optional index)
    ── <project>/.pensieve/       ── ~/.abrain/
```

```typescript
async function search(query: string, ctx: SessionContext): Promise<SearchResult[]> {
  const [projectResults, worldResults] = await Promise.all([
    projectStore.search(query),
    worldStore.search(query),
  ]);
  return rrfMerge([projectResults, worldResults])
    .map(r => ({ ...r, finalScore: r.score * projectBoost * Math.log(1 + r.citations) * (r.confidence/10) }))
    .filter(r => r.status !== 'archived')
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 20);
}
```

### 5.4 ~/.abrain 设计（决策 3）

独立 git 仓库（private），`ABRAIN_ROOT` 环境变量引用。

| 维度 | `.pensieve/` (project) | `~/.abrain/` (world) |
|------|------------------------|---------------------|
| scope | 本项目特定 | 跨项目通用 |
| 判断标准 | 离开当前 repo 不成立 | 换完全不同的项目仍然成立 |
| 示例 | "本项目用 pnpm" | "argv 传 long prompt 用 @file" |

**写入决策树**：

```
洞察 P 引用了具体文件路径/模块名/API？
├─ 是 → 写 .pensieve/
└─ 否 → ≥2 个不同项目验证过？
        ├─ 是 → 写 ~/.abrain/
        └─ 否 → 写 ~/.abrain/staging/，等第二次命中
```

### 5.5 Graph 派生索引（决策 5）

`graph.json` 从 markdown 确定性构建，gitignored：

```json
{
  "nodes": { "<slug>": { "scope": "...", "kind": "...", "status": "..." } },
  "edges": [
    { "from": "a", "to": "b", "type": "relates_to", "source": "frontmatter" }
  ],
  "stats": { "orphans": [...], "dead_links": [...] }
}
```

CLI 命令：

```bash
pi memory check-backlinks [--fix]     # 反向链接完整性（仅 symmetric）
pi memory graph <slug> --depth 2      # 图遍历
pi memory neighbors <slug> --hop 1    # 邻居快照
pi memory doctor                      # 健康评分
```

---

## 6. Memory 工具接口

### 6.1 读工具（统一接口，不暴露 scope）

```
memory_search(query, filters?)  → SearchResult[] { slug, title, summary, score, scope, kind, status, backend, degraded?, related_slugs }
memory_get(slug, options?)      → KnowledgeEntry (完整内容 + 关联摘要)
memory_list(filters?)           → { entries: EntryMeta[], next_cursor? }
memory_relate(from, to, rel)    → void  (声明关系，sidecar 处理)
```

### 6.2 写工具（仅 sediment 可见）

```
memory_write(entry, dest)  → { slug, status }
memory_update(slug, patch)
memory_deprecate(slug, reason)
memory_promote(slug, 'world')  → { promoted, gates_passed[] }
```

---

## 7. 注入策略

### 7.1 三层注入

| 注入位置 | 内容 | 预算 |
|---|---|---|
| **System Prompt (T1)** | ≤5 条 maxims + `_index.md` catalogue | ≤2K tokens |
| **Tool Retrieval (T2)** | 按需 search → get | ≤6K tokens/轮 |
| **Passive Nudge (T3)** | trigger phrase 匹配推送 | ≤300 tokens/轮 |

### 7.2 被动回忆

每条 world knowledge 带 `trigger_phrases`。agent 发言命中 → 自动推送 summary。解决"不会 search 不知道存在的东西"。

---

## 8. 读写分离

| 角色 | 读 | 写 project | 写 world |
|---|---|---|---|
| 主 session | ✅ | ❌ | ❌ |
| dispatch 子进程 | ✅ | ❌ | ❌ |
| sediment sidecar | ✅ | ✅ | ✅ (with gates) |

- 写入路由 fail-closed：无法确定 target project → 不写
- File lock 保证单写入者

---

## 9. 演化机制

### Promotion（决策 1、决策 5）

```
project knowledge
  → Gate 1: 去上下文化 → Gate 2: 跨实例验证 → Gate 3: 反例检查
  → Gate 4: 冷却期(≥3d) → Gate 5: 冲突检查
  → promoted: world scope, confidence ≥ 7
```

每次演化事件追加 timeline 行（决策 5）：
```
- 2026-05-09 | sess-ghi | promoted | project→world [promoted]
```

### Deprecation & Specialization

- 被证伪 → deprecated + superseded_by（不降级）
- 条件约束 → specialization（加 boundaries，不降级）

---

## 10. 治理

### Lint & Health Pipeline（决策 4、决策 5）

| 工具 | 时机 | 检查内容 |
|------|------|---------|
| `pi memory lint` | git pre-commit | timeline 格式 (T1-T7) + frontmatter schema |
| `pi memory check-backlinks` | pre-commit / cron | symmetric 类型反向链接完整性 |
| `pi memory doctor` | 每日 cron | 5 维 health score → report |

**5 维 Health Score**：

| 指标 | 权重 | 算法 |
|------|------|------|
| timeline_coverage | 30% | 含 timeline 条目数 / 总数 |
| link_density | 25% | clamp(avg_degree / 2.0, 0, 1) |
| orphan_avoidance | 20% | 1 - 零链节点数 / 总节点数 |
| dead_link_avoidance | 15% | 1 - 死链数 / 总链接数 |
| staging_freshness | 10% | 1 - p90(staging age) / 30d |

### 安全脱敏

sediment 写入前过 redactor：credential → `[REDACTED]`，绝对路径 → `$HOME/...`，token → 拒绝写入。

---

## 11. 实现路线图

### Phase 1：Project 层 + 格式标准化

- Markdown 条目 compiled truth + timeline 双段格式（决策 5）
- `memory_search / get / list` grep-based 实现
- `_index.md` 自动生成（决策 4）
- `pi memory lint` 7 条校验规则（决策 5）

### Phase 2：World 层接入

- `~/.abrain/` 落地，`ABRAIN_ROOT` 支持（决策 3）
- Memory Facade 跨 store + graceful degradation
- Trigger phrases + passive nudge 机制
- `graph.json` rebuild + check-backlinks（决策 5）

### Phase 3：派生索引 + Health

- qmd 可选本地搜索后端接入（决策 4）
- `pi memory doctor` 健康面板
- 查询反哺闭环（决策 4）

### Phase 4：治理

- 冲突检测 + contested 状态
- 引用热度排序
- 脱敏 pipeline

### Phase 5：Session 层

- Session scratchpad API
- Cross-session 分析 pass

---

## 附录 A：综合架构图

```
┌─────────────────────────────────────────────────────┐
│                    Agent / LLM                       │
│          memory_search()  │  memory_get()            │
└────────────────────────┬────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Memory Facade     │
              │  路由 · 归并 · 排序   │
              │  Graceful Degrade   │
              └────┬──────────┬─────┘
                   │          │
    ┌──────────────▼──┐  ┌───▼──────────────┐
    │  grep backend   │  │  qmd/vector      │  ← 可选派生索引
    │  (rg over md)    │  │  (embedding idx) │
    └──────┬──────────┘  └───┬──────────────┘
           │                 │
    ┌──────▼─────────────────▼──────────────┐
    │           SOURCE OF TRUTH              │
    │  project/   <project>/.pensieve/**     │
    │  world/     ~/.abrain/**               │
    │  (markdown + git, 人类可读, 离线可用)   │
    └────────────────────────────────────────┘
```

---

## 附录 B：T0 讨论分析（按决策组织）

### B.1 决策 1 分析：short-term 的定位

**结论**：short-term 不作为 scope 第四层。用 2×2 矩阵验证正交性：

| scope \ lifetime | permanent | ephemeral |
|---|---|---|
| Session | ❌ | ✅ |
| Project | ✅ | ✅ |
| World | ✅ | ✅ |

六个有效象限。若把 short-term 当 scope 层，会丢失"world 级临时暂存"这个关键需求。改为 lifetime 属性：`kind: permanent | ttl | event | review`，GC 作为独立 pipeline。

### B.2 决策 2+3 分析：gbrain vs markdown + ~/.abrain

**多维度评估**：gbrain 在检索质量（语义向量+图查询）和 AI 原生特性上占优，但 md+git 在离线可用、版本控制、人类可编辑、零搭建、零锁定风险、跨机器同步等维度上结构性占优。且 gbrain 的优势可通过派生索引获得。

**混合方案 C（推荐）**：md 做主存储 + 派生向量/图索引。索引 gitignored 可重建；不可用时 fallback 到 grep。

**~/.abrain**：独立 git repo，`ABRAIN_ROOT` 环境变量引用（不用 submodule/symlink）。append-only timeline 段减少 git merge 冲突。

### B.3 决策 5 分析：Timeline + Graph 在 Markdown 中的实现

**Timeline**：`---`（triple-hr）作为 compiled_truth 与 timeline 的硬分隔符。7 条 lint 规则（T1-T7），零 LLM 调用：triple-hr 存在性、唯一性、无标题泄漏、bullet 格式、日期顺序、非空、frontmatter 完整。T3（无标题泄漏）是关键安全规则。

**Graph**：三个边来源——frontmatter 关系字段（强类型）、正文 wikilink（弱类型）、代码引用（可选）。图作为 `graph.json` 派生索引。关系分 symmetric（需双向一致）、asymmetric（反向边只在索引）、body_links（wikilink 默认）。回溯链、N 跳遍历、反向链接检查均从 graph.json 确定性计算。

**Health**：5 指标加权，纯 ripgrep + jq 脚本。timeline_coverage 作为渐进指标（新条目强制，旧条目报告不阻断）。CI 硬错误阻塞 dead link；cron 每日全量 doctor。

### B.4 决策 4 分析：Karpathy LLM Wiki 方法论

**契合度**：markdown=源真、LLM=维护者、编译真相等核心理念完全一致。**真正缺口**：Lint & Maintain 阶段、查询反哺闭环、Raw Sources 层。

**引入的修改**：sediment-lint 定期健康检查；知识应用追踪（timeline 追记 `[applied]`）；`_index.md` 自动生成；`raw/` 目录渐进引入。

**qmd 定位**：作为 Facade 下可选后端，本地 BM25+向量+LLM Rerank。不能替代 scope 路由、图查询、sediment 写入。

**向量索引调整**：Pensieve 层不做向量索引。World 层向量搜索降为可选（2,000 条目以下标注"不需要"）。
