# pi-astack 上游跟踪

> 维护原则: brain maxim `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`
>
> **跟进方式: LLM 协作而非机械脚本**
> 上游有新 commit 时，让 pi 当前会话里的助手把上游 diff 交给 LLM 阅读、分析、与 alfadb 讨论：每条 commit 是否值得移植、移植到哪个端口位置、是否有连锁改动。决策完成后由 LLM 直接执行端口层 edit + bump vendor SHA + 更新本表。
>
> 这一条**明确反对**通过 `npm run` 脚本机械地拉 diff 列表然后批量决策——上游变更需要语义理解，不是文件清单比对。

---

## 上游关系三分类

详见 [ADR 0006](./docs/adr/0006-component-consolidation.md)。

| 类别 | 含义 | 是否进本表 |
|---|---|---|
| **A 类：自有功能** | alfadb 永久 own，不向上游 PR | ❌ 不进本表 |
| **B 类：vendor 移植参考** | 上游只读引用，pi 端口在 pi-astack 内 | ✅ 进本表（主体） |
| **C 类：内部组件迁入** | 曾经独立的 alfadb 自有 npm 包 | ❌ 不进本表（不是上游协作） |

### A 类：自有功能（不进本表，仅列举）

| 组件 | 理由 |
|---|---|
| `extensions/model-fallback/` | alfadb 自己的功能，上游对 PR 态度大多直接关闭 |
| `skills/memory-wand/` | pensieve-wand 改写后是 pi-astack 自有产权 |
| `extensions/memory/` | v7 新建，Facade 模式封装 `memory_search/get/list/neighbors`（替代旧 `extensions/gbrain/`） |
| `extensions/sediment/` 改造（markdown writer、graph builder、lint、doctor） | v7 自有设计，基于 memory-architecture.md |
| `extensions/sediment/prompts/` 全套 rubric | pi-astack 私有 |
| `extensions/dispatch/` ADR 0009 重构 | v6.5 自有设计 |
| `extensions/dispatch/input-compat.ts` + `input-compat.test.ts` | v6.5 自有设计 |
| `prompts/{commit,plan,review,sync-to-main}.md` | 从 pensieve pipelines 提取后是 pi-astack 私有 |
| `defaults/pi-astack.defaults.json` | package-local fallback / 文档示例（运行时走官方 pi settings chain） |

### C 类：内部组件迁入（不进本表，仅列举）

| 组件 | 原仓 | 处置 |
|---|---|---|
| `extensions/dispatch/` | `alfadb/pi-dispatch` | subtree merge，原仓 archive，README 指向 pi-astack |
| `extensions/sediment/` | `alfadb/pi-sediment` | subtree merge，原仓 archive，README 指向 pi-astack |
| `extensions/model-curator/` | `~/.pi/agent/skills/pi-model-curator/`（in-tree） | cp 迁入 |
| `skills/{19 个}/` + `extensions/browse/` + `prompts/ship.md` | `alfadb/pi-gstack` | cp 迁入，原仓 archive |
| `extensions/gbrain/` | `~/.pi/agent/extensions/gbrain/` | cp 迁入 |
| `extensions/retry-stream-eof/` | `~/.pi/agent/extensions/retry-stream-eof.ts` | cp 迁入（同时升级为 A 类自有功能） |

---

## B 类：vendor/gstack — `garrytan/gstack`

### 基线
- URL: `https://github.com/garrytan/gstack`
- SHA: `bf65487` (v1.26.0.0, 2026-05-02)
- 跟进策略: 上游每次 release，看 changelog 决定是否值得移植

### 端口层映射

