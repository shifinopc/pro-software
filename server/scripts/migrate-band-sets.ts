/**
 * Adopt every existing band into a default scheme for its country.
 *
 * Bands used to hang off the country alone. Now they hang off a SCHEME, and a client points at the
 * scheme that judges it. That leaves every row already in this database belonging to no ladder, and
 * `bandsForCompany` deliberately ignores those rather than applying them to everybody — so without
 * this pass, an upgraded installation would compute no band for any client at all.
 *
 * What it does: one scheme per country that has bands, named for the country, marked `isDefault`,
 * holding exactly the rows that country already had. Every client keeps the band it has today and
 * nobody has to configure anything before the app works again.
 *
 * Idempotent. Re-running adopts only rows that are still unassigned, and never creates a second
 * default for a country that has one.
 */
import { prisma } from "../src/db.js";
import { countryName } from "../src/countries.js";

async function main() {
  const orphans = await prisma.workforceBand.findMany({ where: { setId: null }, select: { id: true, country: true } });
  if (!orphans.length) {
    const sets = await prisma.workforceBandSet.count();
    console.log(`nothing to adopt — every band already belongs to a scheme (${sets} scheme(s) on file)`);
    await prisma.$disconnect();
    return;
  }

  // Grouped in code rather than by a groupBy so a null country is handled explicitly: those rows
  // predate country scoping and would otherwise be adopted into a scheme nobody can find.
  const byCountry = new Map<string, string[]>();
  for (const b of orphans) {
    const key = String(b.country ?? "");
    byCountry.set(key, [...(byCountry.get(key) ?? []), b.id]);
  }

  for (const [country, ids] of byCountry) {
    if (!country) {
      console.log(`  ${ids.length} band(s) have no country — left unassigned, since there is no country whose default they could be`);
      continue;
    }
    const label = countryName(country) || country;
    let set = await prisma.workforceBandSet.findFirst({ where: { country, isDefault: true, retired: false } });
    if (!set) {
      set = await prisma.workforceBandSet.create({
        data: { country, name: `${label} — default`, isDefault: true, sort: 0, packKey: `${country.toLowerCase()}.bandset.default` },
      });
      console.log(`  created default scheme "${set.name}" for ${country}`);
    } else {
      console.log(`  ${country} already has a default scheme ("${set.name}")`);
    }
    await prisma.workforceBand.updateMany({ where: { id: { in: ids } }, data: { setId: set.id } });
    console.log(`    adopted ${ids.length} band(s) into it`);
  }

  const left = await prisma.workforceBand.count({ where: { setId: null } });
  console.log(`\ndone — ${left} band(s) still unassigned`);
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
