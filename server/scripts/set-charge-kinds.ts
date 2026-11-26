/**
 * WHICH FEE EACH CHARGE TYPE IS — the column the whole staged-billing feature reads.
 *
 * `ChargeType.kind` is what sorts a quotation line into professional, government or foreign company
 * fees, and a payment term set bills against exactly that: "100% of Foreign Company Fees on signing,
 * 50% of Professional Fees". The line's kind is stamped from its charge type.
 *
 * WITH kind NULL THE FEATURE MIS-BILLS SILENTLY. linesOfKind reads
 * `String(l?.kind ?? "prof") === kind`, so a line with no kind counts as a PROFESSIONAL fee. A term
 * set naming foreign company fees then matches no lines at all: that stage's base is zero, it bills
 * nothing, and the stage-invoice route refuses it as "a percentage of a fee the quotation does not
 * carry" — while every government and foreign fee quietly joins the professional ladder and is
 * billed 50/30/20 instead of up front.
 *
 * Found by reconciling live against local after a deploy: all four live charge types had kind NULL,
 * and nothing anywhere said so, because a null here is indistinguishable from "professional".
 *
 * The mapping is BY NAME and stated here rather than inferred, because it is a statement about the
 * firm's money. "Company Formation" is foreign on purpose: on these deals it is the formation of the
 * shell companies in the other jurisdiction, paid to that jurisdiction — not the Saudi setup work,
 * which is the professional fee. Anything not listed is left alone.
 *
 * Dry run by default.
 *   npx tsx scripts/set-charge-kinds.ts [--apply]
 */
import { prisma } from "../src/db.js";

const KIND: Record<string, string> = {
  "professional fees": "prof",
  "government fees": "gov",
  "acquisition": "foreign",
  "company acquisition": "foreign",
  "company formation": "foreign",
};

async function main() {
  const apply = process.argv.includes("--apply");
  const rows = await prisma.chargeType.findMany({ select: { id: true, name: true, kind: true, vatTreatment: true, retired: true } });
  if (!rows.length) { console.log("no charge types here"); return; }

  const plan = rows.map(r => {
    const want = KIND[String(r.name).trim().toLowerCase()];
    return { ...r, want, change: !!want && String(r.kind ?? "") !== want };
  });

  for (const r of plan) {
    const state = `kind=${r.kind ?? "(null)"} vat=${r.vatTreatment ?? "(null)"}`;
    if (!r.want) console.log(`  "${r.name}"  ${state}  — not in the mapping, left alone`);
    else if (!r.change) console.log(`  "${r.name}"  ${state}  — already ${r.want}`);
    else console.log(`→ "${r.name}"  ${state}  →  kind=${r.want}`);
  }

  const todo = plan.filter(r => r.change);
  if (!todo.length) { console.log("\nnothing to change"); return; }
  if (!apply) { console.log(`\n(dry run — ${todo.length} to change, pass --apply to write)`); return; }

  for (const r of todo) await prisma.chargeType.update({ where: { id: r.id }, data: { kind: r.want! } });
  console.log(`\nset kind on ${todo.length} charge type(s)`);

  /**
   * THE LINES ALREADY WRITTEN KEEP THEIR OWN KIND.
   *
   * A quotation line stores the kind it was stamped with, so correcting the catalogue does not
   * reclassify documents already issued — which is right: a quotation the client was sent must not
   * change what it billed because somebody fixed a dropdown afterwards. Said out loud because the
   * opposite is the obvious assumption, and because it means any quotation raised while this was
   * null still has every line on the professional ladder.
   */
  const stale = await prisma.quotation.count({ where: { items: { not: undefined } } });
  console.log(`note: ${stale} existing quotation(s) keep the kinds their lines were stamped with — correct the lines, not the catalogue, if any of them billed the wrong ladder`);
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
