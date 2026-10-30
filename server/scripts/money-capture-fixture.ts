/**
 * A throwaway run with a money capture, so the real task sheet can be driven in a browser.
 *
 *   npx tsx scripts/money-capture-fixture.ts          create it
 *   npx tsx scripts/money-capture-fixture.ts clean    remove it and everything it made
 *
 * Deliberately named "ZZ …" so it sorts to the bottom of every list while it exists. Delete it when
 * you are done: this database holds real client records.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";

const NAME = "ZZ money capture fixture";

async function clean() {
  const t = await prisma.workflowTemplate.findFirst({ where: { name: NAME } });
  if (!t) return console.log("nothing to remove");
  const ids = (await prisma.workflowInstance.findMany({ where: { templateId: t.id }, select: { id: true } })).map(r => r.id);
  await prisma.disbursement.deleteMany({ where: { workflowInstanceId: { in: ids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowInstance.deleteMany({ where: { templateId: t.id } });
  await prisma.workflowTemplate.delete({ where: { id: t.id } });
  console.log(`removed the fixture and ${ids.length} run(s)`);
}

async function make() {
  const existing = await prisma.workflowTemplate.findFirst({ where: { name: NAME } });
  const tpl = existing ?? await prisma.workflowTemplate.create({
    data: {
      name: NAME, country: "SA", active: true, entityType: "generic",
      graph: {
        nodes: [
          { id: "n1", type: "start", config: {} },
          { id: "n2", type: "task", config: { title: "Pay the work permit fee", captures: [
            { var: "permitAmount", label: "Work permit fee", type: "money" },
            { var: "note", label: "Anything to note", type: "text", required: false },
          ] } },
          { id: "n3", type: "end", config: {} },
        ],
        edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
      } as any,
    },
  });
  const run = await startInstance(tpl.id, { title: "ZZ money capture fixture run", clientName: "ZZ Test Client" });
  const task = await prisma.workflowTask.findFirst({ where: { instanceId: run!.id, status: "active" } });
  console.log("template", tpl.id);
  console.log("run     ", run!.id);
  console.log("task    ", task?.id, "—", task?.title);
}

await (process.argv[2] === "clean" ? clean() : make());
await prisma.$disconnect();
