/**
 * Throwaway check: can a workflow raise a courier shipment, and does it arrive linked to the document
 * the same run just renewed?
 *
 * Runs: collect → issue/renew the document → send it back by courier. Then asserts the shipment names
 * that document, carries a proper sequence reference rather than a timestamp, and starts as
 * "preparing" rather than claiming to be in transit.
 *
 * Creates everything it needs and deletes all of it.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const graph = {
  nodes: [
    { id: "n1", type: "trigger", label: "Start" },
    { id: "n2", type: "task", label: "Collect the old passport", config: { assigneeRole: "pro_officer" } },
    { id: "n3", type: "issue_document", label: "Renew passport", config: { docType: "ZZ PROBE Passport" } },
    { id: "n4", type: "courier", label: "Post it back", config: { direction: "outbound", carrier: "Aramex", description: "Renewed passport back to the client" } },
    { id: "n5", type: "end", label: "Done" },
  ],
  edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" }, { from: "n4", to: "n5" }],
};

async function main() {
  const co = await prisma.company.findFirst();
  if (!co) throw new Error("no company on file");
  const before = { ship: await prisma.courierShipment.count(), doc: await prisma.document.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  let bad = 0;

  // A document for the run to renew, so `vars.documentId` is set by the time the courier step runs.
  const doc = await prisma.document.create({ data: {
    docType: "ZZ PROBE Passport", person: "Probe Subject", companyId: co.id,
    docNumber: "P-PROBE-1", expiryDate: "2027-01-01", status: "valid", daysLeft: 500,
  } });

  const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ COURIER PROBE", trigger: "manual", active: true, graph: graph as any } });
  const run = await startInstance(tpl.id, {
    title: "Passport renewal — probe", companyId: co.id, clientName: co.name,
    variables: { documentId: doc.id, newExpiry: "2032-01-01", docNumber: "P-PROBE-2" },
  });

  // The case file. Real work always has one — acceptServiceRequest and the New-task dialog both create
  // it — so the probe creates one too, otherwise it would not exercise the task link at all.
  const caseTask = await prisma.task.create({ data: {
    ref: "ZZ-PROBE-CASE", title: "Passport renewal — probe", companyId: co.id, clientName: co.name,
    assignee: "Unassigned", priority: "medium", status: "todo", workflowInstanceId: run.id,
  } });

  // Finish the one human step; the renew and the courier steps run automatically after it.
  const step = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
  await completeTask(step!.id, { actor: "probe" });

  const ship = await prisma.courierShipment.findFirst({ where: { taskId: { not: null } }, orderBy: { id: "desc" } })
    ?? await prisma.courierShipment.findFirst({ orderBy: { id: "desc" } });

  console.log(`shipment raised by the workflow: ${ship ? "YES" : "NO"}`);
  if (!ship) { bad++; }
  else {
    console.log(`  ref        ${ship.ref}`);
    console.log(`  carries    ${ship.documentId === doc.id ? "the document this run renewed" : "NOTHING / the wrong document"}`);
    console.log(`  direction  ${ship.direction} · carrier ${ship.carrier}`);
    console.log(`  status     ${ship.status}`);
    console.log(`  task link  ${ship.taskId === caseTask.id ? "the case file this run belongs to" : (ship.taskId ? "a DIFFERENT task" : "none")}`);
    if (ship.taskId !== caseTask.id) { console.log("  TASK LINK MISSING OR WRONG"); bad++; }
    if (ship.documentId !== doc.id) { console.log("  WRONG OR MISSING DOCUMENT LINK"); bad++; }
    if (!/^CR-\d+$/.test(ship.ref)) { console.log(`  REF IS NOT FROM THE SEQUENCE: ${ship.ref}`); bad++; }
    if (ship.status !== "preparing") { console.log("  CLAIMS TO BE IN TRANSIT BEFORE ANYONE COLLECTED IT"); bad++; }
  }

  // And the document knows about it — the question that started all this.
  const fromDoc = await prisma.courierShipment.findFirst({ where: { documentId: doc.id } });
  console.log(`\n"where is that passport", asked of the document: ${fromDoc ? `${fromDoc.ref} · ${fromDoc.status} · ${fromDoc.carrier}` : "unanswerable"}`);
  if (!fromDoc) bad++;

  // ── clean up ──
  if (ship) await prisma.courierShipment.delete({ where: { id: ship.id } }).catch(() => {});
  await prisma.workflowLog.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowInstance.delete({ where: { id: run.id } });
  await prisma.task.deleteMany({ where: { ref: "ZZ-PROBE-CASE" } });
  await prisma.workflowTemplate.delete({ where: { id: tpl.id } });
  await prisma.document.deleteMany({ where: { docType: "ZZ PROBE Passport" } });

  const now = { ship: await prisma.courierShipment.count(), doc: await prisma.document.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  shipments ${before.ship}->${now.ship} · documents ${before.doc}->${now.doc} · templates ${before.tpl}->${now.tpl} · runs ${before.run}->${now.run}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
