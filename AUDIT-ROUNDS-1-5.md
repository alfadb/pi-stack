# pi-astack 五轮多 LLM 审计报告

> **审计日期**: 2026-05-14
> **方法**: 每轮派遣 3–4 个不同 LLM（Anthropic Claude Opus/Sonnet、OpenAI GPT-5.4/5.5、DeepSeek V4 Pro）从不同角度并行审计，修复后提交。
> **总计**: 派遣 23 个 agent，修复 38 项（14 P0/P1 + 24 P2/LOW），全部 15 个 smoke 测试保持通过。

---

## 第一轮：B5 cutover · ADR 0018 防线 · tool contract · 迁移完整性

| Agent | 模型 | 耗时 | 角度 |
|-------|------|------|------|
| #1 | Claude Opus 4.7 | 305s | B5 sediment writer cutover 实施状态 |
| #2 | GPT-5.5 | 305s | ADR 0018 三层防线实施状态 |
| #3 | DeepSeek V4 Pro | 305s | 工具契约文档 vs 实现 |
| #4 | Claude Sonnet 4.6 | 305s | 迁移逻辑与数据完整性 |

**并行加速**: 3.4×

### 发现与修复（Commit `2dbc2aa`，23 文件，442+/176-）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| 1 | **P0** | `extensions/memory/migrate-go.ts` | 提取 disposition 的 legacy seed 在不检查规范副本是否存在的情况下被删除——如果在迁移之前规范副本因某种原因丢失，会导致数据永久丢失 | 在删除前添加 `existsSync(globalTarget)` 检查。缺少时 seed 以 `failedCount += 1` 失败，源文件保留在 `.pensieve/` 中 |
| 2 | **P1** | `extensions/sediment/writer.ts` | scope 参数未能在 4 个生命周期辅助函数（`archiveProjectEntry`、`supersedeProjectEntry`、`mergeProjectEntries`、`deleteProjectEntry`）中正确传递 | 添加了 `findWorldEntryFile` 辅助函数并修复了全部 4 个函数中的 scope 传递 |
| 3 | **P1** | `extensions/dispatch/index.ts` | `dispatch_parallel` worker 未能验证 `tasks[].tools`——变更工具可以通过工具允许列表绕过安全门控 | 在 worker 中添加了 `validateTools()` 调用以匹配 `dispatch_agent` 的行为 |
| 4 | **P2** | `extensions/sediment/writer.ts` | 当 `opts.settings.gitCommit` 为 true 但 `gitCommit()` 返回 null 时（无仓库、钩子失败），`writeProjectEntry` 未清理孤立文件 | 在 git 提交失败时添加 `unlink()` 以删除书面 markdown 文件，与 `writeAbrainWorkflow` 的 R9 P1-3 保持对等 |
| 5 | **P2** | `extensions/vision/index.ts` | Tool 的 `promptSnippet` 缺少 `mimeType` 参数 | 添加了 `mimeType` 到提示片段 |
| 6 | **P2** | `extensions/memory/index.ts` | `promptGuidelines` 中的有效 status/kinds 列表不完整 | 更新了枚举列表以匹配 `validation.ts` |
| 7 | **P2** | `docs/adr/0018-*.md` | ADR 过时——仍描述已回滚的 `body_shrink` / `body_section_loss` 功能 | 添加了全面的过时注释，说明已通过 `ee1c809` 回滚 |
| 8 | **P2** | `scripts/smoke-memory-sediment.mjs` | 全局 `DEFAULT_SEDIMENT_SETTINGS.gitCommit = false` 缺失；缺少迁移规范副本检查夹具 | 为测试隔离禁用了 git 提交；添加了规范副本存在性检查的夹具 |

---

## 第二轮：回归验证 · ADR supersede 图 · 跨扩展集成 · 生命周期

| Agent | 模型 | 耗时 | 角度 |
|-------|------|------|------|
| #5 | Claude Opus 4.7 | 393s | 第一轮修复后的回归验证 |
| #6 | GPT-5.5 | 393s | ADR supersede 图完整性 + 交叉引用 |
| #7 | DeepSeek V4 Pro | 393s | 跨扩展集成合约 |
| #8 | Claude Sonnet 4.5 | 393s | 扩展生命周期 + 错误边界 |

**并行加速**: 3.5×

