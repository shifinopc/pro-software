/**
 * A PAYMENT CAN CARRY THE SLIP THAT PROVES IT.
 *
 *   npx tsx scripts/payment-receipt-check.ts     (needs the API running)
 *
 * Recording a payment used to keep only a typed reference — "ref 884201" and nothing to look at.
 * The officer had the bank slip in front of them and no place to put it, so the proof lived in
 * somebody's mail folder and an argument about whether a transfer arrived could not be settled
 * from the record.
 *
 * Three things are asserted, because the middle one is the only reason the column can be trusted:
 *
 *   · an uploaded file given to /api/payments/record is stored on the payment, and comes back out
 *     of the list the console reads
 *   · an attachment that is NOT one of our own uploads is refused — the field takes a file id,
 *     never an arbitrary URL, or a receipt could be made to point anywhere
 *   · a payment recorded without one stores NULL, not an empty string: the console shows the
 *     "View" row on truthiness
 *
 * Everything it makes is numbered "ZZR-" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This writes throwaway invoices, payments and an uploaded file."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);

const TAG = "ZZ Receipt";
const EMAIL = "zz-receipt@example.invalid";

async function sweep() {
  await prisma.payment.deleteMany({ where: { invoiceNumber: { startsWith: "ZZR-" } } });
  await prisma.invoice.deleteMany({ where: { number: { startsWith: "ZZR-" } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.fileAsset.deleteMany({ where: { name: "zz-receipt-slip.pdf" } });
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
  const draft = () => prisma.invoice.create({
    data: {
      number: `ZZR-${++n}`, companyId: co.id, clientName: co.name, status: "approved", currency: "SAR",
      amount: 288, subtotalMinor: 25000, totalMinor: 28750, vatMinor: 3750, vatRateBp: 1500,
      date: "2026-11-10", dueDate: "2026-11-24",
    },
  });

  // The smallest thing the upload route will accept as a PDF: it sniffs the bytes, not the name.
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

  console.log("\nthe slip is uploaded, then filed with the payment");
  const up = await call("POST", "/api/upload", { kind: "document", name: "zz-receipt-slip.pdf", data: pdf });
  if (up.status !== 201 || !up.body?.path) { fail(`upload → ${up.status} ${JSON.stringify(up.body)}`); return; }
  ok(`uploaded → ${up.body.path}`);

  const inv1 = await draft();
  const rec = await call("POST", "/api/payments/record", {
    invoiceId: inv1.id, amount: 287.5, method: "Bank transfer", reference: "ZZ-884201",
    attachment: up.body.path, attachmentName: "zz-receipt-slip.pdf",
  });
  if (rec.status !== 201) fail(`record with slip → ${rec.status} ${JSON.stringify(rec.body)}`);
  else {
    const p = await prisma.payment.findUnique({ where: { id: rec.body.payment.id } });
    p?.attachment === up.body.path ? ok("stored on the payment") : fail(`stored → ${p?.attachment}`);
    p?.attachmentName === "zz-receipt-slip.pdf" ? ok("name kept beside it") : fail(`name → ${p?.attachmentName}`);
    // The console reads the list, not the create response — if it is not in here, nothing shows it.
    const list = await call("GET", "/api/payments");
    const row = (Array.isArray(list.body) ? list.body : []).find((x: any) => x.id === rec.body.payment.id);
    row?.attachment === up.body.path ? ok("comes back out of GET /api/payments") : fail(`list row → ${JSON.stringify(row?.attachment)}`);
  }

  console.log("\nan attachment that is not one of our uploads is refused");
  const inv2 = await draft();
  const evil = await call("POST", "/api/payments/record", {
    invoiceId: inv2.id, amount: 287.5, attachment: "https://example.invalid/slip.pdf",
  });
  evil.status === 400 ? ok(`refused → ${evil.body?.error}`) : fail(`external URL accepted → ${evil.status}`);
  (await prisma.payment.count({ where: { invoiceId: inv2.id } })) === 0 ? ok("nothing recorded") : fail("a payment was written anyway");

  console.log("\nno slip means NULL, not an empty string");
  const inv3 = await draft();
  const plain = await call("POST", "/api/payments/record", { invoiceId: inv3.id, amount: 287.5, reference: "ZZ-none" });
  if (plain.status !== 201) fail(`record without slip → ${plain.status} ${JSON.stringify(plain.body)}`);
  else {
    const p = await prisma.payment.findUnique({ where: { id: plain.body.payment.id } });
    p?.attachment === null && p?.attachmentName === null ? ok("both columns null") : fail(`→ ${JSON.stringify([p?.attachment, p?.attachmentName])}`);
  }
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
