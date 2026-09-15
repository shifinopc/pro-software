/**
 * The document intake agent, everything except the model call.
 *
 * The reading itself is one Claude request and cannot be exercised without an API key. Everything
 * AROUND it is where a fast wrong entry becomes a caught one, so that is what this proves, using a
 * stand-in reader that returns a fixed reading:
 *
 *   1. The switch: with intake off, nothing is read and the reason is given.
 *   2. The checks: an Iqama is matched to its employee by ID; a wrong employee is flagged; a number
 *      already on somebody else is an error; a Hijri-only expiry is caught.
 *   3. Accepting: refused without an expiry; with the officer's correction it creates the document,
 *      records what the officer changed, retires the older Iqama, and fills only BLANK employee fields.
 *   4. The rest: a rejected suggestion cannot then be accepted; a failed reading is recorded as failed.
 *
 * Own client, employees, files and suggestions. Deletes everything it makes.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";
import { createSuggestion, acceptSuggestion, rejectSuggestion, setIntakeSettings, intakeStatus, IntakeError, type Extraction, type Extractor } from "../src/intake-agent.js";

const CLIENT = "ZS Intake Probe Client";
const OTHER = "ZS Intake Probe Other";
const PRIVATE = path.resolve(process.cwd(), "uploads-private");

let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);

async function sweep() {
  for (const n of [CLIENT, OTHER]) {
    const co = await prisma.company.findFirst({ where: { name: n } });
    if (!co) continue;
    const sugg = await prisma.documentSuggestion.findMany({ where: { companyId: co.id }, select: { fileAssetId: true } });
    for (const s of sugg) {
      const a = await prisma.fileAsset.findUnique({ where: { id: s.fileAssetId } });
      if (a) { try { fs.unlinkSync(path.join(PRIVATE, a.id + ".png")); } catch {} await prisma.fileAsset.delete({ where: { id: a.id } }).catch(() => {}); }
    }
    await prisma.documentSuggestion.deleteMany({ where: { companyId: co.id } });
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.fileAsset.deleteMany({ where: { name: { startsWith: "zs-intake-probe" } } });
}

/** A real private upload on disk, as /api/upload would leave it. */
async function upload() {
  const asset = await prisma.fileAsset.create({ data: { kind: "document", name: "zs-intake-probe.png", path: "", size: 8, private: true, at: new Date().toISOString() } as any });
  fs.mkdirSync(PRIVATE, { recursive: true });
  fs.writeFileSync(path.join(PRIVATE, asset.id + ".png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await prisma.fileAsset.update({ where: { id: asset.id }, data: { path: "/api/files/" + asset.id } });
  return asset.id;
}

const reading = (over: Partial<Extraction["fields"]>, type = "Iqama"): Extraction => ({
  documentType: type, isIdentityDocument: true,
  fields: { number: "2555555555", expiry: "2027-03-01", expiryHijri: null, issueDate: "2025-03-01", name: "RAHMAN MOHAMMED", nationality: "IN", dob: "1990-05-04", ...over },
  confidence: { number: "high", expiry: "high", expiryHijri: "none", issueDate: "medium", name: "high", nationality: "high", dob: "low" },
  notes: "",
});
const stub = (ex: Extraction): Extractor => async () => ex;
const codes = (s: any) => ((s.issues ?? []) as any[]).map(i => `${i.level}:${i.code}`);

async function main() {
  await sweep();
  const before = await intakeStatus();
  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA", cr: "7111111111" } as any });
  const other = await prisma.company.create({ data: { name: OTHER, country: "SA", cr: "7222222222" } as any });
  const rahman = await prisma.employee.create({ data: { name: "Mohammed Rahman", companyId: co.id, govId: "2555555555", nationality: null, dob: null, status: "valid" } as any });
  const sara = await prisma.employee.create({ data: { name: "Sara Ahmed", companyId: co.id, nationality: "SA", status: "valid" } as any });
  const elsewhere = await prisma.employee.create({ data: { name: "Someone Else", companyId: other.id, status: "valid" } as any });
  // an Iqama already on file for Rahman, to be retired when the new one is accepted
  const oldIqama = await prisma.document.create({ data: { companyId: co.id, employeeId: rahman.id, person: rahman.name, docType: "Iqama", docNumber: "2555555555", expiryDate: "2026-03-01", status: "overdue", daysLeft: -1 } as any });
  // a work permit number already held by somebody at another client
  await prisma.document.create({ data: { companyId: other.id, employeeId: elsewhere.id, person: elsewhere.name, docType: "Work Permit", docNumber: "WP-CLASH-1", expiryDate: "2027-01-01", status: "valid", daysLeft: 300 } as any });

  // ── 1. the switch ───────────────────────────────────────────────────────────────────────────
  console.log("1. with intake switched off, nothing is read");
  await setIntakeSettings({ enabled: false });
  try {
    await createSuggestion({ companyId: co.id, employeeId: null, fileAssetId: await upload(), actorId: null, privateDir: PRIVATE, extractor: stub(reading({})) });
    fail("a suggestion was created while intake was switched off");
  } catch (e: any) {
    if (e instanceof IntakeError && e.status === 409) ok(`refused: "${e.message}"`);
    else fail(`wrong refusal: ${e?.message}`);
  }
  const common = { companyId: co.id, actorId: null, privateDir: PRIVATE, ignoreSwitch: true };

  // ── 2. the checks ───────────────────────────────────────────────────────────────────────────
  console.log("\n2. what the checks catch");
  const s1 = await createSuggestion({ ...common, employeeId: null, fileAssetId: await upload(), extractor: stub(reading({})) });
  if (s1.employeeId !== rahman.id) fail(`the Iqama should match Mohammed Rahman by ID, matched ${s1.employeeId}`);
  else ok(`matched to Mohammed Rahman by ID number, no employee picked (${codes(s1).join(", ")})`);
  if (codes(s1).some(c => c.startsWith("error:"))) fail(`a clean Iqama raised errors: ${codes(s1)}`);
  else ok("no errors on a clean reading");
  if (!codes(s1).includes("info:low_dob")) fail("a low-confidence date of birth was not flagged");
  else ok("low-confidence date of birth flagged for checking");

  const s2 = await createSuggestion({ ...common, employeeId: sara.id, fileAssetId: await upload(), extractor: stub(reading({})) });
  if (!codes(s2).includes("warning:name_mismatch")) fail(`wrong employee not flagged: ${codes(s2)}`);
  else ok("choosing Sara for Rahman's Iqama raises a name mismatch");
  if (!codes(s2).includes("warning:nationality_mismatch")) fail("nationality mismatch not flagged");
  else ok("and a nationality mismatch (IN on the card, SA on Sara's record)");

  const s3 = await createSuggestion({ ...common, employeeId: sara.id, fileAssetId: await upload(), extractor: stub(reading({ number: "WP-CLASH-1", name: "Sara Ahmed", nationality: "SA" }, "Work Permit")) });
  if (!codes(s3).includes("error:duplicate_number")) fail(`a number held by another client's employee was not caught: ${codes(s3)}`);
  else ok("a work permit number already held by someone at another client is an error");

  const s4 = await createSuggestion({ ...common, employeeId: rahman.id, fileAssetId: await upload(), extractor: stub(reading({ expiry: null, expiryHijri: "1448/09/12" })) });
  if (!codes(s4).includes("warning:no_expiry")) fail(`a Hijri-only expiry was not caught: ${codes(s4)}`);
  else ok("a Hijri-only expiry is caught, and the Hijri date is shown to the officer");

  const s5 = await createSuggestion({ ...common, employeeId: null, fileAssetId: await upload(), extractor: stub(reading({}, "Library Card")) });
  if (!codes(s5).includes("error:unknown_type")) fail(`an untracked document type was not caught: ${codes(s5)}`);
  else ok("a document type the firm does not track is an error");

  // ── 3. accepting ────────────────────────────────────────────────────────────────────────────
  console.log("\n3. accepting");
  try { await acceptSuggestion(s4.id, { actorId: null }); fail("accepted an Iqama with no expiry"); }
  catch (e: any) { e instanceof IntakeError ? ok(`refused without an expiry: "${e.message}"`) : fail(e?.message); }

  const acc = await acceptSuggestion(s4.id, { actorId: null, expiry: "2027-03-02" });
  const doc = await prisma.document.findUnique({ where: { id: acc.document.id } });
  if (!doc || doc.expiryDate !== "2027-03-02" || doc.employeeId !== rahman.id) fail(`document not created as corrected: ${JSON.stringify(doc)}`);
  else ok(`created Iqama ${doc.docNumber} for ${doc.person}, expiring ${doc.expiryDate}`);
  if (!acc.changed.expiry || acc.changed.expiry.accepted !== "2027-03-02") fail(`the officer's correction was not recorded: ${JSON.stringify(acc.changed)}`);
  else ok("the officer's correction to the expiry is recorded against the reading");
  if (String((doc?.customData as any)?.filePath ?? "") !== `/api/files/${s4.fileAssetId}`) fail("the scan is not attached to the document");
  else ok("the scan is attached, behind the private file route");
  const retired = await prisma.document.findUnique({ where: { id: oldIqama.id } });
  if (!retired?.supersededAt || retired.supersededById !== doc!.id) fail("the older Iqama was not retired");
  else ok("the older Iqama was retired and kept as history, pointing at its replacement");
  const emp = await prisma.employee.findUnique({ where: { id: rahman.id } });
  if (emp?.nationality !== "IN" || emp?.dob !== "1990-05-04" || emp?.govId !== "2555555555") fail(`blank fields not filled, or ID overwritten: ${JSON.stringify(emp)}`);
  else ok("blank nationality and date of birth filled from the card; the existing ID left alone");

  const live = await prisma.document.count({ where: { employeeId: rahman.id, docType: "Iqama", supersededAt: null } });
  if (live !== 1) fail(`Rahman has ${live} live Iqamas, expected exactly 1`);
  else ok("exactly one live Iqama for Rahman");

  // ── 4. the rest ─────────────────────────────────────────────────────────────────────────────
  console.log("\n4. decisions stick, and failures are recorded");
  await rejectSuggestion(s2.id, null, "wrong person selected");
  try { await acceptSuggestion(s2.id, { actorId: null }); fail("accepted a rejected suggestion"); }
  catch (e: any) { e instanceof IntakeError && e.status === 409 ? ok("a rejected suggestion cannot then be accepted") : fail(e?.message); }
  try { await acceptSuggestion(s4.id, { actorId: null, expiry: "2027-03-02" }); fail("accepted the same suggestion twice"); }
  catch (e: any) { e instanceof IntakeError && e.status === 409 ? ok("an accepted suggestion cannot be accepted twice") : fail(e?.message); }

  const boom: Extractor = async () => { throw new IntakeError("The document reader is busy. Try again in a minute.", 503); };
  try { await createSuggestion({ ...common, employeeId: null, fileAssetId: await upload(), extractor: boom }); fail("a failed reading did not throw"); } catch {}
  const failed = await prisma.documentSuggestion.count({ where: { companyId: co.id, status: "failed" } });
  if (failed !== 1) fail(`expected 1 failed suggestion on record, found ${failed}`);
  else ok("a failed reading is recorded as failed, with the reason");

  // ── 5. no model: the built-in passport reader ───────────────────────────────────────────────
  console.log("\n5. with no model, a passport is read by the built-in reader");
  const passportAsset = await prisma.fileAsset.create({ data: { kind: "document", name: "zs-intake-probe-passport.png", path: "", size: 0, private: true, at: new Date().toISOString() } as any });
  fs.copyFileSync(path.resolve(process.cwd(), "scripts/fixtures/synthetic-passport.png"), path.join(PRIVATE, passportAsset.id + ".png"));
  // On file as "Ravi Shankar": the MRZ name has no check digit and OCR may garble a middle name.
  const ravi = await prisma.employee.create({ data: { name: "Ravi Shankar", companyId: co.id, nationality: "IN", status: "valid" } as any });
  const sp = await createSuggestion({ ...common, employeeId: null, fileAssetId: passportAsset.id, model: null });
  const spf = (sp.fields ?? {}) as any;
  sp.status === "pending" && sp.docType === "Passport" && spf.number === "Z8841207" && spf.expiry === "2031-03-11" && sp.model === "builtin:mrz"
    ? ok(`read passport ${spf.number}, expiring ${spf.expiry}, with no model (${sp.model})`) : fail(`built-in reading: ${JSON.stringify({ status: sp.status, docType: sp.docType, fields: spf, model: sp.model, error: sp.error })}`);
  sp.employeeId === ravi.id ? ok("matched to Ravi Shankar by name") : fail(`employee match: ${sp.employeeId}`);
  const notPassport = await upload();
  try {
    await createSuggestion({ ...common, employeeId: null, fileAssetId: notPassport, model: null });
    fail("a non-passport was read with no model");
  } catch (e: any) {
    e instanceof IntakeError && /need a model/.test(e.message) ? ok(`anything else, with no model, is refused: "${e.message}"`) : fail(`wrong refusal: ${e?.message}`);
  }
  // A damaged image that claims to be a PNG must be refused, not crash the server.
  const broken = await prisma.fileAsset.create({ data: { kind: "document", name: "zs-intake-probe-broken.png", path: "", size: 0, private: true, at: new Date().toISOString() } as any });
  fs.writeFileSync(path.join(PRIVATE, broken.id + ".png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]));
  try {
    await createSuggestion({ ...common, employeeId: null, fileAssetId: broken.id, model: null });
    fail("a damaged image was read");
  } catch (e: any) {
    e instanceof IntakeError ? ok(`a damaged image is refused without crashing: "${e.message.split(".")[0]}."`) : fail(`damaged image: ${e?.message}`);
  }
  for (const id of [passportAsset.id, broken.id]) { try { fs.unlinkSync(path.join(PRIVATE, id + ".png")); } catch {} }

  await setIntakeSettings({ enabled: before.enabled, model: before.modelChosen });
  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
