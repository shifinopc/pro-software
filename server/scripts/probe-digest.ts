/**
 * Throwaway check: the daily digest holds the right mail, sends it once, and loses nothing.
 *
 * A digest is a delivery-delaying mechanism, so every way it can go wrong is a way to LOSE somebody's
 * message. The assertions are mostly about that:
 *
 *   - owner-addressed reminders are queued, not sent, when the mode is daily
 *   - CLIENT mail is never held, whatever the mode — an invoice does not wait until tomorrow
 *   - nothing goes out before the configured local hour
 *   - one email per person, carrying every item, grouped
 *   - a second run the same day sends nothing (the unique index is the guard)
 *   - the day boundary is the ORGANISATION's timezone, not the server's
 *   - switching the mode off FLUSHES what was already queued instead of stranding it
 *   - an empty queue sends nothing at all
 *
 * Mail is captured by switching sending off and reading the disabled-mail log, so nothing is
 * transmitted — see the note in probe-owner-audience.ts.
 */
import { prisma } from "../src/db.js";
import { notifyFollowUpDue, notifyInvoiceRaised } from "../src/notify.js";
import { sendDueDigests, localParts, digestSettings } from "../src/digest.js";

const SENT: { to: string; subject: string; text: string }[] = [];
const realLog = console.log;
function captureMail() {
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    const m = /^\[mailer:disabled\] would send to (\S+) — "([^"]*)"\n([\s\S]*)$/.exec(line);
    if (m) SENT.push({ to: m[1], subject: m[2], text: m[3] });
    else realLog(...args);
  };
}
const stopCapture = () => { console.log = realLog; };
const settle = () => new Promise(r => setTimeout(r, 400));

async function sweep() {
  await prisma.digestItem.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.digestRun.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
}

