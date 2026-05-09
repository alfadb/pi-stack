# ADR 0014 — Abrain Personal Brain Redesign（重定位 ~/.abrain 为 alfadb 数字孪生）

- **状态**：Accepted（2026-05-09）
- **修订**：v1.3（2026-05-09，incorporate Round 5 复核 P0 修订，含首次真代码修订）、v1.2（2026-05-09，incorporate Round 4 复核 P0 修订）、v1.1（2026-05-09，incorporate Round 3 复核 P0 修订）
- **日期**：2026-05-09
- **决策者**：alfadb
- **依赖**：[ADR 0003](0003-main-session-read-only.md)、[ADR 0010](0010-sediment-single-agent-with-lookup-tools.md)、[ADR 0013](0013-asymmetric-trust-three-lanes.md)、[memory-architecture.md](../memory-architecture.md)
- **被引用**：[brain-redesign-spec.md](../brain-redesign-spec.md)（详细规范）、[migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)、[migration/vault-bootstrap.md](../migration/vault-bootstrap.md)
- **触发**：2026-05-09 三轮多模型辩论（Opus 4-7 / GPT-5.5 / DeepSeek v4-pro）+ 用户重定位 ~/.abrain + 一轮 P0 复核（三方 PASS after fixing P0）

## 背景

### 触发链

1. **用户原始诉求**：希望 pi 升级为"全能助手"，能学习习惯、记忆项目、辅助决策、观测全部 pi 操作
2. **三轮多模型辩论**（共耗时 ~6.5 分钟、$0.95）：从五个能力维度（C1-C5）拆解为六个核心架构分歧（A-F），三方在 R1 高度对立、R2 大幅让步
3. **用户关键 reframe（2026-05-09 18:25）**：把 ~/.abrain 从"world knowledge 仓库"重新定义为"**关于 alfadb 这个人的一切**"——含 identity、skills、habits、workflows、所有 projects（吃掉旧 .pensieve/）、knowledge、vault
4. **用户自主反思（2026-05-09 21:00）**：放弃"主体进程 + 分身 + 队列"激进方案，回归"N 个独立 pi 进程共享同一 brain"的克制路径
5. **brain layout v0.1 → v0.2 收敛**，五个开放点全部锁定

### 为什么需要这个 ADR

memory-architecture.md（v1.0，2026-05-07 通过两轮三模型评审）的 scope=project|world 二元划分**在新需求下不够用**：

- 它假设 world 是"跨项目通用 fact"——但用户要的 world 实际上是"alfadb 这个人"
- 它没有 identity / habits / skills / workflows / vault 的概念
- 它没有跨项目 portfolio view 的内生支持
- 它的 `.pensieve/` per-project 物理结构与"统一大脑"的认知模型冲突

ADR 0013 的 Lane B（manual promote project→world）和 Lane D（auto-promote）在新架构下**失去意义**——abrain 内部不再有"promote"概念，所有写入直接定位到对应区域。

## 决策

### D1. ~/.abrain 重定位为 alfadb 数字孪生 / Jarvis 大脑

七区结构：

| 区域 | 性质 | 写入者 |
|---|---|---|
| `identity/` | 关于"我"的固定事实 | 用户主动声明（Lane G）+ sediment 高门槛提炼 |
| `skills/` | 我会什么、熟练度 | sediment 观察 + 用户校正 |
| `habits/` | 我的行为模式 | sediment 观察 + 用户校正 |
| `workflows/` | 我的常用 pipeline | 用户主动声明 + sediment 补完 |
| `projects/<id>/` | 项目工作记忆（吃掉 .pensieve/） | sediment / 用户 |
| `knowledge/` | 跨项目通用 fact（旧 world scope） | sediment |
| `vault/` + `projects/<id>/vault/` | 双层秘密 | 用户主动（Lane V），不进 git |

详细 schema、子目录、读写规则见 [brain-redesign-spec.md](../brain-redesign-spec.md)。

### D2. 项目知识从 `<cwd>/.pensieve/` 迁入 `~/.abrain/projects/<id>/`

