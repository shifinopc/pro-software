/**
 * BRING THE OPEN TASKS ON ONE STEP UP TO DATE WITH THE STEP.
 *
 *   npx tsx scripts/repoint-step.ts "Iqama Renewal" renew            say what it would do
 *   npx tsx scripts/repoint-step.ts "Iqama Renewal" renew --apply    do it
 *
 * A task SNAPSHOTS its questions, its documents and its brief when it is created, so that saving the
 * Builder cannot rewrite work somebody is already holding. That is right, and it is also why a step
 * simplified today goes on asking the old questions on every renewal already in flight — including
 * questions the template no longer has an answer for, which is a step nobody can finish.
 *
 * This is the Builder's own "update open tasks" button (POST /templates/:id/repoint) for one named
 * step, run from the command line. It copies the step's CURRENT `captures`, `checklist` and
 * `instructions` onto tasks that are ACTIVE on RUNNING instances, and touches nothing else: no
 * answers, no checklist ticks, no assignees, no due dates — and no finished task, which has to keep
 * the questions it was actually answered against.
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("repoint-step");
const APPLY = process.argv.includes("--apply");
const [tplName, nodeId] = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (!tplName || !nodeId) {
  console.error('usage: npx tsx scripts/repoint-step.ts "<template name>" <nodeId> [--apply]');
  process.exit(1);
}

const tpl = await prisma.workflowTemplate.findFirst({ where: { name: tplName } });
if (!tpl) { console.error(`no template called "${tplName}"`); process.exit(1); }

const node = (((tpl.graph as any)?.nodes ?? []) as any[]).find(n => String(n?.id) === nodeId);
if (!node) { console.error(`"${tplName}" has no node "${nodeId}"`); process.exit(1); }

const cfg = node.config ?? {};
const captures = cfg.captures ?? [];
const checklist = cfg.checklist ?? [];
const instructions = cfg.instructions ?? null;

const open = await prisma.workflowTask.findMany({
  where: { nodeId, status: "active", instance: { templateId: tpl.id, status: "running" } },
  select: { id: true, title: true, captures: true, checklist: true, instructions: true,
            instance: { select: { title: true, clientName: true } } },
});

const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const stale = open.filter(t => !same(t.captures, captures) || !same(t.checklist, checklist) || t.instructions !== instructions);

console.log(`${tplName} · ${node.label ?? nodeId}: ${open.length} open task(s), ${stale.length} out of date`);
for (const t of stale) console.log(`  ${t.instance.clientName ?? "—"} — ${t.instance.title ?? ""}`);

if (stale.length && APPLY) {
  await prisma.workflowTask.updateMany({
    where: { id: { in: stale.map(t => t.id) } },
    data: { captures, checklist, instructions },
  });
}
console.log(APPLY ? `\nDone — ${stale.length} updated.` : "\nNothing was changed. Re-run with --apply.");
await prisma.$disconnect();
