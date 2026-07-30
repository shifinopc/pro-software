/**
 * Reconstruct stored figures on invoices and quotations issued before the minor-unit columns existed.
 *
 * The first pass at this split the stored gross as if it were VAT-inclusive. That preserved the total
 * but left the printed subtotal disagreeing with the document's own line items — which is the exact
 * complaint the columns were added to answer. So the line items lead here:
 *
 *   - lines sum == stored gross     → VAT was never added on top. Subtotal = lines, VAT 0, rate 0.
 *                                     The total is unchanged, so a paid invoice still reconciles.
 *   - lines sum + VAT ≈ stored gross → VAT was added and then rounded to a whole unit on save.
 *                                     Subtotal = lines, VAT recomputed exactly. The total moves by
 *                                     under a unit — that movement IS the correction.
 *   - no line items                  → nothing to contradict the inclusive reading; split the gross
 *                                     and keep the total exactly as issued.
 *
 * Idempotent: re-running recomputes the same values. Safe to run against live.
 */
import { prisma } from "../src/db.js";
import { currentVatRateBp, figuresFromGross } from "../src/money.js";
import { logAudit } from "../src/auth.js";

const minor = (n: any) => Math.round((Number(n) || 0) * 100);
const sumLines = (items: any) =>
  (Array.isArray(items) ? items : []).reduce(
    (a: number, it: any) => a + Math.round((Number(it?.units) || 1) * minor(it?.price)),
    0,
  );

type Figures = { subtotalMinor: number; vatMinor: number; totalMinor: number; vatRateBp: number; amount: number };

function reconstruct(grossUnits: any, items: any, rateBp: number): { figures: Figures; basis: string } {
  const gross = minor(grossUnits);
  const lines = sumLines(items);

  if (lines <= 0) {
    return { figures: figuresFromGross(gross, rateBp), basis: "no line items — gross split as VAT-inclusive" };
  }

  const vat = Math.round((lines * rateBp) / 10000);
  const withVat = lines + vat;
  const noVat = () => ({
    figures: { subtotalMinor: lines, vatMinor: 0, totalMinor: lines, vatRateBp: 0, amount: Math.round(lines / 100) },
    basis: "gross equals the lines — no VAT was charged",
  });
  const addedVat = () => ({
    figures: { subtotalMinor: lines, vatMinor: vat, totalMinor: withVat, vatRateBp: rateBp, amount: Math.round(withVat / 100) },
    basis: `VAT was added and rounded on save — recomputed at ${rateBp / 100}%`,
  });

  // Ordered by strength of evidence: an exact match settles it. The tolerances exist only because the
  // old code rounded the gross to whole units, and at small amounts both readings can fall inside one
  // unit of the gross — hence exact first, so an ambiguous case is decided by the stronger match.
  if (gross === lines) return noVat();
  if (gross === withVat) return addedVat();
  if (Math.abs(gross - lines) <= 100) return noVat();
  if (Math.abs(gross - withVat) <= 100) return addedVat();
  // Matches neither reading: leave the total exactly as issued and split it, rather than guess.
  return { figures: figuresFromGross(gross, rateBp), basis: "gross matches neither reading — split as VAT-inclusive" };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rateBp = await currentVatRateBp();
  console.log(`VAT rate: ${rateBp / 100}%  ${apply ? "— APPLYING" : "— dry run, pass --apply to write"}\n`);

  for (const kind of ["invoice", "quotation"] as const) {
    const rows: any[] = kind === "invoice"
      ? await prisma.invoice.findMany({ select: { id: true, number: true, status: true, amount: true, items: true, subtotalMinor: true, vatMinor: true, totalMinor: true, vatRateBp: true } })
      : await prisma.quotation.findMany({ select: { id: true, number: true, status: true, amount: true, items: true, subtotalMinor: true, vatMinor: true, totalMinor: true, vatRateBp: true } });

    console.log(`── ${kind}s (${rows.length}) ──`);
    for (const r of rows) {
      const { figures, basis } = reconstruct(r.amount, r.items, rateBp);
      const same = r.subtotalMinor === figures.subtotalMinor && r.vatMinor === figures.vatMinor && r.totalMinor === figures.totalMinor && r.vatRateBp === figures.vatRateBp;
      const f = (n: number) => (n / 100).toFixed(2);
      console.log(
        `  ${r.number} (${r.status})  sub ${f(figures.subtotalMinor)} + VAT ${f(figures.vatMinor)} = ${f(figures.totalMinor)} @${figures.vatRateBp}bp` +
        `${same ? "  [unchanged]" : `  [was ${r.totalMinor == null ? "nothing stored" : `sub ${f(r.subtotalMinor)} / tot ${f(r.totalMinor)}`}]`}\n      ${basis}`,
      );
      if (apply && !same) {
        if (kind === "invoice") await prisma.invoice.update({ where: { id: r.id }, data: figures });
        else await prisma.quotation.update({ where: { id: r.id }, data: figures });
        // The reconstruction belongs in the audit trail, not in `notes` — notes print on the document
        // the client receives, and a client's invoice should not carry our bookkeeping remarks.
        await logAudit({
          action: `${kind}.figures_backfilled`, target: r.id,
          detail: `${r.number}: ${basis} → ${f(figures.subtotalMinor)} + ${f(figures.vatMinor)} = ${f(figures.totalMinor)}`,
        });
      }
    }
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
