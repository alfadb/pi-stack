# Phase 2.3 — Promotion Gates 设计稿

> ⚠️ **SUPERSEDED by [ADR 0014](../adr/0014-abrain-as-personal-brain.md) §D3（2026-05-09）**。abrain 七区拓扑下不再有 "project → world promotion" 概念——sediment writer 直接将条目路由到 `identity` / `skills` / `habits` / `workflows` / `projects` / `knowledge` / `vault` 中一个。Lane B（manual promote）与 Lane D（auto-promote）在 ADR 0013 中同期被标记为 "失效"。Promotion gates 1–5 不在路线图上，本文档仅作为设计动机记录保留。
>
> **原状态**：DRAFT，2026-05-08。等 Phase 1.4 burn-in 数周稳定后再实施。
>
> **范围**：定义 project → world 条目升级的闸门、命令、文件流、回滚。
> 实施前必须有用户签字。
>
> **来源**：
> - `memory-architecture.md` §9.1 Promotion (project → world)
> - `migration/steps.md` Phase 2.3 验收标准
> - 2026-05-08 Phase 1.4 burn-in 教训（asymmetric trust / G13 / audit raw_text）

---

## 0. 目标 / 非目标

### 目标

1. 实现 `/sediment promote <slug>` 把 project 条目升级到 `~/.abrain/`。
2. 强制 Gate 1-5 验证；Gate 失败默认 BLOCK，可 audited override。
3. 保留 project 原条目（追加 timeline `[promoted_to world:<slug>]`），不删除。
4. 提供对称的 `/sediment demote <world-slug>` 反向操作。
5. 所有 promote/demote 都写 audit row（同 sediment audit log），含 raw gate evaluation。

### 非目标（推迟）

- LLM judge 模式 Gate 3（反例搜索）— Phase 5
- 语义相似度 Gate 5 — Phase 4+ qmd 集成后
- 自动 promotion（confidence-by-citations 触发）— Phase 5+，需 burn-in 评估
- 跨机 sync — Phase 2.x 路线漏洞，独立设计
- Cross-`pi-astack`-instance 协调（多并发 pi 进程同时 promote）— 用 file lock 兜底

---

## 1. Asymmetric Trust（从 Phase 1.4 burn-in 学到）

> 本节原则已升为正式架构决策：[ADR 0013 — Asymmetric Trust 三段式](../adr/0013-asymmetric-trust-three-lanes.md)。本设计稿是 ADR 0013 中 **Lane B (manual promote)** 的详细实施展开。

| Lane | 触发 | 信任度 | 闸门 |
|---|---|---|---|
| 显式 `MEMORY:` block | 用户亲手输入 | 高 | 仅 hard validation |
| LLM auto-write | bg LLM lane | 低 | G2-G13 全套 |
| **Promotion (Phase 2.3)** | **用户 `/sediment promote` 手动调用** | **中** | **Gate 1-5** |
| Auto-promotion (Phase 5+) | confidence/citation 指标 | 低 | Gate 1-5 + readiness |

**核心原则**：promotion 是 USER-invoked，不是 sediment 自动行为。即使全 gates 通过，sediment 不会主动 promote——必须有用户 `/sediment promote <slug>` 命令。

**为什么**：world 是跨项目永久知识，错把 project-specific 升级成 world maxim 后果远比错写 project entry 严重；用户介入是必要的人工 review。Phase 1.4 LLM auto-write lane 的"7/12 留存率"说明 LLM 提取不够 reliable 到自动 promotion 的程度。

---

## 2. Gate 详细规约

### Gate 1 — 去上下文化（Decontextualization）

**目的**：world maxim 不应包含 project-specific 字面值（路径、技术栈、内部命名）。

**Phase 2.3 实现**：keyword-based static rules 检查。

**规则源**：`~/.abrain/schemas/decontextualized-check.yaml`（git tracked）

