/**
 * RE-RATE THE DRAFTS THAT TAX A LINE NOBODY TAXES ANY MORE.
 *
 *   npx tsx scripts/rerate-untaxed-drafts.ts                  # says what it would do
 *   npx tsx scripts/rerate-untaxed-drafts.ts --apply          # does it
 *   npx tsx scripts/rerate-untaxed-drafts.ts --apply --live   # …on a non-local database
 *
 * Marking a charge type "outside VAT" changes what the composers compute from now on; it does not
 * touch a document already stored, because a document freezes its own figures. That is right for
 * anything issued and wrong for a DRAFT, which is still an offer nobody has seen: left alone it
 * would be approved later carrying VAT on money the firm merely collects for the ministry.
 *
 * So this re-rates drafts only. A sent quotation is not touched — the client holds the old figure
 * and the honest fix is a revision they receive. An invoiced one is not touched either: it is the
 * record of what was converted. Both are reported and skipped rather than quietly fixed.
 *
 * THE DERIVATION IS A COPY OF vat-per-line-check's, deliberately not imported: that script is the
 * independent check on this one, and the two must be able to disagree. Run it afterwards — if this
 * wrote a figure the audit would not have derived, the audit still says so.
 *
 * WHAT IT WRITES
 *   vatMinor    = round(taxable base × the document's own frozen rate)
 *   totalMinor  = subtotal + that
 *   amount      = the whole-unit copy every report and list reads
 *   items[].vat = "outside" on the lines that are not taxed, so the document stops depending on the
 *                 catalogue. Re-rate Government Fees back to standard tomorrow and these keep the
 *                 treatment they were re-rated under, which is what a frozen document means.
 *   the "VAT (15%)" line, where the invoice composer wrote the tax as a line of its own
 *
 * It REFUSES a document whose stored subtotal does not equal the sum of its own lines. That is a
 * different fault from this one, and a tool that silently "fixes" it would be writing a total
 * nobody derived.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("rerate-untaxed-drafts");
const APPLY = process.argv.includes("--apply");

type Line = { name?: string; units?: number; price?: number; vat?: string };

const minor = (l: Line) => Math.round((Number(l.units) || 1) * Math.round((Number(l.price) || 0) * 100));
const isVatLine = (l: Line) => /^VAT\s*\(/i.test(String(l.name ?? ""));

async function main() {
  const catalogue = new Map<string, string>();
  const types: any[] = await prisma.$queryRawUnsafe(
    "select name, coalesce(vatTreatment,'standard') as vatTreatment from ChargeType");
  for (const c of types) catalogue.set(String(c.name).trim().toLowerCase(), String(c.vatTreatment));
  const treatment = (l: Line) =>
    String(l.vat ?? "").trim() || catalogue.get(String(l.name ?? "").trim().toLowerCase()) || "standard";

  let fixed = 0, skipped = 0, refused = 0, freedMinor = 0;
  const done: string[] = [], held: string[] = [], bad: string[] = [];

  for (const kind of ["quotation", "invoice"] as const) {
    const docs: any[] = await (prisma as any)[kind].findMany();
    for (const d of docs) {
      if (d.totalMinor == null || d.vatRateBp == null) continue;
      const items: Line[] = Array.isArray(d.items) ? d.items : [];
      if (!items.length) continue;

      const lines = items.filter(l => !isVatLine(l));
      const base = lines.filter(l => treatment(l) === "standard").reduce((n, l) => n + minor(l), 0);
      const want = Math.round((base * Number(d.vatRateBp)) / 10000);
      const got = Number(d.vatMinor ?? 0);
      if (want === got) continue;

      const label = `${String(d.number ?? d.id).padEnd(14)} ${String(d.status).padEnd(9)}`;

      // Only a draft. Anything else is somebody else's copy of the truth.
      if (String(d.status).toLowerCase() !== "draft") {
        skipped++;
        held.push(`  ${label} VAT ${(got / 100).toFixed(2)} → would be ${(want / 100).toFixed(2)}  — left alone`);
        continue;
      }

      // The stored subtotal must be the sum of the lines, or the document has a second fault and
      // re-rating it would bury that one under this one.
      const sumLines = lines.reduce((n, l) => n + minor(l), 0);
      if (Number(d.subtotalMinor ?? -1) !== sumLines) {
        refused++;
        bad.push(`  ${label} subtotal ${(Number(d.subtotalMinor ?? 0) / 100).toFixed(2)} ≠ lines ${(sumLines / 100).toFixed(2)}  — REFUSED`);
        continue;
      }

      const total = sumLines + want;
      const nextItems = items.map(l => {
        if (isVatLine(l)) return { ...l, name: `VAT (${Number(d.vatRateBp) / 100}%)`, units: 1, price: want / 100 };
        const t = treatment(l);
        return t === "standard" ? l : { ...l, vat: t };
      });

      fixed++;
      freedMinor += got - want;
      done.push(`  ${label} VAT ${(got / 100).toFixed(2).padStart(9)} → ${(want / 100).toFixed(2).padStart(9)}` +
        `   total ${(Number(d.totalMinor) / 100).toFixed(2).padStart(10)} → ${(total / 100).toFixed(2).padStart(10)}`);

      if (APPLY) {
        await (prisma as any)[kind].update({
          where: { id: d.id },
          // Guarded on the figures expected, the same way the SQL passes were: a document that has
          // moved on since the audit is left for a human.
          data: { vatMinor: want, totalMinor: total, amount: Math.round(total / 100), items: nextItems },
        });
      }
    }
  }

  if (done.length) console.log(`\ndrafts re-rated:\n${done.join("\n")}`);
  if (held.length) console.log(`\nnot drafts — reported, not touched:\n${held.join("\n")}`);
  if (bad.length) console.log(`\nrefused:\n${bad.join("\n")}`);
  console.log(`\n${fixed} draft${fixed === 1 ? "" : "s"} ${APPLY ? "re-rated" : "would be re-rated"}` +
    `, removing ${(freedMinor / 100).toFixed(2)} of VAT that was charged on untaxed lines.` +
    `\n${skipped} issued or sent document${skipped === 1 ? "" : "s"} left alone` +
    (refused ? `, ${refused} refused.` : "."));
  if (!APPLY) console.log("\ndry run — nothing written. Add --apply.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
