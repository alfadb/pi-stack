# Migration — memory_search 升级为 LLM-driven retrieval

> **状态**：In progress（2026-05-10；Phase 0/1 implemented；Phase 2 curator create/update/merge/archive/supersede/delete/skip implemented by ADR 0016）
> **依赖**：[ADR 0015](../adr/0015-memory-search-llm-driven-retrieval.md)（决策本身）
> **关联**：[ADR 0010](../adr/0010-sediment-single-agent-with-lookup-tools.md)（lookup-tools loop 设计）/ [ADR 0016](../adr/0016-sediment-as-llm-curator.md)（curator + update/delete 方向）
> **触发**：见 ADR 0015 背景

## 总览

| Phase | 内容 | 工作量 | 阻塞条件 |
|---|---|---|---|
| **Phase 0** | 增强 `_index.md` 格式 | ✅ implemented | 无 |
| **Phase 1** | LLM-driven search 核心实现 | ✅ implemented | Phase 0 |
| **Phase 2** | sediment curator 接入新 search：优先 update/merge，create 次之（ADR 0010 lookup-tools loop + ADR 0016） | ✅ create/update/merge/archive/supersede/delete/skip implemented | Phase 1 burn-in 1-2 天 |
| **Phase 3** | memory-architecture / brain-redesign-spec 全量文档对齐 + ADR 0010 状态升级 | 30 分钟 | Phase 1+2 落地 |

总工作量约一个 4-6 小时会话窗口。Phase 0+1 可一次性做完；Phase 2 不再以“拒绝同义重复”为终点，而是进入“找旧条目 → update/merge/skip/create”的 curator loop。

---

## Phase 0：增强 `_index.md` 格式

### 现状

`extensions/memory/index-file.ts` 当前生成的 `_index.md`：

```markdown
## maxims
- [[slug-1]] — 一句话摘要（compiled_truth 第一段，最多 240 字符）
- [[slug-2]] — ...

## decisions
- [[slug-3]] — ...
```

每条 entry 信号量 ~50 token。LLM stage 1 要从 250 entry 中选 top-50，靠这个信号量不够。

### 目标格式

```markdown
## maxims

### [[eliminate-special-cases-by-redesigning-data-flow]]
- kind: maxim | status: active | confidence: 7 | updated: 2026-04-30
- trigger: ["edge case", "if branch", "data flow"]
- summary: Prefer restructuring data flow over adding if-branches for edge cases.

### [[preserve-user-visible-behavior-as-a-hard-rule]]
- kind: maxim | status: active | confidence: 8 | updated: 2026-05-02
- trigger: ["refactor", "behavior change", "regression"]
- summary: Never change observable behavior during refactoring.

## decisions
...
```

每条 entry ~150 token，250 entry ≈ 37k tokens，opus/ds 200k 窗口装得下。

### 实现

- 改 `extensions/memory/index-file.ts` 的 `makeIndexEntryMarkdown()` 函数
- 增加输出字段：kind / status / confidence / updated / trigger_phrases
- summary 仍取 compiled_truth 第一段（保持向后兼容）
- 跑 `/memory rebuild --index .pensieve` 重建一次验证 token 量

### 验收

- enhanced `_index.md` 总字节数 < 200KB（粗估 token < 50k）
- smoke:memory 仍 pass
- enhanced index 生成不影响 LLM runtime；`memory_search` 无 grep 降级路径

---

## Phase 1：LLM-driven search 核心实现

### 文件结构

```
extensions/memory/
  llm-search.ts       (新建)   核心实现
    - buildLlmIndexText(entries)  // Phase 1 实现：内存生成 enhanced index，避免物理 _index.md 过期
    - stage1 candidate selection via configured model
    - stage2 final rerank via configured model
    - llmSearchEntries(entries, params, settings, modelRegistry)
  index.ts            (改)     memory_search execute 路由：只走 LLM；失败 hard error
  search.ts           (保留)   legacy grep+tf-idf implementation for diagnostics/tests + list/get/neighbors
  settings.ts         (改)     加 SearchSettings 接口 + 默认值
  index-file.ts       (改)     `/memory rebuild --index` 输出 enhanced `_index.md`
pi-astack-settings.schema.json (已在 ADR commit 先行落地)     memory.search.* 节点
scripts/smoke-memory-sediment.mjs (改)  加 LLM 路径 mock 测试
```

### 关键设计点

#### Stage 1 prompt 模板

```
You are pi-astack memory search candidate selector.

Task: given a user query and a markdown index of all knowledge entries,
select up to {stage1Limit} entries that are most likely relevant. Output
a JSON array of {slug, reason} objects.

Hard rules:
- The query is a natural-language retrieval prompt. It should state the
  full intent, not just terse keywords.
- The query may be in Chinese, English, or mixed. Match across languages
  semantically, not just literally (e.g. "沉淀" ≡ "sediment", "auto-write"
  ≡ "自动写入").
- Prefer entries whose trigger_phrases match query intent.
- Prefer recent (high updated date) over stale, all else equal.
- Status=archived entries are excluded by default; do not output them
  unless query explicitly asks for archived/historical context.
- Output JSON only, no markdown wrapper, no commentary.

Index:
<<<INDEX
{enhanced _index.md content}
INDEX>>>

Query: {query}

Output (JSON array, max {stage1Limit} items):
```

