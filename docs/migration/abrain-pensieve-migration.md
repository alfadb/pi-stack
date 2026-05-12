# Migration — `.pensieve/` → `~/.abrain/projects/<id>/`

> **状态**：✅ B4 已 ship（2026-05-12）——`/memory migrate --go` 在 `extensions/memory/migrate-go.ts`，12 个 smoke 场景覆盖。接下来是手动逐仓迁移（§4 优先级表）。
> **依赖**：[ADR 0014](../adr/0014-abrain-as-personal-brain.md) / [brain-redesign-spec.md](../brain-redesign-spec.md)
> **前置**：[vault-bootstrap.md](vault-bootstrap.md)（vault 基础设施已 ship，P0a-P0c.read）

## 1. 模型：per-repo 一次性迁移

**单用户 14 仓场景**——比起多人多机渐进迁移，per-repo 一次性更适合。每个 `.pensieve/` 仓在用户主动触发时整体搬迁到 abrain，git 是回滚网，不做 backup，不留 symlink。

**核心原则**：

| 维度 | 决策 | 理由 |
|---|---|---|
| **粒度** | 单仓一次性（不 per-file，不全局批处理） | 14 仓挨个迁，每仓单一 commit，逆向只看那个 commit |
| **触发** | 用户在仓 cwd 内主动 `/memory migrate --go` | 不预定 migration window，不锁所有仓，按用户节奏 |
| **回滚网** | git working tree clean 作为 precondition + `git checkout HEAD --` 作为唯一逆向路径 | 13/14 仓已 git tracked，数据天然有逆向网；自定义 backup 反而与 git 重复 |
| **symlink** | 不留 | runtime resolver 在 sediment writer 内部定位新路径；symlink 是另一种 split-brain 风险源 |
| **dual-read 期** | memory facade 长期 dual-read `.pensieve/` + `~/.abrain/projects/<id>/`（已 ship） | 单仓迁完即 forward-only；其他仓未迁仍读旧路径，无需统一切换 |

## 2. precondition（`--go` 强制检查，dry-run 跳过）

执行 `/memory migrate --go` 验证：

1. **父仓 git working tree clean**（`git status --porcelain` 为空）—— dirty 时阻止，提示先 commit
2. **`.pensieve/` 内文件 tracked > 0** —— sub2api 这种 untracked 仓需要先 `git add .pensieve && git commit` 否则失去 git 回滚网
3. **`.pensieve/` 内有至少 1 个用户 entry­**（排除 `.state/`/`.index/` 下的派生文件）——避免幂等双迁时跟仓中只剩 derived 文件仍提交一个空迁移 commit
4. **`~/.abrain` working tree clean** —— 确保 abrain 一侧 mv 后能干净 commit、出问题能用 preflight 捕获的 `abrainPreSha` 精确 rollback（详 §5；不是 `HEAD~1` —— abrain 有 N+1 commits）
5. **projectId 可推断**。优先级：`--project=<id>` 显式 override > git remote origin（`github.com/alfadb/pi` → `alfadb-pi`）> 父仓 cwd 末二段拼接（`~/work/uamp/full` → `uamp-full`，避免多个 `full` 冲突）。最终 id 走 `validateAbrainProjectId`，不过则 `--go` 拒绝。

**隐藏 hard-fail（代码 sanity check，不被上述 5 项覆盖）**：preflightMigrationGo 另外还会拒绝以下场景——这些项不可能被用户 bypass，不列为独立 preflight，但调试时需要知道它们存在：

- `pensieveTarget` 路径不存在（用户输错或仓里根本没 `.pensieve/`）
- `abrainHome` 路径不存在（`~/.abrain` 从未被 `/vault init` 创建过）
- 父仓 root 不存在（`gitToplevel(parentRepoRoot)` 返回 null，表明 cwd 不在 git 仓内）
- `abrainHome` 是普通目录而非 git repo（`gitIsClean` 不能判定，后续 commit/rollback 会失败）

加上这 4 项，`/memory migrate --go` 实际运行时总共检查 9 项。spec 上面只列 5 项是因为那五项是「用户可能遇到 + 能够手工修复」的路径，这四项是 sanity guard。

dry-run（`/memory migrate` 默认 / `/memory migrate --dry-run`）仅列出 legacy entry、不检 precondition；它是护栏前的调查工具，不是迁移预览。要看 per-repo 迁移的 dry-run，要么手动检查上述 5 项，要么直接 `--go` 让它 fail-fast。

## 3. 迁移动作（`/memory migrate --go` 内部步骤）

