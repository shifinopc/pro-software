/**
 * Throwaway check for the workforce trend: what gets recorded, and what must never be rewritten.
 *
 * The assertions that matter are about history STAYING history:
 *   - one row per client per day, however many times the tick runs
 *   - a hire later the same day updates TODAY's row, because the day is not over
 *   - …and never touches yesterday's
 *   - renaming a band afterwards does not rewrite the days already recorded
 *   - a client with nobody on the books is still recorded — "they had no staff" is history, and a
 *     gap would make the trend interpolate across it as though nothing had changed
 *   - leads and written-off companies are never snapshotted
 *   - one point is reported as "not enough", not drawn as a flat line
 *
 * Own country, own clients, own bands. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { captureWorkforceSnapshots, workforceHistory } from "../src/workforce.js";

const COUNTRY = "ZZ";
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.workforceSnapshot.deleteMany({ where: { companyId: { in: ids } } });
    for (const m of ["employee", "contact", "opportunity", "interaction"] as const)
      await (prisma as any)[m].deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.workforceBand.deleteMany({ where: { country: COUNTRY } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  // The capture covers EVERY client, so running it here writes rows for the real ones too — and one
  // of the runs below is backdated to yesterday, which would put a day of invented history on their
  // records. Remember exactly which snapshot rows existed before, and remove anything this probe
  // caused that is not its own.
  const preexisting = new Set((await prisma.workforceSnapshot.findMany({ select: { id: true } })).map(r => r.id));

  for (const b of [
    { name: "ZZ Red", minBp: 0, maxBp: 3000, sort: 1 },
    { name: "ZZ Green", minBp: 3000, maxBp: null, sort: 2 },
  ]) await prisma.workforceBand.create({ data: { ...b, country: COUNTRY } });

  const co = await prisma.company.create({ data: { name: "ZZ Trend Co", cr: "1", country: COUNTRY, lifecycle: "client" } });
  const empty = await prisma.company.create({ data: { name: "ZZ Empty Co", cr: "2", country: COUNTRY, lifecycle: "client" } });
  const lead = await prisma.company.create({ data: { name: "ZZ Trend Lead", country: COUNTRY, lifecycle: "lead" } });
  const lost = await prisma.company.create({ data: { name: "ZZ Trend Lost", country: COUNTRY, lifecycle: "lost", lostReason: "probe" } });

  const hire = (n: number, national: boolean) => Promise.all(Array.from({ length: n }, (_v, i) =>
    prisma.employee.create({ data: { companyId: co.id, name: `ZZ ${national ? "N" : "E"}${i}${Math.random()}`, workCountry: COUNTRY, nationality: national ? COUNTRY : "IN" } })));
  // Give the lead staff too, so "leads are skipped" is tested against something that would otherwise show.
  await prisma.employee.create({ data: { companyId: lead.id, name: "ZZ Lead Staff" + Math.random(), workCountry: COUNTRY, nationality: "IN" } });

  // ── yesterday: 1 of 4 = 25% → ZZ Red ──
  await hire(1, true); await hire(3, false);
  await captureWorkforceSnapshots(day(-1));
  const yday = await prisma.workforceSnapshot.findUnique({ where: { companyId_day: { companyId: co.id, day: day(-1) } } });
  console.log(`yesterday recorded: ${yday!.nationals}/${yday!.total} = ${yday!.ratioMinBp / 100}% · ${yday!.bandName}`);
  if (yday!.ratioMinBp !== 2500 || yday!.bandName !== "ZZ Red") fail("yesterday's row is wrong");

  // ── today, then again: one row, not two ──
  await captureWorkforceSnapshots(day(0));
  const r = await captureWorkforceSnapshots(day(0));
  const todays = await prisma.workforceSnapshot.count({ where: { companyId: co.id, day: day(0) } });
  console.log(`\nrunning the tick twice today: ${todays} row (written ${r.written})`);
  if (todays !== 1) fail(`${todays} rows for one client on one day — the tick is not idempotent`);

  // ── a hire this afternoon updates TODAY, not yesterday ──
  await hire(2, true); // 3 of 6 = 50% → ZZ Green
  await captureWorkforceSnapshots(day(0));
  const today = await prisma.workforceSnapshot.findUnique({ where: { companyId_day: { companyId: co.id, day: day(0) } } });
  const ydayAgain = await prisma.workforceSnapshot.findUnique({ where: { companyId_day: { companyId: co.id, day: day(-1) } } });
  console.log(`after hiring: today ${today!.ratioMinBp / 100}% ${today!.bandName} · yesterday still ${ydayAgain!.ratioMinBp / 100}% ${ydayAgain!.bandName}`);
  if (today!.ratioMinBp !== 5000 || today!.bandName !== "ZZ Green") fail("today's row did not follow the hire");
  if (ydayAgain!.ratioMinBp !== 2500 || ydayAgain!.bandName !== "ZZ Red") fail("a hire today rewrote yesterday's record");

  // ── renaming a band does not rewrite the past ──
  await prisma.workforceBand.updateMany({ where: { country: COUNTRY, name: "ZZ Red" }, data: { name: "ZZ Crimson" } });
  const afterRename = await prisma.workforceSnapshot.findUnique({ where: { companyId_day: { companyId: co.id, day: day(-1) } } });
  console.log(`\nafter renaming Red → Crimson, yesterday still says: ${afterRename!.bandName}`);
  if (afterRename!.bandName !== "ZZ Red") fail("renaming a band today rewrote a day that has already happened");

  // ── a client with nobody is still recorded ──
  const emptyRow = await prisma.workforceSnapshot.findUnique({ where: { companyId_day: { companyId: empty.id, day: day(0) } } });
  console.log(`a client with no staff: ${emptyRow ? `recorded, total ${emptyRow.total}, band ${emptyRow.bandName ?? "none"}` : "NOT RECORDED"}`);
  if (!emptyRow) fail("a client with no staff was skipped, leaving a gap the trend would interpolate across");
  if (emptyRow && emptyRow.bandName !== null) fail("a client with nobody on the books was given a band");

  // ── leads and written-off companies are not history worth keeping ──
  const leadRows = await prisma.workforceSnapshot.count({ where: { companyId: { in: [lead.id, lost.id] } } });
  console.log(`snapshots for the lead and the written-off company: ${leadRows} (must be 0)`);
  if (leadRows) fail("a lead or a lost company is being snapshotted");

  // ── the series ──
  const h = await workforceHistory(co.id, 90);
  console.log(`\nseries: ${h.points.map(p => `${p.day} ${p.ratioMinBp / 100}%`).join(" → ")}`);
  console.log(`  enough to draw: ${h.enough} · direction ${h.direction} · change ${h.changeBp! / 100} points · band ${h.bandFrom} → ${h.bandTo} (moved: ${h.bandMoved})`);
  if (!h.enough) fail("two points should be enough to show a direction");
  if (h.direction !== "up" || h.changeBp !== 2500) fail(`direction/change wrong: ${h.direction} ${h.changeBp}`);
  if (!h.bandMoved) fail("the band change across the window was not reported");

  // A client that only exists from today, so it genuinely has ONE point. The empty client above
  // does not qualify — it was created before the backdated capture and therefore has two.
  const fresh = await prisma.company.create({ data: { name: "ZZ Brand New Co", cr: "3", country: COUNTRY, lifecycle: "client" } });
  await captureWorkforceSnapshots(day(0));
  const single = await workforceHistory(fresh.id, 90);
  console.log(`\na client with ${single.points.length} point: enough ${single.enough} · direction ${single.direction}`);
  if (single.points.length !== 1) fail(`expected exactly one point, got ${single.points.length}`);
  if (single.enough) fail("one point was reported as enough to show a trend");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  // Anything this run wrote for somebody else's client, removed — including the backdated rows.
  const strays = (await prisma.workforceSnapshot.findMany({ select: { id: true } }))
    .filter(r => !preexisting.has(r.id))
    .map(r => r.id);
  const own = new Set((await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } })).map(c => c.id));
  const notOurs = (await prisma.workforceSnapshot.findMany({ where: { id: { in: strays } }, select: { id: true, companyId: true } }))
    .filter(r => !own.has(r.companyId)).map(r => r.id);
  if (notOurs.length) await prisma.workforceSnapshot.deleteMany({ where: { id: { in: notOurs } } });
  console.log(`\nsnapshots written for real clients, removed: ${notOurs.length}`);

  const ids = [co.id, empty.id, lead.id, lost.id, fresh.id];
  await prisma.workforceSnapshot.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.employee.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
  await prisma.workforceBand.deleteMany({ where: { country: COUNTRY } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: "ZZ " } }, { message: { contains: "ZZ " } }] } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.workforceBand.count({ where: { country: COUNTRY } })) +
    (await prisma.workforceSnapshot.count({ where: { country: COUNTRY } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
