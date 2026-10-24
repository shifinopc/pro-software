/**
 * A throwaway workflow run with two steps, both assigned to the local admin, so the task sheet can
 * be driven end to end: instructions + checklist + captures on step one, a second step behind it so
 * "Complete step" has somewhere to advance to.
 *
 *   npx tsx scripts/_zs-task-fixture.ts create
 *   npx tsx scripts/_zs-task-fixture.ts clean
 *
 * Deletes only what it made. Not a probe and not in CI — a scratch fixture for driving the UI.
 */
import { prisma } from "../src/db.js";

const TAG = "ZS sheet fixture";

async function clean() {
  const runs = await prisma.workflowInstance.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  const ids = runs.map(r => r.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: `${TAG} template` } });
  console.log(`cleaned ${ids.length} run(s)`);
}

async function create() {
  await clean();
  const me = await prisma.user.findFirst({ where: { email: "local.admin@stimes.test" }, select: { id: true, name: true, roleId: true } });
  if (!me) throw new Error("local admin not found");
  const co = await prisma.company.findFirst({ where: { lifecycle: "client" }, select: { id: true, name: true } });
  if (!co) throw new Error("no client to hang it on");

  const tpl = await prisma.workflowTemplate.create({ data: {
    name: `${TAG} template`, country: "SA", entityType: "company", active: false,
    graph: { nodes: [], edges: [] } as any,
  } as any });

  const run = await prisma.workflowInstance.create({ data: {
    templateId: tpl.id, title: `${TAG} — Work Permit renewal`, companyId: co.id, clientName: co.name,
    status: "running", variables: {} as any,
  } as any });

  const step = (nodeId: string, title: string, extra: any) => prisma.workflowTask.create({ data: {
    instanceId: run.id, nodeId, nodeType: "task", title, status: "active",
    assigneeId: me.id, assignee: me.name, assigneeRole: me.roleId,
    priority: "high", slaHours: 24, ...extra,
  } as any });

  const one = await step("zs1", "Check Establishment and Employee", {
    instructions: "Qiwa refuses a renewal against a blocked establishment or an unauthenticated contract.\nConfirm all four before the fee is put to the client.\nIf the establishment is blocked, raise it with the client before going further.",
    checklist: [
      { key: "passport", label: "Passport copy", required: true },
      { key: "contract", label: "Authenticated contract", required: true },
      { key: "photo", label: "Photograph", required: false },
    ] as any,
    captures: [
      // options is a comma-separated STRING here, not an array — the console splits it.
      { var: "estStatus", label: "Establishment status", type: "select", options: "Active, Blocked" },
      { var: "refNo", label: "Qiwa reference", type: "text" },
    ] as any,
  });
  const two = await step("zs2", "Pay the renewal fee", {
    instructions: "Pay from the client's wallet and record the receipt number.",
    captures: [{ var: "receipt", label: "Receipt number", type: "text" }] as any,
  });

  console.log(`run   ${run.id}`);
  console.log(`step1 ${one.id}  ${one.title}`);
  console.log(`step2 ${two.id}  ${two.title}`);
  console.log(`client ${co.name}`);
}

const cmd = process.argv[2];
(cmd === "clean" ? clean() : create())
  .then(() => prisma.$disconnect())
  .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