/** A Date that is `hour` o'clock in the given zone today — used to drive the hour gate honestly. */
function atLocalHour(zone: string, hour: number): Date {
  for (let h = 0; h < 48; h++) {
    const d = new Date(Date.now() - 24 * 3600_000 + h * 3600_000);
    if (localParts(zone, d).hour === hour) return d;
  }
  return new Date();
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const snap = async (key: string) => (await prisma.appSetting.findUnique({ where: { key } }))?.value ?? null;
  const mailSnap = await snap("email");
  const digestSnap = await snap("notifDigest");
  const rulesSnap = await snap("notifRules");

  const setKey = async (key: string, value: any) =>
    prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  const restore = async (key: string, value: any) =>
    value ? setKey(key, value) : prisma.appSetting.deleteMany({ where: { key } });

  await setKey("email", { ...((mailSnap as any) ?? {}), enabled: false });
  captureMail();

  try {
    await sweep();
    const owner = await prisma.user.create({ data: { name: "ZZ Digest Owner", email: "zz-dg-owner@example.invalid", roleId: "sales", status: "active", type: "staff" } });
    const co = await prisma.company.create({ data: { name: "ZZ Digest Co", cr: "9994440001", lifecycle: "client", ownerId: owner.id, email: "zz-dg-client@example.invalid" } });
    await prisma.user.create({ data: { name: "ZZ Portal", email: "zz-dg-client@example.invalid", roleId: "client_admin", status: "active", type: "portal", companyId: co.id } });

    const cfg0 = await digestSettings();
    const zone = cfg0.zone;
    console.log(`organisation timezone resolved:          ${zone}${zone === "UTC" ? " (fallback)" : ""}`);

    // ── daily mode queues instead of sending ───────────────────────────────────────────────────
    await setKey("notifDigest", { mode: "daily", hour: 8 });
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: owner.id, companyId: co.id, companyName: co.name, action: "ZZ First thing", daysLate: 0 });
    notifyFollowUpDue({ ownerId: owner.id, companyId: co.id, companyName: co.name, action: "ZZ Second thing", daysLate: 4 });
    await settle();
    const queued = await prisma.digestItem.count({ where: { email: owner.email, sentAt: null } });
    console.log(`\ndaily mode: ${SENT.length} sent now, ${queued} queued`);
    if (SENT.length) fail("an owner reminder was emailed immediately despite digest mode");
    if (queued !== 2) fail(`expected 2 queued items, found ${queued}`);

    // ── client mail is NEVER held ──────────────────────────────────────────────────────────────
    SENT.length = 0;
    notifyInvoiceRaised({ companyId: co.id, number: "ZZ-INV-1", amount: 100, currency: "SAR", dueDate: "2026-09-01" });
    await settle();
    console.log(`\nclient mail still immediate:             ${SENT.some(s => s.to === "zz-dg-client@example.invalid") ? "YES" : "NO"}`);
    if (!SENT.some(s => s.to === "zz-dg-client@example.invalid")) fail("a CLIENT's invoice notice was held for the digest — indefensible");
    if (await prisma.digestItem.count({ where: { email: "zz-dg-client@example.invalid" } })) fail("client mail was put in the digest queue");

    // ── nothing goes out before the hour ───────────────────────────────────────────────────────
    SENT.length = 0;
    const before = await sendDueDigests(atLocalHour(zone, 6));
    console.log(`\nat 06:00 local (send hour 08:00):        sent=${before.sent} waiting=${before.waiting}`);
    if (before.sent) fail("the digest went out before the hour the admin chose");
    if (before.waiting !== 2) fail("the queued items were not reported as waiting");

    // ── at the hour: one email, everything in it ───────────────────────────────────────────────
    SENT.length = 0;
    const run = await sendDueDigests(atLocalHour(zone, 9));
    console.log(`\nat 09:00 local:                          sent=${run.sent} items=${run.items}`);
    if (run.sent !== 1) fail(`expected exactly 1 digest, sent ${run.sent}`);
    const mail = SENT.find(s => s.to === owner.email);
    console.log(`  one email to the owner:                ${mail ? "YES" : "NO"}`);
    if (!mail) fail("the owner received no digest");
    console.log(`  carries BOTH items:                    ${/ZZ First thing/.test(mail?.text ?? "") && /ZZ Second thing/.test(mail?.text ?? "") ? "YES" : "NO"}`);
    if (!(/ZZ First thing/.test(mail?.text ?? "") && /ZZ Second thing/.test(mail?.text ?? ""))) fail("an item was dropped from the digest");
    console.log(`  grouped under its rule:                ${/Follow-up due/i.test(mail?.text ?? "") ? "YES" : "NO"}`);
    if (!/Follow-up due/i.test(mail?.text ?? "")) fail("the digest does not say what kind of thing these are");
    console.log(`  counts them in the subject:            ${/2 things/i.test(mail?.subject ?? "") ? "YES" : "NO (" + mail?.subject + ")"}`);
    if (!/2 things/i.test(mail?.subject ?? "")) fail("the subject does not say how much is waiting");

    // ── not twice in one day ───────────────────────────────────────────────────────────────────
    SENT.length = 0;
    const again = await sendDueDigests(atLocalHour(zone, 11));
    console.log(`\nrunning again the same day:              sent=${again.sent} (${SENT.length} email(s))`);
    if (again.sent || SENT.length) fail("somebody was digested twice in one day");

    // ── the day key is the ORGANISATION's, not the server's ────────────────────────────────────
    const runs = await prisma.digestRun.findMany({ where: { email: owner.email } });
    const expectedDay = localParts(zone, atLocalHour(zone, 9)).day;
    console.log(`\nday key uses the org timezone:           ${runs[0]?.day === expectedDay ? "YES (" + runs[0]?.day + ")" : "NO (" + runs[0]?.day + " vs " + expectedDay + ")"}`);
    if (runs[0]?.day !== expectedDay) fail("the day boundary is the server's, so the digest hour drifts for the office");

    // ── switching off flushes rather than strands ──────────────────────────────────────────────
    await prisma.digestRun.deleteMany({ where: { email: owner.email } });
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: owner.id, companyId: co.id, companyName: co.name, action: "ZZ Queued then disabled", daysLate: 0 });
    await settle();
    await setKey("notifDigest", { mode: "off", hour: 8 });
    const flushed = await sendDueDigests(atLocalHour(zone, 2)); // 2am: before the hour, and it must STILL go
    console.log(`\nmode off flushes the backlog at 02:00:    sent=${flushed.sent} items=${flushed.items}`);
    if (flushed.sent !== 1) fail("turning the digest off stranded already-queued reminders — they would never be sent");
    if (!SENT.some(s => /ZZ Queued then disabled/.test(s.text))) fail("the stranded item was not in the flush");
    const leftover = await prisma.digestItem.count({ where: { email: owner.email, sentAt: null } });
    console.log(`  queue drained:                         ${leftover === 0 ? "YES" : "NO (" + leftover + " left)"}`);
    if (leftover) fail("items stayed unsent after a flush");

    // ── an empty queue is silence, not an empty email ──────────────────────────────────────────
    SENT.length = 0;
    await prisma.digestRun.deleteMany({ where: { email: owner.email } });
    const nothing = await sendDueDigests(atLocalHour(zone, 9));
    console.log(`\nempty queue sends nothing:               ${nothing.sent === 0 && SENT.length === 0 ? "YES" : "NO"}`);
    if (nothing.sent || SENT.length) fail("an empty digest was emailed");

  } finally {
    stopCapture();
    await sweep();
    await restore("email", mailSnap);
    await restore("notifDigest", digestSnap);
    await restore("notifRules", rulesSnap);
  }

  const left =
    (await prisma.digestItem.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.digestRun.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");
  const e: any = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? {};
  const d = (await prisma.appSetting.findUnique({ where: { key: "notifDigest" } }))?.value ?? null;
  console.log(`restored: email enabled=${e.enabled} passLen=${e.pass?.length ?? "n/a"} · notifDigest=${JSON.stringify(d)}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
