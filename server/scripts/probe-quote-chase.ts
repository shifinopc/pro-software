/**
 * Throwaway check for chasing quotations nobody has answered.
 *
 * The assertions that matter are about saying the RIGHT thing ONCE:
 *   - only a `sent` quotation is chased; a draft is not the client's problem yet, and an accepted,
 *     rejected or invoiced one has already been answered
 *   - the wait is measured from when it was SENT, not from the issue date printed on it
 *   - each of the three moments — no answer, about to lapse, lapsed — fires exactly once, however
 *     many times the hourly tick runs
 *   - answering it stops the chasing
 *   - a quotation with no validity date still gets the first chase, and no expiry notice it cannot
 *     honestly make
 *   - the thresholds come from settings, so a firm can change them without a deploy
 *   - the deal is NEVER auto-lost: a client going quiet is not a decision
 *
 * Own client, own quotations. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { chaseQuotations } from "../src/jobs.js";
import { salesRules, SALES_RULE_DEFAULTS } from "../src/salesrules.js";

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString();
const dayOnly = (offset: number) => day(offset).slice(0, 10);

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.quotation.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.quotation.deleteMany({ where: { number: { startsWith: "ZZ-" } } });
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: "quote:" }, title: { contains: "ZZ-" } } });
  await prisma.pipelineStage.deleteMany({ where: { country: "ZZ" } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const rules = await salesRules();
  console.log(`rules in force: chase after ${rules.quoteChaseDays}d · warn ${rules.quoteExpiryWarnDays}d before lapse · expiry notice ${rules.quoteExpiryNotice}`);
  if (rules.quoteChaseDays !== SALES_RULE_DEFAULTS.quoteChaseDays) fail("the default chase window is not what the module says it is");

  const co = await prisma.company.create({ data: { name: "ZZ Quote Co", cr: "9990009999", country: "SA", lifecycle: "client" } });
  const mk = (number: string, over: any = {}) => prisma.quotation.create({
    data: {
      number, companyId: co.id, clientName: co.name, service: "ZZ work", amount: 1000,
      status: "sent", date: dayOnly(-40), sentAt: day(-10), ...over,
    },
  });

  // Silent for ten days, no validity date at all.
  const silent = await mk("ZZ-SILENT");
  // Sent yesterday — inside the window, must be left alone.
  const fresh = await mk("ZZ-FRESH", { sentAt: day(-1) });
  // Valid until the day after tomorrow: about to lapse.
  const soon = await mk("ZZ-SOON", { validUntil: dayOnly(2) });
  // Validity already passed.
  const gone = await mk("ZZ-LAPSED", { validUntil: dayOnly(-2) });
  // Not sent, or already answered — none of these are anybody's problem.
  const draft = await mk("ZZ-DRAFT", { status: "draft" });
  const accepted = await mk("ZZ-ACCEPTED", { status: "accepted" });
  // Dated 40 days ago but only SENT yesterday: the whole reason sentAt exists.
  const lateSend = await mk("ZZ-LATESEND", { date: dayOnly(-40), sentAt: day(-1) });

  const notesFor = (q: string) => prisma.notification.findMany({ where: { dedupeKey: { contains: q } } });

  const r = await chaseQuotations();
  console.log(`\nfirst run: scanned ${r.scanned} · chased ${r.chased} · expiring ${r.expiringSoon} · lapsed ${r.lapsed}`);
  for (const d of r.details) console.log(`  ${d}`);

  console.log(`\nonly sent quotations scanned:            ${r.scanned === 5 ? "YES" : "NO (" + r.scanned + " of 5)"}`);
  if (r.scanned !== 5) fail(`scanned ${r.scanned} — a draft or an answered quotation was picked up`);
  if ((await notesFor(draft.id)).length) fail("a DRAFT quotation was chased");
  if ((await notesFor(accepted.id)).length) fail("an ACCEPTED quotation was chased");

  console.log(`silent one chased:                       ${(await notesFor(silent.id)).length === 1 ? "YES" : "NO"}`);
  if ((await notesFor(silent.id)).length !== 1) fail("a quotation unanswered for 10 days raised nothing");

  console.log(`one sent yesterday left alone:           ${(await notesFor(fresh.id)).length === 0 ? "YES" : "NO"}`);
  if ((await notesFor(fresh.id)).length) fail("a quotation sent yesterday was already being chased");

  // The point of sentAt: dated 40 days ago, sent yesterday, must be treated as yesterday's.
  console.log(`dated 40d ago but sent yesterday:        ${(await notesFor(lateSend.id)).length === 0 ? "left alone — YES" : "CHASED — NO"}`);
  if ((await notesFor(lateSend.id)).length) fail("the wait was measured from the issue date, not from when it was sent");

  const soonNote = (await notesFor(soon.id))[0];
  console.log(`about to lapse flagged:                  ${soonNote ? "YES — " + soonNote.title : "NO"}`);
  if (!soonNote || !/about to lapse/i.test(soonNote.title)) fail("a quotation days from lapsing was not flagged as such");

  const goneNote = (await notesFor(gone.id))[0];
  console.log(`lapsed one flagged as lapsed:            ${goneNote ? "YES — " + goneNote.title : "NO"}`);
  if (!goneNote || !/lapsed/i.test(goneNote.title)) fail("a lapsed quotation was not reported");

  // ── each moment once ───────────────────────────────────────────────────────────────────────
  const before = (await prisma.notification.count({ where: { dedupeKey: { startsWith: "quote:" } } }));
  const again = await chaseQuotations();
  const after = (await prisma.notification.count({ where: { dedupeKey: { startsWith: "quote:" } } }));
  console.log(`\na second tick adds nothing:              ${after === before ? "YES" : "NO (" + before + " → " + after + ")"}`);
  if (after !== before) fail("the same quotation was chased twice");
  if (again.chased || again.expiringSoon || again.lapsed) fail("the second run reported work it did not do");

  // ── answering it stops the chasing ─────────────────────────────────────────────────────────
  await prisma.quotation.update({ where: { id: silent.id }, data: { status: "accepted" } });
  const r3 = await chaseQuotations();
  console.log(`accepting takes it out of the scan:      ${r3.scanned === 4 ? "YES" : "NO (" + r3.scanned + ")"}`);
  if (r3.scanned !== 4) fail("an accepted quotation is still being scanned");

  // ── the deal is never auto-lost ────────────────────────────────────────────────────────────
  for (const s of [{ name: "ZZ Open", sort: 0 }, { name: "ZZ Won", sort: 1, isWon: true }, { name: "ZZ Lost", sort: 2, isLost: true }])
    await prisma.pipelineStage.create({ data: { ...s, country: "ZZ" } });
  const openStage = (await prisma.pipelineStage.findFirst({ where: { country: "ZZ", isWon: false, isLost: false } }))!;
  const deal = await prisma.opportunity.create({
    data: { companyId: co.id, title: "ZZ deal behind a lapsed quote", stageId: openStage.id, country: "ZZ", quotationId: gone.id },
  });
  await chaseQuotations();
  const stillOpen = await prisma.opportunity.findUnique({ where: { id: deal.id } });
  console.log(`a lapsed quote does NOT lose the deal:   ${stillOpen!.stageId === openStage.id ? "YES" : "NO"}`);
  if (stillOpen!.stageId !== openStage.id) fail("a lapsed quotation silently marked the deal lost — nobody decided that");

  // ── the thresholds are settings ────────────────────────────────────────────────────────────
  await prisma.appSetting.upsert({
    where: { key: "salesRules" },
    create: { key: "salesRules", value: { quoteChaseDays: 30 } },
    update: { value: { quoteChaseDays: 30 } },
  });
  const widened = await salesRules();
  console.log(`\nsettings change the window:              ${widened.quoteChaseDays === 30 ? "YES (30d)" : "NO (" + widened.quoteChaseDays + ")"}`);
  if (widened.quoteChaseDays !== 30) fail("a configured chase window was ignored");
  const nonsense = { quoteChaseDays: -5 };
  await prisma.appSetting.update({ where: { key: "salesRules" }, data: { value: nonsense } });
  const clamped = await salesRules();
  console.log(`a nonsense value is clamped, not obeyed: ${clamped.quoteChaseDays >= 1 ? "YES (" + clamped.quoteChaseDays + "d)" : "NO"}`);
  if (clamped.quoteChaseDays < 1) fail("a negative setting would make the job fire on everything, every hour");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.appSetting.deleteMany({ where: { key: "salesRules" } });
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: "quote:" } } });
  await prisma.opportunity.deleteMany({ where: { companyId: co.id } });
  await prisma.quotation.deleteMany({ where: { companyId: co.id } });
  await prisma.pipelineStage.deleteMany({ where: { country: "ZZ" } });
  await prisma.contact.deleteMany({ where: { companyId: co.id } });
  await prisma.company.delete({ where: { id: co.id } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.quotation.count({ where: { number: { startsWith: "ZZ-" } } })) +
    (await prisma.appSetting.count({ where: { key: "salesRules" } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
