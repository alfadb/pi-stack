# Pi 知识管理架构设计

> 基于 2026-05-06 用户原始架构想法，通过五轮 T0 深度讨论 + 完备性审查 + qmd 集成方案逐步细化而成。
> 讨论与审查参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

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

---

## 2. 用户的关键设计决策（2026-05-06，四轮讨论）

**决策 1**：short-term 不作为 scope 层，作为任意持久层上的 **lifetime 属性**（ttl / expires_at / expire_on）。

**决策 2**：暂时不上 gbrain。统一用 **markdown + git** 作为 source of truth。但借鉴 gbrain 的 timeline 和图谱方法论（决策 5）。

**决策 3**：`~/.abrain/` 作为世界级知识的独立 git 仓库（private），`ABRAIN_ROOT` 环境变量引用。与 `.pensieve/` 边界：pensieve=项目特定，abrain=跨项目通用。

**决策 4**：参考 Karpathy LLM Wiki 方法论，补齐 **Lint & Maintain** 阶段、**查询反哺闭环**、**Index 文件自动生成**。qmd 作为可选本地搜索后端。向量索引降为可选加速层。

**决策 5**：借鉴 gbrain 方法论，在纯 markdown 层面实现 **Compiled Truth + Timeline 双段格式**、**7 条确定性 Lint 规则**、**Graph 派生 JSON 索引**、**Brain Health 评分**。

---

## 3. 核心架构原则

1. **读写分离**：只有 sediment sidecar 可以写持久知识（markdown 文件、frontmatter、graph.json）。主 session、dispatch 子进程只能读。
2. **读接口统一，结果保留 provenance**：LLM 工具不区分 project/world（分配置），但返回的每条结果必须带 `scope`、`source`、`backend` 标注——统一是 rank 层的责任，不是 LLM 的认知负担。
3. **写入显式 scoped**：只有 sidecar 的写工具区分项目/世界。
4. **Scope × Lifetime 正交**：适用范围和失效时间是独立维度，不在目录结构中混叠。
5. **Markdown 为唯一 source of truth**：索引是 view，文本是 table。索引 gitignored，可随时从 md 重建。
6. **Facade 模式隔离**：LLM 只看到统一的读接口，底层存储和索引拓扑变更不影响上层。
7. **默认永久，显式临时**：大多数知识无过期时间。只有实验性的条目显式声明 ttl。
8. **Graceful degradation**：索引不可用时降级到 ripgrep 关键词搜索，结果标注 `degraded: true`。系统不失效。
9. **核心接口必须完备，边缘功能渐进迭代**：数据模型、写入安全、读接口契约不能有空白。性能优化、高级治理可以按 Phase 迭代。

---

## 4. 知识模型

### 4.1 三层 Scope（MVP 为 Project + World，Session 为可选层）

| 层 | 生命周期 | 存储位置 | 写入者 | MVP |
|---|---|---|---|---|
| **Session** | 当前会话，结束即蒸发 | 内存 scratchpad | 主 agent（零摩擦） | Phase 5 |
| **Project** | 项目存活期 | `<project>/.pensieve/`（md + git） | sediment sidecar | ✅ Phase 1 |
| **World** | 跨项目持久 | `~/.abrain/`（md + git） | sediment sidecar（with gates） | ✅ Phase 2 |

Session scope 只能有 `lifetime: session`（write-path validator 强制约束），不可 promote 到 project/world。Session 是 scope 轴上的合法值，但 MVP 不做持久化。

### 4.2 正交属性

```yaml
# 知识条目的核心元数据
scope: project | world                  # MVP；Phase 5 加 session
kind: maxim | decision | anti-pattern | pattern | fact | preference | smell
status: provisional | active | contested | deprecated | superseded | archived
confidence: 0-10                        # 0-2=staging smell, 3-5=provisional, 6-7=active, 8-10=high-certainty

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
- search ranking 中 confidence 作为加权因子（`* (confidence/10)`）。

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
| timeline | `## Timeline` 之后的 append-only 日志 | 只能追加 | ❌ 默认不参与 search，仅 audit/memory_get 时返回 |

**关键规则**：
- `## Timeline` 是最后一个 H2，之后只允许 `- YYYY-MM-DD | ...` 格式的 bullet 行
- `updated` 只反映 compiled_truth 编辑时间；timeline 追加不影响 `updated`
- Timeline 内禁止 heading、code fence、table、嵌套 list
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

