# Pi 知识管理架构设计

> 基于 2026-05-06 用户原始架构想法 + 两轮 T0 深度讨论综合而成。
> 参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

---

## 1. 原始起因：用户的 9 点框架性想法（2026-05-06）

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

## 2. 用户补充追问（2026-05-06）

在第一轮讨论后，用户针对三个关键设计决策点提出进一步追问：

**追问 A：short-term 概念是否还有用？**
> 在旧的 pensieve 体系中有一个"short-term"分类。在新架构中，Session 层已覆盖会话内临时知识，但"跨 session 但仍为临时"的知识（如分支临时决策）和"世界级暂存"（如未经验证的洞察）是否需要 short-term？如果需要，它应该是 scope 的一层还是任意层的属性？

**追问 B：gbrain 是否真的有必要？**
> 从检索质量、版本控制、离线可用、人类可编辑、搭建复杂度、维护负担、跨机器同步、扩展性、成本、锁定风险、AI 原生特性、多项目联邦、与 project 层同构性等多个维度，全面评估 gbrain 与纯 markdown 存储的优劣。是否存在"md 做主存储 + 自动构建向量索引"的混合方案？

**追问 C：~/.abrain 是否可行？**
> 如果世界级也用 markdown + git 存储，放在 `~/.abrain/` 作为独立版本化仓库。分析这个方案是否合理，以及它与 `~/.pi/.pensieve/` 的功能边界、引用机制、多机器同步策略。

---

## 3. 核心架构原则

从用户原始想法和两轮 T0 讨论中提炼的核心原则：

1. **读写分离**：只有 sediment sidecar 可以写持久知识。主 session、dispatch 子进程、所有其他 LLM 调用路径只能读。
2. **读接口统一**：对 LLM 暴露的查询工具不区分项目级/世界级——区分是噪音。
3. **写入显式 scoped**：只有 sidecar 的写入工具需要区分目标层级。
4. **Scope × Lifetime 正交**：知识的适用范围（scope）和失效时间（lifetime）是两个独立维度，不应折叠。
5. **Markdown 为唯一源真（source of truth）**：所有知识以 markdown + git 存储。向量索引、图索引为可重建的派生制品——索引是 view，文本是 table。
6. **Facade 模式隔离**：LLM 只看到统一的 Memory Facade，底层存储拓扑变更不影响上层。
7. **默认永久，显式临时**：大部分知识无过期时间。只有真正临时的条目显式声明 lifetime。
8. **Graceful degradation**：派生索引不可用时（离线、损坏、未构建），系统降级到 grep，不失效。
9. **拒绝完备性**：默会知识入库的永远是投影，不是本体。staging 区容纳未经验证的洞察，不强行要求 clean rule。

---

## 4. 知识模型

### 4.1 三层 Scope

| 层 | 生命周期 | 存储位置 | 写入者 | 示例 |
|---|---|---|---|---|
| **Session** | 当前会话 | 内存 scratchpad | 主 agent（零摩擦） | "已验证 foo.ts 调用链安全，别再查"、"B 方案已排除" |
| **Project** | 项目存活期 | `<project>/.pensieve/`（md + git） | sediment sidecar | 架构决策、模块边界、测试规范、部署约束 |
| **World** | 跨项目持久 | `~/.abrain/`（md + git） | sediment sidecar（with promotion gates） | dispatch 并行陷阱、tmux 主 pane 不关、argv/@file 选择 |

**不需要的层级**：团队/组织层（当前单用户架构不需要身份模型。如有需要，通过 git 共享 `.pensieve/` 即可）。

### 4.2 正交属性：Scope × Lifetime × Maturity

short-term 不作为 scope 第四层，而作为任意持久层上的 **lifetime 属性**。用 2×2 矩阵验证正交性：

| scope \ lifetime | permanent | ephemeral |
|---|---|---|
| **Session** | ❌ 矛盾 | ✅ 会话内临时上下文 |
| **Project** | ✅ 项目长期决策 | ✅ 分支实验决策、本周优先级 |
| **World** | ✅ 经验证的通用 maxim | ✅ 未经验证的 staging 候选 |

六个有效象限，四个已有真实用例。如果硬把 short-term 当 scope 层，会丢失"world 级临时暂存"这个关键需求。

**推荐模型**：

