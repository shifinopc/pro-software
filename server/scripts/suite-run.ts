/**
 * RUN THE CHECK SUITE, AND NOTICE WHEN ONE OF THEM STOPS WORKING.
 *
 *   npx prisma db push --skip-generate
 *   npx tsx scripts/suite-seed.ts
 *   npx tsx src/index.ts &                    (only needed for the API group)
 *   npx tsx scripts/suite-run.ts [--group db|api|all] [--list]
 *
 * This folder holds 178 scripts. Each was written beside the bug it found, and then ran only when
 * somebody remembered — which is the same as not having it. Twenty-one were in CI. The rest were a
 * regression suite in everything but the running.
 *
 * What was missing was never the scripts. It was a database to run them against: most of them write,
 * and several refuse outright to touch a populated one. Given a freshly seeded scratch database —
 * see suite-seed.ts — the great majority pass as written.
 *
 * HOW THIS STAYS HONEST. Three lists in suite-manifest.ts, and the runner treats them differently:
 *
 *   EXPECTED    must pass. One failure fails the build. This is the regression suite.
 *   QUARANTINE  known not to pass, each with a reason. Reported, never fatal — but if one starts
 *               passing, this says so, loudly, because a quarantine nobody revisits is just a list
 *               of things that will never be fixed.
 *   TOOLS       not checks at all — importers, installers, fixture makers. They print usage and
 *               exit non-zero, forever. Excluded rather than quarantined, so the quarantine stays
 *               a list of real problems.
 *
 * A script this folder gains and the manifest does not mention is reported as UNLISTED and fails the
 * build. That is deliberate: the default for a new check should be "it runs", and the way to find
 * out it does not is not to discover six months later that it never did.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { EXPECTED, QUARANTINE, TOOLS, MIGRATIONS, MODULES, API_GROUP } from "./suite-manifest.js";
import { sweep } from "./suite-sweep.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, "..");

const arg = (k: string) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const group = (arg("--group") ?? "all") as "db" | "api" | "all";
const LIST_ONLY = process.argv.includes("--list");

const url = process.env.DATABASE_URL ?? "";
const dbName = (url.split("/").pop() ?? "").split("?")[0];
if (!LIST_ONLY) {
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) { console.error("refusing: DATABASE_URL is not on localhost"); process.exit(1); }
  // Anchored, not a substring match. `/(scratch|ci|test)/` would have accepted a database called
  // "precision" or "practice" — and a guard that errs towards permitting is not a guard.
  if (!/(^|_)(scratch|ci|test)$|scratch$|_(ci|test)_/i.test(dbName)) {
    console.error(`refusing: "${dbName}" does not look like a scratch database — these scripts write, and several do not clean up.\n  Name it so it cannot be mistaken for anything else, e.g. stimespro_ciscratch.`);
    process.exit(1);
  }
}

// The suite's own files are not part of the suite.
const OWN = new Set(["suite-run", "suite-manifest", "suite-seed", "suite-sweep"]);
const onDisk = fs.readdirSync(path.join(serverDir, "scripts"))
  .filter(f => f.endsWith(".ts"))
  .map(f => f.replace(/\.ts$/, ""))
  .filter(n => !OWN.has(n))
  .sort();

const quarantined = new Map(QUARANTINE.map(q => [q.name, q.why]));
const listed = new Set([...EXPECTED, ...quarantined.keys(), ...TOOLS, ...MIGRATIONS, ...MODULES]);
const unlisted = onDisk.filter(n => !listed.has(n));
const missing = [...listed].filter(n => !onDisk.includes(n));

// The API group is the subset that signs in over HTTP rather than talking to the database directly.
// CI runs ONE sequence with a server already up — splitting the run would reorder it, and order is
// part of the result here (see the note below). `--group` is for working on a slice locally.
const inGroup = (n: string) => group === "all" || (group === "api" ? API_GROUP.includes(n) : !API_GROUP.includes(n));

if (LIST_ONLY) {
  console.log(`on disk ${onDisk.length} | expected ${EXPECTED.length} | quarantined ${quarantined.size} | tools ${TOOLS.length} | migrations ${MIGRATIONS.length} | modules ${MODULES.length}`);
  console.log(`\nexpected (${group}):\n  ` + EXPECTED.filter(inGroup).join("\n  "));
  if (quarantined.size) { console.log("\nquarantined:"); for (const [n, why] of quarantined) console.log(`  ${n.padEnd(34)} ${why}`); }
  if (unlisted.length) console.log("\nUNLISTED:\n  " + unlisted.join("\n  "));
  if (missing.length) console.log("\nin the manifest but not on disk:\n  " + missing.join("\n  "));
  process.exit(0);
}

/**
 * ORDER IS PART OF THE RESULT, and pretending otherwise would make this lie.
 *
 * These scripts are not isolated: most write, several leave rows behind, and some pass only
 * because an earlier one created what they needed. `paid-gate-check` is the clear case — it wants a
 * workflow template named "Iqama Renewal", fails on a freshly seeded database, and passes in a full
 * run because something alphabetically before it makes one.
 *
 * So the suite runs every listed script in ONE alphabetical sequence, expected and quarantined
 * together, which is exactly the order the manifest was measured in. Running the expected ones
 * first and the quarantined ones afterwards — the obvious implementation — silently changes that
 * order and turns a dependency into a failure nobody can reproduce.
 *
 * The honest fix is a fresh database per script, and at 178 scripts it costs hours. This is the
 * trade: one fixed order, written down, rather than a false claim of independence.
 */
