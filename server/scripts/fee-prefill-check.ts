/**
 * A GOVERNMENT FEE IS A RATE, SO THE SCREEN SHOULD WORK IT OUT.
 *
 *   npx tsx scripts/fee-prefill-check.ts
 *
 * The work permit fee is 9,700 a year, charged by the quarter: 2,425 / 4,850 / 7,275 / 9,700. Nobody
 * should be typing those from memory, and the records show what happens when they do — the same
 * 3-month Jawazat term was recorded as 160, 162 and 165 by different officers, and one work permit
 * came in at 165, which is the Jawazat figure typed into the permit's box.
 *
 * This runs the drawer's OWN arithmetic, lifted out of index.html rather than reimplemented here: a
 * copy of the formula would pass while the shipped one was broken, which is the whole failure mode a
 * check like this exists to catch.
 *
 * The two halves that matter, and both are needed:
 *   · picking a term fills the amount — otherwise the rate is decoration
 *   · a hand-corrected amount SURVIVES — the step records what was actually paid, not what was due
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

// ── Lift the real implementation out of the page ────────────────────────────────────────────────
const from = ui.indexOf("const _rateAmt9 = (annual, term)");
const to = ui.indexOf("const caps = (selStep.captures", from);
if (from < 0 || to < 0) { console.log("  FAIL could not find the fill helpers in index.html"); process.exit(1); }
const src = ui.slice(from, to);
const load = (selStep: any, cap: any) =>
  new Function("selStep", "cap", src + "\nreturn { _rateAmt9, _rateFill9 };")(selStep, cap) as
    { _rateAmt9: (a: any, t: any) => number | null; _rateFill9: (v: string, picked: string) => Record<string, any> };

const step = (extra: any = {}) => ({
  id: "permit",
  captures: [
    { var: "permitTerm", type: "select", options: "3_month,6_month,9_month,12_month" },
    { var: "permitAmount", type: "money", termVar: "permitTerm", annualFee: 9700, ...extra },
  ],
});
const amountFor = (picked: string, cap: any = {}) => load(step(), cap)._rateFill9("permitTerm", picked)?.permitAmount?.amount;
// The shape the OPEN work is in: every work-permit step open today snapshotted this fee as a plain
// number field, so a fill that only understood the money shape would change nothing for any of them.
const numStep = {
  id: "permit",
  captures: [
    { var: "permitTerm", type: "select", options: "3_month,6_month,9_month,12_month" },
    { var: "permitAmount", type: "number", termVar: "permitTerm", annualFee: 9700 },
  ],
};
const numAmount = (picked: string, cap: any = {}) => load(numStep, cap)._rateFill9("permitTerm", picked)?.permitAmount;

console.log("the quarterly rates come out of one yearly figure:");
for (const [term, want] of [["3_month", "2425"], ["6_month", "4850"], ["9_month", "7275"], ["12_month", "9700"]] as const) {
  const got = amountFor(term);
  ok(got === want, `${term} → ${want} (got ${got})`);
}

console.log("\na number field — the shape the 153 open steps carry — fills too:");
ok(numAmount("3_month") === "2425", `a plain number capture gets the bare string (got ${numAmount("3_month")})`);
ok(numAmount("6_month", { permitTerm: "3_month", permitAmount: "2425" }) === "4850", "and follows the term when untouched");
ok(numAmount("6_month", { permitTerm: "3_month", permitAmount: "2000" }) === undefined, "and is left alone when corrected by hand");

console.log("\nthe Jawazat fee rounds to the riyals the counter actually charges:");
const jaw = {
  id: "jawazat",
  captures: [
    { var: "jawazatTerm", type: "select", options: "3_month,6_month,9_month,12_month" },
    { var: "jawazatAmount", type: "money", termVar: "jawazatTerm", annualFee: 650 },
  ],
};
// 162.50 and 487.50 on paper. The firm pays 163 and 488, and the receipt is what gets recorded.
for (const [term, want] of [["3_month", "163"], ["6_month", "325"], ["9_month", "488"], ["12_month", "650"]] as const) {
  const got = load(jaw, {})._rateFill9("jawazatTerm", term)?.jawazatAmount?.amount;
  ok(got === want, `${term} of 650/yr → ${want} (got ${got})`);
}

console.log("\nwhat the person typed is theirs:");
const typed = { permitTerm: "3_month", permitAmount: { amount: "2000", paid: true, reference: "RCPT-9" } };
ok(amountFor("6_month", typed) === undefined, "a corrected amount is left alone when the term changes");
ok(load(step(), typed)._rateFill9("permitTerm", "6_month").permitAmount === undefined,
  "…and nothing else about that payment is touched either");
// The reason the one above can be recognised as hand-typed: it does not match the rate for the term
// it was entered under. An UNTOUCHED amount must therefore still follow the term.
const untouched = { permitTerm: "3_month", permitAmount: { amount: "2425", paid: true } };
ok(amountFor("6_month", untouched) === "4850", "an untouched 2,425 follows 3 → 6 months to 4,850");
ok(load(step(), untouched)._rateFill9("permitTerm", "6_month").permitAmount.paid === true,
  "and the rest of the payment it carries survives the refill");

console.log("\nnothing is invented where no rate was set:");
ok(Object.keys(load(step({ annualFee: undefined }), {})._rateFill9("permitTerm", "3_month")).length === 0,
  "a money field with no yearly rate is left empty");
ok(Object.keys(load(step({ termVar: undefined }), {})._rateFill9("permitTerm", "3_month")).length === 0,
  "so is one that names no term field");
ok(load(step(), {})._rateAmt9(9700, "later") === null, "a term that is not a number prices nothing");

console.log("\nthe screen is actually wired to it:");
ok(ui.includes("const fill9 = _rateFill9(c.var, o);") && ui.includes("[c.var]: o, ...fill9"),
  "picking an option fills the fee in the same write");
// The fill is computed once and then read twice - once for the answer, once to decide whether the
// amount box has to be re-mounted to show it. Computing it twice would be two different objects.
ok((ui.match(/_rateFill9\(c\.var, o\)/g) || []).length === 1, "...and is computed once, not once per reader");
ok(ui.includes("fd.cycleTerm"), "the step builder can name the term field");
ok(ui.includes("fd.setAnnualFee"), "…and carries the yearly rate");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
