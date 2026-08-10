/**
 * Throwaway check: the numbers behind every automatic decision are settings, and safe ones.
 *
 * Each was a constant in jobs.ts — `const STALE_DEAL_DAYS = 14`, `const SUSPEND_RECOMMEND_DAYS = 45`.
 * Those are not engineering values: how long a firm waits before it chases a client, or recommends
 * cutting one off, is a commercial policy with a relationship on the other end of it. A number like
 * that in a source file cannot be argued with by the person answerable for the consequence.
 *
 * What is asserted:
 *   - every default equals the constant the product behaved with, so exposing them changed nothing
 *   - a saved value is read back, per call, with no restart
 *   - out-of-range values are CLAMPED, not stored and silently ignored
 *   - garbage falls back to the default rather than to NaN — a NaN comparison is always false, which
 *     would switch a job off in complete silence
 *   - a missing settings row behaves exactly as an empty one
 *   - the renewal window reads BOTH ends: lead time and grace, the second of which was a bare `-30`
 *   - the sales rules alongside them still work — they share a screen but not a blob
 *
 * Restores whatever was there before, whatever happens.
 */
import { prisma } from "../src/db.js";
import { jobRules, JOB_RULE_DEFAULTS } from "../src/jobrules.js";
import { salesRules, SALES_RULE_DEFAULTS } from "../src/salesrules.js";

