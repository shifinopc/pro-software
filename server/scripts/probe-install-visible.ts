/**
 * Throwaway check for the two faults behind "I installed Saudi Arabia but nothing is listed".
 *
 * Run against a COPY of the real database, so the starting point is the one that actually failed:
 * a hand-built configuration, and a pack exported from it — meaning every row matches by name, so
 * there is nothing to create and everything to adopt.
 *
 *   1. install with adopting OFF   → must change nothing, and must be reported as changing nothing
 *   2. install with adopting ON    → must stamp the existing rows AND put the country on the screen
 *
 * The second assertion is the one that matters: without a country row there is no Uninstall button,
 * so an install could not be undone from the screen it was started on.
 */
import { prisma } from "../src/db.js";
import { readPack, planInstall, applyInstall, installedPacks, planUninstall, KINDS } from "../src/packs.js";
import { newestPackFile } from "./_pickpack.js";
import { requireScratchDatabase } from "./_scratch-guard.js";

const countryRow = async () => {
  const r = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
  const list = (r?.value as any)?.countries;
  return Array.isArray(list) ? list : [];
};

async function main() {
  await requireScratchDatabase("This probe", "copy");
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const pack = readPack(newestPackFile());

  const plan = await planInstall(pack);
  console.log(`the plan against your own configuration:`);
  console.log(`  ${plan.totals.create} to create · ${plan.totals.adopt} to adopt · ${plan.totals.installed} already installed`);
  if (plan.totals.create !== 0) console.log(`  (note: ${plan.totals.create} would be created — your config has drifted from the pack)`);

  // ── 1. adopting off: the path that silently did nothing ──
  const before = await prisma.documentType.count();
  const off = await applyInstall(pack, { adopt: false });
  const rowsAfterOff = await countryRow();
  console.log(`\nadopting OFF → ${off.created} created · ${off.adopted} adopted`);
  console.log(`  managed rows: ${JSON.stringify(await installedPacks())}`);
  console.log(`  country now on the screen: ${rowsAfterOff.length ? rowsAfterOff.map(r => r[0]).join(", ") : "NO"}`);
  // Even a no-op install registers the market — that is the point of pressing Install on a country.
  if (!rowsAfterOff.some(r => String(r[0]) === "Saudi Arabia")) fail("the country still does not appear on Country Rules");
  if (await prisma.documentType.count() !== before) fail("rows were created when nothing should have been");

  // ── 2. adopting on: the path that actually links the configuration ──
  const on = await applyInstall(pack, { adopt: true });
  console.log(`\nadopting ON  → ${on.created} created · ${on.adopted} adopted`);
  const inst = (await installedPacks())["SA"];
  console.log(`  Country Rules will read: Pack ${inst?.version} · ${inst?.rows} rows · ${inst?.edited} edited by you`);
  if (!inst || !inst.rows) fail("nothing became pack-managed, so there is still no Uninstall button");

  // Adoption must not have changed a single value — that is its whole promise.
  // Looked for across every kind rather than on serviceItem specifically: a pack carries whichever
  // kinds that market has, so asking one table meant this assertion silently checked nothing the
  // moment a pack shipped without services — `undefined` is not a passing row.
  let marked: { kind: string; name: string } | null = null;
  for (const kind of KINDS) {
    for (const row of await (prisma as any)[kind.model].findMany({ where: { packKey: { not: null }, packModified: true }, select: { name: true } })) {
      marked ??= { kind: kind.one, name: row.name };
    }
  }
  console.log(`  adopted rows are marked as yours: ${marked ? `YES (e.g. ${marked.kind} "${marked.name}")` : "NO - none found"}`);
  if (!marked) fail("no adopted row is marked as edited by you, so an upgrade could overwrite it");

  // ── and now it can be undone ──
  const un = await planUninstall("SA");
  console.log(`\nUninstall would now: ${un.totals.remove} removed · ${un.totals.retire} retired · ${un.totals.keep} kept`);
  console.log(`  (everything adopted is KEPT — your rows stay, they just stop being pack-managed)`);
  // The promise is about ADOPTED rows — the ones marked packModified. A row the pack itself created
  // and nobody has touched is correctly removed by an uninstall; asserting `remove === 0` made this
  // fail the moment the installation held any genuinely pack-owned row, which says nothing at all
  // about whether adoption protects your work.
  const removedIds = new Set(un.rows.filter(r => r.outcome === "remove").map(r => r.id));
  let yoursRemoved = 0;
  for (const kind of KINDS) {
    for (const row of await (prisma as any)[kind.model].findMany({ where: { packModified: true }, select: { id: true, name: true } }))
      if (removedIds.has(row.id)) { console.log(`      would delete YOUR ${kind.one} "${row.name}"`); yoursRemoved++; }
  }
  console.log(`  rows you edited that uninstall would delete: ${yoursRemoved}`);
  if (yoursRemoved > 0) fail(`${yoursRemoved} row(s) you edited would be DELETED by an uninstall - adoption should make them "keep"`);
  if (!un.totals.keep) fail("uninstall found nothing to release");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
