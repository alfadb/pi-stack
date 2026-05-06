# pi-stack

> alfadb's personal pi workflow — 专为 pi 打造的个人工作流仓 + 记忆基础设施。

> **v6.8 update (2026-05-06, ADR 0012):** sediment 回退到 **pensieve + gbrain default 双 target** 架构。gbrain v0.27 multi-source
> 写入与检索隔离均未实现，所以项目级记忆重新写 `<projectRoot>/.pensieve/`，世界级原则写 gbrain default。本文档中以下提及的概念被废弃：
> “**Source 二分**”、“**双轨沉淀（project source + world source）**”、“**.gbrain-source dotfile**”、“**自动源注册**”。
> 实际架构以 [ADR 0012](./docs/adr/0012-sediment-pensieve-gbrain-dual-target.md) 为准。

## 是什么

把 alfadb 用 pi-coding-agent 时所需的全部资源集中维护在一个仓里：
- pi 行为扩展（extensions/）
- pi 技能（skills/）
- pi 提示模板（prompts/）
- 记忆基础设施（gbrain 唯一存储 + sediment 单写 + offline 兜底）
- 上游 vendor 引用（vendor/）

参考心智模型：**gstack 之于 claude-code 的关系，pi-stack 之于 pi 的关系一样**。作者为自己常用的 harness agent 打造一整套工作流，集成自己认同的 review/qa/security/multi-agent/memory 等能力，不断演进。不是发行版（不为不同环境打包同一软件），不是仓库集合（不是谁都可以拿出一个独立包），是**作者自用 + 作者认可的完整工作流**。

## 心智速览

| 维度 | 决策 |
|---|---|
| 单一记忆基础设施 | gbrain（postgres + pgvector）；**部署由 alfadb 自决**，pi-stack 仅消费 |
| Sediment 双 target（v6.8） | **pensieve target**：`<projectRoot>/.pensieve/short-term/{maxims,decisions,knowledge}/` 项目本地文件系统<br>**gbrain target**：gbrain default source（federated=true，世界级工程原则） |
| ~/.pi 身份 | pi-stack 开发环境 + 其他项目的 pi 基础环境；sediment 按 cwd 检测 `.pensieve/` 存在 + `gbrain doctor` 可用 独立决定运行 |
| 主会话角色 | 只读（`gbrain_search/get/query` + `pensieve-context` extension） |
| Sediment 角色 | 唯一写入者；v6.8 **双 target 并行**调度 + 独立 checkpoint scheduler；默认模型 deepseek-v4-pro reasoning=high；架构 lift 自验证成熟的 garrytan/pi-sediment |
| Multi-agent 能力 | `dispatch_agent`/`dispatch_agents` 基础能力；主会话自由组合；sediment 不再使用（单 agent 流水线）；原 4 strategy 降为 cookbook |
| Pensieve 项目 | 复活 — sediment 走 4 象限（maxims/decisions/knowledge/short-term），未来 gbrain multi-source 就绪后迁移 |
| Offline 兜底 | sediment markdown export + read tool fallback |
| 上游升级 | LLM 阅 diff → 语义判断 → 端口层适配（不机械化） |

详见 [docs/adr/](./docs/adr/) 12 条 ADR（最新：ADR 0012 sediment 双 target）+ [docs/memory-architecture.md](./docs/memory-architecture.md)。

> ADR 状态提示：ADR 0002 / 0005 / 0011 被 ADR 0012 superseded。

## 安装方式

### alfadb 自己（开发即使用）

**前置依赖**（alfadb 自决）：
- 安装 gbrain CLI：`bun install -g gbrain` 或 git clone + bun link
- 准备 postgres + pgvector 实例（local docker / 云 postgres / neon / supabase 任选）
- 在 `~/.gbrain/config.toml` 配置连接
- 跑 `gbrain migrate`

挂为 `~/.pi/agent/skills/pi-stack/` submodule，并在官方 pi settings chain（`~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）里用 local package path 加载。改一行立即生效。

> 注意：`~/.pi/agent/skills/pi-stack/` 是 alfadb dotfiles 的组织路径，不代表 pi-stack 靠 skill discovery 运行；真正加载靠 pi package manifest（`package.json#pi`）+ `packages` settings。

```bash
# 一次性挂载（在 ~/.pi 仓内执行）
cd ~/.pi
git submodule add git@github.com:alfadb/pi-stack.git agent/skills/pi-stack
git submodule update --init --recursive

# ~/.pi/agent/settings.json 一行 local package path:
#   "packages": ["~/.pi/agent/skills/pi-stack"]
# 运行时配置也走官方 settings chain，例如：
#   "piStack": { "sediment": { "enabled": true } }

# 首次创建 pi-stack source
gbrain sources add pi-stack --path ~/.pi --no-federated

# 跨设备同源关键：commit 两份 .gbrain-source dotfile（ADR 0008）
# 为什么两份：~/.pi 与 pi-stack/ 两种 cwd 起点都要 dotfile walk-up 能命中
echo pi-stack > ~/.pi/.gbrain-source
echo pi-stack > ~/.pi/agent/skills/pi-stack/.gbrain-source
```

