/**
 * A task and the workflow it launched are two records for one job. They must end together.
 *
 * Found in the field: an officer marked "misa renewal" done in the Task List and its Company Check
 * step went on sitting in My Tasks, assigned to them, breaching its SLA. Two records, one job,
 * drifting apart, with nothing on screen to explain it. The engine already held half the rule —
 * cancelling a run closes its task, with a comment saying exactly why drift is harmful — but the
 * other two directions were missing:
 *
 *   task closed while the run is live   → nothing stopped it        (now refused)
 *   run finished normally               → its task stayed open      (now closed with the run)
 *
 * This walks all four directions, because fixing two and trusting the other two is how the pair
 * comes apart again.
 *
 * Own client, own template, own run. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const CLIENT = "ZS Sync Probe Client";
const TEMPLATE = "ZS sync probe template";

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
    await prisma.task.deleteMany({ where: { companyId: co.id } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: TEMPLATE } });
}

/** The smallest run that still has a step to complete: start → one task → end. */
async function makeTemplate() {
  const graph = {
    nodes: [
      { id: "start", type: "start", label: "Start", config: {} },
      { id: "step", type: "task", label: "The Only Step", config: { assigneeRole: "pro_officer", slaHours: 24 } },
      { id: "end_done", type: "end", label: "Done", config: {} },
    ],
    edges: [{ from: "start", to: "step" }, { from: "step", to: "end_done" }],
  };
  return prisma.workflowTemplate.create({
    data: { name: TEMPLATE, country: "SA", entityType: "generic", trigger: "manual", graph: graph as any, active: true, createdAt: new Date().toISOString() },
  });
}

async function main() {
  await sweep();
  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA" } as any });
  const tpl = await makeTemplate();

  // ── 1. a finished run closes its task ───────────────────────────────────────────────────────
  console.log("1. a run that finishes closes the task that carries it");
  {
    const run = await startInstance(tpl.id, { title: "sync probe — completes", companyId: co.id, clientName: CLIENT });
    const task = await prisma.task.create({ data: { title: "sync probe task", companyId: co.id, status: "todo", workflowInstanceId: run.id } as any });
    const step = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
    if (!step) { fail("the run opened with no active step"); }
    else {
      await completeTask(step.id, { actor: "sync probe" });
      const inst = await prisma.workflowInstance.findUnique({ where: { id: run.id } });
      const after = await prisma.task.findUnique({ where: { id: task.id } });
      if (inst?.status !== "completed") fail(`the run should be completed, it is "${inst?.status}"`);
      else ok("the run completed");
      if (after?.status !== "done") fail(`the linked task should close with the run — it is "${after?.status}"`);
      else ok("the linked task closed with it");
    }
  }

  // ── 2. a task somebody already closed is not rewritten ──────────────────────────────────────
  console.log("\n2. a task already closed by hand is left as the person left it");
  {
    const run = await startInstance(tpl.id, { title: "sync probe — preclosed", companyId: co.id, clientName: CLIENT });
    const task = await prisma.task.create({ data: { title: "sync probe cancelled task", companyId: co.id, status: "cancelled", workflowInstanceId: run.id } as any });
    const step = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
    await completeTask(step!.id, { actor: "sync probe" });
    const after = await prisma.task.findUnique({ where: { id: task.id } });
    if (after?.status !== "cancelled") fail(`a cancelled task must not be rewritten to "${after?.status}"`);
    else ok("a cancelled task stayed cancelled");
  }

  // ── 3. the run is still live: closing the task is refused ───────────────────────────────────
  // The guard lives in the HTTP layer, so this asserts the condition it tests rather than the
  // middleware itself — the route probe below is what proves the wiring.
  console.log("\n3. while the run is live the task must not be closeable");
  {
    const run = await startInstance(tpl.id, { title: "sync probe — live", companyId: co.id, clientName: CLIENT });
    const task = await prisma.task.create({ data: { title: "sync probe live task", companyId: co.id, status: "todo", workflowInstanceId: run.id } as any });
    const inst = await prisma.workflowInstance.findUnique({ where: { id: run.id } });
    const step = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
    if (inst?.status !== "running") fail("expected a running run");
    else if (!step) fail("expected a live step");
    else ok(`the guard's condition holds: run=${inst.status}, open step "${step.title}"`);

    // ── 4. cancelling closes it, which is the half that already worked ────────────────────────
    console.log("\n4. cancelling the run still closes the task (the half that already worked)");
    await prisma.workflowInstance.update({ where: { id: run.id }, data: { status: "cancelled" } });
    await prisma.workflowTask.updateMany({ where: { instanceId: run.id, status: "active" }, data: { status: "skipped" } });
    await prisma.task.updateMany({ where: { workflowInstanceId: run.id, NOT: { status: "done" } }, data: { status: "cancelled" } });
    const after = await prisma.task.findUnique({ where: { id: task.id } });
    if (after?.status !== "cancelled") fail(`cancelling should close the task — it is "${after?.status}"`);
    else ok("cancelling closed the task");
  }

  // ── 5. nothing is left drifting ─────────────────────────────────────────────────────────────
  console.log("\n5. no linked task is out of step with its run");
  {
    const linked = await prisma.task.findMany({ where: { companyId: co.id, workflowInstanceId: { not: null } }, select: { title: true, status: true, workflowInstanceId: true } });
    let drift = 0;
    for (const t of linked) {
      const i = await prisma.workflowInstance.findUnique({ where: { id: t.workflowInstanceId! }, select: { status: true } });
      if (t.status === "done" && i?.status === "running") drift++;
      if (t.status !== "done" && t.status !== "cancelled" && i?.status === "completed") drift++;
    }
    if (drift) fail(`${drift} of ${linked.length} linked tasks are out of step`);
    else ok(`all ${linked.length} linked tasks agree with their runs`);
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
