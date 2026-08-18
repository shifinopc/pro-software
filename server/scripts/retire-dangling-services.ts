/**
 * Retire services that no longer lead anywhere.
 *
 * Stripping the country to one flow deleted the workflows behind the service catalogue. The services
 * survived — nothing deletes them — but every one now points at a workflow id that does not exist, or
 * at a document type that was retired with it. A catalogue entry a client can still order, which
 * starts nothing, is worse than one that is not offered.
 *
 * RETIRED, NOT DELETED, and the reason is specific: packages hold service ids and clients hold
 * subscriptions to those packages. Deleting the rows would leave both pointing at nothing — the exact
 * dangling reference the delete guards exist to prevent — while retiring takes them off the catalogue
 * and leaves every package and subscription intact and revivable.
 *
 * Only touches services that are actually broken. One that still resolves is left alone.
 *
 * Dry run by default; --apply writes.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const wfIds = new Set((await prisma.workflowTemplate.findMany({ select: { id: true } })).map(w => w.id));
  const liveDocs = new Set((await prisma.documentType.findMany({ where: { retired: false }, select: { name: true } })).map(d => d.name));

  let retired = 0, kept = 0;
  for (const s of await prisma.serviceItem.findMany({ where: { retired: false }, orderBy: { name: "asc" } })) {
    const why: string[] = [];
    if (s.workflowId && !wfIds.has(s.workflowId)) why.push("its workflow was removed");
    else if (!s.workflowId) why.push("it has no workflow");
    if (s.docType && !liveDocs.has(s.docType)) why.push(`its document type "${s.docType}" is retired`);
    if (!why.length) { kept++; console.log(`  keep    ${s.name}`); continue; }

    const inPackages: string[] = [];
    for (const p of await prisma.package.findMany({ select: { name: true, serviceIds: true } }))
      if (Array.isArray(p.serviceIds) && (p.serviceIds as string[]).includes(s.id)) inPackages.push(p.name);

    console.log(`  RETIRE  ${s.name.padEnd(34)} ${why.join(" and ")}${inPackages.length ? `  [in ${inPackages.join(", ")} — row kept]` : ""}`);
    if (APPLY) await prisma.serviceItem.update({ where: { id: s.id }, data: { retired: true } });
    retired++;
  }

  console.log(`\n${retired} retired · ${kept} still work${APPLY ? "" : "  — dry run, nothing written"}`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