### 4.6 默会知识管道

```
smell (staging, confidence<5) → pattern (project, 5-7) → maxim (world, 8-10)
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
    ├── maxims/                           └── fulltext.db (optional)
    ├── decisions/
    ├── knowledge/                      ~/.abrain/.state/index/
    ├── staging/                          ├── graph.json
    ├── archive/                          └── fulltext.db (optional)
    ├── raw/
    ├── _index.md                       .pensieve/.state/
    └── schemas/relations.yaml            ├── health-report.md
                                          ├── lint-report.md
world/                                    ├── sediment-events.jsonl
  ~/.abrain/                              └── locks/
    ├── maxims/
    ├── patterns/                       ~/.abrain/.state/
    ├── anti-patterns/                    ├── health-report.md
    ├── facts/                            ├── lint-report.md
    ├── staging/                          ├── sediment-events.jsonl
    ├── archive/                          └── locks/
    ├── raw/
    ├── _index.md
    └── schemas/relations.yaml
```

### 5.3 `memory_search` 算法规格

**hybrid = BM25 关键词 + (可选) qmd 向量语义，RRF 融合，grep fallback。**

> qmd 作为 Facade 的 QmdBackend 接入。完整集成方案见附录 C。

```
memory_search(query):
  1. 并发查询 ProjectStore + WorldStore
  2. 每个 store:
     a. 如果向量索引可用 → 向量语义搜索（top-50）
     b. 始终运行 BM25 关键词搜索（ripgrep + 简单 tf-idf）
     c. RRF 融合 a + b（向量不可用时仅 BM25）
  3. Facade 合并两 store 结果：
     a. 统一格式：{ slug, title, summary, score, scope, kind, status, confidence, backend, degraded? }
     b. 排序：textScore × projectBoost(项目级当前project加权1.5) × log(1+citations) × (confidence/10)
     c. 过滤：默认排除 status=archived
     d. 截断：top-20
  4. 返回结果始终标注 backend 来源（'rg' | 'vector'），但按统一 ranking 排序
```

每个结果格式：

```json
{
  "slug": "world:avoid-long-argv-prompts",
  "title": "Avoid Long argv Prompts",
  "summary": "传给子进程的 prompt 应通过 @file 传递...",
  "score": 0.87,
  "scope": "world",
  "kind": "pattern",
  "status": "active",
  "confidence": 8,
  "backend": "rg",
  "degraded": false,
  "source_path": "~/.abrain/patterns/avoid-long-argv-prompts.md",
  "related_slugs": ["world:use-at-file-input"]
}
```

**LLM 不直接看到 `scope`（按 §3.2 原则不要求 LLM 判断 scope），但 scope 字段存在——用于 ranking 层的 project boost 和 Facade 路由。**

### 5.4 Facade 模式

```
                        LLM Tools
                  memory_search | memory_get | memory_list | memory_neighbors
                              │
                        Memory Facade
                    (路由、归并、RRF 融合、排序、degrade)
                     /                    \
            ProjectStore               WorldStore
    (rg + optional qmd/vector)    (rg + optional qmd/vector)
    ── <project>/.pensieve/       ── ~/.abrain/ (ABRAIN_ROOT)
```

- 不统一 `KnowledgeStorage` interface（不同后端的 grep vs vector 能力曲线不同）
- Facade 负责超时（单 store 3s timeout）、partial result（一个 store 超时另一个仍返回，标注 degraded）、backend 标注
- ABRAIN_ROOT 未设置或 ~/.abrain 不存在时 → WorldStore 空结果，degraded 标注，不报错

### 5.5 ~/.abrain 设计（决策 3）

独立 git 仓库（private），`ABRAIN_ROOT` 环境变量引用（默认 `~/.abrain`）。

| 时机 | 动作 |
|---|---|
| 机器启动 / session 开始 | `git pull --rebase --autostash` |
| sediment 写完一条 | `git add . && git commit -m "abrain: <slug>"`（不 auto push） |
| 会话结束 | 安全脚本：`pull --rebase --autostash && push` |
| 冲突 | 不自动解决，pending 等人工 |

### 5.6 Graph 派生索引（决策 5）