```yaml
# 知识条目的核心元数据
scope: session | project | world       # 空间边界——适用于哪里？
kind: maxim | decision | anti-pattern | pattern | fact | preference | smell
status: provisional | active | contested | deprecated | superseded | archived
confidence: 0-10

lifetime:                              # 时间边界——何时失效？
  kind: permanent | ttl | event | review
  expires_at: 2026-05-14               # kind=ttl
  expire_on: branch_merged:feat/x      # kind=event（"分支合入后失效"）
  review_after: 2026-05-10             # kind=review（"到期复查是否应 promote"）
```

- 默认 `lifetime.kind: permanent`，绝大多数条目零负担
- Event-driven expiry（`expire_on: branch_merged`）比固定 7 天更准确
- Session scope 的 lifetime 强制为 `session`（write-path validator 保证）
- GC 是独立 pipeline，不挑 scope，过期条目移入 `archive/` 而非直接删除

### 4.3 Kind 详细定义

| kind | 权威性 | 说明 | 例子 |
|---|---|---|---|
| **maxim** | MUST | 硬约束，不可违反 | "tmux 中永不关主 pane" |
| **decision** | WANT | 时效性约束，标注失效条件 | "当前项目用 pnpm，不用 npm" |
| **anti-pattern** | WARN | 已知陷阱，复用价值最高 | "dispatch_agents 表面并行可能实际串行" |
| **pattern** | SUGGEST | 经过验证的良好模式 | "用 @file 传 long prompt" |
| **fact** | IS | 事实陈述 | "pi 的 _emitExtensionEvent 透传引用" |
| **preference** | PREFER | 用户/项目偏好 | "用户喜欢中文回复" |
| **smell** | MAYBE | 刚浮现的模式，confidence < 5 | "这个错误信息 smells like 权限问题" |

### 4.4 默会知识管道（Tacit Knowledge Pipeline）

Polanyi 的"默会知识"不是"不可说"，而是"不能**完全**说"。每次外化都会产生新的默会背景。架构上承认：库里存的永远是 tacit knowledge 的**投影**，不是本体。

```
smell (staging)  ──验证──→  pattern (project)  ──promotion gates──→  maxim (world)
    ↓                            ↓                                    ↓
confidence < 5              confidence 5-7                       confidence 8-10
project scope only          project scope                       world scope
随意捕获，低承诺              半形式化，有边界                   跨项目验证，高承诺
```

**可显式化 vs 必须保持默会的边界**：

| 可以写 | staging 中等待 | 永远不写（保持默会） |
|---|---|---|
| "当 X 出现时，做 Y" | "X smell like Y" | 从 200 行 diff 中 2 秒定位 bug 的注意力机制 |
| "argv 传 long prompt 用 @file" | "这个 PR 的 shape 不对" | 知道什么时候停止调查、该动手试 |
| "tmux 永不关主 pane" | "感觉这个架构会 brittle" | 判断"该重构还是该加 if"的嗅觉 |

---

## 5. 存储架构

### 5.1 核心决策：Markdown 为 Source of Truth

> **知识管理系统应选择最长半衰期的格式作为 source of truth，所有性能结构（向量索引、全文搜索、图边）都作为可重建的派生制品。索引是 view，文本是 table。永远不要让索引成为 source of truth。**

经过多维度评估，**世界级知识与项目级知识统一使用 markdown + git 作为 source of truth**：

| 维度 | gbrain 专用服务 | 纯 md + git | 评估 |
|------|----------------|-------------|------|
| 检索质量 | 🟢 语义向量 + 关键词 + 图查询 | 🟡 仅 grep，用词不同时漏检 | gbrain 胜出，但可通过派生索引获得 |
| 版本控制 | 🟡 需自己实现 | 🟢 git 原生（blame/diff/revert） | md 碾压 |
| 离线可用 | 🔴 依赖网络/本地服务 | 🟢 纯文件系统，永远可用 | 决定性差异 |
| 人类可读可编辑 | 🟡 通过 CLI | 🟢 任何编辑器直接改 | md 碾压 |
| 搭建复杂度 | 🔴 安装服务、配置、运行 | 🟢 `mkdir` 即可 | 零搭建 vs 持续维护 |
| 维护负担 | 🔴 服务需升级、排障 | 🟢 `git commit` 即为维护 | 长期成本差异巨大 |
| 跨机器同步 | 🟡 取决于后端实现 | 🟢 `git push/pull` | 30 年工业验证 |
| 锁定风险 | 🔴 后端特定格式 | 🟢 纯文本，`cp -r` 迁移 | 50 年后 md 依然可读 |
| AI 原生特性 | 🟢 嵌入向量、图、聚类 | 🔴 纯文本无结构理解 | 可通过派生索引获得 |
| 多项目联邦 | 🟢 统一索引 | 🟡 需遍历多目录 | gbrain 胜出，但 md+facade 可行 |

