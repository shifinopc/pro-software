/**
 * THE DOCUMENTS OF A STEP THAT HAS NOT STARTED YET.
 *
 *   npx tsx scripts/chain-docs-check.ts
 *
 * One form can now cover a run of steps that each collect documents — Business Setup's whole stretch
 * between two gates, which is what the officer does in one sitting. The ticks for the later steps
 * have nowhere to live while the form is open: a document is received against a TASK, and those
 * tasks are created one at a time as the run advances. So the form holds them and `complete-chain`
 * writes each step's ticks onto its task in the instant between the engine creating it and the step
 * being completed.
 *
 * That instant is the whole risk, and it fails CLOSED in the ugliest way: `checklistSatisfied` reads
 * `checklistState`, so ticks that do not arrive in time mean the run stops half-finished, on a step
 * whose documents the officer is holding in their hand.
 *
 * Checked against the real engine on a real run: two steps, both collecting, completed in one press.
 *
 * LOCAL DATABASES ONLY: it creates a client, a template and a run, and deletes all three.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask, stepChain, applyChecklistGate } from "../src/workflow.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ Chain Docs Check";
let failures = 0;
const ok = (cond: any, what: string) => {
  if (cond) console.log("  ok   " + what);
  else { console.log("  FAIL " + what); failures++; }
};

const cleanup = async () => {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = cos.map(c => c.id);
  if (cids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: { in: cids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    if (rids.length) {
      await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    }
    await prisma.document.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.company.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
};

const collects = (id: string, key: string) => ({
  id, type: "task", label: id, config: { assigneeRole: "pro_officer",
    checklist: [{ key, label: key.toUpperCase(), required: true }],
    captures: [{ var: id + "Val", label: id, type: "text", required: true }] },
});

(async () => {
  await cleanup();
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, lifecycle: "client", status: "active", country: "SA" } });
  const tpl = await prisma.workflowTemplate.create({
    data: {
      name: `${TAG} Template`, country: "SA", trigger: "manual", entityType: "company",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          collects("one", "deed"), collects("two", "poa"),
          { id: "end", type: "end", label: "Done" },
        ],
        edges: [{ from: "start", to: "one" }, { from: "one", to: "two" }, { from: "two", to: "end" }],
      },
    },
  });

  const g = { nodes: (tpl.graph as any).nodes, edges: (tpl.graph as any).edges } as any;
  ok(stepChain(g, "one").map((n: any) => n.id).join(",") === "two",
    "a collecting step is offered in the same form");

  const inst = await startInstance(tpl.id, { companyId: co.id, clientName: co.name });
  const t1 = (await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId: "one", status: "active" } }))!;

  // Step one, done the ordinary way — its own task exists, so its tick is already on the row.
  await prisma.workflowTask.update({ where: { id: t1.id }, data: { checklistState: { deed: { received: true, fileRef: "D-1" } } } });
  await completeTask(t1.id, { actor: "docs-check", variables: { oneVal: "a" } });

  const t2 = (await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId: "two", status: "active" } }))!;
  ok(!!t2, "step two opened, and its task did not exist while the form was being filled");

  // EXACTLY WHAT complete-chain DOES, through the same function it calls: the ticks the form has
  // been holding, applied to the task that appeared a moment ago.
  const held = await applyChecklistGate(t2, { poa: { received: true, fileRef: "P-7" } });
  ok(held === null, "the held ticks satisfy the gate on a task that did not exist when they were made");
  await completeTask(t2.id, { actor: "docs-check", variables: { twoVal: "b" } });

  const done2 = await prisma.workflowTask.findUnique({ where: { id: t2.id } });
  ok(done2?.status === "done", "and it completed — the ticks arrived before the gate was checked");
  ok((done2?.checklistState as any)?.poa?.fileRef === "P-7", "the reference typed against it was kept");

  /**
   * AND THE REFUSAL, which is the half that was missing.
   *
   * `completeTask` does NOT check documents — the ROUTE does — so when the chain route was written
   * it completed every step after the first with no gate at all. A run of four went through with
   * none of their required documents received. Both routes call this one function now, and this
   * asserts it refuses rather than assuming it.
   */
  const inst2 = await startInstance(tpl.id, { companyId: co.id, clientName: `${TAG} Client`, force: true });
  const u1 = (await prisma.workflowTask.findFirst({ where: { instanceId: inst2.id, nodeId: "one", status: "active" } }))!;
  ok(/not received: DEED/.test(String(await applyChecklistGate(u1, null))),
    "an unticked required document refuses the step, and names it");
  ok(/not received: DEED/.test(String(await applyChecklistGate(u1, { deed: { received: false } }))),
    "and a box that was looked at and left unticked is still a refusal");
  ok(await applyChecklistGate(u1, { deed: { received: true } }) === null, "ticking it lets the step through");

  await cleanup();
  console.log(failures ? `\n${failures} FAILED` : "\nok: a later step's documents reach its task in time");
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(String(e?.message ?? e)); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