`graph.json` 从 markdown 确定性构建（post-commit hook 增量重建，缺失时当场 grep）：

```json
{
  "built_at": "...", "git_head": "abc123",
  "nodes": { "<slug>": { "scope": "...", "kind": "...", "status": "...", "title": "..." } },
  "edges": [
    { "from": "a", "to": "b", "type": "relates_to", "source": "frontmatter" }
  ],
  "stats": { "node_count": 320, "edge_count": 614, "orphans": [...], "dead_links": [...] }
}
```

CLI 命令（全部只读，写操作由 sediment 代理）：

```bash
pi memory check-backlinks       # 反向链接完整性（仅 symmetric 类型），只报告不修改
pi memory graph <slug> -d 2     # 图遍历（返回缩进边树）
pi memory neighbors <slug>      # 1 跳邻居，供 memory_get include_related 使用
pi memory doctor                # 健康评分
```

---

## 6. Memory 工具接口

### 6.1 读工具（主 session + dispatch 子进程可调用）

```
memory_search(query: string, filters?: { kinds?, status?, limit? })
  → SearchResult[] { slug, title, summary, score, scope, kind, status,
                     confidence, backend, degraded?, source_path, related_slugs }
  // 默认搜索当前 project + world；scope/kinds 过滤为可选参数

memory_get(slug: string, options?: { include_related?: boolean })
  → KnowledgeEntry { ...full entry including timeline }

memory_list(filters: { scope?, kind?, status?, limit?, cursor? })
  → { entries: EntryMeta[], next_cursor? }
  // 分页浏览，主要用于人工调试

memory_neighbors(slug: string, options?: { hop?: number, max?: number })
  → { slug, title, kind, edge_type }[]
  // 只读图遍历，不写任何关系（替代原名 memory_relate 的读语义）
```

### 6.2 写工具（仅 sediment sidecar 可见）

```
memory_write(entry, destination: 'project' | 'world')
  → { slug, status: 'created' | 'merged' | 'rejected', reason? }

memory_update(slug, patch: Partial<KnowledgeEntry>)
  → void

memory_deprecate(slug, reason, superseded_by?)
  → void

memory_promote(slug, target_scope: 'world')
  → { slug, promoted: boolean, gates_passed: string[] }

memory_relate(from_slug: string, to_slug: string, relation: string)
  → void
  // 声明关系并写入 frontmatter（写操作，仅 sediment）
```

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
extract: 从 transcript 识别潜在洞察（LLM prompt: "本轮对话中有无值得持久化的知识？"）
  ↓
classify: 为每个候选判定 scope(project/world) + kind + confidence
  ↓
dedupe: memory_search 查询已有条目，计算语义相似度
  ↓
  ├─ 相似度 > 0.85 → merge：更新已有条目 compiled_truth + 追加 timeline
  └─ 相似度 < 0.85 → create：写入新条目
  ↓
sanitize: 过 redactor（credential/IP/路径脱敏）
  ↓
lint: 内存中校验 frontmatter schema + timeline 格式
  ↓
acquire lock: 获取对应 scope 的 file lock（`.state/locks/sediment.lock`）
  ↓
write: 原子写入 markdown 文件（先写 tmp，再 rename）
  ↓
git: git add + git commit（不 auto push）
  ↓
index: 增量更新 graph.json（新增/修改的条目）
  ↓
release lock
  ↓
audit: 追加 sediment-events.jsonl
```

**写入决策树（project vs world）**：

```
新洞察 P：

P 引用了具体文件路径 / 模块名 / API 名？
├─ 是 → scope: project
└─ 否 → P 在 ≥2 个不同领域的 project 中出现过？
        ├─ 是 → scope: world（直接写 maxims/patterns/anti-patterns）
        └─ 否 → scope: world, status: provisional, 写入 staging/
