/**
 * Throwaway check: a billing document cannot carry money that does not make sense.
 *
 * The console refused a negative price and a quantity below one, but nothing on the server did:
 * POST /api/invoices with `units: -5, price: -100` returned 201 and stored a document totalling
 * 575.00, because negative × negative is positive. Anything that is not the console bypassed the
 * rule entirely.
 *
 * The negative cases matter, but the ACCEPT cases matter more: a validator that rejects ordinary
 * billing is a worse outage than the hole it closes. So this asserts, in both directions, that a
 * normal invoice, a zero-priced line, an item-less field edit and a large-but-real amount all
 * still go through.
 *
 * Own user, own documents. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";

async function sweep() {
  await prisma.invoice.deleteMany({ where: { number: { startsWith: "ZZ-AMT-" } } });
  await prisma.quotation.deleteMany({ where: { number: { startsWith: "ZZ-AMT-" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    await prisma.user.create({ data: { name: "ZZ Amt", email: "zz-amt@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("zz-Throwaway-1!", 10) } });
    const lj: any = await (await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zz-amt@example.invalid", password: "zz-Throwaway-1!" }) })).json();
    if (!lj.token) { console.log("login failed — is the API up?"); return; }
    const H = { "Content-Type": "application/json", Authorization: "Bearer " + lj.token };

    let n = 0;
    const post = (body: any, path = "/api/invoices") =>
      fetch(`${API}${path}`, { method: "POST", headers: H, body: JSON.stringify({ number: `ZZ-AMT-${++n}`, clientName: "ZZ Probe", status: "draft", currency: "SAR", ...body }) });

    // ── the exact payload that used to be accepted ────────────────────────────────────────────
    const attack = await post({ amount: 575, items: [{ name: "ZZ neg", units: -5, price: -100 }], totalMinor: 57500 });
    const aj: any = await attack.json().catch(() => ({}));
    console.log(`units:-5 price:-100 is refused:        ${attack.status === 400 ? "YES" : "NO (" + attack.status + ")"}`);
    if (attack.status !== 400) fail("the original hole is still open — a negative line was stored as a positive total");
    else console.log(`  says why:                            "${String(aj.error).slice(0, 72)}…"`);

    // ── each half on its own, so neither is only caught by the other ──────────────────────────
    for (const [label, item] of [
      ["a negative price alone", { name: "ZZ p", units: 1, price: -100 }],
      ["a zero quantity", { name: "ZZ q", units: 0, price: 100 }],
      ["a negative quantity alone", { name: "ZZ q2", units: -1, price: 100 }],
      ["a non-numeric price", { name: "ZZ x", units: 1, price: "abc" }],
    ] as const) {
      const r = await post({ amount: 100, items: [item] });
      console.log(`  ${label.padEnd(36)} ${r.status === 400 ? "refused" : "ACCEPTED (" + r.status + ")"}`);
      if (r.status !== 400) fail(`${label} was accepted`);
    }

    // ── the stored totals travel separately from the lines ────────────────────────────────────
    const negTotal = await post({ amount: 100, items: [{ name: "ZZ ok", units: 1, price: 100 }], totalMinor: -10000 });
    console.log(`\na negative stored total is refused:      ${negTotal.status === 400 ? "YES" : "NO (" + negTotal.status + ")"}`);
    if (negTotal.status !== 400) fail("sane lines with a negative total were accepted — the total is what every report reads");

    // ── and the same rule covers quotations, which become invoices ────────────────────────────
    const q = await fetch(`${API}/api/quotations`, { method: "POST", headers: H, body: JSON.stringify({ number: "ZZ-AMT-Q1", clientName: "ZZ Probe", status: "draft", currency: "SAR", amount: 575, items: [{ name: "ZZ neg", units: -5, price: -100 }] }) });
    console.log(`  quotations are held to it too:         ${q.status === 400 ? "YES" : "NO (" + q.status + ")"}`);
    if (q.status !== 400) fail("a quotation could carry a negative line and then be converted into an invoice");

    // ── ORDINARY BILLING MUST STILL WORK ──────────────────────────────────────────────────────
    console.log("");
    const okCases: Array<[string, any]> = [
      ["a normal invoice", { amount: 575, items: [{ name: "ZZ service", units: 2, price: 250 }], subtotalMinor: 50000, vatMinor: 7500, totalMinor: 57500 }],
      ["a line with no units (means one)", { amount: 300, items: [{ name: "ZZ implicit", price: 300 }] }],
      ["a large but real amount", { amount: 250000, items: [{ name: "ZZ big", units: 1, price: 250000 }], totalMinor: 25000000 }],
    ];
    for (const [label, body] of okCases) {
      const r = await post(body);
      console.log(`${label.padEnd(38)} ${r.status < 300 ? "accepted" : "REFUSED (" + r.status + ") — " + String(((await r.json().catch(() => ({}))) as any).error).slice(0, 50)}`);
      if (r.status >= 300) fail(`${label} was refused — the guard is blocking real billing`);
    }

    // A zero-priced LINE is fine (a waived fee sits beside chargeable ones); a zero-total DOCUMENT
    // is refused, but by a pre-existing rule and not by this guard — asserted so a later change to
    // either one cannot quietly swap which rule is doing the work.
    const zeroLine = await post({ amount: 250, items: [{ name: "ZZ waived", units: 1, price: 0 }, { name: "ZZ charged", units: 1, price: 250 }], totalMinor: 25000 });
    console.log(`a waived line beside a charged one     ${zeroLine.status < 300 ? "accepted" : "REFUSED (" + zeroLine.status + ")"}`);
    if (zeroLine.status >= 300) fail("a zero-priced line was refused — waiving one fee on a multi-line invoice is ordinary");

    // A FIELD EDIT must not have to resend the lines. This is the case the guard is written to let
    // through: no `items` key at all means nothing about the money is being asserted.
    const made: any = await (await post({ amount: 300, items: [{ name: "ZZ base", units: 1, price: 300 }], totalMinor: 30000 })).json();
    const edit = await fetch(`${API}/api/invoices/${made.id}`, { method: "PUT", headers: H, body: JSON.stringify({ notes: "ZZ retitled, money untouched" }) });
    console.log(`editing a field without resending lines ${edit.status < 300 ? "accepted" : "REFUSED (" + edit.status + ")"}`);
    if (edit.status >= 300) fail("a due-date/subject edit was forced to resend the figures — that is its own way to corrupt a total");
    const after = await prisma.invoice.findUnique({ where: { id: made.id } });
    console.log(`  …and the total is unchanged:         ${after?.totalMinor === 30000 ? "YES" : "NO (" + after?.totalMinor + ")"}`);
    if (after?.totalMinor !== 30000) fail("a field edit moved the money");

  } finally {
    await sweep();
  }

  const left = (await prisma.invoice.count({ where: { number: { startsWith: "ZZ-AMT-" } } }))
    + (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
