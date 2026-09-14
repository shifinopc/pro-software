/**
 * Import employees for one client from a CSV, from the command line.
 *
 * The same import now sits behind a button on the client's Employees tab. Both call
 * src/employee-import.ts, so there is one set of rules — date format, nationality codes, identity
 * by government ID, which rows are refused — rather than two copies that drift. Read that file for
 * the reasoning; this is only the command-line front on it.
 *
 *   npx tsx scripts/import-employees.ts <file.csv> "<client name>"          # dry run, changes nothing
 *   npx tsx scripts/import-employees.ts <file.csv> "<client name>" --commit
 */
import { prisma } from "../src/db.js";
import fs from "node:fs";
import { planEmployeeImport, applyEmployeeImport } from "../src/employee-import.js";

const [, , file, clientName, ...flags] = process.argv;
const COMMIT = flags.includes("--commit");

if (!file || !clientName) {
  console.log('usage: import-employees.ts <file.csv> "<client name>" [--commit]');
  process.exit(1);
}

async function main() {
  const co = await prisma.company.findFirst({ where: { name: clientName } });
  if (!co) {
    const all = await prisma.company.findMany({ select: { name: true } });
    console.log(`no client called "${clientName}". On this installation: ${all.map(c => c.name).join(", ")}`);
    process.exit(1);
  }

  const plan = await planEmployeeImport(co.id, fs.readFileSync(file, "utf8"));
  console.log(`\nclient        ${plan.company.name}  (${plan.company.country ?? "no country"})`);
  console.log(`rows read     ${plan.rowsRead}`);
  console.log(`  new         ${plan.creates}`);
  console.log(`  update      ${plan.updates}`);
  console.log(`  refused     ${plan.refused.length}`);
  console.log(`documents     ${plan.documents}`);
  console.log(`nationalities ${plan.nationalities.map(n => `${n.code} ${n.count}`).join(" · ")}`);
  console.log(`saudization   ${plan.saudization.saudis} of ${plan.saudization.total} = ${plan.saudization.pct}% once loaded`);
  if (plan.warnings.length) { console.log(`\nimported with something left out (${plan.warnings.length}):`); for (const w of plan.warnings) console.log(`  row ${w.row}  ${w.name}: ${w.what}`); }
  if (plan.refused.length) { console.log(`\nREFUSED (${plan.refused.length}) — these rows are not imported:`); for (const p of plan.refused) console.log(`  row ${p.row}  ${p.name}: ${p.what}`); }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --commit to import.`);
  } else {
    const r = await applyEmployeeImport(plan);
    console.log(`\nIMPORTED: ${r.made} new, ${r.changed} updated, ${r.docsMade} new document(s), ${r.docsUpdated} document(s) corrected.`);
  }
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e?.message ?? e); await prisma.$disconnect(); process.exit(1); });
