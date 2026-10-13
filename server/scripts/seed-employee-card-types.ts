/**
 * Decide, once, which document types the employee card measures people against.
 *
 * The card was `types.filter(employee).slice(0, 5)` over a query with no ordering, so it showed the
 * first five rows the database happened to return. Nobody chose them. On the Saudi pack that put the
 * WORK VISA on every employee's card — a one-time entry document, consumed when the Iqama is issued,
 * so everybody who is actually working here is marked permanently incomplete for it — and left the
 * PASSPORT off the card altogether.
 *
 * This writes down what each install is showing TODAY, so turning the flag on changes nothing on the
 * screen, and the firm then picks properly from the Document Types screen. It deliberately does not
 * decide for them beyond that: --drop names a type to leave off, which is a decision, not a default.
 *
 * IDEMPOTENT. Once anything is ticked this makes no further guess — re-running will not undo a
 * choice somebody has since made on the screen.
 *
 *   npx tsx scripts/seed-employee-card-types.ts                      # report only
 *   npx tsx scripts/seed-employee-card-types.ts --apply
 *   npx tsx scripts/seed-employee-card-types.ts --apply --drop "Work Visa"
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const drop = new Set(
  process.argv.flatMap((a, i) => (a === "--drop" && process.argv[i + 1] ? [process.argv[i + 1]] : [])),
);

const main = async () => {
  const employee = await prisma.documentType.findMany({
    where: { subjectKind: "employee", retired: false },
    select: { id: true, name: true, onEmployeeCard: true },
  });
  const already = employee.filter(t => t.onEmployeeCard);
  if (already.length) {
    console.log(`already chosen (${already.length}): ${already.map(t => t.name).join(", ")}`);
    console.log("nothing to seed — the card is configured.");
    if (!drop.size) return;
  }

  // The same five the card is showing right now: first five, in the order the list route returns
  // them, which is the order this query returns them.
  const showing = already.length ? already.map(t => t.name) : employee.slice(0, 5).map(t => t.name);
  const keep = showing.filter(n => !drop.has(n));

  console.log(`employee types:  ${employee.length}`);
  console.log(`card shows today: ${showing.join(", ")}`);
  if (drop.size) console.log(`dropping:        ${[...drop].join(", ")}`);
  console.log(`card will show:  ${keep.join(", ")}`);
  const off = employee.filter(t => !keep.includes(t.name)).map(t => t.name);
  if (off.length) console.log(`not on the card: ${off.join(", ")}`);

  if (!APPLY) return console.log("\nreport only. Re-run with --apply to write.");

  const on = await prisma.documentType.updateMany({
    where: { subjectKind: "employee", retired: false, name: { in: keep } },
    data: { onEmployeeCard: true },
  });
  const offR = await prisma.documentType.updateMany({
    where: { subjectKind: "employee", name: { notIn: keep } },
    data: { onEmployeeCard: false },
  });
  console.log(`\non: ${on.count}   off: ${offR.count}`);
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
