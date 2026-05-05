# pi-stack 目录布局与所有权

```
alfadb/pi-stack/
│
├── package.json                       # pi-package manifest
├── README.md
├── UPSTREAM.md                        # 上游跟踪 + 端口映射
├── LICENSE                            # MIT
├── .gitignore
├── .gitmodules
│
├── docs/
│   └── adr/
│       └── 0001-pi-stack-as-personal-pi-workflow.md
│
├── vendor/                            # ▼▼▼ READ-ONLY，仅作 diff/参考源 ▼▼▼
│   ├── gstack/                        # submodule → garrytan/gstack@bf65487
│   └── pensieve/                      # submodule → kingkongshot/Pensieve@main
│
├── extensions/                        # ▼▼▼ pi 行为扩展，alfadb own ▼▼▼
│   ├── multi-agent/                   # subtree from alfadb/pi-multi-agent
│   │   ├── package.json
│   │   ├── index.ts
│   │   ├── runner.ts
│   │   ├── subagent-tools.ts
│   │   └── ...
│   ├── sediment/                      # subtree from alfadb/pi-sediment
│   │   ├── package.json
│   │   ├── index.ts
│   │   ├── scheduler.ts
│   │   ├── pensieve-writer.ts
│   │   ├── lookup-tools.ts
│   │   ├── gbrain-target.ts
│   │   ├── agent-loop.ts
│   │   └── ...
│   ├── model-curator/                 # cp from agent/skills/pi-model-curator
│   │   ├── package.json
│   │   ├── index.ts
│   │   └── catalog.json
│   ├── gbrain/                        # cp from agent/extensions/gbrain
│   │   └── index.ts
│   ├── pensieve-context/              # from kingkongshot/Pensieve@pi:pi/extensions/pensieve-context
│   │   ├── package.json
│   │   └── index.ts
│   ├── browse/                        # from pi-gstack/extensions/browse
│   │   └── ...
│   └── retry-stream-eof.ts            # cp from agent/extensions/retry-stream-eof.ts
│                                      # 注释 PR 链接，PR 合并后删除
│
├── skills/                            # ▼▼▼ pi 技能，alfadb own ▼▼▼
│   ├── pensieve-wand/                 # from kingkongshot/Pensieve@pi:pi/skills/pensieve-wand
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
├── prompts/                           # ▼▼▼ pi 提示模板，alfadb own ▼▼▼
│   ├── ship.md                        # from garrytan/gstack
│   ├── multi-debate.md                # from alfadb/pi-multi-agent/prompts
│   ├── multi-ensemble.md
│   ├── multi-parallel.md
│   └── multi-chain.md
│
└── runtime/                           # ▼▼▼ 非 pi 资源，由 extension 调度 ▼▼▼
    └── pensieve/                      # 来自废弃的 kingkongshot/Pensieve@pi 分支
        ├── install.sh                 # alfadb 写的项目级安装
        ├── manifest.json
        ├── core/
        │   └── hooks.json             # B 类
        ├── scripts/                   # B + C-i 混合
        │   ├── planning-prehook.sh           # B
        │   ├── register-hooks.sh             # B
        │   ├── stop-hook-auto-sediment.sh    # B
        │   ├── run-hook.sh                   # C-i
        │   ├── lib.sh                        # C-i
        │   ├── init-project-data.sh          # C-i
        │   ├── maintain-project-state.sh     # C-i
        │   ├── sync-project-skill-graph.sh   # C-i
        │   └── pensieve-session-marker.sh    # C-i
        ├── templates/                 # C-i
        │   ├── maxims/
        │   │   ├── eliminate-special-cases-by-redesigning-data-flow.md
        │   │   ├── prefer-pragmatic-solutions-over-theoretical-completeness.md
        │   │   ├── preserve-user-visible-behavior-as-a-hard-rule.md
        │   │   └── reduce-complexity-before-adding-branches.md
        │   ├── pipeline.run-when-committing.md
        │   ├── pipeline.run-when-planning.md
        │   ├── pipeline.run-when-reviewing-code.md
        │   ├── pipeline.run-when-syncing-to-main.md
        │   ├── agents/pensieve-wand.md
        │   └── knowledge/taste-review/content.md
        ├── references/                # C-i (9 个)
        │   ├── decisions.md
        │   ├── directory-layout.md
        │   ├── knowledge.md
        │   ├── maxims.md
        │   ├── pipelines.md
        │   ├── shared-rules.md
        │   ├── short-term.md
        │   ├── skill-lifecycle.md
        │   └── tool-boundaries.md
        ├── loop/                      # C-i
        │   ├── DESIGN.template.md
        │   └── REQUIREMENTS.template.md
        └── tools/                     # C-i (6 个)
            ├── doctor.md
            ├── init.md
            ├── migrate.md
            ├── refine.md
            ├── self-improve.md
            └── upgrade.md
```

## 所有权与依赖矩阵

| 目录 | 所有者 | 是否被 pi 加载 | 是否被运行时 import | 是否可修改 |
|---|---|---|---|---|
| `vendor/gstack/` | garrytan | ❌ | ❌ | ❌ 只读 |
| `vendor/pensieve/` | kingkongshot | ❌ | ❌ | ❌ 只读 |
| `extensions/*/` | alfadb | ✅ pi.extensions | — | ✅ |
| `skills/*/` | alfadb | ✅ pi.skills | — | ✅ |
| `prompts/*/` | alfadb | ✅ pi.prompts | — | ✅ |
| `runtime/pensieve/` | alfadb | ❌ | ✅ 由 `extensions/pensieve-context/` 调度 | ✅ |
| `docs/adr/` | alfadb | ❌ | ❌ | ✅ |
| `UPSTREAM.md` | alfadb | ❌ | ❌ | ✅（每次 vendor bump 必更新）|

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
        │ runtime 调度
        ▼
  runtime/pensieve/
        │
        │ ❌ 严禁
        ▼
   vendor/*  ←─── 仅 docs/adr 与 UPSTREAM.md 引用
```

**严禁的引用关系**:
1. `extensions/* → vendor/*`（端口层不能依赖 vendor）
2. `runtime/* → vendor/*`（runtime 是端口层的一部分）
3. `skills/* / prompts/* → 任何代码`（声明式资源）
4. `vendor/* → 任何 pi-stack 内容`（vendor 是 read-only 上游快照）

## 资源类型 vs pi 加载机制对照

| pi 资源类型 | 本仓位置 | 加载方式 |
|---|---|---|
| Extensions | `extensions/` | `package.json` 的 `pi.extensions` 数组扫描 |
| Skills | `skills/` | `package.json` 的 `pi.skills` 数组扫描，找 `SKILL.md` |
| Prompts | `prompts/` | `package.json` 的 `pi.prompts` 数组扫描，加载 `.md` |
| Themes | （无） | — |
| Runtime materials | `runtime/` | **不被 pi 加载**，由 extension 在 install/setup 时使用 |
| Vendor sources | `vendor/` | **不被 pi 加载**，只是参考材料 |
