# 落盘后浮出的问题（v6.5）

落盘期间识别出的待澄清问题，按优先级排序。

---

## ✅ 已拍板

- **沉淀基础设施**: gbrain 唯一存储；项目记忆 = `pi-astack` source（federated=false），跨项目 = `default`（federated=true）
- **gbrain 部署**: alfadb 自决，pi-astack 不提供安装兜底；只要求 alfadb 提供可用连接（ADR 0007）
- **~/.pi 双重身份**: pi-astack 开发环境 + 其他项目的 pi 基础环境；source 路由按 ADR 0008
- **主会话角色**: 只读（`gbrain_search/get/query`），不写记忆，不引入 intent tool
- **Sediment 角色**: 唯一写入者；pensieve 4 象限 + gstack 字段双重哲学；单写 / 分离写 / 派生写三策略（ADR 0004）
- **Pensieve 项目**: 退场，不在 pi-astack 内（ADR 0005）
- **Multi-agent 定位**: 基础能力 `dispatch_agent` / `dispatch_agents`，主会话自由组合；原 4 strategy 降为 cookbook（ADR 0009）
- **Source 配置**: 完全跟随 gbrain 官方 resolver；`.gbrain-source` dotfile **必须 commit 进 git**（跨设备同源关键）；两份（~/.pi/.gbrain-source + pi-astack/.gbrain-source）
- **Default 污染保护**: 项目事件不得写 default（ADR 0004 § 3.3）；未注册仓 + scope=project → pending queue
- **Default 写入门槛**: confidence ≥ 7 + 3/3 全票（项目 source 仅需 ≥ 4 + 2/3）
- **临时仓逃生口**: `.gbrain-scratch` marker 跳过全部 sediment 处理
- **Offline 兜底**: **两件套**（markdown export + read fallback）；gbrain 部署不计在 pi-astack 职责范围内
- **GitHub 仓**: `git@github.com:alfadb/pi-astack.git`，公开
- **物理位置**: `~/.pi/agent/skills/pi-astack/`，作为 ~/.pi 的 git submodule
- **加载方式**: settings.json `packages: ["~/.pi/agent/skills/pi-astack"]`（local path）
- **方案落盘位置**: pi-astack 仓内（方案即代码）
- **上游关系三分类**: A 自有 / B vendor / C 内部迁入

---

## P0 — 落盘后必须立即澄清才能 finalize 方案的

### Q0. sediment vote-prompt 的具体写法

ADR 0004 要求 sediment 在 vote 时 prompt 含足够信息让模型做 4 象限判断 + confidence/source 评估 + 不写判断。具体写法未定。

**建议**：P3.2.2 手写时，参考 pensieve `references/{maxims,decisions,knowledge,short-term}.md` + gstack `learnings.jsonl` schema，设计为：
- 第一部分：输入 = agent_end 上下文
- 第二部分：判据友粘贴 4 象限进入条件 + 反义信号 + gstack 字段含义 + 5 条不写判据
- 第三部分：要求输出 JSON（如 ADR 0004 schema）

**优先级**: P0，不能拖。

### Q0b. cookbook 模板具体内容

ADR 0009 说主会话参考 `extensions/multi-agent/templates/{parallel,debate,chain,ensemble}.md` cookbook，但具体内容未写。

**建议**：P4.1.4 时参考现有 multi_dispatch 各 strategy 的实现代码与 本会话 debate 过程中踩过的址。

**优先级**: P0，不能拖。


### Q1. 公开仓敏感扫描

ADR 已选公开仓。但发现以下需要确认：

- `extensions/sediment/prompts/`（写入 rubric，主会话不可见）里是否包含个人记忆/项目敏感信息？
- gbrain markdown export 输出是否会被误 commit 到 ~/.pi 仓？（`.gbrain-cache/` 已加入 ~/.pi/.gitignore）
- 145 个 default source page 中是否有敏感概念暴露？

**需要决策**: 公开 push 之前要不要做一次 `gitleaks` + 人工 sweep？  
**推荐**: 是。P3-P5 完成后、P5 push 之前加一步"敏感扫描"。

```bash
gitleaks detect --source ~/.pi/agent/skills/pi-astack --no-git
grep -ri "TODO.*personal\|私人\|alfadb.*password\|secret" ~/.pi/agent/skills/pi-astack
```

### Q2. multi-agent 的 prompts 路径

P5.5 选了 (b)：保留 `extensions/multi-agent/prompts/`，让 `pi.prompts` 多列一个路径。

