# Brain Redesign Spec

> **状态**：v1.5 — current as of 2026-05-11（abrain vault P0a-c shipped + dispatch --tools allowlist enforcement + vaultWriter security claim corrected）。
>
> Baseline v1.0 accepted alongside [ADR 0014](adr/0014-abrain-as-personal-brain.md)；v1.1 完成 Round 3 P0 闭合；v1.2 完成 Round 4 P0 闭合；v1.3 完成 Round 5 P0 闭合；v1.4.6 中间迭代；v1.5 修正 §6.4.0 vaultWriter module export 安全声明。
>
> **v1.3 变更点**（三家 Round 5 复核 → 1 PASS after fixing P0 / 2 CONDITIONAL，5 个新 P0）：
> - **真代码修订**：`extensions/dispatch/index.ts` 的 `runSubprocess()` 加 `env: { ...process.env, PI_ABRAIN_DISABLED: "1" }` env override（v1.2 文档写了但代码未实施——GPT P0-1）；加 `smoke:vault-subpi-isolation` 验证 5 项不变量
> - §6.4.0 audit 顺序**内部矛盾修复**（DS P0-A）：选顺序 A（rename 在前 audit 在后）+ 加 crash recovery（启动时 scan vault vs audit log）
> - migration §6 `pi brain pause` 加 `trap EXIT` cleanup（DS P0-B）：抢锁失败 / crash 均不泄 pause flag
> - vaultWriter trust 边界明确化（Opus NP0-1）：删错乱 `parent_pid != pi_pid` wording；明示 bash 通用工具（`secret-tool` + `age` / `node -e require()` / direct fs）是 known residual surface；坐偏入 §坟处 #10
> - 不变量 #1 wording 拆为 mechanic + best-effort 两段（Opus NP1-1）
> - migration §6 P5 silent drop 修复（GPT P0-2）：paused 期间 sediment bg checkpoint **不前进**，避免已 advance checkpoint 后 LLM 返回看见 paused 静默丢
> - 4 个 P1 顺手：staging 加 session-start-epoch / cross-log timestamp 契约 / ADR §D3 staging 第四出口 / substrate API 边界清单
>
> **v1.2 变更点**（三家 Round 4 复核 → PASS after fixing P0，5 个新 P0）：
> - §6.4.0 vault 写入**模型重写**：sediment IPC → main pi 调 vaultWriter library（避免 daemon / socket auth / peer credential，与 ADR D6 不做 daemon 一致）
> - §6.4.0 + §11.2 补 vault concurrency lock：vault 目录级 flock + `_meta/<key>.md` append-only 结构
> - §11.2 dedupe 行 wording 修正：从“中期方案 dedupe”改为“接受最后写入赢（不假装解决 race）”
> - §6.5 wording 修正：“明文仅存于子 shell” → “execve 临界区短暂存于父进程内存（sub-ms 级）”
> - §6.6 streaming buffer 限定：仅对 §6.5.1 释放了 stdout 的 `$VAULT_*` 命令启用
> - §3.5 补 staging directory lifecycle + validateRouteDecision() enforceable gate
> - §4.1 boost 表补一行：staging 入 facade 默认排除（需 explicit `pi brain review-staging`）
>
> **v1.1 变更点**（三家 Round 3 复核 → PASS after fixing P0）：
> - §3.5 新增 deterministic router（Lane G/V 分类路由规范）
> - §4.1 明确 ranking boost 系数；§4.3 删除 `scope` 形参
> - §5.4 新增 active project 生命周期（boot-time snapshot）、§5.3 补 git root + worktree + remote canonicalize
> - §6.2 补平台矩阵（详 [vault-bootstrap.md](migration/vault-bootstrap.md)）
> - §6.4.0 新增「vault 写入的执行者与同步语义」
> - §6.5.1 新增「bash exfiltration 防御」（引用 `$VAULT_*` 的 stdout 默认不回流 LLM）
> - §6.6 补 redaction 实现层 + streaming buffer + warning
> - §11.2 表格补「同 project 同 slug 双写」行
> **决策者**：alfadb
> **作用**：把 ~/.abrain 从「跨项目 world knowledge 仓库」重定位为「alfadb 数字孪生 / Jarvis 大脑」之后的目录结构、读写路径、vault 双层安全边界、project 切换逻辑、多 pi 进程并发处理。
> **不作用**：不写代码、不写 schema 字段细节、不写工程排期；也不写 spawn-and-queue / thread / 长跑 daemon / 分身编排——这些归到 §10「明确不做」。
>
> 决策来源：三轮多模型辩论（Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）→ 用户重定位 abrain 为 Jarvis 大脑 → brain layout v0.1 → v0.2 收敛 → 本文档。

---

## 0. 与现有 ADR 的关系

- ADR 0003（主会话只读）：**保留**
- ADR 0013（Lane 三段）：**扩展**到四段（A/C/G/V），Lane B/D 失去意义
- memory-architecture.md：**部分 superseded by ADR 0014**（scope=project|world 二元划分被 brain 内部结构吸收，`.pensieve/` 物理位置废止）
- ADR 0014：本文档的决策记录

---

## 1. 顶层结构

```
~/.abrain/                              ← Jarvis 的全部大脑（私有 git repo）
├── identity/                           ← 我是谁
├── skills/                             ← 我会什么
├── habits/                             ← 我怎么工作
├── workflows/                          ← 我的常用 pipeline
├── projects/                           ← 我所有的项目
│   ├── _index.md                       ← portfolio view（sediment 顺手维护）
│   ├── _bindings.md                    ← cwd → project-id 映射
│   ├── pi-astack/
│   │   ├── decisions/
│   │   ├── knowledge/
│   │   ├── maxims/
│   │   ├── observations/               ← session-level summary，TTL 30d
│   │   ├── habits/                     ← 项目特定 habit（区别于全局 habits/）
│   │   ├── status.md                   ← 当前关注点 / 进度
│   │   └── vault/                      ← 项目级 vault（encrypted artifacts/meta 可进 git；plaintext/lock/tmp 不进 git）
│   └── work-uamp/
├── knowledge/                          ← 传统 world facts
├── vault/                              ← 全局 vault（encrypted artifacts/meta 可进 git；plaintext/lock/tmp 不进 git）
└── .gitignore                          ← 忽略 runtime state、lock、tmp；不忽略 encrypted vault artifacts

运行模型：
  N 个独立 pi 进程同时跑，互不通信
  每个进程通过 cwd 在 _bindings.md 中查 active project
  identity/skills/habits/workflows/knowledge 全局共享
  projects/<active>/ 是该 pi 的工作记忆
  vault 双层：全局（~/.abrain/vault/）+ 项目级（projects/<active>/vault/）
```

### 顶层简表

| 区域 | 性质 | 主要写入者 | 进 git | lifetime 默认 |
|---|---|---|---|---|
| `identity/` | 关于"我"的固定事实 | 用户主动声明 + sediment 提炼 | ✅ | permanent |
| `skills/` | 我会什么、熟练度 | sediment 提炼 + 用户校正 | ✅ | permanent，可衰减 |
| `habits/` | 我的行为模式 | sediment 提炼 + 用户校正 | ✅ | permanent，可衰减 |
| `workflows/` | 我的常用 pipeline | 用户主动声明 + sediment 提炼 | ✅ | permanent |
| `projects/<id>/<kind>/` | 项目工作记忆（原 pensieve） | sediment / 用户 | ✅ | 跟随项目 |
| `projects/<id>/vault/` | **项目级秘密** | 用户主动 + 项目内自动 ingest 元数据 | ✅ encrypted/meta；❌ plaintext/lock/tmp | permanent |
| `projects/_index.md` | portfolio view | sediment agent_end 顺手 | ✅ | derived |
| `projects/_bindings.md` | cwd 映射 | pi 启动时维护 | ✅ | derived |
| `knowledge/` | 跨项目 fact/pattern | sediment（原 world scope） | ✅ | permanent |
| `vault/` | **全局秘密** | 用户主动 + 全局元数据 ingest | ✅ encrypted/meta；❌ plaintext/lock/tmp | permanent |

---

## 2. 各区域细则

### 2.1 `identity/` — 我是谁

不会因项目切换、心情变化、几个月时间过去而失效的事。

示例：`cognitive-profile.md` / `values.md` / `self-narrative.md`。

写入：用户主动声明（Lane G）—— 高 trust；sediment 在跨多个 session/项目稳定观察才能写（高门槛）。

读出：每次 session 启动时 always 进 `/decide` 等高层工具的 advisory context。