**跨设备说明**：.gbrain-source 内容是 source id 字符串 `pi-stack`（不是路径），随 git 同步到所有设备后都解析到同一 source。设备 A `~/.pi` / B `/data/alfadb/.pi` / C `~/dotfiles/pi` 路径不同不影响。`local_path` 是本机便利，每台机首次 `gbrain sources add` 重复注册即可。

日常开发：

```bash
cd ~/.pi/agent/skills/pi-stack
$EDITOR extensions/multi-agent/runner.ts    # 直接改
git add . && git commit -m "fix: ..."
git push                                    # 推到 GitHub

cd ~/.pi
git add agent/skills/pi-stack
git commit -m "chore: bump pi-stack to <sha>"
git push
```

### 假想他人安装

```bash
pi install git:github.com/alfadb/pi-stack
```

仅作展示用途。alfadb 永远走 submodule + local path。

## 内容

### Extensions（pi 行为扩展）
- `multi-agent/` — 自带基础能力 `dispatch_agent` / `dispatch_agents`（主会话自由组合） + `vision` + `imagine`；兼容 `multi_dispatch`；4 种 cookbook 模板供主会话参考（ADR 0009）
- `sediment/` — 后台沉淀代理（gbrain 唯一写入者，v6.7 双轨 project+world，ADR 0011）
- `model-curator/` — 模型能力快照与选择建议
- `gbrain/` — 主会话记忆 read tool（`gbrain_search/get/query`），含 markdown fallback
- `retry-stream-eof/` — 流错误重试（**自有功能，不向上游 PR**）

### Skills（pi 技能）
- `memory-wand/` — 记忆库查询助手（`gbrain_*` tool 包装）
- 19 个来自 garrytan/gstack 的 skills：autoplan, review, qa, qa-only, cso, investigate, retro, plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review, office-hours, document-release, land-and-deploy, setup-deploy, canary, scrape, health, benchmark

### Prompts
- `commit.md` / `plan.md` / `review.md` / `sync-to-main.md`（4 pipelines，从 pensieve 提取；是否同步落地为 gbrain guide 节点延后到核心链路稳定后）
- `ship.md`（来自 garrytan/gstack）
- `multi-*.md`（来自 alfadb/pi-multi-agent）

## 维护节奏

上游升级**不**通过机械脚本，而是 LLM 协作工作流（vendor/gstack 适用；vendor/ 之外的"自有功能"不需要）：

1. 在 pi 当前会话里让助手 `git fetch` + `git log --oneline HEAD..origin/main` 列出上游未合入的 commit
2. 助手对每条 commit 跑 `git show` 看 diff，按性质分类（bug 修复 / 新功能 / 与 pi 无关 / 与端口层冲突）
3. 助手把分类结果呈给 alfadb，逐条讨论
4. 决策后助手用 edit 工具在 `extensions/skills/prompts/` 端口层改文件
5. `chore(vendor)` commit bump SHA，紧跟 `feat(<area>)` commit 完成端口适配
6. 助手同步更新 [UPSTREAM.md](./UPSTREAM.md)

详细工作流见 UPSTREAM.md。

## 上游关系（三分类）

详见 [UPSTREAM.md](./UPSTREAM.md) + [ADR 0006](./docs/adr/0006-component-consolidation.md)。

| 类别 | 例子 | 是否进 UPSTREAM.md |
|---|---|---|
| A 类：自有功能 | retry-stream-eof / memory-* / sediment 改造 / 4 prompts | ❌ 不进，永久 own |
| B 类：vendor 移植参考 | garrytan/gstack | ✅ 进，10 步协作工作流 |
| C 类：内部组件迁入 | pi-multi-agent / pi-sediment / pi-model-curator / pi-gstack | ❌ 不进（同一作者迁入） |

## 沉淀

pi-stack 仓内**不**自带 `.pensieve/`（pensieve 项目已退场，详见 [ADR 0005](./docs/adr/0005-pensieve-deprecated.md)）。

沉淀基础设施 = **gbrain**：
- 项目记忆 → `source: pi-stack`（federated=false）
- 跨项目准则 → `source: default`（federated=true）
- 主会话只读，sediment 单写
- offline 兜底 → ~/.pi/.gbrain-cache/markdown/（gitignored）

详见 [docs/memory-architecture.md](./docs/memory-architecture.md)。

## 设计原则

- 作者自用的 pi 工作流仓（不为多外部 contributor 优化，也不为多 harness 优化）
- 单一记忆基础设施（gbrain）+ 主会话只读 + sediment 单写
- vendor + 端口层（不 fork、不维护私有长寿命分支）
- 单一 pi-package 入口（local submodule，开发即使用）
- offline 配齐两件套兜底：sediment markdown export + read tool fallback（gbrain 部署由 alfadb 自决，不提供 docker-compose）
- model-facing tool 输入宽进严出，但保持 strict schema；兼容逻辑放 `n(args)` argument preparation hook
- 主会话只读必须机制化：deny direct gbrain writes / protected cache writes / unsafe subagent tool escalation

详见 [docs/adr/0001-pi-stack-as-personal-pi-workflow.md](./docs/adr/0001-pi-stack-as-personal-pi-workflow.md) + 后续 ADR 0002-0011。

## License

MIT
