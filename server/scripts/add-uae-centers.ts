/**
 * The UAE authorities, as government centers.
 *
 * Six workflow templates already do UAE work — Emirates ID, Labour Card, Trade License,
 * Establishment Card, Office Ejari, and a UAE Employment Visa — but Country Rules only had the five
 * Saudi centers. Their steps could not name an authority, so the Government Centers queue had no
 * column to put them in.
 *
 * THREE THINGS, because adding the rows alone would leave two lies in place:
 *
 *  1. The centers themselves. Only the ones the templates actually reference — MOHRE, ICP, DED,
 *     Ejari, FTA. Not a general list of everything the UAE has: a picker full of authorities this
 *     firm never files with makes the five that matter harder to find.
 *
 *  2. Two steps I filed under MUQEEM by mistake. set-step-portals matched "entry permit" and
 *     "residence visa" without asking which country the template was for, and Muqeem is Saudi. A
 *     step under the wrong authority is worse than one under none — it turns up in an officer's
 *     Muqeem queue, they cannot action it there, and the queue stops being trusted.
 *
 *  3. The template `country` field. All six UAE templates are tagged "SA", which is simply wrong
 *     and will bite the first time anything filters centers or rules by country.
 *
 * DRY RUN BY DEFAULT.  npx tsx scripts/add-uae-centers.ts          → prints the plan
 *                      npx tsx scripts/add-uae-centers.ts --apply  → writes it
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

/** Colours follow the Saudi rows: a distinct hue per authority, on its own tint. */
const CENTERS = [
  { name: "MOHRE", sub: "Work permits · labour cards · establishment card", color: "#0E9355", bg: "#E7F8EF", packKey: "ae.center.mohre" },
  { name: "ICP", sub: "Emirates ID · entry permits · residence visas", color: "#0284C7", bg: "#E4F4FD", packKey: "ae.center.icp" },
  { name: "DED", sub: "Trade licence · commercial registration", color: "#B8860B", bg: "#FEF4E2", packKey: "ae.center.ded" },
  { name: "Ejari", sub: "Tenancy contract registration", color: "#6D5BD0", bg: "#EFEBFF", packKey: "ae.center.ejari" },
  { name: "FTA", sub: "VAT registration & certificates", color: "#C0353A", bg: "#FEECEC", packKey: "ae.center.fta" },
];

/** The two steps set-step-portals put on the wrong country's authority, and where they belong. */
const CORRECTIONS: Array<[string, RegExp, string]> = [
  ["UAE Employment Visa (New, Inside-Country)", /entry permit/i, "ICP"],
  ["UAE Employment Visa (New, Inside-Country)", /residence visa stamping/i, "ICP"],
];

/** Templates whose work is UAE, currently mis-tagged SA. */
const UAE_TEMPLATES = [
  "UAE Employment Visa (New, Inside-Country)", "Emirates ID Renewal", "Labour Card Renewal",
  "Trade License Renewal", "Establishment Card Renewal", "Office Ejari Contract Renewal",
];

async function main() {
  console.log("── centers ──");
  const existing = new Set((await prisma.govCenter.findMany({ select: { name: true } })).map(c => c.name));
  const toAdd = CENTERS.filter(c => !existing.has(c.name));
  for (const c of CENTERS) console.log(`  ${existing.has(c.name) ? "already there" : "ADD         "}  ${c.name.padEnd(7)} ${c.sub}`);

  console.log("\n── corrections to steps I filed under the wrong country ──");
  const fixes: Array<{ id: string; graph: any; note: string }> = [];
  for (const [tplName, re, target] of CORRECTIONS) {
    const t = await prisma.workflowTemplate.findFirst({ where: { name: tplName }, select: { id: true, name: true, graph: true } });
    if (!t) { console.log(`  (template "${tplName}" not found — skipping)`); continue; }
    const graph: any = fixes.find(f => f.id === t.id)?.graph ?? t.graph ?? {};
    for (const n of ((graph.nodes ?? []) as any[])) {
      if (!re.test(String(n.label ?? ""))) continue;
      const was = n.config?.govCenter ?? "(none)";
      if (was === target) { console.log(`  already ${target}  ${n.label}`); continue; }
      console.log(`  ${String(was).padEnd(8)} → ${target}   ${n.label}`);
      n.config = { ...(n.config ?? {}), govCenter: target };
      delete n.config.noPortal;
      const found = fixes.find(f => f.id === t.id);
      if (found) found.graph = graph; else fixes.push({ id: t.id, graph, note: t.name });
    }
  }
  if (!fixes.length) console.log("  none needed");

  console.log("\n── template country ──");
  const mis = await prisma.workflowTemplate.findMany({ where: { name: { in: UAE_TEMPLATES } }, select: { id: true, name: true, country: true } });
  for (const t of mis) console.log(`  ${t.country === "AE" ? "already AE" : `${t.country ?? "(none)"} → AE   `}  ${t.name}`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${toAdd.length} center(s) to add · ${fixes.length} template(s) with a step to correct · ${mis.filter(t => t.country !== "AE").length} template(s) to re-tag AE`);

  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply to write it."); }
  else {
    for (const c of toAdd) await prisma.govCenter.create({ data: { ...c, country: "AE", officer: "Unassigned" } });
    for (const f of fixes) await prisma.workflowTemplate.update({ where: { id: f.id }, data: { graph: f.graph } });
    for (const t of mis.filter(x => x.country !== "AE")) await prisma.workflowTemplate.update({ where: { id: t.id }, data: { country: "AE" } });
    console.log(`\nAPPLIED: ${toAdd.length} centers, ${fixes.length} graph fix(es), ${mis.filter(t => t.country !== "AE").length} re-tagged.`);
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