`.pensieve/` 物理位置废止。每个项目的 decisions/knowledge/maxims/observations/habits/status/vault 子目录全部进入 abrain 内。

cwd → project-id 映射通过 `~/.abrain/projects/_bindings.md` 维护（git remote URL 优先，UUID/手动 alias 兜底）。pi 启动时识别 cwd，未绑定 cwd 触发 TUI 绑定 prompt。

### D3. Lane 模型扩展：A/C/G/V 四段

| Lane | 触发 | 目标 | 信任 | 状态 |
|---|---|---|---|---|
| **A** explicit MEMORY | `MEMORY: ... END_MEMORY` | `projects/<active>/` | 高 | ✅ 已有，迁移目标 |
| **C** auto-write | sediment LLM 后台 extract | `projects/<active>/` 或 `knowledge/` | 中 | ✅ 已有，迁移目标 |
| **G** about-me declare | `/about-me` 或 `MEMORY-ABOUT-ME:` block | `identity/` 或 `habits/` 或 `skills/`（按内容路由，**非** lane↔目录绑定） | 高 | 🆕 |
| **V** vault declare | `/secret <key>` 等系列命令（**同步**：user slash → main pi 进程内 vaultWriter library 同步调用 → 加密落盘 → 立即可用。**不走 sediment IPC**（v1.2 修订 N1） | 全局或项目级 vault | 最高 | 🆕 |
| ~~B promote~~ / ~~D auto-promote~~ | — | — | — | ⛔ 失去意义（abrain 内部无 promote） |

