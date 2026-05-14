# pi-astack

> alfadb's personal pi workflow — 专为 pi 打造的个人工作流仓 + 记忆基础设施。

> **v7 update (2026-05-07):** 记忆基础设施从 gbrain (postgres+pgvector) 整体替换为**纯 markdown+git** 架构（
> [memory-architecture.md](./docs/memory-architecture.md)）。项目级知识走 `<project>/.pensieve/`，世界级知识走
> `~/.abrain/`（独立 git repo）。主会话通过 `memory_search/get/list/neighbors` 只读，sediment sidecar
> 通过内部 writer substrate 单写（create/update/merge/archive/supersede/delete/skip），不暴露 LLM-facing 写工具。
> gbrain 被完全去除；其 timeline/图谱方法论被借鉴到 markdown 条目格式中（Compiled Truth + `## Timeline` + `graph.json`）。
>
> **v7.1 update (2026-05-09 起持续 v1.x 迭代，[ADR 0014](./docs/adr/0014-abrain-as-personal-brain.md) + [brain-redesign-spec.md](./docs/brain-redesign-spec.md)):** `~/.abrain/` 从「跨项目 world knowledge 仓库」重定位为 alfadb 数字孪生 / Jarvis 大脑——七区结构（identity / skills / habits / workflows / projects / knowledge / vault）。`.pensieve/` 已由 ADR 0014 废止（设计层面），当前 14 仓按需通过 `/memory migrate --go` 一次性迁移到 `~/.abrain/projects/<id>/`（B4 ✅ shipped 2026-05-12；B4.5 project binding strict mode ✅ shipped 2026-05-12，见 [ADR 0017](./docs/adr/0017-project-binding-strict-mode.md)：先 `/abrain bind --project=<id>`，再 `/memory migrate --dry-run` / `--go`；`/memory migrate --project=<id>` 已废弃并拒绝）。已 ship 节点：vault P0a-c 子集（`/secret` + `/vault`，age 加密 + portable identity backend）；B1 abrain workflows lane writer；B3+B7 per-file migration substrate 剥离；B4 per-repo `/memory migrate --go` 含 preflight + frontmatter 归一化 + pipeline routing + 索引重建 + pre-migration SHA rollback。待实施：B5 sediment writeProjectEntry cutover 到 abrain projects 路径、P0d vault TUI wizard、Lane G (about-me) + identity/skills/habits writer。
>
> 历史架构演进：v6.5（gbrain 唯一存储 + 三模型投票）→ v6.6（单 agent + lookup tools）→ v6.7（双轨 gbrain sources）
> → v6.8（pensieve+gbrain 双 target）→ **v7（纯 markdown+git）→ v7.1（abrain 重定位为数字孪生）**。详见 [docs/adr/](./docs/adr/) 18 条 ADR（含 [ADR 0015](./docs/adr/0015-memory-search-llm-driven-retrieval.md) memory_search LLM-driven retrieval、[ADR 0016](./docs/adr/0016-sediment-as-llm-curator.md) sediment 从 gate-heavy extractor 转向 LLM curator，以及 [ADR 0017](./docs/adr/0017-project-binding-strict-mode.md) project binding strict mode、[ADR 0018](./docs/adr/0018-sediment-curator-defense-layers.md) curator 三层防御）。

## 是什么

把 alfadb 用 pi-coding-agent 时所需的全部资源集中维护在一个仓里：
- pi 行为扩展（extensions/）
- pi 技能（skills/）
- pi 提示模板（prompts/）
- 记忆基础设施（markdown+git 唯一 source of truth + sediment 单写）
- 上游 vendor 引用（vendor/）`[计划 — 当前未挂载，详见 UPSTREAM.md]`

参考心智模型：**gstack 之于 claude-code 的关系，pi-astack 之于 pi 的关系一样**。作者为自己常用的 harness agent 打造一整套工作流，集成自己认同的 review/qa/security/multi-agent/memory 等能力，不断演进。不是发行版（不为不同环境打包同一软件），不是仓库集合（不是谁都可以拿出一个独立包），是**作者自用 + 作者认可的完整工作流**。

## 心智速览

