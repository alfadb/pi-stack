# 2026-05-15 — multi-LLM doc-vs-code audit + fixes

> Live truth lives in [../current-state.md](../current-state.md) and
> [../roadmap.md](../roadmap.md). This file is a frozen snapshot of the
> 2026-05-15 audit findings and the same-day fixes; not authoritative.

## Method

4 parallel sub-agents (different providers to diversify failure modes),
each focused on one subsystem of pi-astack, given a precise list of doc
claims to verify against the live source tree. Each agent ran with
`thinking=high` and read-only tools.

| # | Subsystem | Model | Verdict |
|---|---|---|---|
| 1 | abrain + vault | `anthropic/claude-opus-4-7` | B+ — 11/13 verified, 2 doc-wording / line-number drifts |
| 2 | memory read path | `openai/gpt-5.5` | B− — found real storage-topology drift (B5 cutover not landed) |
| 3 | sediment write path | `deepseek/deepseek-v4-pro` | A — 9/9 verified, only minor prompt-cap doc lag |
| 4 | dispatch + total surface | `anthropic/claude-sonnet-4-6` | B− — roadmap invariant line-numbers 4/6 stale post-ADR-0020 |

Run footprint: 4 tasks, 482.8s wall (3.0× speedup over serial), ~$0.74 total.

## Findings (cross-cutting)

### HIGH

1. **memory store priority does NOT match docs.** `parser.ts::resolveStores`
   pushed `.pensieve/` first; dedup used `confidence`+`updated` tiebreak
   which could let a stale legacy entry shadow the abrain canonical copy.
   `current-state.md` §3 says `.pensieve/` is "legacy 只读迁移源" but the
   read priority gave it precedence.
2. **world walker fallback leaks `projects/` + `vault/`.** `listFilesWithRg`
   excludes both via `--glob`, but `walkMarkdownFiles` only excluded
   `IGNORE_DIRS={.git,.hg,.svn,node_modules,.state,.index,.cache}`. When
   `rg` was missing/timeout, world scan would walk into
   `~/.abrain/projects/**` (other-project leakage) and `~/.abrain/vault/**`
   (encrypted material exposure).
3. **roadmap "Architecture invariants" line numbers stale.** 4/6 entries
   pointed at code shifted by ~44 lines after the same-day ADR 0020
   startup-hook insertion. Specifically the `abrain/index.ts:212-249,
   1075-1101, 1145-1185` block pointed at three unrelated functions
   (`autoCommitPaths`, `runInit`, `encryptMasterKey`), not the P1 active
   project resolver.

### MID

4. **`current-state.md` §7 misleadingly describes all three legacy
   backends as "reader 仍 fail-soft 正常解锁".** Reality: `passphrase-only`
   cannot unlock because `vault-reader.ts::defaultExec` runs age with
   `stdio[0]="ignore"` (no tty pass-through), times out at 30s. ADR 0019
   + roadmap "Tier 3 legacy backends reader UX" already acknowledge the
   gap; only the §7 wording was inconsistent.

