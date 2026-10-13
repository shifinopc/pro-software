/**
 * The company's own signed employment contract, as a document type of its own.
 *
 * Distinct from "Qiwa Employment Contract", which is the copy authenticated on the ministry's
 * portal. The firm tracks both: one is what the parties signed, the other is what the government
 * holds, and they can differ — which is the whole reason for checking.
 *
 * Settings mirror the Qiwa type deliberately, so the two behave the same wherever the code reads a
 * type rather than a name. IDEMPOTENT: re-running finds the existing row and changes nothing.
 *
 *   npx tsx scripts/add-employment-contract-type.ts --apply
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const NAME = "Employment Contract";

const main = async () => {
  const existing = await prisma.documentType.findUnique({ where: { name: NAME } });
  if (existing) return console.log(`"${NAME}" already exists (${existing.id}) — nothing to do.`);

  const data = {
    name: NAME,
    subjectKind: "employee",
    country: "SA",
    // No issuing authority: the employer issues it, which is exactly what distinguishes it from the
    // Qiwa copy. Leaving it blank is the honest answer, not an omission.
    authority: null,
    leadDays: 30,
    requiresApproval: false,
    defaultAssigneeRole: "pro_officer",
    neverExpires: false,
    fields: [
      { key: "contractNo", type: "text", label: "Contract number" },
      { key: "wage", type: "text", label: "Basic wage" },
    ],
    // Added here, owned here: no packKey, so a pack upgrade will never overwrite or retire it.
    onEmployeeCard: true,
  };
  console.log(`create "${NAME}":`, JSON.stringify(data));
  if (!APPLY) return console.log("\nreport only. Re-run with --apply to write.");
  const t = await prisma.documentType.create({ data: data as any });
  console.log(`\ncreated ${t.id}`);
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
