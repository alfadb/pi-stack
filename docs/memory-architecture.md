# Pi 知识管理架构设计

> ⚠️ **部分 superseded by [ADR 0014](adr/0014-abrain-as-personal-brain.md)（2026-05-09）+ [ADR 0015](adr/0015-memory-search-llm-driven-retrieval.md)（2026-05-10）+ [ADR 0016](adr/0016-sediment-as-llm-curator.md)（2026-05-10）**
>
> 本文档的以下部分**已被 ADR 0014 + [brain-redesign-spec.md](brain-redesign-spec.md) 或 ADR 0015 取代**：
> - **§4.1 三层 Scope（Session / Project / World）的物理拓扑**：`<project>/.pensieve/` 物理位置已废止；项目知识迁入 `~/.abrain/projects/<id>/`。所有数据统一在 `~/.abrain/` 内部按七区结构（identity/skills/habits/workflows/projects/knowledge/vault）组织。
> - **scope=project\|world 二元划分（含 4.1 表 / 8 节 sediment 路由 / 9 节 promotion）**：被 brain 内部结构吸收。Lane B（manual promote）和 Lane D（auto-promote）失去意义。新增 Lane G（about-me declare）和 Lane V（vault declare）。
> - **§7 工具接口**：`memory_search` 等 facade 接口形状保留，但 `scope` 参数语义重新定义（详见 brain-redesign-spec.md §4）。
> - **§5.3 `memory_search` 算法规格 / §3.8 Graceful degradation**：被 ADR 0015 supersede。`memory_search` runtime 只走双阶段 LLM retrieval；grep+tf-idf 代码仅作为历史 baseline/diagnostics，不作为降级路径。LLM 失败 hard error。
>
> **仍然有效的部分**：7 节 LLM-facing facade 契约 / Compiled Truth + Timeline 双段格式 / Lint 规则 / Brain Health 评分 / 8 节 sediment pipeline 的 extractor/triage/writer/reviewer 内核。**修正**：sediment Lane C 的 mechanical semantic gates / dedupe gates 已被 ADR 0016 删除；默认转向 LLM curator + sensitive-info/storage hard gates，git/audit 作为回滚面。
>
> **需要随 ADR 0014 同步修订的部分**（v1.1 incorporate Round 3 P0）：
> - **audit row schema (§8.4)**：`lane` 字段 enum 扩展为 `"explicit" | "auto_write" | "about_me" | "vault_write"`（原ADR 0013 的 `promote` / `auto_promote` 不再使用）。Lane V 另写入独立 log `~/.abrain/.state/vault-events.jsonl`。详 [ADR 0014 §审计扩展](adr/0014-abrain-as-personal-brain.md#审计扩展)。
> - **T7 lint 规则 (§10.1)**：`scope` frontmatter 字段从 **ERROR**-required 降为 **WARNING**-recommended——新 brain 拓扑下 scope 由目录位置隐式决定（§3.5 deterministic router），不再是显式选择。
>
> 阅读本文档时，遇到 `<project>/.pensieve/` 与 `~/.abrain/` 字样请同时参照 [brain-redesign-spec.md](brain-redesign-spec.md) 进行物理路径转换。

---

> 基于 2026-05-06 用户原始架构想法，通过五轮 T0 深度讨论 + 完备性审查 + qmd 集成方案 + 两轮最终评审逐步细化而成。
> 讨论与审查参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro
> 最终评审（2026-05-07）：两轮三模型双盲审查 CONDITIONAL → 修订后 PASS
> **2026-05-09 后续修订**：物理拓扑被 ADR 0014 supersede（见上方 banner）。

**读者前提**：本文档假设读者了解 pi 的基本概念——pi 是一个 TypeScript TUI 编码 agent 框架，通过 `extension` 机制注册工具和生命周期钩子（`activate()`/`agent_end`），配置分布在 `<project>/.pi/agent/settings.json`（运行偏好）和 `<project>/.pensieve/config.yml`（项目知识配置）。pi 是长生命周期进程，主 session 和 dispatch 子进程通过工具与 LLM 交互，sediment sidecar 是 pi 的后台写入扩展。

**文档角色**：本文档**曾经**是 Pi 知识管理系统的权威设计规范（v1.0，2026-05-07）；自 ADR 0014 起，物理拓扑部分由 [brain-redesign-spec.md](brain-redesign-spec.md) 接管，本文档的 sediment internals / facade 契约 / lint / health 部分仍是权威。

---

## 1. 用户的原始 9 点框架（2026-05-06）

1. 知识分为两层：**项目级知识**和**世界级知识**
2. 项目级知识提取原则来自 pensieve 的 maxims / decisions / knowledge 三个维度
3. 世界级知识提取原则目前没有具体原则，一般来说属于跨项目成立的知识，或者更像"默会"（tacit knowledge）这个概念
4. 只有 sidecar 可以写知识，其它会话包括子进程都只能读取知识
5. 抽象出 `memory_list` / `memory_search` / `memory_get` 几个工具用于知识查询、读取；sidecar 写知识有专门的工具并且不对外暴露
6. 上述工具暴露给 LLM 使用，具体后端实现可根据具体情况替换：项目级用本地 markdown 文档存储，世界级用 gbrain 存储，或者两者都用 md 存储
7. 工具返回的结果应该是当前项目内容和世界知识混合的，对 LLM 来说查询到的知识不需要区分是世界级还是项目级——区分是噪音
8. 上述工具中只有 sidecar 使用的写入工具需要区分项目级写入还是世界级写入
9. 以上是粗略想法，需要进一步补充和完善

> **以下架构对 §1.7 的细化**：LLM-facing 工具返回值不暴露 `scope`/`backend`/`source_path`，混合排序。scope 仅 Facade 内部用于 project boost ranking，backend 仅用于可观测性。§1.7 的原则在实现中完整保留。

---

## 2. 用户的关键设计决策（2026-05-06，四轮讨论）

**决策 1**：short-term 不作为 scope 层，作为任意持久层上的 **lifetime 属性**（ttl / expires_at / expire_on）。

**决策 2**：暂时不上 gbrain。统一用 **markdown + git** 作为 source of truth。但借鉴 gbrain 的 timeline 和图谱方法论（决策 5）。

> **Supersedes ADR 0012**：ADR 0012（2026-05-06）规定 sediment 走 "pensieve（.pensieve/）+ gbrain default（世界级）" 双 target。本文档基于以下理由转向纯 markdown+git：gbrain v0.27 的 multi-source 模式尚未稳定，且一旦确认单 source 模式，markdown+git 在离线可用、版本控制、人类可编辑、零锁定方面结构性占优。gbrain 的 timeline 与图谱方法论被借鉴到 markdown 格式中（决策 5）。~/.abrain/ 替代 gbrain default 作为世界级存储。

**决策 3**：`~/.abrain/` 作为世界级知识的独立 git 仓库（private），`ABRAIN_ROOT` 环境变量引用。与 `.pensieve/` 边界：pensieve=项目特定，abrain=跨项目通用。

**决策 4**：参考 Karpathy LLM Wiki 方法论，补齐 **Lint & Maintain** 阶段、**查询反哺闭环**、**Index 文件自动生成**。qmd 作为可选本地搜索后端。向量索引降为可选加速层。

**决策 5**：借鉴 gbrain 方法论，在纯 markdown 层面实现 **Compiled Truth + Timeline 双段格式**、**10 条确定性 Lint 规则**、**Graph 派生 JSON 索引**、**Brain Health 评分**。

---

## 3. 核心架构原则

1. **读写分离**：只有 sediment sidecar 可以写持久知识（markdown 文件、frontmatter、graph.json）。主 session、dispatch 子进程只能读。
2. **读接口统一，provenance 仅内部可见**：LLM-facing 工具结果不包含 `scope`、`backend`、`source_path`——LLM 不做 scope/backend 判断。Facade 内部保留 provenance 用于 ranking（project boost）、路由和 debug。`memory_get` 返回完整条目（含 scope），但 scope 是条目固有属性，不是 LLM 选择的结果。
3. **写入显式 scoped**：只有 sidecar 的写工具区分项目/世界。
4. **Scope × Lifetime 正交**：适用范围和失效时间是独立维度，不在目录结构中混叠。
5. **Markdown 为唯一 source of truth**：索引是 view，文本是 table。索引 gitignored，可随时从 md 重建。
6. **Facade 模式隔离**：LLM 只看到统一的读接口，底层存储和索引拓扑变更不影响上层。LLM-facing schema 绝不暴露 backend selector、scope filter、物理路径。
7. **默认永久，显式临时**：大多数知识无过期时间。只有实验性的条目显式声明 ttl。
8. **Graceful degradation**：索引不可用时降级到 ripgrep 关键词搜索，结果标注 `degraded: true`。系统不失效。**ADR 0015 例外**：`memory_search` 以准确度为硬约束，LLM 路径失败时 hard error，且不提供 grep 降级开关。
9. **核心接口必须完备，边缘功能渐进迭代**：数据模型、写入安全、读接口契约不能有空白。性能优化、高级治理可以按 Phase 迭代。

---

## 4. 知识模型

### 4.1 三层 Scope（MVP 为 Project + World，Session 为可选层）

| 层 | 生命周期 | 存储位置 | 写入者 | MVP |
|---|---|---|---|---|
| **Session** | 当前会话，结束即蒸发 | 内存 scratchpad | 主 agent（零摩擦） | Phase 6（可选） |
| **Project** | 项目存活期 | `<project>/.pensieve/`（md + git） | sediment sidecar | ✅ Phase 1 |
| **World** | 跨项目持久 | `~/.abrain/`（md + git） | sediment sidecar（with gates） | ✅ Phase 2 |

Session scope 不是持久 schema 的一部分——它是内存 scratchpad，不落盘，没有 markdown 文件，不参与 search。其 `lifetime` 固定为 session 生命周期（会话结束即蒸发），不可 promote 到 project/world。Session 在 MVP 中不实现，Phase 6 之前 scope 枚举仅含 `project | world`。

### 4.2 正交属性

```yaml
# 知识条目的核心元数据
scope: project | world                  # MVP；Phase 5 加 session
kind: maxim | decision | anti-pattern | pattern | fact | preference | smell
status: provisional | active | contested | deprecated | superseded | archived
confidence: 0-10                        # 0-2=staging/low, 3-5=provisional, 6-7=active, 8-10=high-certainty（cross-validated）

lifetime:                               # 时间边界
  kind: permanent | ttl | event | review
  expires_at: 2026-05-14                # kind=ttl
  expire_on: branch_merged:feat/x       # kind=event
  review_after: 2026-05-10              # kind=review
```

**`confidence` 定义**：
- 取值 0-10 整数。由 sediment 在写入/update 时设定，promotion gate 通过后自动 +2。
- project 与 world 的 confidence 不可直接比较——只是各自 scope 内的信号强度。
- 不随时间自动衰减。被反例命中（contested）后 sediment 下调；被多项目验证后上调。
- search ranking 中 confidence 作为加权因子（`* max(0.1, confidence/10)`）。floor 0.1 确保 confidence=0 的 staging 条目仍可被检索（只大幅降权，不归零消失）。
- **Phase 1 初始化规则**（promotion gates 未上线时，sediment deterministic fallback）：
  - fact（transcript 中的客观事实）→ confidence: 5
  - pattern / anti-pattern / decision（含 LLM 判断）→ confidence: 3
  - maxim（hard rule）→ confidence: 7
  - preference → confidence: 5
  - staging 中条目（任意 kind）→ confidence: 1-2
- Phase 3+ promotion gate 通过后自动 +2（cap: `min(10, confidence+2)`）。被反例命中（contested）后 sediment 下调 2-3。

### 4.3 Kind 定义

| kind | 权威性 | 例子 |
|---|---|---|
| **maxim** | MUST | "tmux 中永不关主 pane" |
| **decision** | WANT | "本项目用 pnpm，不用 npm" |
| **anti-pattern** | WARN | "dispatch_agents 表面并行可能实际串行" |
| **pattern** | SUGGEST | "用 @file 传 long prompt" |
| **fact** | IS | "pi 的 _emitExtensionEvent 透传引用" |
| **preference** | PREFER | "用户喜欢中文回复" |
| **smell** | MAYBE | confidence < 5 的模式初现 |

### 4.3.1 Kind → 目录映射

sediment 写入时根据 kind + scope 决定目标目录。这是确定性映射，不是 LLM 的判断。

| kind | project 目录 | world 目录 | 说明 |
|------|-------------|-----------|------|
| maxim | `maxims/` | `maxims/` | |
| decision | `decisions/` | N/A | decision 只在 project scope 中存在（决策绑定具体项目上下文） |
| anti-pattern | `knowledge/` | `anti-patterns/` | project 中作为通用 knowledge 存储 |
| pattern | `knowledge/` | `patterns/` | project 中作为通用 knowledge 存储 |
| fact | `knowledge/` | `facts/` | |
| preference | `knowledge/` | `maxims/` | world 中 preference 本质是全局 maxim（"用户喜欢中文回复"） |
| smell | `staging/` | `staging/` | smell 不是独立 kind——是 `staging/` 中任意条目 + `confidence < 3` 的事实状态 |
| (any, status=archived) | `archive/` | `archive/` | 按 status 路由，不按 kind |
| (any, status=deprecated) | 留在原目录 | 留在原目录 | 原位标记，不移动 |
| (any, status=superseded) | 留在原目录 | 留在原目录 | 原位标记，不移动 |

### 4.4 条目内部结构：Compiled Truth + Timeline（决策 5）

**完整示例（avoid-long-argv-prompts）**：

```markdown
---
id: world:avoid-long-argv-prompts
scope: world
kind: pattern
status: active
confidence: 8
schema_version: 1
created: 2026-05-06
updated: 2026-05-08
trigger_phrases:
  - "argv"
  - "long prompt"
  - "shell argument"
  - "@file"
relates_to:
  - world:use-at-file-input
derives_from:
  - project:pi/dispatch-agent-input-compat-contract
provenance:
  sessions:
    - sess-abc123
    - sess-def456
  models:
    - claude-opus-4-7
  human_reviewed: false
---

# Avoid Long argv Prompts

## Summary
传给子进程的 prompt 如果包含换行、引号或超过约 200 字符，
应写入临时 .md 文件，通过 `@file` 语法传递，而非直接作为 argv 参数。

## Principle
`spawn("pi", [prompt], ...)` 中的 prompt 可能包含：
- 换行符（多段落指令）
- 双引号 / 单引号（shell escaping 边界）
- Markdown 代码块（反引号在 shell 中需要转义）

即使 Linux ARG_MAX 为 2MB，shell escaping + 调试可读性在远低于此
限制时已退化。推荐：prompt 一律写入临时 .md，通过 `@file` 传递。

## Boundaries
- 适用于 Node `spawn` / shell `exec` 传参
- 不适用于 HTTP body / stdin stream / REST API
- 短 prompt（< 200 chars 且无特殊字符）可以直接传

## Evidence
- sess-abc123: dispatch_agent 长 prompt 导致子进程接收到损坏的指令
- sess-def456: 另一个 CLI wrapper 中同样问题再现，@file 彻底解决

---

## Timeline

- 2026-05-05 | sess-abc | captured | 在 dispatch_agent 长 prompt 失败中首次发现
- 2026-05-07 | sess-def | validated | 在另一个 CLI wrapper 中再次验证 [+1]
- 2026-05-08 | sess-ghi | promoted | project→world，通过 5 个 promotion gates [promoted]
```

**区域定义**：

| 区域 | 含义 | 可重写？ | 参与 search？ |
|---|---|---|---|
| frontmatter | 结构化元数据、关系、当前状态 | 可更新 | 仅字段过滤，不参与语义搜索 |
| compiled truth | `## Timeline` 之前的正文 | 可被 sidecar 完全重写 | ✅ 主检索区域 |
| timeline | `## Timeline` 之后的 append-only 日志 | 只能追加 | Stage 1 不入 index；ADR 0015 Stage 2 对候选读取完整 timeline，用于 freshness/supersession 判断 |

**关键规则**：
- `## Timeline` 是最后一个 H2，之后只允许 `- <time> | ...` 格式的 bullet 行。`<time>` 兼容旧 `YYYY-MM-DD`，但 sediment 新写入必须使用本地 ISO datetime（如 `2026-05-10T22:41:36+08:00`），因为每天可能产生几十条 entry，date-only 不足以表达同日 supersession。
- `updated` 只反映 compiled_truth 编辑时间；timeline 追加不影响 `updated`。sediment 新写入的 `created`/`updated` 同样使用本地 ISO datetime；旧 date-only entry 不批量迁移。
- Timeline 内禁止：heading（`#`/`##`/`###`）、code fence（`` ``` ``）、Markdown table（`|---|` 分隔行）、嵌套 list
- Timeline bullet 的 `|` 分隔符不属于 table——T9 lint 规则仅检测 table 语法
- **Timeline action 枚举**：`captured | validated | promoted | deprecated | superseded | applied | merged | migrated | specialized`。T4 lint 不校验 action 值（只校验日期+格式），但非标准 action 会被 doctor 标 warning
- **slug 生成规则**：sediment 从 title 派生（lowercase、空格→`-`、去特殊字符、≤80 字符）。frontmatter `id` 使用 `project:<project-slug>:<slug>` 或 `world:<slug>`。LLM-facing 接口使用 bare slug。`memory_get` 内部并发查 project+world 两 store 解析同名 slug，命中任意返回
- git diff 可区分"知识演化"（compiled truth 变更）和"证据追加"（timeline 追加）

### 4.5 关系类型与对称性

```yaml
symmetric:                         # lint 检测缺失对，建议补全
  - relates_to
  - contested_with

asymmetric:                        # 反向边只在派生索引存在，不写回 markdown
  derives_from:    derived_into
  superseded_by:   supersedes
  applied_in:      cited_by

body_links:                        # 正文 [[slug]] wikilink 默认关系
  references:      referenced_by
```

**`schemas/relations.yaml`**（git tracked，关系类型注册表）：

```yaml
# 定义所有合法的 relation type 及其属性
relations:
  relates_to:
    symmetric: true
    description: "通用关联"
  derives_from:
    symmetric: false
    reverse: derived_into
    description: "派生自"
  superseded_by:
    symmetric: false
    reverse: supersedes
    description: "被替代"
  applied_in:
    symmetric: false
    reverse: cited_by
    description: "应用在"
  contested_with:
    symmetric: true
    description: "与...冲突"
  references:
    symmetric: false
    reverse: referenced_by
    description: "正文 wikilink 引用"
```

sediment 写入 relation 时校验 type 必须存在于该 registry。graph.json 构建时从此文件读取合法的 edge type 列表。

### 4.6 默会知识管道

```
smell (staging, confidence<3) → pattern (project, 3-7) → maxim (world, 7-10)
```

**边界**：可写的是"当 X 出现时，做 Y"的规则。必须保持默会的是"从 200 行 diff 中 2 秒定位 bug"的注意力机制。"拒绝完备性"指：永不追求把全部默会知识形式化——库里的永远是投影。

---

## 5. 存储架构

### 5.1 Source of Truth 与派生索引

Markdown + git 是唯一 canonical store。所有索引（向量、全文、图）是 gitignored 派生制品，可随时从 md 重建。不可用时系统降级但不失效。

### 5.2 存储拓扑

```
源真层（git tracked）                      派生索引层（gitignored，可重建）
─────────────────────────────          ──────────────────────────────

project/                                .pensieve/.index/
  <project>/.pensieve/                    ├── graph.json
    ├── config.yml                        └── fulltext.db (optional)
    ├── maxims/
    ├── decisions/                      ~/.abrain/.state/index/
    ├── knowledge/                        ├── graph.json
    ├── staging/                          └── fulltext.db (optional)
    ├── archive/
    ├── _index.md                       .pensieve/.state/
    └── schemas/                          ├── health-report.md
          └── relations.yaml              ├── lint-report.md
                                          ├── sediment-events.jsonl
world/                                    ├── locks/
  ~/.abrain/                              │   └── sediment.lock
    ├── config.yml                        ├── nudge-history.json
    ├── maxims/                           └── migration-report.md
    ├── patterns/
    ├── anti-patterns/                  ~/.abrain/.state/
    ├── facts/                            ├── health-report.md
    ├── staging/                          ├── lint-report.md
    ├── archive/                          ├── sediment-events.jsonl
    ├── _index.md                         ├── pending-world-intents.jsonl
    └── schemas/                          ├── locks/
          └── relations.yaml              │   └── sediment.lock
                                          └── known-projects.json
```

### 5.3 `memory_search` 算法规格

> ⚠️ **Superseded by ADR 0015（2026-05-10）——以下全文为历史设计记录，不是当前 shipped runtime。**
>
> 当前 shipped 算法是 `extensions/memory/llm-search.ts` 中的双阶段 LLM retrieval：Stage 1 (deepseek-v4-flash、thinking=off、内存生成 enhanced index text、出 top-K 候选类型指引) → Stage 2 (全 entry compiled_truth+timeline_tail、thinking=high、输出 final rank + rank_reason)。结果卡含 `created` / `updated` / `rank_reason` / `timeline_tail`。无 grep fallback，Stage 2 不跳过，LLM 失败 hard error——准确性优先是硬契约。
>
> **下方原 hybrid/grep/qmd 规格只作为历史 baseline + 未来 qmd 设计参考保留**。体现 ADR 0015 设计意图：`memory_search` 允许未来加 cache / qmd 加速层，但**从不**推荐回退到 tf-idf / RRF 的准确性降级路径。

**historical/future hybrid = 关键词搜索（rg + tf-idf）+ (可选) qmd 向量语义，RRF 融合。** 当前 `memory_search` runtime 不使用该路径降级；它只作为历史 baseline 与未来 qmd 设计参考。

> "BM25" 术语保留给 Phase 3+ qmd 提供真正 Okapi BM25 实现时使用。Phase 1 为 rg + 简单 tf-idf。
> qmd 作为 Facade 的 QmdBackend 接入。完整集成方案见附录 C。

```
historical/future hybrid baseline（not current ADR 0015 runtime）:
  1. 并发查询 ProjectStore + WorldStore
  2. 每个 store:
     a. 如果向量索引可用 → 向量语义搜索（top-50）
     b. 始终运行关键词搜索（ripgrep + tf-idf + 文档长度归一化）
     c. RRF 融合 a + b（向量不可用时仅关键词搜索）
  3. Facade 合并两 store 结果：
     a. 内部 schema：{ slug, title, summary, score, scope, kind, status,
        confidence, backend, source_path, degraded? }
     b. project boost：scope=project 且属于当前 project → ×1.5
     c. 内部排序：textScore × projectBoost × citationBoost × confidenceFactor
        其中 citationBoost = log(2 + citations)（citations≥0 时 ≥1，永不为 0）
        confidenceFactor = max(0.1, confidence/10)
        graph 不可用时 citationBoost = 1（无 citations 数据）
        （citations 来自 graph.json 反向边计数）
     d. **注意**：各因子为不同量纲（textScore: tf-idf 0-N, citations: 0-N, confidence: 0-10），
        相乘前 Facade 内部 min-max 归一化 textScore 到 [0,1]
     d. 过滤：默认排除 status=archived
     e. 截断：top-20
  4. 返回 LLM-facing schema（scope/backend/source_path 不暴露）
```

**LLM-facing 结果schema**（`memory_search` 返回；ADR 0015 后）：

```json
{
  "slug": "avoid-long-argv-prompts",
  "title": "Avoid Long argv Prompts",
  "summary": "传给子进程的 prompt 应通过 @file 传递...",
  "score": 0.87,
  "kind": "pattern",
  "status": "active",
  "confidence": 8,
  "created": "2026-05-10T22:41:36+08:00",
  "updated": "2026-05-10T23:08:12+08:00",
  "rank_reason": "Directly answers the query; latest timeline confirms it supersedes the older argv note.",
  "timeline_tail": ["- 2026-05-10T23:08:12+08:00 | ..."],
  "related_slugs": ["use-at-file-input"]
}
```

`degraded` 不再出现在 `memory_search` LLM runtime 结果中：ADR 0015 明确无降级路径。完整 timeline 仍通过 `memory_get(slug)` 获取；search card 只返回最近 1-2 条 `timeline_tail` 作为新鲜度/废止信号。

**内部 schema**（Facade/CLI debug 使用，LLM 不可见）：在上述基础上包含 `scope`、`backend`、`source_path`。`memory_get` 返回完整条目（含 scope，因为 scope 是条目固有属性）。`memory_search` 的 LLM-facing 结果中 slug 为 bare slug（不含 `project:`/`world:` 前缀）。

**`citations` 定义**：来自 graph.json 中指向该 slug 的 `relates_to`/`derives_from`/`applied_in` 入边总数。初始为 0，随着条目被引用自动增长。在 ranking 中 `log(1+citations)` 作为 freshness/热度信号——这不是"被引用多=更正确"，而是"被引用多=更活跃/更可能相关"。

### 5.4 Facade 模式

```
                        LLM Tools
                  memory_search | memory_get | memory_list | memory_neighbors
                              │
                        Memory Facade
                    (解析 markdown stores；ADR 0015 search 走双阶段 LLM rerank，无 grep/degrade fallback)
                     /                    \
            ProjectStore               WorldStore
    (rg + optional qmd/vector)    (rg + optional qmd/vector)
    ── <project>/.pensieve/       ── ~/.abrain/ (ABRAIN_ROOT)
```

- **MemoryBackend 接口**：ProjectStore 和 WorldStore 实现相同的最小接口（不强制 grep/vector 能力统一——不同后端的能力差异通过 `capabilities` 声明，Facade 按能力路由）：

```typescript
interface MemoryBackend {
  capabilities: { keywordSearch: boolean; semanticSearch: boolean; graphTraversal?: boolean };
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  get(slug: string): Promise<KnowledgeEntry | null>;
  list(filters?: { kind?, status?, limit?, cursor? }): Promise<ListResult>;
  neighbors?(slug: string, opts?: { hop?: number; max?: number }): Promise<Neighbor[]>;
}
```
- Project/World store 的行为模式对称（都是 markdown 后端），同一接口减少实现分支
- Facade 负责合并当前项目 `.pensieve/` 与可用的 `~/.abrain/` entries；ADR 0015 `memory_search` runtime 不返回 `degraded`，LLM/model/auth/network/JSON 失败 hard error。
- ABRAIN_ROOT 未设置或 `~/.abrain` 不存在时 → WorldStore 空结果，不向 LLM-facing search card 暴露 backend/scope/degraded。

### 5.5 ~/.abrain 设计（决策 3）

独立 git 仓库（private），`ABRAIN_ROOT` 环境变量引用（默认 `~/.abrain`）。

| 时机 | 动作 |
|---|---|
| 机器启动 / session 开始 | `git pull --rebase --autostash` |
| sediment 写完一条 | `git add . && git commit -m "abrain: <slug>"`（不 auto push） |
| 会话结束 | 安全脚本：`pull --rebase --autostash && push` |
| 冲突 | 不自动解决，pending 等人工 |

**跨 project 注册**：`~/.abrain/.state/known-projects.json` 记录所有已知 project：

```json
[
  {
    "project_id": "pi-global",
    "pensieve_path": "/home/worker/.pi/.pensieve",
    "last_seen": "2026-05-07T14:30:00Z",
    "slug_count": 23
  }
]
```

sediment 启动时自动注册当前 project（upsert by project_id）。Gate 2 跨实例验证时从此文件获取 ≥2 个 project。project_id 从 `<project>/.pensieve/config.yml` 的 `project.id` 字段读取，缺失时 fallback 为 `path.basename(projectRoot)`。

### 5.6 Graph 派生索引（决策 5）

`graph.json` 从 markdown 确定性构建（post-commit hook 增量重建，缺失时当场 grep）：

```json
{
  "built_at": "2026-05-08T14:30:00Z",
  "git_head": "abc123",
  "stale": false,
  "nodes": {
    "<slug>": {
      "title": "...",
      "scope": "project|world",
      "kind": "maxim|decision|pattern|anti-pattern|fact|preference",
      "status": "active|provisional|contested|deprecated|superseded|archived",
      "confidence": 7,
      "in_degree": 3,
      "out_degree": 1
    }
  },
  "edges": [
    {
      "from": "<slug>",
      "to": "<slug>",
      "type": "relates_to|derives_from|superseded_by|applied_in|references|contested_with",
      "source": "frontmatter|body_wikilink"
    }
  ],
  "stats": {
    "node_count": 320,
    "edge_count": 614,
    "orphans": ["<slug>"],
    "dead_links": [{"from": "<slug>", "to": "<missing-slug>", "type": "relates_to"}]
  }
}
```

**Edge type 来源**：`frontmatter` 边的合法 type 来自 `schemas/relations.yaml` 注册表。`body_wikilink` 边 type 固定为 `references`。graph.json 构建时过滤不在注册表中的 type → warning。

**Stale 标记**：`stale: true` 表示 graph.json 不反映当前 git HEAD（sediment 写后 index 失败，或手动编辑了 markdown）。任意读工具首次访问 graph.json 时检测 `git_head ≠ HEAD` → 触发 lazy rebuild。

**增量更新**：sediment 写入单条目后，仅更新该条目的 node + 出入边，不重建全量 graph。增量更新异常（如边冲突）→ 设置 `stale: true`，下次读触发全量 rebuild。

CLI 命令（全部只读，写操作由 sediment 代理）——2026-05-11 修订：pi-astack 里这些是 pi 内部的 slash 命令（`/memory ...`），不是 shell binary；实际注册在 `extensions/memory/index.ts` 的是 `/memory` 下的 `lint` / `migrate` / `doctor-lite` / `check-backlinks` / `rebuild --graph|--index`。原列表中 `graph` / `neighbors` / `doctor` 三个子命令未落地（`graph` 被 `rebuild --graph` 合并；`neighbors` 同 memory_neighbors 工具重复；`doctor` 被轻量 `doctor-lite` 取代）：

```text
/memory lint                # frontmatter 与结构 lint
/memory migrate [--dry-run] # 旧格式迁移
/memory doctor-lite         # 快速健康报告
/memory check-backlinks     # 反向链接完整性检查
/memory rebuild --graph|--index   # 重建派生索引 artifact
```

---

## 6. Memory 工具接口

### 6.1 读工具（主 session + dispatch 子进程可调用）

```
memory_search(query: natural-language retrieval prompt, filters?: { kinds?, status?, limit? })
  → SearchResult[] { slug, title, summary, score, kind, status, confidence, created, updated, rank_reason?, timeline_tail, related_slugs }
  // slug 为 bare slug（不含 scope 前缀），scope/backend/source_path 不暴露给 LLM
  // ADR 0015 双阶段 LLM retrieval；无 grep fallback，无 degraded 字段；默认搜索当前 project + world，LLM 不区分来源

memory_get(slug: string, options?: { include_related?: boolean })
  → KnowledgeEntry { ...full entry including timeline, scope, source_path }
  // 完整条目含 scope——scope 是条目的固有属性，不是搜索时的选择

memory_list(filters: { kind?, status?, limit?, cursor? })
  → { entries: EntryMeta[], next_cursor? }
  // 分页浏览，主要用于人工调试
  // **`scope` 形参与 EntryMeta 里的 scope 字段均不暴露**（superseded by
  //  brain-redesign-spec.md §4.3 + ADR 0014）——与 memory_search 同一 facade
  //  不变量。当前实现静默忽略 LLM 传入的 `scope` key。

memory_neighbors(slug: string, options?: { hop?: number, max?: number })
  → { slug, neighbors: Array<{ slug, title, kind, status, confidence, direction, edge_type, distance }> }
  // 返回 envelope，不是 bare array——便于未来加话题 / cursor。选项 hop 默认 1 (clamp 1..3)，max 默认 20 (clamp 1..100)。
  // 只读图遍历，不写任何关系（替代原名 memory_relate 的读语义）
```

### 6.2 写入 substrate（仅 sediment sidecar 内部可见）

主会话 **不注册** LLM-facing `memory_write/update/delete/promote/relate` 工具。ADR 0016 后，写入能力是 sediment 内部 writer substrate：

```
writeProjectEntry(draft)
updateProjectEntry(slug, patch)
mergeProjectEntries(target, sources, patch)
archiveProjectEntry(slug)
supersedeProjectEntry(oldSlug, newSlug?)
deleteProjectEntry(slug, mode = "soft")
```

这些内部操作由 Lane A explicit `MEMORY:` 或 Lane C auto-write curator 调用；主会话仍只有 `memory_search/get/list/neighbors` 只读工具。`memory_neighbors` 是只读图遍历，不是旧 `memory_relate` 写语义。

---

## 7. 注入策略

### 7.1 三层注入

| 注入位置 | 内容 | 预算 | 选择算法 |
|---|---|---|---|
| **System Prompt (T1)** | ≤5 条当前 project maxims + `_index.md` 摘要 | ≤2K | 最近更新 + 最高 confidence，project 优先 |
| **Tool Retrieval (T2)** | 按需 `memory_search` → `memory_get` | ≤6K/轮 | LLM 自行决定检索 |
| **Passive Nudge (T3)** | trigger phrase 匹配推送 | ≤300/轮 | 每轮 agent_end 匹配，去重，最多 3 条 |

### 7.2 冲突裁决

同一知识出现在 T1 和 T2 → T2 结果优先（更新鲜）。project 与 world 矛盾 → project 优先（更具体、更近）。但若有 `contested` 标记 → 两者都暴露给 LLM，让它自行判断。

### 7.3 被动回忆（Passive Nudge）

每条知识带 `trigger_phrases: string[]`。sidecar 在 agent_end 后检测 agent 发言是否包含精确子串匹配任一 trigger phrase。命中 → 注入 summary 到下一轮 T3。每轮最多 3 条，同一条 24h 内不重复推送。中文和英文 trigger phrases 平等对待（均为子串匹配）。

---

## 8. 读写分离与 Sediment 行为规范

### 8.1 权限表

| 角色 | 读 | 写 project | 写 world |
|---|---|---|---|
| 主 session agent | ✅ | ❌ | ❌ |
| dispatch 子进程 | ✅ | ❌ | ❌ |
| sediment sidecar | ✅ | ✅ | ✅ (with gates) |
| 用户显式 `/skill:pensieve` | ✅ | 发起 intent 请求 | 发起 intent 请求 |

### 8.2 Sediment 触发与决策逻辑

```
agent_end 事件
  ↓
sediment 读取本轮完整 transcript（工具调用 + LLM 输出 + 用户消息）
  ↓
extract: 从 transcript 识别潜在洞察（LLM prompt: 给目标"寻找可复用的规则/模式/反例"，不给开放式"有无值得持久化的知识"——避免过度沉淀）
  ↓
sanitize: 第一时间过 redactor（credential/IP/路径脱敏），确保后续所有步骤（dedupe/search/log）不接触敏感信息
  ↓
classify: 为每个候选判定 scope(project/world) + kind + confidence
  ↓
dedupe: 查询已有条目。Phase 1 使用确定性 dedupe（slug 精确相等 + 标题 trigram Jaccard ≥ 0.7 + BM25 召回 top-5 人工比对）；Phase 3+ 升级为语义相似度（阈值 0.85）
  ↓
  ├─ 命中 → merge：更新已有条目 compiled_truth + 追加 timeline
  └─ 未命中 → create：写入新条目
  ↓
lint: 内存中校验 frontmatter schema + timeline 格式
  ↓
acquire lock: 获取 project 级 file lock（`.pi-astack/sediment/locks/sediment.lock`）
  ↓
write: 原子写入 markdown 文件（先写 tmp，再 rename）——这是事务核心
  ↓
git: git add + git commit（不 auto push）——canonical md 已持久化，事务完成
  ↓
index: 增量更新 graph.json（best-effort；失败不回滚 md/git，下次查询时 lazy rebuild）
  ↓
release lock
  ↓
audit: 追加 sediment-events.jsonl
```

**写入决策树（project vs world）**：

```
新洞察 P：

P 引用了具体文件路径 / 模块名 / API 名？
├─ 是 → scope: project（先写入 project staging/ 或对应 kind 目录）
└─ 否 → P 在 ≥2 个不同领域的 project 中出现过？
        ├─ 是 → scope: world（通过 promotion gates 写入 world）
        └─ 否 → scope: project, world_candidate: true（留在 project，跨项目验证后再 promote）

默认路径：所有首次捕获 → project。仅当 promotion gates 通过后才写入 world。
不绕过 gates 直接写 world staging/。
```

**Transaction 边界**：
- 核心事务 = sanitize → classify → dedupe → lint → lock → write md → release lock → audit
- **事务完成标志 = markdown 原子写入成功（tmp→rename）**
- git commit 是事务完成后的 best-effort 持久化：成功则标记 `git_commit` 到 audit；失败则记录 `git_unavailable` warning，下次 session 自动补 commit
- 任何核心步骤失败 → 回滚：删除 tmp markdown，释放 lock
- graph.json 索引更新是 **best-effort**：成功则更新，失败则标记 stale（下次查询时 lazy rebuild），不回滚 md
- 多条目的 sediment run：每条目独立事务（各自 write→commit），互不连锁失败

### 8.3 错误处理与恢复

| 场景 | 行为 |
|---|---|
| Markdown 解析失败 | 记录 `sediment-events.jsonl`，跳过该条目，不阻断其他条目 |
| Git 仓库不存在 | 允许写 markdown，标记 `git_unavailable`，doctor 中 warning；不写 graph.json（避免成功假象） |
| Git push 冲突 | 保留本地 commit，标记 pending，**下**次写入前先 pull --rebase |
| Lock 获取超时（>5s） | writer 返回/抛出 lock timeout；auto-write audit 标记失败，git/audit 是诊断面。当前不实现 pending queue，也不把窗口标记为已写成功。 |
| 磁盘满 / 权限错误 | 记录错误到 sediment-events.jsonl，通知主 session（ui.notify） |
| 写入中途崩溃 | tmp 文件残留，下次启动时清理 `.tmp-*` 文件；graph.json 从 markdown 全量重建 |
| ABRAIN_ROOT 未设置 | WorldStore 空返回；写入 world 的 attempt 记录到 `.state/pending-world-intents.jsonl`（格式：`{"ts","session_id","slug","kind","confidence","title","reason"}`），等 ABRAIN 可用后 sediment 重放或人工确认。不自动改 scope |
| `.index/` 与 markdown 不一致 | 查询时检测 `git_head` ≠ HEAD → lazy rebuild（允许读路径写 gitignored 派生索引）。canonical markdown 的读写分离不适用于 `.index/` 派生层 |
| 脱敏规则误伤 | 拒绝写入（fail-closed），人工通过直接编辑 markdown 恢复 |

### 8.4 可观测性

`sediment-events.jsonl`（gitignored）记录每次写入：

```json
{
  "timestamp": "2026-05-07T08:30:00Z",
  "session_id": "sess-abc123",
  "operation": "create",
  "target": "project:avoid-long-argv",
  "model": "claude-opus-4-7",
  "lint_result": "pass",
  "git_commit": "abc123",
  "dedupe_score": 0.32,
  "duration_ms": 2340
}
```

---

## 9. 演化机制

### 9.1 Promotion（Project → World）

```
project knowledge (status: active)
    ↓
Gate 1: 去上下文化检查
  → sediment 重写 compiled_truth，去掉项目名、路径、技术栈，保留成立边界和技术前提
  → 对照 `.pensieve/schemas/decontextualized-check.md` 规则检查（Phase 3+）：
```yaml
# schemas/decontextualized-check.md（项目级，git tracked）
# 定义 promotion 时需移除的模式
rules:
  - pattern: "<project_root>/"
    replace: "$PROJECT/"
  - pattern: "\\b(pnpm|npm|yarn|bun)\\b"
    action: warn  # 提醒检查是否为技术栈特化
  - pattern: "\\b\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b"
    replace: "[IP]"
  - pattern: "\\b[A-Z][a-z]+Name\\b"  # 驼峰客户名
    action: reject  # 拒绝 promotion，需人工去标识
```
    ↓
Gate 2: 跨实例验证
  → 同一 insight 在 ≥2 个独立 project 的 `.pensieve/` 中被 sediment 引用或写入过
  → 存储：graph.json 中搜索 derives_from 或 similar slug
    ↓
Gate 3: 反例检查
  → sediment 用 LLM 搜索：是否存在该 maxim 不成立的场景？
  → 存储：如有反例 → 写入 boundaries 字段
    ↓
Gate 4: 冷却期
  → 从首次 capture 起 ≥ 3 天
  → 存储：timeline 首行日期 vs 当前日期
    ↓
Gate 5: 冲突检查
  → memory_search 查询已有 world 条目。Phase 2 使用 keyword + trigram Jaccard (≥0.7) 比对；Phase 4+ 升级为语义相似度
  → 如冲突 → 旧条目标 contested，新条目标 contested 互相 link
  → 如一致 → promote
    ↓
promoted → scope: world, confidence: +2, status: active
  → world 条目 timeline: "2026-05-09 | sess-ghi | promoted | project→world [promoted]"
  → project 原条目：保留，追加 timeline "[promoted_to world:<slug>]"，不删除
```

**Gate 结果存储**：promotion 状态写在新 world 条目的 frontmatter 中：

```yaml
promotion:
  source_entry: project:avoid-long-argv
  gates:
    decontextualized: pass
    cross_instance: pass  # 2 projects
    counterexamples: pass  # boundaries added
    cooling_until: 2026-05-09
    conflict_check: pass  # no conflicts
  completed_at: 2026-05-09
```

### 9.2 Deprecation & Specialization

- 被证伪 → `status: deprecated` + `superseded_by: <new-slug>`（不删除，保留历史）
- 条件约束 → specialization（加 boundaries 字段，不改变 scope）
- 不存在 World → Project 降级

---

## 10. 治理

### 10.1 Lint & Health Pipeline

| 工具 | 时机 | 范围 |
|------|------|------|
| `memory lint` | sediment 写后 + git pre-commit | timeline 格式 (7 rules) + frontmatter schema |
| `memory check-backlinks` | CI / 每日 cron | 仅 symmetric 类型反向链接 |
| `memory doctor` | 每周 cron | 健康评分 → `.state/health-report.md` |

**10 条 Lint 规则（T1-T10）**：

| 规则 | 检测内容 | 严重度 |
|------|---------|--------|
| T1 `timeline-heading-present` | 条目文件必须包含 `## Timeline` 且为最后一个 H2 | ERROR |
| T2 `timeline-heading-unique` | 文件中恰好一个 `## Timeline` | ERROR |
| T3 `no-headings-in-timeline` | Timeline 之后不能有 `#`/`##`/`###` | ERROR |
| T4 `timeline-bullet-format` | Timeline 每行必须是 `- <time> \| ...` 格式；旧 `YYYY-MM-DD` 兼容，新 sediment 写入用 ISO datetime | WARNING |
| T5 `timeline-chronological` | Timeline 条目按日期升序 | WARNING |
| T6 `timeline-not-empty` | Timeline 至少一行记录 | WARNING |
| T7 `frontmatter-required` | 必须有 `kind`/`status`/`confidence`/`created`/`schema_version`/`title`；`scope` recommended 但不必须（新 brain 拓扑下 scope 由目录隐式决定） | ERROR / `scope` 缺失仅 WARNING |
| T8 `no-code-fence-in-timeline` | Timeline 区域内不能出现 `` ``` `` code fence | ERROR |
| T9 `no-table-in-timeline` | Timeline 区域内不能出现 Markdown table（`|---|` 分隔行或 `| 表头 |` 行）。注意：Timeline bullet 自身的 `|` 字段分隔符不属于 table | ERROR |
| T10 `no-nested-list-in-timeline` | Timeline 区域内不能出现缩进子列表（仅允许顶层 `- `） | WARNING |

### 10.2 Health 评分（避免腐烂，不追完备）

与 §4.6 "拒绝完备性" 对齐——评分衡量**避免腐烂**，不衡量**正向覆盖率**：

| 指标 | 权重 | 算法 |
|------|------|------|
| `dead_link_rate` | 30% | 1 - 死链数/max(总链接数, 1) |
| `orphan_rate` | 25% | 1 - 零链节点数/总节点数 |
| `staging_freshness` | 20% | max(0, 1 - p90(staging age)/90d) — clamp 到 [0,1] |
| `conflict_rate` | 15% | 1 - contested条目数/总条目数 |
| `schema_validity` | 10% | lint 通过的条目数/总条目数 |

**不包含** timeline_coverage（避免逼着补全旧条目）和 link_density（避免滥加链接）。

CI gate：`dead_links > 0` → fail（不允许死链）。死链 = 链接目标是 graph.json 中不存在的 slug。其余指标只 warn，不阻塞。

### 10.3 安全脱敏

sediment 写入前执行（§8.2 sanitize 阶段），**写前脱敏**：

| 模式 | 处理 |
|---|---|
| credential 字符串（匹配 API key / token 模式） | 整条写入拒绝，记录 warn |
| IP 地址 / 内部 hostname | 替换为 `[HOST]` |
| 绝对路径含 $HOME | 替换为 `$HOME/...` |
| 客户名 / 公司名（world promotion 时） | 替换为 `[ENTITY]` 或去标识化 |
| email 地址 | 替换为 `[EMAIL]` |

写前脱敏意味着**存储中无明文敏感信息**，git push 不会泄漏。原始信息在 session transcript 中（不持久化），需要时从 transcript 回溯。

### 10.4 迁移策略

Phase 1 实施从旧 `.pensieve/` 格式到新格式的迁移：

```bash
pi memory migrate [--dry-run]
```

- 识别旧格式条目：无 `schema_version` 或无 `---` 分隔符
- 自动映射：旧 `short-term/` → 条目移入同级目录 + `lifetime.kind: ttl` + `lifetime.expires_at` 
- 缺失 timeline：迁移时生成初始 timeline 行 `- <now> | migrate | migrated from legacy format`
- 迁移结果输出到 `.state/migration-report.md`
- 支持 `--dry-run` 预览
- migration 前自动 git commit 当前状态（可回滚）
- Phase 1 结束后旧格式条目全部迁移完毕，doctor 对旧格式报错（不再只是 warn）

### 10.5 `_index.md` 格式模板

`_index.md` 由 sediment 每次写入后自动重建（gitignored 或 git tracked 由项目决定）。提供人类可读的条目概览：

```markdown
# Project Knowledge Index

> Auto-generated 2026-05-08T14:30:00Z | 12 entries

## By Kind

- **maxims** (2): [永远不关主pane](maxims/never-close-main-pane.md), [prompt走@file](maxims/prefer-at-file-for-long-prompts.md)
- **decisions** (3): [本项目用pnpm](decisions/use-pnpm.md), ...
- **knowledge** (5): [...]
- **staging** (2): [...]

## Recently Updated

- 2026-05-08 | [永远不关主pane](maxims/never-close-main-pane.md) | confidence:7
- 2026-05-07 | [避免长argv prompt](knowledge/avoid-long-argv-prompts.md) | confidence:3
- ...

## Orphans

- [orphan-entry](staging/orphan-entry.md) — no incoming links
```

格式约定：
- 使用 relative markdown links（`[title](relative/path.md)`）
- 条目按 confidence 降序，同 confidence 按 updated 降序
- Orphans 仅列出 staging/ 中零入边的条目

---

## 11. 实现路线图

> ⚠️ **2026-05-11 修订**：下述 Phase 1/2/3 路线图已被 ADR 0014（abrain 重定位）+ ADR 0015（LLM retrieval）+ ADR 0016（sediment LLM curator）绿色路径越过。
>
> **实际 shipped 状态**：
> - Phase 1 及 Phase 2 中的“grep-based memory_search” / “trigram dedupe” / “keyword promotion gates” **未落地也不会落地**。`memory_search` 直接上 LLM retrieval（ADR 0015）；sediment 机械 G2–G13 / readiness / rolling / rate / sampling gates 已删除（ADR 0016）；Lane B/D promotion 本身在 abrain 下失去意义（ADR 0014 §D3）。
> - Phase 3 qmd 集成仍是可选未来 baseline，**不是**`memory_search` 的 fallback path（ADR 0015 D5 明确拒绝 grep degradation）。
> - 项目层 SOT 从 `<project>/.pensieve/` 迁入 `~/.abrain/projects/<id>/`（ADR 0014 §D2）。下文在路径上请按此设口设。
>
> **以下 checklist 保留作为历史设计记录。**

### Phase 1：Project 层 + 格式标准化（MVP）

**验收标准**：
- [ ] Markdown 条目格式标准化（frontmatter schema v1 + compiled truth + `## Timeline`）
- [ ] 10 条 Lint 规则实现（T1-T10）
- [ ] 旧格式迁移工具 `pi memory migrate` 完成，现有 `.pensieve/` 全部迁移
- [ ] `memory_search` grep-based 实现（rg 召回 + per-file tf-idf + title boost；仅 project 层）
- [ ] `memory_get` / `memory_list` 实现
- [ ] `_index.md` 自动生成（sediment 写入后重建）。格式模板见 §10.4.1
- [ ] graph.json 构建脚本 + `memory check-backlinks`（只读报告）
- [ ] Sediment project-only pipeline：extract → sanitize → classify → dedupe（确定性：slug + trigram Jaccard）→ lint → lock → write md → git commit → release → audit
- [ ] Project scope 的 file lock + 错误恢复
- [ ] 最小脱敏：credential/knowledge pattern redact → 写入拒绝（fail-closed）；$HOME 路径替换

**不包含**：World 层、向量搜索、promotion gates、passive nudge、语义 dedupe、daemon REST

**可验证性**：每项验收标准可独立测试。dedupe 算法明确为 word-trigram Jaccard（≥0.7），不需要语义模型。"Sediment pipeline" 缩小为 project-only 子集——不要求实现 world classify 和 world staging。

### Phase 2：World 层接入

- [ ] `~/.abrain/` 目录结构落地，独立 git repo
- [ ] `ABRAIN_ROOT` 环境变量支持，默认 `~/.abrain`
- [ ] Memory Facade 跨 store dispatch + graceful degradation（WorldStore 不存在不报错）
- [ ] `memory_search` 同时检索 project + world
- [ ] Sediment world lane（world 写入路径，决策树 logic）
- [ ] World scope 的 file lock（独立于 project lock）
- [ ] Promotion gate 1-5 基础版（keyword-based：Gate 5 使用 trigram Jaccard ≥0.7 替代语义相似度；Gate 3 仅检查已有 contested 关系不主动搜索反例）
- [ ] 跨机器同步脚本（session 启动 pull，session 结束 push）

### Phase 3：qmd 集成（详见附录 C）

- [ ] QmdBackend 接入 `memory_search` Facade（不暴露独立 qmd 工具给 LLM）
- [ ] BM25 关键词搜索 via CLI 直读 db（`execFile('qmd', ['search', ...])`）
- [ ] 语义搜索 via daemon REST（需 daemon 补 `/search` 端点；或 CLI `qmd vsearch` fallback）
- [ ] Collection 配置从 `.pensieve/config.yml` 读取 + fail-closed
- [ ] Graceful degradation：qmd 不可用 → 自动降级到 GrepBackend
- [ ] Direct qmd tools（`qmd_search`/`qmd_vsearch`）仅暴露给 human debug / TUI，不注册默认 LLM tool list

### Phase 4：派生索引 + Health + 查询反哺

- [ ] qmd 语义搜索接入（via daemon REST 或 CLI vsearch）——若 daemon REST 未就绪则本 phase 中此 item 可延期
- [ ] `memory doctor` 健康评分（5 指标，cron 每周）
- [ ] 查询反哺闭环：sediment 检测本 session 的知识应用 → 追加 `[applied]` timeline 行
- [ ] Trigger phrases + passive nudge 机制
- [ ] Sediment-events.jsonl 可观测性面板

### Phase 5：治理

- [ ] 冲突检测 + contested 状态自动标记
- [ ] graph.json 引用热度参与 search ranking（citationBoost）
- [ ] 安全脱敏完整 pipeline（多模式 redact：首次 attempt redact，仅在无法定位 credential 边界时整条拒绝）
- [ ] Promotion gates 1-5 完善版（LLM judge 模式：Gate 3 LLM 反例搜索、Gate 5 升级语义相似度）——Phase 2 的 gates 为 keyword-based 基础版
- [ ] 审计 dashboard（sediment-events 可视化）

### Phase 6：Session 层（可选探索）

- [ ] Session scratchpad API（内存，零摩擦写入，会话结束蒸发；非持久 schema，不影响 Phase 1-5）
- [ ] Cross-session 分析 pass（每周，寻找未沉淀的重复洞察）

---

## 附录 A：综合架构图

```
┌─────────────────────────────────────────────────────┐
│                    Agent / LLM                       │
│     memory_search()  │  memory_get()                 │
│     memory_list()    │  memory_neighbors()           │
└────────────────────────┬────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Memory Facade     │
              │  路由 · RRF 融合 · 排序 │
              │  Graceful Degrade   │
              │  Backend Provenance │
              └────┬──────────┬─────┘
                   │          │
    ┌──────────────▼──┐  ┌───▼──────────────┐
    │  grep backend   │  │  qmd/vector      │  ← 可选派生索引
    │  (rg + BM25)    │  │  (embedding idx) │
    └──────┬──────────┘  └───┬──────────────┘
           │                 │
    ┌──────▼─────────────────▼──────────────┐
    │           SOURCE OF TRUTH              │
    │  project/   <project>/.pensieve/**     │
    │  world/     ~/.abrain/**               │
    │  (markdown + git, 人类可读, 离线可用)   │
    └────────────────────────────────────────┘

写入路径（仅 sediment）:
  agent_end → extract → sanitize → classify → dedupe
  → lint → lock → write md → git commit → index → unlock → audit
```

---

## 附录 B：T0 分析摘要（按决策组织）

### B.1 决策 1：short-term 的定位

short-term 不作为 scope 第四层。改为 lifetime 属性（kind: permanent | ttl | event | review），GC 为独立 pipeline。与 scope 正交。

### B.2 决策 2+3：gbrain vs markdown + ~/.abrain

12 维度多模型评估：gbrain 在检索质量上占优，但 md+git 在离线可用、版本控制、人类可编辑、零搭建、零锁定、跨机器同步等维度结构性占优。gbrain 的优势可通过派生索引获得。

### B.3 决策 5：Timeline + Graph 的 Markdown 实现

借鉴 gbrain 的 Above/Below the Line 模式：`## Timeline` 作为最后一个 H2，append-only。7 条确定性 lint 规则。Graph 作为 `graph.json` 派生索引（gitignored），从 frontmatter + wikilink 提取边。

### B.4 决策 4：Karpathy LLM Wiki 方法论

核心哲学完全一致（markdown=源真、LLM=编译器）。补齐三个缺口：Lint & Maintain、查询反哺闭环、Index 文件自动生成。qmd 作为 Facade 下可选搜索后端。

### B.5 完备性审查（第五轮 T0）

主要修补：`memory_relate` 移到写工具并补充 `memory_neighbors` 读工具；Sediment 行为规范从黑盒到完整 10 步 pipeline；`memory_search` 算法从"hybrid"到 BM25+向量 RRF 规格；Health Score 从正向覆盖率改为腐烂避免指标；补充错误恢复矩阵、审计日志、迁移策略。

### B.6 最终评审（第八轮 T0，2026-05-07）

**第一轮**（Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro — 一致 CONDITIONAL）：Facade 泄漏、Phase 1 dedupe 空白、Phase 1 范围过宽、kind→目录映射缺失。修订后 PASS。

**第二轮双盲**（同上三模型 — 一致 CONDITIONAL）：暴露更深层问题——slug 解析、citations 归零、git transaction 边界、conf 初始化、BM25 命名、ADR 0012 supersede、Gate 5 时间线矛盾。

核心收敛（两轮综合修订）：
- LLM-facing schema 不暴露 scope/backend/source_path；memory_get 保留 scope（固有属性）
- Slug 生成规则 + memory_get 双 store 并发解析同名 slug
- citations 公式：log(2+citations) 替代 log(1+citations)（不归零）；新增 textScore min-max 归一化
- "BM25" → "关键词搜索（rg + tf-idf）"，BM25 保留给 Phase 3+ qmd
- Git transaction：事务完成标志=md 原子写入（非 git commit）；git commit 降为 best-effort
- Confidence 初始化规则（Phase 1 deterministic fallback）
- Gate 5 Phase 2 使用 trigram Jaccard ≥0.7；Phase 5 升级语义相似度
- Smell 从独立 kind 改为 staging/ + confidence<3 的事实状态
- 附录 A 与 §8.2 pipeline 顺序统一（sanitize 在 classify 前）
- Phase 2/5 promotion gates 区分：Phase 2=keyword-based 基础版，Phase 5=LLM judge 完善版
- _index.md 格式模板（§10.5）
- Timeline action 枚举定义 + T9 lint 仅检测 table 分隔行（不误伤 bullet 的 `|`）
- Staging freshness clamp 到 [0,1]；dead_links 定义明确
- 宣布 Supersedes ADR 0012

---

## 附录 C：qmd 集成方案

> 基于 2026-05-06 第六轮 T0 讨论 + 实际环境验证 + 后续深入分析。
> 参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

### C.1 qmd 概述

qmd（github.com/tobi/qmd, v2.1.0）是一个本地 markdown 搜索引擎，提供三层搜索：

| 命令 | 能力 | 是否需要模型 |
|------|------|------------|
| `qmd search` | BM25 关键词全文搜索 | ❌ 不需要，纯 SQLite FTS |
| `qmd vsearch` | 向量语义搜索 | ✅ 需要 embedding 模型（~300MB） |
| `qmd query` | BM25 + 向量 + LLM rerank 混合搜索 | ✅ 需要 embedding + rerank 模型（~3GB） |

全部本地运行（node-llama-cpp + GGUF 模型），零云依赖。

当前部署为 **单 daemon + 多 collection** 架构：
- 全局索引：`~/.cache/qmd/index.sqlite`（804 文件，3,694 向量已嵌入）
- Collection 定义：`~/.qmd/config/index.yml`
- Daemon HTTP：`http://localhost:8181`（MCP 协议 + `/health` 端点）
- 模型常驻 VRAM，跨请求共享

### C.2 核心洞察：关键词搜索和语义搜索走不同的最优路径

**BM25 关键词搜索不需要模型**——纯 SQLite FTS 查询，任何进程直接读 db 都能在 ~50ms 内完成。

**语义搜索必须加载 embedding 模型**——查询文本 → embedding 向量 → 和 db 中的向量做余弦相似度。模型的冷启动成本是 2-3s（~300MB 模型加载 + 首次推理）。

这意味着：

| 搜索类型 | 最优路径 | 模型在哪 | 冷启动 |
|---------|---------|---------|--------|
| BM25 关键词 | **CLI 直读 db**（`execFile` 调 `qmd search --json`） | 不需要 | 无 |
| 语义搜索 | **Daemon REST**（daemon 已持有模型在 VRAM） | daemon 进程 | 无（永远 warm） |
| 语义搜索（CLI 路径） | CLI 自加载模型 | CLI 进程（每次启动） | 每次 2-3s ❌ |
| 语义搜索（SDK 路径） | pi 进程内加载模型 | pi 进程 | 首次 2-3s，后续 warm ⚠️ 但和 daemon 重复加载 |

**结论**：
- **BM25** → CLI 直读 db。已验证可行，~50ms，零依赖。不需要 daemon。
- **语义搜索** → daemon 已经有模型在 VRAM 里。pi extension 通过 daemon 的 REST 端点调用（~100ms）。让 pi 自己再加载一份模型是浪费。
- daemon 当前只暴露 MCP 协议——需要补一个 **薄 REST 端点**（`POST /search`、`POST /query`）。这不是架构问题，是 qmd daemon 缺一个 pi-friendly 接口。

### C.3 语义搜索"直读 db"的局限性

语义搜索的流程：查询文本 → embedding 模型 → 向量 → 和 db 中预嵌入的向量做余弦相似度。

db 中的向量是预先嵌入好的（存储成本为 0），但**查询时必须把查询文本也转成向量**——这一步绕不开 embedding 模型。CLI 直读 db 做语义搜索：每次启动 CLI 进程都要重新加载模型（2-3s），而 daemon REST 路径下模型永远 warm（~100ms）。

这就是"直读 db"在语义搜索场景下的局限——db 可以直读，但向量化查询文本的那一步离不开模型。

**附加问题**：当前 daemon 的索引是用旧版 embedding 模型（1024-dim）构建的，CLI v2.1.0 自带新版模型（768-dim），维度不匹配导致 CLI 的 `qmd vsearch` 直接报错。这是 qmd 版本升级导致的配置不一致——daemon 和 CLI 需要统一 embedding 模型版本。与架构无关。

### C.4 MCP 与 pi 设计哲学的冲突

pi 使用 TypeScript extension 工具体系：工具在 `activate()` 中注册，在 pi 进程内执行，拥有 `signal`/`onUpdate`/`ctx` 的完整控制。

MCP（Model Context Protocol）存在的真实原因是 **Claude Code 是短会话进程**——需要一个独立 daemon 保持模型常驻。pi 本身就是长生命周期 TUI 进程，不需要这层脚手架。引入 MCP 等于在不需要它的平台上加 JSON-RPC + HTTP + MCP session 三层额外开销。

**但 daemon 本身是有价值的**——它让 embedding 模型常驻 VRAM，被所有消费者共享。pi 不走 MCP 调它，而是通过 REST 调它的搜索能力：

```
  ┌─ pi (TUI 进程) ─────────────────────────────┐
  │  pi-qmd extension                           │
  │    ├─ BM25: execFile('qmd', ['search'...])  │ ← 直读 db，不需要 daemon
  │    └─ 语义: fetch('localhost:8181/search')  │ ← 调 daemon，模型 warm
  └──────────────────────────────────────────────┘

  ┌─ qmd daemon（独立进程）──────────────────────┐
  │  模型常驻 VRAM                              │
  │  POST /mcp      ← Claude Code               │
  │  POST /search    ← pi（需补充）               │
  │  POST /query     ← pi（需补充）               │
  │  GET  /health    ← pi health check           │
  └──────────────────────────────────────────────┘
```

### C.5 Collection 路由

```yaml
# <project>/.pensieve/config.yml
qmd:
  collections:
    - "pi-pensieve"
    - "pi-knowledge"
  world_collections:
    - "global-knowledge"
  daemon_endpoint: "http://localhost:8181"
```

解析优先级：`.pensieve/config.yml` → `settings.json` → 环境变量 → `~/.qmd/config/index.yml`（仅校验）→ FAIL CLOSED。

### C.6 与 `memory_search` Facade 的集成

qmd 作为 Facade 下 QmdBackend，不暴露独立工具给 LLM：

- BM25 查询 → `execFile('qmd', ['search', query, '--json'])`（直读 db）
- 语义查询 → `fetch(`${daemon}/search`, ...)`（调 daemon，模型 warm）
- Daemon 不可用 → graceful degradation 到 GrepBackend
- 结果标注 `backend: 'qmd'`，含 score/source_path

### C.7 pi-qmd 现有扩展

`github.com/hjanuschka/pi-qmd`：TypeScript pi extension，用 CLI（`execFile`），不用 MCP、不用 SDK。注册了 `qmd_search`/`qmd_vsearch`/`qmd_query`/`qmd_get`/`qmd_multi_get`/`qmd_status` 6 个工具 + TUI browser。可改造为 Facade backend 模式。

### C.8 实施路线

```
Phase 1（立即可做）: BM25 via CLI 直读 db
  - execFile 调 qmd search --json
  - QMD_CONFIG_DIR + INDEX_PATH 指向 daemon 索引
  - ~50ms/query，零依赖，已验证

Phase 2（需 daemon 补 REST）: 语义搜索 via daemon
  - daemon 加 POST /search + POST /query 端点
  - pi extension 通过 fetch() 调 daemon
  - 模型永远 warm，语义搜索 ~100ms

Phase 3: memory_search Facade 统一
  - QmdBackend + GrepBackend 并行，RRF 融合
  - 自动降级 + collection 路由 fail-closed
```
