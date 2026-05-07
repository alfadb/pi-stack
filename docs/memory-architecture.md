# Pi 知识管理架构设计

> 基于 2026-05-06 用户原始架构想法 + Claude Opus 4 / GPT-5.5 / DeepSeek V4 Pro 三方深度讨论综合而成。

## 0. 核心原则

1. **读写分离**：只有 sediment sidecar 可以写持久知识。主 session、dispatch 子进程、所有其他 LLM 调用路径只能读。
2. **读接口统一**：对 LLM 暴露的查询工具不区分项目级/世界级——区分是噪音。
3. **写入显式 scoped**：只有 sidecar 的写入工具需要区分目标层级。
4. **存储后端可插拔**：project 用 markdown + git，world 用 gbrain。Facade 确保切换后端不改工具接口。

---

## 1. 三层知识模型

### 1.1 层级定义

| 层 | 生命周期 | 存储 | 写入者 | 示例 |
|---|---|---|---|---|
| **Session** | 当前会话 | 内存 scratchpad | 主 agent（零摩擦） | "已验证 foo.ts 调用链安全，别再查"、"B 方案已排除" |
| **Project** | 项目存活期 | Markdown + git（`.pensieve/`） | sediment sidecar | ADR 决策、模块边界、测试规范、部署约束 |
| **World** | 跨项目持久 | gbrain | sediment sidecar（with gates） | dispatch 并行陷阱、tmux 主 pane 不关、argv/@file 选择 |

**Session 层关键设计**：
- 主 agent 可以直接写 session scratchpad，不需要走 voter/sidecar。
- Session 结束自动蒸发（或保留 3 轮 activity 作为 sticky note）。
- 与 project/world 完全分离的写入路径——session 层的随意性不污染持久层。

### 1.2 不需要的层级

- **团队/组织层**：当前是单用户 agent，不需要身份模型。如有需要，通过 git 共享 `.pensieve/` 即可。
- **用户偏好层**：可以放在 world 层作为特殊 type（`type: preference`），不需要独立物理层。

---

## 2. 二维 Schema（scope × kind）

"项目级 / 世界级"是一维 scope。知识条目还需要第二维 **kind**。

### 2.1 Schema 定义

```typescript
interface KnowledgeEntry {
  // 主键
  slug: string;          // e.g. "world:dispatch-parallel-trap"

  // 二维分类
  scope: 'session' | 'project' | 'world';
  kind:  'maxim' | 'decision' | 'anti-pattern' | 'pattern' | 'fact' | 'preference' | 'smell';

  // 生命周期
  status: 'provisional' | 'active' | 'contested' | 'deprecated' | 'superseded' | 'archived';
  confidence: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

  // 内容
  title: string;
  summary: string;       // ≤200 tokens，用于 search snippet
  body: string;          // 完整内容
  trigger_phrases: string[];   // 被动回忆触发词

  // 演化
  superseded_by?: string;
  relates_to?: string[];
  derives_from?: string[];

  // 来源
  provenance: {
    session_id: string;
    project_source: string;
    model: string;
    created_at: string;
    updated_at: string;
    last_verified_at?: string;
  };

  // 边界
  applies_to_versions?: string;    // e.g. "pi >= 6.5, node >= 20"
  boundaries?: string;             // 什么时候不适用

  // 安全
  visibility: 'private' | 'project' | 'world';
  contains_sensitive: boolean;

  // 证据
  evidence_count: number;
  evidence_sessions: string[];
}
```

### 2.2 kind 详细定义

| kind | 权威性 | 说明 | 例子 |
|---|---|---|---|
| **maxim** | MUST | 硬约束，不可违反 | "tmux 中永不关主 pane" |
| **decision** | WANT | 时效性约束，标注失效条件 | "当前项目用 pnpm，不用 npm" |
| **anti-pattern** | WARN | 已知陷阱，复用价值最高 | "dispatch_agents 表面并行可能实际串行" |
| **pattern** | SUGGEST | 经过验证的良好模式 | "用 @file 传 long prompt" |
| **fact** | IS | 事实陈述 | "pi 的 _emitExtensionEvent 透传引用" |
| **preference** | PREFER | 用户/项目偏好 | "用户喜欢中文回复" |
| **smell** | MAYBE | 刚浮现的模式，confidence < 5 | "这个错误信息 smells like 权限问题" |

### 2.3 写入分流规则

