/**
 * Throwaway check: a lead can be corrected without anything else moving.
 *
 * The Add-lead form was create-only, so a typo in a company name or a wrong phone number could not
 * be fixed from the Leads screen at all. Editing a record is easy to get wrong in two specific ways,
 * and both are asserted here:
 *
 *   - the company's contact/email/phone columns are a MIRROR of the primary contact, written by
 *     contacts.ts alone. An edit form that wrote them directly would give the mirror a second author
 *     and the two would drift. So the person is edited through the contacts module and the mirror
 *     must follow on its own.
 *   - LIFECYCLE must be untouchable here. Turning a lead into a client provisions a portal login,
 *     opens a deal and demands a CR — that is the lifecycle route's job. A correction form that
 *     could do it by accident would be a very expensive typo.
 *
 * Also asserted: an empty name is refused, `ownerId: null` is honoured as a real choice rather than
 * ignored, and editing does not create a second contact.
 *
 * Own company, own contacts. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
import { addContact } from "../src/contacts.js";

const API = "http://localhost:4100";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  if (cos.length) {
    await prisma.contact.deleteMany({ where: { companyId: { in: cos.map(c => c.id) } } });
    await prisma.company.deleteMany({ where: { id: { in: cos.map(c => c.id) } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    await prisma.user.create({ data: { name: "ZZ Edit Admin", email: "zz-edit-admin@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("zz-Throwaway-1!", 10) } });
    const seller = await prisma.user.create({ data: { name: "ZZ Seller", email: "zz-seller@example.invalid", roleId: "sales", status: "active", type: "staff" } });
    const lj: any = await (await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zz-edit-admin@example.invalid", password: "zz-Throwaway-1!" }) })).json();
    if (!lj.token) { console.log("login failed — is the API up?"); return; }
    const H = { "Content-Type": "application/json", Authorization: "Bearer " + lj.token };

    const co = await prisma.company.create({ data: { name: "ZZ Typo Co", lifecycle: "lead", city: "Riyadh", source: "Referral", ownerId: seller.id } });
    await addContact(co.id, { name: "Wrong Name", jobTitle: "Manager", email: "wrong@example.invalid", phone: "+966 55 000 0000" });

    const put = (body: any, id = co.id) =>
      fetch(`${API}/api/companies/${id}/details`, { method: "PUT", headers: H, body: JSON.stringify(body) });

    // ── the correction itself ─────────────────────────────────────────────────────────────────
    const r = await put({
      name: "ZZ Fixed Co", city: "Jeddah", source: "Website", sourceDetail: "ZZ note",
      ownerId: seller.id,
      contact: { name: "Right Name", jobTitle: "Director", email: "right@example.invalid", phone: "+966 55 111 2222" },
    });
    const after = await prisma.company.findUnique({ where: { id: co.id } });
    console.log(`company fields updated:                  ${r.status === 200 && after?.name === "ZZ Fixed Co" && after?.city === "Jeddah" ? "YES" : "NO (" + r.status + ")"}`);
    if (after?.name !== "ZZ Fixed Co" || after?.city !== "Jeddah") fail("the company's own fields did not save");

    // ── the mirror followed, and nobody wrote it twice ────────────────────────────────────────
    const contacts = await prisma.contact.findMany({ where: { companyId: co.id } });
    console.log(`  the contact was EDITED, not added:     ${contacts.length === 1 ? "YES" : "NO (" + contacts.length + " contacts)"}`);
    if (contacts.length !== 1) fail("editing created a second contact instead of correcting the first");
    console.log(`  the person's own row is right:         ${contacts[0]?.name === "Right Name" && contacts[0]?.phone === "+966 55 111 2222" ? "YES" : "NO"}`);
    if (contacts[0]?.name !== "Right Name") fail("the contact was not updated");
    console.log(`  the company's mirror followed:         ${after?.contact === "Right Name" && after?.email === "right@example.invalid" && after?.phone === "+966 55 111 2222" ? "YES" : "NO (" + after?.contact + "/" + after?.email + "/" + after?.phone + ")"}`);
    if (after?.contact !== "Right Name" || after?.email !== "right@example.invalid") fail("the flat columns disagree with the primary contact — the mirror has drifted");
    console.log(`  …and is still primary:                 ${contacts[0]?.isPrimary ? "YES" : "NO"}`);
    if (!contacts[0]?.isPrimary) fail("editing dropped the primary flag");

    // ── lifecycle is untouchable ──────────────────────────────────────────────────────────────
    await put({ name: "ZZ Fixed Co", lifecycle: "client", status: "active", cr: "1234567890" });
    const sneaky = await prisma.company.findUnique({ where: { id: co.id } });
    console.log(`\nlifecycle cannot be changed here:        ${sneaky?.lifecycle === "lead" ? "YES (still lead)" : "NO — became " + sneaky?.lifecycle}`);
    if (sneaky?.lifecycle !== "lead") fail("a correction form turned a lead into a client — that provisions a portal login and opens a deal");
    console.log(`  and a CR cannot be smuggled in:        ${!sneaky?.cr ? "YES" : "NO (" + sneaky?.cr + ")"}`);
    if (sneaky?.cr) fail("a field the lifecycle route is responsible for was written by the edit form");

    // ── unassigning is a real choice ──────────────────────────────────────────────────────────
    await put({ name: "ZZ Fixed Co", ownerId: null });
    const unowned = await prisma.company.findUnique({ where: { id: co.id } });
    console.log(`\nownerId: null is honoured:               ${unowned?.ownerId === null ? "YES" : "NO"}`);
    if (unowned?.ownerId !== null) fail("a manager deliberately unassigning a lead was ignored");
    // …and omitting the key leaves it alone, so a form that does not send it cannot wipe ownership.
    await prisma.company.update({ where: { id: co.id }, data: { ownerId: seller.id } });
    await put({ name: "ZZ Fixed Co" });
    const kept = await prisma.company.findUnique({ where: { id: co.id } });
    console.log(`  omitting the key leaves it alone:      ${kept?.ownerId === seller.id ? "YES" : "NO"}`);
    if (kept?.ownerId !== seller.id) fail("not sending ownerId wiped the owner");

    // ── refusals ──────────────────────────────────────────────────────────────────────────────
    const blank = await put({ name: "   " });
    console.log(`\nan empty name is refused:                ${blank.status === 400 ? "YES" : "NO (" + blank.status + ")"}`);
    if (blank.status !== 400) fail("a lead could be saved with no name");
    const missing = await put({ name: "ZZ X" }, "does-not-exist");
    console.log(`  a missing company is a 404:            ${missing.status === 404 ? "YES" : "NO (" + missing.status + ")"}`);
    if (missing.status !== 404) fail("editing a company that does not exist did not 404");

    // ── validation, on the SERVER ─────────────────────────────────────────────────────────────
    // The console checks these too, but a form is a convenience and the route is the rule. "test" in
    // an email field is not a lead with no email — it is a lead nobody can reach, and it fails
    // silently weeks later when the invitation bounces.
    const badEmail = await put({ name: "ZZ Fixed Co", contact: { name: "A", email: "test" } });
    console.log(`\nrefuses a non-email:                     ${badEmail.status === 400 ? "YES" : "NO (" + badEmail.status + ")"}`);
    if (badEmail.status !== 400) fail('"test" was accepted as an email address');
    const badPhone = await put({ name: "ZZ Fixed Co", contact: { name: "A", phone: "ttt" } });
    console.log(`  refuses a non-phone:                   ${badPhone.status === 400 ? "YES" : "NO (" + badPhone.status + ")"}`);
    if (badPhone.status !== 400) fail('"ttt" was accepted as a phone number');
    const shortPhone = await put({ name: "ZZ Fixed Co", contact: { name: "A", phone: "222" } });
    console.log(`  refuses a 3-digit "number":            ${shortPhone.status === 400 ? "YES" : "NO (" + shortPhone.status + ")"}`);
    if (shortPhone.status !== 400) fail("a 3-digit string was accepted as a phone number");
    const orphanDetails = await put({ name: "ZZ Fixed Co", contact: { name: "", email: "someone@example.invalid" } });
    console.log(`  refuses details with nobody attached:  ${orphanDetails.status === 400 ? "YES" : "NO (" + orphanDetails.status + ")"}`);
    if (orphanDetails.status !== 400) fail("an email was saved with no name against it");
    const blanksOk = await put({ name: "ZZ Fixed Co", contact: { name: "Someone", email: "", phone: "" } });
    console.log(`  …but BLANK is still fine:              ${blanksOk.status === 200 ? "YES" : "NO (" + blanksOk.status + ")"}`);
    if (blanksOk.status !== 200) fail("a lead with no contact details was refused — it would live on a sticky note instead");

    // The CREATE route was the looser of the two, which is backwards.
    const createBad = await fetch(`${API}/api/companies`, {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "ZZ New Bad", lifecycle: "lead", contacts: [{ name: "B", email: "nope" }] }),
    });
    console.log(`  creating is held to the same rule:     ${createBad.status === 400 ? "YES" : "NO (" + createBad.status + ")"}`);
    if (createBad.status !== 400) fail("a bad address typed at CREATION is accepted — the one nobody ever looks at again");

    // ── the duplicate check can exclude itself ────────────────────────────────────────────────
    const self = await (await fetch(`${API}/api/companies/duplicates?name=${encodeURIComponent("ZZ Fixed Co")}&excludeId=${co.id}`, { headers: H })).json() as any[];
    console.log(`\nduplicate check can exclude itself:      ${!self.some(d => d.id === co.id) ? "YES" : "NO"}`);
    if (self.some(d => d.id === co.id)) fail("a lead being edited warns that it duplicates itself");

  } finally {
    await sweep();
  }

  const left =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
