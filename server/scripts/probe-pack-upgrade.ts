/**
 * Throwaway check for upgrade, run against a scratch database.
 *
 * Installs v1, then builds a v2 in memory that exercises every outcome at once, and sets up the two
 * situations the upgrade has to respect rather than steamroll:
 *   - a row the user edited after installing   → must be left ALONE, changes only reported
 *   - a row retired by an earlier uninstall    → must come back, not be duplicated beside itself
 *
 * The interesting assertions are the negative ones: that an edited row keeps its values and its
 * workflow binding, and that a dropped row still in use is retired rather than deleted.
 */
import { prisma } from "../src/db.js";
import { readPack, applyInstall, planUpgrade, applyUpgrade, installedPacks, type Pack } from "../src/packs.js";
import { requireScratchDatabase } from "./_scratch-guard.js";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await requireScratchDatabase("This probe");

  const v1: Pack = JSON.parse(JSON.stringify(readPack("pack-sa-2026.2.json")));
  // A row nothing will ever reference, so that "dropped and unused" can actually be tested. Every
  // real checklist rule in this pack is used by a workflow step, which makes them all retire cases.
  v1.checklistRules!.push({ key: "sa.checklist.zz-unused", name: "ZZ Unused Rule", rows: [] } as any);
  console.log("installing v1…");
  const ins = await applyInstall(v1, { adopt: false });
  console.log(`  ${ins.created} rows created\n`);

  // ── build v2 ──
  const v2: Pack = JSON.parse(JSON.stringify(v1));
  v2.version = "2026.3";

  const CHANGED = v2.documentTypes![0];               // pack changes it, nobody here did → update
  CHANGED.defaultFee = (CHANGED.defaultFee ?? 0) + 250;
  CHANGED.leadDays = 99;

  const EDITED = v2.serviceItems![0];                 // user edited it → yours, left alone
  EDITED.govFee = 4242;

  const RETIRED = v2.documentTypes![1];               // retired earlier → revive
  const DROPPED_USED = v2.documentTypes![2];          // dropped by v2, has a document → retire
  const DROPPED_FREE = v2.checklistRules!.find(c => c.key === "sa.checklist.zz-unused")!;  // dropped by v2, unused → remove
  v2.documentTypes = v2.documentTypes!.filter(d => d.key !== DROPPED_USED.key);
  v2.checklistRules = v2.checklistRules!.filter(c => c.key !== DROPPED_FREE.key);

  const ADDED = { key: "sa.doctype.zz-new-in-v2", name: "ZZ New In v2", subjectKind: "company", defaultFee: 100, leadDays: 5 };
  v2.documentTypes!.push(ADDED as any);

  // ── set up the local state v2 has to respect ──
  const svc = await prisma.serviceItem.findFirst({ where: { packKey: EDITED.key } });
  await prisma.serviceItem.update({ where: { id: svc!.id }, data: { govFee: 111, packModified: true } });
  const keptBinding = (await prisma.serviceItem.findUnique({ where: { id: svc!.id } }))!.workflowId;

  await prisma.documentType.updateMany({ where: { packKey: RETIRED.key }, data: { retired: true } });

  const usedType = await prisma.documentType.findFirst({ where: { packKey: DROPPED_USED.key } });
  const co = await prisma.company.create({ data: { name: "ZZ Upgrade Client", cr: "0000", country: "SA" } });
  const doc = await prisma.document.create({ data: {
    docType: usedType!.name, person: "ZZ Upgrade Person", companyId: co.id,
    docNumber: "2-UPG", expiryDate: "2027-01-01", status: "valid", daysLeft: 400,
  } });

  console.log("set up:");
  console.log(`  "${EDITED.name}" edited here (gov fee 111)`);
  console.log(`  "${RETIRED.name}" retired by an earlier uninstall`);
  console.log(`  "${usedType!.name}" dropped by v2 but has a document\n`);

  // ── the plan ──
  const plan = await planUpgrade(v2);
  const t = plan.totals;
  console.log(`upgrade ${plan.from} → ${plan.to}`);
  console.log(`  add ${t.add} · update ${t.update} · unchanged ${t.unchanged} · yours ${t.yours} · revive ${t.revive}`);
  console.log(`  dropped by this version: remove ${t.remove} · retire ${t.retire} · keep ${t.keep}\n`);

  const row = (key: string) => plan.rows.find(r => r.key === key);
  if (row(ADDED.key)?.outcome !== "add") fail(`"${ADDED.name}" should be ADD`);
  if (row(CHANGED.key)?.outcome !== "update") fail(`"${CHANGED.name}" should be UPDATE`);
  if (row(EDITED.key)?.outcome !== "yours") fail(`"${EDITED.name}" should be YOURS`);
  if (row(RETIRED.key)?.outcome !== "revive") fail(`"${RETIRED.name}" should be REVIVE`);

  // The whole point of the stable comparison: untouched rows must not drift into "update".
  console.log(`untouched rows reported unchanged:     ${t.unchanged}`);
  if (t.unchanged < 40) fail(`only ${t.unchanged} unchanged — identical rows are being reported as changed`);
  if (t.update !== 1) fail(`${t.update} updates, expected exactly 1`);

  const ch = row(CHANGED.key)!.changes;
  console.log(`the changed row lists its fields:      ${ch.map(c => `${c.field} ${c.from}→${c.to}`).join(", ")}`);
  if (!ch.some(c => c.field === "defaultFee")) fail("the fee change was not detected");

  const yoursChanges = row(EDITED.key)!.changes;
  console.log(`the edited row still SHOWS the diff:   ${yoursChanges.map(c => `${c.field} ${c.from}→${c.to}`).join(", ")}`);
  if (!yoursChanges.length) fail("an edited row should still report what the pack would have changed");

  const goneUsed = plan.gone.find(g => g.id === usedType!.id);
  const goneFree = plan.gone.find(g => g.name === DROPPED_FREE.name);
  console.log(`\ndropped but in use:                    ${goneUsed?.outcome.toUpperCase()} — ${goneUsed?.why}`);
  console.log(`dropped and unused:                    ${goneFree?.outcome.toUpperCase()} — ${goneFree?.why}`);
  if (goneUsed?.outcome !== "retire") fail("a dropped type with a document must be RETIRED, not deleted");
  if (goneFree?.outcome !== "remove") fail("a dropped unused rule should be removed");

  // ── carry it out ──
  const before = { docs: await prisma.document.count(), companies: await prisma.company.count() };
  const out = await applyUpgrade(v2);
  console.log(`\ncarried out: ${out.added} added · ${out.updated} updated · ${out.revived} revived · ${out.yours} left as yours · ${out.removed} removed · ${out.retired} retired`);
  if (out.unresolved.length) console.log(`  unresolved references: ${out.unresolved.length}`);

  // ── what the database looks like afterwards ──
  const changedAfter = await prisma.documentType.findFirst({ where: { packKey: CHANGED.key } });
  console.log(`\n  the pack's change applied:           fee ${changedAfter?.defaultFee} (expected ${CHANGED.defaultFee})`);
  if (changedAfter?.defaultFee !== CHANGED.defaultFee) fail("the update did not apply");

  // The field that used to be named "entity" and therefore shipped nothing. A company-scoped type
  // arriving as employee-scoped is silent and wrong, so it is asserted rather than eyeballed.
  const addedAfter = await prisma.documentType.findFirst({ where: { packKey: ADDED.key } });
  console.log(`  subjectKind travelled:               ${addedAfter?.subjectKind} (expected company)`);
  if (addedAfter?.subjectKind !== "company") fail("subjectKind still does not travel in a pack");

  const editedAfter = await prisma.serviceItem.findUnique({ where: { id: svc!.id } });
  console.log(`  your edit survived:                  gov fee ${editedAfter?.govFee} (must still be 111)`);
  if (editedAfter?.govFee !== 111) fail("an edited row was overwritten by the upgrade");
  console.log(`  …and kept its own workflow binding:  ${editedAfter?.workflowId === keptBinding ? "YES" : "NO — REWIRED"}`);
  if (editedAfter?.workflowId !== keptBinding) fail("an edited row had its workflow binding rewritten");
  console.log(`  …and is still marked as yours:       ${editedAfter?.packModified ? "YES" : "NO"}`);
  if (!editedAfter?.packModified) fail("packModified was cleared, so the row silently became pack-owned");

  const revivedAfter = await prisma.documentType.findFirst({ where: { packKey: RETIRED.key } });
  const dupes = await prisma.documentType.count({ where: { packKey: RETIRED.key } });
  console.log(`  the retired row came back:           ${revivedAfter && !revivedAfter.retired ? "YES" : "NO"} (${dupes} row, not duplicated)`);
  if (!revivedAfter || revivedAfter.retired || dupes !== 1) fail("revive did not work");

  const usedAfter = await prisma.documentType.findUnique({ where: { id: usedType!.id } });
  console.log(`  the in-use dropped type retired:     ${usedAfter?.retired ? "YES" : "NO"}`);
  if (!usedAfter?.retired) fail("a dropped in-use type was not retired");

  // Live rows move to the new version. A row v2 withdrew keeps the version that last contained it —
  // stamping it 2026.3 would claim it is part of a version that dropped it.
  const live = await prisma.documentType.findMany({ where: { packKey: { not: null }, retired: false }, select: { packVersion: true } });
  const stale = live.filter(v => v.packVersion !== "2026.3").length;
  console.log(`  every live row says 2026.3:          ${stale === 0 ? "YES" : "NO — " + stale + " still on the old version"}`);
  if (stale) fail("the version stamp did not move everywhere");

  const reported = (await installedPacks())["SA"];
  console.log(`  the country reports:                 ${reported?.version}${reported?.mixed ? " (mixed)" : ""}`);
  if (reported?.version !== "2026.3") fail(`Country Rules would still show ${reported?.version} after upgrading`);

  const after = { docs: await prisma.document.count(), companies: await prisma.company.count() };
  console.log(`\n  client data untouched:               documents ${before.docs}->${after.docs} · clients ${before.companies}->${after.companies}`);
  if (before.docs !== after.docs || before.companies !== after.companies) fail("client data changed");

  // ── upgrading again must be a no-op ──
  const again = await planUpgrade(v2);
  console.log(`  running it twice changes nothing:    add ${again.totals.add} · update ${again.totals.update} · remove ${again.totals.remove}`);
  if (again.totals.add || again.totals.update || again.totals.remove) fail("the upgrade is not idempotent");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
