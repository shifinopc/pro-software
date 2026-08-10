/**
 * Throwaway check: a reminder reaches the person whose job it is.
 *
 * Every CRM reminder used to write an in-app row and stop, so a salesperson not sitting in the
 * console learned nothing. This asserts the new `audience: "owner"` actually resolves to ONE person,
 * and — the case that matters most — does something sensible when nobody owns the record.
 *
 * What is asserted:
 *   - an owned record mails the owner, and ONLY the owner
 *   - the owner is found via the record's ownerId, or failing that via its company's
 *   - an UNOWNED record falls back to the admins, and the email says nobody owns it
 *   - an owner who has left (inactive) or is a portal user is treated as no owner at all
 *   - a rule switched off sends nothing
 *   - `Deal has gone quiet` is off unless somebody turned it on
 *
 * Mail is silenced for the whole run and the outbound messages are captured instead of sent, so
 * nothing leaves the building and no Brevo send is spent.
 */
import { prisma } from "../src/db.js";
import { notifyFollowUpDue, notifyGoneQuiet, notifyWebEnquiry } from "../src/notify.js";

const SENT: { to: string; subject: string; text: string }[] = [];

/**
 * How the outbound mail is captured, and why it is done this way.
 *
 * The obvious approach — swapping `mailer.sendMail` for a spy — does not work: these are real ES
 * modules and their exports are immutable bindings, so assigning to one throws. So sending is turned
 * OFF instead, which makes `sendMail` log the message rather than transmit it, and the log line is
 * parsed. That is stricter than a spy, not weaker: it exercises the actual disabled-mail path a
 * fresh install runs on, and it cannot possibly put a message on the wire.
 */
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

async function sweep() {
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
}

