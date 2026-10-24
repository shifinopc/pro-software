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
// No purpose on any of these: purpose says which run variable a field feeds, and the number, issue
// date and expiry that renewals actually move are columns on every document, not fields.
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

  // The periodic inspection. Its own type because it has its own expiry: a car can be insured and
  // registered and still be off the road for a lapsed Fahas, and a renewals queue that tracks one
  // date per vehicle would never say so.
  { name: "Vehicle Inspection (Fahas)", authority: "Fahas", leadDays: 30, fields: [f("plate", "Plate number")] },
];

/**
 * FIELDS ADDED TO TYPES THAT ALREADY EXIST.
 *
 * Add-only, matched by field id. A type somebody has edited keeps every field they put on it, and
 * nothing is renamed or removed — a document captured under a type keeps its values keyed by these
 * ids, so changing one would orphan what is already on file.
 *
 * WHY THE CAR'S IDENTITY SITS ON THE REGISTRATION AND NOWHERE ELSE. Owner, year and model are facts
 * about the vehicle, not about a particular paper. The Istimara is the document that states them,
 * so it carries them once; the insurance and the inspection carry the plate, which is what ties the
 * three together, and their own dates. Repeating make and year on all three would mean typing one
 * car three times and letting the three copies drift.
 */
const ADD_FIELDS: { type: string; fields: Field[] }[] = [
  { type: "Vehicle Registration", fields: [
    f("plate", "Plate number"),
    f("vehicle", "Vehicle name / model"),
    f("year", "Year of manufacture", "number"),
    f("owner", "Owner"),
  ] },
  { type: "Vehicle Insurance", fields: [f("plate", "Plate number")] },
];

/**
 * AUTHORITIES CORRECTED ON TYPES THAT ALREADY EXIST.
 *
 * Only when the row still carries the value the pack installed — `from` has to match, so a firm
 * that already chose something else keeps their choice. The row is marked packModified, which is
 * what makes a future pack upgrade show a diff instead of quietly putting the old value back.
 *
 * A motor policy is issued by the insurer. Tamm is where you look it up, which is not the same
 * thing, and the authority on a document is what the visit queue and the credential vault match on.
 */
const FIX_AUTHORITY: { type: string; from: string; to: string }[] = [
  { type: "Vehicle Insurance", from: "Tamm", to: "Insurer" },
];

/**
 * TYPES A CLIENT CAN HOLD SEVERAL OF AT ONCE.
 *
 * One per vehicle, not one per CR. Without the flag the Add-client form counted a second car as a
 * second branch and refused the third, because nothing distinguished "another car" from "another
 * branch". Set to true only; a type switched off by hand stays off.
 */
const REPEATABLE = ["Vehicle Registration", "Vehicle Insurance", "Vehicle Inspection (Fahas)"];

/**
 * The authorities those types are issued by, as GOVERNMENT CENTRES.
 *
 * A document's authority is picked from this list, not typed, so a type whose authority is not a
 * centre would offer a value the picker cannot show. Three of the six above are authorities the
 * Saudi pack does not carry, so they are created here — in the same script, because a type and the
 * centre it names have to arrive together or the type is born pointing at nothing.
 */
const CENTRES: { name: string; sub: string }[] = [
  { name: "ZATCA", sub: "Tax and customs — VAT, e-invoicing, certificates" },
  { name: "Baladiya", sub: "Municipality — shop and premises licensing" },
  { name: "Ejar", sub: "Tenancy contracts" },
  // Spelled out, because the list already holds Fasah — the customs single window — and the two are
  // one letter apart on screen.
  { name: "Fahas", sub: "Periodic vehicle inspection (MVPI) — the car is driven there" },
];

const write = process.argv.includes("--write");

const haveTypes = new Set((await prisma.documentType.findMany({ where: { name: { in: TYPES.map(t => t.name) } }, select: { name: true } })).map(e => e.name));
const haveCentres = new Set((await prisma.govCenter.findMany({ where: { name: { in: CENTRES.map(c => c.name) } }, select: { name: true } })).map(e => e.name));
const todoTypes = TYPES.filter(t => !haveTypes.has(t.name));
const todoCentres = CENTRES.filter(c => !haveCentres.has(c.name));

