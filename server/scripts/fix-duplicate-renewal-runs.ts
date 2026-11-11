/**
 * SEVENTY EMPLOYEES WITH TWO OPEN IQAMA RENEWALS EACH, AND HOW TO GET BACK TO ONE.
 *
 *   npx tsx scripts/fix-duplicate-renewal-runs.ts            # says what it would do, changes nothing
 *   npx tsx scripts/fix-duplicate-renewal-runs.ts --apply    # does it
 *
 * The renewal job claimed each document AFTER starting its run, so two overlapping passes — a
 * restart, where the old process finishes its tick while the new one runs its boot tick — both saw
 * the same unclaimed documents. On 13 October 2026 two passes 2m25s apart raised a second renewal
 * for seventy people, and the second claim overwrote the first, orphaning the run that held the
 * actual work from the document it was renewing.
 *
 * The race is closed at source (jobs.ts claims before starting, with a compare-and-swap) and
 * startInstance now refuses a second open run for the same subject. Neither undoes what is already
 * open, which is what this does.
 *
 * WHICH ONE SURVIVES: the run with the most finished steps, and on a tie the one started first.
 * Never the newest by default — the newest is the accidental one, and the older has the payments
 * recorded and the checklists ticked. The loser is CANCELLED, not deleted: it is evidence of work
 * somebody did, its steps are marked skipped, its task row is closed, and the document's claim is
 * re-pointed at the survivor so the next tick does not raise a third.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const nowISO = () => new Date().toISOString();

const runs = await prisma.workflowInstance.findMany({
  where: { status: "running" },
  select: { id: true, templateId: true, companyId: true, clientName: true, title: true, variables: true, startedAt: true,
            template: { select: { name: true } } },
});

/** The same subject rule the engine's own guard uses, so this cleans up exactly what it now prevents. */
const subjectOf = (r: any) => {
  const v: any = (r.variables && typeof r.variables === "object") ? r.variables : {};
  if (v.employeeId) return `${r.templateId}|e:${v.employeeId}`;
  if (!r.companyId) return null;                       // no subject — nothing to compare it to
  return `${r.templateId}|c:${r.companyId}|${v.establishmentId ?? ""}`;
};

const groups = new Map<string, any[]>();
for (const r of runs) {
  const k = subjectOf(r);
  if (!k) continue;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const dupes = [...groups.values()].filter(g => g.length > 1);

const doneCount = async (id: string) =>
  prisma.workflowTask.count({ where: { instanceId: id, status: { in: ["done", "approved"] } } });

console.log(`${runs.length} running runs · ${dupes.length} subject(s) with more than one open\n`);
let cancelled = 0, repointed = 0, tasksClosed = 0;

for (const g of dupes) {
  const scored = await Promise.all(g.map(async r => ({ r, done: await doneCount(r.id) })));
  scored.sort((a, b) => b.done - a.done || String(a.r.startedAt).localeCompare(String(b.r.startedAt)));
  const keep = scored[0], drop = scored.slice(1);
  console.log(`${keep.r.template?.name} · ${keep.r.title}`);
  console.log(`   KEEP   ${keep.r.id} ${keep.r.startedAt} · ${keep.done} step(s) done`);
  for (const d of drop) console.log(`   CANCEL ${d.r.id} ${d.r.startedAt} · ${d.done} step(s) done`);

  if (!APPLY) { cancelled += drop.length; continue; }

  for (const d of drop) {
    await prisma.workflowInstance.update({ where: { id: d.r.id }, data: { status: "cancelled", completedAt: nowISO() } });
    await prisma.workflowTask.updateMany({ where: { instanceId: d.r.id, status: "active" }, data: { status: "skipped" } });
    const closed = await prisma.task.updateMany({ where: { workflowInstanceId: d.r.id, NOT: { status: "done" } }, data: { status: "cancelled" } });
    tasksClosed += closed.count;
    await prisma.workflowLog.create({ data: {
      instanceId: d.r.id, action: "instance.cancelled", actor: "duplicate-cleanup", at: nowISO(),
      detail: `Duplicate of ${keep.r.id} — same subject, raised by overlapping renewal passes. That run keeps the work.`,
    } });
    // The document must point at the survivor, or the next tick sees a finished renewal, releases
    // the claim and raises a THIRD.
    const moved = await prisma.document.updateMany({ where: { renewalRunId: d.r.id }, data: { renewalRunId: keep.r.id } });
    repointed += moved.count;
    cancelled++;
  }
}

console.log(APPLY
  ? `\napplied: ${cancelled} run(s) cancelled, ${tasksClosed} task row(s) closed, ${repointed} document claim(s) moved to the survivor`
  : `\nDRY RUN — ${cancelled} run(s) would be cancelled. Re-run with --apply.`);
await prisma.$disconnect();