```

**Transaction 边界**：每个条目一次 git commit。多个条目可合并 commit。写入先写 tmp 文件再 rename（原子操作）。graph.json 写入也先 tmp 再 rename。任何步骤失败 → 回滚 markdown 写入（删除 tmp），不提交 git，不更新 graph.json。

### 8.3 错误处理与恢复

| 场景 | 行为 |
|---|---|
| Markdown 解析失败 | 记录 `sediment-events.jsonl`，跳过该条目，不阻断其他条目 |
| Git 仓库不存在 | 跳过 git 操作，仅写 markdown + graph.json |
| Git push 冲突 | 保留本地 commit，标记 pending，不下次写入前先 pull --rebase |
| Lock 获取超时（>5s） | 退化为只读 + 入队 pending queue（`.state/locks/pending.jsonl`），下次 session 重试 |
| 磁盘满 / 权限错误 | 记录错误到 sediment-events.jsonl，通知主 session（ui.notify） |
| 写入中途崩溃 | tmp 文件残留，下次启动时清理 `.tmp-*` 文件；graph.json 从 markdown 全量重建 |
| ABRAIN_ROOT 未设置 | WorldStore 空返回；写入 world 的 attempt 自动转为 project staging |
| `.index/` 与 markdown 不一致 | 查询时检测 `git_head` ≠ HEAD → lazy rebuild，结果标注 `degraded: false`（已自动新鲜） |
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
  → sediment 重写 compiled_truth，去掉项目名、路径、技术栈
  → 存储：检出条目的 compiled_truth 副本，对照 schemas/decontextualized-check.md 规则
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
  → memory_search 查询已有 world 条目，语义相似度 > 0.7 的逐一比对
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

**7 条 Lint 规则（T1-T7）**：

| 规则 | 检测内容 | 严重度 |
|------|---------|--------|
| T1 `timeline-heading-present` | 条目文件必须包含 `## Timeline` 且为最后一个 H2 | ERROR |
| T2 `timeline-heading-unique` | 文件中恰好一个 `## Timeline` | ERROR |
| T3 `no-headings-in-timeline` | Timeline 之后不能有 `#`/`##`/`###` | ERROR |
| T4 `timeline-bullet-format` | Timeline 每行必须是 `- YYYY-MM-DD \| ...` 格式 | WARNING |
| T5 `timeline-chronological` | Timeline 条目按日期升序 | WARNING |
| T6 `timeline-not-empty` | Timeline 至少一行记录 | WARNING |
| T7 `frontmatter-required` | 必须有 `id`/`scope`/`kind`/`created`/`schema_version` | ERROR |

### 10.2 Health 评分（避免腐烂，不追完备）

与 §4.6 "拒绝完备性" 对齐——评分衡量**避免腐烂**，不衡量**正向覆盖率**：

| 指标 | 权重 | 算法 |
|------|------|------|
| `dead_link_rate` | 30% | 1 - 死链数/max(总链接数, 1) |
| `orphan_rate` | 25% | 1 - 零链节点数/总节点数 |
| `staging_freshness` | 20% | 1 - p90(staging age)/90d |
| `conflict_rate` | 15% | 1 - contested条目数/总条目数 |
| `schema_validity` | 10% | lint 通过的条目数/总条目数 |

**不包含** timeline_coverage（避免逼着补全旧条目）和 link_density（避免滥加链接）。

CI gate：`dead_link_rate < 1.0` → fail（不允许死链）。其余指标只 warn，不阻塞。

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

---

## 11. 实现路线图

### Phase 1：Project 层 + 格式标准化（MVP）

**验收标准**：
- [ ] Markdown 条目格式标准化（frontmatter schema v1 + compiled truth + `## Timeline`）
- [ ] 7 条 Lint 规则实现（T1-T7），CI pre-commit hook 集成
- [ ] 旧格式迁移工具 `pi memory migrate` 完成，现有 `.pensieve/` 全部迁移
- [ ] `memory_search` grep-based 实现（keyword + BM25，无向量；仅 project 层）
- [ ] `memory_get` / `memory_list` 实现
- [ ] `_index.md` 自动生成（sediment 写入后）
- [ ] graph.json 构建脚本 + `memory check-backlinks`（只读报告）
- [ ] Sediment 行为规范完整实现（§8.2 全部步骤）
- [ ] Project scope 的 file lock + 错误恢复

**不包含**：World 层、向量搜索、promotion gates、passive nudge

### Phase 2：World 层接入

