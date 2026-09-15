/**
 * The six agents added beside document intake, everything except model calls.
 *
 *   1. Renewal preparation ticks what records prove, flags the rest, drafts the fee message, and
 *      sending it closes the task.
 *   2. Request triage matches service and employee, finds the missing document, proposes a quote
 *      for a service outside the plan, and the quote action creates a draft.
 *   3. Collections matches a payment notice to the invoice it names and records it on confirm;
 *      a reminder for a client who pays on time gains the "probably missed" line.
 *   4. Data quality finds a missing ID, a duplicate ID and an expired document with no renewal, and
 *      closes the missing-ID finding once it is fixed.
 *   5. Nitaqat advisor sees a Saudi exit dropping the band and suggests keeping them or hiring one.
 *   6. The console assistant refuses without a model; settings refuse non-admins.
 *
 * Own fixtures, all deleted. Agent settings and run times are restored. Findings the daily agents
 * raise about OTHER local data during the run are deleted too.
 */
import { prisma } from "../src/db.js";
import { runRenewalPrep, act as renewalAct } from "../src/agent-renewal-prep.js";
import { runTriage, act as triageAct } from "../src/agent-triage.js";
import { runCollections, act as collectionsAct, reminderNote } from "../src/agent-collections.js";
import { runDataQuality } from "../src/agent-data-quality.js";
import { runNitaqat } from "../src/agent-nitaqat.js";
import { ask } from "../src/agent-assistant.js";
import { updateAgent } from "../src/agents.js";
import { saveAgentSetting, AgentActionError } from "../src/agent-core.js";

const CO = "ZS Agents Probe Co";
const TAG = "zs-agents-probe";
let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);
const admin = { id: null, name: "Probe Admin", role: "super_admin" };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CO } });
  if (co) {
    const invs = await prisma.invoice.findMany({ where: { companyId: co.id }, select: { id: true } });
    await prisma.payment.deleteMany({ where: { invoiceId: { in: invs.map(i => i.id) } } });
    await prisma.invoice.deleteMany({ where: { companyId: co.id } });
    await prisma.quotation.deleteMany({ where: { companyId: co.id } });
    const reqs = await prisma.serviceRequest.findMany({ where: { companyId: co.id }, select: { id: true } });
    await prisma.requestAttachment.deleteMany({ where: { requestId: { in: reqs.map(r => r.id) } } });
    await prisma.serviceRequestMessage.deleteMany({ where: { requestId: { in: reqs.map(r => r.id) } } });
    await prisma.serviceRequest.deleteMany({ where: { companyId: co.id } });
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { companyId: co.id } });
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.agentTask.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: TAG } });
  await prisma.serviceItem.deleteMany({ where: { name: "ZS Probe Visa Service" } });
  const sets = await prisma.workforceBandSet.findMany({ where: { name: TAG }, select: { id: true } });
  await prisma.workforceBand.deleteMany({ where: { setId: { in: sets.map(s => s.id) } } });
  await prisma.workforceBandSet.deleteMany({ where: { name: TAG } });
}