| scope | kind 支持 | 写入路径 |
|---|---|---|
| session | preference, fact | 主 agent 直接写 scratchpad |
| project | maxim, decision, anti-pattern, pattern, fact, preference | sediment project lane |
| world | maxim, anti-pattern, pattern, fact | sediment world lane（with gates） |

---

## 3. 默会知识管道

### 3.1 核心洞察

Polanyi 的"默会知识"不是"不可说"，而是"不能**完全**说"。每次外化都会产生新的默会背景。架构上要承认：**库里存的永远是 tacit knowledge 的投影，不是本体。**

### 3.2 三级管道

```
smell (staging)  ──验证──→  pattern (project)  ──promotion gates──→  maxim (world)
    ↓                            ↓                                    ↓
confidence < 5              confidence 5-7                       confidence 8-10
project scope only          project scope                       world scope
trigger_phrases 粗粒度       trigger_phrases 结构化              trigger_phrases 精确
```

### 3.3 何时可以入库 vs 何时保留为默会

| 可以写 | staging 中等待 | 永远不写（保持默会） |
|---|---|---|
| "当 X 出现时，做 Y" | "X smell like Y" | 从 200 行 diff 中 2 秒定位 bug 的注意力机制 |
| "argv 传 long prompt 用 @file" | "这个 PR 的 shape 不对" | 知道什么时候停止调查、该动手试 |
| "tmux 永不关主 pane" | "感觉这个架构会 brittle" | 判断"该重构还是该加 if"的嗅觉 |

### 3.4 Smell Entry 格式

```yaml
slug: smell:permission-smell-pattern
kind: smell
scope: project
confidence: 3
status: provisional
title: "错误信息含 EACCES 时的排查嗅觉"
summary: >
  当看到一个 EACCES 错误但路径显然正确时，
  smell 的方向依次是：父目录权限 → SELinux → container uid mapping
trigger: "EACCES 错误 + 路径看似正确"
boundaries: "标准 Linux 环境，不适用于 Windows ACL"
provenance:
  session_id: "session-xxx"
  model: "claude-opus-4-7"
```

---

## 4. Memory 工具接口

### 4.1 暴露给 LLM 的工具（读）

```
memory_search(query: string, filters?: { scope?, kind?, status? })
  → SearchResult[] {
      slug, title, summary, score,
      scope, kind, confidence, status,
      source: 'md-grep' | 'gbrain-hybrid',
      related_slugs: string[]
    }

memory_get(slug: string, options?: { include_related?: boolean })
  → KnowledgeEntry (完整内容 + 关联条目摘要)

memory_list(filters: { scope?, kind?, status?, limit?, cursor? })
  → { entries: EntryMeta[], next_cursor? }
  // LLM 很少用，主要用于浏览和调试

memory_relate(from_slug: string, to_slug: string, relation: string)
  → void
  // 声明关系，不写内容。sidecar 后续处理物理写入
```

### 4.2 暴露给 sediment 的工具（写）

```
memory_write(entry: Omit<KnowledgeEntry, 'provenance'>)
  → { slug: string, status: 'created' | 'merged' | 'rejected', reason?: string }

memory_update(slug: string, patch: Partial<KnowledgeEntry>)
  → void

memory_deprecate(slug: string, reason: string, superseded_by?: string)
  → void

memory_merge(source_slugs: string[], target_slug: string)
  → void

memory_promote(slug: string, target_scope: 'world')
  → { slug: string, promoted: boolean, gates_passed: string[] }
```

### 4.3 LLM 不暴露的参数

- `scope`（在 search 中隐式处理：默认两层都搜，当前 project 加权）
- 底层后端详情（`source` 字段只影响排序，不由 LLM 控制）
- 写入相关工具

---

## 5. 存储架构

### 5.1 Facade 模式（不用统一 Interface）

```
                        LLM Tools
                  memory_search | memory_get | memory_list
                              │
                        Memory Facade
                    (路由、归并、排序、去重、脱敏、权限)
                     /                    \
            ProjectStore               WorldStore
    (markdown + ripgrep +         (gbrain: vector + keyword
     optional embed cache)               + graph)
```

### 5.2 为什么不统一 Interface