- [ ] `~/.abrain/` 目录结构落地，独立 git repo
- [ ] `ABRAIN_ROOT` 环境变量支持，默认 `~/.abrain`
- [ ] Memory Facade 跨 store dispatch + graceful degradation（WorldStore 不存在不报错）
- [ ] `memory_search` 同时检索 project + world
- [ ] Sediment world lane（world 写入路径，决策树 logic）
- [ ] World scope 的 file lock（独立于 project lock）
- [ ] Promotion gate 1-5 实现（LLM judge 模式）
- [ ] 跨机器同步脚本（session 启动 pull，session 结束 push）

### Phase 3：qmd 集成（详见附录 C）

- [ ] pi-qmd extension：设置 `QMD_CONFIG_DIR`/`INDEX_PATH` 指向 daemon 索引
- [ ] `qmd_search`/`qmd_vsearch` CLI 工具实现（execFile + --json）
- [ ] Collection 配置从 `.pensieve/config.yml` 读取 + fail-closed
- [ ] `memory_search` Facade 集成 QmdBackend（与 GrepBackend 并行，RRF 融合）
- [ ] Graceful degradation：qmd 不可用 → grep fallback
- [ ] 保留 `/qmd_ui` TUI browser

### Phase 4：派生索引 + Health + 查询反哺

- [ ] `memory doctor` 健康评分（5 指标，cron 每周）
- [ ] 查询反哺闭环：sediment 检测本 session 的知识应用 → 追加 `[applied]` timeline 行
- [ ] Trigger phrases + passive nudge 机制
- [ ] Sediment-events.jsonl 可观测性面板

### Phase 5：治理

- [ ] 冲突检测 + contested 状态自动标记
- [ ] graph.json 引用热度参与 search ranking
- [ ] 安全脱敏完整 pipeline（写前脱敏，多模式 redact）
- [ ] 审计 dashboard（sediment-events 可视化）

### Phase 6：Session 层（可选）

- [ ] Session scratchpad API（零摩擦写入，会话结束蒸发）
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
  agent_end → extract → classify → dedupe → sanitize
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

---

## 附录 C：qmd 集成方案

> 基于 2026-05-06 第六轮 T0 讨论 + 实际环境验证。参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

### C.1 背景：qmd 的当前部署

qmd（github.com/tobi/qmd）是一个本地 markdown 搜索引擎，提供 **BM25 全文搜索 + 向量语义搜索 + LLM 重排序**，全部本地运行（node-llama-cpp + GGUF 模型，零云依赖）。

当前部署为 **单 daemon + 多 collection** 架构（基于 `2026-04-21` 的架构决策），部署在 `~/.qmd/` 下：

```
~/.qmd/config/index.yml          # 全局 collection 定义
~/.cache/qmd/index.sqlite         # 全局索引
~/.cache/qmd/mcp.pid              # daemon PID
```

```yaml
# ~/.qmd/config/index.yml（示例）
collections:
  claude-knowledge:
    path: /home/worker/.claude/.pensieve/knowledge
    pattern: "**/*.md"
  sub2api-pensieve:
    path: /home/worker/work/base/sub2api/.pensieve
    pattern: "**/*.md"
  # ... 每项目 1-N 个 collection
```

**当前状态**（2026-05-06 实测）：
- daemon 运行中，804 个文件已索引，3,694 个向量已嵌入
- 模型常驻 VRAM 跨请求共享
- MCP HTTP 端点：`http://localhost:8181/mcp`（供 Claude Code 等 MCP 客户端使用）
- daemon 通过 `qmd mcp --http --daemon --port 8181` 启动

### C.2 核心决策：pi 不用 MCP，用 CLI + 共享索引

#### C.2.1 MCP 与 pi 设计哲学的冲突

pi 使用 **TypeScript extension 工具体系**：
- 工具在 `activate()` 中通过 `pi.registerTool()` 注册
- 工具函数在 pi 进程内执行
- 拥有 `signal`（abort）、`onUpdate`（流式）、`ctx`（UI/事件）的完整控制

MCP（Model Context Protocol）是外部工具服务器协议：
- MCP 存在的真实原因是 Claude Code 等客户端是**短会话进程**——需要一个独立 daemon 保持模型常驻 VRAM
- pi 本身就是**长生命周期 TUI 进程**，天然扮演 daemon 角色
- 引入 MCP 层等于引入 Claude Code 的脚手架到不需要它的平台：JSON-RPC 序列化、HTTP roundtrip、MCP session 握手——全部是多余开销

#### C.2.2 CLI + 共享索引：已验证可行