```yaml
# ~/.abrain/schemas/decontextualized-check.yaml
# 默认规则；用户可覆盖
rules:
  # path patterns (replaceable)
  - pattern: "/home/[^/\\s]+"
    action: replace
    with: "$HOME"
  - pattern: "<project_root>/"
    action: replace
    with: "$PROJECT/"

  # tech stack mentions (warn — could be legitimate)
  - pattern: "\\b(pnpm|npm|yarn|bun)\\b"
    action: warn

  # IP / email already in sanitizer; warn here for paranoia
  - pattern: "\\b\\d{1,3}(\\.\\d{1,3}){3}\\b"
    action: replace
    with: "[IP]"

  # CamelCase entity names (entity / customer / product)
  - pattern: "\\b[A-Z][a-z]+[A-Z][a-zA-Z]+\\b"
    action: reject
    reason: "possible entity/product name; manual de-identification required"

  # Specific project file paths (project-relative)
  - pattern: "\\bagent/skills/pi-astack/"
    action: reject
    reason: "pi-astack-specific path; rewrite to abstract"
```

**Action 语义**：
- `replace` — sediment 自动重写 compiled_truth + title 后通过
- `warn` — 提示但放行（写入 audit warnings[]）
- `reject` — 阻断 promote；用户必须手改 project 条目再重试

**实现**：
```ts
function evaluateDecontextualization(entry: MemoryEntry, rules: Rule[]): Gate1Result {
  const violations = [];
  let rewrittenTruth = entry.compiledTruth;
  let rewrittenTitle = entry.title;
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, "g");
    const matches = [
      ...rewrittenTruth.matchAll(re),
      ...rewrittenTitle.matchAll(re),
    ];
    if (matches.length === 0) continue;
    if (rule.action === "reject") return { passed: false, reason: rule.reason };
    if (rule.action === "replace") {
      rewrittenTruth = rewrittenTruth.replace(re, rule.with);
      rewrittenTitle = rewrittenTitle.replace(re, rule.with);
    }
    if (rule.action === "warn") violations.push({ rule, matches });
  }
  return { passed: true, rewrittenTruth, rewrittenTitle, warnings: violations };
}
```

**开放问题**：
- Q1.1 默认规则文件位置：`~/.abrain/schemas/` vs `pi-astack/defaults/`？建议 `~/.abrain/schemas/` 让用户拥有，pi-astack 提供 `defaults/decontextualized-check.yaml` 作 fallback。
- Q1.2 是否需要 dry-run 预览重写？建议 `/sediment promote <slug> --dry-run` 输出 before/after diff。

---

### Gate 2 — 跨实例验证（Cross-Instance）

**目的**：确认洞察在 ≥2 个独立项目中独立浮现，证明可泛化。

**Phase 2.3 实现**：基于 `~/.abrain/.state/known-projects.json` 注册表 + slug/title 跨项目匹配。

**known-projects.json schema**：
```json
[
  {
    "project_id": "pi-global",
    "pensieve_path": "/home/worker/.pi/.pensieve",
    "first_seen": "2026-05-08T16:00:00+08:00",
    "last_seen": "2026-05-08T18:00:00+08:00",
    "slug_count": 142
  }
]
```

**注册触发**：sediment activate 时 upsert（pensieve_path → project_id 映射）。`project_id` 从 `<project>/.pensieve/config.yml` 的 `project.id` 字段读，缺失时 fallback `path.basename(projectRoot)`。

**Gate 2 算法**：
```ts
async function evaluateCrossInstance(slug: string, title: string): Promise<Gate2Result> {
  const known = await loadKnownProjects();
  const matches: { project_id, slug, score }[] = [];
  for (const proj of known) {
    if (proj.pensieve_path === currentProject) continue; // skip self
    const localScan = await scanStore({ scope: "project", root: path.join(proj.pensieve_path) }, ...);
    // exact slug match
    const exact = localScan.find(e => e.slug === slug);
    if (exact) { matches.push({ project_id: proj.project_id, slug, score: 1.0 }); continue; }
    // soft signal — same G13 logic
    const dup = await detectProjectDuplicate(proj.pensieve_path, title, { kind: ...});
    if (dup.duplicate || dup.nearDuplicate) {
      matches.push({ project_id: proj.project_id, slug: dup.match.slug, score: dup.score });
    }
  }
  return {
    passed: matches.length >= 1,  // self counts as 1, plus matches.length means ≥2 total
    matches,
  };
}
```

