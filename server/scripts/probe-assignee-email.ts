/**
 * Throwaway check: a PRO officer finally gets email about their own work.
 *
 * `staffRecipients` is admins-only and every other audience resolves to the client or the record's
 * owner, so an officer could run every government step in the product and never receive one message
 * about any of it. This asserts the new `audience: "assignee"` closes that, and closes it safely.
 *
 * What is asserted:
 *   - a pro_officer receives assignee-addressed mail, and only they do
 *   - an accountant does too — it is about the role holding the task, not a new hard-coded list
 *   - officers still do NOT receive admin-wide mail; this widened one channel, not all of them
 *   - a task with nobody on it falls back to the admins, and says nobody is assigned
 *   - resolveStaffByName refuses to guess between two people with the same name
 *   - an inactive assignee is treated as nobody
 *   - the least-loaded picker counts by id, so two people sharing a name are not merged
 *
 * Mail is captured via the disabled-mail log — nothing is transmitted.
 */
import { prisma } from "../src/db.js";
import { notifyTaskAssigned, notifyTaskLate, notifySlaBreach } from "../src/notify.js";
import { resolveStaffByName, pickAssignee } from "../src/workflow.js";

const SENT: { to: string; subject: string; text: string }[] = [];
const realLog = console.log;
const captureMail = () => {
  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    const m = /^\[mailer:disabled\] would send to (\S+) — "([^"]*)"\n([\s\S]*)$/.exec(line);
    if (m) SENT.push({ to: m[1], subject: m[2], text: m[3] });
    else realLog(...args);
  };
};
const stopCapture = () => { console.log = realLog; };
const settle = () => new Promise(r => setTimeout(r, 400));

