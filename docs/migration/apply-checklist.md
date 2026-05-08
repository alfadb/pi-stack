# Memory migration apply checklist

> Scope: Phase 1 legacy `.pensieve/` → schema v1 migration. This document is intentionally conservative: it standardizes the current single-file plan/apply/restore workflow and does **not** authorize batch migration.

## Safety invariants

- `extensions/memory/` remains read-only for canonical markdown entries.
  - It may generate migration reports only under `.pensieve/.state/`.
- Canonical markdown migration writes go through `extensions/sediment/migration.ts` only.
- One apply command migrates exactly one source file.
- Every apply creates a backup under `.pensieve/.state/migration-backups/<timestamp>/...` before writing the target.
- `--restore` only restores from `.pensieve/.state/migration-backups/`.
- If a migrated target has been manually edited, restore must reject with `target_modified` and must not delete the target.
- Automatic LLM memory writing remains separate from migration apply and is not enabled by this workflow.

## End-to-end workflow

### 0. Preflight

Run from the project root that owns `.pensieve/`:

```text
/memory doctor-lite .pensieve
```

Record the current status before changing files. Warnings are acceptable for known legacy migration debt, but unexpected lint/parser errors should be inspected first.

### 1. Generate the queue

```text
/memory migrate --dry-run --report .pensieve
```

This writes:

```text
.pensieve/.state/migration-report.md
```

The report is generated state, not canonical knowledge. It should include one `Plan Command` and one `Apply Command` per migration item.

### 2. Pick one file

Choose a single row from `## Migration Items`. Do not apply multiple rows without re-running the report between applies.

Preferred order:

1. low-risk `short-term/maxims` or simple `content.md` entries;
2. entries without dead backlinks;
3. entries with short bodies before large knowledge entries.

### 3. Preview the single-file migration

Run the row's plan command:

```text
/sediment migrate-one --plan .pensieve/short-term/maxims/example.md
```

Review:

- `source_path`
- `target_path`
- `actions`
- `lintErrors` / `lintWarnings`
- `preview.frontmatter`
- `preview.compiledTruthPreview`
- `preview.timelinePreview`

Stop if:

- `lintErrors > 0`
- `target_exists: true`
- the generated `kind` / `status` / `confidence` is obviously wrong
- the body preview lost important content
- the planned target path is surprising

### 4. Apply exactly one file

Only after the preview looks correct:

```text
/sediment migrate-one --apply --yes .pensieve/short-term/maxims/example.md
```

Expected success fields:

```json
{
  "status": "applied",
  "backup_path": ".pensieve/.state/migration-backups/.../short-term/maxims/example.md",
  "restore_command": "/sediment migrate-one --restore .pensieve/.state/migration-backups/.../short-term/maxims/example.md --yes",
  "derived": {
    "graph": { "path": ".pensieve/.index/graph.json" },
    "index": { "path": ".pensieve/_index.md" }
  }
}
```

If `derived.error` is present, the canonical migration may still have completed. Run the manual rebuild commands and then `doctor-lite`:

```text
/memory rebuild --graph .pensieve
/memory rebuild --index .pensieve
/memory doctor-lite .pensieve
```

### 5. Validate after apply

```text
/memory lint .pensieve
/memory check-backlinks .pensieve
/memory doctor-lite .pensieve
```

Also inspect the migrated target with normal file review. Confirm the legacy source was removed only when the target path changed.

### 6. Refresh the queue

```text
/memory migrate --dry-run --report .pensieve
```

The migrated file should disappear from `Migration Items` or become `already schema_version v1-compatible` in skipped output.

### 7. Restore if needed

If apply was wrong and the migrated target has not been manually edited, run the returned restore command:

```text
/sediment migrate-one --restore .pensieve/.state/migration-backups/<timestamp>/short-term/maxims/example.md --yes
```

If the restore command was lost, list backups:

```text
/sediment migration-backups --limit 20
```

Use the `restore_command` from the matching item.

## Backup states

`/sediment migration-backups` reports these states:

| State | Meaning | Operator action |
|---|---|---|
| `restorable` | Source can be restored; no migrated target needs deletion | Safe to restore if desired |
| `restorable_remove_target` | Source can be restored and target still matches generated migration output | Safe to restore; target will be deleted |
| `already_restored` | Source already matches backup and migrated target is gone | No action needed |
| `target_modified` | Migrated target exists but differs from generated migration output | Manual review required; restore refuses to delete target |
| `source_exists` | Original source path exists with different content | Manual review required |
| `source_modified` | Same-path migration source differs from expected generated target | Manual review required |
| `source_missing` | Same-path migration source is missing | Manual review required |
| `invalid` | Backup path/content cannot be interpreted | Inspect backup manually |

## Do not do this yet

- Do not run shell loops that call `/sediment migrate-one --apply --yes` repeatedly.
- Do not rewrite the whole `.pensieve/` tree with a script.
- Do not delete empty legacy directories automatically.
- Do not enable automatic LLM writes as part of migration apply.
- Do not treat generated `.state/` reports or `.index/` graph snapshots as canonical memory.

## Completion criteria for Phase 1 migration burn-in

Before considering a limited batch apply command, collect evidence from repeated single-file runs:

- at least 10 successful single-file applies across different legacy layouts;
- at least 3 successful restores;
- at least 1 verified `target_modified` refusal;
- `npm run smoke:memory` passes after each code change;
- `doctor-lite` results are understood before and after each real apply;
- no manual recovery outside `--restore` was required.

## Status: Phase 1 migration completed (2026-05-08)

All legacy `.pensieve/` entries in the parent `~/.pi` repo were migrated to schema v1 over ~14 LLM-driven batches using the single-file workflow above:

- pending count: 173 → 0
- lint errors: 547 → 0
- dead links (post code-span fix): 0
- migration backups: pruned (git history is the canonical undo trail)
- final `doctor-lite` status: `pass`

Batch apply was deliberately not added. The single-file workflow + git commit-per-batch was sufficient. Backup pruning at the end of migration is the recommended cleanup step; the `migration-backups` directory is gitignored and can be removed once a clean `git status` proves all migrations are committed.

The migration tooling (`/sediment migrate-one`, `migration-backups`, restore logic) remains in place for future schema bumps but is one-shot in spirit — do not extend it (no batch mode, no queue, no dashboard).