### 2.2 `skills/` — 我会什么

技术或元能力 inventory。让 Jarvis 知道"alfadb 已经知道 TypeScript 了"。

写入：sediment 自动观察（看 transcript 处理的代码类型、回答的问题），用户校正。

### 2.3 `habits/` — 我怎么工作

观察出来的行为模式。区别于 identity（identity 是稳定的"我是谁"，habits 是统计上的"我倾向怎么做"）。

per-habit 多文件 SOT；外加 `habits/_snapshot.md` 是 derived view（每次更新整体 regenerate，不是 append-only）。

衰减：90 天没强化 → confidence 衰减；< 0.5 → status: deprecated（不删，标记不再用）。

### 2.4 `workflows/` — 我的常用 pipeline

你常做的"标准动作"。用户主动声明 + sediment 补完。

与 habits 的边界：habits 是"我倾向怎么做"（描述性），workflows 是"我有意识地跑过的标准流程"（规定性）。

### 2.5 `projects/` — 我所有的项目

这是吃掉旧 .pensieve/ 的核心区域。

#### 结构

```
projects/
├── _index.md
├── _bindings.md
└── <project-id>/
    ├── decisions/    knowledge/    maxims/
    ├── observations/      ← TTL 30d
    ├── habits/            ← 项目特定 habit
    ├── status.md          ← 当前关注点
    └── vault/             ← 项目级秘密（详见 §6）
```

#### `_index.md` 维护策略

> **简化决策**：不需要单独 sidecar daemon。每次 sediment 在 agent_end 写完该项目的 entries 后，顺手 regenerate 一次 _index.md。

逻辑：
1. 扫所有 `projects/<id>/status.md` + recent observations
2. 拼一份 portfolio markdown
3. 原子 rename 到 _index.md

每个 pi 进程在 agent_end 都跑这个动作。**幂等**——多次运行结果一致，最后赢的写入即当前真相。

代价：偶尔会出现两次 update 间的瞬间不一致（A 写完 _index 之后 0.5s 内 B 又覆盖）。这个不一致无副作用，因为 _index 是 derived view。

#### `_bindings.md`

```yaml
- cwd: /home/worker/.pi
  project: pi-astack
  bound_at: 2026-05-09
  bound_via: manual
  git_remote: git@github.com:alfadb/pi-astack.git
- cwd: /home/worker/work/uamp-full
  project: work-uamp
  bound_at: 2026-04-30
  bound_via: git_remote_match
```

详见 §5 Project Identity。

### 2.6 `knowledge/` — 传统 world-level facts

旧 ~/.abrain 顶层 maxim/decision/fact 全部搬进这里。

写入：sediment（自动观察跨项目稳定的 fact / pattern / maxim）。

与 identity/skills/habits/workflows 的关系：knowledge 是关于**世界**的（"git 历史不可重写"），那四个区域是关于**我**的。

### 2.7 `vault/` 与 `projects/<id>/vault/` — 双层秘密

完整规范在 §6。这里只列简表：

| 维度 | 全局 vault `~/.abrain/vault/` | 项目级 vault `~/.abrain/projects/<id>/vault/` |
|---|---|---|
| **场景** | 跨项目通用秘密 | 仅与某项目相关 |
| **典型** | github-token / anthropic-api-key / openai-api-key / aws-default / ssh-key / 私人事项 | prod-db-password / 项目特定 third-party API key |
| **可见性** | 任意 pi 进程都看得到 | 仅 active project = 该项目时可见 |
| **写入命令** | `/secret --global <key>` | `/secret <key>`（默认）或 `/secret --project=<id> <key>` |
| **.env 自动 ingest** | ❌ 不自动 | ✅ 写元数据到 `projects/<id>/vault/_meta.md` |
| **明文 LLM context** | 默认排除，需 `vault_release` 授权 | 同左 |
| **bash 注入** | `$VAULT_<key>`（解析时若全局有同名 key，被项目级覆盖）| 同左 |
| **进 git** | encrypted `.md.age` + `_meta/*.md` 可进 private git；lock/tmp/runtime state 不进 git | 同左 |

---

## 3. 写入路径

四条 Lane（扩展 ADR 0013）：

| Lane | 触发 | 目标 | 信任 | 状态 |
|---|---|---|---|---|
| **A** explicit MEMORY | `MEMORY: ... END_MEMORY` | `projects/<active>/` | 高 | ✅ 已有，迁移目标 |
| **C** auto-write | sediment LLM 后台 extract | `projects/<active>/` 或 `knowledge/`（跨项目稳定）| 中 | ✅ 已有，迁移目标 |
| **G** about-me declare | `/about-me <text>` 或 `MEMORY-ABOUT-ME: ... END_MEMORY` | `identity/` 或 `habits/` 或 `skills/` | 高 | 🟡 **pending** —— 仅架设，代码未实现（grep `registerCommand("about-me")` 0 命中），待 P0d 后 Lane G writer ship |
| **V** vault declare | `/secret <key>` 等系列命令（详 §6） | `vault/` 或 `projects/<active>/vault/` | 最高 | 🆕 |
| ~~B promote~~ / ~~D auto-promote~~ | — | — | — | ⛔ 失去意义（abrain 内部不需要 promote） |

### 3.1 Lane A 迁移（自动）

旧：用户 `MEMORY:` block → `<cwd>/.pensieve/`
新：用户 `MEMORY:` block → `~/.abrain/projects/<active>/`

active 由 §5 cwd→project 决定。

### 3.2 Lane C 迁移（半自动）

旧：sediment 写 `<cwd>/.pensieve/<kind>/`
新：sediment 写 `~/.abrain/projects/<active>/<kind>/`

新行为：sediment 抽取的 entry 如果是**跨项目通用**（"git 历史不可重写"），写到 `knowledge/`；否则写到 `projects/<active>/`。判断：抽取 prompt 里加一句"这条 fact 是关于这个具体项目，还是关于一般工程实践？"。

### 3.3 Lane G — about-me declare（新）

```
/about-me 我对 over-engineering 过敏，宁可砍 feature 也不要复杂度
```

或 fence：
```
ABOUT-ME:
我倾向先做 MVP 再讨论长期架构。
END
```

sediment 收到后写到 `identity/` 或 `habits/` 或 `skills/`（看内容由 sediment 决定子目录）。**不进 vault**。

### 3.4 Lane V — vault declare（新）

详 §6.4 命令语义。

### 3.5 Deterministic router

> **为什么需要这个节**：Round 3 复核中 Opus + GPT 同时指出“七区互斥依赖 sediment prompt 分类”不可执行，不符合 ADR 0013 的 enforceable gate 原则；““sediment 看个人意证””会在实操中漂移。本节把路由逻辑从 prompt 升为 deterministic spec。

#### 两阶段路由

**Stage 1 — 按 Lane 预分流**（不可跳过）：

| Lane | 预分流范围 |
|---|---|
| **A** explicit MEMORY | 始终 `projects/<active>/<kind>/`，取决于 block 中 `kind:` 提示或 sediment 默认 `decisions/` |
| **C** auto-write | 默认 `projects/<active>/<kind>/`；sediment 评估“跨项目文本证据充分”才能升级到 `knowledge/` 或全局 `habits/skills/workflows/`（评估规则：同一语义在≥2 个独立项目出现，或体现为与项目代码无关的一般工程实践） |
| **G** about-me declare | 只能写 `identity/` / `habits/` / `skills/` 三区之一。**不能写 `knowledge/`**（“关于我”不是“关于世界”） |
| **V** vault declare | 始终 `vault/` 或 `projects/<active>/vault/`，由命令 flag 决定 |

**Stage 2 — 在 Lane 允许范围内按 aboutness 路由**（只对 Lane G 与 Lane C 需要）：

| aboutness 特征 | 写入 |
|---|---|
| 关于“我是谁”的稳定自述（价值观 / 认知偏好 / 个人叙事） | `identity/` |
| 观察到的重复行为模式（“我倾向这么做”） | `habits/` （全局）或 `projects/<id>/habits/`（项目仅） |
| 可执行步骤集合（“记一下我的 X 流程”） | `workflows/` |
| 项目内事实 / 实验结果 | `projects/<active>/knowledge/` 或 `decisions/` |
| 跨项目世界 fact / pattern（不依赖项目上下文） | `knowledge/` |
| 技术 / 元能力 inventory | `skills/` |

