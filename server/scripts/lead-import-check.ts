/**
 * THE TEMPLATE PEOPLE DOWNLOAD MUST BE A FILE THE IMPORTER ACCEPTS — AND MUST CARRY THE SAME
 * FIELDS THE ADD LEAD FORM DOES.
 *
 *   npx tsx scripts/lead-import-check.ts      (local database; writes nothing)
 *
 * Two failures this exists to catch, both of them quiet:
 *
 *   1. The template and the importer disagree. Somebody downloads it, fills in three hundred rows
 *      and is told the file has no company_name column. The work is already done by then. The
 *      employee import has a check for exactly this because its template is built in the browser
 *      from a second copy of the column list; this template is served from the same constant the
 *      importer reads, so the headings cannot drift — but the EXAMPLE ROW still can, and an example
 *      the importer refuses is worse than none.
 *
 *   2. The import and the form fall out of step. The form posts name, lifecycle, city, source,
 *      sourceDetail, industry, campaign, service and contacts to POST /api/companies. A field added
 *      to one and not the other means a lead typed in by hand and a lead imported are different
 *      objects — and the one that is missing something is the one nobody looks at again. That is
 *      the same defect lead-details-fields-check.ts was written for, one route along.
 *
 * It plans the real template against the real planner, so "it parses" is proved rather than argued.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEAD_IMPORT_COLUMNS, LEAD_EXAMPLE_ROW, leadImportTemplateCsv, planLeadImport } from "../src/lead-import.js";
import { prisma } from "../src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

const fails: string[] = [];

/** The keys the Add lead form puts in the body it posts to /api/companies. */
const formFields = (() => {
  // ANCHORED ON THE ADD LEAD FORM, not on "lifecycle: 'lead'". Two places in the console create a
  // lead — this form, and "make a lead of this" in the inbox, which posts a different body — and
  // the looser anchor found the inbox one, so the check reported the import missing fields that
  // belong to a path it has nothing to do with.
  const MARK = "name: String(f.name).trim(), lifecycle: 'lead',";
  const at = html.indexOf(MARK);
  if (at < 0 || html.indexOf(MARK, at + 1) >= 0) return null;   // gone, or no longer unique
  const open = html.lastIndexOf("body: JSON.stringify({", at);
  const close = html.indexOf("}),", at);
  if (open < 0 || close < 0) return null;
  // Comments stripped first. The form's own comment contains the words "three flat columns:", and a
  // key-shaped match inside prose is how this check came to report a field called `columns`.
  const slice = html.slice(open, close).replace(/\/\/[^\n]*/g, "");
  return [...new Set([...slice.matchAll(/(?:^|[\s{,])([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)].map(m => m[1]))]
    // `jobTitle` and the rest live inside the nested contact object; the import builds that object
    // too, so comparing the top level is comparing like with like.
    .filter(k => !["body", "jobTitle", "email", "phone"].includes(k));
})();

const csv = leadImportTemplateCsv();
console.log(`template: ${LEAD_IMPORT_COLUMNS.length} columns, 1 example row, ${csv.length} bytes`);

// 1. Every column the importer knows is offered, and the example fills in every one of them. A
//    blank example column teaches nothing and is usually a column somebody forgot to finish.
for (const c of LEAD_IMPORT_COLUMNS) {
  if (!csv.includes(c)) fails.push(`the template has no "${c}" heading`);
  if (!String(LEAD_EXAMPLE_ROW[c] ?? "").trim()) fails.push(`the example row leaves "${c}" empty — show what belongs there`);
}

// 2. The file the button hands out survives the planner that reads it back.
const plan = await planLeadImport(csv);
console.log(`planned: ${plan.rowsRead} row read, ${plan.creates} would be created, ${plan.refused.length} refused, ${plan.skipped.length} skipped`);
for (const r of plan.refused) fails.push(`the template's own example is REFUSED: row ${r.row} — ${r.what}`);
if (plan.unknownColumns.length) fails.push(`the template has columns the importer ignores: ${plan.unknownColumns.join(", ")}`);
if (!plan.creates && !plan.skipped.length) fails.push("the template's example row produced nothing to import");
// Skipped is not a failure here: run this twice against a database that kept the example and it is
// correctly recognised as already on file. Say so rather than failing on it.
for (const sk of plan.skipped) console.log(`  note: ${sk.what} — expected if a previous run imported the example`);

// 3. The import writes what the form writes.
if (!formFields) {
  fails.push("could not find the Add lead form's POST body in index.html — this check needs updating");
} else if (plan.rows.length) {
  const sent = new Set(Object.keys(plan.rows[0].body));
  // ownerId is the one the import deliberately omits: leaving it out is what lets the sales rules
  // route the lead, which is better than every imported lead landing unassigned.
  const expected = formFields.filter(f => f !== "ownerId");
  const missing = expected.filter(f => !sent.has(f));
  if (missing.length) {
    fails.push(`the Add lead form sends ${missing.map(m => `"${m}"`).join(", ")} and the import does not — `
      + `an imported lead would be missing what a typed one has`);
  }
  console.log(`fields: form sends ${formFields.join(", ")}`);
  console.log(`        import sends ${[...sent].join(", ")}`);
}

if (!fails.length) {
  console.log("\nin order — the template imports, and carries everything the form does.");
} else {
  for (const f of fails) console.log(`\n  FAIL  ${f}`);
  process.exitCode = 1;
}
await prisma.$disconnect();