async function sweep() {
  const wf = await prisma.workflowTask.findMany({ where: { title: { startsWith: "ZZ " } }, select: { id: true } });
  if (wf.length) await prisma.workflowTask.deleteMany({ where: { id: { in: wf.map(w => w.id) } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const mailSnap = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? null;
  await prisma.appSetting.upsert({
    where: { key: "email" },
    update: { value: { ...((mailSnap as any) ?? {}), enabled: false } as any },
    create: { key: "email", value: { enabled: false } as any },
  });
  captureMail();

  try {
    await sweep();
    const officer = await prisma.user.create({ data: { name: "ZZ Officer", email: "zz-officer@example.invalid", roleId: "pro_officer", status: "active", type: "staff" } });
    const acct = await prisma.user.create({ data: { name: "ZZ Accountant", email: "zz-acct@example.invalid", roleId: "accountant", status: "active", type: "staff" } });
    const admin = await prisma.user.create({ data: { name: "ZZ Admin", email: "zz-admin@example.invalid", roleId: "admin", status: "active", type: "staff" } });
    const left = await prisma.user.create({ data: { name: "ZZ Departed", email: "zz-departed@example.invalid", roleId: "pro_officer", status: "inactive", type: "staff" } });

    // ── the officer hears about their own work ────────────────────────────────────────────────
    SENT.length = 0;
    notifyTaskAssigned({ assigneeId: officer.id, title: "ZZ Submit the Qiwa transfer", clientName: "ZZ Client", why: "it was waiting for a pro_officer" });
    await settle();
    console.log(`pro_officer gets assigned work:          ${SENT.length === 1 && SENT[0].to === officer.email ? "YES" : "NO (" + SENT.map(s => s.to).join(",") + ")"}`);
    if (!(SENT.length === 1 && SENT[0].to === officer.email)) fail("a pro_officer still cannot be emailed about their own task");
    console.log(`  and nobody else:                       ${SENT.length === 1 ? "YES" : "NO"}`);
    if (SENT.length !== 1) fail("assignee mail was broadcast beyond the assignee");
    console.log(`  says why they got it:                  ${/assigned to you/i.test(SENT[0]?.text ?? "") ? "YES" : "NO"}`);
    if (!/assigned to you/i.test(SENT[0]?.text ?? "")) fail("the email does not explain why it arrived");

    // ── it is about the role holding the task, not a new hard-coded list ──────────────────────
    SENT.length = 0;
    notifyTaskLate({ assigneeId: acct.id, title: "ZZ Reconcile the fee", state: "breached", hoursOver: 5 });
    await settle();
    console.log(`\nan accountant too (not a new allowlist): ${SENT.length === 1 && SENT[0].to === acct.email ? "YES" : "NO"}`);
    if (!(SENT.length === 1 && SENT[0].to === acct.email)) fail("only some roles can be an assignee — the fix was hard-coded, not general");
    console.log(`  lateness is in the subject:            ${/past its deadline/i.test(SENT[0]?.subject ?? "") ? "YES" : "NO (" + SENT[0]?.subject + ")"}`);
    if (!/past its deadline/i.test(SENT[0]?.subject ?? "")) fail("a breach does not look like one in the inbox");

    // ── but admin-wide mail did NOT widen ─────────────────────────────────────────────────────
    SENT.length = 0;
    notifySlaBreach({ title: "ZZ Some other queue broke", detail: "ZZ across the book" });
    await settle();
    const gotAdminMail = SENT.map(s => s.to);
    console.log(`\nofficer excluded from admin-wide mail:   ${!gotAdminMail.includes(officer.email) ? "YES" : "NO"}`);
    if (gotAdminMail.includes(officer.email)) fail("widening the assignee channel also opened every admin notification to officers");
    if (!gotAdminMail.includes(admin.email)) fail("admins stopped getting the admin-wide notification");

    // ── nobody assigned → admins, and it says so ──────────────────────────────────────────────
    SENT.length = 0;
    notifyTaskAssigned({ assigneeId: null, title: "ZZ Nobody's step", why: "nothing picked it up" });
    await settle();
    console.log(`\nunassigned → admins:                     ${SENT.some(s => s.to === admin.email) ? "YES" : "NO"}`);
    if (!SENT.some(s => s.to === admin.email)) fail("a step with nobody on it told nobody");
    console.log(`  says nobody is assigned:               ${/nobody is assigned/i.test(SENT[0]?.text ?? "") ? "YES" : "NO"}`);
    if (!/nobody is assigned/i.test(SENT[0]?.text ?? "")) fail("an admin cannot tell this is not their own work");

    // ── an inactive assignee is nobody ────────────────────────────────────────────────────────
    SENT.length = 0;
    notifyTaskAssigned({ assigneeId: left.id, title: "ZZ Left the company", why: "they have gone" });
    await settle();
    console.log(`\ninactive assignee → admins:              ${SENT.some(s => s.to === admin.email) && !SENT.some(s => s.to === left.email) ? "YES" : "NO"}`);
    if (SENT.some(s => s.to === left.email)) fail("work was emailed to somebody who has left");

    // ── the name bridge refuses to guess ──────────────────────────────────────────────────────
    const one = await resolveStaffByName("ZZ Officer");
    console.log(`\nresolveStaffByName, one match:           ${one?.id === officer.id ? "YES" : "NO"}`);
    if (one?.id !== officer.id) fail("an unambiguous name did not resolve");
    const twin = await prisma.user.create({ data: { name: "ZZ Officer", email: "zz-twin@example.invalid", roleId: "pro_officer", status: "active", type: "staff" } });
    const two = await resolveStaffByName("ZZ Officer");
    console.log(`  two people, same name → refuses:       ${two === null ? "YES" : "NO (picked " + two?.id + ")"}`);
    if (two !== null) fail("it guessed between two people with the same name — one would get the other's work");
    console.log(`  "Unassigned" is not a person:          ${(await resolveStaffByName("Unassigned")) === null ? "YES" : "NO"}`);
    if ((await resolveStaffByName("Unassigned")) !== null) fail('"Unassigned" resolved to a user');

    // ── the picker counts by id, so twins are not merged ──────────────────────────────────────
    const inst = await prisma.workflowInstance.findFirst({ select: { id: true } });
    if (inst) {
      for (let i = 0; i < 3; i++) {
        await prisma.workflowTask.create({ data: { instanceId: inst.id, nodeId: "zz", nodeType: "task", title: `ZZ Load ${i}`, status: "active", assignee: "ZZ Officer", assigneeId: officer.id } });
      }
      const next = await pickAssignee("pro_officer");
      console.log(`\nleast-loaded picks the FREE twin:        ${next?.id === twin.id ? "YES" : "NO (" + next?.name + "/" + next?.id + ")"}`);
      if (next?.id !== twin.id) fail("load was counted by name, so two people sharing one were merged into a single queue");
    } else {
      console.log(`\n(no workflow instance to hang load tasks on — load-balancing check skipped)`);
    }

  } finally {
    stopCapture();
    await sweep();
    if (mailSnap) await prisma.appSetting.update({ where: { key: "email" }, data: { value: mailSnap as any } });
    else await prisma.appSetting.deleteMany({ where: { key: "email" } });
  }

  const leftovers =
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.workflowTask.count({ where: { title: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");
  const e: any = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? {};
  console.log(`email config intact: host=${e.host} enabled=${e.enabled} passLen=${e.pass?.length ?? "n/a"}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