#### Stage 2 prompt 模板

```
You are pi-astack memory search final ranker.

Task: given a user query and {N} candidate knowledge entries (full
content), rank them by relevance and output the top {stage2Limit} with
ranking + per-entry relevance analysis.

Hard rules:
- Read each entry's compiled_truth AND timeline. Recent timeline entries
  may invalidate or refine the compiled_truth; reflect this in ranking.
- An entry whose timeline says "deprecated by X" should rank lower than
  X if X is also a candidate.
- Score each entry 0-10 for query relevance.
- Output JSON: [{slug, score, why}, ...]
- Output JSON only.

Query: {query}

Candidates:
<<<CANDIDATES
{N entries, each as: ## slug\n<full markdown>\n---}
CANDIDATES>>>

Output (JSON, top {stage2Limit} sorted by score desc):
```

#### settings.ts 默认值

```typescript
export interface SearchSettings {
  stage1Model: string;
  stage1Limit: number;
  stage1Thinking: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
  stage2Model: string;
  stage2Limit: number;
  stage2Thinking: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  stage1Model: "deepseek/deepseek-v4-flash",
  stage1Limit: 50,
  stage1Thinking: "off",   // DeepSeek v4 supports off/high/xhigh; minimal would clamp to high
  stage2Model: "deepseek/deepseek-v4-pro",
  stage2Limit: 10,
  stage2Thinking: "high",
};
```

#### no grep degradation

`memory_search` 不提供 env/config 降级开关。LLM/modelRegistry/auth/network/JSON 失败时 hard error；修复模型/网络/配置后重试。准确性是契约，不能用 grep 结果静默替代。Stage 1 只要返回任何候选，就必须进入 Stage 2 full-content rerank，不因候选数少而跳过。请求的 thinking level 若模型不支持则 hard error，不让 pi-ai silently clamp。

#### memory_search 工具描述更新

```
description: "Search markdown memory using a natural-language retrieval
prompt. Internally uses two-stage LLM rerank (stage 1 candidate selection
from index, stage 2 full-content rerank) to handle Chinese-English mixed
queries, semantic paraphrase, and trigger-phrase matching. Returns
relevance-ranked entries; results are merged across stores without
scope/backend/source_path."

promptGuidelines:
- "Write query as a natural-language retrieval prompt that states the full
  intent, not just terse keywords."
- "Mixed-language retrieval prompts work: '找关于知识沉淀 extractor prompt 的
  durable rule' will match both Chinese and English entries."
- "Hard error if LLM unavailable; there is no grep degradation path."
```

### Phase 1 验收

- ✅ `npm run smoke:memory` pass（含新增 LLM 路径 mock 测试：stage1 reasoning=off，stage2 reasoning=high；missing modelRegistry hard error；结果含 created/updated/timeline_tail/rank_reason 且不含 degraded）
- 实测 5 个 query：
  - `vault read path` → 命中 abrain-vault-read-path entry
  - `知识沉淀提示词` → 命中 sediment llm-extractor 相关 entry（中文修复验证）
  - `extracting` → 命中 sediment extractor 系列 entry（词形变化修复验证）
  - `跟 dotfiles 自动 push 相关` → 命中 dotfiles-no-auto-push 系列（同义改述 + 中文修复）
  - 无关 query → 返回空或低分
- LLM 不可用时报 hard error；不提供 grep 降级路径
- 结果 card 暴露新鲜度信号：`created` / `updated` / `rank_reason` / `timeline_tail`；不暴露 `degraded`（无降级路径），完整 timeline 仍用 `memory_get(slug)`

### Phase 1 burn-in 观察期

落地后建议**主会话使用 1-2 天**观察：
- 准确度是否真的解决 5 大短板
- 延迟是否在可接受范围（15-20s）
- stage 1 漏选率（如果 user 明确说"漏了 X entry"则需调整 prompt）
- token 用量是否符合预期

---

## Phase 2：sediment curator 接入新 search（ADR 0010 lookup-tools loop + ADR 0016）

### 现状

`extensions/sediment/dedupe.ts` 已按 ADR 0016 收敛为 storage-only slug collision guard。旧 word-trigram / G13 rare-token 机械语义 dedupe 已删除。语义改述、旧决策实现、supersession 等全部交给 `extensions/sediment/curator.ts` 通过 `memory_search` + curator LLM 判断。

### 目标

sediment curator 在 create 前调用 ADR 0015 `memory_search`：

```typescript
const neighbors = await memorySearch({
  query: `找与这个候选知识语义相关、可能应被更新/合并/跳过的旧条目：${draft.compiledTruth}`,
  filters: { limit: 5 },
}, settings, modelRegistry);

const op = await curatorLlm.decide({ draft, neighbors: fullEntries });
// op: skip | create | update | merge | supersede | archive | delete
```

