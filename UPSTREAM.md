# pi-astack 上游 / vendor 策略

> 原则：read-only vendor submodule + owned adaptation layer，避免长期 fork。上游变更由 LLM 阅读 diff 后和 alfadb 讨论，不用脚本机械批量决策。

## 1. 三分类

| 类别 | 含义 | 是否进入上游跟踪 |
|---|---|---|
| A 类：自有功能 | alfadb 永久 own，不向上游 PR | 否 |
| B 类：vendor 移植参考 | 上游只读引用，pi 端口在 pi-astack 内维护 | 是 |
| C 类：内部组件迁入 | 曾经独立的 alfadb 自有包/文件，现并入 pi-astack | 否 |

## 2. 当前事实

- 当前仓库有两个 read-only methodology/reference submodules：
  - `vendor/gstack/` → `https://github.com/garrytan/gstack.git`（main @ `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32`）
  - `vendor/pensieve/` → `https://github.com/kingkongshot/Pensieve.git`（main @ `8731f61b18a65f09eb0d3cd1ffbff7650ef8df48`）
- `vendor/` 是方法论参考来源，不是 runtime package surface；pi-astack 不从 vendor 目录直接加载扩展/skills。
- 当前仓库没有 `skills/`、`prompts/`、`extensions/browse/`、`defaults/` 目录。
- `extensions/gbrain/` 已废弃，不是 current component。
- pi-astack runtime config 在 `~/.pi/agent/pi-astack-settings.json`，不是官方 settings chain 下的 package-local defaults。

## 3. A 类：自有功能

| Component | Notes |
|---|---|
| `extensions/memory/` | v7+ 自有 memory facade；替代 gbrain tools。 |
| `extensions/sediment/` | LLM curator + abrain writer substrate。 |
| `extensions/abrain/` | 七区 layout、project binding、vault。 |
| `extensions/dispatch/` | ADR 0009 后的 subprocess multi-agent capability。 |
| `extensions/model-fallback/` | alfadb 自用 fallback policy。 |
| `extensions/model-curator/` | curated/raw model capability prompt。 |
| `extensions/vision/` / `extensions/imagine/` | visual tool surface。 |
| `extensions/compaction-tuner/` | context percentage compaction trigger。 |
| future `skills/memory-wand/` / prompts | 若恢复，也是 pi-astack 自有端口。 |

## 4. C 类：内部组件迁入

| Component | Origin | Current disposition |
|---|---|---|
| `extensions/dispatch/` | `alfadb/pi-dispatch` | merged; original archive/redirect。 |
| `extensions/sediment/` | `alfadb/pi-sediment` | merged; original archive/redirect。 |
| `extensions/model-curator/` | in-tree pi skill | copied into pi-astack。 |
| `extensions/model-fallback/` | old retry-stream-eof extension | renamed/evolved into A 类。 |
| `extensions/gbrain/` | old gbrain extension | deleted/obsolete; replaced by memory facade。 |
| `alfadb/pi-gstack` content | old pi-gstack archive | not currently restored into this repo; future port only if needed。 |

## 5. B 类：active vendor methodology references

These submodules are read-only reference sources. They are not runtime dependencies and should not be edited in place. Porting means copying/adapting ideas into owned pi-astack files, then recording the decision here.

| Path | Upstream | Pinned ref | Role |
|---|---|---|---|
| `vendor/gstack/` | `https://github.com/garrytan/gstack.git` | `e362b0ae2f94afdcb55e37cc4690f9ce55ee5d32` (`main`) | Claude-code/gstack methodology reference: review/QA/security skills, `ship` flow, browse ideas, specialist docs. |
| `vendor/pensieve/` | `https://github.com/kingkongshot/Pensieve.git` | `8731f61b18a65f09eb0d3cd1ffbff7650ef8df48` (`main`) | Pensieve methodology reference: memory workflows, task blueprints, legacy sediment/pipeline ideas. |

Historical gstack baseline previously recorded: `bf65487` (v1.26.0.0, 2026-05-02). Current submodule now tracks a newer pinned `main` snapshot.

## 6. Upstream update workflow（LLM 协作）

Applicable only to active B 类 vendors.

1. User asks to inspect upstream.
2. Assistant runs `git fetch` in `vendor/<name>/` and lists new commits.
3. Assistant reads each relevant diff (`git show <sha>`), classifies semantic value.
4. Assistant presents options to alfadb:
   - direct bugfix worth porting
   - feature worth discussion
   - upstream-only/no pi value
   - conflicts with pi-astack design
5. After decision, assistant edits owned adaptation layer with `edit`/`write`.
6. Commit vendor SHA bump separately from port changes.
7. Update this file with new baseline/ported paths.

This is deliberately not a Makefile/script workflow. Upstream integration needs semantic judgment, not path-list diffing.

## 7. Retired entities

| Entity | Current replacement / reason |
|---|---|
| gbrain infrastructure | markdown+git + memory facade |
| `.gbrain-source` / `.gbrain-cache` / `.gbrain-scratch` | ADR 0017 strict binding |
| `extensions/gbrain/` | `extensions/memory/` |
| `<project>/.pensieve/` as write target | `~/.abrain/projects/<id>/` |
| Pensieve runtime integration / write target | removed; `vendor/pensieve/` remains read-only methodology reference |
| `pi memory migrate` style docs | current slash command `/memory migrate` |
| `skills/`/`prompts/` gstack port maps | design-intent archive until actual files exist; `vendor/gstack/` is only reference source |

See [docs/adr/0006-component-consolidation.md](./docs/adr/0006-component-consolidation.md) for the historical consolidation decision.
