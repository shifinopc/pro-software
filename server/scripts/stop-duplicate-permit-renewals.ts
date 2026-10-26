/**
 * ONE RENEWAL, NOT TWO.
 *
 *   npx tsx scripts/stop-duplicate-permit-renewals.ts            # report only
 *   npx tsx scripts/stop-duplicate-permit-renewals.ts --apply
 *
 * A Saudi work permit is renewed WITH the Iqama and carries the same expiry, and since the Iqama
 * workflow was rebuilt it renews both. "Work Permit Renewal" went on auto-starting anyway, from its
 * own document-expiry trigger — and because the two fire a month apart (Iqama at 60 days, the permit
 * at 30) the second run is raised into a job the first is already doing. Nobody works it, so it sits
 * on step one until somebody asks why the Task List is full of month-old work permits.
 *
 * TWO THINGS, IN THIS ORDER, because the order is the whole trick:
 *
 *   1. the template stops triggering itself          trigger: document_expiry -> manual
 *   2. the duplicate runs are cancelled
 *
 * Cancel first and the hourly renewal pass re-arms the document and raises every one of them again
 * within the hour.
 *
 * THE TEMPLATE IS NOT RETIRED. A permit still has to be renewed on its own sometimes — a transfer, a
 * profession change, a first permit — and that is what this workflow is for. It just must not raise
 * itself from an expiry date that belongs to the Iqama.
 *
 * ONLY PROVEN DUPLICATES ARE CANCELLED: a permit run whose employee has an Iqama renewal running
 * right now. A permit run that is the only one for that person is somebody's real work and is left
 * alone — as is any run with no employeeId, where the claim cannot be checked at all.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const nowISO = () => new Date().toISOString();

/**
 * WHO A RUN IS ABOUT — and why one key is not enough.
 *
 * This read `variables.employeeId`, and that quietly let three duplicates through: a run started by
 * hand carries the person's NAME and no id (there is no employeeId column on an instance, only
 * whatever is in variables), so a permit run failed to match an Iqama renewal running for the very
 * same employee and the report called it genuine work.
 *
 * Keying by name INSTEAD was the obvious repair and is just as broken the other way: one side then
 * holds "id:abc" and the other "name:…", two key spaces that can never meet however equal the
 * people are. So a run offers EVERY key it can prove, and two runs are the same person if they
 * share any one of them.
 *
 * The name key is scoped to the client, because two employees of one name in one company is the
 * case that makes a bare name wrong — the same name+company fallback completeTask already uses.
 */
const keysOf = (i: { variables: unknown; title: string; companyId: string | null }): string[] => {
  const out: string[] = [];
  const id = String(((i.variables ?? {}) as any).employeeId ?? "").trim();
  if (id) out.push("id:" + id);
  const name = i.title.replace(/.*—\s*/, "").trim().toLowerCase();
  if (name && name !== i.title.trim().toLowerCase()) out.push(`name:${i.companyId ?? "-"}:${name}`);
  return out;
};

