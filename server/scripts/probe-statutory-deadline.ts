/**
 * Throwaway check that a statutory deadline is recorded separately from the reminder window.
 *
 * `leadDays` is when Compliance starts nagging — `daysLeft <= leadDays → expiring`. It has never been
 * a legal deadline, but it was the only number on the screen and it was labelled "Lead days", so an
 * external reviewer read "Iqama · 60" as "the law allows 60 days" and wrote it up as a compliance
 * defect. The number was right; the label invited the wrong conclusion.
 *
 * So the reminder now says what it is, and a deadline has somewhere of its own to live — with the
 * source it came from, because a deadline the platform invented is worse than no deadline at all.
 *
 * Own document type. Deletes it afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "sd-probe@example.invalid";
const PW = "SdProbe!2026";
const NAME = "ZS Probe Type";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  await prisma.documentType.deleteMany({ where: { name: NAME } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "SD Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  // ── a type with a reminder and no deadline, which is the honest default ────────────────────
  const made = await call("POST", "/api/document-types", tok, { name: NAME, subjectKind: "employee", country: "ZS", leadDays: 60 });
  const id = made.body?.id;
  if (!id) { fail("could not create the probe type: " + JSON.stringify(made.body)); await sweep(); process.exit(1); }
  const bare = await prisma.documentType.findUnique({ where: { id } });
  console.log(`a reminder window alone implies no deadline: ${bare?.statutoryDays === null ? "YES" : "NO (" + bare?.statutoryDays + ")"}`);
  if (bare?.statutoryDays !== null) fail("a deadline appeared without anybody entering one");
  console.log(`  leadDays kept its meaning:                 ${bare?.leadDays === 60 ? "YES (60 days before expiry)" : "NO"}`);
  if (bare?.leadDays !== 60) fail("the reminder window did not survive");

  // ── recording one, with its source ─────────────────────────────────────────────────────────
  await call("PUT", `/api/document-types/${id}`, tok, {
    statutoryDays: 90, statutoryFrom: "entry to the Kingdom", statutoryBasis: "MHRSD work permit service page",
  });
  const withDl = await prisma.documentType.findUnique({ where: { id } });
  console.log(`\na deadline is stored with its source:       ${withDl?.statutoryDays === 90 && withDl?.statutoryFrom && withDl?.statutoryBasis ? "YES" : "NO"}`);
  console.log(`  "${withDl?.statutoryDays} days from ${withDl?.statutoryFrom}" — ${withDl?.statutoryBasis}`);
  if (withDl?.statutoryDays !== 90) fail("the deadline was not stored");
  if (!withDl?.statutoryFrom) fail("stored a number of days with no event to count from, which cannot be resolved to a date");
  if (!withDl?.statutoryBasis) fail("stored a deadline with no source, which is the thing this exists to prevent");
  console.log(`  it did NOT overwrite the reminder:         ${withDl?.leadDays === 60 ? "YES" : "NO"}`);
  if (withDl?.leadDays !== 60) fail("recording a deadline changed the reminder window — they are one field again");

  // ── clearing it must mean "not recorded", not "zero days" ──────────────────────────────────
  await call("PUT", `/api/document-types/${id}`, tok, { statutoryDays: null, statutoryFrom: null, statutoryBasis: null });
  const cleared = await prisma.documentType.findUnique({ where: { id } });
  console.log(`\nclearing it means unknown, not zero:        ${cleared?.statutoryDays === null ? "YES" : "NO (" + cleared?.statutoryDays + ")"}`);
  if (cleared?.statutoryDays !== null) fail(`cleared to ${cleared?.statutoryDays} — a deadline of zero days is a different claim from no deadline`);

  // ── and it travels, or a new market silently loses it ──────────────────────────────────────
  const { buildPack } = await import("../src/packs.js");
  await call("PUT", `/api/document-types/${id}`, tok, { statutoryDays: 15, statutoryFrom: "employment start", statutoryBasis: "GOSI FAQ" });
  const built = await buildPack("ZS", { version: "1.0", allowEmpty: true } as any).catch(() => null);
  const row = (built?.pack as any)?.documentTypes?.find((d: any) => d.name === NAME);
  console.log(`\nthe deadline travels in a pack:             ${row?.statutoryDays === 15 ? "YES" : "NO (" + JSON.stringify(row?.statutoryDays) + ")"}`);
  if (row?.statutoryDays !== 15) fail("a pack drops the deadline, so a new installation would start again with none");
  if (row?.statutoryBasis !== "GOSI FAQ") fail("the source did not travel, leaving a bare number nobody can check");

  // A RECORD THAT CANNOT EXPIRE IS NOT OVERDUE.
  //
  // Removing a dangling expiryVar left GOSI registrations with no expiry date, and the SLA Monitor
  // read the missing date as due today: seven sat in the at-risk column at "0d left" with an Escalate
  // button beside them. The records were fine — nothing could say they had no deadline, so "no
  // expiry" and "nobody has entered one yet" were the same null.
  const { recomputeCompliance } = await import("../src/scheduler.js");
  await prisma.documentType.update({ where: { id }, data: { neverExpires: true } });
  const co = await prisma.company.findFirst({ select: { id: true } });
  const permDoc = await prisma.document.create({ data: {
    companyId: co!.id, person: "ZS Probe Person", docType: NAME,
    expiryDate: null, status: "unknown", daysLeft: 0,
  } });
  await recomputeCompliance();
  const perm = await prisma.document.findUnique({ where: { id: permDoc.id }, select: { status: true } });
  console.log("");
  console.log(`a non-expiring record is valid, not unknown: ${perm?.status === "valid" ? "YES" : "NO (" + perm?.status + ")"}`);
  if (perm?.status !== "valid") fail("a record that cannot expire is still reported as unknown, so it stays in the deadline reports");

  // The SLA Monitor's own rule, applied here so the screen and this check cannot drift apart.
  const rows = (await prisma.document.findMany({ where: { supersededAt: null }, select: { docType: true, status: true, daysLeft: true, expiryDate: true } }))
    .filter(d => d.expiryDate && (d.status !== "valid" || (Number(d.daysLeft) || 99) <= 30));
  console.log(`...and nothing without an expiry is shown:  ${rows.every(r => r.expiryDate) ? "YES" : "NO"}`);
  if (rows.some(r => !r.expiryDate)) fail("a document with no expiry date is still shown against a deadline");
  if (rows.some(r => r.docType === NAME)) fail("the non-expiring type is still in the deadline report");
  await prisma.document.delete({ where: { id: permDoc.id } });

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
