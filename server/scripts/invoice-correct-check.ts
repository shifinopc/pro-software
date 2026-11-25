/**
 * CORRECTING AN ISSUED INVOICE: VOID IT AND RAISE ITS REPLACEMENT, IN ONE ACT.
 *
 *   npx tsx scripts/invoice-correct-check.ts     (needs the API running)
 *
 * An issued invoice cannot be edited — the client holds a copy and the figures are frozen on a tax
 * document. Both halves of the lawful correction already existed as separate routes, which meant
 * voiding the invoice and then retyping every line from the document you had just cancelled. That
 * is how people end up editing the database instead, so the two halves are now one request.
 *
 * What is asserted, and why each one is here:
 *
 *   · the replacement carries the original's client, lines and figures — a blank one makes somebody
 *     retype the four fields that were right to fix the one that was not
 *   · it arrives as a DRAFT with a NEW number: nothing is sent and nothing is owed until approved
 *   · both directions of the link are written, so neither document is a mystery on its own
 *   · the original is void, with the reason on it
 *   · a reason is REQUIRED — "void" with no explanation is the state this is meant to replace
 *   · a draft is refused (edit it), a void is refused (and names its replacement)
 *   · an invoice with a payment against it is refused and says a credit note is what it needs,
 *     rather than blaming the amount
 *   · re-charged ministry payments FOLLOW the replacement — left on the cancelled invoice they read
 *     as billed while nothing billable exists, and the client is never charged for them
 *
 * Everything it makes is numbered "ZZC-" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This voids throwaway invoices and raises replacements."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${got}, expected ${want}`);

const TAG = "ZZ Correct";
const EMAIL = "zz-correct@example.invalid";

async function sweep() {
  const made = await prisma.invoice.findMany({
    where: { OR: [{ number: { startsWith: "ZZC-" } }, { clientName: { startsWith: TAG } }] },
    select: { id: true },
  });
  const ids = made.map((i) => i.id);
  if (ids.length) {
    await prisma.disbursement.deleteMany({ where: { invoiceId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { invoiceId: { in: ids } } });
    await prisma.invoice.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.disbursement.deleteMany({ where: { label: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  await sweep();
  await prisma.user.create({ data: { name: TAG, email: EMAIL, roleId: "super_admin", status: "active", type: "staff" } });
  const token = await tokenForEmail(EMAIL);
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, country: "SA" } });

  const call = async (method: string, path: string, body?: any) => {
    const r = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  let n = 0;
  const make = (status: string) => prisma.invoice.create({
    data: {
      number: `ZZC-${++n}`, companyId: co.id, clientName: co.name, status, currency: "SAR",
      amount: 288, subtotalMinor: 25000, vatMinor: 3750, totalMinor: 28750, vatRateBp: 1500,
      date: "2026-11-10", dueDate: "2026-11-24", services: "ZZ service",
      items: [{ name: "ZZ line", units: 1, price: 250 }], notes: "ZZ note",
    },
  });

  console.log("\nthe correction itself");
  const issued = await make("pending");
  // A ministry payment this invoice re-charged, to prove it follows the replacement.
  const disb = await prisma.disbursement.create({
    data: {
      companyId: co.id, clientName: co.name, label: `${TAG} ministry fee`,
      amountMinor: 5000, recharge: true, invoiceId: issued.id, at: "2026-11-10",
    },
  });
  const r = await call("POST", `/api/invoices/${issued.id}/correct`, { reason: "Wrong client reference on the line" });
  if (r.status !== 201) { fail(`correct → ${r.status} ${JSON.stringify(r.body)}`); return; }
  const made = r.body.invoice;
  expect(made.status, "draft", "the replacement is a draft");
  made.number !== issued.number ? ok(`new number → ${made.number}`) : fail("it reused the old number");
  expect(made.clientName, issued.clientName, "client carried over");
  expect(made.totalMinor, issued.totalMinor, "total carried over");
  expect(made.vatRateBp, issued.vatRateBp, "VAT rate carried over");
  expect(JSON.stringify(made.items), JSON.stringify(issued.items), "lines carried over");
  expect(made.revisesId, issued.id, "the replacement points back");

  const old = await prisma.invoice.findUnique({ where: { id: issued.id } });
  expect(old?.status, "void", "the original is void");
  expect(old?.voidReason, "Wrong client reference on the line", "with the reason on it");
  expect(old?.supersededById, made.id, "and points forward");
  expect((await prisma.disbursement.findUnique({ where: { id: disb.id } }))?.invoiceId, made.id,
    "the re-charged payment followed it");

  console.log("\nwhat it refuses");
  const second = await call("POST", `/api/invoices/${issued.id}/correct`, { reason: "again" });
  expect(second.status, 409, "an already-void invoice");
  second.body?.replacedBy === made.number
    ? ok("and names its replacement")
    : fail(`no replacement named → ${JSON.stringify(second.body)}`);

  const draft = await make("draft");
  expect((await call("POST", `/api/invoices/${draft.id}/correct`, { reason: "x" })).status, 409, "a draft");

  const noReason = await make("pending");
  expect((await call("POST", `/api/invoices/${noReason.id}/correct`, {})).status, 400, "no reason given");
  expect((await prisma.invoice.findUnique({ where: { id: noReason.id } }))?.status, "pending", "and left it alone");

  const partPaid = await make("pending");
  await prisma.payment.create({
    data: {
      invoiceId: partPaid.id, invoiceNumber: partPaid.number, companyId: co.id,
      amount: 100, amountMinor: 10000, date: "2026-11-20",
    },
  });
  const paid = await call("POST", `/api/invoices/${partPaid.id}/correct`, { reason: "wrong amount" });
  expect(paid.status, 409, "an invoice with a payment against it");
  /credit note/i.test(String(paid.body?.error ?? ""))
    ? ok("and says a credit note is what it needs")
    : fail(`unhelpful refusal → ${paid.body?.error}`);
  expect((await prisma.invoice.findUnique({ where: { id: partPaid.id } }))?.status, "pending", "and left it alone");
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
