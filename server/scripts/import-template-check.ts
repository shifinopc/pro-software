/**
 * THE TEMPLATE PEOPLE DOWNLOAD MUST BE A FILE THE IMPORTER ACCEPTS.
 *
 *   npx tsx scripts/import-template-check.ts      (local database; writes nothing)
 *
 * The Employees tab offers Template and Import side by side, and they are built from two different
 * lists in two different files: the console writes the CSV from its own `head9`, and the server
 * reads it against `IMPORT_COLUMNS` and the aliases. Nothing connects them — `IMPORT_COLUMNS` is
 * exported for the purpose and imported by nobody.
 *
 * They agree today. The failure when they stop is the expensive kind: somebody downloads the
 * template, fills in three hundred people, and is told the file has no "nationality" column. The
 * work is already done by then, and the person who did it has no way to tell whose fault it is.
 *
 * So this reads the SHIPPED template out of index.html — not a copy of it — and does two things:
 * compares its headings to the server's list, and then feeds the exact file the button produces to
 * the real planner. Headings that line up are not enough; the example rows have to survive the
 * parsing too, which is what a person discovers by pressing Import on the file they were given.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMPORT_COLUMNS, planEmployeeImport } from "../src/employee-import.js";
import { prisma } from "../src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

const grab = (marker: string) => {
  const from = html.indexOf(marker);
  if (from < 0) return null;
  const open = html.indexOf("[", from);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") { depth--; if (!depth) break; }
  }
  // eslint-disable-next-line no-eval
  return eval(html.slice(open, i + 1)) as any[];
};

const head = grab("const head9 = [") as string[] | null;
const people = grab("const people9 = [") as string[][] | null;
if (!head || !people) { console.error("Could not find the template's headings or example rows in index.html — this check needs updating."); process.exit(2); }

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };

// 1. The two lists.
const missing = IMPORT_COLUMNS.filter(c => !head.includes(c));
const extra = head.filter(c => !IMPORT_COLUMNS.includes(c));
if (!missing.length && !extra.length && head.join() === IMPORT_COLUMNS.join())
  console.log(`  ok    the template's ${head.length} headings match IMPORT_COLUMNS, in order`);
else {
  for (const c of missing) fail(`IMPORT_COLUMNS has "${c}" and the downloaded template does not offer it`);
  for (const c of extra) fail(`the template offers "${c}" and IMPORT_COLUMNS does not list it`);
  if (!missing.length && !extra.length) fail(`same headings, different order:\n          template: ${head.join(", ")}\n          server:   ${IMPORT_COLUMNS.join(", ")}`);
}

// 2. The file itself, through the real planner. cr_number is filled in by the console per client;
//    blank is the documented meaning of "the main CR", so the plain template is what is tested.
const rows = people.map(p => [...p.slice(0, 3), "", ...p.slice(3)]);
const csv = [head, ...rows].map(r => r.map(v => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(",")).join("\n") + "\n";

const co = await prisma.company.findFirst({ where: { lifecycle: "client" }, select: { id: true, name: true } });
if (!co) { console.log("  ..    no client on this database to plan against; headings were still checked"); }
else {
  try {
    const plan = await planEmployeeImport(co.id, csv);
    const names = plan.preview.map(p => p.name);
    if (plan.preview.length === people.length) console.log(`  ok    all ${people.length} example rows parse (${names.join(", ")})`);
    else fail(`${plan.preview.length} of ${people.length} example rows parsed — ${names.join(", ") || "none"}`);

    // The nationality column is written as a word, and has to come back as a code.
    const unresolved = plan.preview.filter(p => !/^[A-Z]{2}$/.test(String(p.nationality ?? "")));
    if (!unresolved.length) console.log(`  ok    every nationality resolves to a code (${[...new Set(plan.preview.map(p => p.nationality))].join(", ")})`);
    else fail(`nationality not resolved for: ${unresolved.map(p => `${p.name} → "${p.nationality}"`).join("; ")}`);

    // The expiry columns are the point of the file; a template whose documents are silently ignored
    // teaches people to leave them blank.
    if (plan.documents > 0) console.log(`  ok    the example rows plan ${plan.documents} documents from their expiry columns`);
    else fail("no documents planned — the passport / iqama / permit / insurance columns are being ignored");

    if (plan.errors?.length) fail(`the planner reported: ${plan.errors.map((e: any) => e.message ?? e).join(" · ")}`);
  } catch (e: any) {
    fail(`the planner rejected the template outright: ${e?.message ?? e}`);
  }
}

console.log(bad ? `\n${bad} wrong.` : "\nin order.");
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
