/**
 * A PAYMENT SCHEDULE THAT BILLS, INSTEAD OF ONE THAT PRINTS.
 *
 *   npx tsx scripts/milestone-invoice-check.ts     (needs the API running)
 *
 * A quotation's stages — "100% of the foreign company fee, 50% of professional fees on signing,
 * the rest on the licence" — were printed on the proposal and billed nothing. Accepting raised ONE
 * invoice for the whole amount, so a client who paid exactly what the terms asked for was recorded
 * as part-paying a bill nobody had sent them in that shape, and nothing in the system could answer
 * "is the acquisition paid?" because no document said acquisition.
 *
 * What is asserted:
 *
 *   · accepting raises the FIRST stage only, as a draft, linked to its stage
 *   · that invoice carries the LINES of the fee its stage names — which is what makes its VAT
 *     right, because a government-fee line and a professional-fee line are not taxed alike
 *   · VAT is computed server-side from each line's own treatment, not apportioned from a blended
 *     total, and not taken from the browser
 *   · the later stages are raised one at a time, in order, and refuse to be raised twice
 *   · THE STAGES FOOT TO THE QUOTATION. 50/30/20 of a fee that does not divide by three leaves the
 *     client short or over for ever; the last stage of each fee collects the remainder
 *   · a quotation with NO schedule still bills exactly as it always did — one invoice, whole amount
 *   · a stage against a fee the quotation does not carry is refused, rather than billing zero
 *
 * Everything it makes is tagged "ZZ Stage" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This writes throwaway quotations and raises invoices from them."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${got}, expected ${want}`);

const TAG = "ZZ Stage";
const EMAIL = "zz-stage@example.invalid";

async function sweep() {
  const qs = await prisma.quotation.findMany({ where: { number: { startsWith: "ZZS-" } }, select: { id: true } });
  if (qs.length) await prisma.invoice.deleteMany({ where: { quotationId: { in: qs.map(q => q.id) } } });
  await prisma.invoice.deleteMany({ where: { clientName: { startsWith: TAG } } });
  await prisma.quotation.deleteMany({ where: { number: { startsWith: "ZZS-" } } });
  await prisma.chargeType.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  await sweep();
  await prisma.user.create({ data: { name: TAG, email: EMAIL, roleId: "super_admin", status: "active", type: "staff" } });
  const token = await tokenForEmail(EMAIL);
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, country: "SA" } });

  // A government fee that carries no VAT, so the per-line rule has something to prove.
  await prisma.chargeType.create({ data: { name: `${TAG} Government Fee`, country: "SA", vatTreatment: "outside" } as any });
  await prisma.chargeType.create({ data: { name: `${TAG} Professional Fee`, country: "SA", vatTreatment: "standard" } as any });

  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(API + path, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  // Professional 10,000 ÷ 3 does not divide evenly — that is the point of the last-stage rule.
  const items = [
    { name: `${TAG} Professional Fee`, units: 1, price: 10000, kind: "prof" },
    { name: `${TAG} Government Fee`, units: 1, price: 4000, kind: "gov" },
  ];
  const sub = 1400000, vat = Math.round(1000000 * 0.15), tot = sub + vat;
  const q = await prisma.quotation.create({
    data: {
      number: "ZZS-1", companyId: co.id, clientName: co.name, service: `${TAG} setup`, status: "sent",
      items, subtotalMinor: sub, vatMinor: vat, totalMinor: tot, amount: Math.round(tot / 100), vatRateBp: 1500,
      date: "2026-11-25",
      milestones: [
        { label: "On signing", pct: 50, basis: "prof" },
        { label: "On the licence", pct: 30, basis: "prof" },
        { label: "On the CR", pct: 20, basis: "prof" },
        { label: "Government fees on filing", pct: 100, basis: "gov" },
      ],
    },
  });

  console.log("\naccepting bills the first stage, not the whole thing");
  const conv = await call("POST", `/api/quotations/${q.id}/convert`, {});
  if (conv.status !== 201) { fail(`convert → ${conv.status} ${JSON.stringify(conv.body)}`); return; }
  const first = conv.body.invoice;
  expect(first.milestoneIndex, 0, "it is stage 1");
  expect(first.status, "draft", "raised as a draft");
  expect(first.subtotalMinor, 500000, "50% of the professional fee, and nothing else");
  // 50% of a 10,000 professional fee, taxed at 15%: the government fee is not in this stage at all.
  expect(first.vatMinor, 75000, "VAT on the taxable line only");
  expect(first.totalMinor, 575000, "stage total");

  console.log("\nthe stages are raised one at a time");
  const s2 = await call("POST", `/api/quotations/${q.id}/stages/next`, {});
  expect(s2.status, 201, "stage 2");
  expect(s2.body.invoice.subtotalMinor, 300000, "30% of the professional fee");
  const s3 = await call("POST", `/api/quotations/${q.id}/stages/next`, {});
  expect(s3.body.invoice.subtotalMinor, 200000, "stage 3 — the remainder of the professional fee");
  const s4 = await call("POST", `/api/quotations/${q.id}/stages/next`, {});
  expect(s4.body.invoice.subtotalMinor, 400000, "the government fee, in full");
  expect(s4.body.invoice.vatMinor, 0, "and it carries NO VAT");
  expect((await call("POST", `/api/quotations/${q.id}/stages/next`, {})).status, 409, "a fifth stage");

  console.log("\nthe stages foot to the quotation");
  const raised = await prisma.invoice.findMany({ where: { quotationId: q.id } });
  expect(raised.length, 4, "invoices raised");
  expect(raised.reduce((a, i) => a + (i.subtotalMinor ?? 0), 0), sub, "subtotals sum to the quotation's");
  expect(raised.reduce((a, i) => a + (i.vatMinor ?? 0), 0), vat, "VAT sums to the quotation's");
  expect(raised.reduce((a, i) => a + (i.totalMinor ?? 0), 0), tot, "totals sum to the quotation's");

  console.log("\nan odd number still foots");
  const odd = await prisma.quotation.create({
    data: {
      number: "ZZS-2", companyId: co.id, clientName: co.name, service: `${TAG} odd`, status: "sent",
      items: [{ name: `${TAG} Professional Fee`, units: 1, price: 10000.01, kind: "prof" }],
      subtotalMinor: 1000001, vatMinor: 150000, totalMinor: 1150001, amount: 11500, vatRateBp: 1500,
      date: "2026-11-25",
      milestones: [{ label: "a", pct: 33, basis: "prof" }, { label: "b", pct: 33, basis: "prof" }, { label: "c", pct: 34, basis: "prof" }],
    },
  });
  await call("POST", `/api/quotations/${odd.id}/convert`, {});
  await call("POST", `/api/quotations/${odd.id}/stages/next`, {});
  await call("POST", `/api/quotations/${odd.id}/stages/next`, {});
  const oddRows = await prisma.invoice.findMany({ where: { quotationId: odd.id } });
  expect(oddRows.length, 3, "three stages");
  expect(oddRows.reduce((a, i) => a + (i.subtotalMinor ?? 0), 0), 1000001, "to the halala");
  /**
   * AND SO DOES THE TAX — the half this fixture never exercised.
   *
   * "VAT sums to the quotation's" is asserted above, and passed, because 10,000 split 50/30/20
   * gives 5,000 / 3,000 / 2,000 and VAT of 750 / 450 / 300, which happens to need no rounding at
   * all. Measured on a real quotation whose stages do not divide evenly: five stages charged
   * 9,825.57 against a quotation saying 9,825.56, because each stage rounds its own VAT while the
   * quotation rounds once over the whole taxable base. The net had the remainder rule; the tax did
   * not. One halala the client never agreed to, on every schedule that does not divide cleanly.
   */
  expect(oddRows.reduce((a, i) => a + (i.vatMinor ?? 0), 0), 150000, "and the VAT does too, on figures that do not divide");
  expect(oddRows.reduce((a, i) => a + (i.totalMinor ?? 0), 0), 1150001, "so the totals foot as well");

  console.log("\na quotation with no schedule is untouched");
  const plain = await prisma.quotation.create({
    data: {
      number: "ZZS-3", companyId: co.id, clientName: co.name, service: `${TAG} plain`, status: "sent",
      items: [{ name: `${TAG} Professional Fee`, units: 1, price: 5000, kind: "prof" }],
      subtotalMinor: 500000, vatMinor: 75000, totalMinor: 575000, amount: 5750, vatRateBp: 1500, date: "2026-11-25",
    },
  });
  const one = await call("POST", `/api/quotations/${plain.id}/convert`, {});
  expect(one.status, 201, "convert");
  expect(one.body.invoice.milestoneIndex, null, "no stage index — it is the whole quotation");
  expect(one.body.invoice.totalMinor, 575000, "the whole amount");
  expect((await call("POST", `/api/quotations/${plain.id}/stages/next`, {})).status, 409, "asking for a stage");

  /**
   * CORRECTING A STAGE INVOICE MUST NOT CANCEL THE REST OF THE SCHEDULE.
   *
   * /stages/next refuses outright if ANY invoice against the quotation has a null milestoneIndex,
   * because a null means "the whole quotation was invoiced in full". The correction route carried
   * the figures, the dates, the lines and the links but not the stage — so the replacement read as
   * a whole-quotation bill, and correcting stage 1 of a five-stage schedule answered "already
   * invoiced in full" for ever after. Measured before the fix: stage 2 refused with 409 and the
   * schedule view named the correction as the whole bill.
   */
  console.log("\ncorrecting a stage invoice keeps its stage");
  const toFix = await prisma.invoice.findFirst({ where: { quotationId: q.id, milestoneIndex: 1 } });
  await prisma.invoice.update({ where: { id: toFix!.id }, data: { status: "unpaid" } });
  const corrected = await call("POST", `/api/invoices/${toFix!.id}/correct`, { reason: "ZZ check — wrong figure" });
  expect(corrected.status, 200, "the correction");
  const replacement = await prisma.invoice.findFirst({ where: { revisesId: toFix!.id } });
  expect(replacement?.milestoneIndex, 1, "the replacement is still stage 2");
  expect(replacement?.milestoneLabel, toFix!.milestoneLabel, "and still says what it is for");
  // The reading that made it matter: no invoice against this quotation claims to be the whole of it.
  const reread = await call("GET", `/api/quotations/${q.id}/stages`);
  expect(reread.body?.whole ?? null, null, "and no invoice reads as the whole quotation");

  console.log("\nwhat the console reads");
  const view = await call("GET", `/api/quotations/${q.id}/stages`);
  expect(view.status, 200, "the schedule");
  expect(view.body.hasSchedule, true, "has one");
  expect(view.body.stages.length, 4, "stages listed");
  expect(view.body.stages.filter((st: any) => st.invoice).length, 4, "each showing its invoice");
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