**结论**：gbrain 的优势（语义检索、AI 原生特性）都可以通过 **从 md 派生的可重建索引层** 获得，而 md 的结构性优势（离线、git、人类可编辑、零锁定）是 gbrain 换不回来的。**gbrain 的理想角色不是替代 markdown，而是作为索引构建 pipeline 中的一个组件。**

### 5.2 存储拓扑

```
源真层（source of truth）                  派生索引层（可重建）
─────────────────────────────          ──────────────────────────
project/                                .gitignore'd:
  <project>/.pensieve/**/*.md            .pensieve/.index/
                                           ├── vectors.db
world/                                    ├── fulltext.db
  ~/.abrain/**/*.md                       └── graph.db
    ├── maxims/
    ├── patterns/                       ~/.abrain/.state/index/
    ├── anti-patterns/                    ├── vectors.db
    ├── facts/                            ├── fulltext.db
    ├── staging/                          └── graph.db
    ├── archive/
    ├── schemas/
    └── _index.md
```

**关键约束**：
1. 必须先有 rebuild 脚本，再构建索引——从干净 checkout 可完全重建。这是"索引是派生品"的契约证明。
2. Graceful degradation 是设计保证：派生索引不可用时 fallback 到 `rg`，结果标注 `degraded: true`。
3. 索引重建应在秒到分钟级完成（数百到数千条 entry）。
4. Embedding 模型优先本地（CPU 可跑），避免引入新的云依赖。

### 5.3 Facade 模式

不统一 `KnowledgeStorage` interface（会按最小公约数砍掉两边长处），而用 Facade 路由：

```
                        LLM Tools
                  memory_search | memory_get | memory_list
                              │
                        Memory Facade
                    (路由、归并、排序、去重、脱敏、权限、degrade)
                     /                    \
            ProjectStore               WorldStore
    (markdown + ripgrep +         (markdown + ripgrep +
     optional embed index)         optional embed index)
    ── <project>/.pensieve/       ── ~/.abrain/
```

```typescript
// Facade 中的 search 逻辑
async function search(query: string, ctx: SessionContext): Promise<SearchResult[]> {
  const [projectResults, worldResults] = await Promise.all([
    projectStore.search(query),
    worldStore.search(query),
  ]);

  // 排序（当前 project 加权 > 引用热度 > confidence）
  const scored = [projectResults, worldResults].flat().map(r => ({
    ...r,
    finalScore: r.score
      * (r.scope === 'project' ? ctx.projectBoost : 1)
      * Math.log(1 + (r.citationCount ?? 0))
      * ((r.confidence ?? 5) / 10),
  }));

  return scored
    .filter(r => r.status !== 'archived')
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 20);
}
```

### 5.4 ~/.abrain 设计

**定位**：世界级知识的独立 git 仓库，与 `~/.pi` 完全平行、无文件系统耦合。

**目录结构**：

```
~/.abrain/
├── maxims/              # 硬约束、通用原则
├── patterns/            # 可复用解决方案
├── anti-patterns/       # 已知陷阱
├── facts/               # 跨项目事实
├── staging/             # 未经验证的暂存洞察
├── archive/             # 过期/废弃条目
├── schemas/             # frontmatter schema 定义
├── _index.md            # 自动生成的目录
└── .state/              # gitignored
    ├── index/           # 派生向量/全文索引
    ├── locks/           # 写入锁
    └── pending.jsonl    # 待处理队列
```

**~/.abrain vs ~/.pi/.pensieve/ 边界**：

| 维度 | `.pensieve/` (project) | `~/.abrain/` (world) |
|------|------------------------|---------------------|
| scope | 本项目特定 | 跨项目通用 |
| 判断标准 | 离开当前 repo 不成立 | 换完全不同的项目仍然成立 |
| 示例 | "本项目用 pnpm，不用 npm" | "argv 传 long prompt 一律用 @file" |
| 示例 | "`src/foo.ts` 的设计原因是 X" | "scope 和 lifetime 应建模为正交维度" |

**写入决策树**：

