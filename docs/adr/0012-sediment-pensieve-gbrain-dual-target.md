# ADR 0012: sediment reverts to pensieve+gbrain dual-target after gbrain multi-source isolation proves unimplemented

- **Status:** **Superseded by [memory-architecture.md](../memory-architecture.md)**（2026-05-07）— 本 ADR 的 pensieve+gbrain 双 target 被 memory-architecture.md 整体取代。新架构转向纯 markdown+git：项目级走 `<project>/.pensieve/`（md+git），世界级走 `~/.abrain/`（独立 git repo）。gbrain 被完全去除（memory-architecture.md 决策 2）。
- **Date:** 2026-05-06 (accepted), 2026-05-07 (superseded)
- **Supersedes:** ADR 0005 (pensieve-deprecated), ADR 0011 (two-track via gbrain sources)
- **Superseded by:** [memory-architecture.md](../memory-architecture.md) § 2 决策 2 + 附录 B.2
- **Implements:** the proven dual-target sediment architecture from
  garrytan/pi-sediment, lifted verbatim into pi-astack/extensions/sediment/
- **Related:** ADR 0002 (gbrain as sole memory store — REVISED), ADR 0010
  (single-agent with lookup tools — RETAINED), ADR 0008 (pi dotfiles dual-role
  — partially retired: `.gbrain-source` no longer needed in v6.8)

## Context

ADR 0011 (v6.7) proposed a two-track sediment pipeline that wrote
**project-specific** insights into a `pi-astack` gbrain source and
**cross-project** insights into the `default` source, using gbrain's
multi-source feature for clean isolation.

End-to-end testing exposed that gbrain v0.27 (current upstream master) does
**not implement multi-source write or search isolation**. The schema has the
hooks, the CLI accepts `sources add/list/remove`, and `gbrain sources list`
correctly reports per-source page counts via `COUNT(*) WHERE source_id = $1`
— but the actual write and read paths are wired to source `'default'` only:

### Write path

1. `put_page` operation params (`src/core/operations.ts`) declare only
   `slug` + `content`. There is **no `source` parameter**.
2. `importFromContent` (`src/core/import-file.ts`) receives no sourceId.
3. `putPage` SQL (`src/core/postgres-engine.ts:291`) inserts pages without
   any `source_id` column reference, relying on the schema `DEFAULT 'default'`.
4. The `sync` command threads `sourceId` through `SyncOpts`, but **does NOT
   pass it to `importFile`** at lines 510 and 538 — so even sync writes land
   under `'default'`.
5. The `--source` CLI flag and `GBRAIN_SOURCE` env var are honored ONLY by
   `resolveSourceId`, which is called by `sync` — never by `put`.

### Search/read path

1. `searchKeyword` (`postgres-engine.ts:386`) builds its SQL with no `source_id`
   filter clause.
2. `searchVector` (`postgres-engine.ts:571`) — same: no source filter.
3. `listPages` (`postgres-engine.ts:listPages`) — same.
4. `hybridSearch` (`src/core/search/hybrid.ts`) builds `searchOpts` from its
   input but never propagates `sourceId` into the per-engine search calls.
5. **`SearchOpts.sourceId`** is declared in `core/types.ts:186` but is dead
   code in the markdown search path. Only `getCallersOf` / `getCalleesOf`
   (code-edge graph queries) actually filter by source.

### Net result

Every `gbrain put` writes to `'default'`. Every `gbrain search` / `query` /
`list` returns results from all sources globally. "Multi-source" is schema
scaffolding, not a working feature.

This invalidates ADR 0011's premise. There is no clean way for sediment to
isolate project-level writes inside gbrain today, and a hack (post-write
`UPDATE pages SET source_id` plus mirroring chunks/embeddings/tags filters)
would amount to writing our own multi-source layer on top of gbrain — that's
the upstream's job.

ADR 0005 also fails its own premise: it deprecated pensieve on the assumption
gbrain could fully take over project-level memory. With gbrain stuck on
single-source, that assumption is gone.

## Decision

**Revive the proven dual-target sediment architecture from
garrytan/pi-sediment**, lifted verbatim into `pi-astack/extensions/sediment/`:

1. **pensieve target** writes to project-local
   `.pensieve/short-term/{maxims,decisions,knowledge}/`. This is filesystem
   I/O — no source isolation problem because there's nothing to share.

2. **gbrain target** writes to gbrain's `default` source. Used exclusively for
   universal cross-project engineering principles. Federated: yes (current
   gbrain default behavior is correct for this content).

3. **Each target keeps its own coalescing checkpoint scheduler**
   (`scheduler.ts`), independent retry classification (retryable / permanent /
   processed), per-target prompts, and per-target model config.

4. **No more `.gbrain-source` dotfile, no source-resolver, no auto-register,
   no `pi-astack` gbrain source.** Removed as dead infrastructure under v6.7.

5. **Future migration path** (when gbrain ships working multi-source):
   - `gbrain sources add pi-astack --path ~/.pi --no-federated`
   - `gbrain import .pensieve/maxims/ .pensieve/decisions/ .pensieve/knowledge/
     --source pi-astack`
   - flip sediment's `pensieve` target to a `pi-astack-source` target
   This goes via the upstream's intended import path — not a hack.

## Architecture inheritance

The lift-and-shift brings in 12 production-tested files from
`~/.pi/agent/skills/pi-sediment/extensions/pi-sediment/`:

