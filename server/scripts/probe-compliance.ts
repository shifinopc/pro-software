/**
 * Prove the hourly compliance recompute still writes the right thing after it was changed to group
 * its updates.
 *
 * It used to issue one UPDATE per document, awaited in turn, with every row loaded in full. For a
 * firm with tens of thousands of documents that was one round trip each, every night, sequentially —
 * so it now selects the six columns it reads and groups rows that share a new (status, daysLeft)
 * into one statement. Grouping is the kind of change that works on the happy path and quietly stops
 * updating one of the three shapes, so all three are exercised here:
 *
 *   1. A DATED document gets the right daysLeft and status: overdue when past, expiring inside the
 *      type's lead days, valid beyond them.
 *   2. Documents sharing a new status and daysLeft are all updated, not just the first of them —
 *      which is exactly what a broken grouping would do.
 *   3. An UNDATED document becomes "unknown", and an unparseable date is cleared rather than kept.
 *   4. A PERMANENT type (neverExpires) is valid with no deadline, never "unknown".
 *   5. A renewal in flight ("in_progress") keeps its status — recomputing it would erase the fact
 *      that somebody is already working on it — but still gets a fresh daysLeft.
 *
 * Own country, own client, own document type. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { recomputeCompliance } from "../src/scheduler.js";
import { businessToday, addDays } from "../src/dates.js";

const COUNTRY = "ZZ";
const CLIENT = "ZS Compliance Probe";
const TYPE = "ZS Probe Permit";          // leadDays 30
const FOREVER = "ZS Probe Registration"; // neverExpires

let bad = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); bad++; };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.documentType.deleteMany({ where: { name: { in: [TYPE, FOREVER] } } });
  await prisma.activity.deleteMany({ where: { message: { contains: CLIENT } } });
}

async function main() {
  await sweep();
  try {
    const co = await prisma.company.create({ data: { name: CLIENT, country: COUNTRY, lifecycle: "client" } });
    await prisma.documentType.createMany({ data: [
      { name: TYPE, country: COUNTRY, leadDays: 30 },
      { name: FOREVER, country: COUNTRY, neverExpires: true },
    ] });

    const today = businessToday();
    // Every one of these is created with a daysLeft and status that are DELIBERATELY WRONG, so a
    // pass that fails to write leaves them wrong and this probe says so.
    const mk = (person: string, docType: string, expiryDate: string | null, status = "valid") =>
      prisma.document.create({ data: { companyId: co.id, person, docType, expiryDate, status, daysLeft: 9999 } });

    const overdue = await mk("ZS Overdue One", TYPE, addDays(today, -10));
    const overdue2 = await mk("ZS Overdue Two", TYPE, addDays(today, -10));   // same bucket as above
    const expiring = await mk("ZS Expiring", TYPE, addDays(today, 10));
    const valid = await mk("ZS Valid", TYPE, addDays(today, 200));
    const undated = await mk("ZS Undated", TYPE, null);
    const unparseable = await mk("ZS Nonsense", TYPE, "6786786");
    const permanent = await mk("ZS Forever", FOREVER, addDays(today, 5));
    const inFlight = await mk("ZS In Flight", TYPE, addDays(today, -10), "in_progress");

    const out = await recomputeCompliance();
    console.log(`recompute: scanned ${out.scanned}, changed ${out.changed}, undated ${out.undated}, skipped ${out.skippedInProgress}`);
    if (out.changed === 0) fail("the pass reported no changes at all — nothing was written");

    const read = async (id: string) =>
      (await prisma.document.findUnique({ where: { id }, select: { status: true, daysLeft: true, expiryDate: true } }))!;

    console.log("\ndated documents");
    // `daysLeft` counts to MIDNIGHT on the expiry date, so during the afternoon a date ten days out
    // is 9.x days away and rounds to 9. Asserting the exact number would either be wrong for most of
    // the day or be a copy of the formula, which proves nothing — so the status is asserted exactly
    // and the count within a day of the offset the document was created with.
    const near = (got: number, want: number) => got !== 9999 && Math.abs(got - want) <= 1;
    const dated = async (id: string, label: string, status: string, offset: number) => {
      const r = await read(id);
      if (r.status === status && near(r.daysLeft, offset)) ok(`${label} → ${r.status}, ${r.daysLeft}d`);
      else fail(`${label} → ${r.status}, ${r.daysLeft}d (expected ${status}, about ${offset})`);
      return r;
    };
    const a = await dated(overdue.id, "past its expiry", "overdue", -10);
    // THE GROUPING CASE. These two were created identically, so they share a new (status, daysLeft)
    // and are written by ONE statement. A broken grouping writes the first and leaves the rest, so
    // what matters is not the number but that the second row carries the same one.
    const b = await read(overdue2.id);
    if (b.daysLeft === 9999) fail("the bucket's second row was never written at all");
    else if (b.status === a.status && b.daysLeft === a.daysLeft) ok(`a second document in the same bucket got the same write (${b.status}, ${b.daysLeft}d)`);
    else fail(`the bucket's second row reads ${b.status}, ${b.daysLeft}d against the first's ${a.status}, ${a.daysLeft}d — the grouping dropped it`);

    await dated(expiring.id, "inside the lead days", "expiring", 10);
    await dated(valid.id, "well beyond the lead days", "valid", 200);

    console.log("\nno usable date");
    const e = await read(undated.id);
    if (e.status === "unknown" && e.daysLeft === 0) ok("a missing expiry reads as unknown, not valid");
    else fail(`a missing expiry → ${e.status}, ${e.daysLeft}d (expected unknown, 0)`);

    const f = await read(unparseable.id);
    if (f.status === "unknown" && f.expiryDate === null) ok("an unparseable date is cleared, so it cannot masquerade as one");
    else fail(`an unparseable date → ${f.status}, expiry ${JSON.stringify(f.expiryDate)} (expected unknown, null)`);

    console.log("\na type that never expires");
    const g = await read(permanent.id);
    if (g.status === "valid" && g.expiryDate === null && g.daysLeft === 0) ok("permanently valid, with no deadline to report");
    else fail(`a permanent type → ${g.status}, ${g.daysLeft}d, expiry ${JSON.stringify(g.expiryDate)} (expected valid, 0, null)`);

    console.log("\na renewal already in flight");
    const h = await read(inFlight.id);
    if (h.status === "in_progress") ok("keeps its in_progress status");
    else fail(`was stomped to ${h.status} — somebody's renewal just became invisible`);
    if (near(h.daysLeft, -10)) ok(`...but its countdown is still refreshed (${h.daysLeft}d)`);
    else fail(`its daysLeft was left at ${h.daysLeft} (expected about -10)`);

    console.log("\nand a second pass changes nothing");
    const again = await recomputeCompliance();
    const mine = again.transitions.filter(t => t.person.startsWith("ZS "));
    if (mine.length === 0) ok("idempotent — a repeat pass moves none of these documents");
    else fail(`a repeat pass moved ${mine.length} of them: ${mine.map(t => `${t.person} ${t.from}→${t.to}`).join("; ")}`);
  } finally {
    await sweep();
  }

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
