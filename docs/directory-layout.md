# pi-astack 目录布局与所有权

> **v7 更新提示**（[memory-architecture.md](./memory-architecture.md)）：记忆基础设施从 gbrain (postgres+pgvector) 整
> 体替换为纯 markdown+git。本文件反映 **当前实际实现状态**（2026-05-07）。标注 `[计划]` 的目录尚未实现。

## 实际文件树

```
alfadb/pi-astack/
│
├── package.json                       # pi-package manifest
├── pi-astack-settings.schema.json     # 扩展配置 schema（~/.pi/agent/pi-astack-settings.json）
├── README.md
├── UPSTREAM.md                        # 上游跟踪（B 类 vendor）+ 三分类说明
├── LICENSE                            # MIT
├── .gitignore
│                                      # （无 .gitmodules — vendor/gstack 尚未挂载）
│
├── docs/                              # ✅ 已实现
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
├── extensions/                        # ✅ pi 行为扩展（alfadb own）
│   ├── dispatch/                      # ✅ 已实现：dispatch_agent + dispatch_agents（子进程隔离）
│   │   ├── index.ts                   # 注册 dispatch_agent / dispatch_agents（ADR 0009）
│   │   └── input-compat.ts            # JSON 字符串 unwrap + 类型兑底（ADR 0009 §2.5）
│   ├── vision/                        # ✅ 已实现：vision tool（自动选最佳 vision model）
│   │   └── index.ts
│   ├── imagine/                       # ✅ 已实现：imagine tool（OpenAI Responses API 生图）
│   │   └── index.ts
│   ├── model-curator/                 # ✅ 已实现：模型白名单 + 能力提示注入
│   │   └── index.ts
│   ├── model-fallback/                # ✅ 已实现：多模型 fallback 链（旧名 retry-stream-eof）
│   │   └── index.ts
│   ├── sediment/                      # [计划] v7 单 agent + markdown 写入（Phase 1.4）
│   ├── memory/                        # [计划] v7 主会话只读工具 Facade（Phase 1.3）
│   └── browse/                        # [计划] from pi-gstack
│
├── skills/                            # [计划] pi 技能（19 gstack skills + memory-wand）
├── prompts/                           # [计划] pi 提示模板（5 pipeline prompts）
├── vendor/                            # [计划] READ-ONLY 上游参考源
│   └── gstack/                        # [计划] submodule → garrytan/gstack
└── defaults/                          # [计划] package-local fallback / 文档示例
    └── pi-astack.defaults.json
```

## 已实现 vs 计划对照

| 目录 | 状态 | Phase 依赖 |
|------|------|-----------|
| `extensions/dispatch/` | ✅ 已实现 | — |
| `extensions/vision/` | ✅ 已实现 | — |
| `extensions/imagine/` | ✅ 已实现 | — |
| `extensions/model-curator/` | ✅ 已实现 | — |
| `extensions/model-fallback/` | ✅ 已实现 | — |
| `extensions/sediment/` | [计划] | Phase 1.4 |
| `extensions/memory/` | [计划] | Phase 1.3 |
| `extensions/browse/` | [计划] | Slice F（旧路线图） |
| `skills/` | [计划] | Slice F |
| `prompts/` | [计划] | Slice F |
| `vendor/gstack/` | [计划] | Slice F |
| `defaults/` | [计划] | 低优先级 |

## 已实现扩展详情

### extensions/dispatch/

子进程隔离的 `dispatch_agent` / `dispatch_agents`。每个子 agent = 独立 pi 进程，通过 JSON 事件流通信。

| 文件 | 说明 |
|------|------|
| `index.ts` | 注册 dispatch_agent + dispatch_agents；子进程 spawn + JSON 事件流解析 |
| `input-compat.ts` | JSON 字符串 unwrap（最多 2 层）+ tools array→CSV + timeoutMs string→number |

工具签名（与 ADR 0009 一致）：
- `dispatch_agent(model, thinking, prompt, tools?, timeoutMs?)`
- `dispatch_agents(tasks[{model, thinking, prompt, timeoutMs?}], timeoutMs?)`

### extensions/vision/

自动选择最强 vision-capable model（排除调用者自身），进程内 `streamSimple` 调用。

配置：`pi-astack-settings.json → vision.modelPreferences`

### extensions/imagine/

OpenAI Responses API 生图。复用用户已有的 openai provider 配置（key + baseUrl），零额外配置。

输出：`.pi-astack/imagine/`（PNG）

### extensions/model-curator/

两职责：
1. **白名单**：过滤 pi-ai 数百模型 → 精选 keep-list
2. **能力提示**：每轮 `before_agent_start` 注入 markdown 能力表到 system prompt

配置：`pi-astack-settings.json → modelCurator.{providers, hints, imageGen}`

### extensions/model-fallback/

非对称多模型 fallback：
- 初始模型走 pi 内建指数退避重试（自动读 `settings.json#retry.maxRetries`）
- 耗尽后按 `fallbackModels` 列表切下一个，每个仅尝试 1 次
- 全部失败才停

配置：`pi-astack-settings.json → modelFallback.fallbackModels`

旧名：`retry-stream-eof` → `retry-all-errors` → `model-fallback`

## 配置

pi-astack 使用独立配置文件 `~/.pi/agent/pi-astack-settings.json`，schema 定义在本仓 `pi-astack-settings.schema.json`。

不被 pi 官方 settings chain 加载——各扩展自行 `fs.readFileSync` 读取。

| 扩展 | 配置键 |
|------|--------|
| modelCurator | `providers`, `hints`, `imageGen` |
| modelFallback | `fallbackModels` |
| vision | `modelPreferences` |

## 所有权矩阵

| 目录 | 所有者 | 状态 | 是否可修改 |
|------|--------|------|-----------|
| `extensions/dispatch/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/vision/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/imagine/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/model-curator/` | alfadb（C 类迁入） | ✅ 已实现 | ✅ |
| `extensions/model-fallback/` | alfadb（A 类永久 own） | ✅ 已实现 | ✅ |
| `extensions/sediment/` | alfadb（A 类改造） | [计划] Phase 1.4 | ✅ |
| `extensions/memory/` | alfadb（v7 新建） | [计划] Phase 1.3 | ✅ |
| `extensions/browse/` | alfadb（C 类迁入） | [计划] | ✅ |
| `skills/` | alfadb（B 类端口） | [计划] | ✅ |
| `prompts/` | alfadb（A 类 + B 类） | [计划] | ✅ |
| `vendor/gstack/` | garrytan | [计划] | ❌ 只读 |
| `defaults/` | alfadb | [计划] | ✅ |
| `docs/` | alfadb | ✅ 已实现 | ✅ |

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
  (5 已实现)    (待迁入)   (待迁入)

  dispatch/ ─── 子进程 spawn ─── pi（独立实例，OS 级隔离）
  vision/   ─── 进程内 streamSimple
  imagine/  ─── OpenAI Responses API（复用 openai provider 配置）
  model-curator/ ─── pi.registerProvider() + before_agent_start 注入
  model-fallback/ ─── agent_end 拦截 + pi 内建 retry 对齐

  未来（Phase 1+）:
  memory/   ──→ markdown + git (source of truth)
                 ├── <project>/.pensieve/     (项目级)
                 └── ~/.abrain/               (世界级)
  sediment/ ──→ markdown + git (唯一写入者)
```

**严禁的引用关系**:
1. `extensions/* → vendor/*`（端口层不能依赖 vendor）
2. `skills/* / prompts/* → 任何代码`（声明式资源）
3. `vendor/* → 任何 pi-astack 内容`（vendor 是 read-only 上游快照）
