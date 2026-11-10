/**
 * THE THREE GUARDS THAT STAND BETWEEN A CLICK AND A WRONG NUMBER.
 *
 *   npx tsx scripts/finance-guards-check.ts     (needs the API running)
 *
 * Each of these was found open by audit, and each fails quietly rather than loudly, which is why
 * they are asserted here instead of described:
 *
 *   · a VAT-bearing invoice cannot be approved while the firm's own tax identity is unset — live had
 *     no `org` settings row at all, so everything issued carried no seller VAT number and no ZATCA
 *     QR, and looked perfectly normal while doing it
 *   · a zero-VAT invoice is NOT gated, because a firm that is not VAT-registered must still bill
 *   · the same payment submitted twice records once — a double-clicked button was over-booking cash
 *   · a crash thrown by a browser extension is not filed as an app crash, because a queue full of
 *     other people's bugs is a queue nobody reads
 *
 * Everything it makes is named or numbered "ZZ"/"ZZF-" and removed at the end, including the org
 * settings row it has to blank, so it runs in any order — which is also why it refuses to run
 * anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This blanks the org tax identity and writes throwaway invoices and payments."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: number, want: number, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${got}, expected ${want}`);

const TAG = "ZZ FinGuard";
const EMAIL = "zz-finguard@example.invalid";
let savedOrg: any; // the real settings row, put back at the end

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map((c) => c.id);
  await prisma.payment.deleteMany({ where: { invoiceNumber: { startsWith: "ZZF-" } } });
  await prisma.invoice.deleteMany({ where: { number: { startsWith: "ZZF-" } } });
  if (ids.length) await prisma.company.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.errorReport.deleteMany({ where: { path: "/zz-finguard" } });
}

async function setOrg(value: any) {
  if (value === null) await prisma.appSetting.deleteMany({ where: { key: "org" } });
  else await prisma.appSetting.upsert({ where: { key: "org" }, update: { value }, create: { key: "org", value } });
}

async function main() {
  await sweep();
  savedOrg = (await prisma.appSetting.findUnique({ where: { key: "org" } }))?.value ?? null;

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

  // SAR 250.00 + 15% = 287.50, the figure that exposed the rounding bug these columns were added for.
  let n = 0;
  const draft = (vat: boolean) =>
    prisma.invoice.create({
      data: {
        number: `ZZF-${++n}`, companyId: co.id, clientName: co.name, status: "draft", currency: "SAR",
        amount: 288, subtotalMinor: 25000, totalMinor: 28750,
        ...(vat ? { vatMinor: 3750, vatRateBp: 1500 } : { vatMinor: 0, vatRateBp: 0 }),
        date: "2026-11-10", dueDate: "2026-11-24",
      },
    });

  console.log("\ntax identity — the gate on approving a VAT invoice");
  await setOrg(null); // the state live was actually in: no settings row at all
  const vatInv = await draft(true);
  const blocked = await call("POST", `/api/invoices/${vatInv.id}/approve`);
  expect(blocked.status, 409, "no org settings row at all");
  const missing: string[] = blocked.body?.missingTaxIdentity ?? [];
  missing.length === 3
    ? ok(`and names all three: ${missing.join(", ")}`)
    : fail(`the refusal should name legal name, VAT number and CR number — got ${JSON.stringify(missing)}`);
  // The console slices a server error at 140 characters before showing it, so a longer refusal loses
  // exactly the half that says what to do about it. Asserted because it is invisible from here: the
  // message reads correctly in a test and is cut off on screen.
  const fits = (what: string, msg: unknown) => {
    const s = String(msg ?? "");
    s.length > 0 && s.length < 140
      ? ok(`${what} fits the console's 140-char toast (${s.length})`)
      : fail(`${what} is ${s.length} chars — the console will cut it off: ${JSON.stringify(s)}`);
  };
  fits("the tax-identity refusal", blocked.body?.error);
  if ((await prisma.invoice.findUnique({ where: { id: vatInv.id } }))?.status !== "draft")
    fail("the invoice was approved anyway — the refusal did not stop the write");
  else ok("and the invoice is still a draft");

  await setOrg({ orgName: "ZZ Firm", vatNumber: "" });
  expect((await call("POST", `/api/invoices/${vatInv.id}/approve`)).status, 409, "name set, VAT and CR still blank");
  await setOrg({ legalName: "ZZ Firm LLC", vatNumber: "   ", crNumber: "1010123456" });
  expect((await call("POST", `/api/invoices/${vatInv.id}/approve`)).status, 409, "a VAT number of only spaces");

  console.log("\n…and a zero-VAT invoice must NOT be gated");
  const plain = await draft(false);
  expect((await call("POST", `/api/invoices/${plain.id}/approve`)).status, 200, "no VAT on the document");

  console.log("\n…and it approves once the identity is there");
  await setOrg({ legalName: "ZZ Firm LLC", vatNumber: "300012345600003", crNumber: "1010123456", address: "Riyadh" });
  expect((await call("POST", `/api/invoices/${vatInv.id}/approve`)).status, 200, "all three set");

  console.log("\nduplicate payment — a second click is not a second payment");
  const pay = (body: any) => call("POST", "/api/payments/record", { invoiceId: vatInv.id, ...body });
  const first = await pay({ amount: 100, date: "2026-11-10" });
  expect(first.status, 201, "the first payment");
  const second = await pay({ amount: 100, date: "2026-11-10" });
  expect(second.status, 409, "the same amount, same date, same (absent) reference");
  second.body?.duplicateOf
    ? ok(`and says which receipt it collides with: ${second.body.duplicateOf}`)
    : fail("the refusal should name the receipt it duplicates");
  fits("the duplicate-payment refusal", second.body?.error);
  expect(await prisma.payment.count({ where: { invoiceId: vatInv.id } }), 1, "payment rows actually stored");

  const ref = await pay({ amount: 100, date: "2026-11-10", reference: "ZZ-SECOND-TRANSFER" });
  expect(ref.status, 201, "a genuine second payment, distinguished by its reference");
  const diff = await pay({ amount: 7, date: "2026-11-10" });
  expect(diff.status, 201, "a different amount on the same day");
  expect(await prisma.payment.count({ where: { invoiceId: vatInv.id } }), 3, "payment rows after both are accepted");

  console.log("\nextension crashes are not our crashes");
  const report = (detail: string) =>
    fetch(API + "/api/error-reports", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ kind: "crash", app: "console", path: "/zz-finguard", message: "ZZ synthetic", detail }),
    }).then((r) => r.status);
  const ext = await report("TypeError: x\n    at Y (chrome-extension://abcdefghijklmnop/executors/200.js:1:761)\n    at E (chrome-extension://abcdefghijklmnop/executors/200.js:1:1442)");
  expect(ext, 202, "a stack entirely inside an extension");
  const mine = await report("TypeError: x\n    at Y (chrome-extension://abcdefghijklmnop/executors/200.js:1:761)\n    at R (http://localhost:5188/index.html:4211:9)");
  expect(mine, 201, "one app frame anywhere on the stack");
  expect(await prisma.errorReport.count({ where: { path: "/zz-finguard" } }), 1, "reports actually filed");

  await setOrg(savedOrg);
  await sweep();
  console.log("\ncleaned up: YES (org settings row restored)");
  console.log(bad ? `\n${bad} problem(s)` : "\nall good");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await setOrg(savedOrg).catch(() => {});
  await sweep().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
