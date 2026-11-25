/**
 * AN ISSUED INVOICE CANNOT BE REWRITTEN THROUGH THE BACK DOOR.
 *
 *   npx tsx scripts/invoice-lock-check.ts     (needs the API running)
 *
 * Editing one was refused from the start. DELETING one was not: the guard in front of
 * /api/invoices only looked at PUT and PATCH, so a DELETE fell through to the generic CRUD route
 * and removed the row outright — leaving an unexplainable gap in the number series, payments
 * pointing at nothing, and no record that the document had ever existed. An issued invoice is
 * cancelled by voiding it, which keeps it on file with its reason.
 *
 * Asserted here, because a guard nobody exercises is a comment:
 *
 *   · a DRAFT is still freely editable and still deletable, which is the point of a draft
 *   · an issued invoice refuses a change to its number, total, VAT, lines, client or status
 *   · it refuses one field just as firmly as all of them — the usual edit is a single number
 *   · it refuses a change that LOOKS harmless (a note), because the rule is the document's status
 *     and not a list of fields somebody has to keep current
 *   · an issued invoice cannot be DELETED, and is still there afterwards
 *   · the refusal names the void route, so the answer arrives with the refusal
 *
 * Everything it makes is numbered "ZZL-" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This writes throwaway invoices and tries to rewrite them."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: number, want: number, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${got}, expected ${want}`);

const TAG = "ZZ Lock";
const EMAIL = "zz-lock@example.invalid";

async function sweep() {
  await prisma.payment.deleteMany({ where: { invoiceNumber: { startsWith: "ZZL-" } } });
  await prisma.invoice.deleteMany({ where: { number: { startsWith: "ZZL-" } } });
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
      number: `ZZL-${++n}`, companyId: co.id, clientName: co.name, status, currency: "SAR",
      amount: 288, subtotalMinor: 25000, vatMinor: 3750, totalMinor: 28750, vatRateBp: 1500,
      date: "2026-11-10", dueDate: "2026-11-24", items: [{ name: "ZZ line", units: 1, price: 250 }],
    },
  });

  console.log("\na draft is still a form");
  const draft = await make("draft");
  expect((await call("PUT", `/api/invoices/${draft.id}`, { amount: 500, totalMinor: 50000 })).status, 200, "draft · amount edited");

  console.log("\nan issued invoice is not");
  const issued = await make("pending");
  for (const [what, patch] of [
    ["the total", { amount: 999, totalMinor: 99900 }],
    ["the number", { number: "ZZL-REWRITTEN" }],
    ["the VAT", { vatMinor: 0, vatRateBp: 0 }],
    ["the lines", { items: [{ name: "something else", units: 1, price: 1 }] }],
    ["the client", { clientName: "Someone Else" }],
    ["the status", { status: "paid" }],
  ] as [string, any][]) {
    const r = await call("PUT", `/api/invoices/${issued.id}`, patch);
    expect(r.status, 409, `refuses ${what}`);
  }
  // The real edit is never a whole document — it is one number, which is exactly the shape that
  // slipped through unnoticed.
  expect((await call("PUT", `/api/invoices/${issued.id}`, { amount: 300 })).status, 409, "refuses a single field");

  const after = await prisma.invoice.findUnique({ where: { id: issued.id } });
  after?.amount === 288 && after?.number === issued.number && after?.vatRateBp === 1500
    ? ok("nothing was written")
    : fail(`the row changed → ${JSON.stringify({ amount: after?.amount, number: after?.number, vatRateBp: after?.vatRateBp })}`);

  // Deliberately refused too. A per-field allowlist would have to be kept current as the model
  // grows, and the first field somebody forgot to add would be editable on an issued document.
  expect((await call("PUT", `/api/invoices/${issued.id}`, { notes: "Chased by phone" })).status, 409, "refuses even a note");

  console.log("\ndeleting");
  const del = await call("DELETE", `/api/invoices/${issued.id}`);
  expect(del.status, 409, "issued invoice");
  (await prisma.invoice.findUnique({ where: { id: issued.id } })) ? ok("still on file") : fail("it was deleted anyway");
  // The refusal has to carry the way out, or it is a dead end somebody works around.
  String(del.body?.void ?? "").endsWith("/void") ? ok("names the void route") : fail(`no void route → ${JSON.stringify(del.body)}`);
  expect((await call("DELETE", `/api/invoices/${draft.id}`)).status, 204, "draft invoice");
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
