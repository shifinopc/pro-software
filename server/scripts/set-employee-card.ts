/**
 * Set which document types the employee card shows, and the order they appear in.
 *
 * The card used to be `types.filter(employee).slice(0, 5)` over an unordered list route, so it
 * showed whichever five rows the database returned first, alphabetised. Neither the set nor the
 * order was a decision. This makes both one.
 *
 * Names are given IN THE ORDER THEY SHOULD APPEAR. Everything not named is taken off the card.
 *
 * REFUSES ON AN UNKNOWN NAME rather than skipping it. A typo that silently drops a document from
 * every employee's checklist is exactly the kind of quiet wrong answer this whole change is about —
 * and the near-miss is real: "Employment Contract" and "Qiwa Employment Contract" are two types
 * whose names contain one another.
 *
 *   npx tsx scripts/set-employee-card.ts "Health Insurance" "Work Permit" "Iqama"
 *   npx tsx scripts/set-employee-card.ts --apply "Health Insurance" "Work Permit" "Iqama"
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const wanted = process.argv.slice(2).filter(a => a !== "--apply");

const main = async () => {
  if (!wanted.length) throw new Error("Name the types, in the order they should appear on the card.");

  const all = await prisma.documentType.findMany({
    where: { subjectKind: "employee", retired: false },
    select: { id: true, name: true, onEmployeeCard: true, cardOrder: true },
  });
  const byName = new Map(all.map(t => [t.name, t]));

  const missing = wanted.filter(n => !byName.has(n));
  if (missing.length) {
    console.error(`no employee document type named: ${missing.map(m => `"${m}"`).join(", ")}`);
    console.error(`available: ${all.map(t => t.name).join(", ")}`);
    process.exit(1);
  }
  const dupes = wanted.filter((n, i) => wanted.indexOf(n) !== i);
  if (dupes.length) { console.error(`named twice: ${dupes.join(", ")}`); process.exit(1); }

  console.log("card will show, in order:");
  wanted.forEach((n, i) => {
    const t = byName.get(n)!;
    const was = t.onEmployeeCard ? `was #${t.cardOrder ?? "\u2014"}` : "was off the card";
    console.log(`  ${i + 1}. ${n}   (${was})`);
  });
  const off = all.filter(t => !wanted.includes(t.name));
  if (off.length) console.log(`off the card: ${off.map(t => t.name).join(", ")}`);

  if (!APPLY) return console.log("\nreport only. Re-run with --apply to write.");

  for (const [i, n] of wanted.entries()) {
    await prisma.documentType.update({ where: { id: byName.get(n)!.id }, data: { onEmployeeCard: true, cardOrder: i + 1 } });
  }
  if (off.length) {
    await prisma.documentType.updateMany({
      where: { id: { in: off.map(t => t.id) } },
      data: { onEmployeeCard: false, cardOrder: null },
    });
  }
  console.log(`\non: ${wanted.length}   off: ${off.length}`);
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
