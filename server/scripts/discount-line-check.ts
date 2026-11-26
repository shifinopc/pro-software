/**
 * A DISCOUNT THAT COMES OFF THE RIGHT MONEY.
 *
 *   npx tsx scripts/discount-line-check.ts     (reads the charge-type catalogue; writes nothing)
 *
 * A discount on a quotation is a LINE with a negative amount, not a field on the document. The
 * alternative — one discount held on the header — has to be apportioned back over the lines before
 * anything can use it, and this system reads lines for three separate answers: what VAT is charged
 * on, what each payment stage bills, and what the invoice raised on acceptance says. Three chances
 * to apportion differently, in the two files that have already carried VAT bugs.
 *
 * As a line it needs no new arithmetic at all. That is the claim, and it is only true for as long
 * as the arithmetic keeps treating a negative line like any other, so it is asserted here:
 *
 *   · the discount reduces the TAXABLE base, so VAT is charged on the discounted fee — not on the
 *     list price, and not on the whole subtotal including untaxed government fees
 *   · a discount marked against professional fees leaves the government fee alone. Government fees
 *     are money collected and handed to the ministry; discounting one means absorbing it, which is
 *     a decision somebody makes deliberately by flipping the line's chip, never a side effect
 *   · each PAYMENT STAGE bills the discounted fee. "50% of professional fees" after a 200 discount
 *     is 400, not 500 — otherwise the stages add up to more than the quotation and the last one
 *     silently absorbs the difference
 *   · the stages still foot to the quotation exactly, which is the invariant the whole schedule
 *     rests on
 *
 * No fixtures and no writes, so it runs anywhere — the only database access is the charge-type
 * catalogue that figuresForLines reads to resolve treatments by name, and these lines carry their
 * own frozen `vat` so the answer does not depend on what is in it.
 */
import { planStages, figuresForLines, lineMinor, lineGrossMinor, lineDiscMinor } from "../src/stages.js";
import { prisma } from "../src/db.js";