```
sediment 拿到新洞察 P：

P 引用了具体文件路径 / 模块名 / API 名？
├─ 是 → 写 <project>/.pensieve/
└─ 否 → P 在 ≥2 个不同领域的项目验证过？
        ├─ 是 → 写 ~/.abrain/{maxims|patterns|anti-patterns}/
        └─ 否 → 写 ~/.abrain/staging/，等第二次命中再 promote
```

辅助规则：
- pensieve 条目可以引用 abrain 条目（"本项目应用了 abrain:某原则"）
- abrain 条目不应引用 pensieve 条目（通用不依赖具体）
- 引用用 logical id（`abrain:model-orthogonal-concerns`），不用 filesystem path

**引用机制：环境变量 `ABRAIN_ROOT`**

```typescript
const ABRAIN_ROOT = process.env.ABRAIN_ROOT ?? path.join(os.homedir(), '.abrain');
```

| 方案 | 判断 |
|------|------|
| `ABRAIN_ROOT` 环境变量 | ✅ 零耦合，测试可指 fixture，不同机器可不同路径 |
| git submodule | ❌ 把 abrain commit 钉到 pi，每次写入产生 dirty pointer |
| symlink | ❌ 跨平台不一致，backup/clone 时悬空 |

**跨机器同步**：

| 时机 | 动作 |
|---|---|
| 机器启动 / session 开始 | `git pull --rebase --autostash` |
| sediment 写完一条 | `git add . && git commit`（不 auto push） |
| 会话结束 | 安全脚本：`pull --rebase --autostash && push` |
| 冲突 | 不自动解决，pending 等人工 |

**条目内 append-only timeline 段**减少 git 冲突：

```markdown
## Timeline
- 2026-05-07 | machine-A | First captured during pi memory design
- 2026-05-09 | machine-B | Validated in OAuth refactor
```

纯追加的 merge 几乎总能自动完成。

---

## 6. Memory 工具接口

### 6.1 暴露给 LLM 的读工具（统一接口，不暴露 scope）

```
memory_search(query: string, filters?: { kind?, status? })
  → SearchResult[] {
      slug, title, summary, score,
      scope, kind, confidence, status,
      backend: 'rg' | 'vector' | 'graph',   // 后端标签，不做强制融合
      degraded?: true,
      missing_backends?: string[],
      related_slugs: string[]
    }

memory_get(slug: string, options?: { include_related?: boolean })
  → KnowledgeEntry {
      slug, title, summary, body,
      scope, kind, status, confidence,
      trigger_phrases, related, superseded_by,
      provenance, boundaries, visibility
    }

memory_list(filters: { scope?, kind?, status?, limit?, cursor? })
  → { entries: EntryMeta[], next_cursor? }

memory_relate(from_slug: string, to_slug: string, relation: string)
  → void
  // 声明关系，不写内容。sidecar 后续处理物理写入
```

### 6.2 暴露给 sediment 的写工具（不对外暴露）

```
memory_write(entry, destination: 'project' | 'world')
  → { slug, status: 'created' | 'merged' | 'rejected', reason? }

memory_update(slug, patch)
memory_deprecate(slug, reason, superseded_by?)
memory_merge(source_slugs[], target_slug)
memory_promote(slug, target_scope: 'world')
  → { slug, promoted, gates_passed[] }
```

---

## 7. 注入策略

### 7.1 三层注入

| 注入位置 | 内容 | Token 预算 | 更新频率 |
|---|---|---|---|
| **System Prompt (T1)** | 当前 project 的顶级 maxims（≤5 条）+ 导航 catalogue | ≤2K tokens | 每 session 启动 |
| **Tool Retrieval (T2)** | 按需 search → get hydrate | ≤6K tokens/轮 | 按需 |
| **Passive Nudge (T3)** | trigger phrase 匹配推送 | ≤300 tokens/轮 | 每轮 agent_end |

### 7.2 被动回忆（Passive Nudge）

解决"你不会 search 你不知道存在的东西"这个根本矛盾：

每条 world knowledge 带 `trigger_phrases` 字段（创建时自动提取）。sidecar 在每轮 agent_end 后检测 agent 发言是否命中 trigger phrase，命中则注入该条目 summary 到下一轮的 T3 nudge。

