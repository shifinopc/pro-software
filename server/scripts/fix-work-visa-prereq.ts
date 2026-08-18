/**
 * A work visa cannot require an Iqama.
 *
 * The Work Visa document type carried `{ requiresDocType: "Iqama", minMonths: 6 }`. An Iqama is the
 * residence permit somebody receives AFTER entering the Kingdom on that very visa, so the condition
 * can never be satisfied by the person it applies to — and the workflow issues Work Visa before
 * Iqama, so the check is against a document that does not exist yet.
 *
 * The real validity requirement at this point is the passport, which is also what the onboarding
 * checklist already asks for (`passport_validity`, "Passport valid 6+ months"). The prerequisite and
 * the checklist were describing the same requirement and disagreeing about it.
 *
 * Idempotent: only rewrites a prereq that names Iqama.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.documentType.findMany({ where: { name: "Work Visa" } });
  if (!rows.length) { console.log("no Work Visa document type here"); await prisma.$disconnect(); return; }

  for (const d of rows) {
    const pre: any[] = Array.isArray(d.prereqs) ? (d.prereqs as any[]) : [];
    const bad = pre.filter(p => String(p?.requiresDocType) === "Iqama");
    if (!bad.length) { console.log(`  ${d.country ?? "-"} Work Visa — already correct: ${JSON.stringify(pre)}`); continue; }
    const next = pre
      .filter(p => String(p?.requiresDocType) !== "Iqama")
      .concat(pre.some(p => String(p?.requiresDocType) === "Passport") ? [] : [{ requiresDocType: "Passport", minMonths: 6 }]);
    console.log(`  ${d.country ?? "-"} Work Visa  ${JSON.stringify(pre)}\n            -> ${JSON.stringify(next)}  ${APPLY ? "written" : "(dry run)"}`);
    if (APPLY) await prisma.documentType.update({ where: { id: d.id }, data: { prereqs: next as any } });
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