| 维度 | 决策 |
|---|---|
| 单一记忆基础设施 | **markdown+git**（纯文件，零依赖，离线可用，人类可编辑） |
| 项目级存储 | Phase 1.4 当前：`<project>/.pensieve/{maxims,decisions,knowledge,staging,archive}/`；Phase 2 起迁入 `~/.abrain/projects/<id>/`（详见 [abrain-pensieve-migration.md](./docs/migration/abrain-pensieve-migration.md)） |
| 世界级存储 | `~/.abrain/`（独立 git repo；v7.1 七区结构：identity/skills/habits/workflows/projects/knowledge/vault；`ABRAIN_ROOT` 环境变量） |
| Sediment 写入 | 单 sidecar 写入；LLM curator → sensitive sanitize → memory_search lookup → op∈{create,update,merge,archive,supersede,delete,skip} → lint → atomic write → audit → git（ADR 0016 curator 模型） |
| 主会话角色 | 记忆只读（`memory_search` / `memory_get` / `memory_list` / `memory_neighbors`）；vault 走用户授权 `vault_release(key, scope?, reason?)`（sub-pi 不注册；bash 侧走 `$VAULT_*` / `$PVAULT_*` / `$GVAULT_*` 注入，默认 stdout 不回流 LLM） |
| 条目格式 | frontmatter v1 + compiled truth + `## Timeline`（借鉴 gbrain 方法论） |
| Multi-agent 能力 | `dispatch_agent`/`dispatch_parallel` 基础能力；主会话自由组合；sediment 单 agent 不借用 |
| 知识模型 | 7 种 kind（maxim/decision/anti-pattern/pattern/fact/preference/smell）+ confidence 0-10 + lifetime 正交 |
| Facade 模式 | LLM 只看到统一的 `memory_*` 读接口，底层存储和索引拓扑变更不影响上层 |

详见 [docs/memory-architecture.md](./docs/memory-architecture.md)（权威设计规范，§4.1 物理拓扑部分被 ADR 0014 supersede）+ [docs/brain-redesign-spec.md](./docs/brain-redesign-spec.md)（abrain 七区拓扑权威）+ [docs/adr/](./docs/adr/) 18 条 ADR。

> ADR 状态提示：ADR 0002 / 0005 / 0007 / 0008 / 0011 / 0012 被 memory-architecture.md superseded；ADR 0004 被 ADR 0010 superseded；memory-architecture.md §4.1（物理拓扑） + ADR 0013 Lane B/D 被 ADR 0014 §D3 supersede；ADR 0013 Lane C 的 G2-G13 / readiness / rolling / rate / sampling 机械 gate 被 ADR 0016 删除；ADR 0017 已实施 B4.5 Project Binding Strict Mode，并取代 ADR 0014 / brain-redesign-spec 中旧的 `_bindings.md` + remote/cwd 推断模型（详见各 ADR 顶部状态字段）。
>
> 文件布局参考：[docs/directory-layout.md](./docs/directory-layout.md) — 反映当前实际实现状态。

## 安装方式

### alfadb 自己（开发即使用）

**前置依赖**（零外部服务依赖）：
- 无。markdown+git 架构不需要 postgres/pgvector/gbrain CLI。
- 可选：`qmd` 作为可选 BM25 augmentation（Phase 3，非 LLM retrieval fallback；详见 memory-architecture.md 附录 C）。
- vault backend 可通过 `SECRETS_BACKEND` 环境变量手动覆盖自动检测（可选值：`ssh-key` / `gpg-file` / `macos` / `secret-service` / `pass` / `passphrase-only` / `disabled`）。

挂为 `~/.pi/agent/skills/pi-astack/` submodule，并在官方 pi settings chain（`~/.pi/agent/settings.json` 或项目 `.pi/settings.json`）里用 local package path 加载这份扩展本身。改一行立即生效。

> **运行时配置在哪（2026-05-11 澄清）**：pi-astack 各扩展的运行时配置不走 pi 官方 settings chain / 也不包裹在 `piStack` 命名空间下。所有扩展直接 `fs.readFileSync` 读 `~/.pi/agent/pi-astack-settings.json`，顶层 key 就是扩展名（`memory.*` / `sediment.*` / `modelFallback.*` / `compactionTuner.*` / `vision.*` / …）。schema 见 `pi-astack-settings.schema.json`。

