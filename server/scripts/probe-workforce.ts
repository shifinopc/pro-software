/**
 * Throwaway check for workforce nationalisation. Creates its own client and staff, then deletes them.
 *
 * The assertions that matter are the ones about NOT KNOWING:
 *   - an employee with no nationality is never quietly counted as an expatriate
 *   - the ratio comes back as a RANGE while any nationality is missing, and collapses to one number
 *     the moment they are all filled in
 *   - people who left, or who count toward another country, are out of the headcount
 *   - drift is measured against the ratio captured WITH the band, and only a fall is flagged
 */
import { prisma } from "../src/db.js";
import { workforceFor, recordBand } from "../src/workforce.js";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const pct = (bp: number) => (bp / 100).toFixed(2) + "%";

  const co = await prisma.company.create({ data: { name: "ZZ Workforce Probe", cr: "0000", country: "SA" } });
  const add = (name: string, extra: any = {}) =>
    prisma.employee.create({ data: { companyId: co.id, name, workCountry: "SA", ...extra } });

  await add("ZZ National A", { nationality: "SA", employmentType: "full_time" });
  await add("ZZ National B", { nationality: "SA", employmentType: "full_time" });
  await add("ZZ Expat A", { nationality: "IN", employmentType: "full_time" });
  const unknown = await add("ZZ Unknown", { employmentType: "full_time" });

  let w = (await workforceFor(co.id))!;
  console.log(`4 staff, one nationality missing:`);
  console.log(`  ${w.nationals} national · ${w.expats} expat · ${w.unknown} unrecorded → ${pct(w.ratioMinBp)}–${pct(w.ratioMaxBp)}`);
  if (w.total !== 4) fail(`headcount ${w.total}, expected 4`);
  if (w.ratioMinBp !== 5000) fail(`low end ${pct(w.ratioMinBp)}, expected 50% (unknown counted as expat)`);
  if (w.ratioMaxBp !== 7500) fail(`high end ${pct(w.ratioMaxBp)}, expected 75% (unknown counted as national)`);
  if (w.certain) fail("reported as certain while a nationality is missing");

  // ── the range collapses once nothing is missing ──
  await prisma.employee.update({ where: { id: unknown.id }, data: { nationality: "PK" } });
  w = (await workforceFor(co.id))!;
  console.log(`\nafter filling that nationality in: ${pct(w.ratioMinBp)} (certain: ${w.certain})`);
  if (!w.certain || w.ratioMinBp !== w.ratioMaxBp) fail("the range did not collapse to a single figure");
  if (w.ratioMinBp !== 5000) fail(`ratio ${pct(w.ratioMinBp)}, expected 50%`);

  // ── who is off the books ──
  const gone = await add("ZZ Left Last Year", { nationality: "IN", exitStatus: "exited" });
  const abroad = await add("ZZ Works In UAE", { nationality: "IN", workCountry: "AE" });
  const archived = await add("ZZ Archived", { nationality: "IN", archived: true });
  w = (await workforceFor(co.id))!;
  console.log(`\nadded an exited, an archived and one counted toward the UAE:`);
  console.log(`  headcount still ${w.total} · counted elsewhere ${w.elsewhere}`);
  if (w.total !== 4) fail(`headcount ${w.total} — someone off the books is being counted`);
  if (w.elsewhere !== 1) fail(`elsewhere ${w.elsewhere}, expected 1`);

  // ── the band is recorded, and drift measured from it ──
  await recordBand(co.id, "Green", "2026-08-01", "Qiwa");
  w = (await workforceFor(co.id))!;
  console.log(`\nband recorded: ${w.band} on ${w.bandAt} (${w.bandNote}) · ratio captured ${pct(w.bandRatioBp!)}`);
  if (w.bandRatioBp !== 5000) fail("the ratio was not captured with the band");
  if (w.driftBp !== 0 || w.slipped) fail("drift should be zero immediately after recording");

  // A hire that dilutes the ratio must show up as a fall, in red.
  const hire = await add("ZZ New Expat", { nationality: "IN", employmentType: "full_time" });
  w = (await workforceFor(co.id))!;
  console.log(`  after one expat hire: ${pct(w.ratioMinBp)} · drift ${pct(w.driftBp!)} · slipped ${w.slipped}`);
  if (!w.slipped || w.driftBp! >= 0) fail("a diluting hire was not reported as a fall");

  // Improving is not a warning.
  await prisma.employee.update({ where: { id: hire.id }, data: { nationality: "SA" } });
  w = (await workforceFor(co.id))!;
  console.log(`  after that person turns out to be a national: ${pct(w.ratioMinBp)} · slipped ${w.slipped}`);
  if (w.slipped) fail("a RISING ratio was flagged as a problem");

  // ── clearing the band clears what it was measured against ──
  await recordBand(co.id, "", "");
  w = (await workforceFor(co.id))!;
  console.log(`\nband cleared: band=${w.band} · captured ratio=${w.bandRatioBp} · drift=${w.driftBp}`);
  if (w.band || w.bandRatioBp !== null || w.driftBp !== null) fail("clearing the band left a captured ratio behind");

  // ── clean up ──
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await prisma.company.delete({ where: { id: co.id } });
  const left = await prisma.company.count({ where: { name: { startsWith: "ZZ Workforce" } } })
    + await prisma.employee.count({ where: { name: { startsWith: "ZZ " } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
