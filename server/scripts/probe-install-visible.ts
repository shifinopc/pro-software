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
import { readPack, planInstall, applyInstall, installedPacks, planUninstall } from "../src/packs.js";

const countryRow = async () => {
  const r = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
  const list = (r?.value as any)?.countries;
  return Array.isArray(list) ? list : [];
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const pack = readPack("pack-sa-2026.1.json");

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
  const svc = await prisma.serviceItem.findFirst({ where: { packKey: { not: null } }, select: { name: true, packModified: true } });
  console.log(`  adopted rows are marked as yours: ${svc?.packModified ? "YES" : "NO"} (e.g. "${svc?.name}")`);
  if (!svc?.packModified) fail("an adopted row is not marked as edited by you, so an upgrade could overwrite it");

  // ── and now it can be undone ──
  const un = await planUninstall("SA");
  console.log(`\nUninstall would now: ${un.totals.remove} removed · ${un.totals.retire} retired · ${un.totals.keep} kept`);
  console.log(`  (everything adopted is KEPT — your rows stay, they just stop being pack-managed)`);
  if (un.totals.remove > 0) fail(`${un.totals.remove} of YOUR rows would be DELETED by an uninstall — adoption should make them all "keep"`);
  if (!un.totals.keep) fail("uninstall found nothing to release");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
