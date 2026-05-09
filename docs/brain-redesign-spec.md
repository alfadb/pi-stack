# Brain Redesign Spec

> **状态**：v1.0 — accepted alongside [ADR 0014](adr/0014-abrain-as-personal-brain.md)（2026-05-09）
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
│   │   └── vault/                      ← 项目级 vault，NOT IN GIT
│   └── work-uamp/
├── knowledge/                          ← 传统 world facts
├── vault/                              ← 全局 vault，NOT IN GIT
└── .gitignore                          ← 含 vault/ 与 projects/*/vault/

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
| `projects/<id>/vault/` | **项目级秘密** | 用户主动 + 项目内自动 ingest 元数据 | ❌ | permanent |
| `projects/_index.md` | portfolio view | sediment agent_end 顺手 | ✅ | derived |
| `projects/_bindings.md` | cwd 映射 | pi 启动时维护 | ✅ | derived |
| `knowledge/` | 跨项目 fact/pattern | sediment（原 world scope） | ✅ | permanent |
| `vault/` | **全局秘密** | 用户主动 + 全局元数据 ingest | ❌ | permanent |

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
| **进 git** | ❌ | ❌ |

---

## 3. 写入路径

四条 Lane（扩展 ADR 0013）：

| Lane | 触发 | 目标 | 信任 | 状态 |
|---|---|---|---|---|
| **A** explicit MEMORY | `MEMORY: ... END_MEMORY` | `projects/<active>/` | 高 | ✅ 已有，迁移目标 |
| **C** auto-write | sediment LLM 后台 extract | `projects/<active>/` 或 `knowledge/`（跨项目稳定）| 中 | ✅ 已有，迁移目标 |
| **G** about-me declare | `/about-me <text>` 或 `MEMORY-ABOUT-ME: ... END` | `identity/` 或 `habits/` 或 `skills/` | 高 | 🆕 |
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

---

## 4. 读出 — memory facade 新行为

### 4.1 默认查询面

按相关度融合三个 surface：
1. **active project**（`projects/<active>/*` + `projects/<active>/vault/_meta.md`）—— 最高 boost
2. **identity / habits / skills / workflows / knowledge / vault/_meta.md**（关于"我"和世界的稳定知识 + 全局 vault 元数据） —— 次高 boost
3. **other projects**（`projects/<other-id>/*`，**不含**他们的 vault）—— 低 boost，仅当语义高度相关

### 4.2 Vault redaction 规则

| 命中内容 | facade 返回 |
|---|---|
| 全局 vault `_meta.md` 或加密文件 frontmatter | key + description + `🔒 use $VAULT_<key>` |
| Active project vault 同上 | 同上 |
| 其他 project 的 vault | **不返回**（连元数据都不暴露） |
| 加密体（明文 value） | **永远不解密进 facade**——只通过 `vault_release` 工具单独申请 |

### 4.3 Cross-project 召回

```
memory_search(query, scope?: "active" | "self" | "all-projects" | "everything")
```
默认 `everything`，ranking 偏 active。LLM 不需要选 scope。

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

---

## 6. Vault 完整规范（双层）

### 6.1 加密

- **算法**：age（rust 实现，简单可靠，成熟生态）
- **粒度**：单文件加密（每个 secret 一个 `.md.age`）
- **理由**：粗粒度（整个 vault 一个加密容器）解锁体验差；单文件支持选择性 unlock 和损坏隔离
- **master key**：单一一把（**全局 vault 和所有项目 vault 共享同一 master key**）
  - 让用户管 N+1 把 key 太烦；攻击者拿到 master 就拿到全部，单 key 是合理的简化
  - 如果将来发现真的需要分级（比如某个 client 项目要更高 isolation），再加 per-project master—— v0.x 再考虑

### 6.2 解锁

- **每个 pi 进程启动时独立从 OS keychain 取 master key**（毫秒级开销）
- 不引入共享 vault daemon——保持"无长跑进程"的纯净
- **开机自动解锁**（systemd user service / launchd 在登录后从 OS keychain 准备好 master，pi 启动时拉取）
- **无超时 lock**（用户接受永远在线换便利；机器被偷或被未授权 ssh 时攻击者可读 vault——这个 trade-off 已知已选）

### 6.3 LLM context 边界

| 内容 | 默认 | 如何获取 |
|---|---|---|
| key name + description | 进 context（按 §4.2 scope 过滤） | always |
| value 明文 | **不进 context** | `vault_release(key, scope?, reason)` 工具调用 + TUI 授权 |

授权粒度：
- `[Y]es once`：单 turn 释放
- `[S]ession`：当前 pi 进程生命周期内同 key 不再问
- `[N]o`：拒绝
- `[D]eny+remember`：拒绝并写到 vault entry metadata，未来同样请求自动拒绝

### 6.4 命令语义（双层关键）

```bash
# 写入
/secret <key>                    # 默认写到项目级（如果当前有 active project）
                                 # 没 active project 时（罕见）拒绝写入并提示
/secret --global <key>           # 写到全局 vault
/secret --project=<id> <key>     # 写到指定项目的 vault（少用）
/secret <key> --description "..." # 加描述

# 读取（仅元数据）
/secret list                     # 列出当前可见 keys（全局 + active project）
/secret list --all-projects      # 列所有 keys（提示存在但不解密）

# 导入
vault import-env <path>          # 从 .env 文件导入到项目级 vault（明文 value 加密）
vault import-env --global <path>

# 释放（明文给 LLM）
vault_release(key)                          # 工具调用，不是 slash 命令
vault_release(key, scope="global"|"project") # 显式指定

# 删除
vault forget <key>               # 默认删项目级（active project）
vault forget --global <key>      # 删全局
```

### 6.5 bash 工具注入

LLM 生成的 bash 命令含 `$VAULT_<key>`：

**解析顺序**：
1. **active project's vault**（`projects/<active>/vault/<key>.md.age`）
2. **global vault**（`vault/<key>.md.age`）
3. 都没有 → 主进程在执行前 short-circuit 报错给 LLM："vault key `<key>` 不存在"

**项目级覆盖全局**：如果两层都有同名 key，用项目级（用户在项目里覆盖了全局默认）。

**显式区分**（如需）：
- `$VAULT_<key>`：按上面顺序（默认）
- `$GVAULT_<key>`：强制全局
- `$PVAULT_<key>`：强制项目级

主进程拦截 → 解密 → 注入 env → 子 shell expand。LLM 看到的命令字符串**始终是变量名，不是明文**。

### 6.6 stdout/stderr redaction

bash 执行结果回流 LLM context 之前，主进程做 redaction：
- 扫**两层 vault**所有 value 的字面 match
- 替换为 `<vault:<scope>:<key>>` 占位（标 scope 让 LLM 知道是哪层）
- best-effort：会有 false positive（普通字符串恰好匹配）和 false negative（base64-encoded value 不匹配）—— 比不做好两个数量级，但不是绝对保证

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
vault forget prod-db-password         # rm projects/<active>/vault/prod-db-password.md.age
vault forget --global github-token    # rm vault/github-token.md.age
```

加密文件被删 + 从对应 _meta.md 移除。**因为 vault/ 不在 git，所以无 git history 残留**。

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

### 7.1 一次性 migrate（推荐）

```bash
# 对每个有 .pensieve/ 的项目
project_id=$(determine_project_id <cwd>)
mkdir -p ~/.abrain/projects/$project_id
mv <cwd>/.pensieve/* ~/.abrain/projects/$project_id/
git -C <cwd> rm -r .pensieve
echo ".pensieve" >> <cwd>/.gitignore
```

### 7.2 兼容期 symlink（可选）

```bash
ln -s ~/.abrain/projects/$project_id <cwd>/.pensieve
```
让旧脚本继续 work；最终去除。

### 7.3 顺序

1. 先在 sediment writer 加"目标路径切换"逻辑（看 `_bindings.md` 决定写哪）
2. 再 mv 现有 .pensieve/
3. 跑几天验证
4. 最后删 symlink + 清理 sediment 旧 fallback

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

**决策**：手动（rsync / syncthing / iCloud）。abrain 主体走 git private remote 同步，vault/ 不进 git，由用户自己选传输工具。vault 内容已加密，传输工具不重要；vault 自带 export/import 命令是过度工程。

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

**重申**：这些不是"以后绝不做"，是"现在不做、等真实使用反馈再决定"。如果跑两个月后发现共享 brain 不够、真的需要主体协调——再开 ADR 0015。

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
| 聚合文件（_index / _snapshot） | **先写 .tmp 再原子 rename**——最坏情况是某次 update 被另一次覆盖（无伤大雅，因为是 derived） |
| Vault 同 key 并发写 | flock `~/.abrain/<vault-or-project-vault>/.lock`——罕见，但加上 |
| git commit | flock `~/.abrain/.git/.sediment-lock`——sediment commit 时持有，避免 git index lock 冲突 |
| _bindings.md 更新（pi 启动时） | flock + 读改写 |

### 11.3 失败模式

- **某个 pi 进程 crash 时持有 lock**：flock 在 process 退出时自动释放，无需特殊处理。
- **vault decrypt 失败**：单文件加密粒度——只有那个 key 不能用，其他 vault 内容不影响。
- **_index.md 损坏**（极罕见，原子 rename 期间断电）：手动 `pi brain rebuild-index` 重建（扫所有 status.md）。

---

## 12. 实施依赖

本 spec 的实施依赖以下 ADR 与 sub-spec：

- [ADR 0014](adr/0014-abrain-as-personal-brain.md)：本文档的决策记录
- 待写：`migration/abrain-pensieve-migration.md`（详细迁移脚本与回滚 playbook）
- 待写：`migration/vault-bootstrap.md`（age 加密 + OS keychain 集成的具体步骤）

本 spec 自身不会被实施动作修改——实施过程中的发现只能反向修订 ADR 0014 或本 spec 的 v1.x。