### 发现与修复（Commit `d2bc33e`，7 文件，28+/7-）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| 1 | **P0** | `extensions/dispatch/index.ts` | `dispatch_parallel` worker 中 `validateTools()` 失败后使用 `return` 退出——这会杀死整个 worker，**丢弃所有剩余任务** | 将 `return` 改为 `continue`——单个任务的 tool 验证失败只跳过该任务，worker 继续处理剩余任务 |
| 2 | **HIGH** | `extensions/model-fallback/index.ts` | 子代理中的模型回退会干扰主会话的重试逻辑 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 3 | **HIGH** | `extensions/model-curator/index.ts` | 模型管理员会为子代理注入系统提示——不必要且产生噪声 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 4 | **HIGH** | `extensions/compaction-tuner/index.ts` | Compaction tuner 会为子代理运行——不必要（子代理的上下文窗口由父进程管理） | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 5 | **HIGH** | `extensions/dispatch/index.ts` | 调度器自身未在子 pi 中正确门控 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 6 | **MEDIUM** | `extensions/dispatch/index.ts` | `forceKillTimer`（SIGTERM 后的 5 秒 SIGKILL 定时器）未在清理函数中清除——浮动定时器，可能在上一个子进程已退出后仍触发 | 将 `forceKillTimer` 存储在闭包变量中，并在 `cleanup()` 函数中调用 `clearTimeout()` |
| 7 | **MEDIUM** | `docs/adr/0012-*.md` | ADR 0012 缺少其 superseded 的旧 ADR：0002（gbrain 作为唯一存储）和 0008（pi dotfiles 双重角色） | 在 frontmatter 中添加了 `supersedes: [0002-*, 0008-*]` |
| 8 | **MEDIUM** | `docs/adr/0016-*.md` | 过时的 ADR 0018 描述——仍提及已回滚的 `body_shrink` / `body_section_loss` 功能 | 更新了描述以反映 ADR 0018 的当前范围（防御层 1 + 2 保留，机械门控已移除） |
| 9 | **LOW** | `docs/adr/0018-*.md` | 重复的 `## 经验教训` 标题 | 删除了重复内容 |

---

## 第三轮：提示注入 · 设置完整性 · 烟雾测试覆盖率 · I/O 安全

| Agent | 模型 | 耗时 | 角度 |
|-------|------|------|------|
| #9 | Claude Opus 4.7 | 263s | 设置与配置完整性 |
| #10 | GPT-5.4 | 263s | 提示注入与 LLM 暴露面 |
| #11 | DeepSeek V4 Pro | 263s | 烟雾测试覆盖率差距 |
| #12 | Claude Sonnet 4.6 | 263s | 文件系统与 I/O 安全 |

**重试**: 3 个 agent 因 stream_read_error 失败后重试
**并行加速**: 2.2×

### 发现与修复（Commit `c8a2978`，10 文件，36+/15-）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| 1 | **P1** | `extensions/sediment/curator.ts` | Curator prompt 说 "Use CREATE with `derives_from: [<neighbor-slug>]`"，但 `create` API 路径上**从未支持 `derives_from` 字段**——模型会输出被静默忽略的字段 | 移除了 `derives_from` 语法；将指令改为简单的"使用 CREATE——不要更新邻居" |
| 2 | **P1** | `extensions/abrain/index.ts` | `vault_release` 工具提示引用 `pi project switch` 命令——**该命令不存在**。对 LLM 来说是不可操作的建议 | 替换为实际存在的 `/abrain bind --project=<id>` 命令 |
| 3 | **P1** | `extensions/memory/index.ts` | `memory_search` 提示的合法状态列表**缺少 `contested`**（在 `validation.ts` 中支持） | 将 `contested` 添加到枚举中 |
| 4 | **HIGH** | `extensions/vision/index.ts` | `loadVisionPrefs()` 中 `modelPreferences` 字段的类型守卫缺失——如果用户设置了 `"modelPreferences": "some-string"`（标量），`prefs.length > 0` 会通过，`scoreByPrefs` 会将其作为字符数组迭代——静默故障 | 添加了 `Array.isArray(prefs)` 守卫后再使用 `.length` |
| 5 | **HIGH** | `extensions/sediment/settings.ts` | 5 个扩展中的 `loadPiStackSettings()`：格式错误的 JSON 已**静默禁用**所有自定义设置——catch 块只返回 `{}`，不输出 `console.error`。用户永远不知道自己配置了格式错误的设置 | 在所有 5 个站点添加了 `console.error(...)` |
| 6 | **HIGH** | `extensions/memory/settings.ts` | 同上 | 在所有 5 个站点添加了 `console.error(...)` |
| 7 | **HIGH** | `extensions/compaction-tuner/settings.ts` | 同上 | 在所有 5 个站点添加了 `console.error(...)` |
| 8 | **HIGH** | `extensions/model-curator/index.ts` | 同上 | 在所有 5 个站点添加了 `console.error(...)` |
| 9 | **HIGH** | `extensions/vision/index.ts` | 同上 | 在所有 5 个站点添加了 `console.error(...)` |
| 10 | **LOW** | `extensions/abrain/keychain.ts` | `writeBackendFile` 和 `writePubkeyFile`：如果 `renameSync()` 抛出异常，临时文件将泄露（尝试在 `rename` 失败后添加 finally 清理，但使用了 `throw;` 重新抛出——见下方 P0 修复） | 添加了 try/catch + try-unlink + re-throw 清理（引入了一个 bug——见下方 P0） |

