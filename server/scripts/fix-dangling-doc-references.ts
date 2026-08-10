/**
 * Ten references name a document type or authority that is not there. Resolve them.
 *
 * A reference here is a plain NAME, not a foreign key — a service names the document it produces, a
 * renewal workflow names the document it renews, a prerequisite names the document it waits for. The
 * database will not stop any of them pointing at nothing, so they rot silently: the renewal never
 * triggers, the prerequisite never blocks, and everything still looks configured on screen.
 *
 * THREE DIFFERENT PROBLEMS, THREE DIFFERENT FIXES — which is the whole reason this is a script with
 * reasons in it rather than one UPDATE:
 *
 *   WRONG COUNTRY'S ROW. A Saudi Iqama listed an Emirates ID as a prerequisite, and a UAE
 *   Establishment Card named MHRSD — the Saudi ministry — as its authority. Copy-paste between two
 *   country configurations. The Iqama prerequisite is dropped outright (no Saudi Iqama has ever
 *   required a UAE identity card); the authority becomes MOHRE, which is the UAE body that actually
 *   issues it and which already exists.
 *
 *   A NAME THAT NEVER MATCHED. "GOSI" as a service's document type, where the document type is
 *   called "GOSI Registration" and "GOSI" is the name of the AUTHORITY. Somebody typed the issuer
 *   into the document field. Repointed — nothing is created, the right row was always there.
 *
 *   A DOCUMENT TYPE NOBODY EVER CREATED. Three references name documents that exist nowhere, and in
 *   every case the surrounding configuration is real and complete: a "Vehicle Registration Renewal"
 *   workflow with a trigger, a fee approval and an issuing step; a "Medical Test" service sold inside
 *   packages; a UAE employment visa flow whose last step issues the residence visa the whole flow is
 *   for. The reference is not the mistake — the missing row is. So the row is created, and the
 *   authored work starts functioning instead of being deleted.
 *
 * WHAT IS DELIBERATELY LEFT ALONE
 *   "QA PROBE (INERT - do not use)" triggers on Establishment Card, which is now correctly UAE. It
 *   is scratch work, it is already excluded from packs by --clean, and repairing somebody's probe
 *   would be pretending it is content.
 *
 *   The three new document types get NO packKey. A packKey means "a country pack put this here and a
 *   pack may upgrade it"; these were authored on this installation. The exporter derives a key for a
 *   keyless row anyway, so they travel — they simply do not claim a provenance they do not have.
 *
 *   `active` is not touched on any workflow. Vehicle Registration Renewal stays inactive like every
 *   other renewal template here; turning one on is an operational decision, not a data repair.
 *
 * Idempotent, and prints what it would do before doing it. Run with --apply to write.
 */
import { prisma } from "../src/db.js";

const NEW_TYPES = [
  {
    country: "SA", name: "Medical Certificate", subjectKind: "employee", leadDays: 30,
    why: 'service "Medical Test" produces it, and the visa checklist already asks for a medical report',
  },
  {
    country: "SA", name: "Vehicle Registration", subjectKind: "company", leadDays: 30,
    why: 'workflow "Vehicle Registration Renewal" both triggers on it and issues it',
  },
  {
    country: "AE", name: "Residence Visa", subjectKind: "employee", leadDays: 30, authority: "ICP",
    why: 'the last step of "UAE Employment Visa (New, Inside-Country)" issues it',
  },
] as const;

async function main() {
  const apply = process.argv.includes("--apply");
  const act = (line: string) => console.log(`  ${apply ? "·" : "would"} ${line}`);

  // ── document types that were never created ──────────────────────────────────────────────────────
  console.log("missing document types");
  for (const t of NEW_TYPES) {
    const existing = await prisma.documentType.findFirst({ where: { country: t.country, name: t.name } });
    if (existing) { console.log(`  ${t.name} — already there (${existing.country}${existing.retired ? ", retired" : ""})`); continue; }
    act(`create ${t.country} "${t.name}" (${t.subjectKind}, ${t.leadDays}d lead) — ${t.why}`);
    if (apply) {
      await prisma.documentType.create({ data: {
        country: t.country, name: t.name, subjectKind: t.subjectKind, leadDays: t.leadDays,
        authority: (t as any).authority ?? null,
        // Matches every other row here: no fee invented, no approval imposed, and the officer role
        // every document type already defaults to.
        defaultFee: null, requiresApproval: false, defaultAssigneeRole: "pro_officer",
        fields: [], prereqs: [],
      } });
    }
  }

  // ── a name that never matched anything ──────────────────────────────────────────────────────────
  console.log("\nmistyped reference");
  const gosi = await prisma.serviceItem.findFirst({ where: { country: "SA", name: "GOSI Registration" } });
  if (!gosi) console.log("  service \"GOSI Registration\" not found");
  else if (gosi.docType === "GOSI Registration") console.log("  GOSI Registration — already points at the document type");
  else {
    act(`service "GOSI Registration": docType "${gosi.docType}" → "GOSI Registration"  (GOSI is the authority, not the document)`);
    if (apply) await prisma.serviceItem.update({ where: { id: gosi.id }, data: { docType: "GOSI Registration" } });
  }

  // ── the other country's rows ────────────────────────────────────────────────────────────────────
  console.log("\nwrong country's row");
  const iqama = await prisma.documentType.findFirst({ where: { country: "SA", name: "Iqama" } });
  if (!iqama) console.log("  Iqama not found");
  else {
    const prereqs = ((iqama.prereqs as any[]) ?? []);
    const keep = prereqs.filter(p => String(p?.requiresDocType ?? "").trim().toLowerCase() !== "emirates id");
    if (keep.length === prereqs.length) console.log("  Iqama — no Emirates ID prerequisite left");
    else {
      act(`Iqama: drop the "Emirates ID" prerequisite, keep ${keep.map(p => `"${p.requiresDocType}"`).join(", ")}`);
      if (apply) await prisma.documentType.update({ where: { id: iqama.id }, data: { prereqs: keep } });
    }
  }

  const estab = await prisma.documentType.findFirst({ where: { country: "AE", name: "Establishment Card" } });
  if (!estab) console.log("  Establishment Card not found");
  else if (estab.authority === "MOHRE") console.log("  Establishment Card — authority already MOHRE");
  else {
    act(`Establishment Card: authority "${estab.authority}" → "MOHRE"  (MHRSD is the Saudi ministry)`);
    if (apply) await prisma.documentType.update({ where: { id: estab.id }, data: { authority: "MOHRE" } });
  }

  // ── retired, but something live still depends on it ─────────────────────────────────────────────
  console.log("\nretired with a live dependant");
  const labour = await prisma.documentType.findFirst({ where: { country: "AE", name: "Labour Card" } });
  if (!labour) console.log("  Labour Card not found");
  else if (!labour.retired) console.log("  Labour Card — already active");
  else {
    // It was retired while it was mis-filed under Saudi Arabia, which is the likeliest reason anyone
    // retired it: it did not belong in the Saudi list. It does belong in the UAE one, where a whole
    // renewal workflow triggers on it and issues it.
    act(`Labour Card: un-retire — "Labour Card Renewal" both triggers on it and issues it`);
    if (apply) await prisma.documentType.update({ where: { id: labour.id }, data: { retired: false } });
  }

  console.log(apply ? "\n  applied" : "\n  dry run — nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