**关键发现**（实际环境验证）：qmd CLI 可以通过环境变量直接使用 daemon 的索引：

```bash
# ✅ 已验证：CLI 读 daemon 索引进行向量搜索
QMD_CONFIG_DIR=~/.qmd/config INDEX_PATH=~/.qmd/index.sqlite \
  qmd vsearch "knowledge management" --json -n 3
# → 返回 3694 个向量的语义搜索结果

# ✅ 已验证：BM25 关键词搜索 + collection 过滤
QMD_CONFIG_DIR=~/.qmd/config INDEX_PATH=~/.qmd/index.sqlite \
  qmd search "memory architecture" --json -c "claude-knowledge"

# ✅ 已验证：索引状态
QMD_CONFIG_DIR=~/.qmd/config INDEX_PATH=~/.qmd/index.sqlite qmd status
# → 804 files indexed, 3694 vectors embedded
```

**这意味着**：pi 集成 qmd 不需要通过 MCP、不需要 SDK、不需要重新 embed。CLI 直接操作 daemon 的 sqlite 索引文件即可。

#### C.2.3 三种集成路径的系统评估

| 维度 | CLI subprocess | SDK (`@tobilu/qmd`) | MCP HTTP |
|------|---------------|---------------------|----------|
| **pi-native 程度** | 🟡 需要 `execFile` + stdout 解析 | 🟢 TypeScript 函数调用（但 ESM-only，CJS 兼容性障碍） | 🔴 引入外部协议栈 |
| **daemon 共享 VRAM** | 🟢 读 daemon 的索引文件，不加载模型 | 🔴 每个 pi 进程各自加载模型（~4.3GB VRAM 重复） | 🟢 共享（但需 MCP） |
| **实现复杂度** | 🟢 约 50 行（已有 pi-qmd 1400 行参考） | 🟡 ESM/CJS 兼容 + 原生依赖 | 🔴 JSON-RPC + session 管理 |
| **延迟** | BM25: ~50ms；向量: ~500ms（读索引，无模型加载） | warm: ~50ms | +HTTP+MCP overhead |
| **abort 支持** | 🟡 SIGKILL 杀进程 | 🟢 原生 `signal` 穿透 | 🟡 connection close |
| **error 处理** | 🟡 解析 stderr / exit code | 🟢 原生 exception | 🟡 字符串化 RPC error |
| **当前可用性** | 🟢 已验证 | 🔴 ESM/CJS 导入失败 | 🟢 daemon 运行中 |

**最终决策**：**Phase 1 使用 CLI + 共享索引**。这是唯一已验证可行且符合 pi 设计哲学的路径。

#### C.2.4 Daemon 的角色

qmd daemon **保留**，继续服务：
- Claude Code（如果仍在使用）
- 终端 ad-hoc 查询：`qmd search "something"`
- 其他 MCP 客户端

pi **不依赖 daemon**。pi 的 qmd 扩展通过 CLI 直接读 sqlite 索引文件。daemon 挂掉不影响 pi 的 qmd 搜索能力。

```
  ┌─ pi (TUI 进程) ────────────────────────────┐
  │  pi-qmd extension                          │
  │    └── execFile('qmd', ['search', ...])    │
  │          ↓ (env: QMD_CONFIG_DIR, INDEX_PATH)│
  │     ~/.cache/qmd/index.sqlite (直接读)      │
  └─────────────────────────────────────────────┘

  ┌─ qmd daemon (可选，独立进程) ──────────────┐
  │  模型常驻 VRAM，服务 MCP 客户端             │
  │  Claude Code / ad-hoc CLI 等               │
  └─────────────────────────────────────────────┘
```

### C.3 Collection 路由方案

**核心原则**：collection 映射是项目知识边界配置，属于项目级配置，不是 pi UI 设置。

#### C.3.1 配置位置

```yaml
# <project>/.pensieve/config.yml（新增 qmd 节）
qmd:
  collections:
    - "pi-pensieve"          # 当前 project 的 pensieve
    - "pi-knowledge"         # 当前 project 的 knowledge
  world_collections:         # 跨项目 world 知识
    - "global-knowledge"
  mode: "cli"                # cli | daemon-rest（未来）
```

#### C.3.2 解析优先级

