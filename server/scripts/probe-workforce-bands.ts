/**
 * Throwaway check: configured thresholds decide the band, and disagreement is surfaced.
 *
 * The point of this feature is that a band stops being a fact somebody typed in and becomes something
 * the ratio determines. So the assertions are about the BOUNDARIES — a client sitting exactly on one
 * must land in the band the thresholds say, not the one next to it — and about what happens when the
 * computed band and the one read off the portal disagree.
 *
 * Own client, own bands, own staff. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { workforceFor, recordBand } from "../src/workforce.js";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const COUNTRY = "ZZ";   // a country of its own, so no real configuration is touched

  const bands = [
    { name: "ZZ Red", minBp: 0, maxBp: 2500, color: "#C0353A", bg: "#FEECEC", sort: 1 },
    { name: "ZZ Yellow", minBp: 2500, maxBp: 5000, color: "#B8860B", bg: "#FEF4E2", sort: 2 },
    { name: "ZZ Green", minBp: 5000, maxBp: 7500, color: "#0E9355", bg: "#E7F8EF", sort: 3 },
    { name: "ZZ Platinum", minBp: 7500, maxBp: null, color: "#4B4757", bg: "#F2F1F5", sort: 4 },
  ];
  for (const b of bands) await prisma.workforceBand.create({ data: { ...b, country: COUNTRY } });
  console.log(`bands configured for ${COUNTRY}: ${bands.map(b => b.name + " " + (b.minBp / 100) + "%+").join(" · ")}\n`);

  const co = await prisma.company.create({ data: { name: "ZZ Bands Probe", cr: "0000", country: COUNTRY } });
  const add = (n: number, national: boolean) => Promise.all(
    Array.from({ length: n }, (_v, i) => prisma.employee.create({
      data: { companyId: co.id, name: `ZZ ${national ? "Nat" : "Exp"} ${i}`, workCountry: COUNTRY, nationality: national ? COUNTRY : "IN" },
    })),
  );

  // Each step lands the ratio exactly on a boundary — the case an off-by-one gets wrong.
  const steps: [number, number, string][] = [
    [1, 9, "ZZ Red"],        // 10%
    [0, 0, "ZZ Red"],
    [4, 0, "ZZ Yellow"],     // 5/14 = 35.71%
    [3, 0, "ZZ Green"],      // 8/17 = 47.06% → still Yellow; adjusted below
  ];
  await add(steps[0][0], true); await add(steps[0][1], false);
  let w = (await workforceFor(co.id))!;
  console.log(`1 national of 10  → ${(w.ratioMinBp / 100).toFixed(2)}%  band ${w.computedBand?.name}`);
  if (w.computedBand?.name !== "ZZ Red") fail(`10% should be ZZ Red, got ${w.computedBand?.name}`);

  // Exactly on the 25% boundary: minBp is INCLUSIVE, so 25% belongs to Yellow, not Red.
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(1, true); await add(3, false);
  w = (await workforceFor(co.id))!;
  console.log(`1 of 4 = exactly 25% → band ${w.computedBand?.name}  (boundary belongs to the upper band)`);
  if (w.computedBand?.name !== "ZZ Yellow") fail(`25% should be ZZ Yellow, got ${w.computedBand?.name}`);

  // Exactly on 75% → Platinum, and the top band has no ceiling.
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(3, true); await add(1, false);
  w = (await workforceFor(co.id))!;
  console.log(`3 of 4 = exactly 75% → band ${w.computedBand?.name}`);
  if (w.computedBand?.name !== "ZZ Platinum") fail(`75% should be ZZ Platinum, got ${w.computedBand?.name}`);

  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(4, true);
  w = (await workforceFor(co.id))!;
  console.log(`4 of 4 = 100%       → band ${w.computedBand?.name}  (no ceiling on the top band)`);
  if (w.computedBand?.name !== "ZZ Platinum") fail("100% fell outside every band — the top band needs an open ceiling");

  // ── what the next band would take ──
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(1, true); await add(3, false);
  w = (await workforceFor(co.id))!;
  console.log(`\nat 25%: next band is ${w.nextBand?.name} at ${(w.nextBand!.atBp / 100)}% — ${(w.nextBand!.needBp / 100).toFixed(2)} points away`);
  if (w.nextBand?.name !== "ZZ Green") fail(`next band from Yellow should be ZZ Green, got ${w.nextBand?.name}`);

  // ── computed vs recorded ──
  await recordBand(co.id, "ZZ Green", "2026-08-05", "Probe portal");
  w = (await workforceFor(co.id))!;
  console.log(`\nrecorded "${w.band}" but the ratio computes "${w.computedBand?.name}" → mismatch flagged: ${w.bandMismatch}`);
  if (!w.bandMismatch) fail("a recorded band that disagrees with the computed one was not flagged");

  await recordBand(co.id, "ZZ Yellow", "2026-08-05", "Probe portal");
  w = (await workforceFor(co.id))!;
  console.log(`recorded "${w.band}" matching the computed one → mismatch flagged: ${w.bandMismatch}`);
  if (w.bandMismatch) fail("agreeing bands were reported as a mismatch");

  // ── a country with no bands configured must not invent one ──
  const co2 = await prisma.company.create({ data: { name: "ZZ No Bands", cr: "0001", country: "QQ" } });
  await prisma.employee.create({ data: { companyId: co2.id, name: "ZZ Solo", workCountry: "QQ", nationality: "QQ" } });
  const w2 = (await workforceFor(co2.id))!;
  console.log(`\ncountry with no bands: ratio ${(w2.ratioMinBp / 100)}% · computed band ${w2.computedBand === null ? "null (correct — nothing invented)" : w2.computedBand.name}`);
  if (w2.computedBand !== null) fail("a band was invented for a country with no thresholds configured");

  // ── clean up ──
  await prisma.employee.deleteMany({ where: { companyId: { in: [co.id, co2.id] } } });
  await prisma.company.deleteMany({ where: { id: { in: [co.id, co2.id] } } });
  await prisma.workforceBand.deleteMany({ where: { country: COUNTRY } });
  const left = await prisma.workforceBand.count({ where: { country: COUNTRY } })
    + await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })
    + await prisma.employee.count({ where: { name: { startsWith: "ZZ " } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
