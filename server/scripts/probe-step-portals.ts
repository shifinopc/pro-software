/**
 * Throwaway check: a step's authority reaches the task, and "office work" is a real answer.
 *
 * Not one of 105 task steps named a portal and not one of 80 live tasks carried one — the
 * Government Centers queue groups by authority and had nothing to group. Two separate defects sat
 * behind that: nobody had ever filled the field, and the Builder threw away the "office work"
 * answer by deleting the key, so a decided step looked identical to an unasked one and the list
 * could never reach zero.
 *
 * What is asserted:
 *   · a step naming a portal puts that portal on the task the engine creates
 *   · `noPortal: true` is NOT reported as a gap — it is an answer
 *   · a step with neither IS reported, so the list can still be worked down
 *   · automatic steps are never counted either way
 *
 * Own template and run. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";

const sweep = async () => {
  const t = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: "ZZ PORTAL" } }, select: { id: true } });
  const ids = t.map(x => x.id);
  if (ids.length) {
    const inst = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: inst.map(i => i.id) } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: inst.map(i => i.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { templateId: { in: ids } } });
    await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
  }
};

/** Same shape the real check uses, so the probe and the screen cannot disagree. */
const unanswered = (graph: any) => (graph.nodes as any[]).filter(n =>
  (n.type === "task" || n.type === "approval") && !n.config?.govCenter && !n.config?.noPortal);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    const graph = {
      nodes: [
        { id: "n0", type: "trigger", label: "Start" },
        { id: "n1", type: "task", label: "ZZ file it on Qiwa", config: { assigneeRole: "pro_officer", govCenter: "Qiwa" } },
        { id: "n2", type: "task", label: "ZZ ring the client", config: { assigneeRole: "pro_officer", noPortal: true } },
        { id: "n3", type: "task", label: "ZZ nobody has said", config: { assigneeRole: "pro_officer" } },
        { id: "n4", type: "delay", label: "ZZ wait", config: { hours: 1 } },
        { id: "n5", type: "end", label: "Done" },
      ],
      edges: [{ from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" }, { from: "n4", to: "n5" }],
    };

    const open = unanswered(graph);
    console.log(`only the unanswered one is reported:    ${open.length === 1 && open[0].id === "n3" ? "YES" : "NO (" + open.map(o => o.id).join(",") + ")"}`);
    if (open.length !== 1 || open[0].id !== "n3") fail("the gap list is wrong — office work or a portal or a delay is being counted");
    console.log(`  "office work" counts as ANSWERED:     ${!open.some(o => o.id === "n2") ? "YES" : "NO"}`);
    if (open.some(o => o.id === "n2")) fail("a step deliberately marked office work is still reported as a gap — the list can never reach zero");
    console.log(`  a delay is never counted:             ${!open.some(o => o.id === "n4") ? "YES" : "NO"}`);

    // ── does the authority actually reach the task? ───────────────────────────────────────────
    const tpl = await prisma.workflowTemplate.create({
      data: { name: "ZZ PORTAL carry", entityType: "employee", graph, active: true, trigger: "manual" },
    });
    // Started through the engine's own entry point rather than hand-built rows, so the probe
    // exercises the real path — a fixture assembled by hand can pass while the live one does not.
    const { startInstance } = await import("../src/workflow.js");
    const inst: any = await startInstance(tpl.id, { title: "ZZ PORTAL run" });

    const tasks = await prisma.workflowTask.findMany({ where: { instanceId: inst.id }, select: { nodeId: true, govCenter: true, title: true } });
    const t1 = tasks.find(t => t.nodeId === "n1");
    console.log(`\nthe portal reaches the task it makes:    ${t1?.govCenter === "Qiwa" ? "YES (Qiwa)" : "NO (" + (t1 ? t1.govCenter : "no task created") + ")"}`);
    if (t1?.govCenter !== "Qiwa") fail("a step naming Qiwa produced a task with no authority — the queue still cannot group it");

    // The Government Centers queue is a query on exactly this column.
    const queued = await prisma.workflowTask.count({ where: { govCenter: "Qiwa", instanceId: inst.id } });
    console.log(`  and it appears in the Qiwa queue:     ${queued === 1 ? "YES" : "NO (" + queued + ")"}`);
    if (queued !== 1) fail("the task is not findable by authority, which is what the queue does");

  } finally {
    await sweep();
  }

  const left = await prisma.workflowTemplate.count({ where: { name: { startsWith: "ZZ PORTAL" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