| pi-astack 路径 | 上游来源 | 形式 | 首次移植日期 |
|---|---|---|---|
| `skills/office-hours/SKILL.md` | `office-hours/SKILL.md` | Skill | 2026-04-30 |
| `skills/plan-ceo-review/SKILL.md` | `plan-ceo-review/SKILL.md` | Skill | 2026-04-30 |
| `skills/review/SKILL.md` | `review/SKILL.md` | Skill | 2026-04-30 |
| `skills/investigate/SKILL.md` | `investigate/SKILL.md` | Skill | 2026-04-30 |
| `skills/cso/SKILL.md` | `cso/SKILL.md` | Skill | 2026-04-30 |
| `skills/qa/SKILL.md` | `qa/SKILL.md` | Skill | 2026-04-30 |
| `skills/qa-only/SKILL.md` | `qa-only/SKILL.md` | Skill | 2026-04-30 |
| `skills/retro/SKILL.md` | `retro/SKILL.md` | Skill | 2026-04-30 |
| `skills/document-release/SKILL.md` | `document-release/SKILL.md` | Skill | 2026-04-30 |
| `skills/land-and-deploy/SKILL.md` | `land-and-deploy/SKILL.md` | Skill | 2026-04-30 |
| `skills/setup-deploy/SKILL.md` | `setup-deploy/SKILL.md` | Skill | 2026-04-30 |
| `skills/canary/SKILL.md` | `canary/SKILL.md` | Skill | 2026-04-30 |
| `skills/scrape/SKILL.md` | `scrape/SKILL.md` | Skill | 2026-04-30 |
| `skills/health/SKILL.md` | `health/SKILL.md` | Skill | 2026-04-30 |
| `skills/benchmark/SKILL.md` | `benchmark/SKILL.md` | Skill | 2026-04-30 |
| `skills/plan-eng-review/SKILL.md` | `plan-eng-review/SKILL.md` | Skill | 2026-04-30 |
| `skills/plan-design-review/SKILL.md` | `plan-design-review/SKILL.md` | Skill | 2026-04-30 |
| `skills/plan-devex-review/SKILL.md` | `plan-devex-review/SKILL.md` | Skill | 2026-04-30 |
| `skills/autoplan/SKILL.md` | `autoplan/SKILL.md` | Skill | 2026-04-30 |
| `skills/review/references/checklist.md` | `review/checklist.md` | Reference | 2026-04-30 |
| `skills/review/references/testing.md` | `review/specialists/testing.md` | Reference | 2026-04-30 |
| `skills/review/references/security.md` | `review/specialists/security.md` | Reference | 2026-04-30 |
| `skills/review/references/performance.md` | `review/specialists/performance.md` | Reference | 2026-04-30 |
| `skills/review/references/data-migration.md` | `review/specialists/data-migration.md` | Reference | 2026-04-30 |
| `skills/review/references/api-contract.md` | `review/specialists/api-contract.md` | Reference | 2026-04-30 |
| `skills/review/references/maintainability.md` | `review/specialists/maintainability.md` | Reference | 2026-04-30 |
| `skills/review/references/red-team.md` | `review/specialists/red-team.md` | Reference | 2026-04-30 |
| `skills/qa/references/issue-taxonomy.md` | `qa/references/issue-taxonomy.md` | Reference | 2026-04-30 |
| `skills/qa/references/qa-report-template.md` | `qa/templates/qa-report-template.md` | Reference | 2026-04-30 |
| `skills/plan-devex-review/references/dx-hall-of-fame.md` | `plan-devex-review/dx-hall-of-fame.md` | Reference | 2026-04-30 |
| `skills/cso/references/owasp-top10.md` | `cso/SKILL.md` Phase 9（提取） | Extracted | 2026-04-30 |
| `prompts/ship.md` | `ship/SKILL.md` | Template | 2026-04-30 |
| `extensions/browse/` | `browse/src/*.ts` | Extension | 2026-04-30 |

### alfadb 自创增强（不来自 vendor，但落在 vendor 端口路径）
| 路径 | 描述 | 日期 |
|---|---|---|
| `skills/cso/SKILL.md` Phases 5,11,12 | 增强（不在上游） | 2026-05-01 |
| 全部 19 skill + ship.md memory 集成 | Brain Context Load (memory_search/memory_get) 注入 | 2026-05-02 → 2026-05-07 更新 |
| `prompts/ship.md` step numbering / path refs | review feedback 修复 | 2026-05-01 |

---

## 已废弃 vendor 引用

### ~~vendor/pensieve — `kingkongshot/Pensieve`~~

**已废弃**：pensieve 项目作为 pi-astack 组件退场。详见 [ADR 0005](./docs/adr/0005-pensieve-deprecated.md)。

- 不建立 `vendor/pensieve` submodule
- 从 ~/.pi/.gitmodules 移除 `agent/skills/pensieve` submodule
- alfadb 在 pensieve 上游身份明牌（self-demote 或找替补 user-maintainer）
- 4 个 pipelines 提取为 `prompts/*.md`
- 写入规范进入 `extensions/sediment/prompts/`（主会话不可见）
- pensieve-wand skill 改写为 `skills/memory-wand/`（memory_* tool 包装，A 类自有）

