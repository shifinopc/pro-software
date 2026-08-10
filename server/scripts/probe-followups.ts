/**
 * Throwaway check for CRM phase 3: the contact log, the queue it produces, and the chasing.
 *
 * The assertions that matter are about NOT nagging and NOT losing things:
 *   - an entry with no next action never appears in the queue at all
 *   - half a commitment is refused: an action with no date, or a date with no action
 *   - a follow-up due today appears; an overdue one says how late, and keeps appearing
 *   - the same due follow-up is announced ONCE a day, however many times the tick runs
 *   - ticking it off removes it from the queue and stops the alert
 *   - a commitment on a company that was written off, or on a deal already closed, is not work
 *   - a deal nobody has touched raises the silence alert — but NOT if it already has a follow-up,
 *     because two alerts for one thing is how a notification list stops being read
 *
 * Own client, own deal, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { openFollowUps, logInteraction, closeFollowUp } from "../src/interactions.js";
import { checkFollowUps, STALE_DEAL_DAYS } from "../src/jobs.js";

const COUNTRY = "ZZ";
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const co = await prisma.company.create({ data: { name: "ZZ FollowUp Co", cr: "0000", country: COUNTRY, lifecycle: "client" } });
  const dead = await prisma.company.create({ data: { name: "ZZ Written Off Co", cr: "0001", country: COUNTRY, lifecycle: "lost", lostReason: "probe" } });
  const notes = () => prisma.notification.findMany({ where: { OR: [{ message: { contains: "ZZ " } }, { title: { contains: "ZZ " } }] } });
  const mine = async (on?: string) => (await openFollowUps({ on })).filter(f => f.companyId === co.id || f.companyId === dead.id);

  // ── an entry with no next action is history, not work ──────────────────────────────────────
  await logInteraction({ companyId: co.id, kind: "call", summary: "ZZ introductory call", at: new Date().toISOString() });
  console.log(`a note with no next step stays out:     ${(await mine()).length === 0 ? "YES" : "NO"}`);
  if ((await mine()).length) fail("an interaction with no next action appeared in the follow-up queue");

  // ── half a commitment is refused ───────────────────────────────────────────────────────────
  for (const [what, data] of [
    ["an action with no date", { nextAction: "ZZ send the quote" }],
    ["a date with no action", { nextActionAt: day(1) }],
  ] as const) {
    let refused = false;
    try { await logInteraction({ companyId: co.id, ...data }); } catch { refused = true; }
    console.log(`refuses ${what.padEnd(24)}: ${refused ? "YES" : "NO"}`);
    if (!refused) fail(`${what} was accepted — it would sit in no queue or say nothing`);
  }

  // ── due today, and overdue ─────────────────────────────────────────────────────────────────
  const dueToday = await logInteraction({ companyId: co.id, kind: "call", summary: "ZZ pricing call", nextAction: "ZZ send the quote", nextActionAt: day(0) });
  const late = await logInteraction({ companyId: co.id, kind: "meeting", summary: "ZZ site visit", nextAction: "ZZ chase the CR copy", nextActionAt: day(-3) });
  const future = await logInteraction({ companyId: co.id, kind: "email", summary: "ZZ intro mail", nextAction: "ZZ follow up next week", nextActionAt: day(7) });

  let queue = await mine();
  console.log(`\nqueue today: ${queue.length} (expect 2 — today's and the late one, not next week's)`);
  if (queue.length !== 2) fail(`the queue has ${queue.length} entries, expected 2`);
  const lateRow = queue.find(f => f.id === late.id);
  console.log(`…the overdue one says how late:          ${lateRow?.overdue ? lateRow.daysLate + " days" : "NO"}`);
  if (!lateRow?.overdue || lateRow.daysLate !== 3) fail(`overdue entry reports ${lateRow?.daysLate} days late, expected 3`);
  if (queue.some(f => f.id === future.id)) fail("a follow-up dated next week is already in today's queue");

  // ── a commitment to a company nobody is pursuing is not work ───────────────────────────────
  await logInteraction({ companyId: dead.id, kind: "call", summary: "ZZ old call", nextAction: "ZZ chase them", nextActionAt: day(-1) });
  console.log(`a written-off company is not chased:     ${(await mine()).every(f => f.companyId !== dead.id) ? "YES" : "NO"}`);
  if ((await mine()).some(f => f.companyId === dead.id)) fail("a company marked lost is still generating work");

  // ── the tick announces each due one once a day ─────────────────────────────────────────────
  let r = await checkFollowUps();
  const after1 = (await notes()).length;
  console.log(`\ntick: due ${r.due} · overdue ${r.overdue} → ${after1} notifications`);
  if (r.overdue !== 1) fail(`the tick reported ${r.overdue} overdue, expected 1`);
  await checkFollowUps();
  const after2 = (await notes()).length;
  console.log(`…a second tick adds nothing:             ${after2 === after1 ? "YES" : "NO (" + after1 + " → " + after2 + ")"}`);
  if (after2 !== after1) fail("the same follow-up was announced twice in one day");

  // ── ticking it off takes it out of the queue ───────────────────────────────────────────────
  await closeFollowUp(dueToday.id);
  queue = await mine();
  console.log(`\nclosing removes it from the queue:       ${queue.every(f => f.id !== dueToday.id) ? "YES" : "NO"}`);
  if (queue.some(f => f.id === dueToday.id)) fail("a closed follow-up is still in the queue");
  const closedAgain = await closeFollowUp(dueToday.id);
  console.log(`…closing twice keeps the first time:     ${closedAgain.nextActionDoneAt ? "YES" : "NO"}`);

  // ── a deal nobody has touched ──────────────────────────────────────────────────────────────
  for (const s of [
    { name: "ZZ Open", sort: 0, probabilityBp: 2000 },
    { name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
    { name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
  ]) await prisma.pipelineStage.create({ data: { ...s, country: COUNTRY } });
  const stages = await prisma.pipelineStage.findMany({ where: { country: COUNTRY } });
  const openStage = stages.find(s => s.name === "ZZ Open")!;
  const wonStage = stages.find(s => s.name === "ZZ Won")!;

  // A second company, so the deal is not shielded by the follow-ups already open on the first.
  const quiet = await prisma.company.create({ data: { name: "ZZ Quiet Co", cr: "0002", country: COUNTRY, lifecycle: "client" } });
  const old = new Date(Date.now() - (STALE_DEAL_DAYS + 5) * 86400000).toISOString();
  const deal = await prisma.opportunity.create({
    data: { companyId: quiet.id, title: "ZZ silent deal", stageId: openStage.id, country: COUNTRY, createdAt: old, stageAt: old },
  });
  r = await checkFollowUps();
  const silence = (await prisma.notification.findMany({ where: { dedupeKey: { contains: deal.id } } })).length;
  console.log(`\nsilent deal raises the nudge:            ${silence === 1 ? "YES" : "NO (" + silence + ")"}`);
  if (silence !== 1) fail("a deal with no contact for weeks raised no alert");

  // Speaking to them stops it.
  await logInteraction({ companyId: quiet.id, kind: "call", summary: "ZZ caught up" });
  const before = (await prisma.notification.findMany({ where: { dedupeKey: { contains: deal.id } } })).length;
  await checkFollowUps();
  const afterTalk = (await prisma.notification.findMany({ where: { dedupeKey: { contains: deal.id } } })).length;
  console.log(`…and speaking to them stops it:          ${afterTalk === before ? "YES" : "NO"}`);
  if (afterTalk !== before) fail("a deal that was just spoken about is still being nudged about");

  // A won deal is nobody's problem.
  await prisma.opportunity.update({ where: { id: deal.id }, data: { stageId: wonStage.id } });
  await prisma.interaction.deleteMany({ where: { companyId: quiet.id } });
  await prisma.notification.deleteMany({ where: { dedupeKey: { contains: deal.id } } });
  await prisma.opportunity.update({ where: { id: deal.id }, data: { createdAt: old } });
  await checkFollowUps();
  const wonNudge = (await prisma.notification.findMany({ where: { dedupeKey: { contains: deal.id } } })).length;
  console.log(`a WON deal is not chased:                ${wonNudge === 0 ? "YES" : "NO (" + wonNudge + ")"}`);
  if (wonNudge) fail("a closed deal is still being chased for contact");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  const ids = [co.id, dead.id, quiet.id];
  await prisma.notification.deleteMany({ where: { OR: [{ message: { contains: "ZZ " } }, { title: { contains: "ZZ " } }, { dedupeKey: { contains: deal.id } }] } });
  await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.pipelineStage.deleteMany({ where: { country: COUNTRY } });
  await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.interaction.count({ where: { summary: { startsWith: "ZZ " } } })) +
    (await prisma.pipelineStage.count({ where: { country: COUNTRY } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