> Lane G 的目标在 identity / habits / skills 三区中按内容路由（deterministic router 见 [spec §3.5](../brain-redesign-spec.md#35-deterministic-router)），不是 Lane 与目录的硬绑定。Lane G 保证 trust=高，目录由内容路由。**低置信样本（`routing_confidence < 0.6`）进 §3.5 staging review queue——不直接落 identity/habits**（v1.3 补，Round 5 Opus NP1-2：三区不是唯一出口，staging 是第四出口）。

### D4. Vault 双层架构

- **全局 vault** `~/.abrain/vault/`：跨项目通用秘密（github-token、API keys、ssh-key、私人事项）
- **项目级 vault** `~/.abrain/projects/<id>/vault/`：仅与某项目相关（prod-db-password 等）
- **加密**：age 单文件，单一 master key（全局与所有项目共享，避免管理 N+1 把 key）
- **解锁**：每个 pi 进程从 OS keychain 自动取 master key（毫秒级开销，开机自动解锁，无超时 lock）
- **明文不进 LLM context**（默认）：需 `vault_release` 工具调用 + TUI 授权（once/session/no/deny+remember 四档）
- **bash 注入**：`$VAULT_<key>` 解析顺序为 active project's vault → global vault；项目级覆盖全局
- **stdout/stderr redaction**：主进程在 bash 结果回流前做 best-effort 字面 match 替换为 `<vault:<scope>:<key>>`
- **不进 git**：`vault/*` 与 `projects/*/vault/*` 全部 .gitignore；`vault forget` 直接 rm 加密文件，无 history 残留

### D5. 多 pi 进程共享 brain（无主体 / 无分身 / 无队列）

每个 pi 进程独立 lifecycle，互不通信。通过共享 ~/.abrain 协调：
- 不同 project 的 entry 写入：无锁（OS 文件系统）
- 聚合文件（`_index.md` / `_snapshot.md`）：先写 .tmp 再原子 rename，最坏情况是 update 被另一次覆盖（无伤大雅，因为是 derived）
- vault 同 key 并发写：flock `<vault-dir>/.lock`
- git commit：flock `~/.abrain/.git/.sediment-lock`
- portfolio sidecar 简化为 sediment 在 agent_end 时**顺手 regenerate** `_index.md`（幂等，最后写入赢）

### D6. 明确不做（current scope 外）

以下方向当前**不实施**，等真实使用反馈再决定：

- 主体进程 / 长跑 daemon / HTTP-Unix socket server
- 分身（spawn-and-queue / sub-agent orchestration）
- thread 抽象（跨 session 的"思考线程"一等公民化）
- multi-channel inbox（IM 接入）
- Lane D auto-promote（abrain 内部无 promote，永久消除）

不是"以后绝不做"，是"当前不做、跑两个月后基于真实 pain point 决定"。

## 关键不变量

1. **LLM tool surface 中没有定制 brain mutation tool**（v1.3 拆为 mechanic + best-effort 两段，Round 5 Opus NP1-1）：
   - **层 1 mechanic 不变量**：LLM 可调用的 tool 集中**没有** `vault_write` / `vault_put` / `secret_*` / `brain_write` 这类专门的 brain mutation 入口。sediment 仍为异步记忆写入唯一 dedicated writer（Lane A/C/G）；vaultWriter library **仅在 abrain extension activate 期间被 TUI command handler 同进程调用**（不在 module-level export 中公开、`require()` 取不到 `writeSecret`——详 spec §6.4.0）。
   - **层 2 best-effort residual surface**（已知 trade-off）：LLM 仍可通过通用 tool（bash / edit / write / dispatch_agents）间接写 brain SOT——例如 bash `secret-tool lookup` + `age -e` 手写加密文件、bash `pi /secret` spawn 子 pi（不走 dispatch_agents 路径）。防御手段：§6.5.1 stdout 默认不回流 + §6.6 redaction + sediment audit 后置检测三者叠加，但**不是机制保证**。详 §坟处 #10。
   - **Lane V 同步路径**（v1.2 引入）：user slash command `/secret`（用户物理键入）触发 main pi 进程内 vaultWriter 同步调用。user typing 是面向 TUI 的独立路径，不进 LLM tool surface，**由层 1 不变量保护**。Lane G `/about-me` 仍走 sediment 异步 agent_end 路径。
2. **Markdown + git 是 source of truth**（vault 例外，加密 + 不进 git）：索引/derived view 可重建。
3. **Facade 不暴露 scope/backend/source_path** 给 LLM ranking surface：`memory_search(query)` 签名无多余形参（`scope` 不存在于 schema）。例外：`memory_get(slug)` 是 exact lookup/debug view，可返回 scope/source_path 供调试——不是 LLM 选后端的机制。
4. **跨 project vault 不互见**：active project（**boot-time snapshot**，详 spec §5.4）的 vault + 全局 vault 进 LLM context；其他 project 的 vault 连元数据都不暴露。会话中 bash `cd` 不改变 active project。
5. **vault 明文进 LLM context 必须 user-explicit 授权**：`vault_release` 工具调用 + TUI 弹框确认；best-effort redaction（不是绝对保证）但默认排除是硬不变量。**补充**：引用了 `$VAULT_*` env 的 bash 命令 stdout/stderr **默认不回流 LLM**，需用户 once-授权（详 spec §6.5.1）——这是 LLM 主动 exfiltration 的机制性防御，不仅依赖 redaction 过滤器。
6. **sub-pi 默认看不到任何 vault**：父 pi 已有授权不传给子 pi。**三层机制性 enforcement**（v1.2 强化，Round 4 GPT P0-N2）：(a) `dispatch_agents` 的 spawn 调用强制 `env: { ...process.env, PI_ABRAIN_DISABLED: "1" }`，顺序保证不能被上层 `export PI_ABRAIN_DISABLED=0` 覆盖；(b) abrain extension 启动第一行 `if (process.env.PI_ABRAIN_DISABLED === "1") return;`，不注册 tool / 不订阅事件 / 不加载 vault metadata；(c) `smoke:vault-subpi-isolation` 验证父 vault unlocked 时子 pi `vault status` 返回 locked。详 [vault-bootstrap.md §5](../migration/vault-bootstrap.md#5-每个-pi-进程启动时的-unlock-check)。
7. **七区目录互斥**：identity/habits/skills/workflows/projects/knowledge/vault **七个目录**互斥（单条 entry 物理上只在一处），**但** habits/skills 等概念在全局与项目级有镜像目录（`habits/` 与 `projects/<id>/habits/` 并存），由 sediment 按 scope of generalization 决定写哪层。边界路由由 deterministic router 规范（§审计扩展 + spec §3.5）决定，不是 LLM-facing 选择。
8. **"删除我所有秘密" = `rm -rf ~/.abrain/vault ~/.abrain/projects/*/vault`**：因 vault 不进 git，**git history 无残留**。补充：filesystem 层面的残留（swap / journal / undelete recovery）属 OS-level，超出本 spec 范围。

## 后果

### 好处

1. **认知模型清晰**：~/.abrain 不再是"知识仓库"而是"我的孪生"——所有关于 alfadb 的事实在一个地方，结构对应"我是谁/我会什么/我怎么工作/我在做什么/我的秘密"。
2. **跨项目原生支持**：portfolio view、cross-project pattern 召回、跨项目 habit 学习全部内生，不需要单独 sidecar。
3. **隐私撤销简单**：vault 不进 git → `rm -rf` 即清零。`/habit forget` / `vault forget` 都是单文件操作，无 git history 残留。
4. **工程量可控**：本质是"数据层重构 + sediment writer 路径切换"，pi 内核完全不动。失败回滚 = revert sediment 改动 + mv abrain/projects/* 回各项目 .pensieve/。
5. **未来不锁死**：spawn-and-queue / thread / 主体进程 都是可以以后加的"协调层"——共享 brain 是它们的前置基础设施，不会冲突。
6. **架构辩论复杂度大幅降低**：之前两轮 R1+R2 讨论的"observation 该放哪个 store"、"habit 该不该持久化"等问题，在新架构下要么自动解决要么变成局部决策。

### 坏处

1. **迁移成本**：现有 pi-astack 项目 `.pensieve/` 含 182 entries，必须一次性 mv（详 [migration playbook](../migration/abrain-pensieve-migration.md)）。其他绑定项目同样要走一遍。
2. **vault 引入 OS keychain 依赖**：systemd user service / launchd 配置首次需要用户手动设置；不同 OS 的实现不同。
3. **多 pi 并发的边界 case**：聚合文件最后写入赢策略接受了"瞬间不一致"代价。极罕见情况下用户可能看到旧版 _index.md（实际无副作用，因为 derived view）。
4. **ADR 0013 的 Lane B/D 失去意义**：迁移期需要文档说明"为什么这两个 Lane 在新架构下消失"——避免未来贡献者困惑。
5. **memory-architecture.md 部分 superseded**：那份文档是 2026-05-07 经两轮三模型评审通过的"权威规范"，现在它的 scope/backend/Facade 部分仍然成立，但物理拓扑（.pensieve/ + ~/.abrain/）需要明确标记 superseded。
6. **vault 明文 redaction 是 best-effort**：false positive（普通字符串恰好匹配）和 false negative（base64-encoded value 不匹配）都存在。这个 trade-off 比"完全不 redact"好两个数量级，但不是绝对保证——用户已知已选。
7. **机器被偷或被未授权 ssh 时 vault 全裸**：开机自动解锁 + 无超时 lock 是用户明确选择换便利；这个风险已知已选。
8. **abrain 主体本身的敏感度**：顶层 identity/values.md / cognitive-profile.md / self-narrative.md 全部进 git。private remote 凭证保护是隐含前置条件——未来需要单独 ADR 处理 abrain repo 本身的供应链安全（commit signing / verified push 等）。
9. **LLM 主动 exfiltration 是已知攻击面**：`echo $VAULT_xxx | base64` 类命令能让明文绕过字面 redaction。不变量 #5 的补充（引用 `$VAULT_*` 的 bash stdout 默认不回流 LLM）是机制性防御，但 prompt injection 场景下远不是绝对保证。在高价值 vault（如 prod credential）上这是主动选择的 known trade-off。
10. **LLM 通用 tool 间接写 brain 是 known residual surface**（v1.3 补，Round 5 Opus NP0-1）：不变量 #1 的层 1 mechanic 仅覆盖定制 mutation tool。LLM 仍可以通过 bash 调 `secret-tool` + `age` CLI 手写加密文件、通过 bash spawn 子 pi（不走 dispatch_agents）、通过 edit/write 工具直接改 markdown SOT。这些路径被 §6.5.1/6.6/sediment audit 三重防护层 best-effort 覆盖，但不是机制保证。与 #9 同类主动选择的 trade-off——补充说明 §不变量 #1 的层 2。

### 中性

- **不影响**：pi extension 系统、dispatch_agents 工具、main session 与 sediment 的进程关系、当前的 memory_search facade 的 LLM-facing 接口形状。
- **简化**：sediment writer 的 scope 概念从"project|world 二选一"变为"abrain 内部七区路由"——`kind: decision/knowledge/maxim/...` 决定子目录，scope 不再是显式选择。
- **延后**：spawn-and-queue / thread / 主体-分身模型 由真实使用驱动，至少观察两个月。

## 实施现状

**未实施**——本 ADR 是设计决策记录。完整实施 plan 在 [migration/abrain-pensieve-migration.md](../migration/abrain-pensieve-migration.md)（§1 8-phase plan）与 [migration/vault-bootstrap.md](../migration/vault-bootstrap.md)。下面是 phase 摆跱，详情看两个 sub-spec：

| Phase | 动作 | 验收 |
|---|---|---|
| **P0** | vault-bootstrap（age + OS keychain 平台矩阵 + master key 生成） | `pi vault status` 返回 unlocked |
| **P1** | 新增 `resolveActiveProject(cwd)` / `resolveBrainPaths()` 单一入口，所有读旧 `.pensieve` 代码改走它 | resolver 单测通 + 现有功能零回归 |
| **P2** | Facade dual-read：同时读旧 `.pensieve` + 新 `~/.abrain/projects/<id>/` | smoke：旧内容可被找到 + 新空目录不报错 |
| **P3** | dedupe / projectSlug / lint / index / git-root 全部走 resolver | grep 整 repo 无残留 hard-coded `.pensieve` |
| **P4** | Freeze write + smoke 1-2 天观察 | 连续 24h 无 split-brain |
| **P5** | 持锁迁移：sediment lock + manifest 下 mv | manifest 完整 + epoch 写入 |
| **P6** | Writer cutover：sediment writer 改写新路径 | 一次新写入落地 + audit lane 含新值 |
| **P7** | Symlink 兼容期 1-2 周 | 无报错 |
| **P8** | 删 fallback（dual-read / symlink / 旧 config） | 全链路只走新路径 |

关键约束：P4 之前可 **完全 revert**（git revert 即可）；P5 之后是 forward-only；P6 之后的 delta 只能走 [migration playbook §3-4](../migration/abrain-pensieve-migration.md#3-rollback-playbookp5-半成品状态) 处理。

预计工程：纯代码 ≈3 天 + 2 周观察期。

## 审计扩展

**Cross-log timestamp 契约**（v1.3 补，Round 5 DS P1-D）：sediment-events.jsonl 与 vault-events.jsonl 均为独立日志流，**跨流事件顺序仅按各自行内 `timestamp` 字段关联**（均为 `new Date().toISOString()`，同进程同时钟源）。两个流之间**无全局序列号保证**，审计回放时按 timestamp 做 merge-sort 得到 best-effort 时序。两流共享同一 audit row schema base（`{ts, op, lane, slug, ...}`），lane-specific 字段加在 schema 末尾；sediment substrate 改 base schema 时 vaultWriter 必须同步跟随，由 §vaultWriter substrate API 边界的 contract test（spec §6.4.0）覆盖。

ADR 0013 要求每条 sediment audit row 含 `lane: "explicit" | "promote" | "auto_write" | "auto_promote"`。Lane G/V 引入后，lane enum 必须同步扩展：

```jsonc
// sediment-events.jsonl — lane 字段在新架构下的枚举
{
  "lane": "explicit"      // Lane A — 仍有效
         | "auto_write"    // Lane C — 仍有效
         | "about_me"      // Lane G — 新增
         | "vault_write"   // Lane V — 新增。记录到独立 log `vault-events.jsonl`（§下）
         // “promote” / “auto_promote” 不再处于枚举内——abrain 内部无 promote
}
```

**两个 audit log**：
- `~/.abrain/.state/sediment-events.jsonl`：Lane A / C / G 都走这里（sediment pipeline 内部事件）
- `~/.abrain/.state/vault-events.jsonl`：**Lane V 独立 log**（vault 写入是 sediment 同步处理但在不同事务路径，另走一份 log 避免与 agent_end 异步事件联屏造成验证混乱）

[memory-architecture.md](../memory-architecture.md) 的 supersede banner 同步修正为："audit row schema → 扩展 lane 字段，见 ADR 0014"。

## 与上游 ADR 的关系

| 上游 | 关系 | 说明 |
|---|---|---|
| ADR 0003 主会话只读 | **保留** | sediment 仍唯一 writer，主 session 仍只读 |
| ADR 0010 sediment single-agent | **保留** | sediment 内核完全不动 |
| ADR 0011 / 0012 | 已被 memory-architecture.md superseded | 不变 |
| ADR 0013 三 Lane trust | **扩展为四 Lane** | A/C 保留，B/D 失去意义，新增 G/V |
| memory-architecture.md | **部分 superseded** | scope=project\|world 二元划分被吸收到 brain 七区结构；`.pensieve/` 物理位置废止；其余（writer policy、validation、rolling gate 等）保留 |

## 开放问题

| Q | 问题 | 当前答案 |
|---|---|---|
| Q1 | identity vs habits 边界（Q-A） | **trust 与目录路由分离**。Lane G 保证 trust=高，Lane C 保证 trust=中；identity / habits / skills 三区由 sediment 按 aboutness 分类路由（**不是 Lane↔目录硬绑定**）。habits 接受 Lane C 主写也接受 Lane G 校正；identity 通常 Lane G，sediment 跨多 session 稳定观察才能补充（高门槛）。具体路由规范见 [spec §3.5 deterministic router](../brain-redesign-spec.md#35-deterministic-router) |
| Q2 | workflows MVP 写入策略（Q-B） | 保留目录占位，MVP 不主动 sediment 写；等用户主动声明再开始填 |
| Q3 | 团队协作 fallback（Q-C） | MVP 不实现 export 命令；等真有协作需求再加 `pi project export` |
| Q4 | vault key 命名规范（Q-D） | 自由形式，推荐 `<env>-<service>-<purpose>`，不强制 |
| Q5 | 多设备同步 vault（Q-E） | 手动（rsync/syncthing/iCloud）；vault 自带 export/import 是过度工程 |
| Q6 | 跑通 2 个月后是否需要主体/分身？ | 不预设。基于真实 pain point 在另开 ADR 015+ 评估 |
| Q7 | OpenClaw 借鉴边界 | 个别工程模式可参考（sandbox 白名单、JSON Schema、device pairing）；架构理念不照搬（OpenClaw 是 short-task lifestyle，alfadb 是 long-haul cognitive） |

## 参考

### 触发文档（讨论 trace）

- 三轮多模型辩论 raw output：~/.pi/agent/sessions/--home-worker-.pi--/2026-05-09T*.jsonl line 101 (R1, 200.0s) / line 122 (R2, 179.1s)
- 萃取摘要：`/tmp/omni-discussion/round1-summary.md`、`/tmp/omni-discussion/round2/{opus,gpt,ds}.md`
- 草案：`/tmp/omni-discussion/brain-layout-v0.1.md`（initial）→ `brain-layout-v0.2.md`（收敛）→ 本 ADR + spec

### 相关项目

- [OpenClaw](https://github.com/openclaw/openclaw)（Peter Steinberger，依托 pi-mono）：short-task lifestyle 助手，与本 ADR 场景不同但部分工程模式可参考

### 详细规范

- **[brain-redesign-spec.md](../brain-redesign-spec.md)** —— 七区目录细则、Lane G/V 命令语义、vault 双层完整规范、并发处理、迁移路径
