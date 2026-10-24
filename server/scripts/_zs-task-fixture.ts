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

  // A REAL GRAPH, and that detail is the point of this fixture rather than a nicety.
  //
  // The first version used `{ nodes: [], edges: [] }` and pre-created both steps, and it passed a
  // change that was wrong on live: the Complete button decided "last step" by counting open task
  // rows, which is true on nearly every step of a real run because the engine creates each step
  // only when the one before it finishes. The fixture shared the mistaken assumption, so it agreed.
  // With the flow written down, step one can see step two ahead of it and step two cannot.
  const tpl = await prisma.workflowTemplate.create({ data: {
    name: `${TAG} template`, country: "SA", entityType: "company", active: false,
    graph: {
      nodes: [
        { id: "start", type: "start", label: "Start" },
        { id: "zs1", type: "task", label: "Check Establishment and Employee" },
        { id: "zs2", type: "task", label: "Pay the renewal fee" },
        { id: "end", type: "end", label: "Done" },
      ],
      edges: [
        { from: "start", to: "zs1" },
        { from: "zs1", to: "zs2" },
        { from: "zs2", to: "end" },
      ],
    } as any,
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
    // COPIED FROM THE LIVE "Issue Work Permit" STEP, conditional fields and all. A fixture whose
    // fields are simpler than the real ones tests a form nobody uses: the two showIf fields below
    // only appear when the fee is marked paid, and that branch is what a hand-written fixture
    // leaves out.
    captures: [
      // options is a comma-separated STRING here, not an array — the console splits it.
      { var: "permitTerm", label: "Work permit term", type: "select", options: "3_month,6_month,9_month,12_month", required: true },
      { var: "permitAmount", label: "Work permit fee amount (SAR)", type: "number", required: true },
      { var: "permitPaid", label: "Work permit fee — paid?", type: "select", options: "paid,unpaid", required: true },
      { var: "permitRef", label: "Payment reference", type: "text", required: true, showIf: { var: "permitPaid", equals: "paid" } },
      { var: "permitPaidOn", label: "Payment date", type: "date", required: true, showIf: { var: "permitPaid", equals: "paid" } },
    ] as any,
  });
  // ONLY STEP ONE IS CREATED. The engine makes the next step when this one is completed, and that
  // is the whole shape the earlier version of this fixture got wrong: with both rows sitting there
  // from the start, "how many steps are still open" answered 2, and the bug — a Complete button
  // that called the first step of a run the last — could not reproduce. One row open is what a
  // real run looks like at every moment of its life.
  console.log(`run   ${run.id}`);
  console.log(`step1 ${one.id}  ${one.title}`);
  console.log(`step2 — not created; the engine should make it when step1 completes`);
  console.log(`client ${co.name}`);
}

const cmd = process.argv[2];
(cmd === "clean" ? clean() : create())
  .then(() => prisma.$disconnect())
  .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
