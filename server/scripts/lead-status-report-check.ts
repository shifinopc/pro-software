/**
 * THE LEAD REPORT'S COUNTING RULES, ON A FIXTURE WHOSE ANSWER IS KNOWN.
 *
 *   npx tsx scripts/lead-status-report-check.ts
 *
 * The query is twelve lines of arithmetic over an append-only table, and every one of its rules is
 * a judgement that a reasonable person could have made differently:
 *
 *   · a lead that bounced prospect → lead → prospect inside the range is ONE move, not two
 *   · a lead re-opened after being lost is not a NEW lead — only the arrival row is
 *   · "still open" is the state AS AT the end date, reconstructed from the history, not the
 *     company's current lifecycle — otherwise last March's figures change every day
 *   · movements outside the range do not count, including the day either side
 *
 * Each of those is wrong in a way that looks plausible on screen, so each gets a company here whose
 * contribution is known before the query runs. Six companies, one deliberate owner split.
 *
 * LOCAL DATABASES ONLY, by host: it writes companies and transitions.
 */
import { prisma } from "../src/db.js";
import { leadStatusReport } from "../src/lifecycle.js";
import { ensureLeadDeal, stagesFor } from "../src/pipeline.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ Lead Report";
const FROM = "2099-03-01";
const TO = "2099-03-31";
const at = (d: string) => `${d}T10:00:00.000Z`;

const cleanup = async () => {
  const ids = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map(c => c.id);
  if (ids.length) {
    const deals = (await prisma.opportunity.findMany({ where: { companyId: { in: ids } }, select: { id: true } })).map(d => d.id);
    if (deals.length) {
      await prisma.stageTransition.deleteMany({ where: { opportunityId: { in: deals } } });
      await prisma.opportunity.deleteMany({ where: { id: { in: deals } } });
    }
    await prisma.lifecycleTransition.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
};

(async () => {
  await cleanup();

  /** A company plus its history, in one go. */
  const make = async (label: string, moves: [string | null, string, string][]) => {
    const last = moves[moves.length - 1];
    const co = await prisma.company.create({
      data: { name: `${TAG} ${label}`, lifecycle: last[1], status: "active", country: "SA" },
    });
    for (const [from, to, day] of moves) {
      await prisma.lifecycleTransition.create({
        data: { companyId: co.id, fromLifecycle: from, toLifecycle: to, changedAt: at(day) },
      });
    }
    return co.id;
  };

  // ── the fixture, with the answer worked out by hand ───────────────────────────────────────
  // arrives in range, still a lead at the end         → new 1,                       open 1
  await make("A arrives", [[null, "lead", "2099-03-02"]]);
  // arrives in range and converts in range            → new 1, prospect 1, client 1, open 0
  await make("B converts", [[null, "lead", "2099-03-03"], ["lead", "prospect", "2099-03-10"], ["prospect", "client", "2099-03-20"]]);
  // bounces twice inside the range                    → new 1, prospect 1,            open 1
  await make("C bounces", [[null, "lead", "2099-03-04"], ["lead", "prospect", "2099-03-06"],
                           ["prospect", "lead", "2099-03-08"], ["lead", "prospect", "2099-03-12"]]);
  // arrived BEFORE the range, lost inside it          →                     lost 1,  open 0
  await make("D lost", [[null, "lead", "2099-01-05"], ["lead", "lost", "2099-03-15"]]);
  // arrived before, re-opened inside the range        →                              open 1
  await make("E reopened", [[null, "lead", "2099-01-06"], ["lead", "lost", "2099-02-01"], ["lost", "lead", "2099-03-05"]]);
  // the whole life sits AFTER the range               → nothing at all
  await make("F later", [[null, "lead", "2099-04-01"]]);
  // the day either side, which an inclusive range must include and must not overrun
  await make("G first day", [[null, "lead", "2099-03-01"]]);
  await make("H day after", [[null, "lead", "2099-04-01"]]);

  const ids = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map(c => c.id);
  const rep = await leadStatusReport({ from: FROM, to: TO, companyIds: ids });
  const t = rep.totals;

  const want = { newLeads: 4, toProspect: 2, toClient: 1, lost: 1, openAtEnd: 4 };
  const fails: string[] = [];
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (t[k] !== want[k]) fails.push(`${k}: expected ${want[k]}, got ${t[k]}`);
  }
  // Everything here is unowned, so one row — and that row must carry the totals, not half of them.
  if (rep.rows.length !== 1) fails.push(`expected one owner row, got ${rep.rows.length}`);
  else if (rep.rows[0].owner !== "Unassigned") fails.push(`the unowned row is labelled "${rep.rows[0].owner}"`);

  // ── and the rule that makes a stage a lead STATUS at all ─────────────────────────────────
  //
  // A lead with no card has no status, which is the hole this closes. Checked on the helper rather
  // than through a route: both doors a lead arrives by call it, and a route test would prove one.
  const home = (await prisma.company.findFirst({ where: { country: { not: null } }, select: { country: true } }))?.country ?? "SA";
  const open = (await stagesFor(home)).find(st => !st.isWon && !st.isLost);
  if (!open) fails.push(`no open pipeline stage for ${home} — cannot check that a lead enters the board`);
  else {
    const fresh = await prisma.company.create({ data: { name: `${TAG} I fresh`, lifecycle: "lead", status: "active", country: home } });
    const first = await ensureLeadDeal(fresh.id);
    if (!first) fails.push("a new lead was not given a pipeline card");
    else {
      const deal = await prisma.opportunity.findUnique({ where: { id: first }, select: { stageId: true, valueMinor: true } });
      if (deal?.stageId !== open.id) fails.push(`the card was raised in the wrong stage (expected ${open.name})`);
      if (deal?.valueMinor != null) fails.push("the card was given a value; a lead nobody has quoted has none");
      if (!(await prisma.stageTransition.count({ where: { opportunityId: first } }))) fails.push("the card has no stage history");
      // Twice must be once: the backfill reruns, and so does anything that retries a create.
      if (await ensureLeadDeal(fresh.id)) fails.push("a second card was raised for the same lead");
      if (await prisma.opportunity.count({ where: { companyId: fresh.id } }) !== 1) fails.push("the lead ended up with more than one card");
    }
    const client = await prisma.company.create({ data: { name: `${TAG} J client`, lifecycle: "client", status: "active", country: home } });
    if (await ensureLeadDeal(client.id)) fails.push("a client was given a lead card");
  }

  await cleanup();
  if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
  console.log(`ok: ${want.newLeads} new (bounces counted once, re-opens not new, the day after excluded), `
    + `${want.toProspect} to prospect, ${want.toClient} converted, ${want.lost} lost, ${want.openAtEnd} open as at ${TO}`
    + `; a new lead lands in "${open?.name}" once, with no value, and a client gets no card`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(String(e?.message ?? e));
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