| File | Purpose |
|---|---|
| `index.ts` | extension entry; per-target scheduler registration; phase listener |
| `scheduler.ts` | coalescing per-target checkpoint scheduler with retry classification |
| `detector.ts` | auto-detect `.pensieve/` dir + `gbrain doctor` health |
| `agent-loop.ts` | multi-turn LLM-with-tools wrapper |
| `gbrain-agent.ts` | gbrain markdown protocol (SKIP/SKIP_DUPLICATE/## GBRAIN) |
| `pensieve-writer.ts` | pensieve markdown protocol (SKIP/SKIP_DUPLICATE/## PENSIEVE) |
| `lookup-tools.ts` | gbrain_search/get + pensieve_grep/read/list (read-only) |
| `prompts.ts` | injection sanitizer (position-aware) + GBRAIN_AGENT_PROMPT |
| `targets/gbrain.ts` | gbrain CLI write + retry + non-Latin pre-translate guard |
| `config.ts` | model/reasoning config (env > project > default) |
| `types.ts` | shared types |
| `utils.ts` | sanitizeSlug, gbrainCommand, logLine (atomic + rotation), saveParseFailure |

**No new code is being designed for v6.8.** This is recognition that the
proven implementation already exists; v6.5 → v6.6 → v6.7 was an
unnecessary detour.

## Per-target characteristics

### pensieve target
- **Storage:** `<projectRoot>/.pensieve/short-term/{kind}/{slug}.md`
- **Triggers on:** `.pensieve/` directory exists
- **Worker:** `writePensieve(message, projectRoot, registry)`
- **Output kinds:** `maxim` | `decision` | `knowledge`
- **Subagent:** model picks slug, can update existing entries by emitting
  `mode: update update_path:`, default to SKIP_DUPLICATE when entry exists
- **Promotion to long-term:** done via `/skill:pensieve refine` (manual,
  user-driven) — sediment only writes to `short-term/`

### gbrain target
- **Storage:** gbrain `default` source (federated)
- **Triggers on:** `gbrain doctor --json` exits 0
- **Worker:** `runGbrainAgent` → `writeToGbrainWithRetry`
- **Output:** present-tense imperative principle pages with Timeline section
- **Slug strategy:** new pages derive slug from title; updates pass
  `update_slug: <existing>` to overwrite (gbrain `put` is upsert)
- **Cold-start mode:** when gbrain has < 10 pages, lower the bar for NEW
  decisions
- **Non-Latin guard:** translate to English before write; block if
  translation fails (gbrain English-only)

## Discarded (v6.7 archive at `extensions/sediment/.v6.7-archive/`)

- `tracks.ts` — TrackConfig + project/world prompts
- `source-resolver.ts` — dotfile walk-up + git remote slug
- `source-registry.ts` — gbrain sources list/add wrapper
- `checkpoint.ts` — split track checkpoints
- `entry-text.ts` — entry serialization (now lives in scheduler.ts)
- `gbrain-writer.ts` — pre-rewrite gbrain put via env vars
- `audit-logger.ts` — session_start audit log
- `pending-queue.ts` — sediment-pending.jsonl
- `secret-scanner.ts` — pre-LLM secret scan (planned but not in proven set)
- `commands.ts` — `/memory-pending` etc. slash commands

These all stay in `.v6.7-archive/` as forensic record. **Re-introduce
selectively only if the v6.8 dual-target shows a concrete gap** — don't
preemptively re-add complexity.

The earlier `.v6.5-archive/` (voter, classifier, marker-scanner,
context-budget) stays for the same reason.

## Files retained from v6.7

- `pi-astack/extensions/multi-agent/` — unaffected by this ADR
- `pi-astack/extensions/gbrain/` — read-only gbrain integration for main
  session; unaffected
- `agent/extensions/retry-stream-eof.ts` — unaffected

## Migration steps

1. Delete v6.7 sediment files; copy old `pi-sediment/extensions/pi-sediment/*`
   into `pi-astack/extensions/sediment/` (DONE 2026-05-06)
2. Clean dirty pages from gbrain `default` source: keep universal principles,
   delete retired internals, move project-architecture page to `.pensieve/`
   (DONE 2026-05-06)
3. Remove `.gbrain-source` dotfiles + drop `pi-astack` gbrain source (DONE)
4. Update `defaults/pi-astack.defaults.json` to remove track/source config,
   restore single dual-target structure
5. Update settings.json to remove `pensieve-context` confusion (still active)
6. Update `docs/memory-architecture.md`, `docs/directory-layout.md`,
   `docs/migration/steps.md`, `README.md`
7. Update ADR 0002 and ADR 0005 with `Superseded by ADR 0012` headers

## Backout plan

Re-running v6.7 means restoring the `.v6.7-archive/` files. State files
(`.pi-sediment/state.json`) are compatible — old scheduler reads disk format
that v6.7 didn't use, so a backout is clean.

## Status check after this ADR

- [x] Files copied
- [x] Dirty pages cleaned in default
- [x] Dotfiles removed
- [x] pi-astack source removed
- [ ] defaults/pi-astack.defaults.json updated
- [ ] settings.json reviewed (defaults model already covered by config.ts)
- [ ] memory-architecture / directory-layout / migration / README updated
- [ ] ADR 0002 / 0005 / 0011 marked superseded
- [ ] First end-to-end agent_end produces .pensieve/short-term/ + gbrain default writes

## Decision rationale (Linus)

Stop forcing layered architecture onto a system whose lower layer doesn't
exist. The proven model is filesystem + remote-brain dual-write — that's
been running for months without incident. Three rounds of "we can do
multi-source isolation in gbrain" produced three rounds of architectural
debt because the foundation isn't ready. Build on what works. Migrate to
multi-source the day gbrain actually ships it — via `gbrain import`, not
via SQL hacks.
