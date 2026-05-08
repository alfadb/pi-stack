# pi-astack 目录布局与所有权

> **v7 更新提示**（[memory-architecture.md](./memory-architecture.md)）：记忆基础设施从 gbrain (postgres+pgvector) 整
> 体替换为纯 markdown+git。`extensions/sediment/` 不再依赖 gbrain CLI；写入目标为 `<project>/.pensieve/`
> 和 `~/.abrain/` 的 markdown 文件。`.gbrain-source` / `.gbrain-cache/` / `.gbrain-scratch` 等 dotfile
> 全部作废。`extensions/gbrain/` 被 `extensions/memory/` 替代（`memory_search/get/list/neighbors`）。
>
> 历史归档：`extensions/sediment/.v6.7-archive/`（双轨 source routing）、`extensions/sediment/.v6.5-archive/`（三模型投票）。

```
alfadb/pi-astack/
│
├── package.json                       # pi-package manifest
├── README.md
├── UPSTREAM.md                        # 上游跟踪（B 类 vendor）+ 三分类说明
├── LICENSE                            # MIT
├── .gitignore
├── .gitmodules                        # vendor/gstack only
│
├── docs/
│   ├── memory-architecture.md         # 权威设计规范（v7 记忆架构）
│   ├── directory-layout.md            # 本文件
│   ├── adr/
│   │   ├── 0001-pi-astack-as-personal-pi-workflow.md
│   │   ├── 0002-gbrain-as-sole-memory-store.md          # superseded by memory-architecture.md
│   │   ├── 0003-main-session-read-only.md                # 原则保留，guard 实现过时
│   │   ├── 0004-sediment-write-strategy.md               # superseded by ADR 0010
│   │   ├── 0005-pensieve-deprecated.md                   # superseded by memory-architecture.md
│   │   ├── 0006-component-consolidation.md
│   │   ├── 0007-offline-degraded-mode.md                 # 前提被 memory-architecture.md 改变
│   │   ├── 0008-pi-dotfiles-dual-role.md                 # .gbrain-source 作废
│   │   ├── 0009-multi-agent-as-base-capability.md
│   │   ├── 0010-sediment-single-agent-with-lookup-tools.md # 内核保留，tools 过时
│   │   ├── 0011-sediment-two-track-pipeline.md           # superseded by memory-architecture.md
│   │   └── 0012-sediment-pensieve-gbrain-dual-target.md  # superseded by memory-architecture.md
│   └── migration/
│       ├── steps.md                   # 基于 memory-architecture.md Phase 1-6
│       └── open-questions.md          # 适配新架构的待澄清问题
│
├── defaults/
│   └── pi-astack.defaults.json         # package-local fallback / 文档示例
│                                      # 运行时配置走官方 pi settings chain: piStack.*
│
├── vendor/                            # ▼▼▼ READ-ONLY，仅作 diff/参考源 ▼▼▼
│   └── gstack/                        # submodule → garrytan/gstack@bf65487
│
├── extensions/                        # ▼▼▼ pi 行为扩展，alfadb own ▼▼▼
│   ├── dispatch/                      # subtree from alfadb/pi-dispatch + ADR 0009 重构
│   │   ├── package.json
│   │   ├── index.ts                   # pi.n() registered tool: dispatch_agent / dispatch_agents
│   │   │                              #              + vision + imagine
│   │   ├── runner.ts
│   │   ├── subagent-tools.ts
│   │   ├── input-compat.ts            # n(args) argument preparation hook (ADR 0009 § 2.5)
│   │   ├── input-compat.test.ts       # 兑底层单测
│   │   ├── templates/                 # 调用模式 cookbook
│   │   │   ├── parallel.md
│   │   │   ├── debate.md
│   │   │   ├── chain.md
│   │   │   └── ensemble.md
│   │   └── tools/
│   │       ├── vision-core.ts
│   │       ├── imagine-core.ts
│   │       └── ...
│   ├── sediment/                      # v7 单 agent + markdown 写入（memory-architecture.md §8）
│   │   ├── package.json
│   │   ├── index.ts                   # agent_end 监听 + setTimeout(0) 异步派发
│   │   ├── config.ts                  # 三级 fallback：env → settings.json → defaults
│   │   ├── agent-loop.ts              # multi-turn LLM with tool use
│   │   ├── sediment-agent.ts          # 单 agent loop + markdown 终结符 parser
│   │   ├── lookup-tools.ts            # memory_search / memory_get（只读，去 pensieve/grep）
│   │   ├── markdown-writer.ts         # 原子写入 .pensieve/ 或 ~/.abrain/（tmp → rename）
│   │   ├── graph-builder.ts           # graph.json 增量构建（best-effort）
│   │   ├── lint.ts                    # 10 条 Lint 规则（T1-T10）
│   │   ├── commands.ts                # /memory-pending /memory-doctor 等 slash commands
│   │   ├── .v6.7-archive/             # v6.7 双轨 source routing 模块归档
│   │   └── .v6.5-archive/             # v6.5 三模型投票模块归档
│   ├── memory/                        # v7 主会话只读工具（替代旧 extensions/gbrain/）
│   │   ├── package.json
│   │   ├── index.ts                   # pi.n() registered: memory_search/get/list/neighbors
│   │   └── facade.ts                  # Memory Facade: 路由、RRF 融合、project boost、排序
│   ├── model-curator/                 # cp from agent/skills/pi-model-curator
│   │   ├── package.json
│   │   ├── index.ts
│   │   └── catalog.json
│   ├── browse/                        # from pi-gstack/extensions/browse
│   │   └── ...
│   └── model-fallback/                # from agent/extensions/retry-stream-eof.ts（改名升级）
│       └── index.ts                   # 自有功能，永久 own，不向上游 PR
│
├── skills/                            # ▼▼▼ pi 技能，alfadb own ▼▼▼
│   ├── memory-wand/                   # 改名重写自 pensieve-wand，memory_* tool 包装
│   │   └── SKILL.md
│   ├── autoplan/                      # 19 个来自 garrytan/gstack
│   │   └── SKILL.md
│   ├── review/
│   │   ├── SKILL.md
│   │   └── references/                # 8 个 .md
│   ├── qa/
│   │   ├── SKILL.md
│   │   └── references/                # 2 个 .md
│   ├── qa-only/
│   ├── cso/
│   │   ├── SKILL.md
│   │   └── references/owasp-top10.md
│   ├── investigate/
│   ├── retro/
│   ├── plan-ceo-review/
│   ├── plan-eng-review/
│   ├── plan-design-review/
│   ├── plan-devex-review/
│   │   ├── SKILL.md
│   │   └── references/dx-hall-of-fame.md
│   ├── office-hours/
│   ├── document-release/
│   ├── land-and-deploy/
│   ├── setup-deploy/
│   ├── canary/
│   ├── scrape/
│   ├── health/
│   └── benchmark/
│
└── prompts/                           # ▼▼▼ pi 提示模板，alfadb own ▼▼▼
    ├── commit.md                      # 从 pensieve pipeline 提取
    ├── plan.md
    ├── review.md
    ├── sync-to-main.md
    ├── ship.md                        # from garrytan/gstack
    └── dispatch-*.md                  # from alfadb/pi-dispatch/prompts
```

