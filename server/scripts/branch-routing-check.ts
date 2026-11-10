/**
 * A STEP THAT CAN END TWO WAYS MUST GO EXACTLY ONE WAY.
 *
 *   npx tsx scripts/branch-routing-check.ts
 *
 * Found by running the business-setup case through the console. "Pre-check the drafts" is wired
 * `ok` → sign the documents and `fix` → send them back to the client, and the drawer had a single
 * Complete button, so no outcome was ever sent. nextTargets() then fell through to
 * `(uncond.length ? uncond : edges)` — and with every edge conditional, `edges` is ALL of them. Both
 * branches opened: the client was asked to correct the documents while the same documents were
 * being signed. Silent, and it doubles a case rather than failing it.
 *
 * Two halves, and both are needed or the bug comes back wearing the other half's clothes:
 *
 *   · the ENGINE refuses to route a branch nobody chose, instead of taking every branch
 *   · the SCREEN offers the branches, so there is something to choose with. An engine that refuses
 *     and a UI that cannot answer is a step nobody can finish at all.
 *
 * Everything it creates, it deletes.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ branch-routing-check";
const graph = {
  nodes: [
    { id: "start", type: "start", label: "Start" },
    { id: "check", type: "task", label: "Pre-check" },
    { id: "onward", type: "task", label: "Onward" },
    { id: "rework", type: "task", label: "Rework" },
    { id: "end", type: "end", label: "Done" },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "onward", condition: "ok" },
    { from: "check", to: "rework", condition: "fix" },
    { from: "onward", to: "end" },
    { from: "rework", to: "check" },
  ],
};

async function sweep() {
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = tpls.map(t => t.id);
  if (!ids.length) return;
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
  const rids = runs.map(r => r.id);
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
}

/** Start a run and return its one open step. */
async function fresh(tplId: string) {
  const run = await startInstance(tplId, { title: TAG + " run" });
  const t = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" }, select: { id: true } });
  return { runId: run.id, taskId: t!.id };
}
const openSteps = (runId: string) =>
  prisma.workflowTask.findMany({ where: { instanceId: runId, status: "active" }, select: { title: true } })
    .then(rs => rs.map(r => r.title).sort());

async function engine() {
  await sweep();
  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG, graph } as any });
  try {
    console.log("the engine routes the branch that was chosen:");
    let r = await fresh(tpl.id);
    await completeTask(r.taskId, { actor: TAG, outcome: "ok" });
    ok(JSON.stringify(await openSteps(r.runId)) === '["Onward"]', '"ok" opens Onward, and only Onward');

    r = await fresh(tpl.id);
    await completeTask(r.taskId, { actor: TAG, outcome: "fix" });
    ok(JSON.stringify(await openSteps(r.runId)) === '["Rework"]', '"fix" opens Rework, and only Rework');

    console.log("\n…and refuses the one nobody chose:");
    r = await fresh(tpl.id);
    let err = "";
    try { await completeTask(r.taskId, { actor: TAG }); } catch (e: any) { err = String(e?.message ?? ""); }
    ok(/no outcome was given/.test(err), `it says what is missing (got: ${err || "no error"})`);
    ok(/"ok"/.test(err) && /"fix"/.test(err), "and names the branches it could have taken");
    // The important half: it must not have advanced AT ALL. Taking both was the bug.
    const after = await openSteps(r.runId);
    ok(JSON.stringify(after) === '["Pre-check"]', `the step is still open, not both branches (got ${JSON.stringify(after)})`);
  } finally {
    await sweep();
    await prisma.workflowTemplate.delete({ where: { id: tpl.id } }).catch(() => {});
  }
}

function screen() {
  console.log("\nthe screen can answer:");
  const wf = fs.readFileSync(path.join(import.meta.dirname, "../src/workflow.ts"), "utf8");
  const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");
  ok(wf.includes("outcomes: outcomesFor(t)"), "/my-work sends each step's named branches");
  ok(ui.includes("wdOutcomeKeys: Array.isArray(selStep.outcomes)"), "the drawer reads them off the step");
  ok(ui.includes('<sc-for list="{{ wdOutcomes }}"'), "and renders one button per branch");
  // The plain button is wired `onClick="{{ completeStep }}"`, so it is called with the click EVENT.
  // Sending that as the outcome is a circular structure, and JSON.stringify threw hard enough to
  // take the whole screen down — found the first time the plain button was pressed after this.
  ok(ui.includes("typeof outcome9 === 'string'"), "and an event is not mistaken for a branch name");
}

await engine();
screen();
await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