```typescript
function matchPassiveNudge(agentText: string, knowledge: KnowledgeEntry[]): Nudge[] {
  return knowledge
    .filter(e => e.status === 'active')
    .filter(e => e.trigger_phrases.some(p => agentText.toLowerCase().includes(p.toLowerCase())))
    .slice(0, 3)
    .map(e => ({ slug: e.slug, title: e.title, summary: e.summary }));
}
```

### 7.3 Context Budget 硬约束

```
T1 (system)     ≤ 2,000 tokens
T2 (retrieval)  ≤ 6,000 tokens
T3 (nudge)      ≤   300 tokens
───────────────────────────
Total            ≤ 8,300 tokens
```

超过 8K 后额外知识从零收益变为负收益（挤占 LLM 对当前任务的注意力）。

---

## 8. 读写分离

### 8.1 规则

| 角色 | 读 | 写 session | 写 project | 写 world |
|---|---|---|---|---|
| 主 session agent | ✅ | ✅ | ❌ | ❌ |
| dispatch 子进程 | ✅ | ❌ | ❌ | ❌ |
| sediment sidecar | ✅ | ❌ | ✅ | ✅ (with gates) |
| 用户显式触发 | ✅ | ❌ | 触发 intent | 触发 intent |

### 8.2 写入路由（Fail-Closed）

不能靠 cwd 推断目标项目。写入由 harness 显式注入：

```typescript
interface WriteContext {
  project_source: string;     // e.g. "pi-global"
  project_root: string;       // e.g. "/home/worker/.pi"
  user_id: string;
  session_id: string;
  allowed_scopes: ('project' | 'world')[];
}
```

无法确定 target project → **不写，记录 warning**。错写比漏写危险。

### 8.3 单写入者保证

多个 pi 进程可能同时有 sediment 在跑。用 file lock 保证单写入者：

```typescript
async function acquireWriteLock(lockDir: string): Promise<boolean> {
  const lockFile = path.join(lockDir, 'sediment.lock');
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); // O_CREAT | O_EXCL
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false; // 已有其他实例持有锁
    throw e;
  }
}
// 抢锁失败 → 退化为只读 + 入队 pending queue
```

---

## 9. 演化机制

### 9.1 Promotion（Project → World）

```
project knowledge
    ↓
Gate 1: 去上下文化检查
  → 去掉项目名、路径、技术栈后，是否仍然成立？
    ↓
Gate 2: 跨实例验证
  → 是否至少 2 个独立 project/session 中出现？
    ↓
Gate 3: 反例检查
  → 什么时候不适用？是否存在已知反例？
    ↓
Gate 4: 冷却期
  → 是否已经至少 3 天？（消除近因偏差）
    ↓
Gate 5: 冲突检查
  → 是否已有相反或更精确的 world 知识？
    ↓
promoted → world scope, confidence ≥ 7, status: active
```

### 9.2 Deprecation

触发条件（任一）：
- 被新证据推翻（平台升级后旧规则不再成立）
- 命中频率连续 6 个月为 0
- 与新条目冲突且新条目证据更强
- 用户显式标记 obsolete

操作：`status → deprecated`，`superseded_by → 新条目 slug`。保留 body 和 provenance（可查"为什么以前这么做"）。

### 9.3 Specialization（不是降级）

world 知识不降级为 project。若某 world maxim 只在特定条件下成立，通过 specialization 加约束：

```
world:avoid-argv-long-prompt
    → specialization →
world:avoid-argv-long-prompt (pi-spawn-mode)
    boundaries: "仅适用于 spawn 传参，REST API/HTTP POST 无此问题"
```

不存在 World → Project 降级。如果 world 知识被证伪，直接 deprecate。

---

## 10. 治理

### 10.1 冲突管理

两条规则矛盾时：**不要急着删**。两条都标 `status: contested`，互相 link，让 LLM 检索到时自行判断。冲突本身就是有价值的信息。

### 10.2 安全脱敏

sediment 写入前过 redactor pipeline：

| 模式 | 处理 |
|---|---|
| credential 字符串 | 替换为 `[REDACTED]` |
| IP / 内部 hostname | 替换为 `[HOST]` |
| 绝对路径含 $HOME | 替换为 `$HOME/...` |
| API key / token | 整条拒绝写入 |

脱敏在 capture 阶段做，不事后 redact。

### 10.3 检索评估指标

| 指标 | 含义 |
|---|---|
| precision@k | top-K 结果中相关比例 |
| recall@k | 应召回的知识实际被召回的比例 |
| deprecated-hit rate | LLM 使用的知识中有多少已废弃 |
| duplicate rate | 搜索结果中重复条目比例 |
| wrong-scope write rate | project 知识被误写入 world 的频率 |