---

## 上游升级工作流（LLM 协作）

仅适用于 B 类（vendor/gstack）。A 类自有功能不向上游 PR；C 类内部组件迁入是一次性动作。

核心理念：**diff 是给人/LLM 读的，不是给脚本批处理的**。上游变更的语义判断（值不值得移植、移植到哪、连锁影响是什么）必须经过 LLM 推理 + alfadb 讨论，不能简化成 "看文件名清单 → 决定 yes/no"。

标准回合（在 pi 当前会话里执行）：

1. **触发**: alfadb 想看上游有什么更新，或定期想做一次同步
2. **拉取**: 助手在 `vendor/<x>/` 里跑 `git fetch origin && git log --oneline HEAD..origin/main`，列出未合入的 commit
3. **LLM 阅读 diff**: 助手对每条 commit 跑 `git show <sha>` 看完整 diff，结合 commit message 判断变更性质
4. **LLM 分类汇报**: 助手把 commit 列表分组呈给 alfadb，例如：
   - 🟢 直接价值的 bug 修复（建议移植）
   - 🟡 新功能（需要讨论是否符合 pi 端口层风格）
   - 🔵 与 pi 无关的 claude-code 专属改动（不移植）
   - 🔴 与本仓端口层冲突的（需要 alfadb 决定怎么 reconcile）
5. **alfadb 讨论决策**: 对 🟡🔴 类逐条决定
6. **执行**: 助手用 edit 工具在端口层（extensions/skills/prompts/）改文件
7. **bump vendor**: `cd vendor/<x> && git checkout <new-sha> && cd ../..`，然后独立 commit `chore(vendor): bump <x> to <new-sha>`
8. **端口适配**: 紧跟着的 commit 是端口层改动 `feat(<area>): port <feature> from <vendor> <new-sha>`
9. **更新本表**: 助手把新出现的端口路径加进对应 vendor 章节，更新顶部 SHA
10. **本表 commit**: `docs(upstream): record port for <x> at <new-sha>`

---

注：上面这 10 步是「这个动作链条由人和 LLM 协作完成」的描述，不是 `npm run` 脚本编排。**故意不写成 Makefile 或 scripts 入口**，因为每一步都需要 LLM 推理 + alfadb 决策。

---

## 已废弃实体（仅作历史参考）

| 实体 | 废弃日期 | 接收者/原因 |
|---|---|---|
| **gbrain 记忆基础设施** | 2026-05-07 | 整体替换为纯 markdown+git（[memory-architecture.md](./docs/memory-architecture.md) 决策 2） |
| `~/.pi/.gbrain-source` / `.gbrain-cache/` / `.gbrain-scratch` | 2026-05-07 | 作废（不再依赖 gbrain） |
| `extensions/gbrain/` | 2026-05-07 | → `extensions/memory/`（`memory_*` tools 替代 `gbrain_*` tools） |
| `alfadb/pi-gstack` repo | 2026-05-05 | 整体并入 pi-astack（C 类） |
| `alfadb/pi-dispatch` repo | 2026-05-05 | subtree merge 入 pi-astack/extensions/dispatch（C 类） |
| `alfadb/pi-sediment` repo | 2026-05-05 | subtree merge 入 pi-astack/extensions/sediment（C 类） |
| `kingkongshot/Pensieve@feature/auto-sediment-hook` 分支 | 2026-05-05 | 删除（ADR 0005） |
| `kingkongshot/Pensieve@pi` 分支 | 2026-05-05 | 删除（ADR 0005） |
| `~/.pi/agent/extensions/gbrain/` | 2026-05-05 | pi-astack/extensions/gbrain（C 类）→ 2026-05-07 作废 |
| `~/.pi/agent/extensions/retry-stream-eof.ts` | 2026-05-05 | pi-astack/extensions/model-fallback（C 类迁入 → A 类永久 own） |
| `~/.pi/agent/skills/pi-model-curator/` | 2026-05-05 | pi-astack/extensions/model-curator（C 类） |
| `~/.pi/.pensieve/` 数据（旧格式） | 2026-05-07 | 通过 `pi memory migrate` 迁移为新格式（frontmatter v1 + Timeline） |
| `~/.pi/agent/skills/pensieve/` submodule | 2026-05-05 | 从 ~/.pi/.gitmodules 移除（ADR 0005） |
