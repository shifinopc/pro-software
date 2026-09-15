/**
 * Unbilled Work, Client Document Chaser, and SLA Rescue — against their own fixtures.
 *
 *   1. Unbilled: a delivered request for a service outside the plan, and an accepted quotation, are each
 *      found and turned into a draft invoice; an invoiced request and a covered one are not flagged; a
 *      renewal with a recorded government fee is found.
 *   2. Chaser: a request missing a document gets reminder 1 on day 2, not twice, reminder 2 on day 5,
 *      lands in the request thread, and closes itself when the client uploads; a renewal held for a
 *      passport too close to expiry escalates to a call; the client's upload ticks the officer's step.
 *   3. SLA: a step whose history says it will overrun is flagged and moved (the new person is told);
 *      a proposal that went stale moves nothing; steps with a deactivated account are moved; a late
 *      ordinary task is reported.
 * Probe users get a role of their own so no real officer is ever proposed or handed work.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import { runUnbilled, act as unbilledAct } from "../src/agent-unbilled.js";
import { runChaser, act as chaserAct, LADDER } from "../src/agent-chaser.js";
import { runSlaRescue, act as slaAct } from "../src/agent-sla.js";
import { attachToRequest } from "../src/request-docs.js";

const CO = "ZS Ops Agents Probe Co";
const TAG = "zs-ops-probe";
const ROLE = "zs_probe_role";
let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);
const admin = { id: null, name: "Probe Admin", role: "super_admin" };
const DAY = 86_400_000;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const day = (n: number) => iso(n * DAY).slice(0, 10);

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CO } });
  if (co) {
    const invs = await prisma.invoice.findMany({ where: { companyId: co.id } });
    await prisma.payment.deleteMany({ where: { invoiceId: { in: invs.map(i => i.id) } } });
    await prisma.invoice.deleteMany({ where: { companyId: co.id } });
    await prisma.quotation.deleteMany({ where: { companyId: co.id } });
    const reqs = await prisma.serviceRequest.findMany({ where: { companyId: co.id } });
    await prisma.requestAttachment.deleteMany({ where: { requestId: { in: reqs.map(r => r.id) } } });
    await prisma.serviceRequestMessage.deleteMany({ where: { requestId: { in: reqs.map(r => r.id) } } });
    await prisma.serviceRequest.deleteMany({ where: { companyId: co.id } });
    await prisma.task.deleteMany({ where: { companyId: co.id } });
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } } });
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: tpls.map(t => t.id) } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
  await prisma.workflowInstance.deleteMany({ where: { id: { in: runs.map(r => r.id) } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: tpls.map(t => t.id) } } });
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: "ZS Ops Probe" } } });
  const users = await prisma.user.findMany({ where: { email: { endsWith: "@zs-ops-probe.test" } } });
  await prisma.fileAsset.deleteMany({ where: { OR: [{ uploadedBy: { in: users.map(u => u.id) } }, { name: { startsWith: TAG } }] } });
  await prisma.task.deleteMany({ where: { assigneeId: { in: users.map(u => u.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
  await prisma.mailLog.deleteMany({ where: { to: { endsWith: "@zs-ops-probe.test" } } }).catch(() => {});
}

let tasksBefore = new Set<string>();
async function main() {
  await sweep();
  tasksBefore = new Set((await prisma.agentTask.findMany({ select: { id: true } })).map(t => t.id));
  const co = await prisma.company.create({ data: { name: CO, country: "SA", lifecycle: "client", email: "client@zs-ops-probe.test" } as any });
  const tpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} renewal`, graph: { nodes: [], edges: [] } } as any });

  // ── 1. unbilled work ──
  console.log("1. unbilled work");
  const svc = await prisma.serviceItem.create({ data: { name: "ZS Ops Probe Exit Visa", govFee: 300, serviceFee: 200 } });
  const run1 = await prisma.workflowInstance.create({ data: { templateId: tpl.id, title: "Exit visa — Ravi", companyId: co.id, clientName: CO, status: "completed", startedAt: iso(-10 * DAY), completedAt: iso(-2 * DAY), variables: {} } });
  const rq1 = await prisma.serviceRequest.create({ data: { number: "REQ-ZSOPS-1", companyId: co.id, clientName: CO, type: svc.name, status: "resolved", serviceItemId: svc.id, workflowInstanceId: run1.id, acceptedAt: iso(-10 * DAY) } });
  const run2 = await prisma.workflowInstance.create({ data: { templateId: tpl.id, title: "Exit visa — Nora", companyId: co.id, clientName: CO, status: "completed", startedAt: iso(-9 * DAY), completedAt: iso(-3 * DAY), variables: {} } });
  const rq2 = await prisma.serviceRequest.create({ data: { number: "REQ-ZSOPS-2", companyId: co.id, clientName: CO, type: svc.name, status: "resolved", serviceItemId: svc.id, workflowInstanceId: run2.id, acceptedAt: iso(-9 * DAY) } });
  await prisma.invoice.create({ data: { number: "ZSOPS-INV-1", companyId: co.id, clientName: CO, amount: 500, status: "pending", date: day(-8), services: "ZS Ops Probe Exit Visa — Nora" } });
  const q = await prisma.quotation.create({ data: { number: "ZSOPS-QT-1", companyId: co.id, clientName: CO, service: "Work visa", amount: 1150, subtotalMinor: 100000, vatMinor: 15000, totalMinor: 115000, vatRateBp: 1500, items: [{ name: "Work visa", units: 1, price: 1000 }] as any, status: "accepted", date: day(-5) } });
  const renewalTpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} iqama`, graph: { nodes: [], edges: [] } } as any });
  const run3 = await prisma.workflowInstance.create({ data: { templateId: renewalTpl.id, title: "Iqama Renewal — Majed", companyId: co.id, clientName: CO, status: "completed", startedAt: iso(-20 * DAY), completedAt: iso(-1 * DAY), variables: { _trigger: "document_expiry", docType: "Iqama", person: "Majed Omar", feeAmount: 650 } } });

  await runUnbilled();
  const f = (key: string) => prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "unbilled-work", dedupeKey: key } } });
  const fr1 = await f(`request:${rq1.id}`);
  (fr1?.status === "review" && (fr1.output as any)?.amount === 500) ? ok("delivered request outside the plan found: 300 government + 200 service") : fail(`request finding: ${JSON.stringify(fr1)}`);
  !(await f(`request:${rq2.id}`)) ? ok("the request that already has an invoice naming the service is not flagged") : fail("invoiced request flagged");
  (await f(`quote:${q.id}`))?.status === "review" ? ok("accepted quotation with no invoice found") : fail("quotation not found");
  const fr3 = await f(`run:${run3.id}`);
  fr3?.status === "review" && (fr3.output as any)?.amount === 650 ? ok("finished renewal with a recorded government fee of 650 found") : fail(`renewal finding: ${JSON.stringify(fr3?.output)}`);
  await unbilledAct(fr1!.id, "invoice", {}, admin);
  const inv1 = await prisma.invoice.findFirst({ where: { companyId: co.id, notes: { contains: "Unbilled Work" } } });
  inv1?.status === "draft" && (inv1.items as any[]).length === 2 ? ok(`draft invoice ${inv1.number} raised with both lines`) : fail(`invoice: ${JSON.stringify(inv1)}`);
  await unbilledAct((await f(`quote:${q.id}`))!.id, "invoice", {}, admin);
  const inv2 = await prisma.invoice.findFirst({ where: { quotationId: q.id } });
  inv2?.totalMinor === 115000 && (await prisma.quotation.findUnique({ where: { id: q.id } }))?.status === "invoiced" ? ok("quotation invoiced with its own figures, and marked invoiced") : fail(`quote invoice: ${JSON.stringify(inv2)}`);
  await runUnbilled();
  (await f(`request:${rq1.id}`))?.status === "done" ? ok("a second pass does not raise the invoiced work again") : fail("re-raised");
  await unbilledAct(fr3!.id, "dismiss", { reason: "Included in the retainer" }, admin);
  await runUnbilled();
  (await f(`run:${run3.id}`))?.status === "dismissed" ? ok("work dismissed as covered stays dismissed") : fail("dismissed finding reopened");

  // ── 2. client document chaser ──
  console.log("\n2. client document chaser");
  const docsSvc = await prisma.serviceItem.create({ data: { name: "ZS Ops Probe Family Visit", govFee: 0, serviceFee: 0, requiredDocs: [{ key: "passport", label: "Passport copy", required: true }, { key: "photo", label: "Photo", required: true }] as any } });
  const portalUser = await prisma.user.create({ data: { name: "Probe Client", email: "portal@zs-ops-probe.test", type: "portal", companyId: co.id, status: "active", roleId: "client_admin" } as any });
  const stepTpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} visit`, graph: { nodes: [], edges: [] } } as any });
  const visitRun = await prisma.workflowInstance.create({ data: { templateId: stepTpl.id, title: "Family visit", companyId: co.id, clientName: CO, status: "running", variables: {} } });
  const collect = await prisma.workflowTask.create({ data: { instanceId: visitRun.id, nodeId: "collect", title: "Collect documents", status: "active", checklist: [{ key: "passport", label: "Passport copy", required: true }, { key: "photo", label: "Photo", required: true }], checklistState: { passport: { received: true } } } });
  const rq3 = await prisma.serviceRequest.create({ data: { number: "REQ-ZSOPS-3", companyId: co.id, clientName: CO, type: docsSvc.name, serviceItemId: docsSvc.id, workflowInstanceId: visitRun.id, status: "accepted", lastClientMsgAt: iso(-3 * DAY), acceptedAt: iso(-3 * DAY) } });
  await prisma.requestAttachment.create({ data: { requestId: rq3.id, docKey: "passport", label: "Passport copy", path: "/x", name: "passport.pdf" } });
  const emp = await prisma.employee.create({ data: { name: "Salim Probe", companyId: co.id, nationality: "IN", status: "valid" } as any });
  const iq = await prisma.document.create({ data: { companyId: co.id, employeeId: emp.id, person: emp.name, docType: "Iqama", docNumber: "2999999991", expiryDate: day(20), status: "expiring", daysLeft: 20 } as any });
  await prisma.document.create({ data: { companyId: co.id, employeeId: emp.id, person: emp.name, docType: "Passport", docNumber: "PZ1", expiryDate: day(90), status: "valid", daysLeft: 90 } as any });
  await prisma.document.create({ data: { companyId: co.id, employeeId: emp.id, person: emp.name, docType: "Health Insurance", docNumber: "HZ1", expiryDate: day(300), status: "valid", daysLeft: 300 } as any });

  const c = (key: string) => prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "document-chaser", dedupeKey: key } } });
  await runChaser({ onlyCompanyId: co.id, ignoreHours: true });
  let w = await c(`request:${rq3.id}`);
  const rem = () => (((w?.output as any)?.reminders ?? []) as any[]);
  w?.status === "watching" && rem().length === 1 && rem()[0].rung === LADDER[0] ? ok(`day 3: reminder 1 sent for the missing photo, to ${rem()[0].to.join(", ")}`) : fail(`first reminder: ${JSON.stringify(w)}`);
  const msgs = await prisma.serviceRequestMessage.findMany({ where: { requestId: rq3.id } });
  msgs.length === 1 && /Photo/.test(msgs[0].body) ? ok("the reminder also appears in the request's thread in the portal") : fail(`thread: ${JSON.stringify(msgs)}`);
  await runChaser({ onlyCompanyId: co.id, ignoreHours: true });
  w = await c(`request:${rq3.id}`);
  rem().length === 1 ? ok("running again the same day sends nothing more") : fail("sent twice");
  await runChaser({ onlyCompanyId: co.id, ignoreHours: true, now: Date.now() + 3 * DAY });
  w = await c(`request:${rq3.id}`);
  rem().length === 2 && rem()[1].rung === LADDER[1] ? ok("day 6: reminder 2") : fail(`second reminder: ${JSON.stringify(rem())}`);
  let held = await c(`held:${iq.id}:Passport`);
  const heldReminders = ((held?.output as any)?.reminders ?? []) as any[];
  held?.status === "watching" && heldReminders.length >= 1 && /Passport valid for at least 6 months/.test(held.summary ?? "")
    ? ok(`an Iqama held for 40 days is reminded first, not escalated on discovery: "${held.summary}"`) : fail(`held renewal: ${JSON.stringify(held)}`);
  await runChaser({ onlyCompanyId: co.id, ignoreHours: true, now: Date.now() + 11 * DAY });
  held = await c(`held:${iq.id}:Passport`);
  held?.status === "review" ? ok(`12 days after it was first found and still not provided → officer told to call: "${held.summary}"`) : fail(`held escalation: ${JSON.stringify(held)}`);

  // The client uploads the photo in the portal.
  const asset = await prisma.fileAsset.create({ data: { kind: "document", name: `${TAG}-photo.jpg`, path: "/uploads/x.jpg", size: 10, private: false, uploadedBy: portalUser.id, at: iso(0) } as any });
  const up = await attachToRequest(rq3.id, [{ fileId: asset.id, key: "photo", label: "Photo" }], portalUser.id);
  const step = await prisma.workflowTask.findUnique({ where: { id: collect.id } });
  up.attached.length === 1 && (step?.checklistState as any)?.photo?.received === true && (step?.checklistState as any)?.photo?.verified === false
    ? ok("the portal upload attaches to the request and ticks Photo as received (not verified) on the officer's step") : fail(`upload: ${JSON.stringify({ up, state: step?.checklistState })}`);
  const stranger = await prisma.fileAsset.create({ data: { kind: "document", name: `${TAG}-other.jpg`, path: "/uploads/y.jpg", size: 10, private: false, uploadedBy: null, at: iso(0) } as any });
  (await attachToRequest(rq3.id, [{ fileId: stranger.id, key: "passport" }], portalUser.id)).attached.length === 0 ? ok("a file the client did not upload cannot be attached by quoting its id") : fail("foreign file attached");
  await runChaser({ onlyCompanyId: co.id, ignoreHours: true, now: Date.now() + 3 * DAY });
  w = await c(`request:${rq3.id}`);
  w?.status === "done" && (w.decision as any)?.auto ? ok(`closes itself once provided: "${w.summary}"`) : fail(`after upload: ${JSON.stringify(w)}`);
  await chaserAct(held!.id, "done", { note: "Called — renewing the passport" }, admin);
  (await c(`held:${iq.id}:Passport`))?.status === "done" ? ok("the officer marks the held renewal as called") : fail("could not close");

  // ── 3. SLA rescue ──
  console.log("\n3. SLA rescue and workload");
  const mk = (name: string, status = "active") => prisma.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zs-ops-probe.test`, type: "staff", status, roleId: ROLE } as any });
  const [a, b, gone] = [await mk("ZS Probe Officer A"), await mk("ZS Probe Officer B"), await mk("ZS Probe Officer Gone", "inactive")];
  const slaTpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} sla`, graph: { nodes: [], edges: [] } } as any });
  const slaRun = await prisma.workflowInstance.create({ data: { templateId: slaTpl.id, title: "Work permit — Probe", companyId: co.id, clientName: CO, status: "running", variables: {} } });
  for (let i = 0; i < 6; i++) {
    await prisma.workflowTask.create({ data: { instanceId: slaRun.id, nodeId: "submit", title: "Submit on Qiwa", status: "done", createdAt: iso(-(30 + i) * DAY), completedAt: iso(-(30 + i) * DAY + 48 * 3_600_000) } });
  }
  const risky = await prisma.workflowTask.create({ data: { instanceId: slaRun.id, nodeId: "submit", title: "Submit on Qiwa", status: "active", assigneeId: a.id, assignee: a.name, assigneeRole: ROLE, createdAt: iso(-2 * 3_600_000), dueDate: iso(20 * 3_600_000), slaHours: 22, slaState: "on_track" } });
  for (let i = 0; i < 9; i++) await prisma.workflowTask.create({ data: { instanceId: slaRun.id, nodeId: `other${i}`, title: `Other step ${i}`, status: "active", assigneeId: a.id, assignee: a.name, assigneeRole: ROLE, createdAt: iso(-i * 3_600_000) } });
  const orphan = await prisma.workflowTask.create({ data: { instanceId: slaRun.id, nodeId: "orphan", title: "Left behind", status: "active", assigneeId: gone.id, assignee: gone.name, assigneeRole: ROLE, createdAt: iso(-DAY) } });
  await prisma.task.create({ data: { title: "Collect originals from client", companyId: co.id, assignee: a.name, assigneeId: a.id, dueDate: day(-3), status: "todo" } as any });

  await runSlaRescue();
  const s = (key: string) => prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "sla-rescue", dedupeKey: key } } });
  const risk = await s(`risk:${risky.id}`);
  risk?.status === "review" && (risk.output as any)?.toUserId === b.id ? ok(`flagged before the SLA job would: "${risk.summary?.slice(0, 110)}…"`) : fail(`likely breach: ${JSON.stringify(risk)}`);
  (await s(`overload:${a.id}`))?.status === "review" ? ok("Officer A with 10 live steps against a median of 5 is flagged as overloaded") : fail("overload not flagged");
  (await s(`orphaned:${gone.id}`))?.status === "review" ? ok("a step left with a deactivated account is flagged") : fail("orphan not flagged");
  (await s(`late:${a.id}`))?.status === "review" ? ok("an ordinary task 3 days past due is reported") : fail("late task not reported");

  // A stale proposal moves nothing.
  await prisma.workflowTask.update({ where: { id: risky.id }, data: { assigneeId: b.id, assignee: b.name } });
  try { await slaAct(risk!.id, "move", {}, admin); fail("a stale proposal moved work"); }
  catch (e: any) { /changed hands/.test(e.message) ? ok("once someone else holds the step, the old proposal moves nothing") : fail(e.message); }
  await prisma.workflowTask.update({ where: { id: risky.id }, data: { assigneeId: a.id, assignee: a.name } });
  try { await slaAct(risk!.id, "move", {}, { id: null, name: "Officer", role: "pro_officer" }); fail("an officer moved work"); }
  catch (e: any) { e.status === 403 ? ok("only an admin can move work") : fail(e.message); }
  const moved = await slaAct(risk!.id, "move", {}, admin);
  (await prisma.workflowTask.findUnique({ where: { id: risky.id } }))?.assigneeId === b.id && (await prisma.workflowLog.findFirst({ where: { instanceId: slaRun.id, action: "step.reassigned" } }))
    ? ok(`moved to Officer B and logged on the run: "${moved.message}"`) : fail("move did not happen");
  await slaAct((await s(`orphaned:${gone.id}`))!.id, "move", {}, admin);
  const o2 = await prisma.workflowTask.findUnique({ where: { id: orphan.id } });
  o2?.assigneeId && [a.id, b.id].includes(o2.assigneeId) ? ok(`the orphaned step went to an active colleague in the same role (${o2.assignee})`) : fail(`orphan: ${o2?.assigneeId}`);

  // restore
  await sweep();
  await prisma.agentTask.deleteMany({ where: { id: { notIn: [...tasksBefore] }, agent: { in: ["unbilled-work", "document-chaser", "sla-rescue"] } } });
  await prisma.appSetting.deleteMany({ where: { key: "agentRuns" } });
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.agentTask.deleteMany({ where: { id: { notIn: [...tasksBefore] }, agent: { in: ["unbilled-work", "document-chaser", "sla-rescue"] } } }).catch(() => {}); await prisma.$disconnect(); process.exit(1); });
void fs; void path;
