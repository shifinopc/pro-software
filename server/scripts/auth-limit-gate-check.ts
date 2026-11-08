/**
 * THE LOGIN THROTTLE MAY ONLY EVER BE OFF ON A SCRATCH DATABASE.
 *
 *   npx tsx scripts/auth-limit-gate-check.ts
 *
 * src/index.ts can disable the 20-attempts-per-15-minutes limit on /api/auth/login, because the
 * check suite signs in far more often than a login form ever would. That is a brute-force control,
 * and the whole argument for touching it is that the condition cannot be met anywhere real.
 *
 * This is that argument, executed. It lifts the predicate OUT of src/index.ts rather than restating
 * it — a copy here would pass while the real one drifted, which is the one failure mode that would
 * make this check worse than nothing — and runs it against the URLs that actually exist: the live
 * stack, a local copy of live data, local dev, and the databases in this account whose names come
 * closest to tripping a loose rule.
 *
 * If this fails, do not relax it. Either the predicate has been widened, in which case narrow it
 * again, or a database has been named in a way that makes it look disposable, in which case rename
 * the database.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH_NAME } from "./_scratch-db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "src", "index.ts"), "utf8");

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);

// ── lift the real predicate out of the server ────────────────────────────────────────────────
const open = src.indexOf("const AUTH_LIMIT_OFF = (() => {");
if (open < 0) {
  fail("src/index.ts no longer defines AUTH_LIMIT_OFF. If the exemption was removed, delete this\n" +
       "        check too — and expect the suite's sign-in checks to start failing on 429.");
  process.exit(1);
}
const close = src.indexOf("})();", open);
const body = src.slice(src.indexOf("{", src.indexOf("=>", open)) + 1, close);
ok(`predicate lifted from src/index.ts (${body.trim().split("\n").length} lines)`);

// Re-create it as a function of (env, url) instead of reading process.env, so every case can be
// put through the SAME code the server runs.
const predicate = new Function("SUITE_NO_AUTH_LIMIT", "DATABASE_URL", `
  const process = { env: { SUITE_NO_AUTH_LIMIT, DATABASE_URL } };
  ${body}
`) as (flag: string | undefined, url: string) => boolean;

// The limiter must also actually CONSULT it, or the predicate is decoration.
if (!/skip:\s*\(\)\s*=>\s*AUTH_LIMIT_OFF/.test(src)) fail("authLimiter does not use AUTH_LIMIT_OFF in `skip` — the exemption is wired to nothing");
else ok("authLimiter consults it");

// And it must announce itself: a disabled control that logs nothing is the dangerous kind.
if (!/LOGIN RATE LIMIT DISABLED/.test(src)) fail("startup no longer warns when the limit is off");
else ok("startup warns loudly when it is off");

// THE TWO COPIES OF THE NAME RULE MUST AGREE.
//
// src/index.ts keeps its own, because production code should not import from scripts/, and
// scripts/_scratch-db.ts holds the one the suite's three guards share. Two copies is one more than
// ideal and exactly one more place to drift — so they are compared here rather than trusted.
const inServer = /return (\/.*\/i)\.test\(dbName\);/.exec(body)?.[1];
if (!inServer) fail("could not find the name rule inside AUTH_LIMIT_OFF to compare it");
else if (inServer !== SCRATCH_NAME.toString()) {
  fail(`the name rule has drifted between the two copies:\n` +
       `          src/index.ts        ${inServer}\n` +
       `          scripts/_scratch-db ${SCRATCH_NAME}\n` +
       `        Make them identical. A server that thinks a database is disposable while the suite\n` +
       `        does not — or the reverse — is how one of them ends up pointed somewhere real.`);
} else {
  ok(`the name rule matches scripts/_scratch-db.ts (${SCRATCH_NAME})`);
}

// ── the cases ────────────────────────────────────────────────────────────────────────────────
// Every one of these must leave the limiter ON except the last.
const MUST_STAY_ON: [string, string | undefined, string][] = [
  ["the live docker stack",                  "1",       "mysql://u:p@db:3306/stimespro"],
  ["the live stack with no flag",            undefined, "mysql://u:p@db:3306/stimespro"],
  ["a local copy of live data",              "1",       "mysql://root:x@localhost:3306/stimespro_live"],
  ["local development",                      "1",       "mysql://root:x@localhost:3306/stimespro"],
  ["a database called precision",            "1",       "mysql://root:x@localhost:3306/precision"],
  ["a database called practice",             "1",       "mysql://root:x@localhost:3306/practice"],
  ["a database called latest",               "1",       "mysql://root:x@localhost:3306/latest"],
  ["eastgate",                               "1",       "mysql://root:x@localhost:3306/eastgate"],
  ["a scratch name on a REMOTE host",        "1",       "mysql://root:x@10.0.0.5:3306/stimespro_ciscratch"],
  ["the CI scratch database with NO flag",   undefined, "mysql://root:ci@127.0.0.1:3306/stimespro_ciscratch"],
  ["no DATABASE_URL at all",                 "1",       ""],
  ["the flag set to something else",         "true",    "mysql://root:ci@127.0.0.1:3306/stimespro_ciscratch"],
];
const MUST_TURN_OFF: [string, string | undefined, string][] = [
  ["the CI scratch database, flag set",      "1",       "mysql://root:ci@127.0.0.1:3306/stimespro_ciscratch"],
  ["a local scratch database, flag set",     "1",       "mysql://root:x@localhost:3306/stimespro_scratch"],
];

for (const [label, flag, url] of MUST_STAY_ON) {
  let off: boolean;
  try { off = predicate(flag, url); }
  catch (e: any) { fail(`${label}: the predicate threw — ${String(e?.message).slice(0, 80)}`); continue; }
  if (off) fail(`THE LIMITER WOULD BE DISABLED for ${label}. That is a brute-force control off in a place it must never be off.`);
}
if (!bad) ok(`${MUST_STAY_ON.length} real-world cases all keep the limiter on`);

for (const [label, flag, url] of MUST_TURN_OFF) {
  if (!predicate(flag, url)) fail(`${label}: the limiter stays ON, so the suite's sign-in checks will fail on 429`);
}
ok(`${MUST_TURN_OFF.length} scratch cases turn it off`);

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
