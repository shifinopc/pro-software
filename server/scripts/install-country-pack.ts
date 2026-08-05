/**
 * Install a country pack, from the command line.
 *
 * A thin wrapper over src/packs.ts — the planning and the writing live there because the console needs
 * them too, and two implementations of "what will this do to my configuration" is how a preview ends
 * up disagreeing with the result.
 *
 * Dry run by default; --apply writes; --adopt links rows that already exist here by name.
 *
 * Usage:
 *   npx tsx scripts/install-country-pack.ts pack-sa-2026.1.json [--apply] [--adopt]
 *   (file name only — packs are read from the packs/ folder)
 */
import { prisma } from "../src/db.js";
import { readPack, planInstall, applyInstall, listPacks } from "../src/packs.js";

const file = process.argv[2];
const APPLY = process.argv.includes("--apply");
const ADOPT = process.argv.includes("--adopt");

async function main() {
  if (!file) {
    console.error("Usage: install-country-pack.ts <pack-file.json> [--apply] [--adopt]\n");
    const packs = listPacks();
    if (packs.length) {
      console.error("Available:");
      for (const p of packs) console.error(`  ${p.file}${p.error ? `   (unreadable: ${p.error})` : `   ${p.countryName} ${p.version}`}`);
    } else console.error("No packs found. Export one first.");
    process.exit(1);
  }

  const pack = readPack(file);
  const plan = await planInstall(pack);

  console.log(`\n${plan.countryName} · ${plan.version}   ${APPLY ? "INSTALLING" : "dry run — pass --apply to write"}`);
  console.log(`${pack.contains ?? ""}\n`);

  for (const k of plan.kinds) {
    const bits = [
      k.create.length ? `${k.create.length} new` : "",
      k.installed.length ? `${k.installed.length} already installed` : "",
      k.adopt.length ? `${k.adopt.length} to adopt` : "",
    ].filter(Boolean).join(" · ") || "nothing";
    console.log(`  ${k.label.padEnd(20)} ${bits}`);
  }

  if (plan.totals.adopt) {
    console.log(`\n  ADOPT — these exist here and were made by hand. Your values are kept; the row is`);
    console.log(`  linked to the pack so future updates can reach it, and marked as edited by you.`);
    for (const k of plan.kinds) for (const a of k.adopt) console.log(`    ${k.one.padEnd(18)} ${a.row.name}`);
    if (!ADOPT) console.log(`\n  Not adopting without --adopt. Without it these are left untouched and unmanaged.`);
  }

  if (!APPLY) { console.log(`\n  nothing written\n`); await prisma.$disconnect(); return; }

  const res = await applyInstall(pack, { adopt: ADOPT });
  if (res.unresolved.length) {
    console.log(`\n  ⚠ references left unset rather than pointed at a guess:`);
    for (const u of res.unresolved) console.log(`    ${u}`);
  }
  console.log(`\n  installed — ${res.created} created, ${res.adopted} adopted\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
