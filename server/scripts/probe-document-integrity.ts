/**
 * Throwaway check that an issued government record cannot be quietly rewritten, and can still be fixed.
 *
 * An audit pushed an issued Work Permit's expiry from 2027 to 2039 through the ordinary PUT and got a
 * 200 back with an empty history. Recording the change made it visible, which is not the same as
 * preventing it: the record still said whatever the last person to touch it typed, and a compliance
 * record that can be freely rewritten cannot be reconciled against the portal it came from.
 *
 * The opposite failure matters just as much and is easier to cause by accident. A record nobody can
 * fix is a record people keep somewhere else — a mistyped number would be permanent, the officer
 * would put the real one in a note, and the compliance screen would be wrong forever while looking
 * authoritative. So this checks BOTH: that the direct edit is refused, and that the two named ways
 * through work and leave the original readable.
 *
 * Own documents, own user. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "di-probe@example.invalid";
const PW = "DiProbe!2026";
const PERSON = "DI Probe Person";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  await prisma.document.deleteMany({ where: { person: PERSON } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "DI Probe", email: EMAIL, roleId: "pro_officer", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }
  const co = await prisma.company.findFirst({ select: { id: true } });

  const doc = await prisma.document.create({ data: {
    companyId: co!.id, person: PERSON, docType: "Work Permit", docNumber: "DI-1001",
    expiryDate: "2027-10-01", issueDate: "2026-10-01", issuingAuthority: "Qiwa", status: "valid", daysLeft: 400,
  } });

  // ── the edit the audit performed ───────────────────────────────────────────────────────────
  const direct = await call("PUT", `/api/documents/${doc.id}`, tok, { expiryDate: "2039-01-01" });
  console.log(`pushing an issued expiry to 2039 is refused: ${direct.status === 409 ? "YES" : "NO (" + direct.status + ")"}`);
  console.log(`  "${String(direct.body?.error ?? "").slice(0, 104)}"`);
  if (direct.status !== 409) fail("an issued government record was rewritten through the ordinary update");
  const untouched = await prisma.document.findUnique({ where: { id: doc.id }, select: { expiryDate: true } });
  if (untouched?.expiryDate !== "2027-10-01") fail("the expiry changed despite the refusal");

  // ── working data on the same row is NOT locked ─────────────────────────────────────────────
  const note = await call("PUT", `/api/documents/${doc.id}`, tok, { customData: { collected: "from the client" } });
  console.log(`...while ordinary fields still save:        ${note.status === 200 ? "YES" : "NO (" + note.status + ")"}`);
  if (note.status !== 200) fail("locking the government fields also froze the working data, which pushes people into keeping their own notes");

  // ── correcting a record that was always wrong ──────────────────────────────────────────────
  const noReason = await call("POST", `/api/documents/${doc.id}/correct`, tok, { docNumber: "DI-1002" });
  console.log(`\na correction without a reason is refused:   ${noReason.status === 400 ? "YES" : "NO (" + noReason.status + ")"}`);
  if (noReason.status !== 400) fail("a government record was corrected with no reason recorded");

  const fixed = await call("POST", `/api/documents/${doc.id}/correct`, tok, {
    docNumber: "DI-1002", reason: "transposed digits when it was first entered",
  });
  console.log(`a correction with one is applied:          ${fixed.status === 200 ? "YES" : "NO (" + fixed.status + ")"}`);
  const afterFix = await prisma.document.findUnique({ where: { id: doc.id }, select: { docNumber: true, history: true } });
  const h1: any[] = Array.isArray(afterFix?.history) ? (afterFix!.history as any[]) : [];
  console.log(`  number is now ${afterFix?.docNumber}, and the old one is still readable: ${h1.some(h => JSON.stringify(h).includes("DI-1001")) ? "YES" : "NO"}`);
  if (afterFix?.docNumber !== "DI-1002") fail("the correction did not apply");
  if (!h1.some(h => h.kind === "corrected" && h.reason)) fail("the correction left no reasoned history entry");
  if (!h1.some(h => JSON.stringify(h).includes("DI-1001"))) fail("the value it replaced is not recoverable, so the record is not append-only in any useful sense");

  // ── superseding: the replacement is created first, then the old row is marked ──────────────
  //
  // This route already existed and takes the replacement's id rather than creating it. That split is
  // the better one — creating the new document is ordinary work, and marking the old one replaced is
  // the act that needs an audit trail — so the probe follows the real contract rather than the one I
  // briefly wrote a second route for.
  const replacement = await prisma.document.create({ data: {
    companyId: co!.id, person: PERSON, docType: "Work Permit", docNumber: "DI-2001",
    expiryDate: "2029-10-01", issuingAuthority: "Qiwa", status: "valid", daysLeft: 1100,
  } });
  const sup = await call("POST", `/api/documents/${doc.id}/supersede`, tok, { replacedBy: replacement.id });
  console.log(`
marking a record superseded:               ${sup.status === 200 ? "YES" : "NO (" + sup.status + ")"}`);
  const oldRow = await prisma.document.findUnique({ where: { id: doc.id }, select: { supersededAt: true, supersededById: true, docNumber: true, expiryDate: true } });
  console.log(`  old row kept, not overwritten:           ${oldRow?.docNumber === "DI-1002" && oldRow?.expiryDate === "2027-10-01" ? "YES" : "NO"}`);
  if (oldRow?.docNumber !== "DI-1002" || oldRow?.expiryDate !== "2027-10-01") fail("superseding overwrote the record it was supposed to preserve");
  console.log(`  ...and points at its replacement:        ${oldRow?.supersededById === replacement.id ? "YES" : "NO"}`);
  if (!oldRow?.supersededAt) fail("the replaced record was not marked, so both look live");
  if (oldRow?.supersededById !== replacement.id) fail("the trail does not say what replaced it");

  // a replacement of the wrong type, or for somebody else, would make the trail lie
  const other = await prisma.document.create({ data: {
    companyId: co!.id, person: PERSON, docType: "Iqama", docNumber: "DI-9999", status: "valid", daysLeft: 10,
  } });
  const wrong = await call("POST", `/api/documents/${other.id}/supersede`, tok, { replacedBy: replacement.id });
  console.log(`  a Work Permit cannot replace an Iqama:   ${wrong.status === 400 ? "YES" : "NO (" + wrong.status + ")"}`);
  if (wrong.status !== 400) fail("a document was replaced by one of a different type");

  // and the superseded row must leave the deadline reports
  const live = await prisma.document.count({ where: { person: PERSON, docType: "Work Permit", supersededAt: null } });
  console.log(`  exactly one live Work Permit remains:    ${live === 1 ? "YES" : "NO (" + live + ")"}`);
  if (live !== 1) fail(`${live} live Work Permits for one person — renewal reminders would fire for both`);

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