**单机痛点**：用户只用一台机器、只有一个项目时 Gate 2 永远不过。

**解法选项**：
- **(a) 严格**：默认 reject。escape hatch `--override-cross-instance --justification "<text>"` 写入 audit。**推荐**——保持高 bar，紧凑场景必须用户明示。
- (b) 宽松：单项目时降级为"≥3 次该 slug 被 sediment 引用"。复杂、易作弊。
- (c) 时间替代：≥2 周稳定使用 + ≥1 次外部引用。需要 sediment 跟踪应用记录。

**推荐 (a)**，理由：
1. Burn-in 教训：单机使用是 outlier 场景，主流是多机/多项目；不应为 outlier 妥协架构。
2. Override 机制的 audit 让用户知道"我在违反 Gate 2"，下次会更谨慎。

---

### Gate 3 — 反例检查（Counterexamples）

**目的**：确认没有已知反例存在；如有，标记 `boundaries` 字段限定边界。

**Phase 2.3 实现**：仅检查已存在的 `contested_with` / `superseded_by` 关系。不主动搜索反例（Phase 5 LLM judge）。

```ts
async function evaluateCounterexamples(entry: MemoryEntry): Promise<Gate3Result> {
  const contested = entry.relations.filter(r => r.type === "contested_with");
  const superseded = entry.relations.filter(r => r.type === "superseded_by");
  if (contested.length > 0 || superseded.length > 0) {
    // 不阻断 promotion，但要求 boundaries 字段已填
    if (!entry.frontmatter.boundaries) {
      return { passed: false, reason: "contested/superseded relations exist; boundaries field required" };
    }
  }
  return { passed: true, contestedCount: contested.length };
}
```

**开放问题**：
- Q3.1 boundaries 字段格式：纯文本 vs 结构化？建议 schema-free string，长度 50-500 chars。
- Q3.2 deprecated 状态的 entry 能 promote 吗？建议 NO（writer 早返回 reject）。

---

### Gate 4 — 冷却期（Cooling）

**目的**：避免热血上头新写的"洞察"立刻 promote。

**算法**：从 timeline 首行日期到当前 ≥ 3 天。

```ts
function evaluateCooling(entry: MemoryEntry, days = 3): Gate4Result {
  const firstTs = entry.timeline[0]?.timestamp;
  if (!firstTs) return { passed: false, reason: "no timeline; cannot compute cooling" };
  const ageMs = Date.now() - new Date(firstTs).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return {
    passed: ageDays >= days,
    ageDays: Math.floor(ageDays * 10) / 10,
    requiredDays: days,
    cooling_until: firstTs.toString().slice(0, 10),  // YYYY-MM-DD
  };
}
```

**默认**：3 天。settings: `promotionCoolingDays`。

**Override**：`--override-cooling --justification "<text>"`。  
合法 use case：bug 修复后立即 promote 反 anti-pattern（`pi extension hook handlers are awaited synchronously` 类型，越早 promote 越好）。

---

### Gate 5 — 冲突检查（Conflict）

**目的**：确认 world store 没有同类 active 条目；有则标记 `contested_with`。

**算法**：复用 G13 dedupe（HARD + SOFT），target store 改 world。