**Stage 3 — ambiguous 处理**：如果两阶段后 sediment 仍无法唯一决定（多个 aboutness 特征同时命中或 `routing_confidence < 0.6`），默认写入到 `projects/<active>/observations/staging/<YYYY-MM-DD>--<pid>--<session-start-epoch>.md`——v1.3 补 session-start-epoch（Round 5 DS P1-C）避免 pid 复用：pi A 退出后 pid 被 pi B 拿到会写到同一文件造成两个 session entries 混同文件。session-start-epoch = pi 进程启动时 `Date.now()`，单调递增。**不直接写 identity/habits**——不变量 #1 的 trust budget 下漂移代价高。

#### Staging lifecycle（v1.2 补，Round 4 Opus P1 3-3）

- **Facade boost**：staging 目录**默认不进 `memory_search` 结果**，不与§4.1 三层 surface 混排序。避免“我不肨定”的条目以高优先级进 LLM context
- **读出仅限 review**：`pi brain review-staging` TUI 命令列出需 review 条目，用户按条选：(a) accept → 移到目标区域 + 带原 routing_reason 入 timeline；(b) reject → 从 staging 移除并记 audit；(c) defer → 保留。
- **过期策略**：staging 文件 30 天未被 review → sediment 打一个 `abandon staging entry slug=X reason=stale` audit 行，然后删除。**静默丢弃会被 audit 备案**。
- **routing_confidence threshold**：默认 0.6，可通过 `~/.abrain/.state/facade-config.yaml` 调（`router.staging_threshold`）
- **不受 observations TTL 30d 影响**：staging 与 §2.5 observations 的 30d TTL 隔离——staging 有其独立 30d 未-review 过期机制。

#### validateRouteDecision（v1.2 补，Round 4 GPT P1-N4： router enforceable gate）

router audit 字段仅是记录；sediment writer 在写入前必须调 `validateRouteDecision(decision)` enforce，未通过拒写：

```typescript
function validateRouteDecision(d: RouteDecision): asserts d is ValidRouteDecision {
  // 1. lane allowlist
  const allowed = laneAllowlist[d.lane];          // G→{identity,habits,skills}、V→{vault,*/vault}、A/C→projects/<id>/* 与 knowledge
  if (!allowed.includes(d.chosen_region)) throw new RouterError('lane-target mismatch');
  // 2. chosen · candidates
  if (!d.route_candidates.includes(d.chosen_region)) throw new RouterError('chosen not in candidates');
  // 3. confidence gate
  if (d.routing_confidence < 0.6) {
    if (d.chosen_region !== 'staging') throw new RouterError('low confidence must route to staging');
  }
  // 4. Lane G hard exclusions
  if (d.lane === 'about_me' && ['knowledge','workflows','projects'].includes(d.chosen_region)) {
    throw new RouterError('Lane G cannot write to knowledge/workflows/projects');
  }
  // 5. Lane C global escalation requires evidence
  if (d.lane === 'auto_write' && d.chosen_region in {knowledge:1, habits:1, skills:1, workflows:1}) {
    if (!d.evidence || d.evidence.distinctProjectCount < 2) {
      throw new RouterError('Lane C global region requires ≥2 distinct project evidence');
    }
  }
  // 6. fields completeness
  for (const f of ['lane','chosen_region','route_candidates','routing_reason','routing_confidence']) {
    if (d[f] === undefined) throw new RouterError(`missing audit field: ${f}`);
  }
}
```

拒写场景写一行 `sediment-events.jsonl` `op=route_rejected reason=...`，原始输入入 `staging/rejected/<date>--<pid>.md` 供人工检查（避免静默丢入作样本）。

#### Audit 字段（本路由过程必须可追责）

`sediment-events.jsonl` 除 ADR 0014 §审计扩展提到的 lane enum 外，另增四个 router 字段：

```jsonc
{
  "route_candidates": ["identity", "habits"],     // Stage 2 多选时上报
  "chosen_region": "identity",
  "routing_reason": "strong-self-narrative-signal", // sediment 给出的分类理由
  "routing_confidence": 0.82                       // 低于 0.6 才进 staging
}
```

#### 测试责任

P3 实施阶段必须交付一组路由 fixture（正反例各 5-10 条）覆盖：
- identity vs habit 边界（"我倒向 over-engineering" vs "我通常先跑 smoke"）
- workflow vs habit 边界（"git rebase 前先 stash" 是 workflow 还是 habit？）
- skill vs identity 边界（"我熟 TypeScript" vs "我重视类型安全"）
- project knowledge vs world knowledge 边界（"pi sediment 在 agent_end 后跑" vs "git 历史不可重写"）

---

## 4. 读出 — memory facade 新行为

### 4.1 默认查询面

按相关度融合三个 surface，每个 surface 在 RRF 融合**之前**在其原始得分上乘 boost：

| Surface | 范围 | Boost |
|---|---|---|
| **active project** | `projects/<active>/*`（**排除** `staging/` 与 `staging/rejected/`） + `projects/<active>/vault/_meta/*` | **2.0×** |
| **about-me + world** | `identity/` `habits/` `skills/` `workflows/` `knowledge/` `vault/_meta/*` | **1.0×**（baseline） |
| **other projects** | `projects/<other-id>/*`（**不含**他们的 vault）同样排除 staging | **0.3×** |
| **staging 与 rejected** | 仅通过 `pi brain review-staging` TUI 可见，不进 facade | **excluded** |

这些系数是 baseline，可通过 `~/.abrain/.state/facade-config.yaml` 调。insertion point：在 RRF 融合**之前**对每个 backend 的原始得分乘 boost，不是融合后 rescore——这保持与 [memory-architecture.md §7](memory-architecture.md) 的 RRF 抽象一致。

> **ADR 0015 update（2026-05-10）**：当前 Phase 1 实现尚未启用七区物理拓扑，因此 `memory_search` 默认先在 parsed entries 上构造 enhanced index，再用双阶段 LLM retrieval 做候选选择与精排。上表 boost 系数仍是 facade ranking policy 的目标形态；当 active/other/about-me surface 物理路由启用后，系数作为 stage1/stage2 prompt 的 ranking hint 或 pre-score 特征输入，而不是暴露给 LLM 作为 scope selector。

### 4.2 Vault redaction 规则

| 命中内容 | facade 返回 |
|---|---|
| 全局 vault `_meta.md` 或加密文件 frontmatter | key + description + `🔒 use $VAULT_<key>` |
| Active project vault 同上 | 同上 |
| 其他 project 的 vault | **不返回**（连元数据都不暴露） |
| 加密体（明文 value） | **永远不解密进 facade**——只通过 `vault_release` 工具单独申请 |

### 4.3 Cross-project 召回

```
memory_search(query)
```

**签名无 `scope` 形参**。三个 surface 的混合排序完全在 facade 内决定（§4.1 boost 系数）。ADR 0015 之后，`query` 语义是 natural-language retrieval prompt，内部由 LLM 跨中英文/同义改述做语义匹配；schema 仍不暴露 scope/backend/source_path。

> **为什么不暴露 scope**：Round 3 复核 Opus P0-3 指出——只要 `scope` 出现在 schema 里，LLM 在召回压力下必会传（“为了准确你只看当前项目吧”），facade 的 ranking 控制权悸然外迁。不变量 #3 为此出在每个 ranking surface 升级为硬约束。

未来如果真需要 "只看活跃项目" 意图（极罕见），通过新增 dedicated tool 暴露（如 `memory_search_active_only(query)`），不用 polymorphic 形参。

> `memory_get(slug)` 是 exact lookup 调试接口，可返回 scope/source_path 供实施者 debug——不与 ranking surface 的不变量 #3 冲突（LLM 看到 provenance 也无法据此选后端，facade 仍唯一）。

---

## 5. Project Identity — cwd 映射

### 5.1 stable id 来源（优先级）

1. **git remote URL**（最可靠）
2. **首次绑定时生成的 UUID**，存到项目根 `.pi-project-id`（要不要进 git 由用户）
3. **手动 alias**（`pi project bind <name>`）

### 5.2 首次进入未绑定 cwd

pi 启动 → 看 cwd → 在 `_bindings.md` 查不到 → TUI 提示：

```
新 cwd: /home/worker/foo
未绑定项目。

  [1] 新建项目 "foo"（默认从目录名）
  [2] 关联到现有项目（输入 project-id）
  [3] 暂不绑定（不写知识，本 session 结束后无任何持久痕迹）
```

绑定后写到 `_bindings.md`，下次自动切换。

### 5.3 git remote 优先