const main = async () => {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Work Permit Renewal" } });
  if (!tpl) throw new Error('No workflow template named "Work Permit Renewal"');

  // The claim this rests on, checked rather than assumed: if anyone holds a permit and no Iqama,
  // switching the trigger off would leave their permit with nothing to renew it.
  const docs = await prisma.document.findMany({
    where: { docType: { in: ["Iqama", "Work Permit"] }, supersededAt: null },
    select: { docType: true, employeeId: true, expiryDate: true },
  });
  const byEmp: Record<string, Record<string, string | null>> = {};
  for (const d of docs) if (d.employeeId) (byEmp[d.employeeId] ??= {})[d.docType] = d.expiryDate;
  const people = Object.values(byEmp);
  const orphans = people.filter(p => p["Work Permit"] && !p.Iqama).length;
  const both = people.filter(p => p["Work Permit"] && p.Iqama);
  const disagree = both.filter(p => p.Iqama !== p["Work Permit"]).length;

  console.log(`template:  ${tpl.name}  trigger=${(tpl as any).trigger}  ${JSON.stringify(tpl.triggerConfig)}`);
  console.log(`people holding both documents: ${both.length}   expiry dates that disagree: ${disagree}`);
  console.log(`people holding a Work Permit and NO Iqama: ${orphans}`);
  if (orphans > 0) {
    console.log(`\n  STOP. ${orphans} permit(s) have no Iqama to be renewed alongside. Switching the`);
    console.log(`        trigger off would leave them with nothing to renew them. Fix those first.`);
    process.exitCode = 1;
    return;
  }

  const running = await prisma.workflowInstance.findMany({
    where: { status: "running" },
    select: { id: true, title: true, clientName: true, companyId: true, variables: true, startedAt: true, template: { select: { name: true } } },
  });
  const iqamaFor = new Set(running.filter(i => i.template.name === "Iqama Renewal").flatMap(keysOf));
  const permits = running.filter(i => i.template.name === "Work Permit Renewal");
  const dupes = permits.filter(i => keysOf(i).some(k => iqamaFor.has(k)));
  const keep = permits.filter(i => !dupes.includes(i));

  console.log(`\nrunning Work Permit renewals: ${permits.length}`);
  console.log(`  duplicates (same person has an Iqama renewal running): ${dupes.length}`);
  console.log(`  left alone: ${keep.length}`);
  for (const k of keep) {
    // No Iqama renewal for this person. Either it is genuinely not due, or the renewal pass is
    // HOLDING it on a prerequisite — which is the answer somebody reading this list actually wants,
    // because then the permit is not blocked on the permit at all.
    const name = k.title.replace(/—.*/, "").trim() && k.title.replace(/.*—\s*/, "").trim();
    const held = await prisma.notification.findFirst({
      where: { dedupeKey: { startsWith: "renewal-held:" }, message: { contains: name } },
      select: { message: true },
    });
    const other = await prisma.workflowInstance.findMany({
      where: { status: "running", title: { contains: name }, NOT: { template: { name: "Work Permit Renewal" } } },
      select: { template: { select: { name: true } } },
    });
    console.log(`      keep  ${k.clientName ?? "—"} — ${k.title}`);
    if (held) console.log(`              Iqama renewal held: ${held.message}`);
    if (other.length) console.log(`              also running: ${other.map(o => o.template.name).join(", ")}`);
  }

  if (!APPLY) return console.log(`\nreport only. Re-run with --apply to switch the trigger off and cancel ${dupes.length}.`);

  await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { trigger: "manual" } });
  console.log(`\ntrigger: document_expiry -> manual (the template stays active and startable by hand)`);

  let steps = 0, tasks = 0;
  for (const i of dupes) {
    await prisma.workflowInstance.update({ where: { id: i.id }, data: { status: "cancelled", completedAt: nowISO() } });
    // Exactly what POST /instances/:id/cancel does: the run, its open steps, and the task row that
    // carries it. Leaving any of the three behind is how an officer keeps work in their inbox for
    // something that was called off.
    steps += (await prisma.workflowTask.updateMany({ where: { instanceId: i.id, status: "active" }, data: { status: "skipped" } })).count;
    tasks += (await prisma.task.updateMany({ where: { workflowInstanceId: i.id, NOT: { status: "done" } }, data: { status: "cancelled" } })).count;
    await prisma.workflowLog.create({ data: {
      instanceId: i.id, action: "instance.cancelled", actor: "stop-duplicate-permit-renewals",
      detail: "The Iqama renewal for this employee renews the work permit with it", at: nowISO() } });
  }
  console.log(`cancelled ${dupes.length} run(s), ${steps} open step(s), ${tasks} task row(s)`);
  console.log(`\nThe hourly renewal pass clears renewalRunId on those permits by itself; with the`);
  console.log(`trigger off, nothing raises them again.`);
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