```
1. 验证 precondition（§2）
2. 读取 .pensieve/ 所有 entry 的 frontmatter
3. frontmatter normalize（实际是 **full rewrite + selective preserve**，不是「仅补缺失 kind」）：
   - **重写的标准字段**（`buildNormalizedFrontmatter`取代原值）：
     `id` / `scope` / `kind` / `status` / `confidence` / `schema_version=1` / `title` / `created` / `updated`
   - **从原 frontmatter 保留的非标准字段**（`preservedFrontmatterLines`）：
     `tags` / `trigger` / `trigger_phrases` / `relations` / `evidence` / 其他用户自定义 key 都原样摇进新 frontmatter。
   - **kind 推断优先级**：`frontmatter.kind` > `frontmatter.type`（legacy alias） > `inferKindFromPath(relSource)`。
     - pipelines/run-when-*.md → kind: pipeline（read-only legacy alias）
     - 其他无 kind → 按目录推断（maxims/ → maxim、decisions/ → decision、staging/ → smell、其余 → fact）
   - **表字段提取隐藏行为**：confidence 缺失时走 `defaultConfidence(kind)`（不同 kind 默认不同）；created/updated 缺失时填入 migrationTimestamp（不是原文件 mtime）。这意味着迁移后原锁定的「创建时间」会被覆写为迁移日期。保留原创建时间要求在原 frontmatter 里显式写 `created: <iso>`。
   - **损坏 frontmatter 检测**：若 frontmatter 区存在但 `parseFrontmatter` 返回空对象（YAML 语法损坏），normalize 会在报告中加 `frontmatter-unparseable` note——与 `missing frontmatter`（原本就没有 frontmatter）区分，避免静默 fallback 默认值。
   - 数字注：~/.pi Phase 1 历史扫到 178 条候选；其中 5 条是 .index/.state 派生文件被 migrate-go 预过滤掉，实际计入 lint 报告与 apply-checklist 的「173 → 0 pending」是同一批用户 entry。
4. pipeline-型条目路由：
   - **唯一权威信号是 frontmatter `cross_project: true`**（文件名 `run-when-*` 不再做隐式启发——多项目可能撞名，2026-05-12 决策）
   - cross_project: true → ~/.abrain/workflows/（写 `writeAbrainWorkflow({crossProject: true})`）
   - 缺省 → ~/.abrain/projects/<id>/workflows/
   - 调用 writeAbrainWorkflow (B1 已 ship)
5. 其他 7 kind entry 物理跨仓 mv（实现走 atomic write + `git rm`）：
   .pensieve/<kind-dir>/<slug>.md → ~/.abrain/projects/<id>/<kind-dir>/<slug>.md
   - 跨仓 `git mv` 不可行（两个独立 git repo）——实际实现：
     - abrain 一侧 `atomicWrite()`（tmp + rename，防 partial）
     - 父仓一侧 `gitRmOrUnlink()`（先 `git rm`，失败 fallback `fs.unlink`）
   - 父仓 commit pathspec 限定为 `.pensieve`（不扫入并发 sediment auto-commit 的 `.pi-astack/` 改动）
   - **kind → 子目录映射**（与 `extensions/memory/migrate-go.ts` 中 `KNOWLEDGE_KIND_DIR` 严格一致）：
     | kind | 子目录 | 备注 |
     |---|---|---|
     | `maxim` | `maxims/` | 强约束 · 高权重 |
     | `decision` | `decisions/` | ADR-类深思熟虑 |
     | `anti-pattern` `pattern` `fact` `preference` | `knowledge/` | 一般知识合集 |
     | `smell` | `staging/` | 低信心待提纯 |
     | (any) status=archived | `archive/` | 已 supersede / 退役 |
6. 索引重建：
   - .pensieve/.index/graph.json 在原仓内删除（或保留作历史，gitignore）
   - ~/.abrain/projects/<id>/.index/graph.json 重建
   - ~/.abrain/projects/<id>/_index.md 重建
7. 父仓 commit："chore: migrate .pensieve → ~/.abrain/projects/<id>"
   abrain 仓 commit："migrate(in): <projectId> (N entries from <parent-repo>)"
8. sediment runtime resolver 在下一次 agent_end 自动定位到 abrain projects 路径
   （writer 路径不再硬编码 .pensieve，由 resolveBrainPaths 决定）
```

## 4. 14 仓迁移建议顺序

按风险递增、按内容价值递减——先迁低风险/低价值仓验证流程，再迁主仓：