## 关键变化（v7 vs v6.8）

| 项 | v6.8（ADR 0012） | v7（memory-architecture.md） |
|---|---|---|
| 记忆存储 | gbrain default + `.pensieve/` 双 target | 纯 markdown+git（`.pensieve/` + `~/.abrain/`） |
| 世界级存储 | gbrain default source | `~/.abrain/` 独立 git repo |
| 读工具 | `gbrain_search/get/query` | `memory_search/get/list/neighbors` |
| 写工具 | `gbrain put` via CLI | `memory_write/update/deprecate/promote/relate` |
| extensions/gbrain/ | 主会话 read tool + markdown fallback | → `extensions/memory/`（Facade 模式） |
| extensions/sediment/ | 双 target（pensieve writer + gbrain agent） | 统一 markdown writer + graph builder |
| .gbrain-source dotfile | 两份，commit 进 git | **删除**（作废） |
| .gbrain-cache/ | markdown export 兜底 | **删除**（git 本身就是 source of truth） |
| 条目格式 | gbrain page type + tags | frontmatter v1 + compiled truth + `## Timeline` |
| 知识模型 | pensieve 4 象限 | 7 种 kind + confidence + lifetime |
| graph 索引 | 无 | graph.json（派生，gitignored） |
| Lint 规则 | 无 | 10 条确定性规则（T1-T10） |
| Health 评分 | 无 | 5 指标腐烂避免评分 |