```ts
async function evaluateConflict(promotedDraft, worldRoot): Promise<Gate5Result> {
  const dup = await detectProjectDuplicate(/*projectRoot=*/ worldRoot, promotedDraft.title, {
    slug: promotedDraft.slug,
    kind: promotedDraft.kind,
    threshold: 0.7,                  // word-trigram HARD
    charTrigramThreshold: 0.20,      // SOFT G13
    rareTokenMaxDf: 2,
  });
  if (dup.duplicate) {
    // HARD conflict — block. User must demote/supersede the existing world entry first.
    return { passed: false, reason: "world hard duplicate", match: dup.match };
  }
  if (dup.nearDuplicate) {
    // SOFT conflict — block by default; user can override and BOTH entries get contested_with each other.
    return {
      passed: false,
      reason: "world near-duplicate (soft)",
      match: dup.match,
      detail: dup.nearDuplicateDetail,
      auto_resolve_option: "mark both contested_with",
    };
  }
  return { passed: true };
}
```

**Override 行为**：`--override-conflict --resolve contested`：
- 新 world entry 写入，frontmatter `contested_with: [<existing-slug>]`
- 旧 world entry frontmatter 追加 `contested_with: [<new-slug>]`，写一次（单独 file lock + atomic）
- 两条都保留，doctor-lite 报"contested cluster"

---

## 3. 命令表面

### `/sediment promote <slug> [--dry-run] [--override-* --justification ...]`

```text
/sediment promote avoid-long-argv-prompts
  → 检查所有 5 gates，通过则 promote
  → 失败任一 gate → 输出 detailed gate report，不写入

/sediment promote avoid-long-argv-prompts --dry-run
  → 仅评估 gates + 显示 Gate 1 重写预览，不写入、不 audit

/sediment promote avoid-long-argv-prompts \
  --override-cross-instance \
  --justification "single-machine-user; insight verified across 6 weeks of pi sessions"
  → Gate 2 跳过，audit 记录 override + justification 全文
  → 其他 gates 仍正常评估
```

**Override flags 完整列表**：
- `--override-decontextualization` (Gate 1 reject)
- `--override-cross-instance` (Gate 2)
- `--override-counterexamples` (Gate 3)
- `--override-cooling` (Gate 4)
- `--override-conflict --resolve contested` (Gate 5 soft)

**全局必带** `--justification "<text>"`（≥ 30 chars）。空 justification → 拒绝命令。

### `/sediment demote <world-slug> [--reason <text>]`

```text
/sediment demote avoid-long-argv-prompts --reason "found counterexample in project-x"
  → world 条目移到 ~/.abrain/archive/
  → 原 project 条目 timeline 追加 "[demoted_from world]"
  → 30-day cooldown：再 promote 此 slug 时 Gate 4 自动 reject 直到 cooldown 过
```

### `/sediment promotion-status [<slug>]`

```text
/sediment promotion-status avoid-long-argv-prompts
  → 显示该 slug 各 gate 当前评估结果（不执行）
  → "Gate 4: ageDays=2.3 / required=3 → BLOCK"

/sediment promotion-status
  → 列出 project 中所有 candidates（confidence>=5 + status=active）的 gate 状态汇总
  → 用作 review queue
```

---

## 4. 文件流

```
BEFORE:
  /home/worker/.pi/.pensieve/knowledge/avoid-long-argv-prompts.md  (status: active)

AFTER /sediment promote avoid-long-argv-prompts:
  /home/worker/.pi/.pensieve/knowledge/avoid-long-argv-prompts.md   (timeline appended:
                                                                     "[promoted_to world:avoid-long-argv-prompts]")
  /home/worker/.abrain/knowledge/avoid-long-argv-prompts.md         (NEW; id=world:..., scope=world,
                                                                     confidence=src+2, status=active,
                                                                     promotion={ gates summary })

AFTER /sediment demote avoid-long-argv-prompts --reason ...:
  /home/worker/.abrain/archive/avoid-long-argv-prompts.md           (moved; timeline appended demote)
  /home/worker/.pi/.pensieve/knowledge/avoid-long-argv-prompts.md   (timeline appended
                                                                     "[demoted_from world]")
```

**Slug collision 处理**：极少；如 world 已有同 slug 但内容不同 → Gate 5 拦截。如真要并存，需先 demote 旧 entry。