| 优先级 | 仓 | 条目数（截至 2026-05-12） | 建议时机 |
|---|---|---:|---|
| 1 | `~/.config/opencode` | 9 | 验证用：内容少、丢了影响最小 |
| 2 | `~/work/base/cluster` | 15 | 同上 |
| 3 | `~/work/base/sub2api` | 0 (untracked) | 同上；需要先 `git add .pensieve && commit` 一次 |
| 4 | `~/work/base/proxies` | 21 | — |
| 5 | `~/work/dev-containers/{base,buildkit}` | 16, 33 | — |
| 6 | `~/work/base/happy` | 13 | — |
| 7 | `~/work/mes/nmh/docs` | 31 | — |
| 8 | `~/work/kihh/full` | 54 | — |
| 9 | `~/work/kenon/blk/full` | 16 | — |
| 10 | `~/.codex` | 42 | — |
| 11 | `~/.claude` | 85 | — |
| 12 | `~/work/uamp/full` | 194 | — |
| **最后** | **`~/.pi`** | **336** | 最主仓最后迁，前 13 仓的经验都已积累 |

每仓迁完后跑 `/memory doctor-lite ~/.abrain/projects/<id>/` 验证健康再迁下一个。

## 5. 回滚

### 单仓刚迁完想撤销

`/memory migrate --go` 输出的 summary 末尾会打印 **pre-migration SHA 锡点**的 rollback 命令，直接复制粘贴即可。例：

```bash
Rollback (if needed):
  cd ~/work/uamp/full && git reset --hard a1b2c3d4...   # parentPreSha
  cd ~/.abrain && git reset --hard e5f6g7h8...          # abrainPreSha
  # Note: abrain may have multiple commits from this migration (N workflows + 1 migrate-in).
  # The reset above targets the SHA captured before *any* of them landed.
```

**为什么不用 `HEAD~1`**：
- abrain 一侧 N 个 workflow commit + 1 个 migrate(in) commit = **N+1** 个 commit，`HEAD~1` 只能撤 1 个。
- sediment auto-commit 可能在迁移后并发落入任一侧仓，让 `HEAD~N` 指错位置。
- pre-sha 在 preflight 阶段捕获，不会被后续任何 commit 污染。

如果 summary 已丢（终端滚出去），手动找两仓迁移 commit 的父 commit：

```bash
cd <parent> && git log --oneline -5   # 找 "chore: migrate .pensieve" 上一个 commit
cd ~/.abrain && git log --oneline -10 # 找第一个 "workflow:" / "migrate(in):" 的上一个 commit
```

### 多仓迁完后发现规则错（少见）

不要试图反向迁回所有已迁仓——成本超过收益。改成 forward fix：

1. 直接在 abrain 内改 frontmatter / mv 文件到正确位置
2. abrain commit
3. 不动已迁的父仓（`.pensieve` 已经空了，符合预期）

## 6. ADR 0014 状态推进路径

```
B1: workflows lane writer (✅ shipped 2026-05-12)
  → writeAbrainWorkflow API 可用；为 /memory migrate --go 提供 pipeline routing target

B3+B7: per-file migration substrate 剥离 (✅ shipped 2026-05-12)
  → 删除 sediment/migration.ts + /sediment migrate-one + /sediment migration-backups

B4: /memory migrate --go (✅ shipped 2026-05-12)
  → extensions/memory/migrate-go.ts；preflight + frontmatter 归一化 + pipeline 路由
  → 12 个 smoke 场景覆盖（happy path / dirty preflight / 幂等 / commits）

B5: writer cutover (pending)
  → sediment writeProjectEntry 走 abrain projects 路径而非 <cwd>/.pensieve。
  → ­14 仓完成迁移后拍板。

P0d: vault wizard / mask input / .env import (pending)
  → 与 B5 独立，可并行

Lane G: /about-me + MEMORY-ABOUT-ME (pending)
其他 lane writer: skills / habits / world knowledge (pending)
```

## 7. 历史注记：废止的 8-phase 渐进方案

本文档 v1（2026-05-09）原为 8-phase 渐进迁移规划：

> P0 准备 → P1 单一入口 → P2 Facade dual-read → P3 hard-coded 清除 → P4 freeze write + smoke → P5 持锁迁移（manifest + epoch + drain assert）→ P6 writer cutover → P7 symlink 兼容期 → P8 清理 fallback

**为何废止**（2026-05-12 用户决策）：

- 8-phase 是为多人多机生产环境设计的（manifest / quiescence protocol / sub-pi 协调），单用户场景过度工程
- 14 仓数据变更不频，user 主动触发 per-repo 迁移即可，不需要 8-phase 全局协调
- backup 子系统与 git 重复（git 已是 canonical undo trail）
- symlink 兼容期是另一种 split-brain 风险源
- per-file migration 在 Phase 1 一次性完成后已剥离，其底座（`extensions/sediment/migration.ts`）2026-05-12 已删除；继续走 per-file 模式只会重新引入死代码

实际已 ship 的渐进步骤（P1 单一入口 resolver + P2 memory Facade dual-read）继续生效，但作为**长期 read-side 能力**（让 14 仓挨个迁的过程中老仓仍可读）而非 8-phase 中"准备 cutover"的临时态。
