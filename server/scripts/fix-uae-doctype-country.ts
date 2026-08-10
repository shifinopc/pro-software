/**
 * Five UAE document types are filed under Saudi Arabia. Move them.
 *
 * WHY THIS IS DATA AND NOT AN EXPORTER BUG. The exporter filters by country and always did. These
 * five rows say `country: "SA"` in the database, so a Saudi pack collected them correctly according
 * to the only fact it had. Emirates ID, Labour Card, Trade License, Establishment Card and Office
 * Ejari Contract are not Saudi documents — Saudi Arabia issues an Iqama, a Commercial Register and a
 * Municipal License, all of which already exist as separate rows.
 *
 * HOW WE KNOW IT IS SAFE. Every one of the five is referenced only by an AE workflow template, which
 * is the other half of the same mistake: the workflows were tagged correctly and the document types
 * they name were not. `Document` rows join by docType NAME, not by id, so the one live Emirates ID
 * document keeps working. The one SA workflow that appeared to reference "Trade License" turned out
 * to have it as a step LABEL ("Trade License Issued"), not as a docType binding — nothing breaks.
 *
 * THE packKey MOVES TOO. It reads `sa.doctype.emirates-id`, and leaving it would give an AE row a
 * key inside Saudi's namespace: install both packs and they would fight over the same row. The
 * exporter now refuses to carry a foreign-prefixed key, but the underlying row should be right.
 *
 * Idempotent, and prints what it would do before doing it. Run with --apply to write.
 */
import { prisma } from "../src/db.js";

const MOVE = ["Emirates ID", "Labour Card", "Trade License", "Establishment Card", "Office Ejari Contract"];

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.documentType.findMany({ where: { name: { in: MOVE } } });

  const missing = MOVE.filter(n => !rows.some(r => r.name === n));
  if (missing.length) console.log(`  not found (already gone, or renamed): ${missing.join(", ")}`);

  let moved = 0;
  for (const r of rows) {
    if (r.country === "AE") { console.log(`  ${r.name.padEnd(24)} already AE — nothing to do`); continue; }
    if (r.country !== "SA") { console.log(`  ${r.name.padEnd(24)} is ${r.country}, not SA — left alone`); continue; }

    // Only rewrite a key that is actually in Saudi's namespace. A locally-made row has none, and a
    // key we do not recognise is somebody else's business.
    const oldKey = r.packKey ?? null;
    const newKey = oldKey && oldKey.startsWith("sa.doctype.") ? "ae.doctype." + oldKey.slice("sa.doctype.".length) : oldKey;

    console.log(`  ${r.name.padEnd(24)} SA → AE   ${oldKey ?? "(no key)"}${newKey !== oldKey ? "  →  " + newKey : ""}${r.retired ? "   [retired — stays retired]" : ""}`);
    if (apply) {
      await prisma.documentType.update({ where: { id: r.id }, data: { country: "AE", packKey: newKey } });
      moved++;
    }
  }

  console.log(apply ? `\n  moved ${moved}` : `\n  dry run — nothing written. Re-run with --apply.`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
