/**
 * RAISING AN INVOICE THAT RE-CHARGES DISBURSEMENTS.
 *
 *   npx tsx scripts/disbursement-billing-check.ts        (the API must be running on 4100)
 *
 * The thing this has to get right is not the happy path. It is that an invoice and the payments it
 * bills stand or fall together: if a payment has already been billed, NOTHING is saved. Were that to
 * half-succeed, the client would hold two invoices for one ministry fee, and the second one would
 * look as legitimate as the first.
 *
 * Works on its own throwaway client and its own rows, and deletes both. Local databases only.
 */
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import crypto from "node:crypto";

const host = String(process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`refusing: DATABASE_URL points at "${host || "an unknown host"}", not a local database.`);
  process.exit(2);
}

const API = process.env.API ?? "http://localhost:4100";
const EMAIL = "zz-billing-check@example.invalid";
let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) failures++; };

const made = { companyId: "", otherId: "", userId: "", disb: [] as string[], invoices: [] as string[] };

async function post(token: string, body: any) {
  const r = await fetch(`${API}/api/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const invoiceFor = (companyId: string, name: string, number: string, ids: string[], price: number) => ({
  number, companyId, clientName: name, amount: price, subtotalMinor: price * 100, vatMinor: 0,
  totalMinor: price * 100, vatRateBp: 0, currency: "SAR", status: "draft",
  date: new Date().toISOString().slice(0, 10),
  services: "billing check", items: [{ name: "Fee", units: 1, price }],
  disbursementIds: ids,
});

try {
  const pw = crypto.randomBytes(12).toString("base64url");
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash: await hashPassword(pw), roleId: "admin", status: "active", type: "staff" },
    create: { email: EMAIL, name: "ZZ Billing Check", passwordHash: await hashPassword(pw), roleId: "admin", status: "active", type: "staff" },
  });
  made.userId = user.id;
  const token = (await (await fetch(`${API}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: pw }),
  })).json() as any).token;
  ok(!!token, "signed in as a throwaway account");
  if (!token) throw new Error("no token");

  const co = await prisma.company.create({ data: { name: "ZZ Billing Check Client", lifecycle: "client" } });
  const other = await prisma.company.create({ data: { name: "ZZ Billing Check Other", lifecycle: "client" } });
  made.companyId = co.id; made.otherId = other.id;

  const mk = async (companyId: string, label: string, minor: number) => {
    const d = await prisma.disbursement.create({
      data: { companyId, clientName: "ZZ", label, amountMinor: minor, currency: "SAR", recharge: true, at: new Date().toISOString() },
    });
    made.disb.push(d.id);
    return d.id;
  };
  const a = await mk(co.id, "Fee A", 10000);
  const b = await mk(co.id, "Fee B", 20000);
  const elsewhere = await mk(other.id, "Someone else's fee", 30000);

  // 1. The ordinary case.
  const r1 = await post(token, invoiceFor(co.id, "ZZ Billing Check Client", `ZZCHK-${Date.now()}-1`, [a, b], 300));
  ok(r1.status === 201, `two payments bill in one invoice (got ${r1.status} ${r1.body?.error ?? ""})`);
  if (r1.body?.id) made.invoices.push(r1.body.id);
  const after1 = await prisma.disbursement.findMany({ where: { id: { in: [a, b] } }, select: { invoiceId: true } });
  ok(after1.every(d => d.invoiceId === r1.body?.id), "both rows point at the invoice that billed them");

  // 2. The one that matters: billing a payment that is already on an invoice.
  const before2 = await prisma.invoice.count();
  const r2 = await post(token, invoiceFor(co.id, "ZZ Billing Check Client", `ZZCHK-${Date.now()}-2`, [a], 100));
  ok(r2.status === 409, `billing an already-billed payment is refused (got ${r2.status})`);
  ok(/already been billed/.test(String(r2.body?.error ?? "")), `and says why: ${r2.body?.error ?? "(nothing)"}`);
  ok(await prisma.invoice.count() === before2, "NOTHING was saved - no orphan invoice left behind");
  const stillA = await prisma.disbursement.findUnique({ where: { id: a } });
  ok(stillA?.invoiceId === r1.body?.id, "and the first invoice still owns it");

  // 3. Another client's payment cannot be swept onto this invoice.
  const before3 = await prisma.invoice.count();
  const r3 = await post(token, invoiceFor(co.id, "ZZ Billing Check Client", `ZZCHK-${Date.now()}-3`, [elsewhere], 300));
  ok(r3.status === 409, `a payment belonging to another client is refused (got ${r3.status})`);
  ok(await prisma.invoice.count() === before3, "and again nothing was saved");
  const stillElse = await prisma.disbursement.findUnique({ where: { id: elsewhere } });
  ok(stillElse?.invoiceId === null, "the other client's payment is untouched");

  // 4. An invoice with no disbursements still goes through the ordinary route.
  const r4 = await post(token, { ...invoiceFor(co.id, "ZZ Billing Check Client", `ZZCHK-${Date.now()}-4`, [], 50), disbursementIds: [] });
  ok(r4.status === 201, `an ordinary invoice is unaffected (got ${r4.status} ${r4.body?.error ?? ""})`);
  if (r4.body?.id) made.invoices.push(r4.body.id);
} finally {
  await prisma.disbursement.deleteMany({ where: { id: { in: made.disb } } });
  if (made.invoices.length) await prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } });
  if (made.companyId) await prisma.company.deleteMany({ where: { id: { in: [made.companyId, made.otherId] } } });
  if (made.userId) await prisma.user.deleteMany({ where: { id: made.userId } });
  await prisma.$disconnect();
}
console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
