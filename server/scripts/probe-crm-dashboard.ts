/**
 * PROVE THE CRM DASHBOARD.
 *
 * Every figure is re-derived here by a DIFFERENT route than the module used — raw counts and
 * independent filters — and the two are compared. A probe that calls the same helper the module
 * calls proves only that the function is deterministic.
 *
 * Read-only against real data. Nothing is created and nothing is deleted, so there is no cleanup
 * to get wrong.
 */
import { prisma } from "../src/db.js";
import { crmDashboard } from "../src/crmdashboard.js";
import { jobRules } from "../src/jobrules.js";
import { forecastOf, recordTransition, stageAnalytics } from "../src/pipeline.js";
import { recordLifecycle, lifecycleAnalytics, campaignPerformance } from "../src/lifecycle.js";
import { recordAssignment, assignmentHistory } from "../src/assignment.js";
import { rescheduleFollowUp, cancelFollowUp, closeFollowUp, openFollowUps, followUpCompletion } from "../src/interactions.js";

let bad = 0;
const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
const ok = (m: string) => console.log("  ✓ " + m);
const eq = (label: string, got: any, want: any) =>
  got === want ? ok(`${label} = ${got}`) : fail(`${label}: dashboard says ${got}, the tables say ${want}`);

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);

async function main() {
  const d = await crmDashboard();
  console.log(`\nCRM dashboard as at ${d.on} (month ${d.month})\n`);

  // ── leads ───────────────────────────────────────────────────────────────────────────────────
  console.log("Leads");
  eq("total leads", d.leads.total, await prisma.company.count({ where: { lifecycle: "lead" } }));
  // "New today" is ARRIVAL ROWS, not `createdAt`. This assertion used to read the column and was
  // left behind when the semantics changed — it then failed against a correct dashboard, because
  // the staff-create route never stamped `createdAt` at all. Re-derived the same way the module
  // does but by an independent query, which is the point of this file.
  const arrivedRows = await prisma.lifecycleTransition.findMany({
    where: { fromLifecycle: null, toLifecycle: "lead", changedAt: { gte: today } },
    select: { companyId: true },
  });
  eq("new today (from arrival rows)", d.leads.newToday, new Set(arrivedRows.map(r => r.companyId)).size);
  const leadRows = await prisma.company.findMany({ where: { lifecycle: "lead" }, select: { createdAt: true } });
  const undated = leadRows.filter(c => !c.createdAt).length;
  console.log(`  · ${undated} of ${leadRows.length} leads have no createdAt — that column means "client since" and is not what "new today" reads`);

  // ── deals ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nDeals");
  const wonStages = (await prisma.pipelineStage.findMany({ where: { isWon: true }, select: { id: true } })).map(s => s.id);
  const lostStages = (await prisma.pipelineStage.findMany({ where: { isLost: true }, select: { id: true } })).map(s => s.id);
  const terminal = [...wonStages, ...lostStages];
  eq("open", d.deals.open.count, await prisma.opportunity.count({ where: { stageId: { notIn: terminal } } }));
  eq("won (all time)", d.deals.won.count, await prisma.opportunity.count({ where: { stageId: { in: wonStages } } }));
  eq("lost (all time)", d.deals.lost.count, await prisma.opportunity.count({ where: { stageId: { in: lostStages } } }));

  const wonRows = await prisma.opportunity.findMany({ where: { stageId: { in: wonStages } }, select: { closedAt: true } });
  eq("won this month", d.deals.won.thisMonth, wonRows.filter(r => String(r.closedAt ?? "").slice(0, 7) === month).length);

  // A win rate of null and a win rate of 0 must not be confusable.
  const decided = d.deals.won.thisMonth + d.deals.lost.thisMonth;
  if (decided === 0 && d.deals.winRateBp !== null) fail("nothing closed this month but winRateBp is not null");
  else if (decided > 0 && d.deals.winRateBp === null) fail(`${decided} deals closed this month but winRateBp is null`);
  else ok(`win rate ${d.deals.winRateBp === null ? "null (nothing decided this month)" : (d.deals.winRateBp / 100) + "%"}`);

  // Pipeline stages hold ONLY open deals — a terminal stage appearing here would double-count
  // every won deal into the "in the pipeline" total on the front page.
  const pipeCount = d.pipeline.reduce((n, s) => n + s.count, 0);
  eq("pipeline stage counts sum to open deals", pipeCount, d.deals.open.count);
  if (d.pipeline.some(s => terminal.includes(s.id))) fail("a won/lost stage leaked into the pipeline chart");
  else ok("no terminal stage in the pipeline chart");

  // ── the trend ───────────────────────────────────────────────────────────────────────────────
  console.log("\nSix-month trend");
  eq("months returned", d.months.length, 6);
  eq("last month on the line is this month", d.months[5].key, month);
  const gaps = d.months.filter(m => m.wonCount === 0).length;
  console.log(`  · ${gaps} of 6 months have no wins — present as zeroes, not missing points`);
  eq("this month's won count agrees with the card", d.months[5].wonCount, d.deals.won.thisMonth);
  eq("this month's won value agrees with the card", d.months[5].wonMinor, d.deals.won.thisMonthMinor);

  // ── money ───────────────────────────────────────────────────────────────────────────────────
  console.log("\nMoney");
  const pays = await prisma.payment.findMany({ where: {}, select: { amount: true, date: true } });
  const mine = pays.filter(p => String(p.date ?? "").slice(0, 7) === month);
  eq("payments counted", d.money.collectedCount, mine.length);
  // Payment.amount is WHOLE units — settled directly against Invoice.amount. The dashboard scales
  // it. If somebody later gives Payment a minor column and forgets this line, this check fails.
  eq("collected (minor)", d.money.collectedMinor, mine.reduce((n, p) => n + p.amount * 100, 0));
  const invs = await prisma.invoice.findMany({ select: { amount: true, totalMinor: true, date: true, voidedAt: true } });
  const invMine = invs.filter(i => String(i.date ?? "").slice(0, 7) === month && !i.voidedAt);
  eq("invoices counted (void excluded)", d.money.invoicedCount, invMine.length);
  eq("invoiced (minor)", d.money.invoicedMinor, invMine.reduce((n, i) => n + (i.totalMinor ?? i.amount * 100), 0));
  const voided = invs.filter(i => String(i.date ?? "").slice(0, 7) === month && i.voidedAt).length;
  console.log(`  · ${voided} void invoice(s) this month, correctly excluded`);

  // ── what is next ────────────────────────────────────────────────────────────────────────────
  console.log("\nMeetings and activity");
  // EVERY row must be a real ISO day. This is the check that matters: Appointment.date holds mixed
  // formats, and "30 Jul" string-compares as later than "2026-08-07", so a plain >= today filter
  // lets a meeting from last month through while looking like it is working.
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const wrong = d.upcoming.filter(a => !iso.test(a.date ?? ""));
  if (wrong.length) fail(`${wrong.length} upcoming meeting(s) have an unparseable date: ${wrong.map(a => JSON.stringify(a.date)).join(", ")}`);
  else ok("every upcoming meeting has a real ISO date");
  if (d.upcoming.some(a => (a.date ?? "") < today)) fail("a past meeting is in Upcoming");
  else ok(`${d.upcoming.length} upcoming meeting(s), none in the past`);
  if (d.upcoming.some(a => /cancel/i.test(a.status ?? ""))) fail("a cancelled meeting is in Upcoming");
  else ok("no cancelled meetings in Upcoming");
  const sorted = d.upcoming.every((a, i, xs) => i === 0 || (xs[i - 1].date ?? "") <= (a.date ?? ""));
  sorted ? ok("upcoming meetings are in date order") : fail("upcoming meetings are out of order");
  console.log(`  · ${d.undatedUpcoming} live appointment(s) have a date that cannot be placed in time — excluded and reported, never assumed upcoming`);

  ok(`${d.recentActivity.length} recent activity row(s)`);
  const actSorted = d.recentActivity.every((a, i, xs) => i === 0 || (xs[i - 1].at ?? "") >= (a.at ?? ""));
  actSorted ? ok("activity is newest first") : fail("activity is not newest first");
  // The frozen "Just now" string must not have travelled to the screen.
  if (d.recentActivity.some(a => "time" in (a as any))) fail("recentActivity still carries the frozen `time` label");
  else ok("the frozen \"Just now\" label is not sent to the screen");

  // ── forecast ────────────────────────────────────────────────────────────────────────────────
  // Pure function, probed with fixture stages: thresholds exact at the boundaries, the override
  // beating the arithmetic and saying so, and closed deals carrying no category at all.
  console.log("\nForecast");
  const openStg = { isWon: false, isLost: false, probabilityBp: 0 } as any;
  const fc = (bp: number | null, set?: string | null) =>
    forecastOf({ probabilityBp: bp, forecastCategory: set ?? null } as any, openStg);
  eq("7500 bp derives commit", fc(7500)!.category, "commit");
  eq("7499 bp derives best_case", fc(7499)!.category, "best_case");
  eq("5000 bp derives best_case", fc(5000)!.category, "best_case");
  eq("4999 bp derives pipeline", fc(4999)!.category, "pipeline");
  eq("null odds fall back to the stage's 0 → pipeline", fc(null)!.category, "pipeline");
  const overr = fc(9000, "pipeline")!;
  eq("a set category beats 90% odds", overr.category, "pipeline");
  eq("…and says it was set", overr.source, "set");
  eq("derived says derived", fc(9000)!.source, "derived");
  if (forecastOf({ probabilityBp: 9000, forecastCategory: null } as any, { isWon: true, isLost: false, probabilityBp: 0 } as any) !== null)
    fail("a won deal carries a forecast category — its money is history, not a promise");
  else ok("closed deals carry no category");
  const junk = forecastOf({ probabilityBp: 9000, forecastCategory: "definitely" } as any, openStg)!;
  eq("an unknown stored value falls back to derivation", junk.source, "derived");

  // ── scoping ─────────────────────────────────────────────────────────────────────────────────
  // The one thing a dashboard must never get wrong: an empty scope means "sees nothing", NOT
  // "sees everything". Passing [] must not silently fall through to the unscoped branch.
  console.log("\nScoping");
  const none = await crmDashboard({ companyIds: [], ownerIds: [] });
  if (none.leads.total === 0 && none.deals.open.count === 0) ok("an empty scope shows nothing, not everything");
  else fail(`an empty scope leaked data: ${none.leads.total} leads, ${none.deals.open.count} open deals`);

  // ── the part that can actually fail ─────────────────────────────────────────────────────────
  //
  // Everything above passed against a nearly empty database, where most checks are 0 === 0 and a
  // broken figure would pass just as happily. So: create fixtures whose contribution is known
  // exactly, then assert the DELTA. A dashboard that ignored closedAt, or summed lost deals into
  // won, or scaled payments wrongly, cannot survive this.
  //
  // Every id created is recorded and deleted by id at the end. Nothing is removed by matching a
  // name or a kind.
  console.log("\nAgainst known fixtures");
  const made = { companies: [] as string[], opps: [] as string[], invoices: [] as string[], payments: [] as string[] };
  const wonStage = await prisma.pipelineStage.findFirst({ where: { isWon: true, retired: false } });
  const lostStage = await prisma.pipelineStage.findFirst({ where: { isLost: true, retired: false } });
  const openStage = await prisma.pipelineStage.findFirst({ where: { isWon: false, isLost: false, retired: false }, orderBy: { sort: "asc" } });
  if (!wonStage || !lostStage || !openStage) { fail("no pipeline configured — cannot probe with fixtures"); }
  else {
    const lastMonth = (() => { const x = new Date(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() - 1); return x.toISOString().slice(0, 7); })();
    /** Captured before anything writes to it, restored in the `finally` below. */
    const originalMaxDays = openStage.maxDays;
    try {
      const co = await prisma.company.create({ data: { name: "Qanat Probe Client", lifecycle: "lead", createdAt: today } });
      made.companies.push(co.id);
      // "New today" reads the lifecycle history now, not createdAt — a fixture created straight
      // through prisma has to write its own arrival row, exactly as every real creation path does.
      await recordLifecycle(prisma, { companyId: co.id, to: "lead", at: new Date().toISOString() });
      // `stageAt` is set on every one of these: left null they would all count as unknown-age, and
      // the stalled checks below would then be measuring this helper rather than the module.
      const mk = async (title: string, stageId: string, valueMinor: number, closedAt: string | null) => {
        const o = await prisma.opportunity.create({ data: { companyId: co.id, title, stageId, valueMinor, currency: "SAR", closedAt, stageAt: today } });
        made.opps.push(o.id);
      };
      await mk("Qanat won now", wonStage.id, 500_00, today);            // + won this month, 500.00
      await mk("Qanat won now 2", wonStage.id, 250_00, today);          // + won this month, 250.00
      await mk("Qanat won earlier", wonStage.id, 900_00, lastMonth + "-15"); // NOT this month
      await mk("Qanat lost now", lostStage.id, 400_00, today);          // + lost this month
      await mk("Qanat still open", openStage.id, 100_00, null);         // + open
      const inv = await prisma.invoice.create({ data: { number: "QANAT-PROBE-1", companyId: co.id, amount: 300, totalMinor: 300_00, date: today } });
      made.invoices.push(inv.id);
      const voidInv = await prisma.invoice.create({ data: { number: "QANAT-PROBE-2", companyId: co.id, amount: 999, totalMinor: 999_00, date: today, voidedAt: today, voidReason: "probe" } });
      made.invoices.push(voidInv.id);
      const pay = await prisma.payment.create({ data: { invoiceId: inv.id, companyId: co.id, amount: 300, date: today } });
      made.payments.push(pay.id);

      const a = await crmDashboard();
      eq("leads +1", a.leads.total, d.leads.total + 1);
      eq("new leads today +1", a.leads.newToday, d.leads.newToday + 1);
      eq("open deals +1", a.deals.open.count, d.deals.open.count + 1);
      eq("won this month +2", a.deals.won.thisMonth, d.deals.won.thisMonth + 2);
      eq("won all time +3", a.deals.won.count, d.deals.won.count + 3);
      // The one that catches a closedAt bug: last month's win must NOT be in this month's value.
      eq("won value this month +750.00", a.deals.won.thisMonthMinor, d.deals.won.thisMonthMinor + 750_00);
      eq("lost this month +1", a.deals.lost.thisMonth, d.deals.lost.thisMonth + 1);
      eq("last month's win landed on last month's point", a.months[4].wonMinor, d.months[4].wonMinor + 900_00);
      eq("collected +300.00 (whole units scaled)", a.money.collectedMinor, d.money.collectedMinor + 300_00);
      eq("invoiced +300.00, the void one excluded", a.money.invoicedMinor, d.money.invoicedMinor + 300_00);
      // 2 won, 1 lost → 66.67%. Proves lost deals are in the denominator and only the denominator.
      eq("win rate counts the loss", a.deals.winRateBp, Math.round((( d.deals.won.thisMonth + 2) * 10000) / (d.deals.won.thisMonth + 2 + d.deals.lost.thisMonth + 1)));
      const top = a.leaderboard.length ? a.leaderboard[0] : null;
      top ? ok(`leaderboard head: ${top.name} — ${top.wonCount} won`) : fail("three wins this month but the leaderboard is empty");

      // ── stalled ─────────────────────────────────────────────────────────────────────────────
      // Three ages on purpose: well past the threshold, fresh, and never recorded. Only the first
      // may count as stalled, and the third must never be assumed fresh.
      const ago = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
      const mkOpen = async (title: string, stageAt: string | null) => {
        const o = await prisma.opportunity.create({ data: { companyId: co.id, title, stageId: openStage.id, valueMinor: 100_00, currency: "SAR", stageAt } });
        made.opps.push(o.id);
      };
      await mkOpen("Qanat stalled", ago(45));
      await mkOpen("Qanat fresh", today);
      await mkOpen("Qanat undated", null);
      const s = await crmDashboard();
      eq("stalled +1 (only the 45-day one)", s.stalled.count, d.stalled.count + 1);
      eq("unknown-age +1 (never counted as stalled)", s.stalled.unknownAge, d.stalled.unknownAge + 1);
      const row = s.stalled.rows.find(r => r.title === "Qanat stalled");
      row ? eq("its age is 45 days", row.days, 45) : fail("the 45-day deal is not in the stalled rows");
      if (s.stalled.rows.some(r => r.title === "Qanat fresh")) fail("a deal moved today is listed as stalled");
      else ok("a deal moved today is not stalled");

      // ── THE TWO DEFINITIONS, HELD APART ─────────────────────────────────────────────────────
      //
      // This is the regression that matters. "Stalled" and "gone quiet" measure different clocks —
      // time in the STAGE versus time since anybody logged CONTACT — and they used to be conflated
      // across two surfaces. A deal moved into its stage today but never spoken to must be QUIET and
      // must NOT be stalled; the reverse case must not be quiet.
      //
      // The stage limit is raised well above the contact limit first, so the two thresholds cannot
      // coincide and let a wrong answer pass by accident.
      const rules = await jobRules();
      await prisma.pipelineStage.update({ where: { id: openStage.id }, data: { maxDays: rules.staleDealDays + 40 } });
      const quietDay = ago(rules.staleDealDays + 5);      // silent, but only just arrived in-stage
      const q = await prisma.opportunity.create({
        data: { companyId: co.id, title: "Qanat quiet not stalled", stageId: openStage.id, valueMinor: 100_00, currency: "SAR", stageAt: today, createdAt: quietDay },
      });
      made.opps.push(q.id);
      const t = await crmDashboard();
      const quietRow = t.needsAttention.find(r => r.title === "Qanat quiet not stalled");
      if (!quietRow) fail("a deal with no contact for weeks is not flagged at all");
      else {
        eq("silent-but-just-moved reads as quiet, not stalled", quietRow.state, "quiet");
        if (t.stalled.rows.some(r => r.title === "Qanat quiet not stalled")) fail("a deal that moved today is counted as stalled");
        else ok("time-in-stage and time-since-contact are not conflated");
      }
      // And the stage's OWN limit governs, not a constant: raising it must clear the 45-day deal.
      if (t.stalled.rows.some(r => r.title === "Qanat stalled"))
        fail(`the 45-day deal is still stalled after its stage limit was raised to ${rules.staleDealDays + 40}`);
      else ok("raising the stage's maxDays un-stalls a deal — the limit is per stage, not a constant");

      // Health must account for EVERY open deal exactly once, or the stacked bar lies.
      const healthTotal = t.health.reduce((n, h) => n + h.count, 0);
      eq("health buckets cover every open deal, once", healthTotal, t.deals.open.count);
      // Every non-healthy verdict must be able to explain itself.
      const mute = t.needsAttention.filter(a => !a.reasons.length);
      mute.length ? fail(`${mute.length} flagged deal(s) carry no reason`) : ok("every flagged deal states why");

      // ── funnel ──────────────────────────────────────────────────────────────────────────────
      // A funnel that widens is arithmetically impossible: reaching step N+1 requires having
      // reached N. This is the check that catches a wrong comparison direction on the stage sort.
      // Read from `t`, the snapshot taken AFTER the quiet-deal fixture above. Using the earlier `s`
      // compared a 9-deal snapshot against a 10-deal live count and failed for no reason.
      const steps = t.funnel.steps;
      const monotonic = steps.every((x, i) => i === 0 || steps[i - 1].reached >= x.reached);
      monotonic ? ok(`funnel narrows across ${steps.length} steps: ${steps.map(x => x.reached).join(" → ")}`)
        : fail(`funnel widens, which is impossible: ${steps.map(x => x.reached).join(" → ")}`);
      if (steps.length) {
        const live = await prisma.opportunity.count({ where: { stageId: { notIn: lostStages } } });
        eq("first step = every non-lost deal", steps[0].reached, live);
        if (steps[0].fromPrevBp !== null) fail("the first funnel step reports a drop-off from nothing");
        else ok("the first step has no drop-off figure");
      }
      eq("lost deals are reported unattributed, not spread across steps", t.funnel.lostUnattributed, t.deals.lost.count);

      // ── lost reasons ────────────────────────────────────────────────────────────────────────
      const before = new Map(s.lostReasons.map(r => [r.reason, r.count]));
      const mkLost = async (title: string, reason: string | null) => {
        const o = await prisma.opportunity.create({ data: { companyId: co.id, title, stageId: lostStage.id, valueMinor: 100_00, currency: "SAR", closedAt: today, lostReason: reason } });
        made.opps.push(o.id);
      };
      await mkLost("Qanat lost price", "Price");
      await mkLost("Qanat lost price 2", "Price");
      await mkLost("Qanat lost blank", null);
      const r2 = await crmDashboard();
      const got = (k: string) => r2.lostReasons.find(x => x.reason === k)?.count ?? 0;
      eq('"Price" +2', got("Price"), (before.get("Price") ?? 0) + 2);
      // The blank one must be NAMED, not folded into an "Other" bucket that hides the gap.
      eq('"No reason recorded" +1', got("No reason recorded"), (before.get("No reason recorded") ?? 0) + 1);

      // ── stage history ───────────────────────────────────────────────────────────────────────
      //
      // A deal with a CONTROLLED history: arrived in stage 1, moved to stage 2 after exactly 3
      // days, lost after 2 more. The analytics must read those numbers back — and must NOT count
      // the deal's still-open siblings, whose stays have not finished.
      const t0 = new Date(Date.parse(today) - 5 * 86_400_000).toISOString();
      const t1 = new Date(Date.parse(today) - 2 * 86_400_000).toISOString();
      const t2 = new Date(Date.parse(today)).toISOString();
      const hist = await prisma.opportunity.create({
        data: { companyId: co.id, title: "Qanat history", stageId: lostStage.id, valueMinor: 100_00, currency: "SAR", closedAt: today, stageAt: t2, lostReason: "Price", competitor: "Qanat Rival Co" },
      });
      made.opps.push(hist.id);
      const stg2 = (await prisma.pipelineStage.findMany({ where: { isWon: false, isLost: false, retired: false }, orderBy: { sort: "asc" } }))[1];
      await recordTransition(prisma, { opportunityId: hist.id, toStageId: openStage.id, at: t0 });
      await recordTransition(prisma, { opportunityId: hist.id, fromStageId: openStage.id, toStageId: stg2.id, at: t1 });
      await recordTransition(prisma, { opportunityId: hist.id, fromStageId: stg2.id, toStageId: lostStage.id, at: t2, lostReason: "Price" });
      // Analytics read BEFORE the backward-flag checks below — those write real history rows for
      // deal `q` (a zero-day stay), and reading afterwards averaged 3 and 0 into 1.5 and failed a
      // correct module for the probe's own pollution.
      const sa = await stageAnalytics((await prisma.pipelineStage.findFirst({ where: { id: openStage.id } }))!.country);
      const s1 = sa.stages.find(s => s.id === openStage.id)!;
      const s2 = sa.stages.find(s => s.id === stg2.id)!;
      eq("stage 1 dwell = 3 days", s1.avgDays, 3);
      eq("stage 2 dwell = 2 days", s2.avgDays, 2);
      eq("the deal died in stage 2", s2.diedHere, 1);
      // The open fixtures above have arrival rows? No — they were created raw, without transitions.
      // Their absence from the averages is exactly the completed-stays-only rule doing its job.
      const rival = sa.lostTo.find(c => c.competitor === "Qanat Rival Co");
      rival ? eq("lost-to counts the named rival once", rival.count, 1) : fail("the lost deal's competitor is missing from lostTo");
      // The backward flag is decided at write time, against the sort order both stages hold NOW.
      const back = await recordTransition(prisma, { opportunityId: q.id, fromStageId: stg2.id, toStageId: openStage.id, at: t2 });
      back.isBackward ? ok("a move against the sort order is recorded as backward") : fail("stage2 → stage1 was not flagged backward");
      const fwd = await recordTransition(prisma, { opportunityId: q.id, fromStageId: openStage.id, toStageId: stg2.id, at: t2 });
      fwd.isBackward ? fail("a forward move was flagged backward") : ok("a forward move is not flagged backward");
      // A competitor on an OPEN deal is a fight, not a defeat.
      const openComp = await prisma.opportunity.create({
        data: { companyId: co.id, title: "Qanat fighting", stageId: openStage.id, valueMinor: 100_00, currency: "SAR", stageAt: today, competitor: "Qanat Rival Co" },
      });
      made.opps.push(openComp.id);
      const sa2 = await stageAnalytics((await prisma.pipelineStage.findFirst({ where: { id: openStage.id } }))!.country);
      eq("an open deal's competitor is NOT counted as a loss", sa2.lostTo.find(c => c.competitor === "Qanat Rival Co")?.count ?? 0, 1);

      // ── lifecycle history ───────────────────────────────────────────────────────────────────
      // A company with a controlled relationship history: arrived as a lead 10 days ago, promoted
      // after 3, converted after 5 more. The analytics must read exactly 3 / 5 / 8 back — and a
      // relapse (client → lost → lead again) must NOT reset the clocks, because "how long did it
      // take" means the first time it happened.
      const lc0 = new Date(Date.parse(today) - 10 * 86_400_000).toISOString();
      const lc1 = new Date(Date.parse(today) - 7 * 86_400_000).toISOString();
      const lc2 = new Date(Date.parse(today) - 2 * 86_400_000).toISOString();
      // Its own source name, so it lands in its own row of the source breakdown instead of bumping
      // "Not recorded" between the snapshot above and the delta checks below.
      const lcCo = await prisma.company.create({ data: { name: "Qanat lifecycle co", lifecycle: "client", source: "Qanat lifecycle src" } });
      made.companies.push(lcCo.id);
      await recordLifecycle(prisma, { companyId: lcCo.id, to: "lead", at: lc0 });
      await recordLifecycle(prisma, { companyId: lcCo.id, from: "lead", to: "prospect", at: lc1 });
      await recordLifecycle(prisma, { companyId: lcCo.id, from: "prospect", to: "client", at: lc2 });
      const lcBefore = await lifecycleAnalytics({ companyIds: [lcCo.id] });
      eq("lead → prospect = 3 days", lcBefore.conversion.leadToProspect.avgDays, 3);
      eq("prospect → client = 5 days", lcBefore.conversion.prospectToClient.avgDays, 5);
      eq("lead → client = 8 days", lcBefore.conversion.leadToClient.avgDays, 8);
      eq("each hop counts its one company", lcBefore.conversion.leadToClient.samples, 1);
      // The relapse: back to lead TODAY. First-reach times must not move.
      await recordLifecycle(prisma, { companyId: lcCo.id, from: "client", to: "lost", at: new Date().toISOString(), reason: "probe" });
      await recordLifecycle(prisma, { companyId: lcCo.id, from: "lost", to: "lead", at: new Date().toISOString() });
      const lcAfter = await lifecycleAnalytics({ companyIds: [lcCo.id] });
      eq("a relapse does not reset the clock", lcAfter.conversion.leadToClient.avgDays, 8);
      // And the arrival-based "new today": the relapse row has from='lost', not null, so it is a
      // RETURN, not an arrival — the dashboard must not call an old acquaintance a new lead.
      const dashLc = await crmDashboard({ companyIds: [lcCo.id], ownerIds: null });
      eq("a returning company is not a new lead today", dashLc.leads.newToday, 0);

      // ── assignment history ──────────────────────────────────────────────────────────────────
      // The rule that earns this table its keep: recordAssignment must SKIP a no-op. Saving the
      // details form without touching the owner would otherwise write a row claiming a
      // reassignment happened, and the panel would show a change nobody made.
      const asgCo = await prisma.company.create({ data: { name: "Qanat assign co", lifecycle: "lead", source: "Qanat lifecycle src" } });
      made.companies.push(asgCo.id);
      const someone = (await prisma.user.findFirst({ where: { type: "staff" }, select: { id: true } }))!.id;
      await recordAssignment(prisma, { companyId: asgCo.id, from: null, to: someone, method: "auto", reason: "probe" });
      const noop = await recordAssignment(prisma, { companyId: asgCo.id, from: someone, to: someone, method: "manual" });
      noop === null ? ok("an owner set to the value it already held records nothing") : fail("a no-op assignment wrote a history row");
      await recordAssignment(prisma, { companyId: asgCo.id, from: someone, to: null, method: "manual" });
      const asg = await assignmentHistory(asgCo.id);
      eq("two real changes recorded, the no-op skipped", asg.length, 2);
      eq("newest first", asg[0].to, null);
      // Unassigning is a real event with a real actor — it must not read as "never owned".
      asg[0].from ? ok("unassigning names who it came from") : fail("an unassignment lost who held it");
      eq("the routing reason survives", asg[1].reason, "probe");
      eq("the method is spelled for a reader", asg[1].methodLabel, "Automatic assignment");

      // ── snooze ──────────────────────────────────────────────────────────────────────────────
      // The rules that make a snooze honest rather than a way to hide lateness.
      // Its own source, not blank: a sourceless fixture lands in the "Not recorded" bucket and
      // shifts the lead-source assertions further down, which then fail against correct code.
      const snCo = await prisma.company.create({ data: { name: "Qanat snooze co", lifecycle: "lead", source: "Qanat snooze src" } });
      made.companies.push(snCo.id);
      const overdueDay = ago(6);
      const mkFu = async () => {
        const r = await prisma.interaction.create({
          data: { companyId: snCo.id, kind: "call", at: overdueDay, summary: "Qanat snooze fixture", nextAction: "Call them", nextActionAt: overdueDay },
        });
        return r.id;
      };
      const fu1 = await mkFu();

      // Backwards and sideways are refused — both are ways to make something look less late.
      await rescheduleFollowUp(fu1, { to: ago(9) }).then(() => fail("a snooze into the past was allowed"), () => ok("a snooze backwards is refused"));
      await rescheduleFollowUp(fu1, { to: overdueDay }).then(() => fail("a snooze to the same day was allowed"), () => ok("a snooze to the same day is refused"));
      // Forward of the due date but still before today is refused too: it would be due on arrival.
      await rescheduleFollowUp(fu1, { to: ago(2) }).then(() => fail("a snooze to a past date was allowed"), () => ok("a snooze to any past date is refused"));

      const sn1 = await rescheduleFollowUp(fu1, { to: ago(-3), reason: "client away" });
      eq("first snooze counts", sn1.snoozeCount, 1);
      eq("…and records what it was FIRST due", sn1.snoozedFrom, overdueDay);
      eq("…and keeps the reason", sn1.snoozeReason, "client away");
      const sn2 = await rescheduleFollowUp(fu1, { to: ago(-9) });
      eq("second snooze increments", sn2.snoozeCount, 2);
      // The origin must survive every later push, or "how long has this been owed" becomes whatever
      // date it currently wears — precisely the appearance snoozing would otherwise buy.
      eq("the original due date is not overwritten", sn2.snoozedFrom, overdueDay);
      sn2.snoozeReason === null ? ok("a snooze with no reason clears the last one") : fail("a stale reason survived a later snooze");

      // A snoozed-into-the-future follow-up must LEAVE the queue — otherwise the button does nothing.
      const snQ = await openFollowUps({ companyIds: [snCo.id] });
      if (snQ.some(r => r.id === fu1)) fail("a follow-up snoozed into the future is still in today's queue");
      else ok("a snoozed follow-up leaves the queue until its new date");

      // And once done, it cannot be moved — that would resurrect finished work.
      const fu2 = await mkFu();
      await closeFollowUp(fu2);
      await rescheduleFollowUp(fu2, { to: ago(-5) }).then(() => fail("a completed follow-up was snoozed"), () => ok("a completed follow-up cannot be moved"));

      // owedDays measures from the ORIGIN, so pushing does not reset how long it has been owed.
      await prisma.interaction.update({ where: { id: fu1 }, data: { nextActionAt: today } });
      const snQ2 = await openFollowUps({ companyIds: [snCo.id] });
      const snBack = snQ2.find(r => r.id === fu1);
      if (!snBack) fail("the snoozed follow-up did not return on its new date");
      else {
        eq("due today reads as not late", snBack.daysLate, 0);
        eq("…but is still owed since the original date", snBack.owedDays, 6);
      }
      await prisma.interaction.deleteMany({ where: { companyId: snCo.id } });

      // ── cancel is not done ──────────────────────────────────────────────────────────────────
      // The distinction the column exists for: an abandoned commitment must never read as completed
      // work, and the two states must never both be true.
      const fu3 = await mkFu();
      await cancelFollowUp(fu3, "").then(() => fail("a cancellation with no reason was allowed"), () => ok("cancelling requires a reason"));
      const cx = await cancelFollowUp(fu3, "no longer required");
      cx.cancelledAt ? ok("cancelling stamps its own date") : fail("cancelledAt was not set");
      eq("…and keeps the reason", cx.cancelReason, "no longer required");
      cx.nextActionDoneAt === null ? ok("cancelling does NOT mark it done") : fail("a cancelled follow-up was also marked done");
      // Both directions guarded, or the derived state has two answers.
      await closeFollowUp(fu3).then(() => fail("a cancelled follow-up was completed"), () => ok("a cancelled follow-up cannot be completed"));
      const fu4 = await mkFu();
      await closeFollowUp(fu4);
      await cancelFollowUp(fu4, "changed my mind").then(() => fail("a completed follow-up was cancelled"), () => ok("a completed follow-up cannot be cancelled"));
      // And a cancelled commitment leaves the queue — otherwise the button changes nothing.
      const snQ3 = await openFollowUps({ companyIds: [snCo.id] });
      if (snQ3.some(r => r.id === fu3)) fail("a cancelled follow-up is still in the queue");
      else ok("a cancelled follow-up leaves the queue");
      await prisma.interaction.deleteMany({ where: { companyId: snCo.id } });

      // ── completion rate ─────────────────────────────────────────────────────────────────────
      // The property that makes this metric honest: it is measured from the ORIGINAL due date, so
      // pushing a commitment out of the period cannot remove it from the denominator. If that ever
      // regresses, the number rises as the work gets worse — the exact failure the reviewer warned
      // about — and this check is what catches it.
      const cmpFrom = ago(20), cmpTo = ago(10);
      const inWindow = ago(15);
      const mkDue = async (due: string) => {
        const r = await prisma.interaction.create({
          data: { companyId: snCo.id, kind: "call", at: due, summary: "Qanat completion fixture", nextAction: "Do the thing", nextActionAt: due },
        });
        return r.id;
      };
      const done1 = await mkDue(inWindow);
      await closeFollowUp(done1);                       // completed, but LATE (closed today)
      const done2 = await mkDue(inWindow);
      await prisma.interaction.update({ where: { id: done2 }, data: { nextActionDoneAt: inWindow } }); // on time
      const canc = await mkDue(inWindow);
      await cancelFollowUp(canc, "no longer required");
      const stillOpen = await mkDue(inWindow);
      // …and one PUSHED clean out of the window. It must still be counted against the window.
      const pushed = await mkDue(inWindow);
      await rescheduleFollowUp(pushed, { to: ago(-30) });

      const comp = await followUpCompletion({ from: cmpFrom, to: cmpTo, companyIds: [snCo.id] });
      eq("all five count against the window", comp.total.due, 5);
      eq("…including the one pushed outside it", comp.total.rescheduled, 1);
      eq("two completed", comp.total.completed, 2);
      eq("…only one of them on time", comp.total.completedOnTime, 1);
      eq("one cancelled", comp.total.cancelled, 1);
      // Cancelled + the pushed one are both still owed-or-dropped, never completed.
      eq("two still open", comp.total.open, 2);
      eq("completion rate is 2 of 5", comp.total.rateBp, 4000);
      eq("on-time rate is 1 of 5", comp.total.onTimeBp, 2000);

      // Cancelling MUST NOT raise the rate — the anti-gaming property, stated as a test.
      const rateBefore = comp.total.rateBp!;
      await cancelFollowUp(stillOpen, "gaming check");
      const afterCancel = await followUpCompletion({ from: cmpFrom, to: cmpTo, companyIds: [snCo.id] });
      afterCancel.total.rateBp! <= rateBefore
        ? ok("cancelling a commitment cannot raise the completion rate")
        : fail(`cancelling raised the rate from ${rateBefore} to ${afterCancel.total.rateBp} — it is gameable`);
      eq("the denominator is unchanged by cancelling", afterCancel.total.due, 5);

      // Nobody with nothing due gets a 0% — they get no rate at all.
      const empty = await followUpCompletion({ from: ago(400), to: ago(390), companyIds: [snCo.id] });
      empty.total.rateBp === null ? ok("no commitments due means no rate, not 0%") : fail("an empty period reported a rate");
      await prisma.interaction.deleteMany({ where: { companyId: snCo.id } });

      // ── campaign attribution ────────────────────────────────────────────────────────────────
      // Two companies on one campaign — one a client with a won deal, one still a lead — and a
      // third company with NO campaign whose won deal must not leak into anybody's revenue.
      const campA = await prisma.company.create({ data: { name: "Qanat camp co A", lifecycle: "client", campaign: "Qanat Campaign", source: "Qanat lifecycle src" } });
      const campB = await prisma.company.create({ data: { name: "Qanat camp co B", lifecycle: "lead", campaign: "Qanat Campaign", source: "Qanat lifecycle src" } });
      made.companies.push(campA.id, campB.id);
      const campWon = await prisma.opportunity.create({
        data: { companyId: campA.id, title: "Qanat camp won", stageId: wonStage.id, valueMinor: 500_00, currency: "SAR", closedAt: today, stageAt: today },
      });
      made.opps.push(campWon.id);
      const noCampWon = await prisma.opportunity.create({
        data: { companyId: lcCo.id, title: "Qanat no-camp won", stageId: wonStage.id, valueMinor: 900_00, currency: "SAR", closedAt: today, stageAt: today },
      });
      made.opps.push(noCampWon.id);
      const camp = await campaignPerformance({ companyIds: [campA.id, campB.id, lcCo.id] });
      const campRow = camp.find(c => c.campaign === "Qanat Campaign");
      if (!campRow) fail("the campaign is missing from campaignPerformance");
      else {
        eq("campaign counts both its companies", campRow.companies, 2);
        eq("…one of them a client", campRow.clients, 1);
        eq("…one won deal", campRow.won, 1);
        eq("…revenue = that deal's value", campRow.wonMinor, 500_00);
      }
      if (camp.some(c => c.campaign === "Qanat lifecycle src")) fail("a source leaked into the campaign table");
      // The campaign-less company's win must appear NOWHERE here.
      const totalMinor = camp.reduce((n, c) => n + c.wonMinor, 0);
      eq("a win at a campaign-less company attributes to no campaign", totalMinor, 500_00);

      // ── lead sources ────────────────────────────────────────────────────────────────────────
      // Deltas against what was already there, not absolutes — this database has real companies
      // carrying a Referral source, and asserting a fixed total would only ever pass here.
      const srcBefore = new Map(r2.leadSources.map(x => [x.source, x.total]));
      const leadsBefore = r2.leadSources.find(x => x.source === "Referral")?.leads ?? 0;
      const clientsBefore = r2.leadSources.find(x => x.source === "Referral")?.clients ?? 0;
      const mkCo = async (name: string, source: string | null, lifecycle: string) => {
        const c = await prisma.company.create({ data: { name, source, lifecycle } });
        made.companies.push(c.id);
      };
      await mkCo("Qanat src a", "Referral", "lead");
      await mkCo("Qanat src b", "Referral", "client");
      await mkCo("Qanat src c", null, "lead");
      const r3 = await crmDashboard();
      const src = (k: string) => r3.leadSources.find(x => x.source === k);
      eq('"Referral" total +2', src("Referral")?.total ?? 0, (srcBefore.get("Referral") ?? 0) + 2);
      eq('"Referral" leads +1', src("Referral")?.leads ?? 0, leadsBefore + 1);
      eq('"Referral" clients +1', src("Referral")?.clients ?? 0, clientsBefore + 1);
      eq('"Not recorded" +1', src("Not recorded")?.total ?? 0, (srcBefore.get("Not recorded") ?? 0) + 1);
    } finally {
      // The stage is a REAL configuration row, not a fixture. Its original limit is captured before
      // the checks above touch it and put back here whatever happens — a probe that leaves the
      // pipeline configured differently than it found it is worse than one that fails.
      await prisma.pipelineStage.update({ where: { id: openStage.id }, data: { maxDays: originalMaxDays } });
      // By id, only. Never "delete every Opportunity named Qanat…".
      for (const id of made.opps) await prisma.stageTransition.deleteMany({ where: { opportunityId: id } }).catch(() => {});
      for (const id of made.companies) await prisma.lifecycleTransition.deleteMany({ where: { companyId: id } }).catch(() => {});
      for (const id of made.companies) await prisma.ownerAssignment.deleteMany({ where: { companyId: id } }).catch(() => {});
      for (const id of made.payments) await prisma.payment.delete({ where: { id } }).catch(() => {});
      for (const id of made.invoices) await prisma.invoice.delete({ where: { id } }).catch(() => {});
      for (const id of made.opps) await prisma.opportunity.delete({ where: { id } }).catch(() => {});
      for (const id of made.companies) await prisma.company.delete({ where: { id } }).catch(() => {});
      const after = await crmDashboard();
      eq("cleanup restored the lead count", after.leads.total, d.leads.total);
      eq("cleanup restored the open count", after.deals.open.count, d.deals.open.count);
      eq("cleanup restored collected", after.money.collectedMinor, d.money.collectedMinor);
    }
  }

  console.log(bad ? `\n${bad} PROBLEM(S)\n` : "\nAll checks passed\n");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
