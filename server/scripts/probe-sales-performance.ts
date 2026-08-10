/**
 * Throwaway check for CRM phase 4: renewals that become deals, and the figures that judge them.
 *
 * The assertions that matter are about arithmetic nobody can argue with, and about the report
 * refusing to invent what it does not know:
 *   - a lapsing subscription raises exactly ONE deal, however many ticks run
 *   - an auto-renewing subscription raises none — it bills itself, nobody has to sell it
 *   - a subscription too far out, or long expired, is left alone
 *   - win rate is reported BY COUNT and BY VALUE, because they disagree and both are true
 *   - a deal with no value counts in the counts, is excluded from the money, and that exclusion is
 *     reported rather than silently dragging every average down
 *   - a period with no target reports NO TARGET, not 0%
 *   - deals are attributed to the period they CLOSED in, not the one they were opened in
 *
 * Own country, own client, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { raiseRenewalDeals, RENEWAL_LEAD_DAYS } from "../src/jobs.js";
import { salesReport, periodRange } from "../src/salesreport.js";

const COUNTRY = "ZZ";
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString();
const pct = (bp: number | null) => (bp == null ? "not answerable" : (bp / 100).toFixed(1) + "%");

/**
 * Clear anything a PREVIOUS run of this probe left behind.
 *
 * A probe that throws half way through never reaches its own cleanup, and the rows it made then sit
 * there failing the next run's leftover check — which reads as "the code leaks data" when what
 * actually happened is that the probe crashed once. Swept at the start rather than trusted.
 */