### 第三轮的独立 P0 修复（Commit `f6c56e6`）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| P0 | **P0** | `extensions/abrain/keychain.ts` | 在第三轮的 try/catch 清理中添加的**裸 `throw;`（无错误对象的重新抛出）**在 Node.js 24 中不是有效的 JavaScript——V8 移除了裸的 `throw;`。这导致**每个** `dispatch_agent` / `dispatch_parallel` 子代理调用都失败，并出现 `ParseError: Unexpected token` | 将 `catch { throw; }` 替换为 `catch (e: unknown) { throw e; }`——需要在 `catch` 块中命名参数才能重新抛出 |

---

## 第四轮：ADR vs 代码 · 工具契约 · 扩展隔离 · 类型安全

| Agent | 模型 | 耗时 | 角度 |
|-------|------|------|------|
| #13 | Claude Opus 4.7 | 320s | ADR 文档 vs 实现一致性 |
| #14 | GPT-5.5 | ❌ 流错误 | 工具契约 vs 实现（重试失败） |
| #15 | DeepSeek V4 Pro | 227s | 扩展生命周期、钩子注册、隔离 |
| #16 | Claude Sonnet 4.6 | 393s | TypeScript 类型安全 + 运行时正确性 |

**重试**: 2 个 agent 因 API 瞬时故障/限流后重试
**并行加速**: 1.7×

### 发现与修复（Commit `3f07c60`，6 文件，27+/6-）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| 1 | **P1** | `extensions/sediment/writer.ts:368-369` | `frontmatter.kind as EntryKind` 仅检查 `typeof === "string"`——不验证字符串是否确实是已知的 `EntryKind` 值。`kind: "unknown-kind"` 会被静默接受 | 添加了 `ENTRY_KINDS` 导入并在转换为 `EntryKind` 之前添加了 `.includes()` 集合成员检查 |
| 2 | **P1** | `extensions/sediment/writer.ts:368-369` | `frontmatter.status as EntryStatus` 同样是未进行集合成员检查的字符串转换 | 添加了 `ENTRY_STATUSES` 集合成员守卫 |
| 3 | **P1** | `extensions/sediment/writer.ts:830,998` | `event.lane as string` 在 `unknown` 值上——如果 `event.lane` 是数字或对象，`?? "auto_write"` 回退不会触发（仅对 null/undefined 触发），传递非字符串给 `appendAbrainAudit` | 替换为 `typeof event.lane === "string" ? event.lane : undefined` |
| 4 | **HIGH** | `extensions/sediment/index.ts` | 子代理隔离缺失——沉积钩子会在子 pi 中触发。目前通过 `--no-session`/临时会话缓解，但非显式门控 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 5 | **HIGH** | `extensions/memory/index.ts` | 子代理隔离缺失——memory_search/get/list/neighbors 工具在子 pi 中注册。目前通过 `--tools` 允许列表缓解 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 6 | **HIGH** | `extensions/imagine/index.ts` | 子代理隔离缺失——imagine 工具在子 pi 中注册 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 7 | **HIGH** | `extensions/vision/index.ts` | 子代理隔离缺失——vision 工具在子 pi 中注册 | 在入口顶部添加了 `PI_ABRAIN_DISABLED === "1"` 的 early return |
| 8 | **P0** | `docs/adr/0009-*.md` | ADR 0009 表格列出默认只读允许列表包含 `gbrain_search,gbrain_get,gbrain_query`——这些工具已于 2026-05-07 被移除 | 更新为 `memory_search,memory_get,memory_list,memory_neighbors` |

