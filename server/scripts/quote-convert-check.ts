/**
 * RAISING THE INVOICE FROM A QUOTATION — INCLUDING THE ACCEPTANCE IT RECORDS.
 *
 *   npx tsx scripts/quote-convert-check.ts        (the API must be running on 4100)
 *
 * The happy path is the easy half. What this is really for is the three ways one press can go
 * wrong now that it does more than one thing:
 *
 *   · it must refuse a quotation the client has never been shown — billing for an offer that was
 *     never sent is not a mistake anybody can explain afterwards;
 *   · it must refuse a SUPERSEDED one. A replaced quotation keeps its own `sent` status, so
 *     without that guard the old price is invoiceable while the client holds the revision;
 *   · from `sent` it must open the work as well. An invoice raised with no jobs behind it bills a
 *     client for something nobody was ever given to do.
 *
 * Works on its own throwaway client, user and rows, and deletes all of them. Local databases only.
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
const EMAIL = "zz-convert-check@example.invalid";
let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) failures++; };

const made = { userId: "", companyId: "", quotes: [] as string[], oppId: "", invoices: [] as string[] };

const convert = async (token: string, id: string) => {
  const r = await fetch(`${API}/api/quotations/${id}/convert`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
  });
  return { status: r.status, body: await r.json().catch(() => ({} as any)) };
};

/** A quotation in a given state, with three lines totalling SAR 330 + 15% VAT. */
async function quote(n: string, status: string, extra: Record<string, unknown> = {}) {
  const q = await prisma.quotation.create({
    data: {
      number: n, companyId: made.companyId, clientName: "ZZ Convert Check",
      service: "ZZ bundle", status,
      amount: 380, subtotalMinor: 33000, vatMinor: 4950, totalMinor: 37950, vatRateBp: 1500,
      items: [{ name: "ZZ line one", units: 1, price: 150 },
              { name: "ZZ line two", units: 2, price: 90 }] as any,
      date: new Date().toISOString().slice(0, 10),
      ...extra,
    },
  });
  made.quotes.push(q.id);
  return q;
}

