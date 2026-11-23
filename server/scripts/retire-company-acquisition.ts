/**
 * Retires the standalone "Company Acquisition" workflow.
 *
 * Business Setup already runs acquisition inside itself - three lanes, parent company plus two
 * shells - so the standalone template was a second definition of the same job. Retiring rather than
 * deleting is what the engine supports: `startInstance` refuses a retired template, the builder list
 * and every picker filter it out, and runs already under way are untouched. Eight were running when
 * this was written and they are meant to finish.
 *
 * The service binding is cleared too. Left pointing at a retired template, an acquisition-only
 * quotation would record a start failure on delivery; cleared, the line simply becomes a task, which
 * is what was asked for. The note saying the work happens inside the Business Setup case still
 * appears (see delivery.ts).
 *
 * Idempotent, and prints what it found either way.
 *   npx tsx scripts/retire-company-acquisition.ts [--undo]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const undo = process.argv.includes("--undo");

(async () => {
  const tpl = await prisma.workflowTemplate.findFirst({
    where: { name: "Company Acquisition" },
    select: { id: true, name: true, retired: true, active: true },
  });
  if (!tpl) { console.log("No 'Company Acquisition' template here - nothing to do."); return; }

  const runs = await prisma.workflowInstance.count({ where: { templateId: tpl.id, status: "running" } });
  const svcs = await prisma.serviceItem.findMany({ where: { workflowId: tpl.id }, select: { id: true, name: true } });

  console.log(`template ${tpl.id} retired=${tpl.retired} active=${tpl.active}`);
  console.log(`running cases: ${runs} (left alone)`);
  console.log(`service bindings: ${svcs.map(s => s.name).join(", ") || "none"}`);

  if (undo) {
    await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { retired: false } });
    console.log("UNDONE: the template can start new work again. Re-bind the service by hand if you want that too.");
    return;
  }

  await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { retired: true } });
  for (const s of svcs) await prisma.serviceItem.update({ where: { id: s.id }, data: { workflowId: null } });
  console.log(`DONE: retired, ${svcs.length} binding(s) cleared. The ${runs} running case(s) continue.`);
})().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); })
  .finally(() => prisma.$disconnect());