---

## 11. 实现路线图

### Phase 1：Project 层落地（当前 pensieve 升级）

1. Markdown 条目格式标准化（统一 frontmatter schema）
2. `memory_search / get / list` 的 grep-based 实现（仅 project 层）
3. Auto-generated `_index.md` catalogue
4. Sediment 双轨管道（project lane + world lane）

### Phase 2：World 层接入

1. `~/.abrain/` 目录结构落地，独立 git repo
2. `ABRAIN_ROOT` 环境变量支持
3. Memory Facade 跨 store dispatch + graceful degradation
4. Trigger phrases + passive nudge 机制
5. Promotion gates（project → world）

### Phase 3：派生索引

1. `abrain reindex` rebuild 脚本（从 md 构建向量/全文/图索引）
2. Facade 向量搜索 + grep fallback
3. 索引新鲜度检测（git commit 对比）

### Phase 4：治理与评估

1. 冲突检测与 contested 状态
2. 引用热度排序
3. 安全脱敏 pipeline
4. 检索评估指标采集

### Phase 5：Session 层（可选）

1. Session scratchpad API
2. Intent 通道（memory_relate）
3. Cross-session 分析 pass

---

## 附录 A：综合架构图

```
┌─────────────────────────────────────────────────────┐
│                    Agent / LLM                       │
│          memory_search()  │  memory_get()            │
└────────────────────────┬────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │   Memory Facade     │  ← 统一读取面
              │  · 路由（scope）     │
              │  · 归一化           │
              │  · 去重 + 排序      │
              │  · Graceful Degrade │
              └────┬──────────┬─────┘
                   │          │
    ┌──────────────▼──┐  ┌───▼──────────────┐
    │  grep backend   │  │  vector backend  │  ← 可重建派生索引
    │  (rg over md)    │  │  (embedding idx) │
    └──────┬──────────┘  └───┬──────────────┘
           │                 │
    ┌──────▼─────────────────▼──────────────┐
    │           SOURCE OF TRUTH              │
    │                                        │
    │  project/   <project>/.pensieve/**     │
    │  world/     ~/.abrain/**               │
    │                                        │
    │  (markdown + git, 人类可读, 离线可用)   │
    └────────────────────────────────────────┘
```

**关键属性**：
- 源真层 100% 纯文本 + git，离线可用，人类可编辑，零锁定，50 年后依然可读
- 索引层提供语义搜索增强，不可用时系统降级但不失效
- Facade 隔离 agent 与存储拓扑，底层变更不影响上层
- Scope × Lifetime × Maturity 三个正交维度独立建模，不互相污染
- 写入路径：agent → md → git commit → 索引自动/定时重建

---

## 附录 B：与 Karpathy LLM Wiki 方法论的对比分析

> 基于 2026-05-06 第三轮 T0 深度讨论。参与者：Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro

### B.1 核心方法论概述

Andrej Karpathy 提出了 LLM Wiki 知识管理方法论，核心类比是**编译器模型**：

- **Source code** = 原始资料（论文、文章、笔记、网页剪藏）
- **Compiler** = LLM
- **Executable** = 结构化的 interlinked markdown wiki

四个阶段循环：
1. **Ingest**：原始资料收集到 `raw/` 文件夹
2. **Compile**：LLM 增量编译 raw → wiki（index 文件、概念文章、交叉引用）
3. **Query & Enhance**：查询 wiki，每次交互反哺系统
4. **Lint & Maintain**：LLM 健康检查——断链、矛盾、建议合并、补缺口

关键主张：
- 不做传统 RAG，不做向量数据库——在个人知识库规模（~100 篇）下，index 文件 + LLM 上下文窗口足够
- LLM 是维护者，人类几乎不手动编辑 wiki
- "编译真相"优于"每次重新推导"
- 未来方向：用 wiki 生成合成训练数据 fine-tune 个性化模型

### B.2 与当前架构的契合度