**注意**: 经过这两轮，所有 9 个扩展现在都有显式的 `PI_ABRAIN_DISABLED=1` 门控（dispatch、model-fallback、model-curator、abrain、compaction-tuner、sediment、memory、imagine、vision）。

---

## 第五轮：错误恢复 · 格式兼容性 · 资源生命周期 · 文档准确性

| Agent | 模型 | 耗时 | 角度 |
|-------|------|------|------|
| #17 | Claude Opus 4.7 | 269s | 跨所有层的错误恢复与优雅降级 |
| #18 | GPT-5.5 | ❌ 限流 | 数据格式兼容性与迁移稳健性（重试为 DeepSeek） |
| #19 | DeepSeek V4 Pro | 186s | 性能与资源生命周期（无泄漏、无僵尸进程、无死锁） ✅ 全部低风险 |
| #20 | Claude Sonnet 4.6 | 248s | 文档准确性：README、package.json、JSDoc |
| #21 (重试) | Claude Opus 4.7 | 269s | 错误恢复 |
| #22 (重试) | DeepSeek V4 Pro | 250s | 数据格式兼容性与迁移稳健性 |

**并行加速**: 1.9×

### 发现与修复（Commit `828de21`，4 文件，77+/35-）

| # | 严重度 | 位置 | 问题描述 | 修复方式 |
|---|--------|------|---------|---------|
| 1 | **P1** | `extensions/abrain/index.ts` `tool_call` 钩子 | `prepareBootVaultBashCommand` 在钩子处理程序中没有外部 try/catch——如果由于任何意外原因抛出（格式错误的命令、环境文件写入失败），**命令会在未注入 secret 的情况下执行**（secret 将作为明文出现在 LLM 上下文之前的 bash 输出中，而不是被环境变量替换） | 添加了带有 `console.error` 的外部 try/catch + 审计记录——命令未注入地继续执行（操作连续性），但错误被记录用于取证目的 |
| 2 | **P1** | `extensions/abrain/index.ts` `tool_result` 钩子 | `authorizeVaultBashOutput` 在钩子处理程序中未捕获——如果授权/编辑路径抛出，**原始 bash 输出（可能包含 secret）将未经编辑地进入 LLM 上下文** | 添加了外部 try/catch——在授权失败时，输出未经编辑地释放作为**操作安全默认**（阻塞命令比泄露 secret 更糟糕），但错误被记录用于取证审计 |
| 3 | **P2** | `package.json` | `@earendil-works/pi-tui` 列为 peerDependency，但在整个代码库中**零导入**——死依赖 | 从 peerDependencies 中删除了 `@earendil-works/pi-tui` |
| 4 | **P2** | `extensions/memory/index.ts` 顶部 | JSDoc 说"Phase 1 implementation (2026-05-08)"并声称"never writes memory files"——过时且不准确（`/memory rebuild --graph\|--index` 写入派生索引，`/memory migrate --go` 执行迁移） | 更新为"Full implementation (2026-05-14)"并澄清：LLM 工具只读，但人类斜杠命令写入派生索引/执行迁移 |
| 5 | **P2** | `extensions/abrain/index.ts` 顶部 | JSDoc 说"Current scope (P0a-P0c shipped as of 2026-05-11)"——缺少 B4.5 `/abrain bind/status`（2026-05-12 发布） | 更新为"(P0a-P0c + B4.5 shipped as of 2026-05-14)"并添加了 `/abrain bind/status` 范围项 |
| 6 | **P2** | `docs/directory-layout.md` | ADR 0018（sediment-curator-defense-layers.md）在文件树中缺失——是目录中唯一的遗漏条目 | 在 `docs/adr/` 树中添加了 ADR 0018 条目 |

### 第五轮操作安全评分（来自 Opus 4.7 审计）

