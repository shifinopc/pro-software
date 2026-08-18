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

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