cwd 有 git remote 且某 project 已绑定相同 remote → pi 自动认为是同一 project，不问用户。

**实施细则**（v1.1 补充）：
- pi 启动时 `cwd` 先从子目录向上找到 git root（`git rev-parse --show-toplevel`），以 git root 为查询键
- `_bindings.md` 查询顺序：exact git root match → 最长前缀 cwd match（避免 worktree 坍陷）
- git remote URL 在 match 前先 canonicalize：`git@github.com:owner/repo.git` 与 `https://github.com/owner/repo` 视同；十三位 hash hex 不部分匹配
- 同 remote 多个 worktree 映射到同 project——worktree 是同一项目的并行 view
- remote URL 变更（公司 fork → 个人 fork）不自动 rebind，TUI 提示“remote URL 变了，是还是同一项目？”让用户决定

### 5.4 active project 生命周期

> **为什么需要这个节**：Round 3 复核 Opus P0-5 指出——pi 是长生命周期 TUI，session 中 LLM 可以 `cd /home/worker/work/uamp-full` 然后跑 bash。如果 active project 是 dynamic（跟 cwd），一句 `cd` 就能令 LLM 跨 vault——直接破坏不变量 #4。

**决定**：active project = **pi 启动时的 cwd → 项目映射的 boot-time snapshot**。Session 中通过 bash `cd` 不改变 active project。

**要切项目必须**：
- 重启 pi，或
- 显式调用 `pi project switch <id>` 命令——该命令触发新一轮 keychain unlock check + TUI 确认 + 重新加载 active project's vault

**应用范围**：
- `$VAULT_<key>` 解析 → boot-time active project's vault → 全局 vault。与 bash 当前 cwd 无关
- `memory_search` ranking boost → boot-time active project → boost 2.0×
- sediment writer 路由 → 项目类写入走 boot-time active project——即使用户 cd 到其他项目但未重启 pi，sediment 仍写到启动时的项目。**这是有意选择**：重启边界明确 > UX “跳转项目的便利”。

**Edge case**：pi 启动时用户选择 “[3] 暂不绑定”（§5.2）：active project = **none**。这个状态下：
- `$VAULT_<key>` 只查全局 vault
- `/secret <key>` 不加 `--global` flag 拒绝写入（项目级无目标）
- sediment 不写 `projects/<任何>/`，Lane A 与 Lane C 都拒绝写入（仅 Lane G 可写全局区域）

---

## 6. Vault 完整规范（双层）

### 6.1 加密

- **算法**：age（rust 实现，简单可靠，成熟生态）
- **粒度**：单文件加密（每个 secret 一个 `.md.age`）
- **理由**：粗粒度（整个 vault 一个加密容器）解锁体验差；单文件支持选择性 unlock 和损坏隔离
- **master key**：单一一把（**全局 vault 和所有项目 vault 共享同一 master key**）
  - 让用户管 N+1 把 key 太烦；攻击者拿到 master 就拿到全部，单 key 是合理的简化
  - 如果将来发现真的需要分级（比如某个 client 项目要更高 isolation），再加 per-project master—— v0.x 再考虑

### 6.2 解锁（v1.4 重写）

