/**
 * A PART-FILLED STEP SURVIVES, AND A FINISHED ONE KEEPS NO DRAFT.
 *
 *   npx tsx scripts/step-draft-check.ts
 *
 * "Save for later" writes what has been typed onto the task, so a refresh, a different machine or a
 * colleague picking the work up all find it. Two ways that can go wrong, and both are silent:
 *
 *  1. THE DRAFT DOES NOT COME BACK. The officer types four answers, saves, returns to an empty
 *     form, and has no way of knowing whether the save ever worked.
 *  2. THE DRAFT OUTLIVES THE STEP. Once completed, the answers are run variables — recorded,
 *     logged, read by rules and written onto documents. A copy left on the task is a second version
 *     of the truth that nothing updates, and reopening a finished step would show it.
 *
 * `Prisma.DbNull` is the specific trap behind (2): a plain `null` on a Json column stores the JSON
 * value null, which reads back as a draft that exists and is empty rather than as no draft at all.
 *
 * LOCAL DATABASES ONLY: it creates a client, a template and a run, and deletes all three.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ Draft Check";
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

(async () => {
  await cleanup();
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, lifecycle: "client", status: "active", country: "SA" } });
  const tpl = await prisma.workflowTemplate.create({
    data: {
      name: `${TAG} Template`, country: "SA", trigger: "manual", entityType: "company",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "one", type: "task", label: "Step one", config: { assigneeRole: "pro_officer",
            captures: [{ var: "oneVal", label: "One", type: "text", required: true }] } },
          { id: "end", type: "end", label: "Done" },
        ],
        edges: [{ from: "start", to: "one" }, { from: "one", to: "end" }],
      },
    },
  });
  const inst = await startInstance(tpl.id, { companyId: co.id, clientName: co.name });
  const t = (await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId: "one", status: "active" } }))!;

  // Half an answer, saved — the shape the sheet posts, including a later step's variable, which is
  // the whole reason the draft hangs off the FIRST task rather than each step's own.
  await prisma.workflowTask.update({
    where: { id: t.id },
    data: { draftAnswers: { oneVal: "part", laterStepVal: "typed ahead" }, draftSavedAt: new Date().toISOString() },
  });
  const held = await prisma.workflowTask.findUnique({ where: { id: t.id } });
  ok((held?.draftAnswers as any)?.oneVal === "part", "what was typed comes back");
  ok((held?.draftAnswers as any)?.laterStepVal === "typed ahead", "and so do answers for steps further down the run");
  ok(!!held?.draftSavedAt, "with the time it was saved, so the sheet can say so");
  ok(held?.status === "active", "saving does not finish the step");

  await completeTask(t.id, { actor: "draft-check", variables: { oneVal: "final" } });
  const done = await prisma.workflowTask.findUnique({ where: { id: t.id } });
  ok(done?.status === "done", "completing still works with a draft on the row");
  // `=== null`, not falsy: a JSON null would pass a loose check and is exactly the bug.
  ok(done?.draftAnswers === null, "the draft is GONE once the step is done — not JSON null, gone");
  ok(done?.draftSavedAt === null, "and so is the saved-at stamp");
  const vars = ((await prisma.workflowInstance.findUnique({ where: { id: inst.id } }))?.variables ?? {}) as any;
  ok(vars.oneVal === "final", "the committed answer won, not the draft it replaced");

  await cleanup();
  console.log(failures ? `\n${failures} FAILED` : "\nok: a draft survives until the step does not need it");
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(String(e?.message ?? e)); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