async function sweep() {
  const stale = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = stale.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.package.deleteMany({ where: { name: { startsWith: "ZZ " } } });
  await prisma.pipelineStage.deleteMany({ where: { country: COUNTRY } });
  if (ids.length) console.log(`(cleared ${ids.length} row set(s) from an earlier interrupted run)\n`);
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  for (const s of [
    { name: "ZZ Open", sort: 0, probabilityBp: 2000 },
    { name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
    { name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
  ]) await prisma.pipelineStage.create({ data: { ...s, country: COUNTRY } });
  const stages = await prisma.pipelineStage.findMany({ where: { country: COUNTRY } });
  const S = Object.fromEntries(stages.map(s => [s.name, s]));

  const co = await prisma.company.create({ data: { name: "ZZ Perf Client", cr: "0000", country: COUNTRY, lifecycle: "client" } });
  const pkg = await prisma.package.create({ data: { name: "ZZ Growth", tier: "growth", basePrice: 2500, billingCycle: "yearly", country: COUNTRY, empMin: 1, empMax: 50, features: [] } });

  // ── renewals become deals ──────────────────────────────────────────────────────────────────
  const lapsing = await prisma.subscription.create({
    data: { scope: "company", refId: co.id, companyId: co.id, packageId: pkg.id, price: 2500, autoRenew: false, endDate: iso(20).slice(0, 10) },
  });
  await prisma.subscription.create({
    data: { scope: "company", refId: co.id, companyId: co.id, packageId: pkg.id, price: 9000, autoRenew: true, endDate: iso(20).slice(0, 10) },
  });
  await prisma.subscription.create({
    data: { scope: "company", refId: co.id, companyId: co.id, packageId: pkg.id, price: 7000, autoRenew: false, endDate: iso(RENEWAL_LEAD_DAYS + 30).slice(0, 10) },
  });

  let r = await raiseRenewalDeals();
  console.log(`renewal deals raised: ${r.created} of ${r.considered} considered`);
  if (r.created !== 1) fail(`expected exactly 1 renewal deal, got ${r.created}`);
  const raised = await prisma.opportunity.findMany({ where: { companyId: co.id } });
  console.log(`  "${raised[0]?.title}" · value ${raised[0]?.valueMinor} · source ${raised[0]?.source}`);
  if (raised[0]?.valueMinor !== 250000) fail(`the deal is valued at ${raised[0]?.valueMinor}, expected the subscription price in minor units`);
  if (raised[0]?.source !== "renewal") fail("the renewal deal is not marked as coming from a renewal");

  r = await raiseRenewalDeals();
  const after2 = await prisma.opportunity.count({ where: { companyId: co.id } });
  console.log(`a second run adds nothing:               ${r.created === 0 && after2 === 1 ? "YES" : "NO (created " + r.created + ", now " + after2 + ")"}`);
  if (r.created !== 0 || after2 !== 1) fail("the tick raised the same renewal twice");

  const autoRenewDeal = raised.some(o => o.valueMinor === 900000);
  console.log(`an auto-renewing sub raises nothing:     ${!autoRenewDeal ? "YES" : "NO"}`);
  if (autoRenewDeal) fail("a subscription that renews itself was put on the board as a deal to win");

  // ── the report ─────────────────────────────────────────────────────────────────────────────
  const period = new Date().toISOString().slice(0, 7);
  const range = periodRange(period)!;
  const mid = new Date((Date.parse(range.from) + Date.parse(range.to)) / 2).toISOString();

  // Three closed deals: two won (one priced, one not), one lost.
  await prisma.opportunity.create({ data: { companyId: co.id, title: "ZZ won big", stageId: S["ZZ Won"].id, country: COUNTRY, valueMinor: 6000000, source: "referral", createdAt: iso(-40), closedAt: mid, stageAt: mid } });
  await prisma.opportunity.create({ data: { companyId: co.id, title: "ZZ won unpriced", stageId: S["ZZ Won"].id, country: COUNTRY, source: "website", createdAt: iso(-20), closedAt: mid, stageAt: mid } });
  await prisma.opportunity.create({ data: { companyId: co.id, title: "ZZ lost one", stageId: S["ZZ Lost"].id, country: COUNTRY, valueMinor: 2000000, source: "referral", lostReason: "Price", createdAt: iso(-30), closedAt: mid, stageAt: mid } });
  // Closed in a DIFFERENT period — must not appear.
  await prisma.opportunity.create({ data: { companyId: co.id, title: "ZZ old win", stageId: S["ZZ Won"].id, country: COUNTRY, valueMinor: 9900000, createdAt: iso(-400), closedAt: iso(-300), stageAt: iso(-300) } });

  let rep = await salesReport({ period, companyIds: [co.id] });
  console.log(`\nperiod ${rep.label}: won ${rep.won.count} · lost ${rep.lost.count} · open ${rep.open.count}`);
  if (rep.won.count !== 2 || rep.lost.count !== 1) fail(`the period has ${rep.won.count} won and ${rep.lost.count} lost, expected 2 and 1`);
  console.log(`…a deal closed in another period is out: ${rep.won.valueMinor === 6000000 ? "YES" : "NO (" + rep.won.valueMinor + ")"}`);
  if (rep.won.valueMinor !== 6000000) fail("a deal closed outside the period was counted in it");

  console.log(`win rate by count: ${pct(rep.winRateByCountBp)} · by value: ${pct(rep.winRateByValueBp)}`);
  if (rep.winRateByCountBp !== 6667) fail(`win rate by count is ${rep.winRateByCountBp}bp, expected 6667 (2 of 3)`);
  if (rep.winRateByValueBp !== 7500) fail(`win rate by value is ${rep.winRateByValueBp}bp, expected 7500 (60000 of 80000)`);

  console.log(`unpriced won deals reported:             ${rep.won.unpriced === 1 ? "YES" : "NO (" + rep.won.unpriced + ")"}`);
  if (rep.won.unpriced !== 1) fail("the deal with no value was not reported as excluded from the money");
  console.log(`…and the average excludes it:            ${rep.averageWonMinor === 6000000 ? "YES" : "NO (" + rep.averageWonMinor + ")"}`);
  if (rep.averageWonMinor !== 6000000) fail(`the average won is ${rep.averageWonMinor} — an unpriced deal was averaged in as zero`);

  console.log(`loss reasons: ${rep.lossReasons.map(l => l.key + " ×" + l.count).join(", ")}`);
  if (rep.lossReasons[0]?.key !== "Price") fail("the loss reason was not picked up");
  console.log(`sources: ${rep.sources.map(s => s.key + " ×" + s.count).join(", ")}`);
  if (rep.sources[0]?.key !== "referral" || rep.sources[0]?.count !== 2) fail("source attribution is wrong");

  // ── targets ────────────────────────────────────────────────────────────────────────────────
  console.log(`\nno target set reports no target:         ${rep.target === null && rep.progressBp === null ? "YES" : "NO"}`);
  if (rep.target !== null || rep.progressBp !== null) fail("a period with no target reported a percentage against nothing");

  await prisma.salesTarget.create({ data: { period, ownerId: null, amountMinor: 10000000, currency: "SAR", createdAt: new Date().toISOString() } });
  rep = await salesReport({ period, companyIds: [co.id] });
  console.log(`with a SAR 100,000 target: progress ${pct(rep.progressBp)}`);
  if (rep.progressBp !== 6000) fail(`progress is ${rep.progressBp}bp, expected 6000 (60000 of 100000)`);

  // ── a period with nothing in it ────────────────────────────────────────────────────────────
  const empty = await salesReport({ period: "2019-01", companyIds: [co.id] });
  console.log(`\nan empty period: win rate ${pct(empty.winRateByCountBp)} · decided ${empty.decided}`);
  if (empty.winRateByCountBp !== null) fail("a period where nothing closed reported a win rate instead of nothing");

  let badPeriod = false;
  try { await salesReport({ period: "not-a-period" }); } catch { badPeriod = true; }
  console.log(`a nonsense period is refused:            ${badPeriod ? "YES" : "NO"}`);
  if (!badPeriod) fail("a malformed period was accepted");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.notification.deleteMany({ where: { OR: [{ dedupeKey: { contains: lapsing.id } }, { title: { contains: "ZZ " } }, { message: { contains: "ZZ " } }] } });
  await prisma.salesTarget.deleteMany({ where: { period: { in: [period, "2019-01"] } } });
  await prisma.opportunity.deleteMany({ where: { companyId: co.id } });
  await prisma.subscription.deleteMany({ where: { companyId: co.id } });
  await prisma.package.delete({ where: { id: pkg.id } });
  await prisma.pipelineStage.deleteMany({ where: { country: COUNTRY } });
  await prisma.contact.deleteMany({ where: { companyId: co.id } });
  await prisma.company.delete({ where: { id: co.id } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.opportunity.count({ where: { title: { startsWith: "ZZ " } } })) +
    (await prisma.package.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.salesTarget.count({ where: { period: "2019-01" } })) +
    (await prisma.pipelineStage.count({ where: { country: COUNTRY } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