LLM 在 stage 2 精排时已经做过语义相似和 timeline 判断；sediment 不再把结果简化成 `semantic_duplicate => reject`，而是让 curator 决定 update/merge/skip/create。

### 关键策略

不设置固定 `SEMANTIC_DUP_THRESHOLD` 作为 hard reject。相似度、freshness、status、timeline supersession 都交给 curator prompt 判断：

- 同义改述 → update/merge/skip
- 旧决策已实现 → update compiled truth + append timeline
- 旧知识被推翻 → supersede/archive
- 全新知识 → create

### settings 字段

不再新增 semantic-dedupe 阈值或 legacy mechanical mode。Live path 直接运行：extractor → memory_search → curator decision → create/update/merge/archive/supersede/delete/skip。Git + audit 作为回滚面。

### audit 扩展

`audit.jsonl` 写 curator 决策时 log：
- LLM 返回的 top-5 neighbor 及 score/rank_reason
- curator operation（skip/create/update/merge/supersede/archive/delete）
- operation rationale
- 决策耗时（用于评估"sediment 调 search → search 调 LLM"的总延迟）

### Phase 2 验收

- 同义改述不再平行新增：手工构造一条与已有 entry 同义但表达不同的 draft，sediment curator 输出 update/skip/merge/delete，audit 记录 LLM neighbor 证据
- 真新洞察通过：另一条全新内容正常 create
- LLM 不可用时 hard error / audit failed；不要静默回退到 G13 机械语义判断
- D6 自重复在 burn-in 期不再出现；旧知识能被 update/supersede 而不是无限累加

---

## Phase 3：文档对齐 + ADR 状态升级

### 文档更新清单

- [ ] [memory-architecture.md](../memory-architecture.md) §6.1：memory_search 签名注释更新（query 语义扩展），§3 第 8 条 graceful degradation 加 search 例外
- [ ] [brain-redesign-spec.md](../brain-redesign-spec.md) §4.1：ranking 实现说明从"text score × boost"更新为"LLM rerank, stage 1 用 boost 系数作 prompt 提示"
- [ ] [docs/migration/steps.md](./steps.md) Phase 1.3：补 banner 指向本文件，说明 grep+tf-idf 已退出 `memory_search` runtime 路径
- [ ] [docs/directory-layout.md](../directory-layout.md)：extensions/memory/ 子目录加 llm-search.ts；migration 列表加本文件；ADR 列表加 0015
- [ ] [README.md](../../README.md)：v7.x update banner 加一段 LLM-driven search；ADR 计数 14 → 15
- [ ] [ADR 0010](../adr/0010-sediment-single-agent-with-lookup-tools.md)：状态从"核心思想保留 / tools 过时"升级为"核心思想保留 / tools 实现"
- [x] [ADR 0015](../adr/0015-memory-search-llm-driven-retrieval.md)：状态 Proposed → Accepted（Phase 0/1 implemented；Phase 2 pending）

### Phase 3 验收

- 所有文档引用链一致（不会有"LLM-driven search"在 ADR 写了但 README 没说）
- `/memory doctor-lite` 通过

---

## 操作 Checklist（实施时按这个走）

```
[x] Phase 0: 改 extensions/memory/index-file.ts → /memory rebuild --index → 验证 token 量（302 entries / 137KB / ~37k tokens / 480ms）
[x] Phase 1.1: 写 extensions/memory/llm-search.ts
[x] Phase 1.2: 改 index.ts execute 路由逻辑（实际实现位置；只走 LLM，search.ts 不再作为 memory_search fallback）
[x] Phase 1.3: 改 settings.ts + pi-astack-settings.schema.json（schema 已先行于 ADR commit 落地）
[x] Phase 1.4: 改 index.ts 工具描述
[x] Phase 1.5: 改 smoke-memory-sediment.mjs 加 LLM 路径 mock
[x] Phase 1.6: npm run smoke:memory PASS
[x] Phase 1.7: 重启 pi 后实测真实 query；result card 带 created/updated/rank_reason/timeline_tail，且无 degraded
[x] Phase 1.8: commit + push（ADR 0015 Accepted；Phase 0/1 landed）
[x] Phase 2.1: ADR 0016 改写目标：不做 semanticDedupe hard reject，改为 memory_search lookup + curator lifecycle decision
[x] Phase 2.2: 删除 semantic dedupe/readiness/rate/sampling/rolling settings 与 schema
[x] Phase 2.3: writer substrate 接入 update/merge/archive/supersede/delete/skip
[x] Phase 2.4: audit log 扩展 curator neighbors / decision / operation rationale
[x] Phase 2.5: smoke 覆盖 lifecycle ops；live burn-in 观察 update/merge/skip，避免 append-only create
[x] Phase 2.6: commit + push（ADR 0016 curator loop + lifecycle ops landed）
[ ] Phase 3: 文档收敛 + stale memory entries 修正 + writer-level correlation id 增强
```
