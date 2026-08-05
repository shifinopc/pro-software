/**
 * Throwaway check for workforce band alerting.
 *
 * The assertions that matter are about NOT crying wolf:
 *   - the same fall is announced ONCE, however many times the tick runs
 *   - an IMPROVEMENT is recorded but never alerted
 *   - a client sitting comfortably inside its band is silent
 *   - a client with no staff, or a country with no bands, raises nothing at all
 *   - "close to the edge" is not raised for the lowest band, where there is nothing to fall into
 *
 * Own country, own client, own bands. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { checkWorkforceBands } from "../src/jobs.js";

const COUNTRY = "ZZ";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  for (const b of [
    { name: "ZZ Red", minBp: 0, maxBp: 2500, sort: 1 },
    { name: "ZZ Yellow", minBp: 2500, maxBp: 5000, sort: 2 },
    { name: "ZZ Green", minBp: 5000, maxBp: 7500, sort: 3 },
    { name: "ZZ Platinum", minBp: 7500, maxBp: null, sort: 4 },
  ]) await prisma.workforceBand.create({ data: { ...b, country: COUNTRY } });

  const co = await prisma.company.create({ data: { name: "ZZ Alert Probe", cr: "0000", country: COUNTRY } });
  const add = (n: number, national: boolean) => Promise.all(Array.from({ length: n }, (_v, i) =>
    prisma.employee.create({ data: { companyId: co.id, name: `ZZ ${national ? "N" : "E"}${i}${Math.random()}`, workCountry: COUNTRY, nationality: national ? COUNTRY : "IN" } })));
  const notesFor = () => prisma.notification.findMany({ where: { dedupeKey: { contains: co.id } }, select: { title: true, dedupeKey: true } });

  // ── start comfortably inside Green: 3 of 5 = 60% ──
  await add(3, true); await add(2, false);
  let r = await checkWorkforceBands();
  console.log(`first run (60%, mid-band): checked ${r.checked} · dropped ${r.dropped} · nearEdge ${r.nearEdge}`);
  if (r.dropped || r.nearEdge) fail("a client sitting mid-band raised something on the very first look");
  const seen0 = (await prisma.company.findUnique({ where: { id: co.id } }))!.workforceBandSeen;
  console.log(`  band recorded as seen: ${seen0}`);
  if (seen0 !== "ZZ Green") fail(`seen band is ${seen0}, expected ZZ Green`);

  // ── hire two expats: 3 of 7 = 42.86% → falls to Yellow ──
  await add(2, false);
  r = await checkWorkforceBands();
  console.log(`\nafter two expat hires (42.86%): dropped ${r.dropped} — ${r.details.join(" · ")}`);
  if (r.dropped !== 1) fail("the fall out of Green was not detected");
  let notes = await notesFor();
  console.log(`  notifications raised: ${notes.length} — "${notes[0]?.title}"`);
  if (notes.length !== 1) fail(`expected exactly 1 notification, got ${notes.length}`);

  // ── the tick runs again, unchanged: nothing new ──
  r = await checkWorkforceBands();
  notes = await notesFor();
  console.log(`\nsecond tick, nothing changed: dropped ${r.dropped} · notifications still ${notes.length}`);
  if (r.dropped !== 0) fail("the same fall was reported twice");
  if (notes.length !== 1) fail("a duplicate notification was raised for the same fall");

  // ── recovery: back to Green. Recorded, never alerted. ──
  await prisma.employee.deleteMany({ where: { companyId: co.id, nationality: "IN" } });
  await add(2, false);   // 3 of 5 = 60% again
  r = await checkWorkforceBands();
  notes = await notesFor();
  console.log(`\nrecovered to 60%: improved ${r.improved} · dropped ${r.dropped} · notifications still ${notes.length}`);
  if (r.improved !== 1) fail("the improvement was not recorded");
  if (r.dropped) fail("an improvement was reported as a drop");
  if (notes.length !== 1) fail("an improvement raised a notification — it should be recorded, not announced");

  // ── close to the floor: 5 of 10 = exactly 50%, the Green floor ──
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(5, true); await add(5, false);
  r = await checkWorkforceBands();
  const edge = (await notesFor()).filter(n => n.dedupeKey!.includes("wf-edge"));
  console.log(`\nsitting exactly on the Green floor (50%): nearEdge ${r.nearEdge}`);
  console.log(`  "${edge[0]?.title}"`);
  if (r.nearEdge !== 1) fail("a client on the floor of its band was not flagged as close to the edge");

  // ── the lowest band has nothing below it, so no edge warning ──
  await prisma.employee.deleteMany({ where: { companyId: co.id } });
  await add(0, true); await add(4, false);   // 0% → ZZ Red, the lowest
  const before = (await notesFor()).length;
  r = await checkWorkforceBands();
  const after = (await notesFor()).length;
  console.log(`\nin the LOWEST band (0%): nearEdge ${r.nearEdge} · new notifications ${after - before - r.dropped}`);
  if (r.nearEdge !== 0) fail("an edge warning was raised for the lowest band — there is nothing below it");

  // ── a country with no bands raises nothing ──
  const co2 = await prisma.company.create({ data: { name: "ZZ No Bands Co", cr: "0001", country: "QQ" } });
  await prisma.employee.create({ data: { companyId: co2.id, name: "ZZ Solo" + Math.random(), workCountry: "QQ", nationality: "IN" } });
  const r2 = await checkWorkforceBands();
  const n2 = await prisma.notification.findMany({ where: { dedupeKey: { contains: co2.id } } });
  console.log(`\nclient in a country with no bands: notifications ${n2.length} (must be 0)`);
  if (n2.length) fail("a client in a country with no thresholds was alerted about");

  // ── clean up ──
  await prisma.notification.deleteMany({ where: { OR: [{ dedupeKey: { contains: co.id } }, { dedupeKey: { contains: co2.id } }] } });
  await prisma.employee.deleteMany({ where: { companyId: { in: [co.id, co2.id] } } });
  await prisma.company.deleteMany({ where: { id: { in: [co.id, co2.id] } } });
  await prisma.workforceBand.deleteMany({ where: { country: COUNTRY } });
  const left = await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })
    + await prisma.employee.count({ where: { name: { startsWith: "ZZ " } } })
    + await prisma.workforceBand.count({ where: { country: COUNTRY } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
