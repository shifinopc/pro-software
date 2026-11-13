/**
 * A WON DEAL MUST START THE WORK IT PROMISED.
 *
 *   npx tsx scripts/probe-setup-handover.ts
 *
 * Before building the Business Setup workflow, this proves the handover it will hang off actually
 * fires on this database: client accepts the quotation → the deal is won → a task exists → the
 * service's workflow is RUNNING with its first step sitting on somebody.
 *
 * It also proves the gap that matters for business setup, by doing the same thing the other way
 * round: a deal DRAGGED to the Won column starts nothing at all. For a renewal that is harmless.
 * For a setup case it is the whole job missing while the pipeline says it was sold.
 *
 * Brings its own subject — own client, own service, own deal, own quotation — and deletes all of
 * it, including the run it started. Nothing here touches a real record.
 */
import { prisma } from "../src/db.js";
import { startDeliveryForQuotation } from "../src/delivery.js";
import { nextNumber } from "../src/sequence.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("probe-setup-handover");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };
const TAG = "ZZ setup-handover";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  const runs = await prisma.workflowInstance.findMany({ where: { clientName: { startsWith: TAG } }, select: { id: true } });
  const rids = runs.map(r => r.id);
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } });
  if (ids.length) {
    await prisma.task.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.stageTransition.deleteMany({ where: { opportunity: { companyId: { in: ids } } } }).catch(() => {});
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.quotation.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: TAG } } });
}

await sweep();
try {
  // ── the setup a human would do once, on two ordinary screens ────────────────────────────────
  // A real template stands in for the Business Setup one that does not exist yet. Which template
  // is irrelevant here: the question is whether the binding is honoured at all.
  const tpl = await prisma.workflowTemplate.findFirst({
    where: { active: true, retired: false, trigger: "manual" }, select: { id: true, name: true },
  });
  if (!tpl) throw new Error("no active manual template to stand in for Business Setup");

  const svc = await prisma.serviceItem.create({
    data: { name: `${TAG} Business Setup`, workflowId: tpl.id, serviceFee: 60000, sla: "5 working days" } as any,
  });
  console.log(`set up once: service "${svc.name}" → workflow "${tpl.name}"\n`);

  const co = await prisma.company.create({ data: { name: `${TAG} Client Ltd` } as any });
  const open = await prisma.pipelineStage.findFirst({ where: { retired: false, isWon: false, isLost: false }, orderBy: { sort: "asc" } });
  const won = await prisma.pipelineStage.findFirst({ where: { retired: false, isWon: true, country: open?.country } });
  if (!open || !won) throw new Error("the pipeline has no open stage and won column to test with");

  // ── the ordinary path: quotation → accepted ────────────────────────────────────────────────
  const q = await prisma.quotation.create({
    data: {
      number: await nextNumber("quotation"), companyId: co.id, clientName: co.name,
      service: svc.name, items: [{ name: svc.name, units: 1, price: 60000 }],
      amount: 69000, totalMinor: 6900000, status: "sent", date: new Date().toISOString().slice(0, 10),
    } as any,
  });
  const deal = await prisma.opportunity.create({
    data: { companyId: co.id, title: `${TAG} deal`, stageId: open.id, quotationId: q.id, country: open.country } as any,
  });
  console.log(`a lead at "${open.name}" with quotation ${q.number} for SAR 60,000 + VAT`);

  const result = await startDeliveryForQuotation(q.id, { actor: TAG });

  console.log("\nthe client accepts it, and on its own:");
  const dealNow = await prisma.opportunity.findUnique({ where: { id: deal.id }, include: { stage: true } });
  ok(dealNow?.stageId === won.id, `the deal moved ${open.name} → ${won.name} with nobody dragging the card`);
  ok(!!dealNow?.closedAt, "…and is stamped closed, so the forecast stops counting it as open");

  const tasks = await prisma.task.findMany({ where: { quotationId: q.id }, select: { id: true, ref: true, title: true, workflowInstanceId: true, dueDate: true } });
  ok(tasks.length === 1, `one task per line on the quotation (${tasks.length})`);
  ok(!!tasks[0]?.dueDate, `…with a due date read from the service's SLA (${tasks[0]?.dueDate ?? "none"})`);

  const run = tasks[0]?.workflowInstanceId
    ? await prisma.workflowInstance.findUnique({ where: { id: tasks[0].workflowInstanceId }, select: { id: true, status: true, templateId: true, variables: true } })
    : null;
  ok(!!run, "the service's workflow is running behind that task");
  ok(run?.templateId === tpl.id, "…the one the service names, not a guess");
  ok(run?.status === "running", `…and it is live, not queued (${run?.status})`);
  ok(String((run?.variables as any)?._trigger) === "quotation_accepted", "…and it records WHY it started, which is how anyone reconstructs this later");

  const first = await prisma.workflowTask.findMany({ where: { instanceId: run!.id, status: "active" }, select: { title: true, assignee: true, assigneeRole: true } });
  ok(first.length > 0, `its first step is already waiting on somebody: "${first[0]?.title}" → ${first[0]?.assignee || first[0]?.assigneeRole || "unassigned"}`);
  console.log(`         delivery reported ${result.tasks.length} task(s), ${result.runs} run(s)`);

  console.log("\nand accepting it twice does not do it twice:");
  const again = await startDeliveryForQuotation(q.id, { actor: TAG });
  ok(again.started === false, `the second acceptance is refused — ${again.reason ?? "already delivered"}`);
  ok((await prisma.task.count({ where: { quotationId: q.id } })) === tasks.length, "…and no second task appeared");

  /**
   * THE GAP, and it is the one that matters for a setup case.
   *
   * There are two ways a deal becomes Won. Accepting the quotation runs everything above. Dragging
   * the card to the Won column runs NOTHING — no task, no workflow, no first step. For a renewal
   * that is survivable. For business setup it means the pipeline says SAR 60,000 was sold and not
   * one of the forty steps exists, which nobody notices until the client asks how it is going.
   */
  console.log("\nbut a deal dragged straight to Won starts nothing:");
  const co2 = await prisma.company.create({ data: { name: `${TAG} Client Two Ltd` } as any });
  const deal2 = await prisma.opportunity.create({
    data: { companyId: co2.id, title: `${TAG} dragged deal`, stageId: open.id, country: open.country } as any,
  });
  await prisma.opportunity.update({ where: { id: deal2.id }, data: { stageId: won.id, closedAt: new Date().toISOString() } });
  const t2 = await prisma.task.count({ where: { companyId: co2.id } });
  const r2 = await prisma.workflowInstance.count({ where: { companyId: co2.id } });
  ok(t2 === 0 && r2 === 0, `the deal is Won and ${t2} tasks / ${r2} runs exist — the work is simply missing`);
  console.log("         ↑ not a passing test. It is the gap, recorded so it cannot be forgotten.");
} finally {
  await sweep();
}
await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
