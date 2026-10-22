/**
 * Prove the invoice arithmetic, because every invoice in the product depends on it and nothing was
 * checking it.
 *
 * Five things are worth proving:
 *
 *   1. VAT ADDED ON TOP is exact. A fee of SAR 250 marked "plus VAT" is SAR 287.50, not 287 or 288.
 *   2. VAT TAKEN OUT round-trips. Splitting a gross total and adding the parts back gives the total
 *      it started from — the whole reason the figures are stored instead of re-derived at print time.
 *   3. A ZERO RATE is not a missing rate. 0% must stay 0%, never fall back to the 15% default.
 *   4. `amount` is a derived whole-riyal copy, and a payment must NOT be judged against it. This is
 *      the bug that made a SAR 287.50 invoice impossible to settle.
 *   5. PART PAYMENTS add up. Two halves close an invoice; one half does not.
 *
 * Pure functions, so this touches no rows and needs no cleanup. It does read the configured VAT rate
 * from the database for one assertion, and does not write it.
 */
import { prisma } from "../src/db.js";
import { figuresFromGross, figuresFromNet, currentVatRateBp, dueMinor, paidMinor } from "../src/money.js";

let bad = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); bad++; };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const eq = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} = ${got}`) : fail(`${what}: got ${got}, expected ${want}`);

async function main() {
  console.log("VAT added on top of a net fee");
  // The case the whole thing turns on: 250.00 + 15% = 287.50, which is 28750 halala and NOT a whole
  // number of riyals. Every figure below is in halala.
  const net = figuresFromNet(25_000, 1500);
  eq(net.subtotalMinor, 25_000, "subtotal");
  eq(net.vatMinor, 3_750, "VAT");
  eq(net.totalMinor, 28_750, "total");
  eq(net.amount, 288, "amount (the rounded whole-riyal copy)");
  if (net.subtotalMinor + net.vatMinor !== net.totalMinor) fail("the parts do not add up to the total");

  console.log("\nVAT taken out of a gross total");
  const gross = figuresFromGross(28_750, 1500);
  eq(gross.totalMinor, 28_750, "total is unchanged");
  if (gross.subtotalMinor + gross.vatMinor !== gross.totalMinor) fail("the parts do not add up to the total");
  // Round-trip: taking VAT out of a total we just put it into returns the same subtotal.
  eq(figuresFromGross(net.totalMinor, 1500).subtotalMinor, 25_000, "round-trip subtotal");

  console.log("\na zero rate is a decision, not a missing one");
  const zero = figuresFromNet(25_000, 0);
  eq(zero.vatMinor, 0, "VAT at 0%");
  eq(zero.totalMinor, 25_000, "total at 0%");
  eq(figuresFromGross(25_000, 0).subtotalMinor, 25_000, "nothing is divided out at 0%");

  console.log("\nrounding never invents or loses a halala");
  for (const [minor, rateBp] of [[1, 1500], [99, 1500], [33_333, 1500], [1, 500], [12_345, 2000]] as const) {
    const f = figuresFromGross(minor, rateBp);
    if (f.subtotalMinor + f.vatMinor !== f.totalMinor) fail(`gross split of ${minor} at ${rateBp}bp does not add up`);
    const n = figuresFromNet(minor, rateBp);
    if (n.subtotalMinor + n.vatMinor !== n.totalMinor) fail(`net split of ${minor} at ${rateBp}bp does not add up`);
  }
  ok("every split adds up exactly");

  console.log("\nsettlement is judged on the figure the invoice carries");
  const invoice = { totalMinor: net.totalMinor, amount: net.amount };   // 28750 halala, `amount` 288
  eq(dueMinor(invoice), 28_750, "amount due");
  // THE BUG THIS EXISTS FOR. Judged against `amount` (288), the 287.50 the client actually paid
  // never reaches it, so the invoice can never close and the dunning job chases it forever.
  if (287 >= invoice.amount) fail("the whole-riyal comparison unexpectedly closed the invoice");
  else ok("the old whole-riyal comparison would still refuse to settle this invoice");
  const exact = paidMinor([{ amountMinor: 28_750, amount: 288 }]);
  if (exact < dueMinor(invoice)) fail("an exact payment did not cover the invoice");
  else ok("an exact payment of 287.50 settles it");
  const short = paidMinor([{ amountMinor: 28_700, amount: 287 }]);
  if (short >= dueMinor(invoice)) fail("a short payment settled the invoice");
  else ok("fifty halala short does not settle it");

  console.log("\npart payments add up, and old rows still count");
  const halves = paidMinor([{ amountMinor: 14_375, amount: 144 }, { amountMinor: 14_375, amount: 144 }]);
  if (halves < dueMinor(invoice)) fail("two halves did not close the invoice");
  else ok("two part payments close it");
  if (paidMinor([{ amountMinor: 14_375, amount: 144 }]) >= dueMinor(invoice)) fail("one half closed the invoice");
  else ok("one part payment does not");
  // Rows banked before `amountMinor` existed carry only whole riyals, and must still be counted.
  eq(paidMinor([{ amountMinor: null, amount: 288 }]), 28_800, "a pre-existing payment row, in halala");
  eq(dueMinor({ totalMinor: null, amount: 288 }), 28_800, "a pre-existing invoice row, in halala");

  console.log("\nthe configured rate");
  const rate = await currentVatRateBp();
  // Basis points: 1500 = 15.00%. The only assertion worth making about a setting is that it is a
  // sane basis-point figure — the value itself is the firm's to choose.
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) fail(`configured VAT rate is not sane basis points: ${rate}`);
  else ok(`configured rate reads as ${rate}bp (${rate / 100}%)`);

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