async function main() {
  await sweep();
  const settingsBefore = await prisma.appSetting.findMany({ where: { key: { in: ["agents", "agentRuns"] } } });
  const tasksBefore = new Set((await prisma.agentTask.findMany({ select: { id: true } })).map(t => t.id));

  const set = await prisma.workforceBandSet.create({ data: { name: TAG, country: "SA", counting: [{ key: "disability", label: "Saudi with a disability", when: { nationality: "national" }, countsAs: 400 }] as any } });
  await prisma.workforceBand.createMany({ data: [
    { setId: set.id, country: "SA", name: "Red", minBp: 0, maxBp: 1000, sort: 0 },
    { setId: set.id, country: "SA", name: "Green", minBp: 1000, maxBp: 2500, sort: 1 },
    { setId: set.id, country: "SA", name: "Platinum", minBp: 2500, sort: 2 },
  ] });
  const co = await prisma.company.create({ data: { name: CO, country: "SA", lifecycle: "client", email: "probe-client@example.test", workforceBandSetId: set.id } as any });
  const emp = (name: string, nat: string, extra: any = {}) => prisma.employee.create({ data: { name, companyId: co.id, nationality: nat, workCountry: "SA", status: "valid", ...extra } as any });
  const ravi = await emp("Ravi Shankar", "IN", { govId: "2444444441" });
  const saudis = [await emp("Fahad Saud", "SA", { govId: "1444444441" }), await emp("Nora Ali", "SA", { govId: "1444444442" }), await emp("Majed Omar", "SA", { govId: "1444444443", exitStatus: "exit_requested", exitDate: day(20) })];
  for (let i = 0; i < 5; i++) await emp(`Expat Worker ${i}`, "BD", { govId: `24444444${50 + i}` });
  const blank = await emp("No Id Person", "PK");
  await emp("Dup One", "PH", { govId: "2444444441" }); // same ID as Ravi

  // ── 1. renewal preparation ──
  console.log("1. renewal preparation");
  const doc = (docType: string, expiry: string, number: string, employeeId: string | null = ravi.id) =>
    prisma.document.create({ data: { companyId: co.id, employeeId, person: employeeId ? "Ravi Shankar" : CO, docType, docNumber: number, expiryDate: expiry, status: "valid", daysLeft: 1 } as any });
  const iqama = await doc("Iqama", day(20), "2444444441");
  await doc("Passport", day(700), "P9988776");
  await doc("Health Insurance", day(-3), "HI-1");
  await doc("Work Permit", day(200), "WP-1");
  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG, graph: { nodes: [], edges: [] } } as any });
  const run = await prisma.workflowInstance.create({ data: { templateId: tpl.id, title: "Iqama renewal — Ravi Shankar", companyId: co.id, clientName: CO, status: "running",
    variables: { _trigger: "document_expiry", documentId: iqama.id, employeeId: ravi.id, person: "Ravi Shankar", docType: "Iqama", fee: 650 } } });
  const gate = await prisma.workflowTask.create({ data: { instanceId: run.id, nodeId: "prereq", title: "Prerequisite Check", status: "active",
    checklist: [{ key: "passport_6m", label: "Passport valid 6 months", required: true }, { key: "insurance_current", label: "Health insurance current", required: true }, { key: "permit_current", label: "Work permit current", required: true }, { key: "no_fines", label: "No fines", required: true }] } });
  await runRenewalPrep(run.id);
  const prep = await prisma.agentTask.findFirst({ where: { agent: "renewal-prep", refId: run.id } });
  const state = ((await prisma.workflowTask.findUnique({ where: { id: gate.id } }))?.checklistState ?? {}) as any;
  const checks = ((prep?.output as any)?.checks ?? []) as any[];
  const st = (k: string) => checks.find(c => c.key === k)?.state;
  state.passport_6m?.received && state.permit_current?.received ? ok("passport and work permit ticked from records") : fail(`ticks wrong: ${JSON.stringify(state)}`);
  !state.insurance_current?.received && st("insurance_current") === "flag" ? ok("expired insurance flagged, not ticked") : fail("insurance not flagged");
  !state.passport_6m?.verified ? ok("nothing marked verified — that stays with the officer") : fail("agent verified an item");
  st("no_fines") === "unknown" ? ok("fines left to the government portal") : fail("fines not unknown");
  const draft = (prep?.output as any)?.draft;
  /approve/i.test(draft?.body ?? "") && /insurance/i.test(draft?.body ?? "") ? ok("fee message drafted, asking the client to arrange insurance") : fail(`draft: ${draft?.body}`);
  const sent = await renewalAct(prep!.id, "send", {}, admin);
  (await prisma.agentTask.findUnique({ where: { id: prep!.id } }))?.status === "done" ? ok(`send closes the task (${sent.message})`) : fail("send did not close the task");
  await runRenewalPrep(run.id);
  (await prisma.agentTask.count({ where: { agent: "renewal-prep", refId: run.id } })) === 1 ? ok("a second pass does not prepare the same step again") : fail("prepared twice");

  // ── 2. request triage ──
  console.log("\n2. request triage");
  const svc = await prisma.serviceItem.create({ data: { name: "ZS Probe Visa Service", govFee: 2000, serviceFee: 500, requiredDocs: [{ key: "passport", label: "Passport copy", required: true }, { key: "photo", label: "Photo", required: true }] as any } });
  const rq = await prisma.serviceRequest.create({ data: { number: "REQ-ZSPROBE", companyId: co.id, clientName: CO, type: "ZS Probe Visa Service", message: "Please process for employee ID 2444444441", status: "open", lastClientMsgAt: new Date().toISOString() } });
  await prisma.requestAttachment.create({ data: { requestId: rq.id, docKey: "passport", label: "Passport copy", path: "/x", name: "p.pdf" } });
  await runTriage(rq.id);
  const tri = await prisma.agentTask.findFirst({ where: { agent: "request-triage", refId: rq.id, status: "review" } });
  const to = (tri?.output ?? {}) as any;
  to.service?.id === svc.id ? ok("service matched on the request type") : fail(`service: ${JSON.stringify(to.service)}`);
  to.employee?.id === ravi.id ? ok("employee matched by the ID number in the message") : fail(`employee: ${JSON.stringify(to.employee)}`);
  (to.checks ?? []).some((c: any) => c.label === "Photo" && c.state === "flag") && /Photo/.test(to.draft?.body ?? "") ? ok("missing photo found and asked for in the reply") : fail("missing doc not caught");
  to.proposal?.kind === "quote" ? ok("not in the client's plan → proposes a quotation") : fail(`proposal: ${JSON.stringify(to.proposal)}`);
  await triageAct(tri!.id, "quote", {}, admin);
  const q = await prisma.quotation.findFirst({ where: { companyId: co.id } });
  q && q.status === "draft" && q.amount === 2500 ? ok(`draft quotation ${q.number} for 2,500`) : fail(`quotation: ${JSON.stringify(q)}`);

  // ── 3. collections ──
  console.log("\n3. collections");
  const inv = (number: string, amount: number, status: string, due: string) => prisma.invoice.create({ data: { number, companyId: co.id, clientName: CO, amount, status, dueDate: due, date: due } });
  const a = await inv("ZSP-INV-A", 1000, "overdue", day(-10));
  const b = await inv("ZSP-INV-B", 500, "unpaid", day(-5));
  const notice = await prisma.serviceRequest.create({ data: { number: "REQ-ZSPAY", companyId: co.id, clientName: CO, type: "Payment notification", status: "open",
    message: "Client reports a payment of 500\nMethod: bank transfer\nReference: TRX-778\nPaid on: " + day(-1) + "\nAgainst invoices: ZSP-INV-B" } });
  await runCollections(notice.id);
  const col = await prisma.agentTask.findFirst({ where: { agent: "collections", refId: notice.id } });
  const al = ((col?.output as any)?.match?.allocations ?? []) as any[];
  al.length === 1 && al[0].invoiceId === b.id && (col?.output as any)?.match?.confidence === "high" ? ok("notice matched to the invoice it named, high confidence") : fail(`match: ${JSON.stringify((col?.output as any)?.match)}`);
  (await prisma.payment.count({ where: { invoiceId: b.id } })) === 0 ? ok("no payment written before the accountant confirms") : fail("payment written early");
  await collectionsAct(col!.id, "record", {}, admin);
  const pay = await prisma.payment.findFirst({ where: { invoiceId: b.id } });
  pay?.amount === 500 && pay.reference === "TRX-778" && (await prisma.invoice.findUnique({ where: { id: b.id } }))?.status === "paid" ? ok("confirm records 500 with the reference and settles the invoice") : fail(`payment: ${JSON.stringify(pay)}`);
  for (let i = 0; i < 3; i++) {
    const h = await inv(`ZSP-OLD-${i}`, 100, "paid", day(-60 - i * 30));
    await prisma.payment.create({ data: { number: `ZSP-RCP-${i}`, invoiceId: h.id, invoiceNumber: h.number, companyId: co.id, amount: 100, date: day(-60 - i * 30) } });
  }
  await saveAgentSetting("collections", { enabled: true });
  const note = await reminderNote({ id: a.id, number: a.number, companyId: co.id, rung: 7, currency: "SAR" });
  /usually paid on time|almost always paid on time/i.test(note ?? "") ? ok(`on-time payer's reminder: "${note}"`) : fail(`note: ${note}`);

  // ── 4. data quality ──
  console.log("\n4. data quality");
  await runDataQuality();
  const f = async (key: string) => prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "data-quality", dedupeKey: key } } });
  (await f(`missing-id:${co.id}`))?.status === "review" ? ok("employee without an ID found") : fail("missing ID not found");
  (await f("dup-id:2444444441"))?.status === "review" ? ok("two records sharing one ID found") : fail("duplicate not found");
  const exp = await f(`expired:${co.id}`);
  exp?.status === "review" && ((exp.output as any)?.documents ?? []).some((d: any) => d.docType === "Health Insurance") ? ok("expired insurance with no renewal found") : fail("expired doc not found");
  await prisma.employee.update({ where: { id: blank.id }, data: { govId: "2444444499" } });
  await runDataQuality();
  (await f(`missing-id:${co.id}`))?.status === "done" ? ok("fixing the ID closes the finding on the next pass") : fail("finding stayed open after the fix");

  // ── 5. nitaqat ──
  console.log("\n5. nitaqat advisor");
  await runNitaqat();
  const drop = await prisma.agentTask.findFirst({ where: { agent: "nitaqat-advisor", companyId: co.id, status: "review" } });
  const d = (drop?.output ?? {}) as any;
  d.now?.band === "Platinum" && d.projected?.band === "Green" ? ok(`projects ${d.now.band} ${d.now.ratioPct}% → ${d.projected.band} ${d.projected.ratioPct}% from Majed's exit`) : fail(`drop: ${JSON.stringify(d.now)} → ${JSON.stringify(d.projected)}`);
  (d.options ?? []).some((o: any) => /Keep Majed Omar/.test(o.text)) && (d.options ?? []).some((o: any) => /Hire 1 Saudi/.test(o.text)) ? ok(`ways back: ${(d.options ?? []).map((o: any) => o.text).join(" | ")}`) : fail(`options: ${JSON.stringify(d.options)}`);
  await prisma.employee.update({ where: { id: saudis[2].id }, data: { exitStatus: "active" } });
  await runNitaqat();
  (await prisma.agentTask.findUnique({ where: { id: drop!.id } }))?.status === "done" ? ok("cancelling the exit closes the warning") : fail("warning stayed open");

  // ── 6. assistant + settings ──
  console.log("\n6. assistant and settings");
  try { await ask("which iqamas expire this month?", { ...admin }); fail("assistant answered with no model"); }
  catch (e: any) { e instanceof AgentActionError ? ok(`assistant without a model: "${e.message}"`) : fail(e?.message); }
  try { await updateAgent("data-quality", { enabled: true }, { id: null, name: "Officer", role: "pro_officer" }); fail("an officer changed an agent"); }
  catch (e: any) { e instanceof AgentActionError && e.status === 403 ? ok("only admins change agents") : fail(e?.message); }

  // restore
  await prisma.appSetting.deleteMany({ where: { key: { in: ["agents", "agentRuns"] } } });
  for (const s of settingsBefore) await prisma.appSetting.create({ data: s as any });
  await sweep();
  await prisma.agentTask.deleteMany({ where: { id: { notIn: [...tasksBefore] }, agent: { in: ["data-quality", "nitaqat-advisor", "renewal-prep", "request-triage", "collections", "console-assistant"] } } });
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); console.log("NOTE: agent settings/tasks from this run were not restored"); await prisma.$disconnect(); process.exit(1); });
