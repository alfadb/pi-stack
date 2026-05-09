# Migration — `.pensieve/` → `~/.abrain/projects/<id>/`

> **状态**：待实施（spec 与 playbook 已 ready）
> **依赖**：[ADR 0014](../adr/0014-abrain-as-personal-brain.md) / [brain-redesign-spec.md](../brain-redesign-spec.md)
> **前置**：[vault-bootstrap.md](vault-bootstrap.md)（vault 基础设施先就位，否则 Lane V 命令无 backend）
> **关联**：本文件解决 Round 3 复核 P0-C1（实施顺序倒置）+ P0-C2（回滚丢 delta）

## 1. 8-phase plan（替代 ADR §实施现状的"8 步"概括）

**核心原则**：read-side 先支持双源，确认 read 全链路稳定再切 write-side。任何一步失败都能停在当前 phase，不会破坏旧 `.pensieve/`。

| Phase | 动作 | 进入条件 | 离开条件 | 失败回退 |
|---|---|---|---|---|
| **P0** 准备 | 写 `vault-bootstrap.md` 完成 + master key 已生成 + age CLI 可用 | — | vault 工具链 ready | — |
| **P1** 单一入口 | 新增 `resolveActiveProject(cwd)` / `resolveBrainPaths(projectId)` 在 `extensions/_shared/runtime.ts`，所有读旧 `.pensieve` 的代码都改走它 | P0 完成 | resolver 单元测试通过 + 现有功能零回归 | revert `_shared/runtime.ts` 即可 |
| **P2** Facade dual-read | `memory_search` / `memory_get` / `memory_list` / `memory_neighbors` 同时读旧 `.pensieve` 和新 `~/.abrain/projects/<id>/`，结果合并去重 | P1 完成 | smoke：旧 .pensieve 内容仍可被找到 + 新空目录不报错 | 关闭 dual-read flag，仅读旧 |
| **P3** Dedupe / projectSlug / lint / index / git-root 全部走 resolver | 把 `extensions/sediment/{writer,dedupe}.ts` 中 grep 出的所有 hard-coded `.pensieve` 路径改走 resolver | P2 通过 | grep 整 repo 无残留 hard-coded `.pensieve`（除 migration 脚本本身） | 单文件 revert |
| **P4** Freeze write + smoke | sediment 仍写旧 `.pensieve`（writer 路径暂不变），但 read 全链路已切——跑 1-2 天观察 audit / search / dedupe 是否一致 | P3 通过 | 连续 24h 无 split-brain 报错 | 留在 P4，read-side 已稳定 |
| **P5** 持锁迁移 | 全局获取 sediment lock + 暂停 auto-write → 写 `migration_manifest.jsonl` → mv 文件 → 写 `migration_epoch` → 释放锁 | P4 稳定 | manifest 完整 + 文件 mv 完成 | rollback playbook §3 |
| **P6** Writer cutover | sediment writer 改写新路径；旧 `.pensieve` 可写为只读（chmod -w） | P5 完成 | 一次新写入落地 + audit 行 lane 字段含新值 | rollback playbook §4 |
| **P7** Symlink 兼容期 | `<cwd>/.pensieve` → `~/.abrain/projects/<id>/` 软链，让旧脚本继续 work；验证 1-2 周 | P6 完成 | 1-2 周无报错 | 删 symlink，旧脚本各自适配 |
| **P8** 清理 fallback | 删除 dual-read 代码、删 symlink、删 `.pensieve/config.yml` 兼容路径；写 `.pensieve` 进 .gitignore | P7 验证完 | 全链路只走新路径 | 重新加 dual-read（代价不大） |

**关键约束**：
- 任意 phase 失败都不破坏前一 phase 的稳定状态
- P4 之前可以**完全 revert**（git revert 即可）
- P5 之后是 forward-only（mv 操作不可逆，但有 manifest 可指导部分回退）
- P6 之后的 delta（cutover 后的新 entry）只能用 §3 rollback playbook 处理

## 2. Migration manifest 格式

P5 开始时写 `~/.abrain/.state/migration-manifest.jsonl`（gitignored）：

```jsonl
{"ts":"2026-05-10T08:00:00Z","op":"begin","abrain_root":"/home/worker/.abrain","sediment_lock":"acquired"}
{"ts":"2026-05-10T08:00:01Z","op":"mv","source":"/home/worker/.pi/.pensieve/decisions/avoid-long-argv.md","dest":"/home/worker/.abrain/projects/pi-astack/decisions/avoid-long-argv.md","sha256":"abc123...","mtime":"2026-05-09T12:34:56Z"}
{"ts":"2026-05-10T08:00:02Z","op":"mv","source":".../knowledge/dispatch-coerce-tasks.md","dest":".../projects/pi-astack/knowledge/dispatch-coerce-tasks.md","sha256":"def456...","mtime":"..."}
...
{"ts":"2026-05-10T08:05:00Z","op":"epoch","migration_epoch":"2026-05-10T08:05:00Z","files_moved":182}
{"ts":"2026-05-10T08:05:01Z","op":"end","sediment_lock":"released"}
```

P5 结束写 `~/.abrain/.state/migration-epoch`（单行 ISO timestamp），是后续 delta 识别的分界。

## 3. Rollback playbook（P5 半成品状态）

