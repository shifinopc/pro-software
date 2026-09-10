/**
 * Walk the Commercial Registration Renewal workflow, because a graph that looks right and a graph
 * that runs are different things.
 *
 * The MISA build is the reason this exists. Its branches were written { var, value, key } with no
 * `op`, which reads perfectly well and matches NOTHING — evalDecision's default arm is `ok = false`,
 * so every decision fell to "else" and the run bounced between the company check and the on-hold
 * step twenty times before anyone noticed. Nothing about the graph looked wrong. Only walking it
 * showed it.
 *
 * So this walks all four paths:
 *
 *   1. The graph validates — every edge lands on a node that exists, every checklist and document
 *      type it names is really there.
 *   2. The happy path runs to completion and issues a Commercial Registration.
 *   3. Blocked at the gate loops back to the gate ONCE and then proceeds — it does not spin.
 *   4. Refused at the portal loops back to the portal, and a declined fee ends the run without
 *      issuing anything.
 *
 * Own client, own registration, own run. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask, validateReferences } from "../src/workflow.js";

const TEMPLATE = "Commercial Registration Renewal";
const CLIENT = "ZS CR Probe Client";

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
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
}

/** The single active task on a run, or null. */
async function active(instanceId: string) {
  const t = await prisma.workflowTask.findFirst({ where: { instanceId, status: "active" }, orderBy: { createdAt: "asc" } });
  return t;
}

/** Complete whatever is active, asserting it is the step we expect. Returns the next active node. */
async function step(instanceId: string, expectNode: string, vars: Record<string, any>) {
  const t = await active(instanceId);
  if (!t) { fail(`expected to be at "${expectNode}" but the run has no active step`); return null; }
  if (t.nodeId !== expectNode) { fail(`expected "${expectNode}", the run is at "${t.nodeId}"`); return null; }
  // Every checklist item ticked — the point here is the graph, not the document gate.
  const checklist: any = {};
  for (const i of (Array.isArray(t.checklist) ? t.checklist : []) as any[]) checklist[i.key] = { received: true, verified: true };
  await completeTask(t.id, { actor: "CR probe", checklist, variables: vars });
  const nxt = await active(instanceId);
  return nxt;
}

