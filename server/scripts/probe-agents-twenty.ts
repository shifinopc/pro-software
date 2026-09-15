/**
 * The twenty agents built on agent-kit, against their own fixtures — then every one of them over the
 * whole local database, to prove none of them throws on real data.
 *
 *   · onboarding flags a client with nothing set up; the exit agent lists the missing exit work and
 *     "Create tasks" creates it once; document integrity catches one number on two people and an Iqama
 *     number that is not the ID; the licence watch sees a CR expiring; fee recovery finds a hand-recorded
 *     fee and "Create draft invoice" drafts it; the quotation chaser is at the second follow-up; two
 *     records with one CR are duplicates;
 *   · the reconciler reads a Muqeem-style CSV (Arabic and English headings, day-first dates), works out
 *     the client, and lists who is missing on each side and whose expiry differs;
 *   · a pass after the problems are fixed closes the findings by itself.
 *
 * Everything the probe creates — fixtures, findings, tasks, the draft invoice, run stamps — is removed.
 */
import { prisma } from "../src/db.js";
import { AGENTS, actOnTask } from "../src/agents.js";
import { parseExport, importExport } from "../src/agent-compliance.js";
import * as crm from "../src/agent-crm.js";
import * as pro from "../src/agent-pro-ops.js";
import * as cl from "../src/agent-clients.js";
import * as comp from "../src/agent-compliance.js";
import * as fin from "../src/agent-finance-ops.js";
import * as brief from "../src/agent-brief.js";

const TAG = "ZS Twenty Probe";
const A = `${TAG} Trading Est`, B = `${TAG} Trading Establishment`;
const KEYS = [crm.LEADS, crm.QUOTES, crm.WON, crm.DUPES, pro.STUCK, pro.EXIT, pro.APPT, pro.ORIGINALS, pro.REPEAT, cl.ONBOARD, cl.WEEKLY, cl.PORTAL, cl.RISK, comp.RECON, comp.LICENCES, comp.INTEGRITY, comp.FAMILY, fin.FEES, fin.SUBS, brief.BRIEF];
let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);
const expect = (c: unknown, m: string) => (c ? ok(m) : fail(m));
const admin = { id: null, name: "Probe Admin", role: "super_admin" };
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const dmy = (days: number) => { const d = new Date(Date.now() + days * 86_400_000); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };
const started = new Date().toISOString();

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  const emps = await prisma.employee.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
  await prisma.task.deleteMany({ where: { OR: [{ companyId: { in: ids } }, { employeeId: { in: emps.map(e => e.id) } }] } });
  await prisma.invoice.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.quotation.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.document.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.employee.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.agentTask.deleteMany({ where: { companyId: { in: ids } } });
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: TAG }, select: { id: true } });
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: tpls.map(t => t.id) } }, select: { id: true } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
  await prisma.workflowInstance.deleteMany({ where: { id: { in: runs.map(r => r.id) } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: tpls.map(t => t.id) } } });
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
}

const open = (agent: string, companyId: string, kind?: string) => prisma.agentTask.findMany({ where: { agent, companyId, status: "review", ...(kind ? { kind } : {}) } });