| 能力 | Markdown | gbrain |
|---|---|---|
| grep 精确搜索 | ✅ 强 | ⚠️ 中 |
| 语义搜索 | ❌ 弱（需额外 embed） | ✅ 强 |
| graph 遍历 | ❌ 弱 | ✅ 强 |
| git 版本化 | ✅ 原生 | ❌ 弱 |
| 人类直接编辑 | ✅ 强 | ⚠️ 取决于实现 |
| 离线读取 | ✅ 强 | ❌ 弱 |

统一接口会按最小公约数砍掉两边长处。Facade 让各后端保留全部能力。

### 5.3 搜索结果归并

```typescript
// Facade 中的 search 逻辑
async function search(query: string, context: SessionContext): Promise<SearchResult[]> {
  // 并发查询两边
  const [mdResults, gbrainResults] = await Promise.all([
    projectStore.search(query),
    worldStore.search(query),
  ]);

  // 统一格式化
  const allResults = [
    ...mdResults.map(r => ({ ...r, source: 'md-grep' })),
    ...gbrainResults.map(r => ({ ...r, source: 'gbrain-hybrid' })),
  ];

  // 排序（当前 project → world 加权，引用热度加权，confidence 加权）
  const scored = allResults.map(r => ({
    ...r,
    finalScore: r.score
      * (r.scope === 'project' ? context.projectBoost : 1)
      * Math.log(1 + r.citationCount)
      * (r.confidence / 10),
  }));

  return scored
    .filter(r => r.status !== 'archived')
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 20);  // 截断，LLM 从 metadata + snippet 中选择 hydrate
}
```

### 5.4 项目级 Markdown 布局

```text
.pensieve/
├── maxims/                    # 项目级 maxims
│   └── never-close-main-tmux-pane.md
├── decisions/                 # ADR 式决策
│   └── 2026-05-06-use-pnpm.md
├── knowledge/                 # 事实、pattern、anti-pattern
│   └── foo-module-call-chain.md
├── staging/                   # smell / provisional entries
│   └── permission-smell-pattern.md
├── _index.md                  # 自动生成的 catalogue
└── _state.md                  # 元数据
```

条目文件格式：

```markdown
---
slug: project:never-close-main-tmux-pane
scope: project
kind: maxim
status: active
confidence: 10
trigger_phrases: [tmux, kill-pane, close-window, detach]
boundaries: "适用于 tmux 环境，不适用于 screen/zellij"
created_at: 2026-05-01T12:00:00Z
updated_at: 2026-05-06T08:30:00Z
last_verified_at: 2026-05-06T08:30:00Z
model: claude-opus-4-7
session_id: sess-abc123
project_source: pi-global
superseded_by:
relates_to: [world:tmux-escape-time-250ms]
derives_from:
evidence_count: 5
evidence_sessions: [sess-abc123, sess-def456, sess-ghi789]
---

# 永不关闭 tmux 主 pane

## Principle

pi 在 tmux 中运行时，运行 pi 的 pane（主 pane）绝对不能通过
kill-pane / kill-window 关闭。

## Action

- 所有 `tmux kill-pane` / `tmux kill-window` 操作前必须检查目标
- 拆分 pane / new-window 后立即 `select-pane` 切回主 pane
- 关闭其他 pane 时确保主 pane 不在目标列表中

## Boundaries

- 主 pane 的定义：运行 `pi` 进程的那个 pane
- 不适用于：非 tmux 环境、screen、zellij
- 例外：pi 进程已主动退出时

## Evidence

- sess-abc123: 误关主 pane 导致 session 丢失
- sess-def456: split-window 后忘记 select-pane，日志写入错误 pane
- sess-ghi789: kill-window 误杀主 pane（5 次确认后）
```

---

## 6. 注入策略

### 6.1 三层注入

| 注入位置 | 内容 | Token 预算 | 更新频率 |
|---|---|---|---|
| **System Prompt (T1)** | 当前 project 的顶级 maxims（≤5 条）+ 导航卡 | ≤2K tokens | 每 session 启动 |
| **Tool Retrieval (T2)** | 按需 search → get hydrate | ≤6K tokens per turn | 按需 |
| **Passive Nudge (T3)** | trigger phrase 匹配推送 | ≤300 tokens per turn | 每轮 agent_end |

### 6.2 导航卡（注入到 system prompt 最末尾）

```
## Memory
You have access to persistent project and world knowledge:
- memory_search "query" — find relevant entries
- memory_get "slug" — read full entry
- memory_list — browse entries
- memory_relate — connect entries

Current project memory: 12 maxims, 8 decisions, 31 knowledge entries
Use memory_search before changing architecture or when encountering errors.
```