async function main() {
  await sweep();
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  if (!tpl) { console.log(`no template "${TEMPLATE}" — run add-cr-renewal.ts first`); process.exit(1); }

  // ── 1. the graph itself ─────────────────────────────────────────────────────────────────────
  console.log("1. the graph validates");
  const issues = await validateReferences(tpl.graph as any, tpl as any);
  if (issues.length) { for (const i of issues) fail(JSON.stringify(i)); }
  else ok("no dangling edges, missing checklists or unknown document types");

  const g: any = tpl.graph;
  // Reachability, which validateReferences does not check: a step nobody can arrive at is a step
  // that will never run, and that is exactly how the spec's two exception steps could have been lost.
  const reach = new Set<string>(["start"]);
  for (let n = 0; n < g.nodes.length; n++)
    for (const e of g.edges) if (reach.has(e.from ?? e.source)) reach.add(e.to ?? e.target);
  const orphans = g.nodes.map((n: any) => n.id).filter((id: string) => !reach.has(id));
  if (orphans.length) fail(`unreachable node(s): ${orphans.join(", ")}`);
  else ok(`all ${g.nodes.length} nodes reachable from start`);

  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA" } as any });

  // ── 2. the happy path ───────────────────────────────────────────────────────────────────────
  console.log("\n2. the happy path runs to completion");
  const run = await startInstance(tpl.id, { title: "CR probe — happy", companyId: co.id, clientName: CLIENT });
  let n = await active(run.id);
  if (n?.nodeId !== "gate") fail(`a new run should open at the gate check, it opened at "${n?.nodeId}"`);
  else ok("opens at Pre-Renewal Gate Check");

  await step(run.id, "gate", { gateOutcome: "ready" });
  await step(run.id, "fee", { renewalTerm: "1_year", mcFee: 1200, chamberTier: "Second", clientApproval: "approved", approvedBy: "Probe Manager", approvedOn: "2026-09-10" });
  await step(run.id, "chamber", { chamberReceipt: "CH-1", chamberPaidOn: "2026-09-10" });
  await step(run.id, "pay", { paymentRef: "SADAD-1", paymentDate: "2026-09-10" });
  await step(run.id, "portal", { portalRef: "MC-1", submittedOn: "2026-09-10", portalOutcome: "renewed" });
  await step(run.id, "record", { crNumber: "1010999888", newExpiry: "2027-09-10" });
  const afterRecord = await active(run.id);
  if (afterRecord?.nodeId !== "followup") fail(`after recording, expected the follow-up step, got "${afterRecord?.nodeId}"`);
  else ok("issue_document fired and the run moved to Update Related Records");
  await step(run.id, "followup", {});

  const done = await prisma.workflowInstance.findUnique({ where: { id: run.id } });
  if (done?.status !== "completed") fail(`the run should be completed, it is "${done?.status}"`);
  else ok("run completed");

  const doc = await prisma.document.findFirst({ where: { companyId: co.id, docType: "Commercial Registration" } });
  if (!doc) fail("no Commercial Registration was issued");
  else ok(`issued Commercial Registration ${doc.docNumber} expiring ${doc.expiryDate}`);

  // ── 3. blocked at the gate loops back ONCE ──────────────────────────────────────────────────
  console.log("\n3. blocked at the gate returns to the gate, and does not spin");
  const run2 = await startInstance(tpl.id, { title: "CR probe — blocked", companyId: co.id, clientName: CLIENT });
  await step(run2.id, "gate", { gateOutcome: "blocked", blockReason: "Zakat certificate lapsed" });
  const held = await active(run2.id);
  if (held?.nodeId !== "hold_fix") fail(`blocked should go to Clear the Blocking Item, it went to "${held?.nodeId}"`);
  else ok("blocked -> Clear the Blocking Item");
  await step(run2.id, "hold_fix", { blockCleared: "Zakat settled" });
  const back = await active(run2.id);
  if (back?.nodeId !== "gate") fail(`clearing the block should return to the gate, it went to "${back?.nodeId}"`);
  else ok("cleared -> back to the gate check");
  await step(run2.id, "gate", { gateOutcome: "ready" });
  const onward = await active(run2.id);
  if (onward?.nodeId !== "fee") fail(`ready on the second pass should proceed to the fee step, it went to "${onward?.nodeId}"`);
  else ok("ready on the second pass -> Confirm Fee (no loop)");

  const gateTasks = await prisma.workflowTask.count({ where: { instanceId: run2.id, nodeId: "gate" } });
  if (gateTasks !== 2) fail(`the gate should have run exactly twice, it ran ${gateTasks} times`);
  else ok("the gate ran exactly twice — the branch matched, it did not fall through to else");

  // ── 4. declined fee ends the run; refused portal loops back ─────────────────────────────────
  console.log("\n4. the two remaining exits");
  await step(run2.id, "fee", { renewalTerm: "1_year", mcFee: 1200, chamberTier: "Second", clientApproval: "declined" });
  const declined = await prisma.workflowInstance.findUnique({ where: { id: run2.id } });
  const stillOpen = await active(run2.id);
  if (stillOpen) fail(`a declined fee should end the run, it is at "${stillOpen.nodeId}"`);
  else if (declined?.status !== "completed") fail(`a declined run should close, it is "${declined?.status}"`);
  else ok("declined -> Not Renewed — Client Declined, run closed");

  const declinedDocs = await prisma.document.count({ where: { companyId: co.id, docType: "Commercial Registration" } });
  if (declinedDocs !== 1) fail(`a declined run must not issue anything — ${declinedDocs} documents exist, expected the 1 from the happy path`);
  else ok("declining issued nothing");

  const run3 = await startInstance(tpl.id, { title: "CR probe — portal", companyId: co.id, clientName: CLIENT });
  await step(run3.id, "gate", { gateOutcome: "ready" });
  await step(run3.id, "fee", { renewalTerm: "1_year", mcFee: 1200, chamberTier: "Second", clientApproval: "approved", approvedBy: "Probe Manager" });
  await step(run3.id, "chamber", { chamberReceipt: "CH-2", chamberPaidOn: "2026-09-10" });
  await step(run3.id, "pay", { paymentRef: "SADAD-2", paymentDate: "2026-09-10" });
  await step(run3.id, "portal", { portalRef: "MC-2", submittedOn: "2026-09-10", portalOutcome: "blocked" });
  const refused = await active(run3.id);
  if (refused?.nodeId !== "portal_blocked") fail(`a refused filing should go to Portal Blocked, it went to "${refused?.nodeId}"`);
  else ok("portal refused -> Portal Blocked — Resolve");
  await step(run3.id, "portal_blocked", { portalRefusal: "National address mismatch" });
  const refiled = await active(run3.id);
  if (refiled?.nodeId !== "portal") fail(`resolving should return to the portal step, it went to "${refiled?.nodeId}"`);
  else ok("resolved -> back to Renew on the MC Portal");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