/** The values these were, as literals in jobs.ts, before the change. Hard-coded here on purpose: */
/** if a default drifts, this probe should fail rather than agree with whatever it drifted to.     */
const WAS = {
  docSlaAtRiskDays: 7,
  maxCatchUpPeriods: 12,
  suspendRecommendDays: 45,
  bandEdgePoints: 2,
  staleDealDays: 14,
  renewalLeadDays: 45,
  renewalGraceDays: 30,
  idleLeadDays: 10,
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const jSnap = (await prisma.appSetting.findUnique({ where: { key: "jobRules" } }))?.value ?? null;
  const sSnap = (await prisma.appSetting.findUnique({ where: { key: "salesRules" } }))?.value ?? null;
  const put = (key: string, v: any) => prisma.appSetting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
  const drop = (key: string) => prisma.appSetting.deleteMany({ where: { key } });

  try {
    // ── defaults are the old behaviour, exactly ────────────────────────────────────────────────
    await drop("jobRules");
    const d = await jobRules();
    let same = true;
    for (const [k, v] of Object.entries(WAS)) {
      if ((d as any)[k] !== v) { same = false; fail(`${k} defaults to ${(d as any)[k]}, but the constant it replaced was ${v}`); }
    }
    console.log(`no row → the old constants exactly:      ${same ? "YES" : "NO"}`);
    console.log(`  (a missing row and an empty one agree)`);
    await put("jobRules", {});
    const e = await jobRules();
    if (JSON.stringify(e) !== JSON.stringify(d)) fail("an empty settings row behaves differently from no row at all");

    // ── a saved value is honoured, per call ────────────────────────────────────────────────────
    await put("jobRules", { staleDealDays: 30, idleLeadDays: 3, suspendRecommendDays: 90 });
    const set = await jobRules();
    console.log(`\nsaved values are read back:              stale=${set.staleDealDays} idle=${set.idleLeadDays} suspend=${set.suspendRecommendDays}`);
    if (set.staleDealDays !== 30 || set.idleLeadDays !== 3 || set.suspendRecommendDays !== 90) fail("a saved threshold was ignored");
    console.log(`  untouched keys keep their defaults:    ${set.bandEdgePoints === WAS.bandEdgePoints ? "YES" : "NO"}`);
    if (set.bandEdgePoints !== WAS.bandEdgePoints) fail("saving some keys reset the others");

    // ── no restart: change it again and read again ─────────────────────────────────────────────
    await put("jobRules", { staleDealDays: 21 });
    console.log(`  changing again needs no restart:      ${(await jobRules()).staleDealDays === 21 ? "YES" : "NO"}`);
    if ((await jobRules()).staleDealDays !== 21) fail("the value is cached, so a change appears not to work");

    // ── clamping ───────────────────────────────────────────────────────────────────────────────
    // The floors are the ones that matter. staleDealDays: 0 would call every deal opened today
    // stale and mail the whole team their entire pipeline; maxCatchUpPeriods: 500 would raise five
    // hundred real invoices in one tick.
    await put("jobRules", { staleDealDays: 0, maxCatchUpPeriods: 500, bandEdgePoints: -4, renewalLeadDays: 99999 });
    const c = await jobRules();
    console.log(`\nclamped: stale=${c.staleDealDays} catchUp=${c.maxCatchUpPeriods} edge=${c.bandEdgePoints} lead=${c.renewalLeadDays}`);
    if (c.staleDealDays < 2) fail("zero was accepted — every deal opened today would be called stale");
    if (c.maxCatchUpPeriods > 60) fail("an unbounded catch-up was accepted — that creates real invoices");
    if (c.bandEdgePoints < 1) fail("a negative band edge was accepted");
    if (c.renewalLeadDays > 365) fail("a nonsense lead time was accepted");

    // ── garbage must not become NaN ────────────────────────────────────────────────────────────
    await put("jobRules", { staleDealDays: "soon", idleLeadDays: null, docSlaAtRiskDays: "", bandEdgePoints: "2 points" });
    const g = await jobRules();
    const anyNaN = Object.values(g).some(v => !Number.isFinite(v as number));
    console.log(`\ngarbage → defaults, never NaN:           ${!anyNaN ? "YES" : "NO"}`);
    if (anyNaN) fail("a NaN threshold got through — every comparison against it is false, so the job silently stops");
    if (g.staleDealDays !== WAS.staleDealDays) fail(`"soon" did not fall back to the default (got ${g.staleDealDays})`);
    if (g.idleLeadDays !== WAS.idleLeadDays) fail("null did not fall back to the default");

    // ── both ends of the renewal window ────────────────────────────────────────────────────────
    await put("jobRules", { renewalLeadDays: 60, renewalGraceDays: 0 });
    const r = await jobRules();
    console.log(`\nrenewal window reads both ends:          lead=${r.renewalLeadDays} grace=${r.renewalGraceDays}`);
    if (r.renewalLeadDays !== 60) fail("the lead time was ignored");
    if (r.renewalGraceDays !== 0) fail("zero grace was rejected — 'nothing after the end date' is a legitimate policy");

    // ── the sales rules are a separate blob ────────────────────────────────────────────────────
    await put("salesRules", { quoteChaseDays: 9, autoAssignOwner: false });
    const s = await salesRules();
    const j = await jobRules();
    console.log(`\nsales rules unaffected by job rules:     chase=${s.quoteChaseDays} autoOwner=${s.autoAssignOwner}`);
    if (s.quoteChaseDays !== 9) fail("the sales rules stopped reading their own blob");
    if (s.autoAssignOwner !== false) fail("a boolean rule was lost");
    if (j.renewalLeadDays !== 60) fail("writing the sales blob disturbed the job blob");
    console.log(`  and their defaults are intact:        ${(await (async () => { await drop("salesRules"); return (await salesRules()).quoteChaseDays; })()) === SALES_RULE_DEFAULTS.quoteChaseDays ? "YES" : "NO"}`);

  } finally {
    if (jSnap) await put("jobRules", jSnap); else await drop("jobRules");
    if (sSnap) await put("salesRules", sSnap); else await drop("salesRules");
  }

  const jNow = (await prisma.appSetting.findUnique({ where: { key: "jobRules" } }))?.value ?? null;
  const sNow = (await prisma.appSetting.findUnique({ where: { key: "salesRules" } }))?.value ?? null;
  console.log(`\nrestored: jobRules=${JSON.stringify(jNow)} salesRules=${JSON.stringify(sNow)}`);
  console.log(`live thresholds now: ${JSON.stringify(await jobRules())}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