5. **ADR 0019 invariant 6 ("abrain-age-key does NOT generate
   `.vault-master.age`") held only by case-by-case discipline.**
   `runInit` unconditionally computed `vaultMasterEncryptedPath` and
   passed it into `encryptMasterKey`; the abrain-age-key case in
   `keychain.ts` simply ignored it and early-returned. Future refactors
   (e.g. unifying backends behind a shared helper) could silently leak
   a double-encrypted master.age into the abrain repo, becoming a
   confusing fallback path for vault-reader.

6. **`extensions/_shared/runtime.ts` is the actual home of the
   "Vault P1 active project resolver", but no doc named the file.**
   14 extensions import from it; the doc index always pointed at
   `abrain/index.ts` instead.

## Fixes applied (same session)

| Fix | Files | Notes |
|---|---|---|
| F1. memory store priority post-B5 | `extensions/memory/parser.ts::resolveStores`, `loadEntries`, `scanStore`, `walkMarkdownFiles` | New order `abrain-project > world > legacy-pensieve`; legacy anchored at active project root (not raw cwd); dedup first-wins UNCONDITIONAL across stores; same-store tiebreak still confidence+updated. Verified by `/tmp/verify-memory-dedup.mjs` (6 scenarios) and `smoke:memory`. |
| F2. world walker excludes `projects`/`vault` | same file, new `WORLD_EXTRA_IGNORE_DIRS` set | Walker now mirrors `rg --glob` exclusions when `rg` is unavailable. |
| F3. roadmap invariant line numbers | `docs/roadmap.md` | Switched from absolute line numbers to `file::symbol` anchors with optional "~Lxxx" hints; added 2026-05-15 line-number policy note; added new invariant row for memory store priority. |
| F4. current-state.md §7 wording | `docs/current-state.md` | Split legacy-backend reader behaviour: `ssh-key`/`gpg-file` unlock; `passphrase-only` known reader gap, will close when P0d age-key passphrase wrap lands. |
| F5. ADR 0019 inv6 post-init assert | `extensions/abrain/index.ts::runInit` | Defense-in-depth `fs.existsSync(vaultMasterEncryptedPath)` check after `encryptMasterKey` when backend is `abrain-age-key`; throws with actionable error + best-effort unlink before pubkey/backend marker files are written, so `/vault status` still reports uninitialized. |
| F6. directory-layout `_shared/` + abrain layout + smoke list | `docs/directory-layout.md` | `_shared/runtime.ts` key exports listed by name; abrain home tree now shows `.vault-identity/` (Tier 1 default) vs `.vault-master.age` (Tier 3 only); identity/skills/habits marked as Lane G placeholders; smoke list now 17 entries (added `git-sync` + `vault-identity`). |

## Verification

All 14 locally-runnable smokes pass after round 1 (F1–F7) and round 2
(F8–F10) combined:

```text
smoke:memory                              ok  (+ new fm-preserve fixture, + curator create-scope fixture)
smoke:dispatch                            ok
smoke:paths                               ok
smoke:vault-subpi-isolation               ok (5 assertions)
smoke:abrain                              ok (42 assertions)
smoke:abrain-bootstrap                    ok (21 assertions)
smoke:abrain-vault-writer                 ok (28 assertions)
smoke:abrain-vault-reader                 ok (6 assertions)
smoke:abrain-vault-bash                   ok (18 assertions)
smoke:abrain-vault-identity               ok (12 assertions; .vault-master.age NOT-written invariant verified)
smoke:abrain-git-sync                     ok
smoke:abrain-active-project               ok (22 assertions)
smoke:abrain-secret-scope                 ok (18 assertions)
smoke:abrain-i18n                         ok (11 assertions)
```

Ad-hoc verifiers (kept under /tmp for next-session reproducibility):
```text
/tmp/verify-memory-dedup.mjs              6/6 store-priority cases
/tmp/verify-kind-status-normalize.mjs    26/26 normalize cases
/tmp/verify-curator-create-scope.mjs     10/10 create-scope cases
```

External-API smokes (`vision`, `imagine`, `fallback-timing`) not run in
this session.

## Round 2 follow-ups (same session, 2026-05-15 PM)

After the round 1 fixes (F1–F7) cleared the HIGH/MID drift, three of the
original "deferred" items were tractable enough to close in the same
session:

| Fix | Files | Notes |
|---|---|---|
| F8. memory parser kind/status enum enforcement | `extensions/memory/parser.ts`, `extensions/memory/types.ts` | New `normalizeKind`/`normalizeStatus` functions fold non-canonical values to the closest canonical enum; original preserved in optional `entry.legacyKind`/`legacyStatus` for doctor diagnostics. `pipeline` → `pattern`; `knowledge` → `fact`; unknown kind → `fact`; unknown status → `provisional`. LLM-facing card now strictly matches the documented "Valid kinds/statuses" lists. Verified by `/tmp/verify-kind-status-normalize.mjs` (26 cases). |
| F9. sediment update/merge unknown-frontmatter preservation fixture | `scripts/smoke-memory-sediment.mjs` (new block ~L4276+) | 6-step round-trip fixture: seed entry, inject unknown scalar + multi-line array + 3-elem nested array, update body without frontmatterPatch, verify all unknown survive; update body WITH non-protected frontmatterPatch, verify unknown + new key both present; verify each protected key appears exactly once; verify parseEntry exposes unknown fields via `entry.frontmatter`. Closes the systematic-coverage gap roadmap had flagged. |
| F10. curator `create` scope binding | `extensions/sediment/curator.ts::parseDecision` + prompt directive + smoke fixture | Two new hard constraints on the create branch: (a) every `derives_from` slug must exist in allowedSlugs (kills hallucinated derivation chains — also closes deepseek audit [LOW]); (b) if `scope:"world"`, every `derives_from` neighbor must also be world-scope (prevents leaking project-specific context into world store). Project creates remain free to derive from world (legit specialization direction). Verified by `/tmp/verify-curator-create-scope.mjs` (10 cases) + smoke fixture (8 cases inline). |

Roadmap impact: "Curator scope binding (create branch)", "Sediment
update/merge unknown frontmatter preservation systematic coverage
missing" backlog items closed; the "Memory read-path kind/status enum
enforcement" lower-priority item from round 1's deferred list closed.

## Not fixed (deferred or out-of-scope)

- **Lane G writer (identity/skills/habits + `/about-me`)** — honestly
  absent in code (mkdir placeholders only), matches roadmap; no hidden
  half-built code found. Genuinely large scope (needs classifier +
  three writer paths + `/about-me` slash); deferred.
- **Vault P0d** (masked input, `.env` import, `/vault migrate-backend`,
  age-key passphrase wrap) — honest backlog, only error-message stubs
  reference `migrate-backend`. Blocked on (Y2/Y1) tech selection per
  roadmap.
- **Abrain auto-sync UX P0e** (TUI ahead indicator, periodic fetch,
  conflict suggestion logging) — ADR 0020 baseline shipped; UX layer
  deferred until real multi-host usage signal.

## How to re-run this audit

```bash
# From a pi session bound to this project:
# (uses dispatch_parallel; ~8 minutes wall, ~$0.75)
# See the audit prompt that produced this snapshot in the session
# transcript dated 2026-05-15.
```

Subsystem audits should be re-run after any of: new ADR landing, major
extension consolidation, or any roadmap "invariant" claim addition.