### 6.3 被动回忆（Passive Nudge）

每条 world knowledge 带 `trigger_phrases` 字段。sidecar 在 `agent_end` 后的 pipeline 中检测 agent 本轮发言是否命中任何 trigger phrase，命中则注入该条目的 summary 到下一轮的 T3 nudge。

```typescript
// sidecar 中的 passive recall 逻辑
function matchPassiveRecall(agentMessages: string[], knowledge: KnowledgeEntry[]): Nudge[] {
  const nudges: Nudge[] = [];
  const agentText = agentMessages.join(' ').toLowerCase();

  for (const entry of knowledge) {
    if (entry.status === 'archived' || entry.status === 'deprecated') continue;
    for (const phrase of entry.trigger_phrases) {
      if (agentText.includes(phrase.toLowerCase())) {
        nudges.push({
          slug: entry.slug,
          title: entry.title,
          summary: entry.summary,
          confidence: entry.confidence,
          trigger: phrase,
        });
        break;
      }
    }
  }

  return nudges.slice(0, 3);  // 最多 3 条
}
```

### 6.4 Context Budget 硬约束

```
T1 (system prompt)     ≤ 2,000 tokens
T2 (tool retrieval)    ≤ 6,000 tokens per turn
T3 (passive nudge)     ≤ 300 tokens per turn
──────────────────────────────────────
Total memory overhead  ≤ 8,300 tokens

超过 8K tokens 后，额外知识从零收益变为负收益
（挤占 LLM 对当前任务的注意力）
```

---

## 7. 读写分离

### 7.1 规则

| 角色 | 读 | 写 session | 写 project | 写 world |
|---|---|---|---|---|
| 主 session agent | ✅ | ✅ | ❌ | ❌ |
| dispatch 子进程 | ✅ | ❌ | ❌ | ❌ |
| sediment sidecar | ✅ | ❌ | ✅ | ✅ (with gates) |
| 用户（`/skill:pensieve self-improve`） | ✅ | ❌ | 触发 intent | 触发 intent |

### 7.2 主 session 的"意图通道"

主 agent 不能写持久知识，但可以通过 `memory_relate` 声明关系，或表达"这条值得记"的意图：

```
memory_relate("project:foo-decision", "world:dispatch-parallel-trap", "derives_from")
```

这产生一个结构化 intent，sidecar 在 turn end 读取并决定是否写入。

### 7.3 单写入者保证

多个 pi 进程可能同时有 sediment 在跑。必须用 file lock 保证单写入者：

```typescript
// sediment 启动时
async function acquireWriteLock(): Promise<boolean> {
  const lockFile = path.join(lockDir, 'sediment.lock');
  try {
    // O_CREAT | O_EXCL → 原子 create
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      // 已有其他 sediment 实例持有锁
      return false;
    }
    throw e;
  }
}

// 抢锁失败 → 退化为只读 + 入队 pending queue
if (!(await acquireWriteLock())) {
  mode = 'readonly';
  enqueueInsights(insights);  // 等下次拿到锁再写
}
```

### 7.4 写入路由（fail-closed）

不能靠 cwd 推断目标项目。写入由 harness 显式注入：

```typescript
// sediment 收到 agent_end 时的 context
interface WriteContext {
  project_source: string;      // e.g. "pi-global"
  project_root: string;        // e.g. "/home/worker/.pi"
  user_id: string;
  session_id: string;
  allowed_scopes: ('project' | 'world')[];
}
```

无法确定 target project 时 → **不写，记录 warning**。错写比漏写危险。

---

## 8. 演化机制

### 8.1 Promotion（Project → World）

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

### 8.2 Deprecation

```
触发条件（任一）:
  - 被新证据推翻（平台升级后旧规则不再成立）
  - 命中频率连续 6 个月为 0
  - 与新条目冲突且新条目证据更强
  - 用户显式标记 obsolete

操作:
  status → 'deprecated'
  superseded_by → 新条目 slug（如有）
  retains body, provenance（保留历史，可查"为什么以前这么做"）
```

### 8.3 Specialization

不是降级，而是加约束条件：

```
world:avoid-argv-long-prompt
    → specialization →
world:avoid-argv-long-prompt (pi-spawn-mode)
    boundaries: "仅适用于 spawn 传参，REST API/HTTP POST 无此问题"
```

### 8.4 版本化

