/**
 * Walk the three employee renewals, because a graph that looks right and a graph that runs are
 * different things.
 *
 * add-misa-renewal.ts shipped with branches written { var, value, key } and no `op`, which reads
 * perfectly well and matches NOTHING — evalDecision's default arm is ok = false, so every decision
 * fell to "else" and the run bounced between two steps twenty times. Nothing about the graph looked
 * wrong. Only walking it showed it. These three share a decision helper, so one such mistake would
 * have been in all of them at once.
 *
 * What this asserts, per workflow:
 *   - the graph validates and every node is reachable
 *   - the happy path completes and issues the right document type
 *   - a declined client ends the run WITHOUT paying and WITHOUT issuing anything — the branch that
 *     the specs omitted and this build added
 *   - where there is a blocking check, blocked routes away and comes back exactly once
 *
 * Own client, own employee, own runs. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask, validateReferences } from "../src/workflow.js";

const CLIENT = "ZS Renewal Probe Client";

let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } });
    const ids = runs.map(r => r.id);
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.document.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { companyId: co.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
}

async function active(instanceId: string) {
  return prisma.workflowTask.findFirst({ where: { instanceId, status: "active" }, orderBy: { createdAt: "asc" } });
}

async function step(instanceId: string, expectNode: string, vars: Record<string, any>) {
  const t = await active(instanceId);
  if (!t) { fail(`expected "${expectNode}" but the run has no active step`); return null; }
  if (t.nodeId !== expectNode) { fail(`expected "${expectNode}", the run is at "${t.nodeId}"`); return null; }
  const checklist: any = {};
  for (const i of (Array.isArray(t.checklist) ? t.checklist : []) as any[]) checklist[i.key] = { received: true, verified: true };
  await completeTask(t.id, { actor: "renewal probe", checklist, variables: vars });
  return active(instanceId);
}

async function graphChecks(name: string) {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name } });
  if (!tpl) { fail(`no template "${name}" — run add-employee-renewals.ts first`); return null; }
  const issues = await validateReferences(tpl.graph as any, tpl as any);
  if (issues.length) for (const i of issues) fail(`${name}: ${JSON.stringify(i)}`);
  else ok("graph validates — no dangling edges or unknown references");

  const g: any = tpl.graph;
  const reach = new Set<string>(["start"]);
  for (let i = 0; i < g.nodes.length; i++)
    for (const e of g.edges) if (reach.has(e.from ?? e.source)) reach.add(e.to ?? e.target);
  const orphans = g.nodes.map((n: any) => n.id).filter((id: string) => !reach.has(id));
  if (orphans.length) fail(`${name}: unreachable node(s) ${orphans.join(", ")}`);
  else ok(`all ${g.nodes.length} nodes reachable from start`);
  return tpl;
}

async function main() {
  await sweep();
  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA" } as any });
  const emp = await prisma.employee.create({ data: { name: "ZS Probe Employee", companyId: co.id } as any });
  const subject = { companyId: co.id, clientName: CLIENT, variables: { employeeId: emp.id } };

  // ───────────────────────────── IQAMA ─────────────────────────────
  console.log("Iqama Renewal");
  const iq = await graphChecks("Iqama Renewal");
  if (iq) {
    const r = await startInstance(iq.id, { title: "probe — iqama happy", ...subject });
    await step(r.id, "prereq", { prereqOutcome: "ready" });
    await step(r.id, "fee", { renewalTerm: "1_year", feeAmount: 650, clientApproval: "approved", approvedBy: "Probe Manager" });
    await step(r.id, "pay", { paymentRef: "SADAD-IQ", paymentDate: "2026-09-10" });
    await step(r.id, "submit", { muqeemRef: "MQ-1", submittedOn: "2026-09-10" });
    await step(r.id, "record", { iqamaNumber: "2123456789", newExpiry: "2027-09-10" });
    const h = await active(r.id);
    if (h?.nodeId !== "handover") fail(`after recording expected the handover step, got "${h?.nodeId}"`);
    else ok("issue_document fired, run moved to the handover");
    await step(r.id, "handover", { handedTo: "ZS Probe Employee", handedOn: "2026-09-11" });
    const done = await prisma.workflowInstance.findUnique({ where: { id: r.id } });
    if (done?.status !== "completed") fail(`happy path should complete, it is "${done?.status}"`);
    else ok("happy path completed");
    const d = await prisma.document.findFirst({ where: { companyId: co.id, docType: "Iqama" } });
    if (!d) fail("no Iqama was issued"); else ok(`issued Iqama ${d.docNumber} expiring ${d.expiryDate}`);

    // blocked routes away and returns exactly once
    const r2 = await startInstance(iq.id, { title: "probe — iqama blocked", ...subject });
    await step(r2.id, "prereq", { prereqOutcome: "blocked", blockReason: "passport under 6 months" });
    const held = await active(r2.id);
    if (held?.nodeId !== "hold_fix") fail(`blocked should route to Resolve the Blocking Item, got "${held?.nodeId}"`);
    else ok("blocked -> Resolve the Blocking Item");
    await step(r2.id, "hold_fix", { blockCleared: "passport renewed" });
    const back = await active(r2.id);
    if (back?.nodeId !== "prereq") fail(`resolving should return to the check, got "${back?.nodeId}"`);
    else ok("resolved -> back to the Prerequisite Check");
    await step(r2.id, "prereq", { prereqOutcome: "ready" });
    const cnt = await prisma.workflowTask.count({ where: { instanceId: r2.id, nodeId: "prereq" } });
    if (cnt !== 2) fail(`the check should have run exactly twice, it ran ${cnt} times`);
    else ok("the check ran exactly twice — the branch matched, no spin");

    // declined: no payment, no document
    await step(r2.id, "fee", { renewalTerm: "1_year", feeAmount: 650, clientApproval: "declined" });
    if (await active(r2.id)) fail("a declined renewal should end the run");
    else ok("declined -> run closed");
    const paid = await prisma.workflowTask.count({ where: { instanceId: r2.id, nodeId: "pay" } });
    if (paid !== 0) fail(`a declined renewal must never reach the payment step — it created ${paid}`);
    else ok("declined never reached Pay the Government Fee");
    const docs = await prisma.document.count({ where: { companyId: co.id, docType: "Iqama" } });
    if (docs !== 1) fail(`declining must issue nothing — ${docs} Iqamas exist, expected the 1 from the happy path`);
    else ok("declined issued nothing");
  }

  // ───────────────────────────── WORK PERMIT ─────────────────────────────
  console.log("\nWork Permit Renewal");
  const wp = await graphChecks("Work Permit Renewal");
  if (wp) {
    const r = await startInstance(wp.id, { title: "probe — permit happy", ...subject });
    await step(r.id, "check", { checkOutcome: "ready" });
    await step(r.id, "fee", { feeAmount: 9700, clientApproval: "approved", approvedBy: "Probe Manager" });
    await step(r.id, "pay", { paymentRef: "SADAD-WP" });
    await step(r.id, "submit", { qiwaRef: "QW-1", submittedOn: "2026-09-10" });
    await step(r.id, "record", { permitNumber: "WP-77", newExpiry: "2027-09-10" });
    const done = await prisma.workflowInstance.findUnique({ where: { id: r.id } });
    if (done?.status !== "completed") fail(`happy path should complete, it is "${done?.status}"`);
    else ok("happy path completed");
    const d = await prisma.document.findFirst({ where: { companyId: co.id, docType: "Work Permit" } });
    if (!d) fail("no Work Permit was issued"); else ok(`issued Work Permit ${d.docNumber} expiring ${d.expiryDate}`);

    const r2 = await startInstance(wp.id, { title: "probe — permit blocked", ...subject });
    await step(r2.id, "check", { checkOutcome: "blocked", blockReason: "contract not authenticated" });
    const back = await active(r2.id);
    if (back?.nodeId !== "check") fail(`blocked should return to the check, got "${back?.nodeId}"`);
    else ok("blocked -> back to the check (no resolve step in the spec)");
    await step(r2.id, "check", { checkOutcome: "ready" });
    await step(r2.id, "fee", { feeAmount: 9700, clientApproval: "declined" });
    if (await active(r2.id)) fail("a declined renewal should end the run");
    else ok("declined -> run closed");
    const paid = await prisma.workflowTask.count({ where: { instanceId: r2.id, nodeId: "pay" } });
    if (paid !== 0) fail(`a declined renewal must never reach the payment step — it created ${paid}`);
    else ok("declined never reached Pay the Fee");
  }

  // ───────────────────────────── HEALTH INSURANCE ─────────────────────────────
  console.log("\nHealth Insurance Renewal");
  const hi = await graphChecks("Health Insurance Renewal");
  if (hi) {
    const r = await startInstance(hi.id, { title: "probe — insurance happy", ...subject });
    await step(r.id, "cover", { coverClass: "VIP", dependants: "no" });
    await step(r.id, "quote", { insurer: "Bupa Arabia", premium: 4200 });
    await step(r.id, "approval", { clientApproval: "approved", approvedBy: "Probe Manager" });
    await step(r.id, "pay", { paymentRef: "SADAD-HI" });
    await step(r.id, "record", { policyNumber: "POL-9", newExpiry: "2027-09-10" });
    const done = await prisma.workflowInstance.findUnique({ where: { id: r.id } });
    if (done?.status !== "completed") fail(`happy path should complete, it is "${done?.status}"`);
    else ok("happy path completed");
    const d = await prisma.document.findFirst({ where: { companyId: co.id, docType: "Health Insurance" } });
    if (!d) fail("no policy was issued"); else ok(`issued Health Insurance ${d.docNumber} expiring ${d.expiryDate}`);

    const r2 = await startInstance(hi.id, { title: "probe — insurance declined", ...subject });
    await step(r2.id, "cover", { coverClass: "VIP", dependants: "no" });
    await step(r2.id, "quote", { insurer: "Bupa Arabia", premium: 4200 });
    await step(r2.id, "approval", { clientApproval: "declined" });
    if (await active(r2.id)) fail("a declined policy should end the run");
    else ok("declined -> run closed");
    const paid = await prisma.workflowTask.count({ where: { instanceId: r2.id, nodeId: "pay" } });
    if (paid !== 0) fail(`a declined policy must never reach Pay the Premium — it created ${paid}`);
    else ok("declined never reached Pay the Premium");
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