```bash
# 一次性挂载（在 ~/.pi 仓内执行）
cd ~/.pi
git submodule add git@github.com:alfadb/pi-astack.git agent/skills/pi-astack
git submodule update --init --recursive

# 1) ~/.pi/agent/settings.json 一行 local package path 加载扩展本身:
#   "packages": ["~/.pi/agent/skills/pi-astack"]
#
# 2) ~/.pi/agent/pi-astack-settings.json 里顶层 key 调运行时配置（不要包裹在 piStack 下，不是 pi 官方 chain）:
#   {"sediment": {"enabled": true}, "memory": {"search": {"stage1Model": "deepseek/deepseek-v4-flash"}}, "vision": {"modelPreferences": [...]}}

# 初始化 abrain 世界级知识库（v7.1 七区结构）
mkdir -p ~/.abrain/{identity,skills,habits,workflows,projects,knowledge,vault}
cd ~/.abrain && git init
export ABRAIN_ROOT=~/.abrain  # 加入 shell rc

# 初始化 vault（age 加密后端；进入 pi 会话后执行 /vault init 或手动指定 backend）
# 详见 docs/migration/vault-bootstrap.md

# 初始化项目级知识库（Phase 1.4 当前位置；Phase 2 起将迁入 ~/.abrain/projects/<id>/）
# ⚠️ 在项目根目录下执行（不是 ~/.pi 里）
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
- `dispatch/` — subprocess-based `dispatch_agent` / `dispatch_parallel`（主会话自由组合）；每个子 agent 是独立 pi 进程，OS 级隔离（ADR 0009）。子进程 env 强制注入 `PI_ABRAIN_DISABLED=1` 让 abrain extension 在 sub-pi 中 register nothing（brain-redesign-spec v1.3 P0-1）
- `memory/` — ✅ 主会话记忆 read tool（`memory_search/get/list/neighbors`），Facade 模式封装；`memory_search` 走 ADR 0015 双阶段 LLM retrieval（stage1候选 + stage2精排，默认 stage1 thinking=off + stage2 thinking=off（两阶段模型都默认 `deepseek/deepseek-v4-flash`，满足交互式延迟要求，可通过 `memory.search.stage1Thinking / stage2Thinking` 调高）），失败 hard error，不降级到 grep；结果带 created/updated/rank_reason/timeline_tail 新鲜度信号；只读扫描 `.pensieve/` + 可选 `~/.abrain/`；另含 human slash commands `/memory doctor-lite`、`/memory lint`、`/memory migrate --dry-run [--report]`、`/memory check-backlinks`、`/memory rebuild --graph`、`/memory rebuild --index`。B4.5 后 `/memory migrate` 必须先由 `/abrain bind --project=<id>` 建立 strict binding，迁移命令不再接收 `--project`。
- `abrain/` — ✅ vault P0a-c 子集（ADR 0014 §D4）：`/vault status` / `/vault init [--backend=X]` + `/secret set/list/forget --global <key>=<value>`。Backend detection 优先级 ssh-key → gpg-file → macos → secret-service → pass → passphrase-only → disabled（[vault-bootstrap.md](./docs/migration/vault-bootstrap.md) v1.4 portable-identity 矩阵；容器场景头号 first-class）。Master key（`~/.abrain/.vault-master.age`）用 portable identity 加密；vault writer 不接触明文 master key，全部加密走 `~/.abrain/.vault-pubkey`。P0c.read core substrate、`vault_release` LLM tool 与 bash 注入已落地（unlock master + default-deny TUI 授权 + decrypt per-key secret + literal redaction / default-withheld bash output）。`/secret` 已默认 boot-time active project，`$VAULT_<key>` project→global fallback、`$GVAULT_<key>` global-only、`$PVAULT_<key>` project-only；`vault_release(key, scope?, reason?)` 可选 `'global'` / `'project'`；`/secret list --all-projects` 扫描全部 `projects/<id>/vault` 的 metadata，不解密。详 [brain-redesign-spec.md §6](./docs/brain-redesign-spec.md)
- `imagine/` — ✅ `imagine(prompt, size?, quality?, style?, model?)` tool，OpenAI Responses API 生图（默认 `gpt-image-2`，可通过 `model?` 覆盖）；PNG 落 `.pi-astack/imagine/`，调用方支持图片输入则 inline 返回
- `vision/` — ✅ `vision(imageBase64? | path?, prompt)` tool，自动从可用 provider 选最佳 vision-capable 模型；用于当前模型不支持图片输入时降级
- `sediment/` — ✅ Phase 1.4 + ADR 0016：checkpoint/run-window（per-session + RMW 锁）+ deterministic explicit `MEMORY:` extractor（fence-aware）+ `agent_end` 上的 LLM auto-write lane；无 `.pensieve/` 时 writer 按需创建；同 session bg 在飞时不推进 checkpoint、不写 skip audit（agent_end 静默跳过）；bg 完成后若主会话 LLM 不在运行则立即检查 backlog，有则递归 drain（主动排空）；已删除 dry-run/readiness/rate/sampling/rolling/G2-G13 机械门控，直接调用 LLM extractor + ADR 0015 `memory_search` 找近邻，再由 curator LLM 输出 create/update/merge/archive/supersede/delete/skip；project-only writer substrate 只保留 sensitive-info sanitizer（JWT/PEM/AWS/connection URL 等）+ storage integrity（schema/lint/slug collision/lock/atomic write/audit/git best-effort）+ `updateProjectEntry` / `mergeProjectEntries` / `archiveProjectEntry` / `supersedeProjectEntry` / `deleteProjectEntry` 更新/归档/取代/删除基座；audit summary 与 writer rows 共享 `correlation_id` / `candidate_id`；B1 新增 `writeAbrainWorkflow` 将 pipeline-型条目路由到 `~/.abrain/workflows/`；B4 推动的 per-repo 一次性迁移走 `/memory migrate --go`（preflight 检查父仓/abrain 仓 git clean + frontmatter 归一化 + pipeline 路由 + 两边各一个 commit；rollback 用 preflight 阶段捕获的 `parentPreSha` / `abrainPreSha`，summary 末尾打印 `git reset --hard <sha>` 命令——abrain 侧有 N+1 commits 时 `HEAD~1` 不够，spec 见 [abrain-pensieve-migration.md §3](./docs/migration/abrain-pensieve-migration.md)）。Slash command 仅保留 `/sediment status` + `/sediment dedupe --title <title>`，原 per-file `migrate-one` / `migration-backups` 于 2026-05-12 剥离。迁移历史见 [docs/migration/apply-checklist.md](./docs/migration/apply-checklist.md)
- `model-curator/` — 模型能力快照与选择建议
- `model-fallback/` — 非对称多模型 fallback：初始模型走 pi 内建指数退避重试，耗尽后按 `modelFallback.fallbackModels` 切下一个。alfadb 当前 pi 配置：claude-code parity，1+9=10 次尝试。（旧名 retry-stream-eof → retry-all-errors；**自有功能，不向上游 PR**）
- `compaction-tuner/` — 按百分比阈值触发 pi compaction。解决 pi 内建 `reserveTokens` 是绝对数值、跨 200k–1M+ contextWindow 模型无法表达统一百分比的问题。Hook `agent_end` 读 `ctx.getContextUsage()`，`percent >= thresholdPercent` 时 `ctx.compact()`。Hysteresis (`rearmMarginPercent`) 防重复触发。Pi 默认 reserveTokens=16384 仍作底线 safety net。Slash command `/compaction-tuner [status|trigger]`。Audit 在 `<projectRoot>/.pi-astack/compaction-tuner/audit.jsonl`。默认 opt-out；详见 `pi-astack-settings.schema.json#compactionTuner`。