Alternatives：
- (a) 移到顶层 `prompts/multi-*.md`
- (b) 留在 `extensions/multi-agent/prompts/`（**当前方案**）
- (c) 移到 `prompts/multi-agent/multi-*.md`

**推荐**: (b)。subtree merge 进来的资源最好保持原结构，便于反向 cherry-pick。

### Q3. retry-stream-eof.ts 的注释更新

A 类自有功能。P4.3 移入时需更新文件头注释：
- 旧版可能有 `// REMOVE WHEN PR <NNN> MERGED`
- 改为：`// alfadb-owned: stream-eof retry. Not contributed upstream (see ADR 0006).`

---

## P1 — 影响实施细节但不阻塞 finalize

### Q4. gbrain import 的 link 保真验证

P1.3 的 `gbrain import` 需要验证：
- 保留 `[[link]]` 跨页面引用？
- 保留 frontmatter `status: active|superseded|draft`？
- slug 一致（pensieve file slug → gbrain page slug）？
- backlinks 是否完整？

**建议**：P1.2 triage 完后，先用 5 条 short-term 做 dry-run，验证以上 4 点再全量 import。

### Q5. 单元/集成测试

- pi-multi-agent 当前有没有自己的测试？
- pi-sediment 有没有？
- 4 pipelines 的 prompts 提取后行为如何验证？

**推荐**: 至少加一个 `npm run check`（typecheck + 基本 lint），CI 不强制但本地能跑。

### Q6. UPSTREAM.md 的端口映射怎么自动化（仅 B 类）

只有 vendor/gstack 是 B 类。

**推荐**: 写个 `scripts/check-gstack-coverage.sh`，对比 vendor/gstack/{office-hours,...,benchmark}/SKILL.md 与 skills/{...}/SKILL.md 是否一一对应。mismatch 报错。

### Q7. sediment 投票分歧的 pending queue

ADR 0004 提到"投票分歧 → fail closed → pending queue"。pending queue 的 review UX 需要设计：
- 命令是 `pi memory pending list` 还是其他？
- review 后的 promote 怎么触发？是把 pending entry 转 force-write，还是让 sediment 重新投票？
- pending queue 持久化在哪里？（建议 `~/.pi/.gbrain-cache/sediment-pending.jsonl`）

**推荐**: P3 实施时先用最简版（jsonl 文件 + 手工 cat），UX 随真实使用补齐。

---

## P2 — 远期问题

### Q8. 跨设备同步策略

ADR 0007 已声明"跨设备同步不在本 ADR 决定（YAGNI）"。

预留方案：
- (a) postgres dump/restore via cron
- (b) 多设备共用一个云端 gbrain 实例
- (c) git annex 同步 ~/.pi/.gbrain-cache/postgres-data

**推荐**: 当前 alfadb 单设备使用为主，等真实多设备需求出现再写 ADR 0008。

### Q9. sediment 写入纪律的长期保证

ADR 0004 要求 alfadb 头两月每周抽查 sediment 写入分布（防止 LLM 熵漂移把所有 page 都打成 page_type=concept + tag=is）。

**推荐**: 加一个 `pi memory audit` skill（A 类自有），定期跑：
- 各 source 的 page_type 分布
- tags 中 must/want/is/how 的比例
- status=draft 的滞留时长
- 派生写的 frontmatter 字段对侧完整性

**优先级**: P1（影响 v6.5 长期健康度，但不阻塞 land）。

### Q10. multi-agent 子代理使用 vision/imagine 的隔离

`vision` 和 `imagine` 通过 sub2api 调用 OpenAI，有 API key 暴露风险。子代理通过 `Task.tools = "vision,readonly"` 委托时是否会泄漏 key？

**建议**: P4.1 subtree merge 后审查 pi-multi-agent 的 sub2api 实现，确认 key 不进入子代理 prompt。如果有风险，加 ADR 0008 规范子代理 tool 委托的 key 隔离。

---

## 推荐处理顺序

1. **P1 阶段处理**: Q4（link 保真验证）— dry-run 5 条 short-term
2. **P3 阶段处理**: Q7（pending queue UX）— 最简版先
3. **P4 阶段处理**: Q3（retry-stream-eof 注释）+ Q10（vision/imagine 隔离审查）
4. **P5 阶段处理**: Q1（敏感扫描）+ Q2（multi-prompts 路径）+ Q5（测试）
5. **P5+ 永续**: Q9（sediment 写入纪律审计）
6. **远期**: Q6（UPSTREAM 自动化）+ Q8（跨设备同步）
