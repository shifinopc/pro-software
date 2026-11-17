/**
 * THE TEMPLATE PEOPLE DOWNLOAD MUST BE A FILE THE IMPORTER ACCEPTS.
 *
 *   npx tsx scripts/import-template-check.ts      (local database; writes nothing)
 *
 * This used to compare two lists of headings — one in the console, one here — because the Template
 * button built the CSV in the browser while the server read it. They could disagree, and the way
 * you found out was filling in three hundred people and being told the file has no "nationality"
 * column. The server now builds the file it reads, so that drift is gone by construction, and this
 * check guards what replaced it:
 *
 *   · the headings cover every document type on the employee card, which is configuration and can
 *     change after this code was written — the whole reason the Qiwa contract was unimportable
 *   · the exact file the button hands out still survives the real planner
 *   · the console has not grown a second copy of the headings again
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planEmployeeImport, employeeImportTemplateCsv, cardDocColumns, importColumns } from "../src/employee-import.js";
import { prisma } from "../src/db.js";

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };

const co = await prisma.company.findFirst({ where: { lifecycle: "client" }, select: { id: true, name: true } });
if (!co) { console.error("no client on this database to build a template for."); process.exit(2); }

const csv = await employeeImportTemplateCsv(co.id);
const head = csv.replace(/^﻿/, "").split("\n")[0].split(",");
const cols = await importColumns();
const docs = await cardDocColumns();

console.log(`template for ${co.name}: ${head.length} headings, ${csv.trim().split("\n").length - 1} example rows\n`);

// 1. Every document the card measures can be filled in by the file.
for (const d of docs) {
  if (head.includes(`${d.col}_expiry`)) console.log(`  ok    ${d.type} — column "${d.col}_expiry"`);
  else fail(`${d.type} is on the employee card and the template offers no "${d.col}_expiry" column`);
  if (d.numberCol && !head.includes(d.numberCol)) fail(`${d.type} declares a number field and the template offers no "${d.numberCol}"`);
}
if (head.join() !== cols.join()) fail(`the file's headings are not importColumns():\n          file:   ${head.join(", ")}\n          server: ${cols.join(", ")}`);

// 2. The file itself, through the real planner.
try {
  const plan = await planEmployeeImport(co.id, csv);
  const rows = csv.trim().split("\n").length - 1;
  if (plan.preview.length === rows) console.log(`\n  ok    all ${rows} example rows parse (${plan.preview.map(p => p.name).join(", ")})`);
  else fail(`${plan.preview.length} of ${rows} example rows parsed`);

  const unresolved = plan.preview.filter(p => !/^[A-Z]{2}$/.test(String(p.nationality ?? "")));
  if (!unresolved.length) console.log(`  ok    every nationality resolves to a code (${[...new Set(plan.preview.map(p => p.nationality))].join(", ")})`);
  else fail(`nationality not resolved for: ${unresolved.map(p => `${p.name} → "${p.nationality}"`).join("; ")}`);

  // Documents are the point of the file. Counted per type, because "some documents were planned"
  // was true on the day the Qiwa contract silently had no column at all.
  // From `rows`, the planned records themselves — `preview` is a trimmed view that carries only a
  // count of documents, which is the number that stayed reassuringly non-zero while the Qiwa
  // contract had no column at all.
  const planned = new Set<string>();
  for (const p of (plan as any).rows ?? []) for (const d of (p.docs ?? [])) planned.add(d.docType);
  for (const d of docs) {
    if (planned.has(d.type)) console.log(`  ok    ${d.type} documents are planned from the file`);
    else fail(`no ${d.type} planned — its column is in the file and the importer ignored it`);
  }
  if (plan.errors?.length) fail(`the planner reported: ${plan.errors.map((e: any) => e.message ?? e).join(" · ")}`);
} catch (e: any) {
  fail(`the planner rejected the template outright: ${e?.message ?? e}`);
}

// 3. The second list must not come back.
const html = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"), "utf8");
const i = html.indexOf("this._eiTemplateFor");
const eiBlock = i < 0 ? "" : html.slice(i, i + 2400);
if (!eiBlock) fail("could not find _eiTemplateFor in index.html — this check needs updating");
else if (/employees\/import-template/.test(eiBlock)) console.log("\n  ok    the console downloads the server's template rather than building one");
else fail("the console is building the CSV itself again — that is the drift this check exists to prevent");

console.log(bad ? `\n${bad} wrong.` : "\nin order.");
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
