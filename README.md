# pi-astack

> alfadb's personal pi workflow — 专为 pi 打造的个人工作流仓 + 记忆基础设施。

> **v7 update (2026-05-07):** 记忆基础设施从 gbrain (postgres+pgvector) 整体替换为**纯 markdown+git** 架构（
> [memory-architecture.md](./docs/memory-architecture.md)）。项目级知识走 `<project>/.pensieve/`，世界级知识走
> `~/.abrain/`（独立 git repo）。主会话通过 `memory_search/get/list/neighbors` 只读，sediment sidecar
> 通过 `memory_write/update/deprecate/promote/relate` 单写。gbrain 被完全去除；其 timeline/图谱方法论
> 被借鉴到 markdown 条目格式中（Compiled Truth + `## Timeline` + `graph.json`）。
>
> 历史架构演进：v6.5（gbrain 唯一存储 + 三模型投票）→ v6.6（单 agent + lookup tools）→ v6.7（双轨 gbrain sources）
> → v6.8（pensieve+gbrain 双 target）→ **v7（纯 markdown+git）**。详见 [docs/adr/](./docs/adr/) 12 条 ADR。

## 是什么

把 alfadb 用 pi-coding-agent 时所需的全部资源集中维护在一个仓里：
- pi 行为扩展（extensions/）
- pi 技能（skills/）
- pi 提示模板（prompts/）
- 记忆基础设施（markdown+git 唯一 source of truth + sediment 单写）
- 上游 vendor 引用（vendor/）

参考心智模型：**gstack 之于 claude-code 的关系，pi-astack 之于 pi 的关系一样**。作者为自己常用的 harness agent 打造一整套工作流，集成自己认同的 review/qa/security/multi-agent/memory 等能力，不断演进。不是发行版（不为不同环境打包同一软件），不是仓库集合（不是谁都可以拿出一个独立包），是**作者自用 + 作者认可的完整工作流**。

## 心智速览

| 维度 | 决策 |
|---|---|
| 单一记忆基础设施 | **markdown+git**（纯文件，零依赖，离线可用，人类可编辑） |
| 项目级存储 | `<project>/.pensieve/{maxims,decisions,knowledge,staging,archive}/` |
| 世界级存储 | `~/.abrain/`（独立 git repo，`ABRAIN_ROOT` 环境变量） |
| Sediment 写入 | 单 sidecar 写入；extract → sanitize → classify → dedupe → lint → write md → git commit |
| 主会话角色 | 只读（`memory_search` / `memory_get` / `memory_list` / `memory_neighbors`） |
| 条目格式 | frontmatter v1 + compiled truth + `## Timeline`（借鉴 gbrain 方法论） |
| Multi-agent 能力 | `dispatch_agent`/`dispatch_agents` 基础能力；主会话自由组合；sediment 单 agent 不借用 |
| 知识模型 | 7 种 kind（maxim/decision/anti-pattern/pattern/fact/preference/smell）+ confidence 0-10 + lifetime 正交 |
| Facade 模式 | LLM 只看到统一的 `memory_*` 读接口，底层存储和索引拓扑变更不影响上层 |

详见 [docs/memory-architecture.md](./docs/memory-architecture.md)（权威设计规范）+ [docs/adr/](./docs/adr/) 12 条 ADR。

> ADR 状态提示：ADR 0002 / 0005 / 0007 / 0008 / 0011 / 0012 被 memory-architecture.md superseded。ADR 0004 被 ADR 0010 superseded。

## 安装方式

### alfadb 自己（开发即使用）

**前置依赖**（零外部服务依赖）：
- 无。markdown+git 架构不需要 postgres/pgvector/gbrain CLI。
- 可选：`qmd` 用于加速全文搜索（Phase 3，详见 memory-architecture.md 附录 C）。

挂为 `~/.pi/agent/skills/pi-astack/` submodule，并在官方 pi settings chain（`~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）里用 local package path 加载。改一行立即生效。

```bash
# 一次性挂载（在 ~/.pi 仓内执行）
cd ~/.pi
git submodule add git@github.com:alfadb/pi-astack.git agent/skills/pi-astack
git submodule update --init --recursive

# ~/.pi/agent/settings.json 一行 local package path:
#   "packages": ["~/.pi/agent/skills/pi-astack"]
# 运行时配置也走官方 settings chain，例如：
#   "piStack": { "sediment": { "enabled": true } }

# 初始化世界级知识库
mkdir -p ~/.abrain
cd ~/.abrain && git init
export ABRAIN_ROOT=~/.abrain  # 加入 shell rc

# 初始化项目级知识库（在任意项目根目录）
mkdir -p .pensieve/{maxims,decisions,knowledge,staging,archive,schemas}
```

日常开发：

```bash
cd ~/.pi/agent/skills/pi-astack
$EDITOR extensions/dispatch/index.ts    # 直接改
npm run smoke:memory                    # memory/sediment 回归（改记忆基础设施时跑）
git add . && git commit -m "fix: ..."
git push                                    # 推到 GitHub

