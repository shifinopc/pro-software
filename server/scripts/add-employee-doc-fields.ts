/**
 * The three document types the firm asked to track on the employee card, with the fields each needs.
 *
 *   Passport                gains an issue date (it already had number and expiry)
 *   Driving License         new type: number, issue date, expiry
 *   Exit / Re-entry Visa    gains Single/Multiple, and "return before" as its expiry
 *
 * RETURN BEFORE IS THE EXPIRY, not a field beside it. An exit/re-entry visa is one deadline: re-enter
 * by that date or it lapses. Recording it as an ordinary field would leave the compliance engine with
 * nothing to count down, so the date that matters would be the one date nothing reminded anybody
 * about. It carries the expiry purpose and is labelled for what it is.
 *
 * IDEMPOTENT: a field already present by label is left exactly as it is, so this never overwrites an
 * edit somebody has since made on the Document Types screen.
 *
 *   npx tsx scripts/add-employee-doc-fields.ts            # report only
 *   npx tsx scripts/add-employee-doc-fields.ts --apply
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const mint = (n: number) => `f${Date.now()}${n}`;

type F = { id: string; label: string; type: string; required: boolean; purpose: string; options?: string };
const f = (n: number, label: string, type: string, purpose = "", options = "", required = false): F =>
  ({ id: mint(n), label, type, required, purpose, ...(options ? { options } : {}) });

const WANT: Record<string, F[]> = {
  "Passport": [f(1, "Issue Date", "date", "issue")],
  "Driving License": [
    f(2, "Licence Number", "text", "number"),
    f(3, "Issue Date", "date", "issue"),
    f(4, "Expiry Date", "date", "expiry"),
  ],
  "Exit / Re-entry Visa": [
    f(5, "Visa Number", "text", "number"),
    f(6, "Single or Multiple", "dropdown", "", "Single,Multiple", true),
    f(7, "Issue Date", "date", "issue"),
    f(8, "Return Before", "date", "expiry", "", true),
  ],
};

const main = async () => {
  for (const [name, want] of Object.entries(WANT)) {
    let row = await prisma.documentType.findUnique({ where: { name } });
    if (!row) {
      if (name !== "Driving License") { console.log(`SKIP ${name} — no such type`); continue; }
      console.log(`create "${name}"`);
      if (APPLY) {
        row = await prisma.documentType.create({
          data: { name, subjectKind: "employee", country: "SA", authority: "Muroor", leadDays: 30,
                  requiresApproval: false, defaultAssigneeRole: "pro_officer", neverExpires: false, fields: [] },
        });
      } else { console.log(`  (dry run \u2014 would then add ${want.length} fields)`); continue; }
    }
    const have = Array.isArray(row!.fields) ? (row!.fields as any[]) : [];
    const haveLabels = new Set(have.map(x => String(x.label || "").toLowerCase()));
    const add = want.filter(x => !haveLabels.has(x.label.toLowerCase()));
    if (!add.length) { console.log(`${name}: already has ${want.map(w => `"${w.label}"`).join(", ")}`); continue; }
    console.log(`${name}: + ${add.map(a => `${a.label} (${a.type}${a.purpose ? `/${a.purpose}` : ""}${a.options ? ` [${a.options}]` : ""})`).join(", ")}`);
    if (APPLY) await prisma.documentType.update({ where: { id: row!.id }, data: { fields: [...have, ...add], packModified: true } });
  }
  if (!APPLY) console.log("\nreport only. Re-run with --apply to write.");
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