**Wikilink 处理**：不重写。新 world entry 的 body 中如有 `[[some-project-only-slug]]`，会成为 dead link（doctor-lite 报告）；用户可选择手动改写为 `[[world:some-other-slug]]` 或删除。  
（Phase 4 可考虑 promotion-time 自动 wikilink 改写，但要谨慎。）

---

## 5. Frontmatter 变化

### Source（project 条目，保留 + 追加 timeline）

```yaml
---
id: project:pi:avoid-long-argv-prompts
scope: project
kind: maxim
status: active             # 不变
confidence: 7              # 不变
schema_version: 1
title: "Avoid long argv prompts"
created: 2026-05-08
updated: 2026-05-09        # promote 当日
promoted_to: world:avoid-long-argv-prompts   # NEW field
---

# Avoid long argv prompts

[unchanged body]

## Timeline

- 2026-05-08 | sess-abc | captured | explicit MEMORY block
- 2026-05-09 | sess-ghi | promoted | [promoted_to world:avoid-long-argv-prompts]
```

### Target（world 条目，新建）

```yaml
---
id: world:avoid-long-argv-prompts
scope: world
kind: maxim
status: active
confidence: 9              # min(10, src.confidence + 2)
schema_version: 1
title: "Avoid long argv prompts"   # Gate 1 重写后的版本
created: 2026-05-09        # promote 日期
updated: 2026-05-09
promoted_from: project:pi:avoid-long-argv-prompts
promotion:
  source_entry: project:pi:avoid-long-argv-prompts
  promoter_session: 019e06f5-...
  gates:
    decontextualized: { passed: true, warnings: [...] }
    cross_instance: { passed: true, matches: [...] }
    counterexamples: { passed: true, contestedCount: 0 }
    cooling: { passed: true, ageDays: 24.3 }
    conflict: { passed: true }
  overrides: []                       # or e.g. ["cross_instance"]
  justification: ""                   # required when overrides not empty
  completed_at: 2026-05-09T14:30:00+08:00
---

# Avoid long argv prompts

[Gate 1 重写后的 body]

## Timeline

- 2026-05-09 | sess-ghi | promoted | from project:pi (confidence 7→9)
```

---

## 6. Audit 行 schema

`appendAudit(projectRoot, { operation: "promote", ... })` 写到 `.pi-astack/sediment/audit.jsonl`。

```jsonc
{
  "timestamp": "2026-05-09T14:30:00.123+08:00",
  "audit_version": 2,
  "pid": 802913,
  "operation": "promote",
  "session_id": "019e06f5-...",
  "source_slug": "avoid-long-argv-prompts",
  "source_path": ".pensieve/knowledge/avoid-long-argv-prompts.md",
  "target_slug": "avoid-long-argv-prompts",
  "target_path": "~/.abrain/knowledge/avoid-long-argv-prompts.md",
  "kind": "maxim",
  "src_confidence": 7,
  "tgt_confidence": 9,
  "gates": {
    "decontextualized": { "passed": true, "rewrites": [...] },
    "cross_instance": { "passed": true, "matches": [...] },
    "counterexamples": { "passed": true, "contestedCount": 0 },
    "cooling": { "passed": true, "ageDays": 24.3 },
    "conflict": { "passed": true }
  },
  "overrides": [],
  "justification": "",
  "stage_ms": { "gate_eval": 145, "world_write": 88, "src_update": 32, "total": 270 }
}
```

Demote 类似，operation: "demote"，含 `demote_reason`。

---

## 7. 锁

- World writer：`~/.abrain/.state/locks/world.lock`（与 project lock 完全独立）
- Promote 流程同时持有：project lock（追加 source timeline）+ world lock（写新 entry）
- 顺序：先抓 world lock，再抓 project lock（避免与 sediment auto-write 在 project lock 上死锁）

---

## 8. 实施工作量估计

