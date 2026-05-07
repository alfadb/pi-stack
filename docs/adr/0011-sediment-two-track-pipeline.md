# ADR 0011 — sediment 双轨沉淀（项目级 + 世界级）

- **状态**: **Superseded by ADR 0012**（2026-05-06）— 本 ADR 假设 gbrain `sources` 可用于写入 + 检索隔离，但 v0.27 实验发现 put/sync/searchKeyword/searchVector/listPages 都不传也不过滤 source_id。双轨架构被同日退回 pensieve+gbrain 双 target 架构。
- **日期**: 2026-05-06
- **决策者**: alfadb
- **替代关系**: 在 ADR 0010（v6.6 单 agent）基础上扩展，不否定其单 agent + lookup tools 内核
- **依赖**: ADR 0002（gbrain 唯一记忆）/ ADR 0008（双重身份路由 + .gbrain-source dotfile）/ ADR 0010（单 agent + lookup tools + markdown 终结符）

## 背景

ADR 0010 把 v6.5 的三模型投票替换为单 agent + lookup tools，已经端到端跑通。但实测发现 **prompt 与 source 严重脱节**：

- 系统 prompt 明确说"only persist UNIVERSAL cross-project principles, do NOT store project-specific paths/modules"
- 实际 `gbrainPut("pi-astack", page)` 把所有结果写到了 `pi-astack` source

更严重的：**`pi-astack` source 根本没注册**，gbrain 把无效 `--source pi-astack` 默默忽略，全部写到了 default。`gbrain sources list` 显示只有 default 一个 source 存在，183 页全部混在一起。

后果：
1. **项目级洞察从未沉淀**——模型按 prompt 要求 SKIP 所有项目特定内容，pi-astack 内的真实 fact / decision 完全丢失
2. **default 库被污染**——已经写进去的 page 里混杂了 `parseAgentEndMessages skips assistant messages` 这种 pi-astack 内部细节，未来任何项目都会拉到这种噪音
3. **ADR 0008 设计未落地**——双重身份路由的 `.gbrain-source` dotfile 理念有了，但 sediment 写入路径没有用上

## 决策

**双轨并行沉淀**（继承自老 pi-sediment 的 pensieve+gbrain 双 target 范式，pensieve 退场后变为双 source）：

```
agent_end (sync capture) → setTimeout(0) defer
  ↓
ctx.sessionManager.getBranch() → 完整 1700+ entries
  ↓
Promise.allSettled([
  ┌─ project-track agent ─────────────────────────┐
  │  source: <auto-resolved from cwd>             │
  │  prompt: "记录这个项目内有用的 fact / decision" │
  │  checkpoint: sediment-checkpoint-project.json │
  │  output: SKIP / SKIP_DUPLICATE / ## GBRAIN    │
  └───────────────────────────────────────────────┘,
  ┌─ world-track agent ───────────────────────────┐
  │  source: default (federation=true)            │
  │  prompt: "记录跨项目的 engineering principle"  │
  │  checkpoint: sediment-checkpoint-world.json   │
  │  output: SKIP / SKIP_DUPLICATE / ## GBRAIN    │
  └───────────────────────────────────────────────┘
])
  ↓
两路结果各自写入对应 source（可同时写、同时 SKIP，或一写一 SKIP）
```

### 关键设计点

#### 1. 两路独立而非一个模型判 scope

老的"单 agent 同时判 scope=project|cross-project 然后路由"方案被否决：单模型同时承担"是否值得沉淀 + 这是项目级还是世界级"两个判断，scope 漂移率高（v6.5 voter 实测）。

**双轨设计让判据职责单一**：project-track 不问"这够 cross-project 吗"，world-track 不问"这是 pi-astack 内部细节吗"，各自只关心自己 lane 是否值得记录。同一个 window 在两路模型眼里看出**两层洞察**——同一个 debugging 经历可以同时产出"pi-astack 里 entry 4 跑得最久"（project fact）和"agent_end 处理器必须 defer async"（world principle）。

#### 2. project-track 的 source 自动解析 + 自动注册

source id 解析优先级：

1. **`.gbrain-source` dotfile**（从 cwd 向上 walk 到 git root 或 `$HOME` 之前）—— ADR 0008 已设计
2. **`git -C <cwd> config --get remote.origin.url` 推断 slug** —— `git@github.com:alfadb/pi-astack.git → pi-astack`
3. **拒绝**（不 fallback 到目录名，避免 `~/work/foo` 与 `~/play/foo` 撞名）

不存在 = project-track **整轮 SKIP**（world-track 仍跑）。

**首次写入未注册 source 时自动注册**：
```typescript
ensureSourceRegistered({
  id: resolved.id,
  rootPath: resolved.rootPath,
})
// → 不存在则 gbrain sources add <id> --path <rootPath> --no-federated
// → 存在则 noop
```

federation=false 是项目级 source 的硬约束——项目 fact 永远不进入跨项目检索默认结果集。

#### 3. 自动注册的可观测性

- 每次自动注册写一条 audit log：`{"type":"source:auto_registered","sourceId":...,"rootPath":...,"via":"dotfile|git_remote"}`
- 状态栏一次性 toast：`📌 auto-registered source 'foo' → /path`（5s 自动消失）
- 不阻塞、不需要用户确认（用户已经通过 `.gbrain-source` 或 git remote 隐式表达了 source 归属）

