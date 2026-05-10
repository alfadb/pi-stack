# ADR 0015 — memory_search 升级为双阶段 LLM-driven retrieval

- **状态**：Accepted（2026-05-10；Phase 0/1 已实现，Phase 2 sediment semantic dedupe 待 burn-in 后接入）
- **日期**：2026-05-10
- **决策者**：alfadb
- **依赖**：[ADR 0010](0010-sediment-single-agent-with-lookup-tools.md)（lookup-tools loop 设计，本 ADR 落地其内核）/ [memory-architecture.md](../memory-architecture.md) §6（read facade 契约）/ [brain-redesign-spec.md](../brain-redesign-spec.md) §4（cross-project 召回）
- **被引用**：[migration/memory-search-llm-upgrade.md](../migration/memory-search-llm-upgrade.md)（Phase 0/1/2 实施计划）
- **触发**：2026-05-10 一次会话内三件事叠加：
  1. **质量复审**最近 50 条 sediment 沉淀，发现最系统问题是 **D6 自重复**（同义改述被 dedupe 漏过：dotfiles 双条 / memory-list 旧条 / round-3 三联 / dogfood 系列 ~40% 重叠）
  2. **memory_search 实现审查**揭示 5 大短板：CJK 不分词（长中文 query 召回 0 命中实测）/ 无词干化（extract ≠ extracting）/ trigger_phrases 不入索引（设计意图遗漏）/ timeline 不入索引 / substring boost 不可控
  3. **alfadb 明确诉求**："要准确，要能混合检索中英文知识，不考虑成本"——graceful degradation 不变量（"L0 grep 永远在最底"）为准确度让位

## 背景

### 当前实现（Phase 1.3，2026-05-08 落地）

```
rg --files → parseEntry → tokenize(title + slug + compiled_truth)
                       → tf-idf + 4 个 substring boost
                       → × confidence/10 × projectBoost(1.5)
                       → top-N（默认排除 archived）
```

设计目标是"项目级、几百条 entry、英文为主、能跑就行"——明确写在 [docs/migration/steps.md](../migration/steps.md) Phase 1.3。memory-architecture.md 附录 C 早就规划 Phase 3 走 qmd（BM25 + 向量）作为加速层。

### 当前实现的硬伤

实测（2026-05-10）：

| Query | 结果 | 原因 |
|---|---|---|
| `vault read path` | ✅ top-1 准确 | 三纯英文实词，tf-idf + boost 全生效 |
| `沉淀` | ✅ top-1 准确 | 短中文：靠 substring fallback 命中 |
| `知识沉淀提示词` | 🔴 **0 命中** | tokenize 把整段连续 CJK 当**一个 token**，df=0；substring 也匹配不到完整串 |
| `extracting` 找 `extractor` 标题 entry | 🔴 找不到 | 无词干化 |
| `auto-write` vs `auto write` | 🟡 排名不同 | `query.includes` 子串敏感 |

实测召回率在中英混合内容上不可接受，且 **sediment 自己用同一 search 做 dedupe**（lookup-tools loop，ADR 0010）—— search 不准 → dedupe 漏过同义改述 → 自重复 entry 累积，正是 D6 的根因。

### 已被审查否决的替代方案

| 方案 | 否决理由 |
|---|---|
| **修补 grep+tf-idf**（trigger_phrases 进索引 + CJK bigram + 词干化 + timeline 索引） | 局部修补，仍受限于"字面 token 匹配"——同义改述（"自动写入" ≡ "auto-write"）永远搜不到 |
| **qmd（BM25 + 本地 GGUF embedding）** | memory-architecture.md 附录 C 规划但 Phase 3，门槛在 entry > 1000 条；当前 250 条不够触发，且仍是字面/向量召回，不解决跨 entry 推理 |
| **LLM query rewrite**（prompt → keyword 集 → grep） | 部分解决中英混合，但仍受限于 grep 召回；同义改述仍漏 |
| **LLM 整库召回**（250 entry 摘要全塞 LLM 一次） | 准确但单次 token 失控；扩展到 1000+ entry 立即崩 |

## 决策

### D1. 接口不变，内部走 LLM

```
memory_search(query: string /* 自然语言 prompt 或关键词 */, filters?)
  → SearchResult[]  // schema 保持不变
```

主会话 LLM 调用方式 zero change。`query` 语义从"关键词"扩展到"自然语言 prompt"——对 caller 透明。

### D2. 双阶段 LLM rerank

```
Stage 0 (本地)：
  build/read enhanced index（每 entry: slug + title + kind + status +
  confidence + updated + summary + trigger_phrases，~150 token/entry，
  全库 ~37k tokens）。Phase 1 实现为从已解析 entries **内存生成**同形态 index，避免物理 `_index.md` 过期；`/memory rebuild --index` 仍生成同形态 `_index.md` 作为人类/LLM 可浏览 artifact。

Stage 1 (粗排，可配模型，默认 deepseek-v4-flash)：
  输入: query + 全库 _index.md
  输出: top-K 候选 slug + 简短理由（K 默认 50）
  目标: 高召回率。只要有候选，必须进入 Stage 2；不因候选数少而跳过精排

Stage 1.5 (本地)：
  memory_get(slug) × K 拿 candidate 完整 entry（compiled_truth + timeline）

Stage 2 (精排，可配模型，默认 deepseek-v4-pro)：
  输入: query + K 个完整 entry（~60-150k tokens）
  输出: top-N 排序 + 每条相关性分析
  目标: 高精度，跨 entry 推理（"X 比 Y 更相关 because timeline 显示 Z 已废弃"）
```