不要 semver 版本化。用 git 免费获得完整版本历史。知识条目只需：

- `superseded_by`：取代链
- `updated_at` / `last_verified_at`：时间戳
- `applies_to_versions`：版本约束（如 "pi >= 6.5"）
- git blame：细粒度 diff

---

## 9. 治理

### 9.1 冲突管理

两条规则互相矛盾时：

```
不要急着删一条。
→ 两条都标 status: contested
→ 互相 link（relates_to）
→ 在 body 顶部加 conflict notice
→ LLM 检索到时看到冲突 → 它自行判断
```

冲突本身就是有价值的信息。

### 9.2 引用热度排序

搜索结果排序不只靠文本相关性：

```
finalScore = textScore
  × projectBoost（当前 project 加分）
  × log(1 + citationCount)（被多少条目引用）
  × (confidence / 10)
  × recencyDecay（最近更新的加分，但权重低于热度）
```

### 9.3 安全脱敏

sediment 写入前必须过脱敏层：

| 模式 | 处理 |
|---|---|
| 像 credential 的字符串 | 替换为 `[REDACTED]` |
| IP 地址 / 内部 hostname | 替换为 `[HOST]` |
| 绝对路径含用户 home | 替换为 `$HOME/...` |
| API key / token | 整条 knowledge 拒绝写入 |

脱敏在 capture 阶段做，不事后 redact。

### 9.4 Unsafe Failures

```
sidecar 看到如下内容 → 完全拒绝写入：
- 可解析为 credential 的字符串
- 客户数据
- prompt injection payload
- 非公开的内部 URL
```

### 9.5 检索评估

长期需要指标：

| 指标 | 含义 |
|---|---|
| precision@k | top-K 结果中相关比例 |
| recall@k | 应召回的知识实际被召回的比例 |
| deprecated-hit rate | LLM 使用的知识中有多少是已废弃的 |
| duplicate rate | 搜索结果中重复/近似条目的比例 |
| wrong-scope write rate | project 知识被误写入 world 的频率 |
| time-to-retrieve | 从 search 到 get hydrate 的延迟 |

---

## 10. 索引与目录（Index / Catalogue）

### 10.1 问题

> "你不会 search 你不知道存在的东西"

如果 agent 不知道 `dispatch-parallel-trap` 这条知识存在，它永远不会主动 search "dispatch 并行"。

### 10.2 解决：自动生成的 Catalogue

sediment 每次写入后增量重建 `_index.md`：

```markdown
# Project Knowledge Index

## Maxims (3)
- [永不关闭 tmux 主 pane](maxims/never-close-main-tmux-pane.md) — 运行 pi 的 pane 绝对不能 kill
- [主 session 只读不写](maxims/main-session-read-only.md) — 只有 sidecar 可以持持久化
- [文件操作用 edit 不用 write 覆盖](maxims/edit-not-write.md) — 小改动避免全文覆盖

## Decisions (5)
- [2026-05-01 gbrain 作为唯一记忆存储](decisions/2026-05-01-gbrain-as-sole-memory-store.md)
- [2026-05-02 sediment 双轨管道](decisions/2026-05-02-sediment-two-track-pipeline.md)

## Anti-Patterns (4)
- [dispatch_agents 串行陷阱](knowledge/dispatch-parallel-trap.md)
- [argv 传 long prompt](knowledge/argv-long-prompt.md)

## Patterns (3)
...

## Facts (6)
...
```

System prompt 中 include 这个文件。≤500 tokens 的开销换回"agent 知道该搜什么"的能力。

---

## 11. 实现路线图

### Phase 1：Project 层落地（当前 pensieve 的升级）

1. Markdown 条目格式标准化（统一 frontmatter schema）
2. `memory_search/get/list` 工具实现（grep-based，仅 project 层）
3. Auto-generated `_index.md` catalogue
4. Sediment 双轨管道（project lane + world lane）

### Phase 2：World 层接入

1. gbrain `memory_search` hybrid 后端
2. `memory_get` 跨 store dispatch
3. World knowledge trigger_phrases + passive nudge
4. Promotion gates（project → world）

### Phase 3：治理与评估

1. 冲突检测与 contested 状态
2. 引用热度排序
3. 安全脱敏 pipeline
4. 检索评估指标采集

### Phase 4：Session 层（可选）

1. Session scratchpad API
2. Intent 通道（memory_relate）
3. Cross-session 分析 pass
