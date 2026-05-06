# pi-stack 目录布局与所有权

> **v6.8 更新提示**（[ADR 0012](./adr/0012-sediment-pensieve-gbrain-dual-target.md)）：`extensions/sediment/` 已重新架构为 `garrytan/pi-sediment` 象限架构。本文档 `extensions/sediment/` 子节下的文件清单已过时（作者记忆中的
> tracks.ts / source-resolver.ts / source-registry.ts / checkpoint.ts / audit-logger.ts / pending-queue.ts / secret-scanner.ts 都被归档到 `extensions/sediment/.v6.7-archive/`）。实际文件清单请看下面 v6.8 指南。

```
alfadb/pi-stack/
│
├── package.json                       # pi-package manifest
├── README.md
├── UPSTREAM.md                        # 上游跟踪（B 类 vendor）+ 三分类说明
├── LICENSE                            # MIT
├── .gitignore
├── .gitmodules                        # vendor/gstack only
│                                      # （不包含 docker-compose.yml：详见 ADR 0007，
│                                       gbrain 部署由 alfadb 自决）
│
├── docs/
│   ├── memory-architecture.md         # 架构总览
│   ├── directory-layout.md            # 本文件
│   ├── adr/
│   │   ├── 0001-pi-stack-as-personal-pi-workflow.md
│   │   ├── 0002-gbrain-as-sole-memory-store.md
│   │   ├── 0003-main-session-read-only.md
│   │   ├── 0004-sediment-write-strategy.md
│   │   ├── 0005-pensieve-deprecated.md
│   │   ├── 0006-component-consolidation.md
│   │   ├── 0007-offline-degraded-mode.md
│   │   ├── 0008-pi-dotfiles-dual-role.md
│   │   └── 0009-multi-agent-as-base-capability.md
│   └── migration/
│       ├── steps.md                   # 7 阶段迁移路径
│       └── open-questions.md          # 待澄清问题
│
├── defaults/
│   └── pi-stack.defaults.json         # package-local fallback / 文档示例
│                                      # 运行时配置走官方 pi settings chain: piStack.*
│
├── vendor/                            # ▼▼▼ READ-ONLY，仅作 diff/参考源 ▼▼▼
│   └── gstack/                        # submodule → garrytan/gstack@bf65487
│                                      # （没有 vendor/pensieve，详见 ADR 0005）
│
├── extensions/                        # ▼▼▼ pi 行为扩展，alfadb own ▼▼▼
│   ├── multi-agent/                   # subtree from alfadb/pi-multi-agent + ADR 0009 重构
│   │   ├── package.json
│   │   ├── index.ts                   # pi.n() registered tool: dispatch_agent / dispatch_agents (新)
│   │   │                              #              + multi_dispatch (兼容)
│   │   │                              #              + vision + imagine
│   │   ├── runner.ts
│   │   ├── subagent-tools.ts
│   │   ├── input-compat.ts            # n(args) argument preparation hook 输入兑底层 (ADR 0009 § 2.5)
│   │   │                              # 保持 strict parameters schema；不使用 Type.Any 绕过
│   │   │                              # JSON 字符串 ↔ 对象/数组（双重 unwrap）
│   │   │                              # array → CSV / 数字字符串 → number
│   │   ├── input-compat.test.ts       # 兑底层单测（纯函数，必跑）
│   │   ├── templates/                 # 主会话参考的调用模式 cookbook (ADR 0009)
│   │   │   ├── parallel.md            # 独立并行 cookbook
│   │   │   ├── debate.md              # 多轮辩论 cookbook
│   │   │   ├── chain.md               # 串行接力 cookbook
│   │   │   └── ensemble.md            # 投票综合 cookbook
│   │   └── tools/
│   │       ├── vision-core.ts         # vision tool 实现（pi-multi-agent 自带）
│   │       ├── imagine-core.ts        # imagine tool 实现（pi-multi-agent 自带）
│   │       └── ...
│   ├── sediment/                      # v6.6 单 agent + lookup tools 沉淀（ADR 0010 替代原 v6.5 多 voter 方案 ADR 0004）
│   │   ├── package.json
│   │   ├── index.ts                   # agent_end 监听 + setTimeout(0) 异步派发
│   │   ├── config.ts                  # 三级 fallback：env → settings.json → defaults
│   │   ├── checkpoint.ts              # ~/.gbrain-cache/sediment-checkpoint.json 增量 window
│   │   ├── entry-text.ts              # entryToText / contentToText / buildWindowText
│   │   ├── gbrain-agent.ts            # ADR 0010: 单 agent loop + markdown 终结符 parser
│   │   ├── agent-loop.ts              # multi-turn LLM with tool use
│   │   ├── lookup-tools.ts            # gbrain_search / gbrain_get（只读，代替 quorum dedupe）
│   │   ├── source-router.ts           # ADR 0008: 官方 resolver + source trust guard + 显式 --source
│   │   ├── secret-scanner.ts          # pre-LLM redact + post-LLM rescan
│   │   ├── marker-scanner.ts          # 注入 marker 检测（dogfooding bypass 中，待恢复）
│   │   ├── gbrain-writer.ts           # gbrainPut / gbrainGet / gbrainExport / gbrainDelete
│   │   ├── commands.ts                # /memory-pending /memory-source /memory-log-level
│   │   ├── markdown-exporter.ts       # ADR 0007: 定期 export 到 ~/.pi/.gbrain-cache/
│   │   ├── pending-queue.ts           # parse_failure / write 失败 / secret hit 兜底队列
│   │   ├── audit-logger.ts            # 写入 ~/.pi/.gbrain-cache/sediment.log
│   │   ├── .v6.5-archive/             # v6.5 走不通的模块归档（voter / classifier / context-budget）
│   │   └── prompts/                   # 废弃：v6.6 system prompt 直接在 gbrain-agent.ts 里，不再拆文件
│   │                                  # 其 rubric 合并进单 GBRAIN_AGENT_PROMPT（避免 v6.5 模板拼接脆弱性）
│   ├── model-curator/                 # cp from agent/skills/pi-model-curator
│   │   ├── package.json
│   │   ├── index.ts
│   │   └── catalog.json
│   ├── gbrain/                        # cp from agent/extensions/gbrain + M6 fallback
│   │   └── index.ts                   # pi.n() registered tool: gbrain_search / get / query
│   ├── browse/                        # from pi-gstack/extensions/browse
│   │   └── ...
│   └── retry-stream-eof/              # from agent/extensions/retry-stream-eof.ts
│       └── index.ts                   # 自有功能，永久 own，不向上游 PR
│
├── skills/                            # ▼▼▼ pi 技能，alfadb own ▼▼▼
│   ├── memory-wand/                   # 改名重写自 pensieve-wand，gbrain_* tool 包装
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
    ├── commit.md                      # 从 pensieve pipeline.run-when-committing.md 提取
    ├── plan.md                        # 从 pensieve pipeline.run-when-planning.md 提取
    ├── review.md                      # 从 pensieve pipeline.run-when-reviewing-code.md 提取
    ├── sync-to-main.md                # 从 pensieve pipeline.run-when-syncing-to-main.md 提取
    ├── ship.md                        # from garrytan/gstack
    └── multi-*.md                     # from alfadb/pi-multi-agent/prompts
```