| Karpathy 核心理念 | 我们的等价设计 | 对齐程度 |
|---|---|---|
| Markdown = executable（LLM 编译产物） | Markdown = source of truth，派生索引可重建 | 🔒 完全一致 |
| LLM 是维护者，人类不手动编辑 | Sediment sidecar 是唯一持久写入者，主会话只读 | 🔒 完全一致 |
| 编译真相优于重推导 | maxims/decisions 预编译，不每次从 raw 推导 | 🔒 完全一致 |
| 不做传统 RAG / 向量数据库 | 向量索引是可选的派生层，默认 grep + index 文件 | 🟢 高度一致 |
| 四阶段循环 | agent_end → sediment 评估写入 | 🟡 有 compile，缺 lint |
| 每次查询反哺 | 主会话只读不写，查询-应用关联丢失 | 🔴 缺失 |

### B.3 引入的修改

基于 Karpathy 方法论，对 §10 治理和 §11 路线图做以下补充：

#### B.3.1 Lint & Maintain 阶段（`sediment-lint`）

增加定期健康检查任务（cron 或手动触发），sediment sidecar 的第二个角色：

- **断链检测**：所有 `[[wikilink]]` 和 logical ID 引用有效性检查
- **重复检测**：LLM 比对相似条目，建议合并
- **过期提醒**：TTL expired / decisions 失效条件触发的 review prompt
- **缺口分析**：近期高频查询但无对应知识的概念列表
- **scope 污染检测**：world 条目中出现项目私有路径、repo 名

输出 lint report 到 `.state/lint-report.md`，只建议不自动修改。

#### B.3.2 查询反哺闭环

sediment 在 agent_end 处理中增加**知识应用追踪**：

- 检测本 session 中是否检索并**实际应用**了知识条目
- 若被应用 → 在原条目的 evidence timeline 追加 `applied_in` 记录
- 形成"知识因为被使用而增值"的增长飞轮
- 不修改 canonical 内容本身，只追加 usage edge

这弥补了"查询结果不被保留、知识-应用关联在会话结束后丢失"的架构缺口。

#### B.3.3 Raw Sources 层

渐进式引入 `raw/` 目录：

```
.pensieve/raw/          # 用户 /ingest 的原始资料
~/.abrain/raw/          # 跨项目原始资料
```

- 编译后的知识条目通过 `derives_from` / `sources` frontmatter 字段链接回 raw
- 不把所有对话都存为 raw（避免日志膨胀）
- 只有用户明确标记为持久化的源材料进入 raw/

#### B.3.4 Index 文件自动生成

sediment 自动维护每个 scope 的 `_index.md`：

- 综述段落（知识库的高层摘要）
- 按 kind 分类的 TOC
- 核心概念摘要（每个概念 1-2 句，带链接）
- 作为 T1 system prompt 注入的主要载体（替代 grep 裸搜）

### B.4 qmd 的定位

qmd（github.com/tobi/qmd）是一个本地 markdown 搜索引擎：
- BM25 全文 + 向量语义 + LLM rerank，全部本地运行（node-llama-cpp + GGUF）
- 支持 MCP 协议，已有 **pi-qmd 扩展**（github.com/hjanuschka/pi-qmd）

**qmd 在 Facade 模式下的定位**：

```
                    Memory Facade
                    /     |      \
                   /      |       \
            qmd 后端   gbrain    ripgrep fallback
         (BM25+Vec+    (keyword+  (纯 grep)
          LLM Rerank)   graph)
```

| qmd 能替代的 | qmd 不能替代的 |
|---|---|
| 本地 markdown 的 BM25/向量/rerank 搜索 | Facade 的 scope 路由与结果归并 |
| 零云依赖的语义搜索能力 | gbrain 的图查询（callers/callees、实体关系） |
| 当前"无 embedding API"困境的直接解决方案 | sediment 写入路径与 promotion gates |
| | 跨机器同步与长期 world 知识持久化 |

**建议**：pi-qmd 作为 Facade 下的可选本地搜索后端接入，与 gbrain 平行。qmd 解决"本地语义搜索"，gbrain 解决"图查询 + 跨机器同步"。

### B.5 向量索引定位调整

Karpathy 的"个人规模不需要向量数据库"论点验证了我们的已有决策：

- **Pensieve 层（项目范围）**：不做向量索引。`_index.md` + grep + LLM 上下文窗口足够
- **gbrain 层（世界范围）**：向量搜索降为可选加速层，非核心依赖
  - 新用户默认不启用 pgvector
  - 文档标注"在 2,000 条目以下通常不需要向量索引"
  - 无 pgvector 时 FTS + 图遍历 + grep fallback 完整可用

**关键转变**：不说"我们需要向量索引"，而说"我们需要可重建的检索层，向量索引是其中一个可选组件"。
