# Phase 1 migration completion record (2026-05-08)

> 本文件是 `.pensieve/` legacy → schema v1 迁移完成的里程碑记录。原 step-by-step
> apply checklist 已于 2026-05-12 随 per-file 迁移基底剥离而废止——它教读者使用的
> 命令（`/sediment migrate-one --plan/--apply --yes/--restore`、
> `/sediment migration-backups`）已经从代码中删除。
>
> 后续 per-repo 迁移走 ADR 0014 `/memory migrate --go`（✅ 2026-05-12 shipped
> via commits `cc40792` + `a819302` + `37f03a6` + `122c0b2`；spec 见
> [abrain-pensieve-migration.md](./abrain-pensieve-migration.md)）。

## 完成数据（~/.pi 父仓）

`~/.pi/.pensieve/` 所有 legacy entry 在 2026-05-08 之前的 ~14 个 LLM-driven batch
中迁移到 schema v1：

| 指标 | 迁移前 | 迁移后 |
|---|---:|---:|
| pending count | 173 | 0 |
| lint errors | 547 | 0 |
| dead links（修复 code-span fix 后） | — | 0 |
| `doctor-lite` 终态 | — | `pass` |
| migration backups | 14 个 batch 累积 | 已 prune（git 历史是 canonical undo trail） |

`migration-backups` 目录在迁移完成后清理完毕；自始至终 `.pi-astack/sediment/migration-backups/`
是 gitignored，不进入仓库历史。

## 设计层教训

- **single-file workflow 是对的，没必要 batch apply**：14 batch + git commit-per-batch
  的纪律完全够用，不必引入队列/dashboard。
- **每个 apply 走 LLM 审阅**：避免了 schema 误判，迁移期间无回滚事件。
- **backup 是过渡品**：迁移期临时安全网；git 是长期 canonical undo trail。这条
  在 2026-05-12 per-repo 迁移设计中被推到极致——per-repo 直接放弃 backup，
  改用 git working-tree clean 作为 precondition + `git checkout HEAD --` 作为
  唯一回滚路径。

## 后续不再做

- 不重新引入 per-file migration substrate（已剥离）
- 不在 per-repo migration 中加 backup 子系统（git 替代）
- 不实现 batch / queue / dashboard（per-repo 单仓一次性即可）

## 引用

- 后续 per-repo 迁移：[abrain-pensieve-migration.md](./abrain-pensieve-migration.md)
- ADR 0014「待实施」表：`workflows lane writer` (B1, ✅ shipped 2026-05-12, commit `b6a4a49`) → `一次性 per-repo 迁移` (B4, ✅ shipped 2026-05-12, commits `cc40792` + `a819302` + `37f03a6` + `122c0b2`) → `B5 writeProjectEntry cutover` (✅ shipped 2026-05-13, commit `da4bf65`) → 接下来是 Lane G `/about-me` + identity / skills / habits writer (pending)
- open-questions.md `Q1` 已 ✅ 结案