## ~/.pi 双重身份说明（ADR 0008）

~/.pi 同时是：
- **pi-stack 的开发环境**（alfadb cd 到 pi-stack 子目录改代码）
- **其他项目的 pi 基础环境**（alfadb cd 到任意项目跑 pi，pi 加载 ~/.pi/agent/settings.json）

source 路由按 ADR 0008 区分：

| cwd 位置 | source |
|---|---|
| `~/.pi/` 内（包括 pi-stack 子目录） | `pi-stack` |
| `~/.pi/` 外且已注册项目 | 该项目 source |
| `~/.pi/` 外且未注册 git repo | 不注入，sediment fail closed |
| 非 git repo | 不注入 |

## 关键变化（vs v1 方案）

| 项 | v1 方案 | v6.5 方案 |
|---|---|---|
| `runtime/pensieve/` | 完整 own pensieve 运行时 | **删除**（pensieve 项目退场） |
| `vendor/pensieve/` | submodule pin to kingkongshot/Pensieve@main | **删除**（ADR 0005） |
| `extensions/pensieve-context/` | pensieve project memory adapter | **删除** |
| `skills/pensieve-wand/` | pensieve 检索助手 | 改名 `skills/memory-wand/`，重写为 gbrain_* 包装 |
| `prompts/{commit,plan,review,sync-to-main}.md` | 不存在 | **新增**（从 pensieve pipelines 提取，A 类自有） |
| `extensions/sediment/` | pensieve writer + gbrain target 双写 | **改造**：单写 / 分离写 / 派生写三策略，gbrain 唯一 |
| `defaults/pi-stack.defaults.json` | 不存在 | **新增**（package-local fallback / 文档示例；运行时走官方 settings chain） |
| `docker-compose.yml` | 不存在 | **不提供**（gbrain 部署由 alfadb 自决，ADR 0007） |
| `extensions/multi-agent/templates/` | 不存在 | **新增**（ADR 0009）4 种 cookbook 模板 |
| `extensions/multi-agent/input-compat.ts` | 不存在 | **新增**（ADR 0009 § 2.5）JSON 字符串兑底兑底层 |
| `docs/adr/` | 1 ADR | **9 ADR**（v6.5 体系） |