cd ~/.pi
git add agent/skills/pi-astack
git commit -m "chore: bump pi-astack to <sha>"
git push
```

### 假想他人安装

```bash
pi install git:github.com/alfadb/pi-astack
```

仅作展示用途。alfadb 永远走 submodule + local path。

## 内容

### Extensions（pi 行为扩展）
- `dispatch/` — subprocess-based `dispatch_agent` / `dispatch_agents`（主会话自由组合）；每个子 agent 是独立 pi 进程，OS 级隔离（ADR 0009）
- `memory/` — ✅ 主会话记忆 read tool（`memory_search/get/list/neighbors`），Facade 模式封装；只读扫描 `.pensieve/` + 可选 `~/.abrain/`；另含 human slash commands `/memory doctor-lite`、`/memory lint`、`/memory migrate --dry-run [--report]`、`/memory check-backlinks`、`/memory rebuild --graph`、`/memory rebuild --index`
- `sediment/` — ✅ 部分实现：checkpoint/run-window + deterministic explicit `MEMORY:` extractor + `/sediment llm --dry-run`（audit + quality gate + `/sediment llm-report` + `/sediment readiness`）+ project-only writer substrate（validate/sanitize/dedupe/lint/lock/atomic write/audit/git best-effort）+ `/sediment migrate-one --apply --yes` 单文件迁移（成功后自动重建 graph/index derived artifacts）；自动 LLM 写入仍计划中
- `model-curator/` — 模型能力快照与选择建议
- `model-fallback/` — 非对称多模型 fallback：初始模型走 pi 内建指数退避重试，耗尽后按 `modelFallback.fallbackModels` 切下一个。alfadb 当前 pi 配置：claude-code parity，1+9=10 次尝试。（旧名 retry-stream-eof → retry-all-errors；**自有功能，不向上游 PR**）

### Skills（pi 技能）
- `memory-wand/` — 记忆库查询助手（`memory_*` tool 包装）
- 19 个来自 garrytan/gstack 的 skills：autoplan, review, qa, qa-only, cso, investigate, retro, plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review, office-hours, document-release, land-and-deploy, setup-deploy, canary, scrape, health, benchmark

### Prompts
- `commit.md` / `plan.md` / `review.md` / `sync-to-main.md`（4 pipelines，从 pensieve 提取）
- `ship.md`（来自 garrytan/gstack）
- `dispatch-*.md`（pi-astack 自己）

## 维护节奏

上游升级**不**通过机械脚本，而是 LLM 协作工作流：

1. 在 pi 当前会话里让助手 `git fetch` + `git log --oneline HEAD..origin/main`
2. 助手对每条 commit 跑 `git show` 看 diff，按性质分类
3. 助手把分类结果呈给 alfadb，逐条讨论
4. 决策后助手用 edit 工具在端口层改文件
5. `chore(vendor)` commit bump SHA + `feat(<area>)` commit 完成端口适配
6. 助手同步更新 [UPSTREAM.md](./UPSTREAM.md)

## 上游关系（三分类）

详见 [UPSTREAM.md](./UPSTREAM.md) + [ADR 0006](./docs/adr/0006-component-consolidation.md)。

| 类别 | 例子 | 是否进 UPSTREAM.md |
|---|---|---|
| A 类：自有功能 | model-fallback / memory-* / sediment 改造 / 4 prompts | ❌ 不进，永久 own |
| B 类：vendor 移植参考 | garrytan/gstack | ✅ 进，LLM 协作工作流 |
| C 类：内部组件迁入 | pi-dispatch / pi-sediment / pi-model-curator / pi-gstack | ❌ 不进（同一作者迁入） |

## 沉淀

记忆基础设施 = **markdown+git**（详见 [memory-architecture.md](./docs/memory-architecture.md)）：
- 项目记忆 → `<project>/.pensieve/{maxims,decisions,knowledge,staging,archive}/`（md + git）
- 跨项目准则 → `~/.abrain/{maxims,patterns,anti-patterns,facts,staging,archive}/`（独立 git repo）
- 条目格式：frontmatter v1 + compiled truth + `## Timeline`
- 主会话只读（`memory_search/get/list/neighbors`），sediment 单写（writer substrate 已实现；`memory_write/update/deprecate/promote/relate` 自动写接口仍计划中）
- 派生索引（`graph.json`）gitignored，可从 markdown 重建

## 设计原则

- 作者自用的 pi 工作流仓（不为多外部 contributor 优化，也不为多 harness 优化）
- 单一记忆基础设施（markdown+git）+ 主会话只读 + sediment 单写
- vendor + 端口层（不 fork、不维护私有长寿命分支）
- 单一 pi-package 入口（local submodule，开发即使用）
- 纯文件 + git：零服务依赖，离线可用，人类可编辑，天然版本控制
- model-facing tool 输入宽进严出，但保持 strict schema；兼容逻辑放 `n(args)` argument preparation hook
- 主会话只读必须机制化：sediment 独享写工具注册

详见 [docs/adr/0001-pi-astack-as-personal-pi-workflow.md](./docs/adr/0001-pi-astack-as-personal-pi-workflow.md) + 后续 ADR 0002-0012 + [docs/memory-architecture.md](./docs/memory-architecture.md)。

## License

MIT
