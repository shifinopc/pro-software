/**
 * Throwaway check: the exporter refuses what must not travel, and keeps what identity depends on.
 *
 * WHY A FIXTURE COUNTRY. Exporting Saudi Arabia and reading the numbers proves the SA pack is right
 * today; it proves nothing about the rules. So this builds a small country of its own — ZZ — where
 * every row exists to make one assertion fail if the rule is missing, and runs the REAL exporter as
 * a subprocess against it. Nothing here re-implements the exporter, so nothing here can agree with
 * a bug in it.
 *
 * THE FIXTURES ARE ARRANGED SO A WRONG ANSWER CANNOT PASS:
 *   · the retired row has a name nothing else shares, so "absent" cannot mean "matched something else"
 *   · the renamed row's packKey and its name-derived key are DIFFERENT strings, so preserving and
 *     deriving produce visibly different output — a test where they coincide proves nothing
 *   · "DEMO — Long Enough To Pass The Length Guard" is 42 characters, which is exactly the case the
 *     old rule let through; "New Qanat Employment Visa" is the false positive the rule must NOT catch,
 *     so a lazy "drop anything containing demo or new" also fails
 *   · the service points at a workflow that --clean removes, so a dangling reference has somewhere
 *     to come from
 *
 * Own country code, own rows, own output file. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ZZ = "ZZ";
const KINDS = ["documentType", "workflowTemplate", "serviceItem", "govCenter", "package",
  "checklistRule", "workforceBand", "pipelineStage", "leadSource", "lostReason"] as const;

async function sweep() {
  for (const k of KINDS) await (prisma as any)[k].deleteMany({ where: { country: ZZ } });
}

/** Run the real exporter. Never throws on a non-zero exit — a refusal IS one of the things tested. */
function runExport(out: string, ...extra: string[]) {
  try {
    const stdout = execFileSync("npx", ["tsx", "scripts/export-country-pack.ts", "--country", ZZ, "--version", "9.9", "--out", out, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  const dir = mkdtempSync(join(tmpdir(), "zzpack-"));

  try {
    await sweep();

    // ── the fixture country ───────────────────────────────────────────────────────────────────────
    await prisma.documentType.createMany({ data: [
      // One prerequisite resolves and one does not. A check that reported both, or neither, still
      // passes a test that only greps for the broken one — so the assertion below counts them.
      { country: ZZ, name: "Qanat Passport", packKey: "zz.doctype.qanat-passport",
        prereqs: [{ minMonths: 6, requiresDocType: "Qanat Work Permit" }, { minMonths: 1, requiresDocType: "Qanat Nowhere Prereq" }] },
      // Retired. If this travels, retiring something and exporting silently undoes the retirement.
      { country: ZZ, name: "Qanat Retired Card", packKey: "zz.doctype.qanat-retired-card", retired: true },
      // Renamed after install: the key says visa-permit, the name now says Work Permit. Deriving from
      // the name would mint zz.doctype.qanat-work-permit and the far end would gain a SECOND row.
      { country: ZZ, name: "Qanat Work Permit", packKey: "zz.doctype.qanat-visa-permit" },
      // Filed under this country but carrying another country's namespace.
      { country: ZZ, name: "Qanat Borrowed", packKey: "sa.doctype.qanat-borrowed" },
    ] });
    await prisma.govCenter.create({ data: { country: ZZ, name: "Qanat Authority", packKey: "zz.center.qanat-authority" } });
    await prisma.workflowTemplate.createMany({ data: [
      { country: ZZ, name: "Qanat Real Flow", packKey: "zz.workflow.qanat-real-flow",
        // The TRIGGER names a document type as well as the steps do, and checking only the steps
        // missed it: a renewal that can never fire, and never says why.
        trigger: "document_expiry", triggerConfig: { docType: "Qanat Nowhere Trigger" },
        graph: { nodes: [
          { id: "n1", label: "Issue", config: { docType: "Qanat Passport", govCenter: "Qanat Authority" } },
          // Names something that is not in this country — must be reported, not shipped in silence.
          { id: "n2", label: "Stamp", config: { docType: "Qanat Nowhere Doc" } },
        ] } },
      // 42 characters. The old length<14 guard let this straight through.
      { country: ZZ, name: "DEMO — Long Enough To Pass The Length Guard", packKey: "zz.workflow.demo-long" },
    ] });
    const real = await prisma.workflowTemplate.findFirstOrThrow({ where: { country: ZZ, name: "Qanat Real Flow" } });
    const demo = await prisma.workflowTemplate.findFirstOrThrow({ where: { country: ZZ, name: { startsWith: "DEMO" } } });
    await prisma.serviceItem.createMany({ data: [
      // Must survive --clean: it starts with "New", which a blunt rule would drop.
      { country: ZZ, name: "New Qanat Employment Visa", packKey: "zz.service.new-zz-employment-visa", workflowId: real.id, docType: "Qanat Passport" },
      // Points at the template --clean removes.
      { country: ZZ, name: "Qanat Orphaned Service", packKey: "zz.service.qanat-orphaned-service", workflowId: demo.id },
    ] });
    await prisma.checklistRule.create({ data: { country: ZZ, name: "Qanat Checklist", packKey: "zz.checklist.qanat-checklist" } });
    await prisma.workforceBand.create({ data: { country: ZZ, name: "Qanat Band", minBp: 0, packKey: "zz.band.qanat-band" } });
    await prisma.pipelineStage.create({ data: { country: ZZ, name: "Qanat Stage" } });
    await prisma.leadSource.create({ data: { country: ZZ, name: "Qanat Source" } });
    await prisma.lostReason.create({ data: { country: ZZ, name: "Qanat Reason" } });

    // ── a kind the installer expects is missing → refuse, do not write ────────────────────────────
    const outA = join(dir, "a.json");
    const a = runExport(outA);
    console.log(`a missing kind refuses to write:        ${a.code !== 0 && !existsSync(outA) ? "YES" : "NO"}`);
    if (a.code === 0 || existsSync(outA)) fail("a pack with no packages was written — the far end installs a country that half works");
    console.log(`  …and names what is missing:           ${/packages/.test(a.stdout) ? "YES" : "NO"}`);
    if (!/packages/.test(a.stdout)) fail("the refusal did not say which kind was empty");

    // --allow-empty is the deliberate override, and it must still be written down.
    const outB = join(dir, "b.json");
    const b = runExport(outB, "--allow-empty");
    console.log(`  --allow-empty writes, but says so:    ${b.code === 0 && existsSync(outB) && /allow-empty/.test(b.stdout) ? "YES" : "NO"}`);
    if (!existsSync(outB)) fail("--allow-empty did not write the file");

    await prisma.package.create({ data: { country: ZZ, name: "Qanat Package", tier: "zz", basePrice: 1, empMin: 1, empMax: 9, features: [], packKey: "zz.package.qanat-package" } });

    // ── the real export ───────────────────────────────────────────────────────────────────────────
    const outC = join(dir, "c.json");
    const c = runExport(outC, "--clean");
    if (c.code !== 0) { fail("the export refused with every kind present: " + c.stdout.slice(-400)); throw new Error("cannot continue"); }
    const pack = JSON.parse(readFileSync(outC, "utf8"));
    const names = (k: string) => (pack[k] ?? []).map((r: any) => r.name);
    const keyOf = (k: string, name: string) => (pack[k] ?? []).find((r: any) => r.name === name)?.key;

    console.log(`\na retired row does not travel:           ${!names("documentTypes").includes("Qanat Retired Card") ? "YES" : "NO"}`);
    if (names("documentTypes").includes("Qanat Retired Card")) fail("a retired document type is in the pack — installing it would bring it back to life");

    console.log(`\na renamed row keeps its original key:    ${keyOf("documentTypes", "Qanat Work Permit") === "zz.doctype.qanat-visa-permit" ? "YES" : "NO (" + keyOf("documentTypes", "Qanat Work Permit") + ")"}`);
    if (keyOf("documentTypes", "Qanat Work Permit") !== "zz.doctype.qanat-visa-permit") fail("the key was re-derived from the new name — the next upgrade would add a duplicate instead of upgrading");

    console.log(`  a foreign-prefixed key is re-derived:  ${keyOf("documentTypes", "Qanat Borrowed") === "zz.doctype.qanat-borrowed" ? "YES" : "NO (" + keyOf("documentTypes", "Qanat Borrowed") + ")"}`);
    if (keyOf("documentTypes", "Qanat Borrowed") !== "zz.doctype.qanat-borrowed") fail("an SA-namespaced key travelled inside a ZZ pack — the two packs would fight over one row");
    console.log(`  …and both changes are reported:        ${/qanat-visa-permit/.test(c.stdout) && /another country/.test(c.stdout) ? "YES" : "NO"}`);

    console.log(`\n--clean drops a long DEMO name:          ${!names("workflowTemplates").some((n: string) => n.startsWith("DEMO")) ? "YES" : "NO"}`);
    if (names("workflowTemplates").some((n: string) => n.startsWith("DEMO"))) fail("a DEMO template shipped — the length guard is still swallowing it");
    console.log(`  …and keeps "New Qanat Employment Visa":   ${names("serviceItems").includes("New Qanat Employment Visa") ? "YES" : "NO"}`);
    if (!names("serviceItems").includes("New Qanat Employment Visa")) fail("a real row starting with \"New\" was dropped — the rule is too blunt to trust");

    // ── a reference to something --clean removed ──────────────────────────────────────────────────
    const orphan = (pack.serviceItems ?? []).find((s: any) => s.name === "Qanat Orphaned Service");
    console.log(`\na service losing its workflow gets null: ${orphan?.workflowKey === null ? "YES" : "NO (" + JSON.stringify(orphan?.workflowKey) + ")"}`);
    if (orphan?.workflowKey) fail("the service kept a key for a workflow this pack does not contain — it resolves to nothing on install");
    console.log(`  …and the loss is reported:            ${/Qanat Orphaned Service/.test(c.stdout) ? "YES" : "NO"}`);
    if (!/Qanat Orphaned Service/.test(c.stdout)) fail("a reference was dropped without saying so");

    console.log(`\na step's document type is checked:       ${/Qanat Nowhere Doc/.test(c.stdout) ? "YES" : "NO"}`);
    if (!/Qanat Nowhere Doc/.test(c.stdout)) fail("a step naming a document type that is not in the pack shipped unremarked");
    console.log(`  a TRIGGER's document type too:        ${/Qanat Nowhere Trigger/.test(c.stdout) ? "YES" : "NO"}`);
    if (!/Qanat Nowhere Trigger/.test(c.stdout)) fail("a workflow triggering on a document type nothing creates shipped unremarked — it can never fire");
    console.log(`  and a PREREQUISITE's:                 ${/Qanat Nowhere Prereq/.test(c.stdout) ? "YES" : "NO"}`);
    if (!/Qanat Nowhere Prereq/.test(c.stdout)) fail("a prerequisite pointing at nothing shipped unremarked — it never blocks, so it reads as satisfied");
    // Exactly three, out of six references of which three DO resolve. Counting is what separates a
    // working check from one that flags everything; grepping for the broken names cannot tell them
    // apart, and neither can a check that is silently not running at all.
    const flagged = Number(/⚠ (\d+) references? name something/.exec(c.stdout)?.[1] ?? -1);
    console.log(`  exactly the 3 broken ones, no more:   ${flagged === 3 ? "YES" : "NO (" + flagged + ")"}`);
    if (flagged !== 3) fail("the reference check reported " + flagged + " of 3 — it is missing sites, or flagging references that do resolve");

    // ── nothing about anybody's clients ───────────────────────────────────────────────────────────
    const blob = readFileSync(outC, "utf8");
    const leaked = ["companies", "employees", "documents", "invoices", "users", "credentials"].filter(k => Array.isArray(pack[k]) && pack[k].length);
    console.log(`\nno client data of any kind:              ${leaked.length === 0 ? "YES" : "NO (" + leaked.join(", ") + ")"}`);
    if (leaked.length) fail("the pack carries " + leaked.join(", "));
    console.log(`  no cuid survived as a reference:       ${!/"[a-z0-9]{25}"/.test(blob.replace(/"(graph|rows|features|fields|prereqs)":/g, '"_":')) ? "YES" : "NO"}`);

  } finally {
    await sweep();
    rmSync(dir, { recursive: true, force: true });
    for (const f of ["packs/pack-zz-9.9.json"]) if (existsSync(f)) unlinkSync(f);
  }

  let left = 0;
  for (const k of KINDS) left += await (prisma as any)[k].count({ where: { country: ZZ } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
