/**
 * A PAYMENT SCHEDULE HAS TO FOOT UP TO THE MONEY IT SCHEDULES.
 *
 *   npx tsx scripts/payment-terms-check.ts
 *
 * The bug this feature exists to stop: "50% of Professional Fees" computed off the grand total.
 * On a quotation of SAR 24,000 fees + SAR 6,500 government fees that bills SAR 15,250 instead of
 * SAR 12,000 — a 27% overcharge on the first invoice, in a document whose own terms say what it
 * should have been. Percentages of two different subtotals, so the base is the whole feature.
 *
 * Checks the renderer, not the dialog: the dialog's figures are a preview, the .docx is what the
 * client signs, and the two are computed in different languages from the same stored row.
 *
 * Runs against this database and deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { proposalData } from "../src/proposal.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("payment-terms-check");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ payterms";
const num = (s: string) => Number(String(s).replace(/[^0-9.]/g, ""));

async function sweep() {
  await prisma.quotation.deleteMany({ where: { number: { startsWith: "ZZQT-" } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
}

/** One quotation, its values rendered as the proposal would print them. */
async function render(items: any[], milestones: any[] | null, companyId: string, templateTokens?: string[], templateStages?: any[]) {
  const lines = items.reduce((a, it) => a + Math.round(Number(it.price) * 100) * (Number(it.units ?? 1)), 0);
  const q = await prisma.quotation.create({
    data: {
      number: "ZZQT-" + Math.random().toString(36).slice(2, 9), companyId,
      clientName: `${TAG} Co`, service: "test", amount: Math.round(lines / 100),
      subtotalMinor: lines, vatMinor: Math.round(lines * 0.15), totalMinor: Math.round(lines * 1.15),
      vatRateBp: 1500, items: items as any, milestones: milestones as any, status: "draft",
      date: new Date().toISOString().slice(0, 10),
    },
  });
  const v: any = await proposalData(q.id, undefined, templateTokens, templateStages);
  return { q, v };
}