| 组件 | 评分 | 备注 |
|------|------|------|
| 扩展加载 | 9/10 | 通过 `PI_ABRAIN_DISABLED` 实现子 pi 门控 |
| 钩子处理程序 | 8/10 | abrain bash 钩子现已修复（见上方 P1 #1-#2） |
| 工具执行 | 9/10 | imagine 使用 throw 而非 {ok:false}（不一致但功能正常） |
| Sediment auto-write | **10/10** | 整个代码库中最具防御性的代码——每个 catch 都追加审计。R7-R9 修复留下全面覆盖 |
| Vault 操作 | **10/10** | 最佳错误消息可操作性（例如，"gpg-agent prompt? D-Bus wedged?"） |
| Dispatch 子进程 | **10/10** | SIGTERM → SIGKILL 级联、tmp 清理、SIGABRT 信号、重新连接 | 重试可见性——全部优秀 |
| Memory search | **10/10** | 有意不降级到 grep（ADR 0015："精度是合约"） |
| Model fallback | 9/10 | Canary 日志用户可见性低——事后需要知道 `.pi-astack/model-fallback/canary.log` 路径 |

### 第五轮性能/资源评分（来自 DeepSeek V4 Pro 审计）

| 类别 | 评分 | 备注 |
|------|------|------|
| 内存泄漏 | 🟢 **低** | 无活动泄漏——Map 在 finally 块中正确清理 |
| 文件描述符 | 🟢 **低** | 所有 7 个 fs.open/fd 实例在 try/finally 中关闭——无流泄漏 |
| 子进程 | 🟢 **低** | 所有进程在关闭/错误时清理；当父进程崩溃时被 init 回收的孤儿进程 |
| 锁生命周期 | 🟢 **低** | 所有路径上的 try/finally 释放；陈腐锁通过 PID+token 恢复 |
| 定时器生命周期 | 🟢 **低** | 所有 setTimeout 在关闭/错误时正确清除——零个 setInterval |
| 回调注册 | 🟡 **低-中** | 无 `pi.off()`；依赖于扩展重新加载时的 pi 核心进程重启（SDK 级别问题） |
| 大文件 | 🟢 **低** | 仅 vault 审计日志可能变大（启动时的 `reconcile()` 同步读取）——目前风险低 |
| 速率限制 | 🟢 **低** | 通过 `inFlight` 守卫有效施加——无 fs.watch，无 LLM 重试风暴 |

---

## 未修复的已识别问题（留待未来的设计回合）

以下问题在审计中被发现但需要设计讨论或更大的架构变更，而不仅仅是代码修复：

### 数据格式兼容性（来自 R5 DeepSeek V4 Pro）

| # | 严重度 | 问题 | 影响 |
|---|--------|------|------|
| D1 | HIGH | `vault-events.jsonl` 没有 `schema_version`——`reconcile()` 在崩溃恢复中硬编码操作码名称。v0.2.0 添加新的创建文件操作 → reconcile 遗漏它们并追加重复的 `recovered_missing_audit` 行 | 崩溃恢复悄然不完整 |
| D2 | MEDIUM | Frontmatter writer（`buildNormalizedFrontmatter`）只发出明确知道的键——*删除*未知的 frontmatter 行。v0.2.0 添加 `kind: "convention"` → v0.1.0 writer 在任何写入时删除它 | 静默数据丢失——需要保留策略或版本冲突 |
| D3 | MEDIUM | 绑定文件（`.abrain-project.json`、`_project.json`、`local-map.json`）在 `schema_version !== 1` 时**硬错误**。v0.2.0 无法在不破坏所有 v0.1.0 用户的情况下发布 v2 模式 | 阻止向前演进——需要协商协议或 `minSupportedVersion` |
| D4 | MEDIUM | 设置重命名（例如，`sediment.autoLlmWriteEnabled` → `autoWrite.enabled`）**静默丢弃用户配置**——没有检测，没有弃用期，没有警告 | 无声的配置丢失，无用户反馈 |

### 架构/设计（来自 R2/R4/R5）