### D3. 默认全 deepseek 家族

| Stage | 默认模型 | 理由 |
|---|---|---|
| Stage 1 | `deepseek/deepseek-v4-flash` | 国内访问无跨国延迟（alfadb 首要诉求）；粗排是 high-volume eval 任务，flash 甜区；$0.14/1M in 极便宜 |
| Stage 2 | `deepseek/deepseek-v4-pro` | 同 family 国内速度；reasoning 强，跨 entry 推理需要；中文理解原生强；与 sediment extractor 共享，模型 cache 命中 |

**单 family 风险**：sediment extractor 也是 v4-pro，deepseek 服务一挂两个子系统同时失能。可接受理由：
- sediment 是 fire-and-forget + rolling pass-rate fuse，挂了下轮重试
- search 用 hard error（不 fallback grep），用户能立即感知模型/网络问题并修复，不拿低准确度结果继续工作
- 单 family 风险换国内速度 + reasoning + 中文质量，对 alfadb 主用场景是合理 trade-off
- **任何用户/任何环境随时可通过 settings 切异构**（D4）

### D4. 全部模型可配（settings schema）

```jsonc
{
  "memory": {
    "search": {
      "stage1Model": "deepseek/deepseek-v4-flash",
      "stage1Limit": 50,
      "stage2Model": "deepseek/deepseek-v4-pro",
      "stage2Limit": 10
    }
  }
}
```

切异构 example：`stage2Model: "anthropic/claude-opus-4-7"` 或 `"openai/gpt-5.5"`。

### D5. 失败模式：hard error，且没有 grep 降级路径

理由：用户明确诉求是"准确"。grep fallback 会让"准确"约束变成时灵时不灵——LLM 不可用时主会话拿到的结果突然变弱，用户无感知。hard error + 工具描述里说明"依赖 LLM"，让用户在网络/服务异常时立即看到错误信号并修复模型/网络/配置。**不提供 `MEMORY_SEARCH_GREP_ONLY`、`fallbackToGrep` 或空模型退回 grep 的开关。**

graceful degradation 原则（memory-architecture.md §3 第 8 条）**显式让位于准确度**——这是设计选择，不是 bug。

### D6. 不缓存

同 5 分钟内重复 query 不复用前次结果。理由：sediment 高频写入，cache 反而误（刚写入的 entry 不在 cache 里）。每次重读 `_index.md`（~30k token I/O，ms 级）。

## 后果

### 正面

- ✅ **中英混合检索**：LLM 双语原生理解，"沉淀" ≡ "sediment"
- ✅ **同义改述召回**：跨 entry 推理识别"实质同一洞察"（彻底解决 D6 自重复——见 D7）
- ✅ **trigger_phrases / timeline 自动入参**：enhanced `_index.md` + stage 2 完整 entry 都包含
- ✅ **接口不变**：所有 memory_search caller 零改动
- ✅ **可配置 + 默认合理**：默认 ds 家族符合 alfadb 主用场景；任何环境可切异构

### 负面（已接受）

- 🟡 **延迟 +15-20s/call**：alfadb 明示"不考虑"；Stage 2 不跳过
- 🟡 **成本 ~$0.045/call**：alfadb 明示"不考虑"；1000 次 ≈ $45
- 🟡 **graceful degradation 不变量打破**：LLM 不可用时 hard error，不提供 grep 降级
- 🟡 **单 family 失败**：deepseek 挂同时影响 sediment extractor + search；可通过 settings 异构化规避

### D7. 副作用：彻底解决 sediment dedupe D6 自重复

ADR 0010 设计的 lookup-tools loop 由此真正落地：sediment writer 在 dedupe 阶段调一次 `memory_search("语义近邻 of <new entry compiled_truth>")`，LLM 返回"已有 entry X、Y、Z 是同一意思"。dedupe 从字面 trigram 跃迁到语义层——这是质量复审 D6 的根本解，不是修补 dedupe substrate 能达到的层级。

## 实施路线

详见 [migration/memory-search-llm-upgrade.md](../migration/memory-search-llm-upgrade.md)：

- **Phase 0**：增强 `_index.md` 格式（已实现）
- **Phase 1**：实现 `extensions/memory/llm-search.ts` + tool 路由 + settings schema（已实现）
- **Phase 2**：sediment writer 在 dedupe 阶段调新 search（待 Phase 1 burn-in 后落地 ADR 0010）
- **Phase 3**：memory-architecture / brain-redesign-spec 全量文档对齐 + ADR 0010 状态从 deferred 升 implemented

## 与现有 ADR 的关系

- **ADR 0003**（主会话只读）：保留，新 search 仍是只读
- **ADR 0010**（sediment 单 agent + lookup tools）：本 ADR 落地其 lookup tools 内核（D7）；状态从"核心思想保留 / tools 过时"升级为"核心思想保留 / tools 实现"
- **memory-architecture.md §6.1**（read facade 契约）：搜索接口语义扩展（query 从 keyword 升级为 prompt），但 schema 不变；§3 第 8 条 graceful degradation 不变量打破，新增 D5 注释
- **brain-redesign-spec.md §4.1**（默认查询面 RRF 融合）：本 ADR 把"text score × confidence × projectBoost"的字面 ranking 替换为"LLM rerank"，但 §4.1 的 ranking surface boost 系数仍可作为 stage 1 prompt 的输入提示