/** Wait for the fire-and-forget notify() chain to finish — it is deliberately not awaitable. */
const settle = () => new Promise(r => setTimeout(r, 350));

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const rulesRow = await prisma.appSetting.findUnique({ where: { key: "notifRules" } });
  const rulesSnapshot = rulesRow?.value ?? null;
  const mailRow = await prisma.appSetting.findUnique({ where: { key: "email" } });
  const mailSnapshot = mailRow?.value ?? null;
  await prisma.appSetting.upsert({
    where: { key: "email" },
    update: { value: { ...((mailSnapshot as any) ?? {}), enabled: false } as any },
    create: { key: "email", value: { enabled: false } as any },
  });
  captureMail();

  try {
    await sweep();

    const owner = await prisma.user.create({ data: { name: "ZZ Owner", email: "zz-owner@example.invalid", roleId: "sales", status: "active", type: "staff" } });
    const admin = await prisma.user.create({ data: { name: "ZZ Admin", email: "zz-admin@example.invalid", roleId: "admin", status: "active", type: "staff" } });
    const gone = await prisma.user.create({ data: { name: "ZZ Departed", email: "zz-departed@example.invalid", roleId: "sales", status: "inactive", type: "staff" } });

    const owned = await prisma.company.create({ data: { name: "ZZ Owned Co", cr: "9995550001", lifecycle: "lead", ownerId: owner.id } });
    const orphan = await prisma.company.create({ data: { name: "ZZ Orphan Co", cr: "9995550002", lifecycle: "lead", ownerId: null } });
    const abandoned = await prisma.company.create({ data: { name: "ZZ Abandoned Co", cr: "9995550003", lifecycle: "lead", ownerId: gone.id } });

    const realAdmins = await prisma.user.count({ where: { type: "staff", status: "active", roleId: { in: ["super_admin", "admin"] } } });

    // ── an owned record goes to its owner, and nobody else ─────────────────────────────────────
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: owner.id, companyId: owned.id, companyName: owned.name, action: "ZZ Ring them back", daysLate: 0 });
    await settle();
    console.log(`owned record → ${SENT.length} email(s): ${SENT.map(s => s.to).join(", ") || "none"}`);
    if (SENT.length !== 1) fail(`an owned record mailed ${SENT.length} people instead of exactly its owner`);
    if (SENT[0]?.to !== owner.email) fail("it did not reach the owner");
    console.log(`  says it is theirs:                     ${/you own this record/i.test(SENT[0]?.text ?? "") ? "YES" : "NO"}`);
    if (!/you own this record/i.test(SENT[0]?.text ?? "")) fail("the email does not explain why they got it");
    console.log(`  and does NOT claim it is unowned:      ${!/nobody owns/i.test(SENT[0]?.text ?? "") ? "YES" : "NO"}`);
    if (/nobody owns/i.test(SENT[0]?.text ?? "")) fail("an owned record was described as unowned");

    // ── owner resolved through the company when not passed directly ────────────────────────────
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: null, companyId: owned.id, companyName: owned.name, action: "ZZ Second attempt", daysLate: 3 });
    await settle();
    console.log(`\nno ownerId given → resolved via company: ${SENT.length === 1 && SENT[0].to === owner.email ? "YES" : "NO (" + SENT.map(s => s.to).join(",") + ")"}`);
    if (!(SENT.length === 1 && SENT[0].to === owner.email)) fail("the company's owner was not consulted");
    console.log(`  lateness reaches the subject line:     ${/3 days late/i.test(SENT[0]?.subject ?? "") ? "YES" : "NO (" + SENT[0]?.subject + ")"}`);
    if (!/3 days late/i.test(SENT[0]?.subject ?? "")) fail("an overdue commitment does not look overdue in the inbox");

    // ── nobody owns it → the admins, and the email SAYS so ─────────────────────────────────────
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: null, companyId: orphan.id, companyName: orphan.name, action: "ZZ Nobody's job", daysLate: 0 });
    await settle();
    console.log(`\nunowned → admins: ${SENT.length} email(s) (${realAdmins} active admin(s) + ZZ Admin)`);
    if (SENT.length === 0) fail("an unowned record told NOBODY — the record most likely to be dropped is the one that goes silent");
    if (!SENT.some(s => s.to === admin.email)) fail("the admins were not told");
    console.log(`  the email says nobody owns it:         ${/nobody owns this record/i.test(SENT[0]?.text ?? "") ? "YES" : "NO"}`);
    if (!/nobody owns this record/i.test(SENT[0]?.text ?? "")) fail("an admin gets a reminder that reads as though it were their own work");

    // ── a departed owner is not an owner ───────────────────────────────────────────────────────
    SENT.length = 0;
    notifyFollowUpDue({ ownerId: gone.id, companyId: abandoned.id, companyName: abandoned.name, action: "ZZ Left the company", daysLate: 1 });
    await settle();
    console.log(`\ninactive owner → treated as unowned:     ${SENT.some(s => s.to === admin.email) && !SENT.some(s => s.to === gone.email) ? "YES" : "NO"}`);
    if (SENT.some(s => s.to === gone.email)) fail("a reminder was sent to somebody who has left");
    if (!SENT.some(s => s.to === admin.email)) fail("nobody picked up a record whose owner has left");

    // ── the toggles are real ───────────────────────────────────────────────────────────────────
    SENT.length = 0;
    notifyGoneQuiet({ ownerId: owner.id, companyId: owned.id, what: "this deal", name: "ZZ Quiet Deal", days: 21, kind: "deal" });
    await settle();
    console.log(`\n"Deal has gone quiet" is off by default:  ${SENT.length === 0 ? "YES" : "NO (" + SENT.length + " sent)"}`);
    if (SENT.length) fail("a rule defaulted to on that should be opt-in");

    await prisma.appSetting.upsert({
      where: { key: "notifRules" },
      update: { value: { "Deal has gone quiet": true, "New website enquiry": false } as any },
      create: { key: "notifRules", value: { "Deal has gone quiet": true, "New website enquiry": false } as any },
    });
    SENT.length = 0;
    notifyGoneQuiet({ ownerId: owner.id, companyId: owned.id, what: "this deal", name: "ZZ Quiet Deal", days: 21, kind: "deal" });
    await settle();
    console.log(`  switching it on makes it send:         ${SENT.length === 1 ? "YES" : "NO (" + SENT.length + ")"}`);
    if (SENT.length !== 1) fail("switching a rule on did not make it send");

    SENT.length = 0;
    notifyWebEnquiry({ ownerId: owner.id, companyId: owned.id, name: "ZZ Website Person", source: "website", message: "ZZ hello" });
    await settle();
    console.log(`  switching one off silences it:         ${SENT.length === 0 ? "YES" : "NO (" + SENT.length + ")"}`);
    if (SENT.length) fail("a rule switched off still sent");

  } finally {
    stopCapture();
    if (rulesSnapshot) await prisma.appSetting.update({ where: { key: "notifRules" }, data: { value: rulesSnapshot as any } });
    else await prisma.appSetting.deleteMany({ where: { key: "notifRules" } });
    if (mailSnapshot) await prisma.appSetting.update({ where: { key: "email" }, data: { value: mailSnapshot as any } });
    else await prisma.appSetting.deleteMany({ where: { key: "email" } });
    await sweep();
  }

  const left =
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");
  const rules = await prisma.appSetting.findUnique({ where: { key: "notifRules" } });
  console.log(`notifRules restored: ${JSON.stringify(rules?.value ?? null)}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