如果 P5 mv 进行到一半 crash：

```bash
# 1. 检查 manifest 最后一行是 begin / mv / epoch / end？
tail -1 ~/.abrain/.state/migration-manifest.jsonl

# 2. 若没有 epoch 行 → mv 没全部完成
#    回滚每个已完成 mv（manifest 中 op=mv 的行）
jq -r 'select(.op=="mv") | "mv \(.dest) \(.source)"' \
  ~/.abrain/.state/migration-manifest.jsonl | bash

# 3. 删除 ~/.abrain/projects/<id>/（应该已空或只剩残留目录）
rm -rf ~/.abrain/projects/<id>/

# 4. 删除 manifest（标记 P5 未完成）
rm ~/.abrain/.state/migration-manifest.jsonl

# 5. 重新获取 sediment lock 并验证旧 .pensieve 完整
ls <cwd>/.pensieve/{decisions,knowledge,maxims}
pi smoke:memory  # 旧路径下应正常工作
```

**关键**：rollback 期间 sediment auto-write 必须暂停（持有 lock）。否则 sediment 会按 P3 的 dual-read 看到的合并视图去 dedupe，可能写到正在 mv 中的目标位置。

## 4. Rollback playbook（P6 cutover 后发现 bug）

这是最难的场景：sediment 已经按新路径写了 cutover 之后的 delta（假设 N 天内 M 个新 entry）。

**前提声明**：本场景下**不保证无损 forward+backward 回滚**。两条路径任选其一：

### 选项 A — Forward fix（推荐）

修 bug 不回滚。新路径已经是 source of truth，任何回退都会丢 delta。

### 选项 B — 强制回滚（接受 delta 风险）

```bash
# 1. 全局获取 sediment lock + 暂停 auto-write
flock ~/.abrain/.git/.sediment-lock --nonblock || exit 1
touch ~/.abrain/.state/auto-write-paused

# 2. 找出 delta 文件（cutover 后 mtime > migration_epoch）
EPOCH=$(cat ~/.abrain/.state/migration-epoch)
find ~/.abrain/projects/<id>/ -type f -newermt "$EPOCH" \
  > /tmp/delta-files.txt

# 3. 人工 review delta（数量通常 < 50 行级别，N 天内）
cat /tmp/delta-files.txt
# 决定：保留还是丢弃？或合并到旧 .pensieve？

# 4. 选择性回迁 delta（manual git mv 到旧 .pensieve/<kind>/）
# 没有自动化命令——人工 mv，因为旧 .pensieve 可能已经 chmod -w + 路径结构略有不同

# 5. 反向 mv 主体（按 manifest 倒放）
jq -r 'select(.op=="mv") | "mv \(.dest) \(.source)"' \
  ~/.abrain/.state/migration-manifest.jsonl | tac | bash

# 6. 恢复旧 .pensieve 写权限
chmod -R u+w <cwd>/.pensieve

# 7. 还原 sediment writer 路径（git revert P6 commit）
cd ~/.pi/agent/skills/pi-astack
git revert <P6-commit-sha>

# 8. 释放 lock + 启用 auto-write
rm ~/.abrain/.state/auto-write-paused
flock -u ~/.abrain/.git/.sediment-lock

# 9. 全链路验收
pi smoke:memory && pi smoke:dispatch && pi smoke:fallback-timing && pi smoke:paths
```

**已知 trade-off**：
- delta 中如有 sediment 自动 cross-project 写入 `~/.abrain/knowledge/`，无对应 `.pensieve/` 目标——只能保留在 abrain 或丢弃
- audit log 的 timeline 会出现"P6 commit → 多条新 audit row → revert"的非线性 history
- git history 留下回退轨迹（可读但不美观）

## 5. 验收 checklist

每个 phase 离开前必须跑：

- [ ] `pi smoke:memory`（pre-existing failing 时另行处理，但至少不应新增失败）
- [ ] `pi smoke:dispatch`
- [ ] `pi smoke:fallback-timing`
- [ ] `pi smoke:paths`
- [ ] 手动 `memory_search "<已知 entry>"` 能命中
- [ ] 手动 `memory_get "<已知 slug>"` 返回完整内容
- [ ] sediment audit log 最近 24h 无 ERROR
- [ ] git status 干净（除 migration manifest）

P8 离开前**额外**跑：
- [ ] grep -r "\\.pensieve" extensions/ scripts/ 无残留（只在 migration 脚本本身保留）
- [ ] 新建一个测试项目，从空开始跑一遍 `MEMORY:` block + `/about-me` + `/secret`，验证三条 lane 都正常落地
- [ ] 老项目回灌一次 sediment（重跑历史 transcript），新写入路径正确

## 6. 时间预算

按 Phase 依赖：
- P0–P1：0.5 天（resolver 是新代码，单测好覆盖）
- P2–P3：1.5 天（dual-read 和路径替换是大量 grep + 改）
- P4：1-2 天（观察期，不消耗工时）
- P5–P6：0.5 天（mv 是机械操作）
- P7：1-2 周（symlink 兼容期，不消耗工时）
- P8：0.5 天（清理）

**纯工程**：约 3 天 + 2 周观察。和 ADR 原始估算的"1-2 周"一致——只是把不确定性显式拆成 phase。