| 模块 | LOC | 说明 |
|---|---|---|
| `extensions/sediment/promotion.ts` | 400-500 | 5 gate 实现 + frontmatter rewrite + 双仓 file move |
| `extensions/memory/known-projects.ts` | 100-150 | registry RMW + sediment activate hook |
| `extensions/sediment/index.ts` 命令 | 200-300 | `/sediment promote / demote / promotion-status` |
| `extensions/sediment/settings.ts` | +30 | promotion 相关 settings (cooling days / override audit) |
| `decontextualized-check.yaml` 默认 | ~50 | pi-astack defaults + ~/.abrain/schemas/ override |
| Smoke 回归 | 250-350 | 5 gate × pass/fail × override × demote = ~20 cases |
| **总计** | **~1100-1400 LOC** | 1-2 个工作日（不含 burn-in 和 review） |

---

## 9. 开放问题（必须用户拍板）

| Q | 问题 | 推荐 |
|---|---|---|
| Q1 | Gate 2 单机用户怎么过？ | 严格 reject + override --justification |
| Q2 | Gate 5 soft 冲突怎么处理？ | 默认 block，--override-conflict --resolve contested |
| Q3 | Wikilink rewrite 在 promote 时做吗？ | 不做（dead link 由 doctor-lite 提醒）|
| Q4 | confidence 升幅 +2 还是 +3？ | +2（保守，cap 10）|
| Q5 | 是否引入 `--draft` 模式（写到 ~/.abrain/staging/）？ | 不引入；soft 冲突已是 staged 体验 |
| Q6 | Demote 是否触发 30 天 cooldown？ | 是（防 ping-pong）|
| Q7 | Audit 是否写到 ~/.abrain/.state/promotion-audit.jsonl 还是合并到 .pi-astack/sediment/audit.jsonl？ | 合并到 sediment audit（统一查询）|
| Q8 | known-projects.json 跨机同步？ | Phase 2.x sync 解决；Phase 2.3 单机 |
| Q9 | 需要 `/sediment promotion-replay` 重放历史 audit 行吗？ | 不需要，audit 行可读性已够 |
| Q10 | LLM 自动 promote（confidence ≥ 8 + citations ≥ 3 → 自动）？ | NO，Phase 5+ 评估 |

---

## 10. 顺序建议

burn-in 期间（数周）做：
1. Q1-Q10 用户拍板
2. `~/.abrain/.state/known-projects.json` schema 落地（sediment activate 注册即可，无 promote 也有用）
3. `decontextualized-check.yaml` 默认规则收集（看 ~/.pi/.pensieve/ 中已有的 maxim 哪些能 promote，反推规则）

burn-in 通过后：
4. 实施 promotion.ts + 命令 + smoke
5. 第一次手动 promote 几条公认的 cross-project maxim（如 `cross-process-protocol-tradeoff-not-philosophy` / `pi-astack-docs-inside-submodule`）
6. 观察 audit + ~/.abrain/ 增长 1-2 周
7. 实施 demote + cooldown
8. 实施 promotion-status review queue

---

## 11. 与今天迭代的衔接

| 今天的工件 | Phase 2.3 中的角色 |
|---|---|
| G13 soft near-duplicate | 直接复用为 Gate 5 |
| audit raw_text 完整保留 | promote audit 同样保留 raw justification + gate eval |
| asymmetric trust（LLM vs explicit）| 提升为三段式（LLM / explicit / promotion）|
| forceProvisional + maxConfidence | 反向：promotion 给 src.confidence + 2，不锁 provisional |
| settings hot-reload | promotion-related settings 同样可热更 |
| footer status FSM | 可加 `📤 sediment promoting...` / `✅ sediment promoted: N` 态 |

---

**评审请检查**：
- §2 各 Gate 的算法是否有遗漏
- §3 命令命名 / override flag 是否合理
- §4 文件流 / wikilink 处理是否过激
- §9 开放问题的推荐答案是否同意
- §10 顺序建议是否合适