let failed = 0, passed = 0, surprises: string[] = [];
const run = (name: string) => {
  const t0 = Date.now();
  const r = spawnSync(`npx tsx scripts/${name}.ts`, {
    cwd: serverDir, encoding: "utf8", timeout: 120_000, shell: true, env: process.env,
  });
  const ms = Date.now() - t0;
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  const ok = r.status === 0 && !r.signal;
  return { ok, ms, out };
};

const expected = new Set(EXPECTED);
// One alphabetical sequence over everything listed except the tools — see the note above.
const sequence = onDisk.filter(n => (expected.has(n) || quarantined.has(n)) && inGroup(n));
console.log(`suite: ${sequence.length} script(s) in order, group "${group}", database "${dbName}"\n`);

/**
 * BETWEEN SCRIPTS, NOT AFTER THEM ALL.
 *
 * These scripts share one database and a naming convention for anything disposable. One of them
 * leaving a row behind used to fail the next twenty-five on their first line — see suite-sweep.ts
 * for the measurement. Clearing the throwaway namespace between scripts is the cheap stand-in for
 * a fresh database per script, which at 178 scripts costs hours.
 *
 * A sweep that cannot clear something is reported and does not stop the run: whatever is stuck is
 * about to make the next script fail anyway, and saying so here is how that gets attributed to the
 * script that caused it rather than the one that tripped over it.
 */
const prisma = new PrismaClient();
let sweptRows = 0;
const sweepNow = async (after: string) => {
  try {
    const r = await sweep(prisma);
    sweptRows += r.rows + r.companies + r.users;
    if (r.stuck.length) console.log(`        swept after ${after}, but could not clear: ${r.stuck.join("; ")}`);
  } catch (e: any) {
    console.log(`        sweep failed after ${after}: ${String(e?.message ?? e).slice(0, 120)}`);
  }
};

await sweepNow("the seed");
for (const name of sequence) {
  const { ok, ms, out } = run(name);
  await sweepNow(name);
  if (quarantined.has(name)) {
    if (ok) surprises.push(`${name} — quarantined as "${quarantined.get(name)}", and it passes now. Move it to EXPECTED.`);
    else console.log(`  --    ${name.padEnd(36)} ${ms}ms  (quarantined: ${quarantined.get(name)})`);
    continue;
  }
  if (ok) { passed++; console.log(`  ok    ${name.padEnd(36)} ${ms}ms`); }
  else {
    failed++;
    console.log(`  FAIL  ${name.padEnd(36)} ${ms}ms`);
    // The last lines are where these scripts put their verdict, and the whole point of a suite is
    // that a failure tells you what broke without a second run to find out.
    for (const line of out.split("\n").slice(-14)) console.log(`          ${line.slice(0, 160)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (unlisted.length) {
  console.log(`\n${unlisted.length} script(s) are in scripts/ and not in the manifest. Add each to EXPECTED, QUARANTINE (with a reason) or TOOLS:`);
  for (const n of unlisted) console.log(`  ${n}`);
  failed += unlisted.length;
}
if (missing.length) {
  console.log(`\n${missing.length} name(s) in the manifest no longer exist on disk — remove them:`);
  for (const n of missing) console.log(`  ${n}`);
  failed += missing.length;
}
if (surprises.length) { console.log("\nGOOD NEWS, and it needs acting on:"); for (const s of surprises) console.log("  " + s); }

process.exit(failed ? 1 : 0);