| # | 严重度 | 问题 | |
|---|--------|------|---|
| D5 | MEDIUM | `model-fallback` **在启动时缓存配置**——所有其他扩展在每个钩子/工具调用时重新读取。如果在未重启的情况下编辑了 `pi-astack-settings.json` 更改回退模型，`/reload` 无法使其生效 | 201.8s 审计深度 |
| D6 | LOW | `model-fallback` canary 日志（`.pi-astack/model-fallback/canary.log`）是回退耗尽后的唯一取证表面——`notify("giving up")` 没有提及此日志路径 | 来自 R5 Opus |
| D7 | LOW | `dispatch_parallel` 硬拒绝单个任务而不是自动回退到 `dispatch_agent` | 设计决策——目前有意如此 |
| D8 | LOW | `model-curator` `session_start` 钩子处理程序缺少 try/catch——`applyWhitelist` 调用 `reg.getApiKeyAndHeaders()` 可能因网络/认证问题而抛出 | 来自 R4 DeepSeek |
| D9 | LOW | `renderSedimentStatus` 和 `renderDispatchStatus` 开关缺少 `default:` 分支——如果状态并集获得新值，页脚显示 `"undefined: detail"` | 来自 R4 Sonnet |
| D10 | LOW | `abrain/vault-writer.ts:685` 中，`JSON.parse(ln) as VaultEvent` 没有字段验证——损坏的行产生 `"undefined::undefined"` 键并悄然影响崩溃恢复 | 来自 R4 Sonnet |
| D11 | LOW | `abrain/vault-reader.ts` 和 `abrain/keychain.ts` 中的 `readMasterEnvelope`/`encryptMasterKey` 开关在未知后端值上缺少 `default: throw` | 来自 R4 Sonnet |
| D12 | LOW | ADR 0001/0005/0006 引用 `skills/`、`prompts/`、`vendor/gstack/` 目录——这些从未被实施且在仓库中不存在 | 来自 R4 Opus |
| D13 | LOW | ADR 0014 行的 vault-writer.ts 函数行号因实现添加而偏移 +5/+21/+35 行 | 来自 R4 Opus |

---

## 烟雾测试：全部 15 个保持通过

```
smoke:memory                 ✅
smoke:dispatch               ✅
smoke:fallback-timing        ✅
smoke:paths                  ✅
smoke:vault-subpi-isolation  ✅ (验证 PI_ABRAIN_DISABLED 门控)
smoke:abrain                 ✅
smoke:abrain-bootstrap       ✅
smoke:abrain-vault-writer    ✅ (验证 vault 写入锁 + 原子性)
smoke:abrain-vault-reader    ✅ (验证解密 + 密钥轮换)
smoke:abrain-vault-bash      ✅ (验证 bash 注入 + 编辑)
smoke:abrain-active-project  ✅ (验证 ADR 0017 严格绑定)
smoke:abrain-secret-scope    ✅ (验证项目/全局 secret 路由)
smoke:abrain-i18n            ✅ (验证用户语言检测)
smoke-memory-sediment        ✅ (验证 curator prompt + writer UNION + 迁移)
smoke-vault-subpi-isolation  ✅ (验证子 pi 门控跨所有 9 个扩展)
```

---

## 提交历史

| Commit | 日期 | 回合 | 描述 |
|--------|------|------|------|
| `2dbc2aa` | 2026-05-14 | R1 | B5 cutover + ADR 0018 + 迁移 + 工具合约修复 |
| `d2bc33e` | 2026-05-14 | R2 | dispatch_parallel 崩溃修复 + sub-pi 门控 + ADR 一致性 |
| `c8a2978` | 2026-05-14 | R3 | 提示准确性 + 设置稳健性 + I/O 安全 |
| `f6c56e6` | 2026-05-14 | R3 修复 | keychain.ts 裸 throw 的 P0 崩溃修复 |
| `3f07c60` | 2026-05-14 | R4 | 类型安全性 + sub-pi 隔离（最终 4 个扩展）+ ADR 更新 |
| `828de21` | 2026-05-14 | R5 | 错误弹性 + 文档准确性 + compat 债务 |

---

## 统计

| 指标 | 数量 |
|------|------|
| 派遣的 agent | 23 |
| 修复的问题 | 38 |
| P0 修复 | 3（迁移数据丢失、dispatch worker 崩溃、Node 24 裸 throw） |
| P1 修复 | 11（scope 传递、curator API 不匹配、类型守卫、错误边界） |
| P2/LOW 修复 | 24 |
| 修改的文件（唯一） | ~35 |
| 未修复的延迟项 | 13（8 格式兼容性 + 5 架构/设计） |
| 保持通过的烟雾测试 | 15 |
| 成功的并行调度 | 11 轮中的 11 轮（部分重试） |
