/**
 * Point each Saudi document type at the body that issues it.
 *
 * The pack shipped five authorities — Muqeem, GOSI, ZATCA, MHRSD, Qiwa — and fourteen document types
 * with `authority: null`, so the Authorities screen listed five bodies that issued nothing and every
 * document said it came from nowhere. The two ends were built and never joined.
 *
 * Most of these are not a judgement at all: each authority already states what it issues in its own
 * `sub`, and matching them is reading, not deciding. Muqeem says "Iqama · exit-reentry · final exit";
 * ZATCA says "VAT · Zakat · e-invoicing"; Qiwa says "Work permits & contracts".
 *
 * Three needed a body the pack does not carry, so they are created here:
 *   Ministry of Commerce — the commercial register is theirs, not MHRSD's
 *   CCHI                 — mandatory health insurance is regulated by the Council, not GOSI
 *   MOH                  — medical fitness certificates come from licensed centres
 *
 * PASSPORT IS DELIBERATELY LEFT UNSET, and that is the one to keep. A passport is issued by the
 * employee's own government; there is no Saudi authority behind it, and inventing one would make the
 * renewal screens offer to chase a body that cannot be chased. Null here means "nobody in this
 * country issues this", which is a fact worth recording, not a gap left over.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const COUNTRY = "SA";

/** Bodies the pack does not carry. Same shape as the pack's own, so they read identically. */
const NEW_AUTHORITIES = [
  { name: "Ministry of Commerce", sub: "Commercial register · company formation" },
  { name: "CCHI", sub: "Mandatory health insurance · Council of Health Insurance" },
  { name: "MOH", sub: "Medical fitness certificates · licensed centres" },
  // The Work Visa Application step files its work under MOFA, and MOFA was in no database — so that
  // step pointed at an authority that did not exist, and the Government Centers queue had nowhere to
  // put it. Caught by the pack exporter, which refuses to ship a reference it cannot resolve.
  //
  // Deliberately NOT the same body as the Work Visa document type, which is filed under MHRSD: the
  // ministry authorises the recruitment, and Foreign Affairs issues the visa itself.
  { name: "MOFA", sub: "Work visa authorisation · Saudi Visa platform" },
];

/** null = no authority issues this in this country, and that is the correct answer. */
const MAP: Record<string, string | null> = {
  "Iqama": "Muqeem",
  "Exit/Re-entry Visa": "Muqeem",
  "GOSI Registration": "GOSI",
  "GOSI Employee Registration": "GOSI",
  "VAT Certificate": "ZATCA",
  "Work Permit": "Qiwa",
  "Qiwa Employment Contract": "Qiwa",
  "Work Visa": "MHRSD",
  "Commercial Register": "Ministry of Commerce",
  "Health Insurance": "CCHI",
  "Medical Certificate": "MOH",
  "Passport": null,
};

async function main() {
  console.log(APPLY ? "APPLYING\n" : "dry run — pass --apply to write\n");

  for (const a of NEW_AUTHORITIES) {
    const found = await prisma.govCenter.findFirst({ where: { name: a.name, country: COUNTRY } });
    if (found) { console.log(`  authority ${a.name.padEnd(22)} already here`); continue; }
    if (APPLY) await prisma.govCenter.create({ data: { ...a, country: COUNTRY } });
    console.log(`  authority ${a.name.padEnd(22)} ${APPLY ? "created" : "would create"}`);
  }

  console.log("");
  const known = new Set((await prisma.govCenter.findMany({ where: { country: COUNTRY } })).map(g => g.name));
  let set = 0, already = 0, missing = 0;
  for (const d of await prisma.documentType.findMany({ where: { country: COUNTRY }, orderBy: { name: "asc" } })) {
    const want = d.name in MAP ? MAP[d.name] : undefined;
    if (want === undefined) { console.log(`  ${d.name.padEnd(26)} NOT IN THE MAP — left alone`); missing++; continue; }
    if (want === null) { console.log(`  ${d.name.padEnd(26)} left unset on purpose (issued outside this country)`); continue; }
    // An authority the Authorities screen does not list would be a dead string on the document.
    if (!known.has(want) && !APPLY) { console.log(`  ${d.name.padEnd(26)} -> ${want}  (authority does not exist yet)`); continue; }
    if (d.authority === want) { console.log(`  ${d.name.padEnd(26)} -> ${want.padEnd(22)} already`); already++; continue; }
    if (APPLY) await prisma.documentType.update({ where: { id: d.id }, data: { authority: want } });
    console.log(`  ${d.name.padEnd(26)} -> ${want.padEnd(22)} ${APPLY ? "set" : "would set"}`);
    set++;
  }

  console.log(`\n${set} set · ${already} already correct · ${missing} unmapped`);
  // Document types are not the only thing that names an authority — a workflow step files its work
  // under one too. Checking only the map reported MOFA as unused while the Work Visa Application step
  // was pointing straight at it.
  const fromSteps = new Set<string>();
  for (const t of await prisma.workflowTemplate.findMany({ select: { graph: true } }))
    for (const n of (((t.graph as any)?.nodes ?? []) as any[]))
      if (n?.config?.govCenter) fromSteps.add(String(n.config.govCenter));
  const orphans = (await prisma.govCenter.findMany({ where: { country: COUNTRY } }))
    .filter(g => !Object.values(MAP).includes(g.name) && !fromSteps.has(g.name)).map(g => g.name);
  console.log("authorities nothing points at: " + (orphans.length ? orphans.join(", ") : "none"));
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