async function main() {
  const password = crypto.randomBytes(12).toString("base64url");
  const user = await prisma.user.create({
    data: { name: "ZZ Convert Check", email: EMAIL, roleId: "admin", status: "active", type: "staff", passwordHash: await hashPassword(password) },
  });
  made.userId = user.id;
  const login = await fetch(`${API}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  const token = (await login.json().catch(() => ({} as any)))?.token;
  ok(!!token, "the throwaway user can sign in");
  if (!token) return;

  const co = await prisma.company.create({ data: { name: "ZZ Convert Check", country: "SA" } });
  made.companyId = co.id;

  console.log("what cannot be invoiced:");
  for (const st of ["draft", "approved"]) {
    const q = await quote(`ZZ-CONV-${st}`, st);
    const r = await convert(token, q.id);
    ok(r.status === 409, `a ${st} quotation is refused (got ${r.status})`);
    ok(/with the client/.test(String(r.body?.error ?? "")), `  and says why: ${r.body?.error ?? "no error"}`);
  }

  // The one that looks fine and is not: QT-x was replaced, but the replaced row keeps `sent`.
  const old = await quote("ZZ-CONV-old", "sent", { supersededAt: new Date().toISOString() });
  const supersededRes = await convert(token, old.id);
  ok(supersededRes.status === 409, `a superseded quotation is refused (got ${supersededRes.status})`);
  ok(/newer revision/.test(String(supersededRes.body?.error ?? "")), "  and points at the revision instead");

  console.log("one press from `sent`:");
  const live = await quote("ZZ-CONV-sent", "sent");
  // A deal on the board, so that winning it can be checked rather than assumed.
  const stage = await prisma.pipelineStage.findFirst({ where: { country: "SA", isWon: false, isLost: false, retired: false }, orderBy: { sort: "asc" } });
  const wonStage = await prisma.pipelineStage.findFirst({ where: { country: "SA", isWon: true, retired: false } });
  if (stage) {
    const opp = await prisma.opportunity.create({
      data: { title: "ZZ Convert Check", companyId: co.id, stageId: stage.id, country: "SA", quotationId: live.id },
    });
    made.oppId = opp.id;
  }

  const res = await convert(token, live.id);
  ok(res.status === 201, `the invoice is raised (got ${res.status}${res.status !== 201 ? ` — ${res.body?.error}` : ""})`);
  const inv = res.body?.invoice;
  if (inv) made.invoices.push(inv.id);
  ok(!!inv && inv.status === "draft", "it arrives as a draft, so it still has to be approved");
  ok(res.body?.accepted === true, "the response says the acceptance was recorded");

  // The figures are the whole reason the quotation is carried across rather than retyped.
  ok(inv?.subtotalMinor === 33000 && inv?.vatMinor === 4950 && inv?.totalMinor === 37950 && inv?.vatRateBp === 1500,
    `the quotation's own figures are carried across exactly (got ${inv?.subtotalMinor}/${inv?.vatMinor}/${inv?.totalMinor} @ ${inv?.vatRateBp}bp)`);
  ok(Array.isArray(inv?.items) && inv.items.length === 2, `and its line items (got ${(inv?.items ?? []).length})`);

  const after = await prisma.quotation.findUnique({ where: { id: live.id }, select: { status: true } });
  ok(after?.status === "invoiced", `the quotation is now invoiced (got ${after?.status})`);

  // THE HALF THAT IS EASY TO LOSE. Billing for work nobody was given is how it goes undone, so
  // three units across two lines must be three jobs.
  const tasks = await prisma.task.findMany({ where: { quotationId: live.id }, select: { title: true, assignee: true } });
  ok(tasks.length === 3, `the work is opened — 3 jobs for 3 units (got ${tasks.length})`);
  ok(tasks.every(t => t.assignee === "Unassigned"), "and left unassigned, not guessed into somebody's queue");

  if (made.oppId && wonStage) {
    const deal = await prisma.opportunity.findUnique({ where: { id: made.oppId }, select: { stageId: true, closedAt: true } });
    ok(deal?.stageId === wonStage.id && !!deal?.closedAt, "the deal is won, without anybody dragging the card");
  }

  // Pressing twice must not bill twice. The status check catches it; so would the invoice lookup.
  const again = await convert(token, live.id);
  ok(again.status === 409, `pressing it again is refused (got ${again.status})`);
  const invCount = await prisma.invoice.count({ where: { quotationId: live.id } });
  ok(invCount === 1, `and leaves one invoice, not two (got ${invCount})`);

  console.log("the portal's path still works:");
  const acc = await quote("ZZ-CONV-acc", "accepted");
  const accRes = await convert(token, acc.id);
  if (accRes.body?.invoice) made.invoices.push(accRes.body.invoice.id);
  ok(accRes.status === 201, `an already-accepted quotation still invoices (got ${accRes.status})`);
  ok(accRes.body?.accepted === false, "and is not reported as a fresh acceptance");
  // Delivery is NOT re-run for it here: it was scheduled when the client accepted in the portal.
  const accTasks = await prisma.task.count({ where: { quotationId: acc.id } });
  ok(accTasks === 0, `invoicing it does not re-open work the acceptance already scheduled (got ${accTasks})`);
}

try {
  await main();
} finally {
  for (const id of made.quotes) {
    await prisma.task.deleteMany({ where: { quotationId: id } });
    await prisma.invoice.deleteMany({ where: { quotationId: id } });
  }
  if (made.oppId) {
    await prisma.stageTransition.deleteMany({ where: { opportunityId: made.oppId } });
    await prisma.opportunity.delete({ where: { id: made.oppId } }).catch(() => {});
  }
  for (const id of made.quotes) await prisma.quotation.delete({ where: { id } }).catch(() => {});
  if (made.companyId) await prisma.company.delete({ where: { id: made.companyId } }).catch(() => {});
  if (made.userId) await prisma.user.delete({ where: { id: made.userId } }).catch(() => {});
  await prisma.$disconnect();
}
console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