## 所有权与依赖矩阵

| 目录 | 所有者 | 是否被 pi 加载 | 是否可修改 |
|---|---|---|---|
| `vendor/gstack/` | garrytan | ❌ | ❌ 只读 |
| `extensions/dispatch/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/sediment/` | alfadb（C 类迁入 + A 类改造） | ✅ pi.extensions | ✅ |
| `extensions/sediment/prompts/` | alfadb（A 类） | ❌ 主会话不见 | ✅ |
| `extensions/memory/` | alfadb（v7 新建） | ✅ pi.extensions | ✅ |
| `extensions/model-curator/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/browse/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/dispatch/input-compat.ts` | alfadb（A 类自有） | 被 handler import | ✅ |
| `extensions/dispatch/templates/*` | alfadb（供主会话参考） | ✅ promptSnippet 指向 | ✅ |
| `extensions/model-fallback/` | alfadb（A 类永久 own） | ✅ pi.extensions | ✅ |
| `skills/memory-wand/` | alfadb（A 类） | ✅ pi.skills | ✅ |
| `skills/{19 个}/` | alfadb（B 类端口） | ✅ pi.skills | ✅ |
| `prompts/{commit,plan,review,sync-to-main}.md` | alfadb（A 类） | ✅ pi.prompts | ✅ |
| `prompts/ship.md` | alfadb（B 类端口） | ✅ pi.prompts | ✅ |
| `prompts/dispatch-*.md` | alfadb（C 类迁入） | ✅ pi.prompts | ✅ |
| `defaults/pi-astack.defaults.json` | alfadb | ❌（fallback / 文档示例） | ✅ |
| `docs/memory-architecture.md` | alfadb（权威设计规范） | ❌ | ✅ |
| `docs/adr/` | alfadb | ❌ | ✅ |
| `UPSTREAM.md` | alfadb | ❌ | ✅（每次 vendor bump 必更新） |

## 单向依赖图

```
                    pi 加载机制
                       │
        ┌──────────────┼─────────────┐
        ▼              ▼             ▼
  pi.extensions  pi.skills   pi.prompts
        │            │            │
        ▼            ▼            ▼
  extensions/    skills/    prompts/
        │
        │ 写入 / 读取
        ▼
   markdown + git (source of truth)
   ├── <project>/.pensieve/     (项目级)
   └── ~/.abrain/               (世界级)
        │
        │ 派生索引
        ▼
   .pensieve/.index/graph.json   (gitignored, 可重建)
   ~/.abrain/.state/index/graph.json
```

**严禁的引用关系**:
1. `extensions/* → vendor/*`（端口层不能依赖 vendor）
2. `skills/* / prompts/* → 任何代码`（声明式资源）
3. `vendor/* → 任何 pi-astack 内容`（vendor 是 read-only 上游快照）

## 资源类型 vs pi 加载机制对照

| pi 资源类型 | 本仓位置 | 加载方式 |
|---|---|---|
| Extensions | `extensions/` | `package.json` 的 `pi.extensions` 数组扫描 |
| Skills | `skills/` | `package.json` 的 `pi.skills` 数组扫描，找 `SKILL.md` |
| Prompts | `prompts/` | `package.json` 的 `pi.prompts` 数组扫描，加载 `.md` |
| Themes | （无） | — |
| Vendor sources | `vendor/` | **不被 pi 加载**，仅作参考 |
| 配置 | 官方 settings chain | 运行时读取 `piStack.*`；`defaults/` 仅 fallback/文档示例 |
| 内部 prompts（sediment 用） | `extensions/sediment/prompts/` | **不被 pi 加载**，sediment 内部读取 |
| Dispatch cookbook | `extensions/dispatch/templates/` | 主会话 promptSnippet 中提示可读 |
