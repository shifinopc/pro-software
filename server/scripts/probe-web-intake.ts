/**
 * Throwaway check for the public enquiry endpoint, written from the attacker's side.
 *
 * This is the only route in the product that writes without a session, so most of what is asserted
 * here is what it must REFUSE or ignore:
 *   - no key, a wrong key and a revoked key are all refused, with the same message
 *   - the refusal never says which of those it was, so probing keys learns nothing
 *   - a payload naming lifecycle, ownerId, cr or status cannot set any of them
 *   - the honeypot answers success and writes nothing
 *   - a submission with no way to reach anybody is rejected
 *   - a malformed email is rejected
 *   - oversized fields are cut, not stored whole
 *   - a body that is not an object is rejected
 *   - an existing CLIENT is never modified — staff are told instead
 *   - the response is identical whether a lead was created or joined, so the key cannot be used to
 *     test which addresses are already on file
 *
 * And what it must do: create a lead with a contact, an owner, the message on the file, and a
 * notification — then join rather than duplicate on a second submission.
 *
 * Own key, own leads. Deletes all of it afterwards.
 */
import crypto from "node:crypto";
import { prisma } from "../src/db.js";

const API = "http://localhost:4100";

/**
 * Thrown the moment the endpoint rate-limits this machine.
 *
 * This probe makes about a dozen requests and the endpoint allows twenty per address per ten
 * minutes, so running it twice inside that window trips its own limiter — and every assertion after
 * that point then fails for a reason that has nothing to do with the code. Checking only at the
 * start was not enough: the limit can be reached half way through. Raised here, at the one place
 * every request goes through, so the run stops honestly instead of reporting a cascade of bugs.
 */
class RateLimited extends Error {}

const post = (body: any, key?: string) =>
  fetch(API + "/api/public/enquiry", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async r => {
    if (r.status === 429) throw new RateLimited();
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  });

