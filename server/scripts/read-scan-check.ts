/**
 * SELF-CHECK FOR readScan — the reading behind the Add-client documents step.
 *
 *   npx tsx scripts/read-scan-check.ts
 *
 * The reading itself is stubbed, which is the point: what is checked here is everything AROUND the
 * model — the switch, the file types, and the match from the name a model reads to a document type
 * this system actually has. Those are the parts that decide whether a scan ends up on the right
 * record, and they must not depend on a model being connected to be tested.
 *
 * Touches no client data: it flips the intake switch, puts it back, and writes nothing else.
 */
import { prisma } from "../src/db.js";
import { readScan, IntakeError, type Extraction } from "../src/intake-agent.js";

const host = String(process.env.DATABASE_URL ?? "").split("@")[1] ?? "";
if (!/^(localhost|127\.0\.0\.1)/.test(host)) { console.error("Refusing to run: DATABASE_URL is not local."); process.exit(2); }

let pass = 0; const fails: string[] = [];
const ok = (what: string, cond: boolean, got?: unknown) => { if (cond) { pass++; console.log(`  ok   ${what}`); } else { fails.push(what); console.log(`  FAIL ${what}${got === undefined ? "" : `  — got ${JSON.stringify(got)}`}`); } };

const reading = (over: Partial<Extraction["fields"]> & { documentType?: string | null }): Extraction => ({
  documentType: over.documentType === undefined ? "Commercial Registration" : over.documentType,
  isIdentityDocument: false,
  fields: { number: null, expiry: null, expiryHijri: null, issueDate: null, name: null, nationality: null, dob: null, ...over },
  confidence: { number: "high", expiry: "medium", expiryHijri: "none", issueDate: "high", name: "none", nationality: "none", dob: "none" },
  notes: "",
});
const stub = (ex: Extraction) => async () => ex;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const read = (fileName: string, ex: Extraction) => readScan({ data: PNG, fileName, extractor: stub(ex) as any, model: "stub-model" });

// The switch: whatever it was, it is restored at the end.
const before = await prisma.appSetting.findUnique({ where: { key: "intakeAgent" } });
const setSwitch = (enabled: boolean) => prisma.appSetting.upsert({
  where: { key: "intakeAgent" }, create: { key: "intakeAgent", value: { enabled } },
  update: { value: { ...((before?.value ?? {}) as object), enabled } },
});

try {
  console.log("the switch");
  await setSwitch(false);
  await read("cr.png", reading({})).then(() => ok("refuses to read while intake is off", false), e => ok("refuses to read while intake is off", e instanceof IntakeError && e.status === 409));
  await setSwitch(true);

  console.log("\nfile types");
  for (const name of ["cr.pdf", "cr.png", "cr.jpg", "cr.jpeg", "cr.webp"]) {
    await read(name, reading({})).then(() => ok(`accepts ${name}`, true), e => ok(`accepts ${name}`, false, e.message));
  }
  for (const name of ["cr.svg", "cr.docx", "cr"]) {
    await read(name, reading({})).then(() => ok(`refuses ${name}`, false), e => ok(`refuses ${name}`, e instanceof IntakeError && e.status === 400));
  }

  console.log("\nmatching what was read to a type we have");
  let r = await read("cr.png", reading({ documentType: "Commercial Registration", number: "1010123456", expiry: "2027-01-31", issueDate: "2024-01-31" }));
  ok("matches an exact type name", r.docType === "Commercial Registration", r.docType);
  ok("says it is a company document", r.subjectKind === "company", r.subjectKind);
  ok("carries the type's authority", r.authority === "MC", r.authority);
  ok("passes the number through", r.fields.number === "1010123456", r.fields.number);
  ok("passes the dates through", r.fields.expiry === "2027-01-31" && r.fields.issueDate === "2024-01-31");
  ok("reports the confidence per field", r.confidence.number === "high" && r.confidence.expiry === "medium");

  r = await read("cr.png", reading({ documentType: "CR" }));
  ok("matches through the alias table (CR)", r.docType === "Commercial Registration", r.docType);

  // An Iqama read on the company-documents step: reported, and the subject says whose paper it is,
  // so the form can decline to file a person's document against a company.
  r = await read("iq.png", reading({ documentType: "Iqama", number: "2412345678" }));
  ok("an employee document is marked as one", r.subjectKind === "employee", r.subjectKind);

  r = await read("x.png", reading({ documentType: "Pizza menu", number: "7" }));
  ok("an unknown type matches nothing", r.docType === null, r.docType);
  ok("...but still says what it read", r.read === "Pizza menu", r.read);
  ok("...and still returns its fields", r.fields.number === "7", r.fields.number);

  r = await read("x.png", reading({ documentType: null }));
  ok("not a document at all", r.docType === null && r.read === null);

  // A Hijri-only expiry is reported as printed and never converted here.
  r = await read("cr.png", reading({ expiry: null, expiryHijri: "1447-06-15" }));
  ok("a Hijri date is passed through unconverted", r.fields.expiryHijri === "1447-06-15" && r.fields.expiry === null);
} finally {
  if (before) await prisma.appSetting.update({ where: { key: "intakeAgent" }, data: { value: before.value as any } });
  else await prisma.appSetting.delete({ where: { key: "intakeAgent" } }).catch(() => {});
  await prisma.$disconnect();
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
