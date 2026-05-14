#!/usr/bin/env node
// Smoke test: verify dispatch_parallel spawn enforces PI_ABRAIN_DISABLED=1
// regardless of the user's parent env. This is the runtime mechanism that
// backs ADR 0014 invariant #6 (sub-pi 默认看不到任何 vault).
//
// Strategy: don't actually spawn pi (heavy + slow). Instead read the source
// of extensions/dispatch/index.ts and verify the spawn() call includes the
// env override pattern that satisfies the three contract invariants:
//
//   (i)   spawn options has an `env` property
//   (ii)  env spreads ...process.env BEFORE PI_ABRAIN_DISABLED
//   (iii) env sets PI_ABRAIN_DISABLED to "1" (string, not number)
//
// This is structural verification — sufficient to catch the v1.2 → v1.3
// regression where docs claim env override but code path didn't have it.
//
// A future heavier smoke could spawn an actual sub-pi with parent
// PI_ABRAIN_DISABLED=0 and assert it sees "1" — left as a follow-up when the
// abrain extension itself lands.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatchPath = resolve(__dirname, "..", "extensions", "dispatch", "index.ts");

let pass = 0;
let fail = 0;
function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg) { fail++; console.log(`  ✗ ${msg}`); }

const src = readFileSync(dispatchPath, "utf8");

// Locate the spawn("pi", ...) call site
const spawnMatch = src.match(/spawn\("pi",\s*args,\s*\{[\s\S]+?\}\)/);
if (!spawnMatch) {
  bad("could not locate spawn(\"pi\", args, {...}) in dispatch/index.ts");
  process.exit(1);
}
const spawnBlock = spawnMatch[0];

// (i) env property present in spawn options
if (/\benv\s*:/.test(spawnBlock)) {
  ok("spawn options include `env` property");
} else {
  bad("spawn options missing `env` — sub-pi inherits parent env unchanged");
}

// Locate the childEnv definition (immediately precedes spawn)
const envObjMatch = src.match(/const\s+childEnv\s*:\s*NodeJS\.ProcessEnv\s*=\s*\{([\s\S]+?)\};/);
if (!envObjMatch) {
  bad("could not locate `const childEnv: NodeJS.ProcessEnv = {...}` env builder");
  process.exit(1);
}
const envBody = envObjMatch[1];

// (ii) order: ...process.env must appear before PI_ABRAIN_DISABLED
const idxSpread = envBody.indexOf("...process.env");
const idxFlag = envBody.indexOf("PI_ABRAIN_DISABLED");
if (idxSpread >= 0 && idxFlag >= 0 && idxSpread < idxFlag) {
  ok("childEnv order: ...process.env appears BEFORE PI_ABRAIN_DISABLED (override wins)");
} else if (idxSpread < 0) {
  bad("childEnv missing ...process.env spread — sub-pi env truncated");
} else if (idxFlag < 0) {
  bad("childEnv missing PI_ABRAIN_DISABLED key — invariant #6 not enforced");
} else {
  bad("childEnv order WRONG: PI_ABRAIN_DISABLED appears before ...process.env — user's export PI_ABRAIN_DISABLED=0 will overwrite the override");
}

// (iii) PI_ABRAIN_DISABLED set to string "1" (not number 1, not boolean)
const flagMatch = envBody.match(/PI_ABRAIN_DISABLED\s*:\s*("1"|'1'|`1`)/);
if (flagMatch) {
  ok("PI_ABRAIN_DISABLED set to string \"1\"");
} else {
  bad("PI_ABRAIN_DISABLED value is not the string \"1\" — process.env values must be strings, otherwise child reads undefined");
}

// (iv) bonus: spawn block must reference childEnv (catch case where childEnv
//      is built but spawn uses some other env)
if (/env:\s*childEnv/.test(spawnBlock)) {
  ok("spawn passes childEnv (not some other env object)");
} else {
  bad("spawn passes a different env object — childEnv built but unused");
}

// (v) sanity: there's only one spawn("pi") call site (refactor would invalidate this smoke)
const allSpawns = src.match(/spawn\("pi"/g) || [];
if (allSpawns.length === 1) {
  ok("only one spawn(\"pi\") site in dispatch/index.ts (smoke covers all paths)");
} else {
  bad(`found ${allSpawns.length} spawn("pi") sites — this smoke only covers the first; add coverage for additional sites`);
}

console.log();
if (fail === 0) {
  console.log(`all ok — sub-pi PI_ABRAIN_DISABLED=1 override holds (${pass} assertions).`);
  process.exit(0);
} else {
  console.log(`FAIL — ${fail} of ${pass + fail} assertions failed.`);
  process.exit(1);
}
