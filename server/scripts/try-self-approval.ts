/**
 * A THROWAWAY RUN FOR SEEING THE SELF-APPROVAL GUARD IN THE UI.
 *
 *   npx tsx scripts/try-self-approval.ts            set it up, print what to click
 *   npx tsx scripts/try-self-approval.ts --delete   remove every trace of it
 *
 * scripts/self-approval-check.ts already proves the rule by driving the engine. This is for the
 * other question — what the person pressing the button actually sees — so it builds the smallest
 * workflow that has a gate in it and leaves the run waiting in the queue.
 *
 * Both steps are ASSIGNED TO YOU. An unassigned step is returned by /api/workflow/my-work but My
 * Tasks renders nothing for it, so a fixture that left them unassigned was invisible on the one
 * screen you would go looking at. The engine honours a node's `config.assignee` (a staff name,
 * resolved to an id when the step is created), which is also how a real run gets its owner.
 *
 * It refuses any database that is not on this machine. The guard is the host, not the name — the
 * local database here is called `stimespro_live`, so a name check would be no check at all.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";

const url = process.env.DATABASE_URL || "";
const host = url.match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  console.error("This creates a workflow template and a live run. It only belongs on a local database.");
  process.exit(1);
}

const TAG = "ZZ Try self-approval";

const graphFor = (who: string) => ({
  nodes: [
    { id: "start", type: "start", label: "Start" },
    { id: "work", type: "task", label: "Collect the document pack", config: { assignee: who } },
    { id: "gate", type: "approval", label: "G1 — QA approves the pack", config: { assignee: who } },
    { id: "end", type: "end", label: "Done" },
  ],
  edges: [
    { from: "start", to: "work" },
    { from: "work", to: "gate" },
    { from: "gate", to: "end", condition: "approve" },
  ],
});

async function sweep() {
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = tpls.map(t => t.id);
  if (!ids.length) return 0;
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
  const rids = runs.map(r => r.id);
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

async function main() {
  if (process.argv.includes("--delete")) {
    const n = await sweep();
    console.log(n ? `Removed the fixture (${n} template${n === 1 ? "" : "s"} and its runs).` : "Nothing to remove.");
    return;
  }

  await sweep(); // never leave two of these lying about

  const i = process.argv.indexOf("--as");
  const email = i > -1 ? process.argv[i + 1] : "zz-disposable@example.invalid";
  const who = await prisma.user.findUnique({ where: { email }, select: { name: true } });
  if (!who) {
    console.error(`No staff user with the email ${email}.`);
    console.error("Pass --as <your email>, or create the throwaway login first: npx tsx scripts/dev-user.ts");
    process.exit(1);
  }

  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG, graph: graphFor(who.name) } as any });
  const run = await startInstance(tpl.id, { title: TAG + " run" });
  const first = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" }, select: { title: true, assignee: true } });
  if (!first?.assignee) console.warn(`WARNING: the step came out unassigned — My Tasks will not show it.`);
  console.log(`Assigned to: ${who.name} <${email}>`);

  console.log(`
Set up. The run is waiting at: ${first?.title ?? "(no open step?)"}

  1. Sign in at http://localhost:5188 as ${email}, then open My Tasks.
     It is under "LATER — NO SLA", on the run called "${TAG} run".
  2. Click "Collect the document pack", then "Complete step".
     That records YOU as the person who did the work.
  3. The gate "G1 — QA approves the pack" opens in the same drawer. Press Approve.

  EXPECTED: refused, naming the step you completed —
    You completed "Collect the document pack", so this approval has to come from somebody else.

  The toast fades after a few seconds. If you miss it, the request is a 400 in the network tab,
  and the giveaway is that the gate is still sitting there open.

  For the other half, sign in as a different member of staff and approve the same gate: it goes
  through, because they did not do the work. (Both halves are already asserted by
  scripts/self-approval-check.ts — this fixture is only for seeing it happen.)

Clean up when you are done — it leaves nothing behind:
  npx tsx scripts/try-self-approval.ts --delete
`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