async function main() {
  await sweep();
  const runsBefore = ((await prisma.appSetting.findUnique({ where: { key: "agentRuns" } }))?.value ?? {}) as Record<string, string>;
  const tasksBefore = new Set((await prisma.agentTask.findMany({ where: { agent: { in: KEYS } }, select: { id: true } })).map(t => t.id));

  console.log("\n1. Registry");
  expect(KEYS.every(k => AGENTS.some(a => a.key === k)), "all twenty are registered");
  expect(AGENTS.filter(a => KEYS.includes(a.key)).every(a => a.modelUse === "none"), "none of them uses a model");

  console.log("\n2. Fixtures");
  const a = await prisma.company.create({ data: { name: A, cr: "7001234567", lifecycle: "client", createdAt: iso(-3) } });
  const b = await prisma.company.create({ data: { name: B, cr: "7001234567", lifecycle: "lead", createdAt: iso(-3) } });
  const e1 = await prisma.employee.create({ data: { companyId: a.id, name: "RAVI KUMAR NAIR", govId: "2991000001", iqamaExpiry: iso(200), exitStatus: "exit_requested", exitDate: iso(-2), exitReason: "resignation" } });
  const e2 = await prisma.employee.create({ data: { companyId: a.id, name: "MARIA OLIVIA SANTOS", govId: "2991000002" } });
  await prisma.document.create({ data: { companyId: a.id, employeeId: e1.id, person: e1.name, docType: "Iqama", docNumber: "2991000009", expiryDate: iso(200) } });
  await prisma.document.create({ data: { companyId: a.id, employeeId: e1.id, person: e1.name, docType: "Passport", docNumber: "P7788990", expiryDate: iso(900) } });
  await prisma.document.create({ data: { companyId: a.id, employeeId: e2.id, person: e2.name, docType: "Passport", docNumber: "P7788990", expiryDate: iso(800) } });
  await prisma.document.create({ data: { companyId: a.id, person: A, docType: "CR", docNumber: "7001234567", expiryDate: iso(20) } });
  await prisma.document.create({ data: { companyId: a.id, employeeId: e2.id, person: e2.name, docType: "Work Permit", expiryDate: iso(300), history: [{ at: iso(-5), by: "Probe", fee: 850, receipt: "SADAD-PROBE-1" }] as any } });
  await prisma.quotation.create({ data: { number: "QT-PROBE-20", companyId: a.id, clientName: A, service: "Iqama renewal", amount: 1500, status: "sent", sentAt: iso(-8), validUntil: iso(10) } });
  ok("created two companies, two employees, five documents and a quotation");

  console.log("\n3. Findings");
  await cl.runClientOnboarding();
  const onb = await open(cl.ONBOARD, a.id);
  expect(onb.length === 1 && ((onb[0].output as any).checks as any[]).filter(c => c.state === "flag").length >= 3, "onboarding lists the gaps of a client with nothing set up");

  await pro.runEmployeeExits();
  const ex = await open(pro.EXIT, a.id);
  const exTasks = ((ex[0]?.output as any)?.tasks ?? []) as any[];
  expect(ex.length === 1 && exTasks.length === 5, `the exit lists five pieces of work (got ${exTasks.length})`);
  expect(((ex[0]?.output as any)?.checks ?? []).some((c: any) => c.label === "Closed on time" && c.state === "flag"), "a last day in the past is flagged");

  await comp.runDocumentIntegrity();
  expect((await open(comp.INTEGRITY, a.id, "same-number")).length === 1, "one passport number on two people is caught");
  expect((await open(comp.INTEGRITY, a.id, "id-mismatch")).length === 1, "an Iqama number that is not the employee's ID is caught");

  await comp.runCompanyLicences();
  expect((await open(comp.LICENCES, a.id)).length === 1, "a CR expiring in 20 days with no renewal is raised");

  await fin.runFeeRecovery();
  const fee = await open(fin.FEES, a.id);
  expect(fee.length === 1 && (fee[0].output as any).amount === 850, "an 850 fee recorded by hand and never invoiced is found");

  await crm.runQuoteChaser();
  const q = await open(crm.QUOTES, a.id);
  expect(q.length === 1 && q[0].dedupeKey.endsWith(":2"), "an 8-day-old quotation is at the second follow-up");

  await crm.runCrmDuplicates();
  const dup = await prisma.agentTask.findMany({ where: { agent: crm.DUPES, status: "review", dedupeKey: { contains: a.id } } });
  expect(dup.length >= 1, "two records with one CR are raised as duplicates");

  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG, trigger: "document_expiry" } });
  const officer = await prisma.user.findFirst({ where: { type: "staff", status: "active" }, select: { id: true, name: true } });
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  for (let i = 1; i <= 4; i++) {
    const run = await prisma.workflowInstance.create({ data: { templateId: tpl.id, title: `${TAG} renewal ${i}`, companyId: a.id, clientName: A, status: "running", startedAt: old } });
    await prisma.workflowTask.create({ data: { instanceId: run.id, nodeId: "n1", title: "Submit on Muqeem", status: "active", createdAt: old, ...(i < 4 ? { assigneeId: officer?.id, assignee: officer?.name } : { assigneeRole: "pro_officer", assignee: `${TAG} other` }) } });
  }
  await pro.runStuckWorkflows();
  const stuck = await prisma.agentTask.findMany({ where: { agent: pro.STUCK, status: "review", OR: [{ companyId: a.id }, { dedupeKey: `holder:${officer?.id}` }] } });
  const grouped = stuck.find(s => s.dedupeKey === `holder:${officer?.id}`);
  expect(!!grouped && ((grouped.output as any).lists[0].items as any[]).filter(x => x.text.includes(TAG)).length === 3, "three stalled runs with one officer are ONE item listing all three");
  expect(stuck.filter(s => s.dedupeKey.startsWith("still:")).length === 1, "a lone stalled run with someone else stays its own item");

  console.log("\n4. Actions");
  const r1 = await actOnTask(ex[0].id, "tasks", {}, admin as any);
  const made = await prisma.task.count({ where: { employeeId: e1.id } });
  expect(made === 5 && /Created 5 tasks/.test(r1.message), "“Create 5 tasks” creates the exit work");
  await prisma.agentTask.update({ where: { id: ex[0].id }, data: { status: "review" } });
  const r2 = await actOnTask(ex[0].id, "tasks", {}, admin as any);
  expect((await prisma.task.count({ where: { employeeId: e1.id } })) === 5 && /already exist/.test(r2.message), "pressing it again creates nothing twice");
  const r3 = await actOnTask(fee[0].id, "invoice", {}, admin as any);
  const inv = await prisma.invoice.findFirst({ where: { companyId: a.id } });
  expect(inv?.status === "draft" && inv.amount >= 850 && /Draft invoice/.test(r3.message), "“Create draft invoice” drafts the fee");
  let refused = false;
  try { await actOnTask(onb[0].id, "done", {}, { id: null, name: "Nobody", role: "portal_user" } as any); } catch { refused = true; }
  expect(refused, "a role without permission cannot close an item");

  console.log("\n5. Government export");
  const csv = [
    "Establishment employees report,,,,",
    ",,,,",
    "رقم الإقامة / Iqama No,Name,Nationality,Occupation,Iqama Expiry Date",
    `2991000001,RAVI KUMAR NAIR,India,Accountant,${dmy(230)}`,
    `2999999999,AHMED PROBE KHAN,Pakistan,Driver,${dmy(100)}`,
  ].join("\n");
  const parsed = parseExport(csv);
  expect(parsed.rows.length === 2 && parsed.rows[0].expiry === iso(230), "headings under a title row are found, and day-first dates are read");
  const res = await importExport({ fileName: "muqeem-probe.csv", text: csv, actor: admin as any });
  expect(res.client === A && res.source === "Muqeem", "the client is worked out from the IDs in the file");
  expect(res.notOnRecord === 1 && res.notOnPortal === 1 && res.expiry === 1, `one missing each side and one expiry differs (got ${res.notOnRecord}/${res.notOnPortal}/${res.expiry})`);
  let rejected = false;
  try { parseExport("a,b,c\n1,2,3"); } catch { rejected = true; }
  expect(rejected, "a file with no ID column is refused with a reason");

  console.log("\n6. Fixed problems close themselves");
  await prisma.document.updateMany({ where: { companyId: a.id, docType: "Iqama" }, data: { docNumber: "2991000001" } });
  await prisma.document.updateMany({ where: { companyId: a.id, docType: "CR" }, data: { expiryDate: iso(400) } });
  await comp.runDocumentIntegrity();
  await comp.runCompanyLicences();
  expect((await open(comp.INTEGRITY, a.id, "id-mismatch")).length === 0, "the corrected Iqama number closes its finding");
  expect((await open(comp.LICENCES, a.id)).length === 0, "the renewed CR closes its warning");

  console.log("\n7. Every agent over the whole database");
  for (const def of AGENTS.filter(d => KEYS.includes(d.key) && d.run)) {
    const t0 = Date.now();
    try { const out: any = await def.run!(); ok(`${def.name.padEnd(30)} ${String(out?.open ?? "-").padStart(3)} open · ${Date.now() - t0} ms${out?.details?.length ? ` · ${out.details[0]}` : ""}`); }
    catch (e: any) { fail(`${def.name} threw: ${e?.message ?? e}`); }
  }
  const briefRow = await prisma.agentTask.findFirst({ where: { agent: brief.BRIEF, status: "review" } });
  expect(!!briefRow && ((briefRow.output as any)?.facts ?? []).length >= 4, "the morning brief has its figures");
}

main()
  .catch(e => { bad++; console.error(e); })
  .finally(async () => {
    await sweep().catch(e => console.error("sweep:", e?.message));
    // Leave the local queues as they were: drop what this run created, and its run stamps.
    await prisma.agentTask.deleteMany({ where: { agent: { in: KEYS }, createdAt: { gte: started } } }).catch(() => {});
    const row = await prisma.appSetting.findUnique({ where: { key: "agentRuns" } });
    if (row) { const v = { ...(row.value as any) }; for (const k of KEYS) delete v[k]; await prisma.appSetting.update({ where: { key: "agentRuns" }, data: { value: v } }); }
    console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed.");
    await prisma.$disconnect();
    process.exit(bad ? 1 : 0);
  });