```
1. 显式参数 / 调试 override（QMD_COLLECTIONS 环境变量）
2. <project>/.pensieve/config.yml 的 qmd.collections（主路径）
3. ~/.pi/agent/settings.json 的 qmd.defaultCollections（全局默认）
4. ~/.qmd/config/index.yml（仅做存在性校验，不用于自动推断）
5. 未解析出任何 collection → FAIL CLOSED（不默认搜全部）
```

**Fail-closed 是关键安全措施**：默认搜全部 collection 会把其他项目的知识注入当前 agent 上下文，造成 scope 污染。

### C.4 与 `memory_search` Facade 的集成

**结论**：qmd 作为 `memory_search` Facade 下的一个 backend，不单独暴露 `qmd_search` 工具给 LLM。

```
                    LLM Tools
              memory_search | memory_get
                         │
                    Memory Facade
                 (路由 · RRF 融合 · degrade)
              /          |           \
     QmdBackend    GbrainBackend   GrepBackend
   (CLI+共享索引)   (可选,未来)    (ripgrep fallback)
```

每个 backend 声明 `capabilities`：

```typescript
interface BackendCapabilities {
  keywordSearch: boolean;     // BM25 / grep
  semanticSearch: boolean;    // 向量相似度
  hybridSearch: boolean;      // BM25 + 向量 + rerank
  graphTraversal: boolean;    // 图遍历（仅 gbrain）
  listByKind: boolean;        // 按 kind 过滤
}
```

Facade 按 capability 路由：
- 关键词查询 → QmdBackend + GrepBackend（双路并发）
- 语义查询 → QmdBackend（qmd vector search）
- QmdBackend 不可用 → 自动降级到 GrepBackend
- 每条结果标注 `backend` 字段（`'qmd' | 'gbrain' | 'rg'`）

**不暴露独立 `qmd_search` 工具**：LLM 不应该判断"该用 grep 还是 qmd 还是 gbrain"——那是 Facade 的路由职责。LLM 只调 `memory_search`。

### C.5 pi-qmd 现有扩展分析

**已确认**（GPT-5.5 检查了 `github.com/hjanuschka/pi-qmd` 源码）：

- ✅ 是 pi extension（TypeScript），**不是 MCP client**
- ✅ 使用 CLI 路径：`execFile('qmd', [...])`
- ✅ 注册了 6 个工具：`qmd_search` / `qmd_vsearch` / `qmd_query` / `qmd_get` / `qmd_multi_get` / `qmd_status`
- ✅ 有 TUI browser（`/qmd_ui`）
- ⚠️ `execute` 参数签名可能需要适配当前 pi 版本
- ❌ 没有 `@modelcontextprotocol/sdk` 依赖
- ❌ 没有 `@tobilu/qmd` SDK 依赖

**改造方向**（不 fork，直接扩展或上游 PR）：

1. 修正所有 tool `execute` signature 为当前 pi 约定
2. 将 6 个独立工具包装在 `memory_search` Facade 后（`qmd_search` 等保留为 debug config flag）
3. 从 `.pensieve/config.yml` 读取 collection 配置（替代当前的手工 collection 参数）
4. 设置 `QMD_CONFIG_DIR` / `INDEX_PATH` 环境变量指向 daemon 的索引
5. 保留 `/qmd_ui` TUI browser（这是 pi-qmd 相比裸 qmd 的核心增值）

### C.6 实施路线

```
Phase 1（当前）: CLI + 共享索引
  - pi-qmd extension 设置 QMD_CONFIG_DIR=~/.qmd/config INDEX_PATH=~/.qmd/index.sqlite
  - qmd_search 通过 execFile('qmd', ['search', query, '--json', '-c', collection]) 实现
  - qmd_vsearch 同上
  - collection 配置从 .pensieve/config.yml 读取
  - daemon 保留，pi 不依赖

Phase 2（未来）: memory_search Facade 集成
  - qmd 作为 Facade 的 QmdBackend
  - 与 GrepBackend 并行查询，RRF 融合
  - graceful degradation：qmd 不可用 → 自动降级到 grep

Phase 3（如果 daemon 加了 REST endpoint）: daemon REST backend
  - pi extension 用 fetch() 调 daemon 的 /search /query 端点
  - 模型 warm，延迟最低
  - 保留 CLI fallback
```
