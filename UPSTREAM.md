# pi-stack 上游跟踪

> 维护原则: brain maxim `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`
>
> **跟进方式: LLM 协作而非机械脚本**
> 上游有新 commit 时，让 pi 当前会话里的助手把上游 diff 交给 LLM 阅读、分析、与 alfadb 讨论：每条 commit 是否值得移植、移植到哪个端口位置、是否有连锁改动。决策完成后由 LLM 直接执行端口层 edit + bump vendor SHA + 更新本表。
>
> 这一条**明确反对**通过 `npm run` 脚本机械地拉 diff 列表然后批量决策——上游变更需要语义理解，不是文件清单比对。

---

## vendor/gstack — `garrytan/gstack`

### 基线
- URL: `https://github.com/garrytan/gstack`
- SHA: `bf65487` (v1.26.0.0, 2026-05-02)
- 跟进策略: 上游每次 release，看 changelog 决定是否值得移植

### 端口层映射

| pi-stack 路径 | 上游来源 | 形式 | 首次移植日期 |
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

### alfadb 自创增强（不来自 vendor）
| 路径 | 描述 | 日期 |
|---|---|---|
| `skills/cso/SKILL.md` Phases 5,11,12 | 增强（不在上游） | 2026-05-01 |
| 全部 19 skill + ship.md gbrain 集成 | Brain Context Load (gbrain_search/gbrain_get) 注入 | 2026-05-02 |
| `prompts/ship.md` step numbering / path refs | review feedback 修复 | 2026-05-01 |

---

## vendor/pensieve — `kingkongshot/Pensieve`

### 基线
- URL: `https://github.com/kingkongshot/Pensieve`
- 跟踪分支: `main`
- 项目身份: pensieve 项目的上游主仓。alfadb 作为该项目的**维护成员之一**参与上游协作（不是作者，也不是个人 fork）
- SHA: `<待 pin，第一次 git submodule add 后填写>`
- 跟进策略: 上游 main 有新 commit 时，让助手把 diff 交给 LLM 阅读、分类（bug 修复 / 新能力 / 与 pi 无关 / 与端口层冲突）、与 alfadb 讨论每条决策、再执行端口层修改

### 端口层映射（来自废弃的 `pi` 分支）

