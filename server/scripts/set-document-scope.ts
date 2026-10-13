/**
 * Who each employee document applies to.
 *
 * A Saudi national holds no Iqama, no work permit and no exit/re-entry visa — those are documents of
 * residency, and a citizen is not a resident. Measuring a Saudi employee against the same list as an
 * expatriate marks them permanently non-compliant for papers they can never hold.
 *
 * The firm's rule: a Saudi national needs health insurance and a Qiwa employment contract. Nothing
 * else. Everything else on the employee card is therefore an expatriate document.
 *
 * IDEMPOTENT. Only types this names are touched; anything else keeps whatever it has.
 *
 *   npx tsx scripts/set-document-scope.ts            # report only
 *   npx tsx scripts/set-document-scope.ts --apply
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const EVERYONE = ["Health Insurance", "Qiwa Employment Contract"];

const main = async () => {
  const types = await prisma.documentType.findMany({
    where: { subjectKind: "employee", retired: false },
    select: { id: true, name: true, employeeScope: true },
  });
  for (const t of types) {
    const want = EVERYONE.includes(t.name) ? "all" : "expats";
    const mark = t.employeeScope === want ? "=" : "~";
    console.log(`  ${mark} ${t.name.padEnd(28)} ${t.employeeScope} -> ${want}`);
    if (APPLY && t.employeeScope !== want) {
      await prisma.documentType.update({ where: { id: t.id }, data: { employeeScope: want, packModified: true } });
    }
  }
  if (!APPLY) console.log("\nreport only. Re-run with --apply to write.");
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
