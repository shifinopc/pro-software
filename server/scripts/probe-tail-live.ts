/**
 * Throwaway check that the end of the workflow works, by running one employee all the way to
 * confirmed.
 *
 * Nothing had ever reached the end. Twenty-one instances, none past probation, because a 90-day
 * delay does not mature inside anybody's test window — so the last five steps had been read and
 * reasoned about and never executed. That is precisely where the unexercised bugs live: the Notify
 * step in particular was configured for the first time only recently and had never sent anything.
 *
 * The delay is skipped with the engine's own force-resume rather than by shortening the delay in the
 * template. Editing the real workflow to make a test pass leaves either a 90-day probation set to
 * minutes, or a template that gets edited back afterwards and so was never the thing under test.
 *
 * Takes a Saudi national, which is the shortest way to probation — no visa, no permit, no Iqama.
 * Own run, own user, own records. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "tl-probe@example.invalid";
const PW = "TlProbe!2026";
const TITLE = "ZS tail probe";
const WHO = "ZS Tail Probe Person";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: TITLE }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.document.deleteMany({ where: { person: WHO } });
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.notification.deleteMany({ where: { title: "Notify Employee" } }).catch(() => {});
  await prisma.mailLog.deleteMany({ where: { to: "tl@example.invalid" } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

const STEPS: Record<string, any> = {
  profile: { applicant: WHO, nationality: "Saudi", mobile: "+966500000001", email: "tl@example.invalid",
    hiringType: "saudi_national", employmentType: "permanent", profession: "Analyst", department: "Finance",
    reportingManager: "Ops Lead", expectedJoining: "2026-09-01", currentLocationStatus: "inside_ksa" },
  collect: { documentsVerified: "pass" },
  insurance_task: { policyNumber: "POL-TL-1", policyExpiry: "2027-09-01" },
  contract: { contractNumber: "QC-TL-1", contractEnd: "2027-09-01" },
  payroll: { gosiOutcome: "registered", gosiNumber: "GOSI-TL-1" },
  joined: { employeeJoined: "yes" },
  prob_review: { probationOutcome: "yes", probationNotes: "Met every objective in the review", probationEffective: "2026-12-01" },
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "TL Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  const started = await call("POST", "/api/workflow/instances", tok, {
    templateId: tpl!.id, title: TITLE, companyId: co?.id ?? null, clientName: co?.name ?? null,
  });
  const id = started.body?.id ?? started.body?.instance?.id;
  if (!id) { console.log("could not start a run"); await sweep(); process.exit(1); }

  const live = () => prisma.workflowTask.findMany({ where: { instanceId: id, status: "active" } });
  const complete = async (t: any) => {
    const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
    const checklistState: any = {};
    for (const i of items) checklistState[i.key ?? i.label] = { received: true, verified: true };
    return call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
      variables: STEPS[t.nodeId] ?? {},
      ...(t.nodeType === "approval" ? { outcome: "approve" } : {}),
      ...(items.length ? { checklistState } : {}),
    });
  };

  // ── everything up to probation ────────────────────────────────────────────────────────────────
  const walked: string[] = [];
  for (let i = 0; i < 40; i++) {
    const tasks = await live();
    if (!tasks.length) break;                       // parked in the delay, or finished
    for (const t of tasks) {
      const r = await complete(t);
      if (r.status >= 400) { fail(`"${t.title}" refused — ${String(r.body?.error).slice(0, 110)}`); await sweep(); console.log("\n1 problem(s)"); process.exit(1); }
      walked.push(t.nodeId);
    }
  }
  console.log(`walked ${walked.length} steps to probation:`);
  console.log(`  ${walked.join(" → ")}`);

  const parked = await prisma.workflowInstance.findUnique({ where: { id }, select: { variables: true, status: true } });
  const delays: any = (parked?.variables as any)?._delays ?? {};
  console.log(`\nthe run is waiting out probation:           ${delays.probation ? `YES (until ${String(delays.probation).slice(0, 10)})` : "NO"}`);
  if (!delays.probation) fail("the run never reached the probation delay, so the tail is not what is being tested");

  // ── skip the ninety days ──────────────────────────────────────────────────────────────────────
  const resumed = await call("POST", `/api/workflow/instances/${id}/resume`, tok, {});
  console.log(`forcing the wait is accepted:              ${resumed.status === 200 ? "YES" : "NO (" + resumed.status + ")"}`);
  if (resumed.status !== 200) { fail(`could not force the delay — ${String(resumed.body?.error).slice(0, 110)}`); await sweep(); process.exit(1); }
  const forced = await prisma.workflowLog.count({ where: { instanceId: id, action: "delay.forced" } });
  console.log(`  ...and recorded as forced, not elapsed:  ${forced ? "YES" : "NO"}`);
  if (!forced) fail("a delay was skipped with nothing in the run log saying a person did it");

  // ── the five steps that had never run ─────────────────────────────────────────────────────────
  const tail: string[] = [];
  for (let i = 0; i < 12; i++) {
    const tasks = await live();
    if (!tasks.length) break;
    for (const t of tasks) {
      const r = await complete(t);
      if (r.status >= 400) { fail(`"${t.title}" refused — ${String(r.body?.error).slice(0, 110)}`); break; }
      tail.push(t.nodeId);
    }
  }
  console.log(`\nthe tail, executed for the first time:     ${tail.join(" → ") || "nothing ran"}`);

  const fin = await prisma.workflowInstance.findUnique({ where: { id }, select: { status: true } });
  const logs = await prisma.workflowLog.findMany({ where: { instanceId: id }, select: { action: true, nodeId: true, detail: true } });
  const reached = (n: string) => logs.some(l => l.nodeId === n);
  console.log(`  Employee Confirmation Approval ran:      ${tail.includes("confirm_appr") ? "YES" : "NO"}`);
  console.log(`  Notify Employee ran:                     ${reached("notify") ? "YES" : "NO"}`);
  console.log(`  the run ended at Employee Confirmed:     ${reached("end_ok") ? "YES" : "NO"}`);
  console.log(`  the run is marked completed:             ${fin?.status === "completed" ? "YES" : "NO (" + fin?.status + ")"}`);
  if (!tail.includes("confirm_appr")) fail("the confirmation approval never ran");
  if (!reached("notify")) fail("Notify Employee still has not run");
  if (!reached("end_ok")) fail("no run has ever reached Employee Confirmed");
  if (fin?.status !== "completed") fail(`the run finished in state "${fin?.status}"`);

  // ── and what the notification actually was ────────────────────────────────────────────────────
  //
  // The node is configured with a channel, a recipient and a subject. What the engine does with them
  // is the thing nobody could see until this ran.
  const note = await prisma.notification.findFirst({ where: { title: "Notify Employee" }, orderBy: { id: "desc" }, select: { type: true, title: true, message: true } });
  console.log("");
  console.log(`Notify Employee produced:                  ${note ? `a ${note.type} notification` : "NOTHING"}`);
  if (note) console.log(`  "${String(note.message ?? "").slice(0, 96)}"`);
  if (!note) fail("the notify step logged that it ran and produced no notification at all");

  // AND WHO IT WENT TO. The node names a channel, a recipient and a subject; the engine used to read
  // none of them and log that it had notified anyway. `{{ email }}` was not a placeholder — there was
  // no interpolation in this engine at all — so it was the literal recipient string.
  const mail = await prisma.mailLog.findFirst({ where: { kind: "workflow" }, orderBy: { id: "desc" }, select: { to: true, subject: true, status: true, error: true } });
  console.log("");
  console.log(`the employee was actually written to:      ${mail ? `${mail.to} — "${mail.subject}" (${mail.status})` : "NO — nothing was addressed to anybody"}`);
  if (!mail) fail("the notify step reported success and sent nothing — no mail was even attempted");
  else {
    if (mail.to !== "tl@example.invalid") fail(`the notification went to "${mail.to}" — the recipient template was not filled in from the run`);
    if (!/employment is confirmed/i.test(String(mail.subject))) fail(`the subject was "${mail.subject}" rather than the one the step configures`);
    // "skipped" is the right outcome on an installation with sending switched off, and is a
    // different fact from "failed" — the probe must not demand that email be enabled to pass.
    if (!["sent", "skipped"].includes(String(mail.status))) fail(`the mail was recorded as "${mail.status}": ${mail.error ?? ""}`);
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