### Skills（pi 技能）`[计划]`
> **状态（2026-05-11）**：以下 skills 尚未迁入本仓。原 `alfadb/pi-gstack` 中对应文件仍存在但未 cp 到当前仓库。计划在 Slice F 补齐。

- `memory-wand/` — 记忆库查询助手（`memory_*` tool 包装）
- 19 个来自 garrytan/gstack 的 skills：autoplan, review, qa, qa-only, cso, investigate, retro, plan-ceo-review, plan-eng-review, plan-design-review, plan-devex-review, office-hours, document-release, land-and-deploy, setup-deploy, canary, scrape, health, benchmark

### Prompts `[计划]`
> **状态（2026-05-11）**：以下 prompts 尚未迁入本仓。

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
- 项目记忆 → 未迁仓：`<project>/.pensieve/{maxims,decisions,knowledge,staging,archive,pipelines}/`（legacy，memory facade dual-read）；已迁仓：`~/.abrain/projects/<id>/`，走 `/abrain bind --project=<id>` → `/memory migrate --dry-run` → `/memory migrate --go`（ADR 0014 B4 + ADR 0017 B4.5 已 ship；迁移命令已拒绝 `--project` 参数；14 仓逐个手动触发，不是一次性全局切换）
- 跨项目准则 → `~/.abrain/knowledge/`（v7.1 七区之 knowledge 区；独立 git repo）
- 条目格式：frontmatter v1 + compiled truth + `## Timeline`
- 主会话只读（`memory_search/get/list/neighbors`），sediment 单写（内部 writer substrate 已实现：create/update/merge/archive/supersede/delete/skip；不计划暴露 LLM-facing 写工具）
- 派生索引（`graph.json`）gitignored，可从 markdown 重建

## 设计原则

- 作者自用的 pi 工作流仓（不为多外部 contributor 优化，也不为多 harness 优化）
- 单一记忆基础设施（markdown+git）+ 主会话只读 + sediment 单写
- vendor + 端口层（不 fork、不维护私有长寿命分支）
- 单一 pi-package 入口（local submodule，开发即使用）
- 纯文件 + git：零服务依赖，离线可用，人类可编辑，天然版本控制
- model-facing tool 输入宽进严出，但保持 strict schema；兼容逻辑放 `n(args)` argument preparation hook
- 主会话只读必须机制化：sediment 独享写工具注册

详见 [docs/adr/0001-pi-astack-as-personal-pi-workflow.md](./docs/adr/0001-pi-astack-as-personal-pi-workflow.md) + 后续 ADR 0002-0018 + [docs/memory-architecture.md](./docs/memory-architecture.md)。

## License

MIT
