/**
 * Give every existing record a country, and turn free-text nationality into a country code.
 *
 * Everything on file today is Saudi — the product had no concept of country, so there was nowhere
 * for it to be anything else. This stamps that fact rather than leaving it implied, which is what
 * lets a second country exist at all.
 *
 * The nationality part is the one with teeth. It rewrites data a human typed, so:
 *   - a value that resolves is replaced by its ISO code
 *   - a value that does NOT resolve is LEFT EXACTLY AS IT IS and reported
 *   - nothing is ever blanked
 *
 * An unrecognised nationality is somebody's deliberate entry, not noise. Blanking it would delete a
 * fact and, worse, would make the row silently pass a "nobody has said otherwise" check later.
 * Reporting it leaves a short list a person can fix in a minute.
 *
 * Idempotent: a row already holding a code resolves to itself and is left alone.
 * Dry run by default; pass --apply to write.
 */
import { prisma } from "../src/db.js";
import { resolveCountry, countryName } from "../src/countries.js";

const HOME = "SA"; // every existing client and employee is Saudi-domiciled

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLYING\n" : "Dry run — pass --apply to write\n");

  // ── Companies ──
  const companies = await prisma.company.findMany({ select: { id: true, name: true, country: true } });
  const coNeeding = companies.filter(c => !c.country);
  console.log(`Companies: ${companies.length} · without a country: ${coNeeding.length}`);
  for (const c of coNeeding) console.log(`  ${c.name} → ${HOME}`);
  if (apply && coNeeding.length) {
    await prisma.company.updateMany({ where: { id: { in: coNeeding.map(c => c.id) } }, data: { country: HOME } });
  }

  // ── Employees: work country ──
  const emps = await prisma.employee.findMany({
    select: { id: true, name: true, nationality: true, workCountry: true, company: { select: { country: true } } },
  });
  const wcNeeding = emps.filter(e => !e.workCountry);
  console.log(`\nEmployees: ${emps.length} · without a work country: ${wcNeeding.length}`);
  if (apply) {
    for (const e of wcNeeding) {
      // Follow the employer, falling back to the home market. An employee counts toward one country.
      await prisma.employee.update({ where: { id: e.id }, data: { workCountry: e.company?.country || HOME } });
    }
  }

  // ── Employees: nationality → ISO code ──
  console.log(`\nNationality:`);
  const unresolved: { name: string; value: string }[] = [];
  let changed = 0, alreadyCode = 0, blank = 0;

  for (const e of emps) {
    const raw = String(e.nationality ?? "").trim();
    if (!raw) { blank++; continue; }
    const code = resolveCountry(raw);
    if (!code) { unresolved.push({ name: e.name, value: raw }); continue; }
    if (raw === code) { alreadyCode++; continue; }
    console.log(`  ${e.name.padEnd(22)} "${raw}" → ${code}  (${countryName(code)})`);
    changed++;
    if (apply) await prisma.employee.update({ where: { id: e.id }, data: { nationality: code } });
  }

  console.log(`\n  converted ${changed} · already a code ${alreadyCode} · blank ${blank} · unrecognised ${unresolved.length}`);
  if (unresolved.length) {
    console.log(`\n  LEFT UNTOUCHED — these need a human, not a guess:`);
    for (const u of unresolved) console.log(`    ${u.name.padEnd(22)} "${u.value}"`);
    console.log(`  Add an alias in countries.ts, or correct the row in the console.`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
