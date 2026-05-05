# pi-stack 上游跟踪

> 维护原则: brain maxim `prefer-read-only-vendor-submodules-with-owned-adaptation-layers-over-forking-ext`
> 仪式: 上游发版 → `git submodule update --remote vendor/<x>` → diff → 决定哪些值得移植 → 在端口层改 → 在本表更新基线 SHA

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
- 跟踪分支: `main`（kingkongshot/Pensieve 是 alfadb 自己维护的 pensieve 中文化主线，作为事实上游存在）
- SHA: `<待 pin，第一次 git submodule add 后填写>`
- 跟进策略: kingkongshot/Pensieve@main 上有新 commit → 看 diff → 决定是否值得移植

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

## 上游升级仪式（标准流程）

### 1. 看 diff
```bash
npm run vendor:diff:gstack       # 或 vendor:diff:pensieve
# 等价于:
cd vendor/<x> && git fetch origin && git log --oneline HEAD..origin/main
```

### 2. 决定是否升级
- 看 changelog / commit message
- 决定哪些 commit 值得移植到端口层

### 3. 升级 vendor pointer
```bash
cd vendor/<x>
git checkout <new-sha>
cd ../..
git add vendor/<x>
git commit -m "chore(vendor): bump <x> to <new-sha>"
```

### 4. 移植到端口层
- skills / extensions / prompts / runtime/ 内逐个改
- 每个改动一个 commit: `feat(skills/<name>): port <feature> from <vendor> <new-sha>`

### 5. 更新本表
- 任何端口层路径首次出现 → 在对应 vendor 章节加一行
- 任何 alfadb 增强 → 在 "alfadb 自创增强" 章节加一行
- 基线 SHA 更新 → 顶部 SHA 字段更新

### 6. 提交本表更新
```bash
git add UPSTREAM.md
git commit -m "docs(upstream): record port for <x> at <new-sha>"
```

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
