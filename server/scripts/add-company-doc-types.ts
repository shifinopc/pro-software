/**
 * THE SIX COMPANY DOCUMENTS THE FIRM ASKS FOR THAT THE SAUDI PACK DOES NOT CARRY.
 *
 *   npx tsx scripts/add-company-doc-types.ts          # say what would change
 *   npx tsx scripts/add-company-doc-types.ts --write  # create them
 *
 * Idempotent and matched BY NAME, which is the column the database makes unique — run it twice and
 * the second run creates nothing. It only ever creates: a type somebody has since edited keeps their
 * edit, because the one thing worse than a missing type is a field list that moves under the
 * documents already captured against it.
 *
 * packKey stays NULL on purpose. These are the firm's own types, not a country pack's, so a future
 * pack install or upgrade must leave them alone.
 *
 * Fields hold only what is SPECIFIC to the document. Number, issue date, expiry date and issuing
 * authority are columns on every document, so repeating them here would ask for them twice.
 */
import { prisma } from "../src/db.js";

type Field = { id: string; label: string; type: string; required: boolean; purpose: string; options: string };
const f = (id: string, label: string, type = "text"): Field => ({ id, label, type, required: false, purpose: "", options: "" });

const TYPES: { name: string; authority: string; leadDays: number; neverExpires?: boolean; fields?: Field[] }[] = [
  // The constitution of the company. It is amended, never renewed, so it carries no expiry — and
  // saying so is what keeps it out of the renewals queue instead of sitting there as "unknown".
  { name: "Articles of Association", authority: "MC", leadDays: 30, neverExpires: true },

  // The ZATCA registration certificate, which is not the VAT return already in the pack: one is the
  // registration, the other is a filing made against it.
  { name: "ZATCA Certificate", authority: "ZATCA", leadDays: 30, neverExpires: true },
  { name: "VAT Certificate", authority: "ZATCA", leadDays: 30, neverExpires: true },

  // Municipal licence. It is issued per SHOP, so the premises it covers has to be on the record —
  // a client with four branches holds four of these and the number alone does not say which is which.
  // Which CR it belongs to is the document's establishmentId, not a field.
  { name: "Baladiya License", authority: "Baladiya", leadDays: 45, fields: [f("shop", "Shop / location name")] },

  // The tenancy behind an address. Both parties matter: a rental contract identified only by its
  // number cannot be matched to the premises when it comes up for renewal.
  { name: "Ejar Contract", authority: "Ejar", leadDays: 60, fields: [f("property", "Property / unit"), f("landlord", "Landlord")] },

  // The Nitaqat standing certificate. The band is free text rather than a fixed list because the
  // ladder a client is measured on is configured per client — a hardcoded list here would assert a
  // scheme that may not be theirs.
  { name: "Saudization Certificate", authority: "Qiwa", leadDays: 30, fields: [f("band", "Nitaqat band")] },
];

const write = process.argv.includes("--write");

const existing = await prisma.documentType.findMany({ where: { name: { in: TYPES.map(t => t.name) } }, select: { name: true } });
const have = new Set(existing.map(e => e.name));
const todo = TYPES.filter(t => !have.has(t.name));

for (const t of TYPES) console.log(`${have.has(t.name) ? "already there" : write ? "creating    " : "would create"}  ${t.name}`);

if (write && todo.length) {
  await prisma.documentType.createMany({
    data: todo.map(t => ({
      name: t.name, authority: t.authority, leadDays: t.leadDays, neverExpires: !!t.neverExpires,
      fields: t.fields ?? [], prereqs: [], subjectKind: "company", country: "SA",
    })),
  });
}
console.log(`\n${write ? "created" : "would create"} ${todo.length} of ${TYPES.length}`);
await prisma.$disconnect();
