/**
 * BRING THE OPEN FEE STEPS ONTO THE ONE MONEY FIELD.
 *
 *   npx tsx scripts/repoint-old-fee-steps.ts            # says what it would do
 *   npx tsx scripts/repoint-old-fee-steps.ts --apply    # does it
 *
 * The fee capture used to be four questions — an amount, a paid/unpaid dropdown, and a reference and
 * a date that only appeared once you said "paid". It is one money field now, and the templates were
 * changed months ago. The OPEN TASKS were not: a task snapshots its own questions when it is created
 * so that saving the builder cannot rewrite work somebody is already holding, which is right, and
 * which is also why 78 steps are still asking the old four — including the paid/unpaid chip that the
 * money field exists to be rid of.
 *
 * So this is the builder's own "update open tasks" button, run from the command line because the
 * tasks are spread over three steps of a template nobody is editing today. It copies the step's
 * CURRENT questions onto tasks that are still active on running instances — the same two columns the
 * route writes, `captures` and `instructions` — and touches nothing else: no answers, no checklist
 * ticks, no assignees, no due dates, and no completed task, which has to keep the questions it was
 * actually answered against.
 *
 * Nothing is lost by the switch. An active task holds no answers yet (the form keeps them in the
 * browser until the step is completed), so there is no stored paid/unpaid to migrate, and the rules
 * that read `<thing>Paid` are already answered by the `<thing>Amount` money field — which is what
 * money-paid-rule-check covers.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("repoint-old-fee-steps");
const APPLY = process.argv.includes("--apply");

/** The shape being retired: a paid/unpaid dropdown, or an amount that is still a bare number. */
const isOldShape = (caps: any): boolean => {
  if (!Array.isArray(caps)) return false;
  return caps.some(c => (String(c?.type) === "select" && /paid$/i.test(String(c?.var ?? "")))
    || (String(c?.type) === "number" && /amount$/i.test(String(c?.var ?? ""))));
};

const tpls = await prisma.workflowTemplate.findMany({ select: { id: true, name: true, graph: true } });
let total = 0, skipped = 0;

for (const t of tpls) {
  const nodes: any[] = ((t.graph as any)?.nodes ?? []);
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const tasks = await prisma.workflowTask.findMany({
    where: { status: "active", instance: { templateId: t.id, status: "running" } },
    select: { id: true, nodeId: true, title: true, captures: true },
  });
  const stale = tasks.filter(k => isOldShape(k.captures));
  if (!stale.length) continue;

  // Grouped by step, because that is the unit the decision is made in: one step's questions were
  // corrected, and every task sitting on that step should be asking the corrected ones.
  const groups = new Map<string, typeof stale>();
  for (const k of stale) {
    const g = groups.get(String(k.nodeId)) ?? [];
    g.push(k); groups.set(String(k.nodeId), g);
  }
  for (const [nodeId, group] of groups) {
    const n = byId.get(nodeId);
    const want = n?.config?.captures;
    // A step that no longer exists, or that asks nothing: re-pointing would blank the task, which is
    // worse than leaving it on the old questions. Reported rather than silently passed over.
    if (!n || !Array.isArray(want) || !want.length) {
      console.log(`  SKIP ${t.name} · ${group[0].title} — ${!n ? "step no longer in the template" : "step asks nothing"} (${group.length} task(s))`);
      skipped += group.length;
      continue;
    }
    if (isOldShape(want)) {
      console.log(`  SKIP ${t.name} · ${group[0].title} — the template itself still asks the old questions (${group.length} task(s))`);
      skipped += group.length;
      continue;
    }
    const was = (group[0].captures as any[]).map(c => `${c.type}:${c.var}`).join(", ");
    const now = want.map((c: any) => `${c.type}:${c.var}`).join(", ");
    console.log(`  ${APPLY ? "updating" : "would update"} ${String(group.length).padStart(3)} × ${t.name} · ${n.label || nodeId}`);
    console.log(`        was  ${was}`);
    console.log(`        now  ${now}`);
    if (APPLY) {
      await prisma.workflowTask.updateMany({
        where: { id: { in: group.map(k => k.id) } },
        data: { captures: want, instructions: n.config?.instructions ?? null },
      });
    }
    total += group.length;
  }
}

console.log(`\n${total} open task(s) ${APPLY ? "re-pointed" : "to re-point"}${skipped ? `, ${skipped} left alone` : ""}`);
if (!APPLY && total) console.log("run again with --apply to write");
await prisma.$disconnect();