#### 4. 两路 checkpoint 完全独立

文件分离：
- `~/.pi/.gbrain-cache/sediment-checkpoint-project.json`
- `~/.pi/.gbrain-cache/sediment-checkpoint-world.json`

两路推进速度可以不同——project-track 因 `skipped_no_source` 而停滞时，world-track 仍正常推进，反之亦然。

#### 5. 两路独立可配置（Q1 决策）

```json
{
  "piStack": {
    "sediment": {
      "tracks": {
        "project": {
          "enabled": true,
          "model": "deepseek/deepseek-v4-pro",
          "reasoning": "high"
        },
        "world": {
          "enabled": true,
          "model": "anthropic/claude-opus-4-7",
          "reasoning": "xhigh"
        }
      }
    }
  }
}
```

env-var 也分开：
- `PI_STACK_SEDIMENT_MODEL`（两轨都覆盖，临时调试）
- `PI_STACK_SEDIMENT_PROJECT_MODEL`（仅项目轨）
- `PI_STACK_SEDIMENT_WORLD_MODEL`（仅世界轨）

#### 6. 两路 prompt 分离

`tracks.ts` 导出 `PROJECT_TRACK_PROMPT` 和 `WORLD_TRACK_PROMPT`，两个 rubric 措辞针对各自 lane：

- **project-track**: "Project specifics (file paths, module names, commit shas) ARE WELCOME — that's the point"
- **world-track**: "NO file paths, module names, or project specifics — those belong in the project-track"

两个 prompt 互相暗示对方存在，让模型放心把不属于自己 lane 的内容 SKIP（知道另一路会接住）。

## 影响

### 模块变更

新增（pi-astack/extensions/sediment/）：
- `tracks.ts` (~250 lines) — TrackConfig 接口 + PROJECT/WORLD prompts + buildSystemPrompt
- `source-resolver.ts` (~150 lines) — dotfile walk-up + git remote slug
- `source-registry.ts` (~110 lines) — gbrain sources list/add 包装 + ensureSourceRegistered

改动：
- `gbrain-agent.ts` — runGbrainAgent 接受 TrackConfig；删除单 GBRAIN_AGENT_PROMPT
- `config.ts` — `tracks: { project, world }` 两路独立配置；singleAgent 作为 baseline 保留
- `checkpoint.ts` — 所有函数加 `track` 参数；checkpoint 文件按 track 分离
- `index.ts` — 重写为 `Promise.allSettled([projectTrack, worldTrack])`；track:end 事件；source toast

### 配置文件

`defaults/pi-astack.defaults.json` 新加 `piStack.sediment.tracks.{project,world}` 块。`singleAgent` 保留作 baseline 文档但已不再被代码读取（除非用户故意只配 singleAgent，作 backward compat 用）。

### 写入边界

| 场景 | project-track | world-track |
|---|---|---|
| 在 pi-astack 仓内 | 写到 `pi-astack` source | 写到 `default` |
| 在有 `.gbrain-source` 的其他仓 | 写到 dotfile 指定 source | 写到 `default` |
| 在仅有 git remote 的仓 | 自动注册 + 写到 slug source | 写到 `default` |
| 在 `/tmp/scratch/` 无 git 无 dotfile | **SKIP**（不 fallback） | 写到 `default` |
| `.gbrain-scratch` marker 存在 | 整轮 sediment SKIP | 整轮 sediment SKIP |

### 已有 default 库的污染如何处理

不强制清理。已写进 default 的 pi-astack-内部 page 留作历史档案——未来这些 page 在 SKIP_DUPLICATE 或 update 时仍可被引用。**新一轮 sediment 跑起来后**，pi-astack 内的项目细节会写到 `pi-astack` source（自动注册），不再继续污染 default。

如果 alfadb 后续想清理，可以用：
```bash
gbrain sources remove default --dry-run  # 不能删 default
# 改为人工 list + delete 单个 page
gbrain delete <slug>
```

## 替代方案（被否决）

- **单 agent 输出 scope 字段，路由器读字段写对应 source**：单模型判 scope 漂移率高，已在 v6.5 voter 实测。
- **两路串行（项目级先跑，世界级看项目级输出再抽象）**：延迟翻倍，前一路失败阻塞后路。并行更简单。
- **保留单 source（坍缩双层）**：会让项目级洞察永久 SKIP，浪费 sediment 50% 的潜在价值。
- **不自动注册，要求用户手动 `gbrain sources add`**：UX 太重，违反"sediment 是后台 sidecar，对用户透明"的 ADR 0001 原则。

## 后续

- [ ] 实测 7-14 天观察两路写入量、SKIP 率、auto-register 触发频率
- [ ] 评估是否需要"派生写"（同 window 同时产出 project page 和 world page，frontmatter 互相 derives_from / derives_to 引用）
- [ ] cold-start 检测（`gbrain doctor` page count）按 source 而非全局
- [ ] commands.ts 加 `/memory-tracks` 显示两轨当前 checkpoint + 上次写入
- [ ] 考虑 source 自动取消注册机制（删除空 source）