let bad = 0;
const ok = (m: string) => console.log("  ok    " + m);
const eq = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} → ${got}`) : (bad++, console.log(`  FAIL  ${what} → got ${got}, expected ${want}`));

// 1,000 professional (taxed) + 500 government (untaxed), less 200 off the professional fee.
const LINES = [
  { name: "ZZ Professional", units: 1, price: 1000, kind: "prof", vat: "standard" },
  { name: "ZZ Government",   units: 1, price: 500,  kind: "gov",  vat: "outside"  },
  { name: "Discount",        units: 1, price: -200, kind: "prof", vat: "standard" },
];

async function main() {
  console.log("\nthe discount comes off the taxable base, not off everything");
  const f = await figuresForLines(LINES as any, 1500);
  eq(f.subtotalMinor, 130000, "subtotal (1000 − 200 + 500)");
  eq(f.taxedMinor, 80000, "taxed    (the professional fee, discounted)");
  eq(f.vatMinor, 12000, "VAT 15%  (on 800 — not on 1000, not on 1300)");
  eq(f.totalMinor, 142000, "total");

  console.log("\na discount against professional fees leaves the government fee alone");
  const onGov = await figuresForLines(
    LINES.map(l => (l.name === "Discount" ? { ...l, kind: "gov", vat: "outside" } : l)) as any, 1500);
  eq(onGov.taxedMinor, 100000, "the same discount moved to GOV stops reducing the taxable base");
  eq(onGov.vatMinor, 15000, "so VAT is charged on the full professional fee");
  eq(onGov.subtotalMinor, 130000, "and the subtotal is unchanged either way");

  console.log("\nevery payment stage bills the discounted fee");
  const stages = planStages(LINES as any, [
    { label: "On signing", pct: 50, basis: "prof" },
    { label: "On completion", pct: 50, basis: "prof" },
    { label: "Government fees on filing", pct: 100, basis: "gov" },
  ] as any, f.totalMinor);
  eq(stages[0].subtotalMinor, 40000, "stage 1 — 50% of the DISCOUNTED professional fee");
  eq(stages[1].subtotalMinor, 40000, "stage 2 — the remainder of it");
  eq(stages[2].subtotalMinor, 50000, "stage 3 — the government fee, undiscounted");
  eq(stages.reduce((a: number, s: any) => a + s.subtotalMinor, 0), f.subtotalMinor,
     "the stages foot to the quotation");

  // A discount bigger than the fee it comes off. The composer refuses to SAVE one that takes the
  // document below zero, but the arithmetic must still be sane for a document that predates that
  // guard or is written through the API.
  console.log("\na discount larger than the fee does not produce nonsense");
  const over = await figuresForLines(
    [LINES[0], { ...LINES[2], price: -1500 }] as any, 1500);
  eq(over.subtotalMinor, -50000, "subtotal goes negative rather than clamping silently");
  eq(over.vatMinor, -7500, "and VAT follows it, so the three figures still agree");
  eq(over.subtotalMinor + over.vatMinor, over.totalMinor, "total is still subtotal + VAT");
}

/**
 * THE SAME FOUR CLAIMS, FOR A DISCOUNT HELD ON THE LINE ITSELF.
 *
 * `disc` is how the console writes one now: an amount off the line, beside its price. It must behave
 * exactly as the negative line above did, because every figure is still a sum of lineMinor() — and
 * it must be CLAMPED to the line, because a discount larger than the fee it comes off would flip
 * the line negative and take every payment stage billed against that fee with it.
 */
const DISC = [
  { name: "ZZ Professional", units: 1, price: 1000, kind: "prof", vat: "standard", disc: 200 },
  { name: "ZZ Government",   units: 1, price: 500,  kind: "gov",  vat: "outside"  },
];

async function discOnTheLine() {
  console.log("\na discount held on the line comes off the same money");
  const d = await figuresForLines(DISC as any, 1500);
  eq(d.subtotalMinor, 130000, "subtotal (1000 − 200 + 500)");
  eq(d.taxedMinor, 80000, "taxed    (the professional fee, discounted)");
  eq(d.vatMinor, 12000, "VAT 15%  (on 800)");
  eq(d.totalMinor, 142000, "total");
  // The figures a negative line produced, to the halala — the two ways of writing a discount must
  // not price the same quotation differently.
  const asLine = await figuresForLines(LINES as any, 1500);
  eq(d.subtotalMinor === asLine.subtotalMinor && d.vatMinor === asLine.vatMinor, true,
     "identical to the same discount written as a negative line");

  console.log("\nit is clamped to the line it comes off");
  eq(lineDiscMinor({ price: 1000, units: 1, disc: 5000 } as any), 100000, "a discount larger than the fee");
  eq(lineMinor({ price: 1000, units: 1, disc: 5000 } as any), 0, "leaves the line at zero, never negative");
  eq(lineDiscMinor({ price: 1000, units: 1, disc: -50 } as any), 0, "a negative discount is ignored");
  eq(lineDiscMinor({ price: 1000, units: 1, disc: "abc" } as any), 0, "so is a non-number");
  eq(lineMinor({ price: -200, units: 1, disc: 50 } as any), -20000, "an older negative line is untouched by it");
  eq(lineMinor({ price: 100, units: 3, disc: 50 } as any), 25000, "the amount is off the LINE, not per unit");
  eq(lineGrossMinor({ price: 100, units: 3, disc: 50 } as any), 30000, "and the list price still reads as the list price");

  console.log("\nevery payment stage bills the discounted fee");
  const st = planStages(DISC as any, [
    { label: "On signing", pct: 50, basis: "prof" },
    { label: "On completion", pct: 50, basis: "prof" },
    { label: "Government fees on filing", pct: 100, basis: "gov" },
  ] as any, d.totalMinor);
  eq(st[0].subtotalMinor, 40000, "stage 1 — 50% of the DISCOUNTED professional fee");
  eq(st[1].subtotalMinor, 40000, "stage 2 — the remainder of it");
  eq(st[2].subtotalMinor, 50000, "stage 3 — the government fee, undiscounted");
  eq(st.reduce((a: number, x: any) => a + x.subtotalMinor, 0), d.subtotalMinor, "the stages foot to the quotation");
  // THE ONE THAT WOULD HAVE COST MONEY. The stage's lines carry the source line's fields so the VAT
  // travels; without clearing `disc` the stage invoice would deduct the discount a second time.
  eq(st[0].lines.every((l: any) => !Number(l.disc)), true, "and no stage line carries the discount a second time");
  const stageFigures = await figuresForLines(st[0].lines as any, 1500);
  eq(stageFigures.subtotalMinor, 40000, "so the stage invoice bills what the stage says");
}

main()
  .then(discOnTheLine)
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
