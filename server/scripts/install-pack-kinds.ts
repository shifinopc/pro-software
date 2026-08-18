/**
 * Install SOME of a country pack, not all of it.
 *
 * install-country-pack.ts is all-or-nothing, which is right for a new market and wrong for a repair.
 * This installation deliberately keeps one workflow; the SA pack carries eighteen. Installing the
 * pack to recover its document types would have quietly restored seventeen workflows somebody had
 * removed on purpose — the dry run said "17 new" and that is the only reason it was caught.
 *
 * So: name the kinds you want. Everything else in the pack is left alone.
 *
 * Only kinds with no outgoing references are safe to install in isolation, because reference wiring
 * is deliberately NOT run here — a pack half-installed and then wired would point services at
 * workflows this installation does not have. Document types are the safe case: everything points at
 * them, they point at nothing.
 *
 * Dry run by default; --apply writes.
 *
 *   npx tsx scripts/install-pack-kinds.ts pack-sa-2026.2.json documentTypes [--apply]
 */
import { prisma } from "../src/db.js";
import { readPack, planInstall, KINDS } from "../src/packs.js";

const WIRED = new Set(["serviceItems", "workflowTemplates", "checklistRules"]);

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const [file, ...want] = args.filter(a => !a.startsWith("--"));
  if (!file || !want.length) {
    console.error("Usage: install-pack-kinds.ts <pack-file.json> <kind> [kind...] [--apply]");
    console.error("Kinds: " + KINDS.map(k => k.key).join(", "));
    process.exit(1);
  }

  const unknown = want.filter(w => !KINDS.some(k => k.key === w));
  if (unknown.length) { console.error("No such kind: " + unknown.join(", ")); process.exit(1); }
  const wired = want.filter(w => WIRED.has(w));
  if (wired.length) {
    console.error(`${wired.join(", ")} carries references to other rows, which this script does not wire.`);
    console.error("Install the whole pack, or accept that those references arrive unset.");
    process.exit(1);
  }

  const pack = readPack(file);
  const plan = await planInstall(pack);
  console.log(`\n${plan.countryName} \u00b7 ${plan.version}   ${APPLY ? "INSTALLING" : "dry run \u2014 pass --apply to write"}`);
  console.log(`  installing only: ${want.join(", ")}\n`);

  let created = 0;
  for (const key of want) {
    const kind = KINDS.find(k => k.key === key)!;
    const kp = plan.kinds.find(k => k.key === key)!;
    console.log(`  ${kind.label.padEnd(20)} ${kp.create.length} new \u00b7 ${kp.installed.length} already installed \u00b7 ${kp.adopt.length} matching by name (left alone)`);
    for (const a of kp.adopt) console.log(`      leaving your "${a.existingName}" untouched`);
    if (!APPLY) continue;
    const model = (prisma as any)[kind.model];
    for (const r of kp.create) {
      await model.create({ data: { ...kind.fields(r), country: pack.country, packKey: r.key, packVersion: pack.version, packModified: false } });
      created++;
    }
  }

  const skipped = plan.kinds.filter(k => !want.includes(k.key) && k.create.length);
  if (skipped.length) {
    console.log(`\n  NOT installed (would have been, by a full install):`);
    for (const k of skipped) console.log(`    ${String(k.create.length).padStart(3)}  ${k.label}`);
  }

  console.log(APPLY ? `\n  ${created} rows created\n` : `\n  nothing written\n`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
