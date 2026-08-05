/**
 * Throwaway check for uninstall, run against a scratch database.
 *
 * Installs the pack, then deliberately creates the three situations uninstall has to tell apart:
 *   - a document type with a real document captured under it   → must RETIRE, never delete
 *   - a template someone edited after install                  → must be KEPT and unmanaged
 *   - everything untouched and unused                          → safe to REMOVE
 *
 * Then asserts the document survived, the retired row is hidden from lists but still readable, and no
 * client data was touched.
 */
import { prisma } from "../src/db.js";
import { readPack, applyInstall, planUninstall, applyUninstall } from "../src/packs.js";

async function main() {
  let bad = 0;
  const pack = readPack("pack-sa-2026.1.json");

  console.log("installing…");
  const ins = await applyInstall(pack, { adopt: false });
  console.log(`  ${ins.created} rows created\n`);

  // ── set up the three cases ──
  const co = await prisma.company.create({ data: { name: "ZZ Probe Client", cr: "0000", country: "SA" } });
  const iqama = await prisma.documentType.findFirst({ where: { name: "Iqama" } });
  const doc = await prisma.document.create({ data: {
    docType: "Iqama", person: "ZZ Probe Person", companyId: co.id,
    docNumber: "2-PROBE", expiryDate: "2027-01-01", status: "valid", daysLeft: 400,
  } });
  const edited = await prisma.workflowTemplate.findFirst({ where: { packKey: { not: null } } });
  await prisma.workflowTemplate.update({ where: { id: edited!.id }, data: { name: edited!.name + " (my version)", packModified: true } });

  console.log(`set up:`);
  console.log(`  a real document captured under "Iqama"`);
  console.log(`  "${edited!.name}" edited after install\n`);

  // ── the plan ──
  const plan = await planUninstall("SA");
  console.log(`uninstall plan — remove ${plan.totals.remove} · retire ${plan.totals.retire} · keep ${plan.totals.keep}\n`);
  for (const r of plan.rows.filter(r => r.outcome !== "remove")) {
    console.log(`  ${r.outcome.toUpperCase().padEnd(7)} ${r.one.padEnd(18)} ${r.name}`);
    console.log(`          ${r.why}`);
  }

  const iqamaRow = plan.rows.find(r => r.name === "Iqama");
  if (iqamaRow?.outcome !== "retire") { console.log("\n  ✗ Iqama should be RETIRED, it has a document"); bad++; }
  const editedRow = plan.rows.find(r => r.id === edited!.id);
  if (editedRow?.outcome !== "keep") { console.log("  ✗ the edited template should be KEPT"); bad++; }

  // ── carry it out ──
  const before = { docs: await prisma.document.count(), companies: await prisma.company.count() };
  const out = await applyUninstall("SA");
  console.log(`\ncarried out: ${out.removed} removed · ${out.retired} retired · ${out.kept} kept`);

  // ── the assertions that matter ──
  const docStill = await prisma.document.findUnique({ where: { id: doc.id } });
  console.log(`\n  the captured document survived:        ${docStill ? "YES" : "NO — DATA LOST"}`);
  if (!docStill) bad++;

  const iqamaAfter = await prisma.documentType.findUnique({ where: { id: iqama!.id } });
  console.log(`  its document type still readable:      ${iqamaAfter ? "YES" : "NO — ORPHANED"}`);
  console.log(`  …and marked retired:                   ${iqamaAfter?.retired ? "YES" : "NO"}`);
  if (!iqamaAfter || !iqamaAfter.retired) bad++;

  const visible = await prisma.documentType.count({ where: { retired: false } });
  const all = await prisma.documentType.count();
  console.log(`  hidden from pickers:                   ${all - visible} of ${all} retired`);

  const keptRow = await prisma.workflowTemplate.findUnique({ where: { id: edited!.id } });
  console.log(`  your edited template kept:             ${keptRow ? "YES" : "NO"}`);
  console.log(`  …and no longer managed by the pack:    ${keptRow && !keptRow.packKey ? "YES" : "NO"}`);
  if (!keptRow || keptRow.packKey) bad++;

  const after = { docs: await prisma.document.count(), companies: await prisma.company.count() };
  console.log(`\n  client data untouched:                 documents ${before.docs}->${after.docs} · clients ${before.companies}->${after.companies}`);
  if (before.docs !== after.docs || before.companies !== after.companies) bad++;

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
