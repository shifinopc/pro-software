/**
 * A client with a main CR and sub CRs.
 *
 *   1. A client's CR becomes its main CR; a sub CR is added; the same CR twice, or a CR another client
 *      holds, is refused; placeholder CRs ("—") are not CRs.
 *   2. Two company certificates of the same type — main CR and sub CR — are BOTH live: issuing a new
 *      one for the sub CR supersedes only the sub CR's old one.
 *   3. The employee import reads a CR column: rows go under the CR they name, blank is the main CR for
 *      new people and unchanged for people on file, an unknown CR refuses the row in the preview.
 *   4. A sub CR with active employees cannot be cancelled; making a sub CR the main one keeps everybody
 *      on the CR they were on; Company.cr follows the main CR.
 *
 * Everything the probe creates is removed.
 */
import { prisma } from "../src/db.js";
import { createEstablishment, updateEstablishment, listEstablishments, ensureMainEstablishments, syncMainFromCompany, resolveEstablishmentId, isRealCr, crLabel } from "../src/establishments.js";
import { supersedePriorLive } from "../src/docnumber.js";
import { planEmployeeImport, applyEmployeeImport } from "../src/employee-import.js";

const TAG = "ZS CR Probe";
let bad = 0;
const ok = (m: string) => console.log(`   ok    ${m}`);
const expect = (c: unknown, m: string) => { if (c) ok(m); else { bad++; console.log(`   FAIL  ${m}`); } };
const refuses = async (f: () => Promise<unknown>, re: RegExp, m: string) => {
  try { await f(); expect(false, `${m} (was accepted)`); } catch (e: any) { expect(re.test(String(e?.message)), `${m} — “${e?.message}”`); }
};

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  await prisma.document.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.employee.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.establishment.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await sweep();
  console.log("\n1. CRs");
  const a = await prisma.company.create({ data: { name: `${TAG} Trading`, cr: "1010900001", lifecycle: "client", city: "Riyadh" } });
  const other = await prisma.company.create({ data: { name: `${TAG} Other`, cr: "—", lifecycle: "client" } });
  await ensureMainEstablishments();
  let list = await listEstablishments(a.id);
  expect(list.length === 1 && list[0].kind === "main" && list[0].crNumber === "1010900001", "the client's CR became its main CR");
  expect((await listEstablishments(other.id)).length === 0 && !isRealCr("—") && !isRealCr("0000000"), "a placeholder CR is not turned into a CR");
  const jed = await createEstablishment(a.id, { crNumber: "4030 900 002", city: "Jeddah", name: `${TAG} Trading — Jeddah` });
  const dmm = await createEstablishment(a.id, { crNumber: "2050900003", city: "Dammam" });
  expect(jed.kind === "branch" && jed.crNumber === "4030900002", "a sub CR is added as a branch, spaces removed");
  await refuses(() => createEstablishment(a.id, { crNumber: "4030900002" }), /already on this client/, "the same CR twice is refused");
  await createEstablishment(other.id, { crNumber: "7000900009" });
  await refuses(() => createEstablishment(a.id, { crNumber: "7000900009" }), /another client/, "a CR another client holds is refused");
  await refuses(() => resolveEstablishmentId(other.id, jed.id), /does not belong/, "an employee cannot be put under another client's CR");
  expect(crLabel(jed) === "Jeddah (4030900002)", "a sub CR is labelled by its city and number");

  console.log("\n2. Certificates per CR");
  const mainCert = await prisma.document.create({ data: { companyId: a.id, person: a.name, docType: "CR", docNumber: "1010900001", expiryDate: "2027-01-01" } });
  const jedOld = await prisma.document.create({ data: { companyId: a.id, person: a.name, docType: "CR", docNumber: "4030900002", expiryDate: "2026-10-01", establishmentId: jed.id } });
  const jedNew = await prisma.document.create({ data: { companyId: a.id, person: a.name, docType: "CR", docNumber: "4030900002", expiryDate: "2027-10-01", establishmentId: jed.id } });
  const replaced = await supersedePriorLive(jedNew, "probe");
  const live = await prisma.document.findMany({ where: { companyId: a.id, docType: "CR", supersededAt: null }, select: { id: true } });
  expect(replaced === 1 && live.some(d => d.id === mainCert.id) && live.some(d => d.id === jedNew.id) && !live.some(d => d.id === jedOld.id), "renewing the Jeddah CR replaces only Jeddah's old certificate — the main CR's stays live");
  const dmmCert = await prisma.document.create({ data: { companyId: a.id, person: a.name, docType: "CR", docNumber: "2050900003", expiryDate: "2027-03-01", establishmentId: dmm.id } });
  expect((await supersedePriorLive(dmmCert, "probe")) === 0, "adding Dammam's certificate replaces nothing");

  console.log("\n3. Import with a CR column");
  const existing = await prisma.employee.create({ data: { companyId: a.id, name: "OLD HAND KHAN", govId: "2330000001", nationality: "PK" } });
  const csv = [
    "full_name,nationality,gov_id,CR Number,iqama_expiry",
    "AHMED ALI,Saudi,1100000001,,01/05/2027",
    "RAVI NAIR,India,2330000002,4030900002,01/06/2027",
    "SARA MOHAMMED,SA,1100000003,4030-900-002,01/07/2027",
    "JOHN DOE,Philippines,2330000004,9999999999,01/08/2027",
    "OLD HAND KHAN,Pakistan,2330000001,,01/09/2027",
  ].join("\n");
  const plan = await planEmployeeImport(a.id, csv);
  expect(plan.refused.length === 1 && /9999999999 is not one of/.test(plan.refused[0].what), "an unknown CR refuses that row in the preview, naming the client's CRs");
  expect(plan.preview.find(p => p.name === "RAVI NAIR")?.cr === "4030900002" && plan.preview.find(p => p.name === "SARA MOHAMMED")?.cr === "4030900002", "rows are placed under the CR they name, however it is written");
  expect(plan.preview.find(p => p.name === "AHMED ALI")?.cr === "1010900001", "a blank CR on a new person is the main CR");
  expect(plan.preview.find(p => p.name === "OLD HAND KHAN")?.cr === "unchanged", "a blank CR on someone already on file leaves their CR alone");
  const jedRow = plan.crs.find(c => c.cr === "4030900002");
  expect(jedRow?.rows === 2 && jedRow.saudis === 1, "the preview splits the rows per CR with Saudis per CR");
  await prisma.employee.update({ where: { id: existing.id }, data: { establishmentId: dmm.id } });
  await applyEmployeeImport(await planEmployeeImport(a.id, csv));
  const emps = await prisma.employee.findMany({ where: { companyId: a.id }, select: { name: true, establishmentId: true } });
  const at = (n: string) => emps.find(e => e.name === n)?.establishmentId;
  expect(at("RAVI NAIR") === jed.id && at("SARA MOHAMMED") === jed.id && at("AHMED ALI") === null && at("OLD HAND KHAN") === dmm.id && !emps.some(e => e.name === "JOHN DOE"), "the import saved each CR, left the existing person on Dammam, and skipped the refused row");

  console.log("\n4. Cancelling and switching the main CR");
  await refuses(() => updateEstablishment(a.id, jed.id, { status: "cancelled" }), /still under CR/, "a sub CR with active employees cannot be cancelled");
  await refuses(() => updateEstablishment(a.id, list[0].id, { status: "cancelled" }), /main CR cannot be cancelled/, "the main CR cannot be cancelled");
  list = await listEstablishments(a.id);
  const jedInfo = list.find(e => e.id === jed.id)!;
  expect(jedInfo.employees === 2 && jedInfo.saudis === 1 && jedInfo.saudiPct === 50 && jedInfo.documents === 1, "the CR list counts employees, Saudis and certificates per CR");
  const oldMain = list.find(e => e.kind === "main")!;
  await updateEstablishment(a.id, jed.id, { kind: "main" });
  const after = await prisma.employee.findMany({ where: { companyId: a.id }, select: { name: true, establishmentId: true } });
  const at2 = (n: string) => after.find(e => e.name === n)?.establishmentId;
  const co = await prisma.company.findUnique({ where: { id: a.id }, select: { cr: true } });
  expect(at2("AHMED ALI") === oldMain.id && at2("RAVI NAIR") === null && at2("OLD HAND KHAN") === dmm.id, "making Jeddah the main CR keeps everybody on the CR they were on");
  expect(co?.cr === "4030900002", "Company.cr follows the main CR");
  const certs = await prisma.document.findMany({ where: { companyId: a.id, docType: "CR", supersededAt: null }, select: { docNumber: true, establishmentId: true } });
  expect(certs.find(c => c.docNumber === "1010900001")?.establishmentId === oldMain.id && certs.find(c => c.docNumber === "4030900002")?.establishmentId === null, "certificates stay with their CR too");
  await prisma.company.update({ where: { id: a.id }, data: { cr: "4030900099" } });
  await syncMainFromCompany(a.id);
  expect((await prisma.establishment.findUnique({ where: { id: jed.id } }))?.crNumber === "4030900099", "editing the CR on the client form updates the main CR");
  await prisma.employee.updateMany({ where: { companyId: a.id, establishmentId: dmm.id }, data: { establishmentId: null } });
  await updateEstablishment(a.id, dmm.id, { status: "cancelled" });
  expect((await listEstablishments(a.id)).find(e => e.id === dmm.id)?.status === "cancelled", "a sub CR with nobody on it can be cancelled, and stays on file");
  await refuses(() => resolveEstablishmentId(a.id, dmm.id), /cancelled/, "nobody can be put under a cancelled CR");
}

main()
  .catch(e => { bad++; console.error(e); })
  .finally(async () => {
    await sweep().catch(e => console.error("sweep:", e?.message));
    console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed.");
    await prisma.$disconnect();
    process.exit(bad ? 1 : 0);
  });