- **每个 pi 进程启动时独立取 master key**（毫秒级开销）
- 不引入共享 vault daemon，保持“无长跑进程”的纯净
- **解锁依赖于用户已有的便携加密 identity**（v1.4 从 OS keychain 依赖转为 portable identity 优先，详 [vault-bootstrap.md §1](migration/vault-bootstrap.md#1-平台支持矩阵v14-重写)）：
  - **Tier 1 primary**：ssh-key（`age -d -i ~/.ssh/id_*` + ssh-agent cache）/ gpg-file（`gpg --decrypt` + gpg-agent cache）/ passphrase-only（age scrypt + main pi /dev/tty prompt）——三者覆盖几乎所有 dev 用户
  - **Tier 2 optimization**（可用则优，UX 更顺）：macOS Keychain / Linux Secret Service / pass(1)
  - **容器场景（alfadb 主开发环境）**：ssh-key 路径 OOTB 工作——从 v1.0-1.3 的 “不支持” 升 first-class（v1.4 desktop-bias correction 修复了这个 design-from-stereotype 错误）
  - **CI**：默认 fall through 到 passphrase-only；推荐主动 `touch ~/.abrain/.state/vault-disabled` opt-out
- **auto-unlock 等价物**：ssh-agent / gpg-agent cache TTL（user-tuned ≥8h 近似 keychain "unlocked while logged in"）
- **取不到 master key 时 fail-closed**（不转明文备胎）：vault 元数据可读，value 保持加密，bash 注入拒绝 + 报错提示「vault locked；重启 pi 或检查 `~/.abrain/.vault-master.age`」（注：`/vault unlock` 命令未实现，unlock 走启动时 backend auto-detect + master decrypt）。全进程生命周期 TUI footer 持续显示 `vault: locked`
- **无超时 lock**（用户接受永远在线换便利；机器被偷或被未授权 ssh 时攻击者可读 vault——这个 trade-off 已知已选）

### 6.3 LLM context 边界

| 内容 | 默认 | 如何获取 |
|---|---|---|
| key name + description | 进 context（按 §4.2 scope 过滤） | always |
| value 明文 | **不进 context** | `vault_release(key, scope?, reason)` 工具调用 + TUI 授权 |

授权粒度（**default-deny 顺序**——non-interactive / API runner 会自动选第一项，因此 deny 必须在第一位）：
- `[N]o`：拒绝（默认）
- `[D]eny + remember`：拒绝并写到 vault entry metadata，未来同样请求自动拒绝
- `[Y]es once`：单 turn 释放
- `[S]ession`：当前 pi 进程生命周期内同 key 不再问

实际渲染顺序见 `extensions/abrain/index.ts:VAULT_RELEASE_AUTH_CHOICES`（v1.4.6, 2026-05-10）。

### 6.4.0 vault 写入的执行者与同步语义

> **为什么需要这个节**：Round 3 Opus P0-2：`/secret github-token ghp_xxx` 后用户立刻在 bash 里 `gh repo list` 期望 `$VAULT_github_token` 可用。若走 sediment agent_end 异步（5-30s）happy path 失败。
>
> **v1.2 重写**（Round 4 三家点出 N1）：v1.1 原描述“TUI → IPC 调 sediment 进程 → 同进程加密落盘”，这引入三层新工程面：(a) sediment daemon 生命周期，与 ADR D6“不做 daemon”矛盾；(b) UDS / named pipe 需 peer credential 验证，同 user 任意进程可旁路；(c) sync IPC 与 async agent_end 调度冲突。三层问题 v1.2 用 library 调用跳出。

#### 决策：**main pi 进程内同步调用 vaultWriter library**

```
user 键入 `/secret <key> <value>`  (TUI command, not LLM tool)
  → main pi 的 abrain/vault command handler
     → 同步 require('./vault-writer') (in-process library)
        → flock(vault_dir + '/.lock')           // §下 vault concurrency
        → age-encrypt(value, vault_pubkey)
        → write tmp + fsync
        → atomic rename → vault/<key>.md.age
        → append _meta/<key>.md (per-key file, §下)
        → append vault-events.jsonl + fsync
        → unflock
     → 返回 TUI
  → `$VAULT_<key>` 立即在后续 bash 可用
```

**不走 sediment IPC**、**不引入新进程**。vaultWriter library 在 `extensions/abrain/vault-writer.ts`。

#### vaultWriter substrate API 边界（v1.3 补，Round 5 Opus NP1-4）

vaultWriter 复用 sediment 的 substrate但**仅限以下明确清单**，避免隐式耦合到 sediment 的 `.pensieve` / project scope / sediment audit 路径：

- `extensions/_shared/entry-substrate/frontmatter.ts`（待抽）：frontmatter schema 验证
- `extensions/_shared/entry-substrate/sanitize.ts`（待抽）：plaintext 表净化、non-printable 过滤
- `extensions/_shared/entry-substrate/atomic-write.ts`（待抽）：write tmp + fsync + atomic rename helper
- `extensions/_shared/audit/append.ts`（待抽）：audit jsonl append + fsync，per-stream（sediment-events vs vault-events）

**明确不在 substrate 中**（vaultWriter **不**应该 import）：
- `extensions/sediment/writer.ts`（含 `.pensieve` / project slug / sediment checkpoint 耦合）
- `extensions/sediment/dedupe.ts`（vault 不需语义 dedupe——同 key 覆写走事务 lock，不是语义 dedupe）
- `extensions/sediment/index.ts`（agent_end handler）

P3 实施阶段交付 vaultWriter × sediment substrate 的 contract test（migration §5 验收清单）——sediment 改 substrate 时必跑该测试。

#### 主 session LLM enforcement（ADR 0003 补充不取消）

v1.3 将不变量 #1 wording 拆为两段（Round 5 Opus NP1-1：避免“修辞先于机制”）：

**层 1 mechanic enforcement**（机制性不变量）：LLM tool call surface 中**没有**定制 brain mutation tool——没有 `vault_write` / `vault_put` / `secret_*` / `brain_write` 这类专门入口。sediment 仍为异步记忆写入唯一 dedicated writer；vaultWriter library **仅在 abrain extension activate 期间被 TUI command handler 同进程调用**。

**层 2 best-effort residual surface**（已知 trade-off，不是机制保证）：LLM 仍可通过通用 tool（bash / edit / write / dispatch_agents）间接写 brain SOT——例如：

```bash
# bash 路径一：直接调 keychain + age CLI、手写加密文件
secret-tool lookup service abrain key master | age -e -r $(cat ~/.abrain/.vault-pubkey) > ~/.abrain/vault/foo.md.age
# bash 路径二：node -e require vaultWriter library 直接调用
node -e 'require("/path/to/extensions/abrain/vault-writer.js").writeSecret("key","v")'
# bash 路径三：bash spawn 子 pi（不走 dispatch_agents）不带 PI_ABRAIN_DISABLED
pi /secret malicious-key "$(cat ~/.ssh/id_ed25519)"
```

这三条路径**都**可能被 prompt injection 诱导。层 1 机制不覆盖它们。防御手段是装装装：§6.5.1 stdout 默认不回流（限 exfiltration）、§6.6 redaction（限明文看见）、sediment audit 后置检测（限事后追责）——三者合起来压低面但不消除。列为已知 trade-off于 ADR 0014 §坟处 #10。

vaultWriter library 本身的保护：

- **writeSecret 不持有 master key**。vault-writer.ts 仅导入 `.vault-pubkey`（age 公钥，磁盘明文），不调 unlock、不解密 `.vault-master.age`。即使 `require()` 拿到 `writeSecret`，也只能加密写入——无法解密读取已有 secret。
- **TUI 授权在调用方实施**。`/secret set` command handler 在调用 `writeSecret` 之前完成 TUI 授权（`VAULT_RELEASE_AUTH_CHOICES`），`writeSecret` 自身是纯加密+写函数，不做授权判断。
- **bash 路径二的 residual surface 已接受**：`node -e 'require(".../vault-writer.js").writeSecret({...})'` 是 Node.js 模块系统的固有属性（`export` 即 `require` 可见），无法在语言层面阻止。防御依赖：该路径需要攻击者自行提供 plaintext value（若已有 plaintext，保护目标已失）；写入操作产生 audit trail（vault-events.jsonl）；stdout 默认不回流（§6.5.1）。
- v1.0 spec 曾声称 "不在 module-level export 公开 writeSecret API"——该声明在 Node.js ESM/CJS 模块系统中不可行，v1.5 修正为上述实际保护描述。bash 路径一与三仍是 residual surface。

#### 事务语义（v1.3 统一顺序，Round 5 DS P0-A）

v1.2 同节内两处顺序描述自相矛盾（流程图 vs 文字）。v1.3 选 **顺序 A（rename 在前、audit 在后）**——理由：secret 是 source of truth、audit 是 derived；数据不丢优先级 > 可追溯；orphan audit row 恢复难于缺失 audit row。

```
flock(vault_dir + '/.lock')
  → age-encrypt(value, vault_pubkey) → write tmp + fsync
  → atomic rename → vault/<key>.md.age          (★ SOT 已落盘 ★)
  → append _meta/<key>.md + fsync
  → append vault-events.jsonl + fsync
→ unflock
→ 返回 TUI
```

**Crash recovery**：如果 crash 发生在 atomic rename 之后、vault-events append 之前，secret 已落盘但 audit 没有 row——这是“丢 audit 不丢 secret”，多于 “丢 secret 但有 audit”。息复活：

vaultWriter library 启动时跳一次 reconcile：
```typescript
// pseudo-code
for each *.md.age in vault/:
  if file.mtime > last-vault-events.jsonl ts:
    if no "create" audit row for this slug since file.mtime:
      append { op: "recovered_missing_audit", slug, mtime, recovered_ts: now() }
```

这个 reconcile **不在 hot path**——仅 vaultWriter 初始化时跑一次，后续写入不检查。

**失败场景**（同 v1.2）：keychain locked / 磁盘满 / age 库调用错 / vault-events append 失败。但添加：如果 rename 已成功但 vault-events append 失败，TUI 报错但 secret 已落盘可用；下次启动 reconcile 补 audit row。

**Paused-reject 路径的 plaintext 残留**（v1.3 补，Round 5 Opus NP1-5）：migration 期间用户键入 `/secret` 被拒 —— user typed plaintext 在 reject return 前驻留 main pi node.js heap。同 §6.5 execve 临界区存在 sub-ms 级窗口，主 pi crash 且 core dump 在该窗口发生可能泄一个 key。列为已知 trade-off，不进一步防御。

#### Vault concurrency（v1.2 补，Round 4 DS P0-1/P0-2）

两个 pi 同时跳一条同 key `/secret` 的场景罕见但不能静默丢：
- **vault 目录级 flock**：`flock(<vault_dir>/.lock)`（全局 vault 与项目级 vault 各一个锁）。在事务开始加锁、返回前释锁
- **`_meta/<key>.md` per-key 文件**（从 v1.0/v1.1 的单个 `_meta.md` 改为每个 key 独立文件）——消除 read-modify-write 覆盖；不同 key 完全独立文件，application-level 无冲突
- `_meta/<key>.md` 本身为 append-only timeline（与 ADR 0013 maxim/decision/knowledge 一致的 timeline 格式），记录 created/rotated/forgotten 历史
- key list 查询不需独立 _meta.md：扫 `_meta/*.md` 目录

**独立 audit log**：Lane V 走 `~/.abrain/.state/vault-events.jsonl`（不与 sediment-events.jsonl 混）。详见 ADR 0014 §审计扩展。

### 6.4.0.1 P0c.write 实施 invariant（v1.4.3 补，为实现代码准备）

v1.4.3 把 P0c 拆为 **write path** 与 **read path** 两段——理由：vault 写入仅需 `~/.abrain/.vault-pubkey`（明文 age 公钥），**完全不接触 master key plaintext**；只有读（解密 secret）才需 unlock master。这让 write-first 实施 ship 时安全 surface 远小于 read，非常适合作为 dogfood 起点。

#### inv1 —— write 路径不接触 master key plaintext

vaultWriter 仅 import `~/.abrain/.vault-pubkey`（一行 age1xxx public key）；不调任何 unlock helper、不解密 `~/.abrain/.vault-master.age`、不接触 ssh-agent / gpg-agent。所有写入 = `age -r <pubkey> -o <out>` + stdin pipe value。这是 P0c.write 与 P0c.read 的最大安全差异。

#### inv2 —— 用户 typed plaintext 仅在 main pi 内存 + GC 可回收

`/secret set <key>=<value>` 中 value 字符串在 main pi node.js heap 中存在直到 vaultWriter return（同 §6.4.0 paused-reject 同类已知 trade-off）。MVP one-line form 把 value 短暂暴露于 handler args string；TUI 的 prompt form（mask input）留 P0d。

**plaintext 不应该出现在**：vault-events.jsonl audit row、_meta/<key>.md timeline、stdout/stderr 任何打 log、子进程 argv（age 通过 stdin pipe 接收 value）。

#### inv3 —— 事务顺序（同 §6.4.0 顺序 A）

```
(0) flock(<vault_dir>/.lock)                    # 全 vault dir 一锁
(1) age -r <pubkey> < value > tmp + fsync       # plaintext via stdin
(2) atomic rename → vault/<key>.md.age (0600)   # ★ SOT 落盘 ★
(3) append _meta/<key>.md + fsync               # timeline
(4) append vault-events.jsonl + fsync           # audit
(5) unflock
```

Crash recovery (§6.4.0)：(2) 后 (4) 前 crash → secret 已落盘但 audit 缺。reconcile 在 vaultWriter 初始化时跑一次，scan vault/*.md.age vs vault-events.jsonl，缺则补 `op=recovered_missing_audit`。

#### inv4 —— flock acquire/release in finally

```typescript
let lockFd = -1;
try {
  lockFd = await acquireFlock(vaultDir);
  // ... (1)..(4)
} finally {
  if (lockFd >= 0) await releaseFlock(lockFd);
}
```

异常路径必须释放，否则 vault dir 永久锁死。

**Lock 实施（v1.4.3 dogfood 考虑）**：

- 初设计译过用 `flock(1)` 子进程 + sentinel sleep loop 持锁，SIGTERM 释放。**该设计有致命缺陷**：SIGTERM 不会传递给孙子 `sh -c '...sleep 86400...'` 进程，每次 acquire 都泄漏一组 zombie。实际跑 P0c.write smoke 时泄了 50+ zombie 进程，被用户在 ~1138s 后发现。
- 采用设计：**纯-Node atomic file creation lock**。`open(lockPath, 'wx')` 原子创建，内容为 `pid\nts\n`。调用者 EEXIST 时读取 holder pid + ts，检测 stale （`process.kill(pid, 0)` ESRCH 表示进程已死 / age > MAX_LOCK_AGE_MS 表示超老），stale 则 unlink 后重试。零依赖、不 spawn 子进程、不需信号链。
- **并发语义与 flock(2) 一致**：同进程/跨进程同一 vault dir 上互斥；crash 后下一 acquirer 自动接管。差于 flock(2) 之处：polling 不是 event-driven（vault 写低频可接受）；NFS 上不严格 atomic（abrain home 在本地，不走 NFS）。
- 详见 `extensions/abrain/vault-writer.ts` 中 `acquireLock` / `tryReclaimStaleLock` 的完整实现。

#### inv5 —— `<key>.md.age` mode 0600（同 .vault-master.age v1.4.1 dogfood）

age `-o` 受 umask 影响（容器 umask=0002 → 0664）。**rename 前的 tmp 与 rename 后的 final 都必须 chmod 0600**。理由：单个 secret 文件的最小化 attack surface。tmp 模式 0600 防止
atomic rename 之前的极短时间窗口被同 host 其他进程读到。

#### inv6 —— `_meta/<key>.md` 是 append-only timeline（不是 replace）

格式（与 ADR 0013 maxim/decision/knowledge timeline 一致）：
```markdown
# Vault key: github-token

scope: global
created: 2026-05-10T15:30:00Z
description: GitHub PAT for read:user + repo

## Timeline

- 2026-05-10T15:30:00Z | created | scope=global | size=68B
- 2026-05-11T09:00:00Z | rotated | size=68B
- 2026-05-12T10:00:00Z | forgotten | by=user
```

rotate / forget 不删 _meta，append timeline row。`_meta/<key>.md` 永不删除——**用户能 audit 历史**。`<key>.md.age` 文件 forget 时 rm（真删）。

#### inv7 —— /secret 默认 scope = boot-time active project（P1 落地）

> **变更（2026-05-11）**：原 inv7 写 "P0c.write MVP 强制 `--global`，未来 P1 默认项目级" 已 stale。ADR 0014 P1 已落地（commits `83e69b5` / `5cec660` / `64378bd`），下文为当前 shipped 语义。

项目级 vault (`~/.abrain/projects/<id>/vault/`) 由 `resolveActiveProject(cwd, { abrainHome })` 在 `activate()` 中 **boot-time 一次性 snapshot**（ADR 0014 §5.4——session 中 `cd` 不变更 vault 可见性；要切换需要 `pi project switch <id>` 或重启）。

`/secret set/list/forget` 当前 scope 解析：
- 无 flag → boot-time active project（解析失败时 fail-closed，给出 actionable reason：`bindings_missing` / `unbound` / `ambiguous_remote` / `ambiguous_prefix`）
- `--global` → 显式 global opt-out
- `--project=<id>` → 显式指定其他 project（不要求是 active）
- `--global` 与 `--project=<id>` 互斥；`--all-projects` 仅 `list` 子命令支持，枚举所有 project metadata（不解密）

具体实现：`extensions/abrain/index.ts:parseSecretScopeFlags`（line ~214）+ `resolveSecretScope`，覆盖见 `scripts/smoke-abrain-secret-scope.mjs`。

#### inv8 —— ~~P0c.write 不实施 read 路径~~ （已过时：P0c.read 同期 ship）

> **状态（2026-05-11 更新）**：P0c.read 与 P0c.write 已同期 shipped——`release` / `bash $VAULT_*` 注入 / `vault_release` LLM tool 全部落地（实现：`extensions/abrain/vault-reader.ts`、`extensions/abrain/vault-bash.ts`、`extensions/abrain/index.ts:607-628`；Audit op closure 见 ADR 0014 §D4 与 `vault-bootstrap.md`）。历史限定仅作设计思路快照保留。

**当前 · read 路径实际覆盖**：
- `/secret list` 仅返回 _meta（key + scope + description + timeline），不解密 value。
- `vault_release(key, scope?, reason?)` ：pre-flight key existence check（不存在 → `release_blocked` audit + 跳过授权 prompt）→ deny-first 授权 prompt（含 key description 与 reason 渲染、默认 deny，i18n 本地化）→ unlock master → per-key decrypt → literal redaction helper 。
- bash 侧三前缀：`$VAULT_<key>`（active project 优先，fallback global） / `$PVAULT_<key>`（仅 project） / `$GVAULT_<key>`（仅 global）。env file 0600 短生命 + `trap rm -f` 自清理；stdout 默认不回流 LLM（`bash_output_withhold` audit）。
- audit op closure：`release` / `release_denied` / `release_blocked` / `bash_inject` / `bash_inject_block` / `bash_output_release` / `bash_output_withhold`。


```bash
# 写入
### 6.4 命令语义（双层关键）

```bash
# 写入（现状）
/secret set <key>=<value>                       # 默认写到项目级（active project；未解析拒写）
/secret set --global <key>=<value>              # 写到全局 vault
/secret set --project=<id> <key>=<value>        # 写入指定项目 vault（少用）
# 备注：/secret set 暂不接受 --description 选项（P0d 架设）。

# 读取（仅元数据）
/secret list                       # 当前 active project + global 可见 keys
/secret list --all-projects        # 列出所有 project vault 的 keys（仅元数据）

# 删除
/secret forget <key>               # 默认从 active project 删
/secret forget --global <key>      # 删全局
/secret forget --project=<id> <key>

# 释放（明文给 LLM）
vault_release(key)                            # tool call，不是 slash 命令
vault_release(key, scope="global"|"project")

# Bash injection（bash 子进程接受 env）
$VAULT_<key>   $PVAULT_<key>   $GVAULT_<key>

# 待实施（P0d / Lane V import path，grep 0 命中）
# /vault import-env <path>           —— .env 批量导入项目级 vault
# /vault import-env --global <path>
```

#### `/secret list` 输出格式（v1.4.4 dogfood）

```
global vault — N key(s):
  <key>  (since <created-ISO>)  — <description>
  <key>  [forgotten] forgotten <forgotten-ISO>  — <description>
```

关键：在 forgotten 状态下显示 `forgotten <ts>`（最近一次 forget 的 ISO 时间）——**不是** `(since <created>)`。原因：dogfood 发现“在 forgotten 状态下显示 created”让用户误读为“那个时间被忘”。listSecrets 解析 `_meta/<key>.md` 中最后一条 `forgotten` timeline 行的 ts 作 forgottenAt。

### 6.5 bash 工具注入

LLM 生成的 bash 命令含 `$VAULT_<key>`：

**解析顺序**：
1. **active project's vault**（`projects/<active>/vault/<key>.md.age`）——active project 依 §5.4 boot-time snapshot
2. **global vault**（`vault/<key>.md.age`）
3. 都没有 → 主进程在执行前 short-circuit 报错给 LLM："vault key `<key>` 不存在"

**项目级覆盖全局**：如果两层都有同名 key，用项目级（用户在项目里覆盖了全局默认）。

**显式区分**（如需）：
- `$VAULT_<key>`：按上面顺序（默认）
- `$GVAULT_<key>`：强制全局
- `$PVAULT_<key>`：强制项目级

主进程拦截 → 解密 → 注入 env → 子 shell expand。LLM 看到的命令字符串**始终是变量名，不是明文**。

**实现层**（v1.1 补充）：bash 工具 wrapper（`extensions/abrain/bash-injection.ts`调家）在 pi tool sandbox 层拦截，不是：
- ~~main pi 进程加载所有 vault 明文到内存~~（core dump 泄漏风险）
- ~~sediment 事后 redact~~（bash output 已回流，redact 太晚）

bash wrapper 按需 lazy-decrypt（仅 expand 该次执行需要的 keys）、注入子 shell env。

**明文在主 pi 内存的生命周期**（v1.2 修正，Round 4 DS P1-3）：不是“仅存于子 shell”——`child_process.spawn(cmd, { env: {VAULT_xxx: plaintext} })` 时 Node.js 在**执行 execve 临界区**在父进程内存中构造 env 对象，明文在该临界区短暂存在于主 pi 内存（sub-ms 级窗口）。子进程退出后明文在主 pi 不持久保留。最坏情况主 pi crash 且 core dump 在该 sub-ms 窗口发生可能泄 1个 key（无法泄全库）——这是已知 trade-off，不进一步防御。

### 6.5.1 bash exfiltration 防御

> **为什么需要这个节**：Round 3 复核 Opus P0-4 指出——LLM 可以生成 `echo $VAULT_xxx | base64` / `xxd` / `python3 reverse` 让明文绕过 redaction 重新出现在 stdout。字面 redaction 对编码变换无能为力。prompt injection 场景下这是必然路径，不是概率事件。

**决策**：凡是注入了 `$VAULT_*` env 的 bash 命令，其 stdout 与 stderr **默认不回流 LLM context**。LLM 只能看到 exit code。要看到 stdout 需用户 once-授权。

**TUI 交互例**：
```
$ gh auth status            (uses $VAULT_github_token)
  exit code: 0

  [ this command's stdout was withheld from LLM context
    because it referenced $VAULT_*. release? ]
  [N]o  [Y]es once  [S]ession
```

**default-deny 顺序**与 §6.3 同理；bash 输出菜单没有 `Deny + remember`——bash 不持久化每 key 偏好。实际渲染顺序见 `extensions/abrain/vault-bash.ts:VAULT_BASH_OUTPUT_AUTH_CHOICES`（v1.4.6, 2026-05-10）。

**例外**：如果用户选「Session」，后续同一个 $VAULT_* 名的 bash 命令 stdout 自动传回 LLM。另一个 vault key 在同 session 中首次出现仍需重新授权。

**已知 trade-off**：
- UX 代价：LLM 调用 `gh repo list`（需 GH_TOKEN）后看不到输出。需用户主动释放。在优先安全的场景这不是问题——这是主动选择
- 依然存在的面：如果用户 `[Y]es once`，那次 stdout 进 LLM之后 LLM 仍可能以 base64 等编码输出中部分明文——但这需要一次用户明示同意，不再是默认静默泄露
- entropy 检测、编码变换检测：在用户选 [Y]es once 后仍然运行，作为 best-effort 补充层（§6.6）

### 6.6 stdout/stderr redaction

这是 §6.5.1 之后的補充层（用户选 [Y]es 后 bash output 回流前走一遍）。

**限定范围**（v1.2 补，Round 4 DS corner case 5.3 + Opus corner case 1）：streaming buffer 与 redaction **仅对 §6.5.1 中用户释放了 stdout 的 `$VAULT_*` 命令启用**。不引用任何 vault 的普通 bash 命令（`npm test` / `npm install` / `cargo build`）直接流式回流 LLM，不走 buffer——避免误伤正常长输出。

**实现层**：bash tool wrapper（同 §6.5），字节级拦截 stdout/stderr，redact 后再回流。不是 main pi 加载明文、不是 sediment 事后。

**Streaming 命令**（如 `tail -f` / `curl -o -`）：
- pi 先收集完整 stdout 到 buffer。**默认 10s timeout / 1MB 上限**；如果用户在 §6.5.1 选择 `[S]ession` 授权同 key，**后续同 key 命令 buffer 拉到 50MB / 10min 上限**（Round 4 Opus corner case 1：避免 `npm install --registry=$VAULT_xxx` 这类 session 级使用被误截断）
- redact 整个 buffer 后返回
- 超时 / 超限 丢弃剩余并记录 truncation notice——TUI 明示“command stdout was truncated to <N> bytes; LLM saw partial output”（不静默丢）
- 避免 chunk boundary 切断短值（如 12-char `ghp_xxx`）造成 false negative

**Redaction 逻辑**：
- 扫**两层 vault**所有 value 的字面 match
- 替换为 `<vault:<scope>:<key>>` 占位
- best-effort：会有 false positive（普通字符串恰好匹配）与 false negative（base64 / hex / xor 编码 value 不匹配）

**vault_release 与 once-授权 TUI 需加 warning**：
```
⚠  这些 value 在本 session 或本次调用中可见。bash 输出 redaction 为 best-effort：不覆盖 base64 / xxd / xor 等编码变换。
```

**跨层 trade-off 声明**（已知已选，入 ADR 0014 坟处§9）：LLM 主动 exfiltration 在代码生成场景下始终是一个面。§6.5.1 是机制性防御（8 成场景默认拦住），§6.6 是字面 redaction（補充拦截），两者合起来使“意外泄露”几乎不可能，但“受 prompt injection 诱导的主动 exfil” 仍是剩余面。

### 6.7 sub-pi 隔离（dispatch_agents 子进程）

子 pi 默认看不到任何 vault 元数据（连 key name 都不传）。要传必须父 pi 显式 pass，且每次 pass 必须用户授权。父 pi 已有的授权**不传给**子 pi。

### 6.8 .env 自动 ingest

sediment 在 active project 的 cwd 看到 `.env` / `*.env.local` / `secrets/*.yaml`：
- **自动**：在 `projects/<active>/vault/_meta.md` 加一条 "用户在 `<path>` 有 .env，含 `DB_HOST`/`DB_PASS`/`AWS_ACCESS_KEY_ID` 这些 key（仅 key name）"
- **不自动**：明文 value 不读不存
- 用户主动 `vault import-env <path>` 才把明文加密进项目级 vault

cwd 不属于任何 project（罕见，比如临时 directory）：sediment 看到 .env 直接忽略，不写元数据。

**全局 vault 永不自动 ingest**——全局秘密必须用户主动声明。

### 6.9 真 forget

```bash
/secret forget --global github-token        # 当前 P0c.write：rm/shred vault/github-token.md.age，保留 _meta timeline
vault forget prod-db-password               # 未来项目级读写路径：rm/shred projects/<active>/vault/prod-db-password.md.age
```

加密文件从 working tree 删除，`_meta/<key>.md` 保留并追加 `forgotten` timeline，便于审计。若 encrypted vault artifacts 已提交到 private git，history/remote 可能仍保留 ciphertext；plaintext 不进 git。

### 6.10 跨项目同名 key

不同项目可以独立持有同名 key：
- `projects/work-uamp/vault/prod-db-password.md.age`
- `projects/another/vault/prod-db-password.md.age`

互不干扰。bash 注入时按 active project 决定用哪个。

如果**全局 vault** 也有 `prod-db-password`，按 §6.5 解析顺序（项目级覆盖全局）。

### 6.11 多 pi 进程 vault 并发

多个 pi 同时写 vault 同一 key（罕见，但理论上）：用文件锁（flock `vault/.lock`）。读不需要锁（age 加密文件读是原子的，要么读到完整加密体要么读不到）。

---

## 7. .pensieve → abrain 迁移

### 7.1 一次性 migrate（推荐） — 用 `/memory migrate --go`

> ✅ **首选做法**：用 `/memory migrate --go`（B4，2026-05-12 ship；spec 见
> [migration/abrain-pensieve-migration.md §3](./migration/abrain-pensieve-migration.md#3-迁移动作memory-migrate---go-内部步骤)）。
> 该 slash command 内置 preflight + frontmatter 归一化 + pipeline 路由 +
> 索引重建 + pre-migration SHA rollback，自动化原生 git mv 的所有步骤。
> 下面列的 raw bash 步骤是 fallback，仅在 slash command 不可用时手动执行
> （例如 abrain pi extension 未启用、要 batch-migrate 多仓时）。

```bash
# 对每个有 .pensieve/ 的项目
project_id=$(determine_project_id <cwd>)
mkdir -p ~/.abrain/projects/$project_id
mv <cwd>/.pensieve/* ~/.abrain/projects/$project_id/
git -C <cwd> rm -r .pensieve
echo ".pensieve" >> <cwd>/.gitignore
```

### 7.2 兼容期 symlink（可选） — **SUPERSEDED**

> ⚠️ **已废止**（2026-05-12，ADR 0014 v7.1 per-repo 一次性迁移）。abrain 与
> 父仓都是 git repo，git 自身提供撤销网（per-repo `git reset --hard <pre-sha>`
> rollback，pre-sha 由 `/memory migrate --go` summary 打印）。不再需要
> 兼容期 symlink；sediment writer 走 runtime resolver 自动定位新路径
> （详 `extensions/_shared/runtime.ts` 中 `abrainProjectDir` / `abrainWorkflowsDir`
> 等 helpers）。本节保留作历史参考，新仓不要按此实施。

~~原方案：~~

```bash
# ln -s ~/.abrain/projects/$project_id <cwd>/.pensieve
# 让旧脚本继续 work；最终去除。
```

### 7.3 顺序 — **SUPERSEDED**

> ⚠️ **已废止**（2026-05-12）。新顺序见 [migration/abrain-pensieve-migration.md §3](./migration/abrain-pensieve-migration.md#3-迁移动作memory-migrate---go-内部步骤)
> — 单仓一次性迁移，preflight + frontmatter normalize + pipeline routing +
> 索引重建 + 两边各一个 commit，原子 8 步合并为 `/memory migrate --go` 一条命令。

~~原 4 步渐进 cutover：~~ symlink + 「跑几天验证」+ 删 symlink + 清旧 fallback ——
现在用 B4 一次性 `/memory migrate --go` 直接落地，不需要观察期。

---

## 8. 与现有 ADR 的关系

| ADR | 状态 | 处理 |
|---|---|---|
| 0003 主会话只读 | 保留 | 主 session 仍只读，sediment 仍唯一 writer |
| 0010 sediment single-agent | 保留 | sediment 内核不变 |
| 0011 / 0012 | 已被 memory-architecture.md superseded | 不变 |
| 0013 三 lane trust | **扩展** → 四 lane（A/C/G/V），Lane B/D 失去意义 | 写新 ADR 0014 |
| memory-architecture.md | **部分 supersede** | 写 ADR 0014 + memory-architecture.md v2 |

新增 ADR 0014: brain layout + vault 双层访问 + Lane G/V + 多 pi 进程共享 brain 模型

---

## 9. 已锁定的设计决策（traceability）

以下五个决策点经过 brain layout v0.1 → v0.2 收敛，已全部锁定。保留在此用于未来回顾「当初为什么这么定」。

### D-A: identity vs habits 边界

**决策**：严格分开。identity 是**用户主动声明**的（Lane G），habits 是**sediment 观察推断**的（Lane C）。两者 trust level 不同，分开存储让 trust 与 provenance 一致。

### D-B: workflows 的 MVP 写入策略

**决策**：保留 `workflows/` 目录作为概念占位，但**MVP 不主动 sediment 写**。等用户某次主动说"记一下我的 X 流程"再开始填。等积累到一定数量后再决定 workflows 与 habits 的边界要不要重新切。

### D-C: 团队协作 fallback

**决策**：MVP 不实现 export 命令。pi-astack 是单人项目；等真有协作需求时再加 `pi project export <id> --to <path>`。当前 abrain 的 private 默认就是 single-user 假设。

### D-D: vault key 命名规范

**决策**：自由形式，**推荐**（不强制）`<env>-<service>-<purpose>` 模式（如 `prod-postgres-readonly`）。命名灵活以容纳真实场景的多样性，强制约定会变成 friction。

### D-E: 多设备同步

**决策（v1.4.6 dogfood 修订）**：encrypted vault artifacts + `_meta` 可随 abrain private git 同步；plaintext、lock、tmp、runtime state 不进 git。ssh/gpg secret key 仍由用户自管，不进入 abrain。非 portable backend（macOS / secret-service / pass）跨设备时可能仍需用户用 rsync / syncthing / iCloud 或平台自身同步能力补齐 unlock 条件；vault 自带 export/import 命令暂属过度工程。

---

## 10. 明确不做（未来方向）

以下是 v0.2 **明确不做**的事，避免未来跑偏：

| 不做 | 理由 |
|---|---|
| 主体进程（long-running Jarvis daemon） | 用户已经反思——先把 brain 跑通，多 pi 进程通过共享 brain 协调就够。等真有"无主体不行"的 pain point 再考虑 |
| 分身（spawn-and-queue / sub-agent orchestration） | 同上。当前 dispatch_agents 已经能处理多模型并行，不需要更复杂的编排层 |
| Thread 抽象（跨 session 的"思考线程"） | 真正的长程认知是不是需要这个抽象，还没用真实使用验证。先看 brain 共享够不够 |
| Long-running daemon（HTTP/Unix socket server） | 任何长跑后台进程都会引入 lifecycle 管理、auth、IPC 三块新工程。证明必要再加 |
| Multi-channel inbox（IM 接入） | OpenClaw 的方向，不是这套架构的方向 |
| Lane D auto-promote | brain 内部无 promote 概念；ADR 0013 的 Lane D 在新架构下直接消失 |

**重申**：这些不是"以后绝不做"，是"现在不做、等真实使用反馈再决定"。如果跑两个月后发现共享 brain 不够、真的需要主体协调——再另开 ADR（当前下一个空号是 0017；0015 / 0016 已分别被 memory-search LLM retrieval / sediment-as-llm-curator 占用）。

---

## 11. 多 pi 进程共享 brain 的并发处理

这是新架构的关键运维问题。

### 11.1 写操作的实际冲突频率

大部分 sediment 写入是写不同路径——`projects/A/...` 和 `projects/B/...` 完全不冲突。

**真正冲突的是聚合文件**：
- `projects/_index.md`（portfolio view）
- `habits/_snapshot.md`（derived view）
- ~/.abrain 的 git commit lock

### 11.2 处理策略

| 场景 | 策略 |
|---|---|
| 不同 project 的 entry 写入 | 无锁——OS 文件系统就够 |
| **同一 project 的 entry 写入（同 slug）** | 发生概率极低（两个 pi 同一 agent_end 窗口内 sediment 同时 extract 同一洞察）。**接受最后写入赢**（markdown SOT 不丢数据，git history 看到一次覆盖跳变，可读但不美观）。**这不是 bug 是设计取舍**——v1.1 权谋提出“中期 sediment 写前走 dedupe”，v1.2 修正为不错觉解决：memory-architecture §8.2 的 dedupe gate 是语义相似度检测（trigram / embedding）**不是原子性保证**，不能防两个 pi 同时邀 dedupe 后各自认定 not duplicate 然后各自写入。若未来需要真解决 race：`O_CREAT\|O_EXCL` 或 per-project 目录锁是另起必要性证明后的 ADR，v1.x 范围不做。 |
| 聚合文件（_index / _snapshot） | **先写 .tmp 再原子 rename**——最坏情况是某次 update 被另一次覆盖（无伤大雅，因为是 derived） |
| Vault 同 key 并发写 | flock `~/.abrain/<vault-or-project-vault>/.lock`——罕见，但加上。**补充**：退出前先写 `.tmp` 再 rename（避免 crash 在 partial write） |
| git commit | flock `~/.abrain/.git/.sediment-lock`——sediment commit 时持有，避免 git index lock 冲突。**补充**：用户手动 `git pull` 不走该 lock，推荐先 `pi brain pause` 再手动 git 操作 |
| _bindings.md 更新（pi 启动时） | flock + 读改写。**补充**：flock 仅覆盖读改写临界区；TUI 绑定 prompt 期间释放锁，提交后重获锁、二次 read-merge-write，避免 lost update 与 starvation |

### 11.3 失败模式

- **某个 pi 进程 crash 时持有 lock**：flock 在 process 退出时自动释放，无需特殊处理。
- **vault decrypt 失败**：单文件加密粒度——只有那个 key 不能用，其他 vault 内容不影响。
- **_index.md 损坏**（极罕见，原子 rename 期间断电）：手动 `pi brain rebuild-index` 重建（扫所有 status.md）。

---

## 12. 实施依赖

本 spec 的实施依赖以下 ADR 与 sub-spec：

- [ADR 0014](adr/0014-abrain-as-personal-brain.md)：本文档的决策记录
- ✅ [migration/abrain-pensieve-migration.md](migration/abrain-pensieve-migration.md)：per-repo 迁移 spec（§1-§7） + 14 仓优先级 + 回滚 playbook
- ✅ [migration/vault-bootstrap.md](migration/vault-bootstrap.md)：age 加密 + portable identity 矩阵 + 7 种 backend 具体进路

本 spec 自身不会被实施动作修改——实施过程中的发现只能反向修订 ADR 0014 或本 spec 的 v1.x。
