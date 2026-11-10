/**
 * NOBODY APPROVES THEIR OWN WORK.
 *
 *   npx tsx scripts/self-approval-check.ts        (needs no server — drives the engine directly)
 *
 * Every gate in the business-setup workflow rests on one rule: "the person who does the work never
 * approves their own gate." mayActOnTask guards which ROLE may touch a step; it cannot see that the
 * person pressing Approve is the one who did the steps being approved. Until this guard existed the
 * rule was a convention written in a spec, and the system would happily let one person sign off
 * their own document pack.
 *
 * The interesting cases are not "same person, adjacent node". They are:
 *
 *   · a stage is several chained task nodes — doing the FIRST of them must still block the gate,
 *     or a guard that checks only the immediate predecessor is theatre
 *   · work before an EARLIER gate must not block a later one; it was already certified there, and
 *     over-blocking would stall every run in a small team
 *   · a rename must not turn the control off — the comparison is by id, not by display name
 *   · admins are not exempt; an approval one person can give themselves is a signature
 *
 * Everything it makes is named "ZZ" and removed at the end, which is also why it refuses to run
 * anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This creates throwaway staff, templates and workflow runs."));
  process.exit(1);
}

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);

const TAG = "ZZ SelfApproval";

/** Stage A = two chained steps, then G1. Stage B = one step, then G2. */
const GRAPH = {
  nodes: [
    { id: "start", type: "start", label: "Start" },
    { id: "a1", type: "task", label: TAG + " A1 collect" },
    { id: "a2", type: "task", label: TAG + " A2 check" },
    { id: "g1", type: "approval", label: TAG + " G1" },
    { id: "b1", type: "task", label: TAG + " B1 structure" },
    { id: "g2", type: "approval", label: TAG + " G2" },
    { id: "end", type: "end", label: "End" },
  ],
  edges: [
    { from: "start", to: "a1" }, { from: "a1", to: "a2" }, { from: "a2", to: "g1" },
    { from: "g1", to: "b1", condition: "approve" },
    { from: "b1", to: "g2" },
    { from: "g2", to: "end", condition: "approve" },
  ],
};

async function sweep() {
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = tpls.map(t => t.id);
  if (ids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "zz-selfapproval" } } });
}

const open = (instanceId: string, nodeId: string) =>
  prisma.workflowTask.findFirst({ where: { instanceId, nodeId, status: "active" } });

/** Complete a step, returning the error message if the engine refused. */
async function act(taskId: string, who: { id: string; name: string }, outcome?: string): Promise<string | null> {
  try {
    await completeTask(taskId, { actor: who.name, actorId: who.id, outcome });
    return null;
  } catch (e: any) { return String(e?.message ?? e); }
}

async function main() {
  await sweep();

  const mk = (tag: string, role: string) =>
    prisma.user.create({ data: { name: `${TAG} ${tag}`, email: `zz-selfapproval-${tag}@example.invalid`, roleId: role, status: "active", type: "staff" } });
  const doer = await mk("doer", "pro_officer");
  const other = await mk("other", "pro_officer");
  const boss = await mk("boss", "super_admin");

  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG + " Template", graph: GRAPH } as any });

  // ── the first step of a multi-step stage still blocks that stage's gate ──────────────────────
  console.log("a stage of several steps");
  {
    const run = await startInstance(tpl.id, { title: TAG + " run 1" });
    const a1 = await open(run.id, "a1");
    if (!a1) { fail("the run did not open its first step"); await sweep(); process.exit(1); }
    await act(a1.id, doer);                                   // doer does step one
    const a2 = await open(run.id, "a2");
    if (!a2) { fail("step two never opened"); await sweep(); process.exit(1); }
    await act(a2.id, other);                                  // somebody else does step two
    const g1 = await open(run.id, "g1");
    if (!g1) { fail("the gate never opened"); await sweep(); process.exit(1); }

    const refused = await act(g1.id, doer, "approve");
    refused && /somebody else/i.test(refused)
      ? ok(`the doer of step ONE is refused at the gate — "${refused}"`)
      : fail(`doing step one should block the gate; got ${JSON.stringify(refused)}`);

    const alsoRefused = await act(g1.id, other, "approve");
    alsoRefused
      ? ok("the doer of step two is refused as well")
      : fail("the person who did step two approved the gate covering it");

    const allowed = await act(g1.id, boss, "approve");
    allowed === null
      ? ok("somebody who did neither step may approve")
      : fail(`an uninvolved approver was refused: ${allowed}`);
  }

  // ── a later gate must not be blocked by work the PREVIOUS gate already certified ─────────────
  console.log("\nwork belongs to the gate that certifies it");
  {
    const run = await startInstance(tpl.id, { title: TAG + " run 2" });
    const a1 = await open(run.id, "a1"); await act(a1!.id, doer);
    const a2 = await open(run.id, "a2"); await act(a2!.id, doer);
    const g1 = await open(run.id, "g1"); await act(g1!.id, boss, "approve");
    const b1 = await open(run.id, "b1");
    if (!b1) { fail("stage B never opened after the gate"); await sweep(); process.exit(1); }
    await act(b1.id, other);                                  // stage B done by somebody else
    const g2 = await open(run.id, "g2");
    if (!g2) { fail("the second gate never opened"); await sweep(); process.exit(1); }

    const r = await act(g2.id, doer, "approve");
    r === null
      ? ok("the doer of stage A may approve stage B's gate — that work was certified at G1")
      : fail(`over-blocked: stage A's doer was refused at G2 (${r}); every run in a small team would stall`);
  }

  // ── renaming the person must not turn the control off ────────────────────────────────────────
  console.log("\nidentity is the id, not the display name");
  {
    const run = await startInstance(tpl.id, { title: TAG + " run 3" });
    const a1 = await open(run.id, "a1"); await act(a1!.id, doer);
    const a2 = await open(run.id, "a2"); await act(a2!.id, doer);
    const renamed = { id: doer.id, name: TAG + " doer (renamed)" };
    await prisma.user.update({ where: { id: doer.id } , data: { name: renamed.name } });
    const g1 = await open(run.id, "g1");
    const r = await act(g1!.id, renamed, "approve");
    r
      ? ok("still refused after a rename")
      : fail("a rename defeated the guard — it is comparing names, not people");
    await prisma.user.update({ where: { id: doer.id }, data: { name: `${TAG} doer` } });
  }

  // ── admins are not exempt ────────────────────────────────────────────────────────────────────
  console.log("\nno override");
  {
    const run = await startInstance(tpl.id, { title: TAG + " run 4" });
    const a1 = await open(run.id, "a1"); await act(a1!.id, boss);
    const a2 = await open(run.id, "a2"); await act(a2!.id, other);
    const g1 = await open(run.id, "g1");
    const r = await act(g1!.id, boss, "approve");
    r
      ? ok("a super_admin who did the work is refused like anyone else")
      : fail("a super_admin approved their own work — the gate is decorative for admins");
  }

  // ── the id is actually being recorded, or the guard has nothing to compare next time ─────────
  console.log("\nwhat gets written");
  {
    const anyTask = await prisma.workflowTask.findFirst({
      where: { instance: { template: { name: { startsWith: TAG } } }, status: { not: "active" } },
      select: { completedBy: true, completedById: true },
    });
    anyTask?.completedById
      ? ok("completedById is stored alongside the display name")
      : fail(`completedById was not written (${JSON.stringify(anyTask)})`);
  }

  await sweep();
  console.log("\ncleaned up: YES");
  console.log(bad ? `\n${bad} problem(s)` : "\nall good");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