| pi-stack 路径 | 上游来源 | 类别 | 备注 |
|---|---|---|---|
| `extensions/pensieve-context/index.ts` | `pi/extensions/pensieve-context/index.ts` | A 类 | alfadb 100% 自创，pi adapter 主体 |
| `extensions/pensieve-context/package.json` | `pi/extensions/pensieve-context/package.json` | A 类 | alfadb 100% 自创 |
| `skills/pensieve-wand/SKILL.md` | `pi/skills/pensieve-wand/SKILL.md` | A 类 | alfadb 100% 自创 |
| `runtime/pensieve/install.sh` | `pi/install.sh` | A 类 | alfadb 写的 install 流程 |
| `runtime/pensieve/manifest.json` | `.src/manifest.json` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/core/hooks.json` | `.src/core/hooks.json` | B 类 | alfadb 100% 新增 |
| `runtime/pensieve/scripts/planning-prehook.sh` | `.src/scripts/planning-prehook.sh` | B 类 | alfadb 100% 新增 |
| `runtime/pensieve/scripts/register-hooks.sh` | `.src/scripts/register-hooks.sh` | B 类 | alfadb 100% 新增 |
| `runtime/pensieve/scripts/stop-hook-auto-sediment.sh` | `.src/scripts/stop-hook-auto-sediment.sh` | B 类 | alfadb 100% 新增 |
| `runtime/pensieve/scripts/run-hook.sh` | `.src/scripts/run-hook.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/scripts/lib.sh` | `.src/scripts/lib.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/scripts/init-project-data.sh` | `.src/scripts/init-project-data.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/scripts/maintain-project-state.sh` | `.src/scripts/maintain-project-state.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/scripts/sync-project-skill-graph.sh` | `.src/scripts/sync-project-skill-graph.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/scripts/pensieve-session-marker.sh` | `.src/scripts/pensieve-session-marker.sh` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/templates/maxims/*.md` | `.src/templates/maxims/*.md` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/templates/pipeline.*.md` | `.src/templates/pipeline.*.md` (modified, 含新增 run-when-planning.md) | C-i | 部分新增 |
| `runtime/pensieve/templates/agents/pensieve-wand.md` | `.src/templates/agents/pensieve-wand.md` | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/templates/knowledge/taste-review/content.md` | `.src/templates/knowledge/taste-review/content.md` | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/references/*.md` (9 个) | `.src/references/*.md` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/loop/DESIGN.template.md` | `.src/loop/DESIGN.template.md` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/loop/REQUIREMENTS.template.md` | `.src/loop/REQUIREMENTS.template.md` (modified) | C-i | 上游有，alfadb 改过 |
| `runtime/pensieve/tools/*.md` (6 个) | `.src/tools/*.md` (modified) | C-i | 上游有，alfadb 改过 |

### 类别图例（来自 ADR 0001 偏离点说明）
- **A 类**: alfadb 100% 新增，与上游无关
- **B 类**: alfadb 100% 新增的 hook 脚本/manifest 字段
- **C-i 类**: 上游有，alfadb 改过 → 完整 own 一份在 runtime/，**不**走 patches queue（明确选择）

### 仅在 vendor/pensieve 不进入 runtime/ 的部分
（这些是上游 alfadb 没改的，作为升级 diff 参考保留在 vendor/pensieve）
- `.src/loop/` 主体（除 DESIGN.template.md / REQUIREMENTS.template.md）
- `.src/core/` 主体（除 hooks.json）
- `.src/agents/`
- vendor 自带的 README、CHANGELOG、LICENSE、SKILL.md

⚠️ **运行时不能引用 vendor/pensieve**。如果上游某个未改文件未来需要使用，应当显式拷贝到 runtime/pensieve/ 并在本表注册。

---

## 上游升级工作流（LLM 协作）

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
6. **执行**: 助手用 edit 工具在端口层（extensions/skills/prompts/runtime）改文件
7. **bump vendor**: `cd vendor/<x> && git checkout <new-sha> && cd ../..`，然后独立 commit `chore(vendor): bump <x> to <new-sha>`
8. **端口适配**: 紧跟着的 commit 是端口层改动 `feat(<area>): port <feature> from <vendor> <new-sha>`
9. **更新本表**: 助手把新出现的端口路径加进对应 vendor 章节，更新顶部 SHA
10. **本表 commit**: `docs(upstream): record port for <x> at <new-sha>`

---

注：上面这 10 步是「这个动作链条由人和 LLM 协作完成」的描述，不是 `npm run` 脚本编排。**故意不写成 Makefile 或 scripts 入口**，因为每一步都需要 LLM 推理 + alfadb 决策。

---

## 已废弃实体（仅作历史参考）

| 实体 | 废弃日期 | 接收者 |
|---|---|---|
| `alfadb/pi-gstack` repo | 2026-05-05 | 整体并入 pi-stack |
| `alfadb/pi-multi-agent` repo | 2026-05-05 | subtree merge 入 pi-stack/extensions/multi-agent |
| `alfadb/pi-sediment` repo | 2026-05-05 | subtree merge 入 pi-stack/extensions/sediment |
| `kingkongshot/Pensieve@feature/auto-sediment-hook` 分支 | 2026-05-05 | 已通过 `pi` 分支替代后再废弃 |
| `kingkongshot/Pensieve@pi` 分支 | 2026-05-05 | 内容并入 pi-stack（A/B/C-i 三类）|
| `~/.pi/agent/extensions/gbrain/` | 2026-05-05 | pi-stack/extensions/gbrain |
| `~/.pi/agent/extensions/retry-stream-eof.ts` | 2026-05-05 | pi-stack/extensions/retry-stream-eof.ts |
| `~/.pi/agent/skills/pi-model-curator/` | 2026-05-05 | pi-stack/extensions/model-curator |