const mkKey = async (name: string, revoked = false) => {
  const raw = "zzk_" + crypto.randomBytes(24).toString("hex");
  await prisma.apiKey.create({
    data: { name, prefix: raw.slice(0, 10) + "…", keyHash: crypto.createHash("sha256").update(raw).digest("hex"), scope: "write", createdAt: new Date().toISOString(), revoked },
  });
  return raw;
};

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: "ZZ " } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: "ZZ " } }, { message: { contains: "ZZ " } }] } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const key = await mkKey("ZZ Website");
  const dead = await mkKey("ZZ Revoked Site", true);


  // ── the door ───────────────────────────────────────────────────────────────────────────────
  const noKey = await post({ company: "ZZ Nope", email: "a@b.co" });
  const badKey = await post({ company: "ZZ Nope", email: "a@b.co" }, "zzk_not_a_real_key");
  const revoked = await post({ company: "ZZ Nope", email: "a@b.co" }, dead);
  console.log(`no key refused:                          ${noKey.status === 401 ? "YES" : "NO (" + noKey.status + ")"}`);
  console.log(`wrong key refused:                       ${badKey.status === 401 ? "YES" : "NO (" + badKey.status + ")"}`);
  console.log(`revoked key refused:                     ${revoked.status === 401 ? "YES" : "NO (" + revoked.status + ")"}`);
  for (const [what, r] of [["no key", noKey], ["wrong key", badKey], ["revoked key", revoked]] as const) {
    if (r.status !== 401) fail(`${what} was not refused`);
  }
  const same = noKey.body.error === badKey.body.error && badKey.body.error === revoked.body.error;
  console.log(`…all three say the same thing:           ${same ? "YES" : "NO"}`);
  if (!same) fail("the refusal tells a prober which of their guesses used to be a real key");
  if (await prisma.company.count({ where: { name: "ZZ Nope" } })) fail("a refused request still wrote a company");

  // ── the shape of the payload ───────────────────────────────────────────────────────────────
  const cases: Array<[string, any, number]> = [
    ["no contact details at all", { company: "ZZ Unreachable" }, 400],
    ["nothing to call it", { email: "a@b.co" }, 400],
    ["a malformed email", { company: "ZZ Bad Mail", email: "not-an-email" }, 400],
    ["an array instead of an object", [1, 2, 3], 400],
  ];
  console.log("");
  for (const [what, payload, expect] of cases) {
    const r = await post(payload, key);
    console.log(`rejects ${what.padEnd(28)}: ${r.status === expect ? "YES" : "NO (" + r.status + ")"}`);
    if (r.status !== expect) fail(`${what} was accepted`);
  }
  if (await prisma.company.count({ where: { name: { startsWith: "ZZ Unreachable" } } })) fail("a rejected submission still wrote a company");

  // ── the honeypot ───────────────────────────────────────────────────────────────────────────
  const bot = await post({ company: "ZZ Bot Co", email: "bot@example.invalid", website_url: "http://spam" }, key);
  console.log(`\nhoneypot answers success:                ${bot.status === 202 ? "YES" : "NO (" + bot.status + ")"}`);
  console.log(`…and writes nothing:                     ${(await prisma.company.count({ where: { name: "ZZ Bot Co" } })) === 0 ? "YES" : "NO"}`);
  if (await prisma.company.count({ where: { name: "ZZ Bot Co" } })) fail("the honeypot let a bot through");

  // ── a real enquiry ─────────────────────────────────────────────────────────────────────────
  const good = await post({
    company: "ZZ Falcon Contracting", name: "ZZ Layla Hassan", email: "zz-layla@example.invalid",
    phone: "+966 55 000 1122", message: "We need 12 new visas before Ramadan.", source: "website", page: "/services/visas",
    // Everything below is an attempt at mass assignment and must be ignored entirely.
    lifecycle: "client", ownerId: "somebody-elses-id", cr: "1010000000", status: "active", id: "chosen-id",
  }, key);
  console.log(`\na real enquiry is accepted:              ${good.status === 202 ? "YES" : "NO (" + good.status + ")"}`);
  if (good.status !== 202) fail(`a valid enquiry was refused: ${JSON.stringify(good.body)}`);

  const lead = await prisma.company.findFirst({ where: { name: "ZZ Falcon Contracting" } });
  console.log(`  it became a LEAD, not a client:        ${lead?.lifecycle === "lead" ? "YES" : "NO (" + lead?.lifecycle + ")"}`);
  if (lead?.lifecycle !== "lead") fail("a public form created something other than a lead");
  console.log(`  the CR in the payload was ignored:     ${!lead?.cr ? "YES" : "NO (" + lead?.cr + ")"}`);
  if (lead?.cr) fail("a public payload set the CR number");
  console.log(`  the owner in the payload was ignored:  ${lead?.ownerId !== "somebody-elses-id" ? "YES" : "NO"}`);
  if (lead?.ownerId === "somebody-elses-id") fail("a public payload chose the owner");
  console.log(`  the id in the payload was ignored:     ${lead?.id !== "chosen-id" ? "YES" : "NO"}`);
  if (lead?.id === "chosen-id") fail("a public payload chose the primary key");

  const contact = await prisma.contact.findFirst({ where: { companyId: lead!.id } });
  console.log(`  a contact was created:                 ${contact ? "YES — " + contact.name : "NO"}`);
  if (!contact || contact.email !== "zz-layla@example.invalid") fail("the person who enquired was not recorded");
  const note = await prisma.interaction.findFirst({ where: { companyId: lead!.id } });
  console.log(`  their message is on the file:          ${note && /Ramadan/.test(note.summary ?? "") ? "YES" : "NO"}`);
  if (!note || !/Ramadan/.test(note.summary ?? "")) fail("the enquiry text was not kept");
  const told = await prisma.notification.count({ where: { title: { contains: "ZZ Falcon" } } });
  console.log(`  somebody was told:                     ${told === 1 ? "YES" : "NO (" + told + ")"}`);
  if (told !== 1) fail("a web enquiry arrived and nobody was notified");

  // ── oversized input is cut, not stored ─────────────────────────────────────────────────────
  const long = await post({ company: "ZZ " + "x".repeat(5000), email: "zz-long@example.invalid" }, key);
  const longRow = await prisma.company.findFirst({ where: { name: { startsWith: "ZZ xxx" } } });
  console.log(`\noversized name is capped, not rejected:  ${long.status === 202 && longRow && longRow.name.length <= 191 ? "YES (" + longRow.name.length + " chars)" : "NO (status " + long.status + ")"}`);
  // Both halves matter. Storing 5,000 characters would be one bug; throwing a 500 because the column
  // is VARCHAR(191) is a different one, and that is the one this originally had.
  if (long.status !== 202) fail("a long company name broke the endpoint instead of being shortened");
  if (!longRow || longRow.name.length > 191) fail("a 5,000-character company name reached the database");

  // ── a repeat submission joins ──────────────────────────────────────────────────────────────
  const before = await prisma.company.count({ where: { name: "ZZ Falcon Contracting" } });
  const repeat = await post({ company: "ZZ Falcon Contracting", email: "zz-layla@example.invalid", message: "Any update?" }, key);
  const after = await prisma.company.count({ where: { name: "ZZ Falcon Contracting" } });
  console.log(`\na repeat submission makes no second:     ${after === before ? "YES" : "NO (" + before + " → " + after + ")"}`);
  if (after !== before) fail("enquiring twice created two leads");
  const notes = await prisma.interaction.count({ where: { companyId: lead!.id } });
  console.log(`…and joins the file it belongs to:       ${notes === 2 ? "YES" : "NO (" + notes + " notes)"}`);
  if (notes !== 2) fail("the second enquiry was not added to the existing lead");
  console.log(`…and answers identically:                ${repeat.body.message === good.body.message ? "YES" : "NO"}`);
  if (repeat.body.message !== good.body.message) fail("the reply reveals whether the address was already on file");

  // ── an existing CLIENT is never touched ────────────────────────────────────────────────────
  const client = await prisma.company.create({
    data: { name: "ZZ Real Client", cr: "9998880001", country: "SA", lifecycle: "client", email: "zz-client@example.invalid" },
  });
  const snapshot = JSON.stringify(client);
  const onClient = await post({ company: "ZZ Real Client", email: "zz-client@example.invalid", message: "Please add another visa." }, key);
  const clientAfter = await prisma.company.findUnique({ where: { id: client.id } });
  console.log(`\nan existing client is untouched:         ${JSON.stringify(clientAfter) === snapshot ? "YES" : "NO"}`);
  if (JSON.stringify(clientAfter) !== snapshot) fail("a public form modified a client's record");
  console.log(`…and no lead is created beside them:     ${(await prisma.company.count({ where: { name: "ZZ Real Client" } })) === 1 ? "YES" : "NO"}`);
  if ((await prisma.company.count({ where: { name: "ZZ Real Client" } })) !== 1) fail("a duplicate was created for an existing client");
  const clientNote = await prisma.notification.count({ where: { title: { contains: "existing record" } } });
  console.log(`…but staff are told about it:            ${clientNote >= 1 ? "YES" : "NO"}`);
  if (!clientNote) fail("a client's enquiry arrived and nobody was told");
  if (onClient.status !== 202) fail("the client's own enquiry was refused");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await sweep();
  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.apiKey.count({ where: { name: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => {
  if (e instanceof RateLimited) {
    console.log("\nThe endpoint started rate-limiting this machine part way through, which is the");
    console.log("limiter doing exactly its job. Wait ten minutes, or restart the API to clear it,");
    console.log("then run this again. No assertion below that point was reached.");
    await sweep().catch(() => {});
    await prisma.$disconnect();
    process.exitCode = 2;
    return;
  }
  console.error(e);
  await prisma.$disconnect();
  process.exitCode = 1;
});
