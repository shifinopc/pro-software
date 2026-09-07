/**
 * Prove that band schemes actually change what a client is measured against.
 *
 * The whole point of this feature is that two clients with the SAME ratio in the SAME country come
 * out in different bands, because their regulator publishes different thresholds for their activity
 * and size. So that is what this walks: one ratio, two ladders, two answers.
 *
 * Five things are worth proving, and "the rows saved" is not one of them:
 *
 *   1. A client with no scheme falls to the country DEFAULT, and still gets a band. The migration
 *      path depends on this — every existing installation is in exactly this state.
 *   2. Assigning a scheme changes the computed band without a single employee moving.
 *   3. Ranks never cross ladders. Re-scheming a client must not be reported as a band FALL, which is
 *      what a naive comparison does and what would put a false compliance alert in front of somebody.
 *   4. A retired scheme is not quietly obeyed. Retiring thresholds means they no longer describe the
 *      regulator; a foreign key still pointing at them is not consent to keep using them.
 *   5. The suggestion never assigns. It matches on activity AND size, it declines to choose when two
 *      schemes claim the same ground, and it says nothing when the client is already on the best fit.
 *
 * Own country, own client, own schemes. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { workforceFor, suggestBandSet, bandsForCompany } from "../src/workforce.js";
import { checkWorkforceBands } from "../src/jobs.js";

const COUNTRY = "ZZ";              // a country nothing else uses, so no real config is touched
const CLIENT = "ZS Band Scheme Probe";

async function sweep() {
  // The nightly check writes to the ACTIVITY FEED, which is a real screen in this app — a probe that
  // leaves its narration there has not cleaned up, it has published.
  await prisma.activity.deleteMany({ where: { message: { contains: CLIENT } } });
  await prisma.notification.deleteMany({ where: { title: { contains: CLIENT } } });
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.workforceSnapshot.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  const sets = await prisma.workforceBandSet.findMany({ where: { country: COUNTRY }, select: { id: true } });
  await prisma.workforceBand.deleteMany({ where: { OR: [{ country: COUNTRY }, { setId: { in: sets.map(s => s.id) } }] } });
  await prisma.workforceBandSet.deleteMany({ where: { country: COUNTRY } });
}

/** A scheme plus its rungs, in percentages because that is what a regulator publishes. */
async function scheme(name: string, opts: { activity?: string; sizeMin?: number; sizeMax?: number; isDefault?: boolean },
                      rows: [string, number, number | null][]) {
  const set = await prisma.workforceBandSet.create({
    data: { country: COUNTRY, name, activity: opts.activity ?? null, sizeMin: opts.sizeMin ?? null, sizeMax: opts.sizeMax ?? null, isDefault: !!opts.isDefault },
  });
  let sort = 0;
  for (const [bandName, from, to] of rows) {
    await prisma.workforceBand.create({
      data: { country: COUNTRY, setId: set.id, name: bandName, minBp: Math.round(from * 100), maxBp: to == null ? null : Math.round(to * 100), sort: sort++ },
    });
  }
  return set;
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  // ── two ladders over the same range, differing exactly where it matters ────────────────────
  const dflt = await scheme("ZZ — default", { isDefault: true }, [["Red", 0, 25], ["Green", 25, 50], ["Platinum", 50, null]]);
  // Construction is held to a lower bar in most markets; a ratio that is Red on the general ladder
  // is Green on this one. That difference is the entire feature.
  const constr = await scheme("Construction · 50–499", { activity: "Construction", sizeMin: 50, sizeMax: 499 },
    [["Red", 0, 10], ["Green", 10, 30], ["Platinum", 30, null]]);
  const constrBig = await scheme("Construction · 500+", { activity: "Construction", sizeMin: 500 },
    [["Red", 0, 20], ["Green", 20, 45], ["Platinum", 45, null]]);

  // ── one client, 20% national ──────────────────────────────────────────────────────────────
  const co = await prisma.company.create({
    data: { name: CLIENT, country: COUNTRY, industry: "Construction", status: "active", lifecycle: "client" } as any,
  });
  for (let i = 0; i < 100; i++) {
    await prisma.employee.create({
      data: { companyId: co.id, name: `ZS probe ${i}`, nationality: i < 20 ? COUNTRY : "IN", archived: false, exitStatus: "active" } as any,
    });
  }

  const w1 = await workforceFor(co.id);
  console.log(`ratio: ${(w1!.ratioMinBp / 100).toFixed(2)}%  (${w1!.nationals} of ${w1!.total})`);
  console.log("");

  // ── 1. no scheme → country default ────────────────────────────────────────────────────────
  console.log(`no scheme assigned:      band ${w1?.computedBand?.name}  via "${w1?.bandSet?.name}" (assigned: ${w1?.bandSet?.assigned})`);
  if (w1?.computedBand?.name !== "Red") fail(`a 20% ratio on the default ladder should be Red, got ${w1?.computedBand?.name}`);
  if (w1?.bandSet?.id !== dflt.id) fail("a client with no scheme did not fall to the country default");
  if (w1?.bandSet?.assigned !== false) fail("the country default was reported as an assigned scheme");

  // ── 5a. the suggestion spots the better fit, and does NOT apply it ─────────────────────────
  console.log(`suggestion:              ${w1?.bandSetSuggestion ? `"${w1.bandSetSuggestion.name}" — ${w1.bandSetSuggestion.why}` : "none"}`);
  if (w1?.bandSetSuggestion?.id !== constr.id) fail("the 50–499 construction scheme was not suggested for a 100-staff contractor");
  const stillDefault = await prisma.company.findUnique({ where: { id: co.id }, select: { workforceBandSetId: true } });
  if (stillDefault?.workforceBandSetId) fail("the suggestion ASSIGNED a scheme — it must only ever suggest");

  // ── 2. assigning changes the band, with nobody hired or fired ──────────────────────────────
  await prisma.company.update({ where: { id: co.id }, data: { workforceBandSetId: constr.id } });
  const w2 = await workforceFor(co.id);
  console.log(`on the 50–499 scheme:    band ${w2?.computedBand?.name}  via "${w2?.bandSet?.name}" (assigned: ${w2?.bandSet?.assigned})`);
  if (w2?.ratioMinBp !== w1?.ratioMinBp) fail("the ratio moved — the scheme must change the reading, not the arithmetic");
  if (w2?.computedBand?.name !== "Green") fail(`a 20% ratio on the construction ladder should be Green, got ${w2?.computedBand?.name}`);
  if (w2?.bandSet?.assigned !== true) fail("an assigned scheme was reported as a fallback");

  // ── 5b. already on the best fit → nothing to suggest ───────────────────────────────────────
  console.log(`suggestion now:          ${w2?.bandSetSuggestion ? w2.bandSetSuggestion.name : "none"}`);
  if (w2?.bandSetSuggestion) fail("a client already on the best-fitting scheme was told to move to one");

  // ── 3. re-scheming is not a fall ───────────────────────────────────────────────────────────
  // Seed the nightly check's memory as though it had already looked at this client on the OLD ladder.
  await prisma.company.update({ where: { id: co.id }, data: { workforceBandSeen: "Platinum", workforceBandSeenSetId: dflt.id } });
  const before = await prisma.notification.count();
  const r = await checkWorkforceBands();
  const after = await prisma.notification.count();
  const seen = await prisma.company.findUnique({ where: { id: co.id }, select: { workforceBandSeen: true, workforceBandSeenSetId: true } });
  console.log("");
  console.log(`nightly check:           dropped ${r.dropped} · re-schemed ${r.rescheme} · notifications raised ${after - before}`);
  console.log(`  seen band re-based to: ${seen?.workforceBandSeen} on the scheme now in force: ${seen?.workforceBandSeenSetId === constr.id}`);
  if (r.dropped > 0) fail("changing the scheme was reported as a band FALL — ranks are not comparable across ladders");
  if (r.rescheme !== 1) fail(`the scheme change was not recognised (rescheme=${r.rescheme})`);
  if (seen?.workforceBandSeen !== "Green" || seen?.workforceBandSeenSetId !== constr.id) fail("the seen band was not re-based onto the new scheme");

  // ── 4. a retired scheme is not obeyed ──────────────────────────────────────────────────────
  await prisma.workforceBandSet.update({ where: { id: constr.id }, data: { retired: true } });
  const w3 = await workforceFor(co.id);
  console.log("");
  console.log(`after retiring it:       band ${w3?.computedBand?.name}  via "${w3?.bandSet?.name}"`);
  if (w3?.bandSet?.id !== dflt.id) fail("a retired scheme is still placing this client — retiring thresholds must stop them being used");
  if (w3?.computedBand?.name !== "Red") fail("falling back to the default did not re-place the ratio");
  await prisma.workforceBandSet.update({ where: { id: constr.id }, data: { retired: false } });

  // ── 5c. two schemes claiming the same ground → no suggestion ───────────────────────────────
  const clash = await scheme("Construction · 50–499 (duplicate)", { activity: "Construction", sizeMin: 50, sizeMax: 499 },
    [["Red", 0, 15], ["Green", 15, null]]);
  await prisma.company.update({ where: { id: co.id }, data: { workforceBandSetId: null } });
  const amb = await suggestBandSet({ country: COUNTRY, industry: "Construction" }, 100, null);
  console.log(`two schemes claim 50–499: ${amb ? `suggested "${amb.name}"` : "no suggestion"}`);
  if (amb) fail("two schemes claim the same activity and bracket and one was picked anyway — that is a config error, not a choice");
  await prisma.workforceBandSet.delete({ where: { id: clash.id } });

  // ── 5d. size decides between two schemes of the same activity ──────────────────────────────
  const big = await suggestBandSet({ country: COUNTRY, industry: "Construction" }, 900, null);
  console.log(`at 900 staff:             ${big ? `suggested "${big.name}"` : "no suggestion"}`);
  if (big?.id !== constrBig.id) fail("a 900-staff contractor was not matched to the 500+ scheme");

  // ── 5e. activity must agree, not just size ─────────────────────────────────────────────────
  const wrong = await suggestBandSet({ country: COUNTRY, industry: "Retail" }, 100, null);
  console.log(`a retailer at 100 staff:  ${wrong ? `suggested "${wrong.name}"` : "no suggestion"}`);
  if (wrong) fail("a retailer was matched to a construction scheme on headcount alone");

  // ── 6. a client on THEIR OWN ladder is never argued with ───────────────────────────────────
  // Bands are set up per client, so another client's ladder can match this one's activity and size
  // exactly. Suggesting a move to it would be the app second-guessing a decision somebody made about
  // this client specifically, on this client's own screen.
  const own = await prisma.workforceBandSet.create({
    data: { country: COUNTRY, name: `${CLIENT} — bands`, ownerCompanyId: co.id, activity: "Construction", sizeMin: 50, sizeMax: 499 },
  });
  await prisma.workforceBand.createMany({ data: [
    { country: COUNTRY, setId: own.id, name: "Red", minBp: 0, maxBp: 1000, sort: 0 },
    { country: COUNTRY, setId: own.id, name: "Green", minBp: 1000, maxBp: null, sort: 1 },
  ] });
  await prisma.company.update({ where: { id: co.id }, data: { workforceBandSetId: own.id } });
  const w4 = await workforceFor(co.id);
  console.log("");
  console.log(`on its OWN ladder:       band ${w4?.computedBand?.name} via "${w4?.bandSet?.name}"`);
  console.log(`  a rival ladder matches activity and size, suggestion: ${w4?.bandSetSuggestion ? w4.bandSetSuggestion.name : "none"}`);
  if (w4?.bandSetSuggestion) fail("a client set up on its own ladder was told to move to somebody else's");
  await prisma.company.update({ where: { id: co.id }, data: { workforceBandSetId: null } });

  // ── and the bands helper agrees with the reading ───────────────────────────────────────────
  const rows = await bandsForCompany({ country: COUNTRY, workforceBandSetId: constr.id });
  if (rows.length !== 3) fail(`bandsForCompany returned ${rows.length} rows for a three-rung ladder`);

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