// Fields missing from types that already exist. Read before anything is written, so the dry run
// reports exactly what the real run will do.
const fieldWork: { id: string; name: string; add: Field[] }[] = [];
for (const want of ADD_FIELDS) {
  const row = await prisma.documentType.findUnique({ where: { name: want.type }, select: { id: true, name: true, fields: true } });
  if (!row) { console.log(`not found     ${want.type} — no fields added`); continue; }
  const have = new Set((Array.isArray(row.fields) ? row.fields : []).map((x: any) => String(x?.id ?? "")));
  const add = want.fields.filter(x => !have.has(x.id));
  if (add.length) fieldWork.push({ id: row.id, name: row.name, add });
}

// Authorities still on the pack's value. Read before anything is written, same as the fields.
const authWork: { id: string; type: string; to: string }[] = [];
for (const want of FIX_AUTHORITY) {
  const row = await prisma.documentType.findUnique({ where: { name: want.type }, select: { id: true, authority: true } });
  if (!row) { console.log(`not found     ${want.type} — authority unchanged`); continue; }
  if (row.authority === want.to) continue;
  if (row.authority !== want.from) { console.log(`left alone    ${want.type} · authority is "${row.authority}", not the pack's "${want.from}"`); continue; }
  authWork.push({ id: row.id, type: want.type, to: want.to });
}

// Types that should be repeatable and are not yet. A type created above arrives false, so this runs
// after them on a fresh install and finds them.
const repeatWork = (await prisma.documentType.findMany({ where: { name: { in: REPEATABLE }, repeatable: false }, select: { id: true, name: true } }));

const say = (had: boolean, what: string) => console.log(`${had ? "already there" : write ? "creating    " : "would create"}  ${what}`);
for (const c of CENTRES) say(haveCentres.has(c.name), `government centre · ${c.name}`);
for (const t of TYPES) say(haveTypes.has(t.name), t.name);
for (const w of ADD_FIELDS) {
  const job = fieldWork.find(j => j.name === w.type);
  console.log(`${job ? (write ? "adding fields " : "would add     ") + job.add.map(x => x.label).join(", ") : "fields present"}  on ${w.type}`);
}
for (const job of authWork) console.log(`${write ? "setting      " : "would set    "} ${job.type} · authority → ${job.to}`);
for (const job of repeatWork) console.log(`${write ? "setting      " : "would set    "} ${job.name} · several can be live at once`);

if (write) {
  // Centres first: a type names its authority, so the centre it names should already exist.
  if (todoCentres.length) await prisma.govCenter.createMany({ data: todoCentres.map(c => ({ name: c.name, sub: c.sub, country: "SA" })) });
  if (todoTypes.length) {
    await prisma.documentType.createMany({
      data: todoTypes.map(t => ({
        name: t.name, authority: t.authority, leadDays: t.leadDays, neverExpires: !!t.neverExpires,
        fields: t.fields ?? [], prereqs: [], subjectKind: "company", country: "SA",
      })),
    });
  }
  // Appended, never reordered or replaced: the fields a person added themselves stay where they put
  // them, and every document already captured keeps its values.
  for (const job of fieldWork) {
    const row = await prisma.documentType.findUnique({ where: { id: job.id }, select: { fields: true } });
    const current = Array.isArray(row?.fields) ? (row!.fields as any[]) : [];
    await prisma.documentType.update({ where: { id: job.id }, data: { fields: [...current, ...job.add] as any } });
  }
  for (const job of authWork) {
    await prisma.documentType.update({ where: { id: job.id }, data: { authority: job.to, packModified: true } });
  }
  if (repeatWork.length) await prisma.documentType.updateMany({ where: { id: { in: repeatWork.map(j => j.id) } }, data: { repeatable: true } });
}
console.log(`\n${write ? "created" : "would create"} ${todoCentres.length} centre(s) and ${todoTypes.length} type(s), `
  + `${write ? "added" : "would add"} ${fieldWork.reduce((n, j) => n + j.add.length, 0)} field(s), `
  + `${write ? "set" : "would set"} ${authWork.length} authority(ies) and ${repeatWork.length} repeatable flag(s)`);
await prisma.$disconnect();