## 所有权与依赖矩阵

| 目录 | 所有者 | 是否被 pi 加载 | 是否可修改 |
|---|---|---|---|
| `vendor/gstack/` | garrytan | ❌ | ❌ 只读 |
| `extensions/multi-agent/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/sediment/` | alfadb（C 类迁入 + A 类改造） | ✅ pi.extensions | ✅ |
| `extensions/sediment/prompts/` | alfadb（A 类） | ❌ 主会话不见 | ✅ |
| `extensions/model-curator/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/gbrain/` | alfadb（C 类迁入 + A 类改造） | ✅ pi.extensions | ✅ |
| `extensions/browse/` | alfadb（C 类迁入） | ✅ pi.extensions | ✅ |
| `extensions/multi-agent/input-compat.ts` | alfadb（A 类自有，ADR 0009 § 2.5）| 被三个入口 handler import | ✅ |
| `extensions/multi-agent/input-compat.test.ts` | alfadb（单测）| 仅 CI 跳运 | ✅ |
| `extensions/multi-agent/templates/*` | alfadb（供主会话参考） | ✅ 被主会话 promptSnippet 指向读 | ✅ |
| `extensions/retry-stream-eof/` | alfadb（A 类永久 own） | ✅ pi.extensions | ✅ |
| `skills/memory-wand/` | alfadb（A 类） | ✅ pi.skills | ✅ |
| `skills/{19 个}/` | alfadb（B 类端口） | ✅ pi.skills | ✅ |
| `prompts/{commit,plan,review,sync-to-main}.md` | alfadb（A 类） | ✅ pi.prompts | ✅ |
| `prompts/ship.md` | alfadb（B 类端口） | ✅ pi.prompts | ✅ |
| `prompts/multi-*.md` | alfadb（C 类迁入） | ✅ pi.prompts | ✅ |
| `defaults/pi-stack.defaults.json` | alfadb | ❌（fallback / 文档示例） | ✅ |
| `docs/adr/` | alfadb | ❌ | ✅ |
| `UPSTREAM.md` | alfadb | ❌ | ✅（每次 vendor bump 必更新）|

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
   gbrain (postgres + pgvector)
        ↑
        │ markdown export 兜底
        │
   ~/.pi/.gbrain-cache/  (gitignored)
        ↑
        │ read fallback (gbrain unavailable)
        │
   extensions/gbrain/  (主会话 read tool)


   vendor/gstack/  ← 仅 docs/adr 与 UPSTREAM.md 引用
```

**严禁的引用关系**:
1. `extensions/* → vendor/*`（端口层不能依赖 vendor）
2. `skills/* / prompts/* → 任何代码`（声明式资源）
3. `vendor/* → 任何 pi-stack 内容`（vendor 是 read-only 上游快照）
4. `extensions/sediment → 直接调 postgres`（必须经 gbrain CLI / SDK）

## 资源类型 vs pi 加载机制对照

| pi 资源类型 | 本仓位置 | 加载方式 |
|---|---|---|
| Extensions | `extensions/` | `package.json` 的 `pi.extensions` 数组扫描 |
| Skills | `skills/` | `package.json` 的 `pi.skills` 数组扫描，找 `SKILL.md` |
| Prompts | `prompts/` | `package.json` 的 `pi.prompts` 数组扫描，加载 `.md` |
| Themes | （无） | — |
| Vendor sources | `vendor/` | **不被 pi 加载**，仅作参考 |
| 配置 | 官方 settings chain (`~/.pi/agent/settings.json` + `.pi/settings.json`) | 运行时读取 `piStack.*`；`defaults/pi-stack.defaults.json` 仅 fallback/文档示例 |
| 内部 prompts（sediment 用） | `extensions/sediment/prompts/` | **不被 pi 加载**，sediment 内部读取 |
| Multi-agent cookbook | `extensions/multi-agent/templates/` | **不被 pi 加载**（仅考考索引），主会话 promptSnippet 中提示可读 |
