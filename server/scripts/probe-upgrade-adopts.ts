/**
 * Throwaway check that upgrading a pack cannot collide with configuration made here by hand.
 *
 * THE FAILURE THIS REPRODUCES, verbatim from the console:
 *
 *   Invalid `prisma.documentType.create()` invocation:
 *   Unique constraint failed on the constraint: `DocumentType_name_key`
 *
 * How it happens, and it is not exotic — it is the ordinary consequence of exporting your own work:
 * a document type built here has no packKey. Exporting derives a key from its name, so the pack now
 * carries `sa.doctype.qiwa-employment-contract` for a row that is stamped with nothing. planUpgrade
 * matched local rows on packKey ALONE, found no match, and classified it as an add — and `name` is
 * globally unique, so the create threw. Mid-upgrade, with earlier rows already written.
 *
 * The subtle half is what must NOT change: `dropped` is every stamped local row whose key the new
 * pack no longer carries, and it is handed to planRemoval, which deletes what nothing depends on.
 * Hand-made rows must therefore stay out of that set. Widening one query to fix the collision would
 * have turned every upgrade into a purge of the configuration somebody built. So this checks the
 * survival of an unrelated hand-made row as carefully as it checks the adoption.
 *
 * Own country, own rows. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { planUpgrade, applyUpgrade, applyInstall, KINDS, type Pack, forgetCountryRow } from "../src/packs.js";

const C = "ZU";

async function wipe() {
  for (const k of KINDS) await (prisma as any)[k.model].deleteMany({ where: { country: C } });
  // applyInstall also puts the country on the Country Rules screen. Deleting the rows is not enough:
  // without this the fixture market stays listed, with Configure and Export leading to nothing. A
  // "ZU" appeared on the production screen exactly this way.
  await forgetCountryRow(C);
}

const packV = (version: string, docs: { key: string; name: string }[]): Pack => ({
  country: C, countryName: "Probe Country", version,
  documentTypes: docs.map(d => ({ ...d, subjectKind: "employee", leadDays: 30 })),
} as any);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await wipe();

  // v1 installs one row the pack owns.
  await applyInstall(packV("1.0", [{ key: "zu.doctype.owned", name: "ZU Owned Type" }]));

  // …and this installation then builds two of its own, exactly as add-onboarding-hiring-type does.
  await prisma.documentType.create({ data: { name: "ZU Hand Built", country: C, subjectKind: "employee", leadDays: 99 } });
  await prisma.documentType.create({ data: { name: "ZU Unrelated", country: C, subjectKind: "employee", leadDays: 7 } });
  console.log("installed 1 pack row, then built 2 by hand (one of which the next pack will carry)\n");

  // v2 is what you get by exporting this installation: it now carries a key for the hand-built row.
  const v2 = packV("2.0", [
    { key: "zu.doctype.owned", name: "ZU Owned Type" },
    { key: "zu.doctype.hand-built", name: "ZU Hand Built" },
    { key: "zu.doctype.brand-new", name: "ZU Brand New" },
  ]);

  const plan = await planUpgrade(v2);
  const of = (n: string) => plan.rows.find(r => r.name === n)?.outcome;
  console.log(`the hand-built row is ADOPTED, not added:   ${of("ZU Hand Built") === "adopt" ? "YES" : "NO (" + of("ZU Hand Built") + ")"}`);
  if (of("ZU Hand Built") !== "adopt") fail("planned as an add — the create will throw on the unique name, mid-upgrade");
  console.log(`a genuinely new row is still an add:        ${of("ZU Brand New") === "add" ? "YES" : "NO (" + of("ZU Brand New") + ")"}`);
  if (of("ZU Brand New") !== "add") fail("a new row was not planned as an add, so the pack would never deliver it");

  // The half that matters more: the unrelated hand-made row must not be up for removal.
  const goneNames = plan.gone.map(r => r.name);
  console.log(`an unrelated hand-made row is NOT dropped:  ${goneNames.includes("ZU Unrelated") ? "NO" : "YES"}`);
  if (goneNames.includes("ZU Unrelated")) fail("a row this installation built is queued for removal — an upgrade would purge hand-made configuration");

  // ── a row installed before configuration had a country ────────────────────────────────────
  //
  // Early packs wrote rows with country: null. planUpgrade scopes its lookup by country, so those
  // rows were invisible and every one was planned as an ADD — and on a table whose name is not
  // unique that does not fail, it silently makes a second copy. Four duplicate authorities on the
  // live installation came from exactly this, and were removed by hand before the cause was known.
  await prisma.govCenter.deleteMany({ where: { OR: [{ country: C }, { packKey: "zu.center.legacy" }] } });
  await prisma.govCenter.create({ data: { name: "ZU Legacy Authority", country: null, packKey: "zu.center.legacy", packVersion: "1.0", sub: "installed before countries existed" } });
  const v3: any = JSON.parse(JSON.stringify(v2));
  v3.version = "3.0";
  v3.govCenters = [{ key: "zu.center.legacy", name: "ZU Legacy Authority", sub: "installed before countries existed" }];

  const p3 = await planUpgrade(v3);
  const legacyRow = p3.rows.find(r => r.key === "zu.center.legacy");
  console.log(`
a country-less row is recognised, not re-added: ${legacyRow && legacyRow.outcome !== "add" ? `YES (${legacyRow.outcome})` : "NO (" + legacyRow?.outcome + ")"}`);
  if (!legacyRow || legacyRow.outcome === "add") fail("planned as an add — the upgrade would silently create a duplicate authority");

  await applyUpgrade(v3);
  const copies = await prisma.govCenter.count({ where: { name: "ZU Legacy Authority" } });
  console.log(`there is one of it afterwards:              ${copies === 1 ? "YES" : "NO (" + copies + ")"}`);
  if (copies !== 1) fail(`the upgrade produced ${copies} copies of the same authority`);
  const fixed = await prisma.govCenter.findFirst({ where: { name: "ZU Legacy Authority" } });
  console.log(`…and it now carries a country:             ${fixed?.country ?? "still null"}`);
  if (!fixed?.country) fail("country was not filled in, so the NEXT upgrade duplicates it again");
  await prisma.govCenter.deleteMany({ where: { name: "ZU Legacy Authority" } });

  // ── and it actually runs ──────────────────────────────────────────────────────────────────
  let threw = "";
  try { await applyUpgrade(v2); } catch (e: any) { threw = String(e?.message ?? e); }
  console.log(`\nthe upgrade completes:                      ${threw ? "NO" : "YES"}`);
  if (threw) fail("upgrade threw: " + threw.split("\n")[0]);

  const hand = await prisma.documentType.findFirst({ where: { country: C, name: "ZU Hand Built" } });
  const dupes = await prisma.documentType.count({ where: { country: C, name: "ZU Hand Built" } });
  console.log(`there is exactly one of it afterwards:      ${dupes === 1 ? "YES" : "NO (" + dupes + ")"}`);
  if (dupes !== 1) fail("the upgrade duplicated a row it should have recognised");
  console.log(`it now carries the pack's key:              ${hand?.packKey === "zu.doctype.hand-built" ? "YES" : "NO (" + hand?.packKey + ")"}`);
  if (hand?.packKey !== "zu.doctype.hand-built") fail("not stamped, so the NEXT upgrade collides all over again");
  console.log(`its own values were kept:                   ${hand?.leadDays === 99 ? "YES" : "NO (" + hand?.leadDays + ")"}`);
  if (hand?.leadDays !== 99) fail("adoption overwrote values somebody set here");
  console.log(`…and it is marked as a local variant:       ${hand?.packModified ? "YES" : "NO"}`);
  if (!hand?.packModified) fail("not marked, so a later upgrade would silently overwrite their work");

  const unrelated = await prisma.documentType.findFirst({ where: { country: C, name: "ZU Unrelated" } });
  console.log(`the unrelated hand-made row survived:       ${unrelated ? "YES" : "NO — IT WAS DELETED"}`);
  if (!unrelated) fail("the upgrade destroyed configuration this installation built");

  const brandNew = await prisma.documentType.findFirst({ where: { country: C, name: "ZU Brand New" } });
  console.log(`the new row arrived:                        ${brandNew ? "YES" : "NO"}`);
  if (!brandNew) fail("the pack's new row was never created");

  await wipe();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await wipe(); process.exit(1); });