await sweep();
try {
  const co = await prisma.company.create({ data: { name: `${TAG} Co` } as any });

  // The firm's own terms, on the quotation that prompted them.
  console.log("the real case — SAR 24,000 fees + SAR 6,500 government fees, billed 50/30/20 + 100%:");
  {
    const { v } = await render(
      [{ name: "Professional fees", price: 24000, units: 1, kind: "prof" },
       { name: "Government fees", price: 6500, units: 1, kind: "gov" }],
      [{ label: "Upon signing", pct: 50, basis: "prof" },
       { label: "Upon MISA approval", pct: 30, basis: "prof" },
       { label: "Upon MISA approval", pct: 100, basis: "gov" },
       { label: "Upon completion", pct: 20, basis: "prof" }],
      co.id);
    const amts = v.milestones.map((m: any) => num(m["milestone.amount"]));
    ok(amts[0] === 12000, `50% of the fees is 12,000, not half the total (got ${amts[0]})`);
    ok(amts[1] === 7200, `30% of the fees is 7,200 (got ${amts[1]})`);
    ok(amts[2] === 6500, `100% of the government fees is 6,500 (got ${amts[2]})`);
    ok(amts[3] === 4800, `20% of the fees is 4,800 (got ${amts[3]})`);
    // The whole point: the stages must add up to the money, with nothing left over and nothing invented.
    ok(amts.reduce((a: number, b: number) => a + b, 0) === 30500,
      `the four stages add up to the quotation's net total, 30,500 (got ${amts.reduce((a: number, b: number) => a + b, 0)})`);
    ok(num(v["fees.professional"]) === 24000 && num(v["fees.government"]) === 6500,
      "and the two subtotals are published for the template to show");
    ok(v.milestones[0]["milestone.of"] === "Professional Fees" && v.milestones[2]["milestone.of"] === "Government Fees",
      "each stage says in words which fees it is a percentage of");
  }

  /**
   * THE ACQUISITION DEAL, which is most of what the firm actually quotes.
   *
   * QT-005: professional fees 15,000 + "Company Acquire Oman" 16,000 + government fees 6,000. The
   * firm's terms bill the foreign company 100% up front and the Saudi fees at 50/30/20, because
   * the acquisition money leaves for a foreign agent before any Saudi work starts.
   */
  console.log("\nan acquisition deal bills the foreign company on its own schedule:");
  {
    const { v } = await render(
      [{ name: "Professional fees", price: 15000, units: 1, kind: "prof" },
       { name: "Company Acquire Oman", price: 16000, units: 1, kind: "foreign" },
       { name: "Government fees", price: 6000, units: 1, kind: "gov" }],
      [{ label: "On signing", pct: 100, basis: "foreign" },
       { label: "On signing", pct: 50, basis: "prof" },
       { label: "On MISA approval", pct: 30, basis: "prof" },
       { label: "On MISA approval", pct: 100, basis: "gov" },
       { label: "On completion", pct: 20, basis: "prof" }],
      co.id);
    const a = v.milestones.map((m: any) => num(m["milestone.amount"]));
    ok(a[0] === 16000, `the foreign company is billed in full up front, 16,000 (got ${a[0]})`);
    ok(a[1] === 7500, `and the Saudi fees are still halved on their own, 7,500 (got ${a[1]})`);
    // The mis-bill this kind exists to prevent: 50% of fees+acquisition is 15,500, which is BOTH
    // less than the 23,500 due on signing and short of the 16,000 the foreign agent must be paid.
    ok(a[0] + a[1] === 23500, `so signing collects 23,500, not 15,500 (got ${a[0] + a[1]})`);
    ok(a[2] === 4500 && a[3] === 6000 && a[4] === 3000, "the later stages are unaffected by it");
    ok(a.reduce((x: number, y: number) => x + y, 0) === 37000,
      "and the five stages still add up to the whole quotation, 37,000");
    ok(v.milestones[0]["milestone.of"] === "Foreign Company Fees", "the proposal names it in words");
    ok(num(v["fees.foreign"]) === 16000, "and the subtotal is published for the template");
  }
  {
    // The same quotation with the acquisition line left unmarked - what the app did an hour ago.
    const { v } = await render(
      [{ name: "Professional fees", price: 15000, units: 1, kind: "prof" },
       { name: "Company Acquire Oman", price: 16000, units: 1 },
       { name: "Government fees", price: 6000, units: 1, kind: "gov" }],
      [{ label: "On signing", pct: 50, basis: "prof" }], co.id);
    ok(num(v.milestones[0]["milestone.amount"]) === 15500,
      "an UNMARKED acquisition line is still billed as a fee — marking it is what changes the money");
  }

  // THE REGRESSION. Billing off the grand total is the behaviour this replaced.
  console.log("\nand the mistake it replaced stays replaced:");
  {
    const { v } = await render(
      [{ name: "Professional fees", price: 24000, units: 1, kind: "prof" },
       { name: "Government fees", price: 6500, units: 1, kind: "gov" }],
      [{ label: "Upon signing", pct: 50, basis: "prof" }],
      co.id);
    const got = num(v.milestones[0]["milestone.amount"]);
    ok(got !== 15250, `50% of the fees is NOT 50% of the total (15,250) — got ${got}`);
  }

  console.log("\nquotations that know nothing about any of this still print terms:");
  {
    // No milestones at all: every quotation in the database before this existed.
    const { v } = await render([{ name: "Service", price: 1000, units: 1 }], null, co.id);
    ok(v.milestones.length === 1 && num(v.milestones[0]["milestone.amount"]) === 1000,
      "no schedule means the whole amount, on signing");
    ok(v.milestones[0]["milestone.pct"] === "100", "...stated as 100%");
  }
  {
    // Lines with no `kind`: written before the chip existed. They are fees, so a fees-based
    // schedule must still bill them rather than quietly billing zero.
    const { v } = await render(
      [{ name: "Old line", price: 5000, units: 1 }],
      [{ label: "On signing", pct: 50, basis: "prof" }], co.id);
    ok(num(v.milestones[0]["milestone.amount"]) === 2500,
      `an unmarked line counts as a professional fee (got ${num(v.milestones[0]["milestone.amount"])})`);
  }
  {
    // A stage billing a base the quotation has none of. Zero is the true answer and must be
    // printed as zero — NOT silently promoted to the total, which would bill money nobody quoted.
    const { v } = await render(
      [{ name: "Professional fees", price: 9000, units: 1, kind: "prof" }],
      [{ label: "Gov on approval", pct: 100, basis: "gov" }], co.id);
    ok(num(v.milestones[0]["milestone.amount"]) === 0,
      "100% of government fees on a quotation with none is zero, not the total");
  }
  {
    /**
     * QUANTITIES, AND THE HALALA THIS DOES NOT CHASE.
     *
     * 3 x 333.33 = 999.99, and each half of it rounds to 500.00, so the two stages come to 1,000.00
     * — one halala more than the quotation. Each stage is rounded on its own, deliberately: making
     * the last one absorb the remainder is only correct when the stages are exhaustive, and a
     * schedule billing 80% of the fees is a legitimate thing to send.
     *
     * shortcut: a stage can be up to half a halala out, so a schedule can differ from its
     * quotation by a halala per stage. Harmless here because these are proposal TERMS — the
     * invoice raised at each stage is a separate document for the real amount. Upgrade to
     * largest-remainder allocation if stages are ever used to raise invoices directly.
     */
    const { v } = await render(
      [{ name: "Fee", price: 333.33, units: 3, kind: "prof" }],
      [{ label: "a", pct: 50, basis: "prof" }, { label: "b", pct: 50, basis: "prof" }], co.id);
    const sum = v.milestones.reduce((a: number, m: any) => a + num(m["milestone.amount"]), 0);
    ok(sum === 1000, `each stage is rounded on its own, so 999.99 split in two bills 1,000.00 (got ${sum})`);
    ok(Math.abs(sum - 999.99) <= 0.01, "which is within a halala of the quotation, and no further");
  }
  {
    // A flat sum agreed for one stage, not a percentage.
    const { v } = await render(
      [{ name: "Fee", price: 10000, units: 1, kind: "prof" }],
      [{ label: "Fixed", pct: 0, basis: "prof", amountMinor: 250000 }], co.id);
    ok(num(v.milestones[0]["milestone.amount"]) === 2500, "a stage agreed as a flat amount keeps it");
  }

  /**
   * WHICH FEE A STAGE BILLS, ON THE PAGE.
   *
   * Every template in use prints a stage as amount + label, so two stages at the same milestone
   * against different fees read as the same sentence twice with different money on a document
   * somebody signs. The base is folded into the label unless the template places it itself.
   */
  {
    const lines = [
      { name: "Fee", price: 10000, units: 1, kind: "prof" },
      { name: "Gov", price: 4000, units: 1, kind: "gov" },
    ];
    const same = [
      { label: "Upon approval of the MISA Licence", pct: 30, basis: "prof" },
      { label: "Upon approval of the MISA Licence", pct: 100, basis: "gov" },
    ];

    const { v } = await render(lines, same, co.id);
    const [a, b] = v.milestones.map((m: any) => m["milestone.label"]);
    ok(a !== b, `two stages at one milestone against different fees read differently (${a} / ${b})`);
    ok(a.includes("Professional Fees"), "the professional stage names its fee");
    ok(b.includes("Government Fees"), "the government stage names its fee");
    ok(num(v.milestones[0]["milestone.amount"]) === 3000 && num(v.milestones[1]["milestone.amount"]) === 4000,
      "and the amounts still come off their own base, not the total");

    // A template that asks for {{milestone.of}} places it itself, so folding would print it twice.
    const { v: v2 } = await render(lines, same, co.id, ["milestone.label", "milestone.of"]);
    ok(v2.milestones[0]["milestone.label"] === "Upon approval of the MISA Licence",
      "a template that asks for milestone.of gets the label untouched");
    ok(v2.milestones[0]["milestone.of"] === "Professional Fees", "and the fee in its own token");

    // The whole quotation has no base to name — which is every proposal written before schedules.
    const { v: v3 } = await render(lines, [{ label: "upon signing", pct: 100, basis: "total" }], co.id);
    ok(v3.milestones[0]["milestone.label"] === "upon signing",
      "a stage against the whole quotation keeps the label it was given");
    const { v: v4 } = await render(lines, null, co.id);
    ok(v4.milestones[0]["milestone.label"] === "upon signing",
      "and so does the no-schedule fallback, so old proposals render unchanged");
  }

  /**
   * TERMS CONFIGURED ON THE TEMPLATE, because they belong to the kind of work being sold.
   */
  console.log("\nthe schedule a template sells on:");
  {
    const setRows = [
      { label: "Upon signing", pct: 50, basis: "prof" },
      { label: "On licence approval", pct: 30, basis: "prof" },
      { label: "On licence approval", pct: 100, basis: "gov" },
      { label: "On completion", pct: 20, basis: "prof" },
    ];
    const profAndGov = [
      { name: "Fee", price: 10000, units: 1, kind: "prof" },
      { name: "Gov", price: 4000, units: 1, kind: "gov" },
    ];
    const profOnly = [{ name: "Fee", price: 28000, units: 1, kind: "prof" }];

    // A quotation with no stages of its own takes the template's.
    const { v } = await render(profAndGov, null, co.id, [], setRows);
    ok(v.milestones.length === 4, `the template's four stages are printed (got ${v.milestones.length})`);
    const sum = v.milestones.reduce((a: number, m: any) => a + num(m["milestone.amount"]), 0);
    ok(sum === 14000, `and they foot up to the quotation's net total, 14,000 (got ${sum})`);

    // A quotation that names its own keeps them: a default must not replace a negotiated term.
    const { v: own } = await render(profAndGov, [{ label: "All of it", pct: 100, basis: "total" }], co.id, [], setRows);
    ok(own.milestones.length === 1 && own.milestones[0]["milestone.label"] === "All of it",
      "a quotation's own schedule overrides the template's");

    // The template meets a deal with no government fees: that stage is dropped, not printed as 0.
    const { v: noGov } = await render(profOnly, null, co.id, [], setRows);
    ok(noGov.milestones.length === 3, `a template stage billing a fee the deal lacks is dropped (got ${noGov.milestones.length})`);
    ok(!noGov.milestones.some((m: any) => num(m["milestone.amount"]) === 0), "so no SAR 0.00 line reaches the client");
    const sum2 = noGov.milestones.reduce((a: number, m: any) => a + num(m["milestone.amount"]), 0);
    ok(sum2 === 28000, `and the rest still foot up to the whole 28,000 (got ${sum2})`);

    // But a zero the quotation itself names is somebody's own arithmetic — show it.
    const { v: ownZero } = await render(profOnly, [{ label: "Gov", pct: 100, basis: "gov" }], co.id);
    ok(ownZero.milestones.length === 1 && num(ownZero.milestones[0]["milestone.amount"]) === 0,
      "a zero stage the quotation names is kept, so the mistake stays visible");

    // Every template stage comes to nothing: still say what the client owes.
    const { v: allZero } = await render(profOnly, null, co.id, [], [{ label: "Gov", pct: 100, basis: "gov" }]);
    ok(allZero.milestones.length === 1 && num(allZero.milestones[0]["milestone.amount"]) === 28000,
      "a template whose every stage came to nothing falls back to the full amount, never a blank section");
  }
} finally {
  await sweep();
}

await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
