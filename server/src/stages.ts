/**
 * PAYMENT STAGES, AS MONEY RATHER THAN AS A SENTENCE ON A PROPOSAL.
 *
 * A quotation carries its schedule — "50% of professional fees on signing, 100% of the foreign
 * company fee, 30% on the MISA licence" — and until now that schedule was PRINTED and nothing else.
 * Accepting raised ONE invoice for the whole amount, so a client who paid exactly what the terms
 * asked for was recorded as part-paying a bill nobody had sent them in that shape. The system could
 * not answer "is the acquisition paid?" because there was no document that said acquisition.
 *
 * So the stages become invoices. Each one bills the LINES it is a percentage of, scaled, which is
 * what makes the VAT right: a stage against government fees carries the government-fee lines and
 * therefore their tax treatment, and a stage against professional fees carries theirs.
 *
 * ONE OWNER FOR THE ARITHMETIC. proposal.ts had its own copy of "what is 50% of professional fees",
 * and a printed schedule that disagreed with the invoices raised from it would be worse than no
 * schedule at all — the client holds the first and pays against the second. Both now call in here.
 */
import { prisma } from "./db.js";

/** A line as it is stored on a quotation or an invoice. Everything is optional because older rows. */
export type Line = { name?: string; units?: number | string; price?: number | string; kind?: string; vat?: string; country?: string; disc?: number | string };

/** The line at list price, before anything is taken off it. Integer arithmetic, per money.ts. */
export const lineGrossMinor = (l: Line): number =>
  Math.round(Number(l?.price ?? 0) * 100) * (Number(l?.units ?? 1) || 1);

/**
 * WHAT IS TAKEN OFF THIS LINE.
 *
 * `disc` is an amount off the LINE, in major units, never a per-unit price cut and never a
 * percentage — a percentage typed in the console is resolved to money there, once, so that the
 * stored document says what was agreed rather than a rule to re-evaluate. Clamped to the line
 * itself: a discount larger than what it comes off would flip the line negative and every stage
 * billed against that fee with it.
 *
 * A line whose own price is negative — the older way a discount was written here — has nothing to
 * discount, so the clamp floors at zero and leaves it exactly as it was.
 */
export const lineDiscMinor = (l: Line): number => {
  const d = Math.round(Number(l?.disc ?? 0) * 100);
  if (!Number.isFinite(d) || d <= 0) return 0;
  return Math.min(d, Math.max(0, lineGrossMinor(l)));
};

/**
 * WHAT ONE LINE COMES TO — the one place that answers it.
 *
 * Every figure on a quotation or an invoice is a sum of these: the VAT base, each payment stage's
 * share of its own fee kind, the stage invoices, the printed proposal. A discount subtracted
 * anywhere other than here would have to be subtracted in all of them, and the ones it was missed
 * in would disagree with the client's copy.
 */
export const lineMinor = (l: Line): number => lineGrossMinor(l) - lineDiscMinor(l);

/**
 * The composer appends "VAT (15%)" as a line so the stored `amount` stays the grand total. It is a
 * total, not a thing to bill or to tax, and every reader has to skip it — the invoice editor strips
 * it on the way back in for exactly the same reason.
 */
export const isVatLine = (l: Line): boolean => /^VAT\s*\(/i.test(String(l?.name ?? ""));

/** The lines of one fee kind. A line with no kind is professional — that is the historic default. */
export const linesOfKind = (items: Line[], kind: string): Line[] =>
  items.filter(l => !isVatLine(l) && String(l?.kind ?? "prof") === kind);

/**
 * WHAT A STAGE IS A PERCENTAGE OF.
 *
 * `total` is the whole quotation. Anything else is a fee kind, and a kind this quotation does not
 * carry is worth ZERO rather than the whole total — answering "the total" for a kind it had not
 * heard of is how a stage meant to collect a 4,000 government fee billed the entire deal.
 *
 * With no lines at all there is nothing to split, so every basis falls back to the total: a
 * quotation carrying only a figure still produces a schedule that foots up to it.
 */
export function baseMinor(items: Line[], basis: string, totalMinor: number): number {
  const real = items.filter(l => !isVatLine(l));
  if (!real.length) return totalMinor;
  if (!basis || basis === "total") return real.reduce((a, l) => a + lineMinor(l), 0);
  return linesOfKind(real, basis).reduce((a, l) => a + lineMinor(l), 0);
}

export type Stage = {
  index: number;
  label: string;
  pct: number;
  basis: string;
  /** The lines this stage bills, at this stage's share of each. */
  lines: Line[];
  /** What the stage asks for, before VAT. */
  subtotalMinor: number;
};

/**
 * THE SCHEDULE AS A LIST OF BILLS.
 *
 * Each stage bills its share of the lines its basis names. Scaling the LINES rather than inventing
 * one line called "50% of professional fees" is what keeps the tax right — every line arrives on
 * the stage invoice carrying its own kind and its own frozen VAT treatment.
 *
 * THE LAST STAGE OF EACH BASIS COLLECTS THE REMAINDER, not its percentage. 50/30/20 of a fee
 * ending in an odd halala does not foot to the fee: three roundings leave the client a halala
 * short or over, for ever, and the quotation it came from says otherwise. So every earlier stage
 * rounds and the final one is handed what is left — which is also how anybody doing this by hand
 * would do it.
 */
export function planStages(items: Line[], milestones: any[], totalMinor: number): Stage[] {
  const ms = Array.isArray(milestones) ? milestones : [];
  if (!ms.length) return [];

  // Which stage is the last one against each basis, so it can absorb the rounding.
  const lastOf = new Map<string, number>();
  ms.forEach((m, i) => lastOf.set(String(m?.basis ?? "total"), i));
  const spent = new Map<string, number>();

  return ms.map((m, index) => {
    const basis = String(m?.basis ?? "total");
    const pct = Number(m?.pct ?? 0) || 0;
    const base = baseMinor(items, basis, totalMinor);
    const already = spent.get(basis) ?? 0;
    // A stage agreed as a flat sum keeps it; otherwise the percentage, or the remainder if last.
    const want = m?.amountMinor != null
      ? Number(m.amountMinor)
      : (lastOf.get(basis) === index ? Math.max(0, base - already) : Math.round(base * (pct / 100)));
    spent.set(basis, already + want);

    const source = (!items.filter(l => !isVatLine(l)).length || basis === "total" || !basis)
      ? items.filter(l => !isVatLine(l))
      : linesOfKind(items, basis);
    const sourceTotal = source.reduce((a, l) => a + lineMinor(l), 0);
    // Each line at this stage's share of it. The share is want/sourceTotal rather than the raw
    // percentage so that a remainder stage and a flat-sum stage scale their lines correctly too.
    let allocated = 0;
    const lines: Line[] = source.map((l, i) => {
      const exact = sourceTotal > 0 ? Math.round((lineMinor(l) * want) / sourceTotal) : 0;
      // Same remainder rule one level down, so the lines foot to the stage.
      const minor = i === source.length - 1 ? Math.max(0, want - allocated) : exact;
      allocated += minor;
      /**
       * THE LIST PRICE AND THE DISCOUNT, BOTH, ON THE STAGE'S LINE.
       *
       * `minor` is this stage's share of what the line is WORTH — already net of its discount,
       * because baseMinor and the allocation above both work in lineMinor(). Writing that as the
       * price and nothing else is arithmetically right and reads as a cheaper fee: the quotation
       * said "50,000.00 less 375.94" and the invoice raised from it said "49,624.06", so the
       * concession the client was given vanished between the two documents.
       *
       * So the share is split back into the two figures it came from. The discount travels as the
       * SAME FRACTION of this line that is being billed, and the price is the net share plus it —
       * which makes `lineMinor` of this line exactly `minor` again, by construction. Every total
       * downstream is untouched; only the document can now show the subtraction.
       *
       * A line with nothing left to bill divides by zero, so that case carries no discount either.
       */
      const netOfLine = lineMinor(l);
      const discShare = netOfLine > 0 ? Math.round((lineDiscMinor(l) * minor) / netOfLine) : 0;
      return { ...l, units: 1, price: (minor + discShare) / 100, disc: discShare / 100 };
    }).filter(l => lineMinor(l) > 0);

    return { index, label: String(m?.label ?? "").trim(), pct, basis, lines, subtotalMinor: want };
  });
}

/**
 * WHAT VAT A SET OF LINES ACTUALLY CARRIES, decided HERE and not in the browser.
 *
 * The console works this out per line already; a stage invoice is raised by the server, where the
 * browser's answer is not available — and a figure the server can only get by asking the browser is
 * a figure the server cannot defend. Same rule, same order: the treatment FROZEN on the line wins,
 * then the catalogue by name, then "standard", which is how every document written before any of
 * this behaved.
 */
export async function figuresForLines(lines: Line[], vatRateBp: number) {
  const real = lines.filter(l => !isVatLine(l));
  const names = [...new Set(real.map(l => String(l?.name ?? "").trim().toLowerCase()).filter(Boolean))];
  const types = names.length
    ? await prisma.chargeType.findMany({ where: { retired: false }, select: { name: true, vatTreatment: true } })
    : [];
  const byName = new Map(types.map(t => [String(t.name).trim().toLowerCase(), String((t as any).vatTreatment ?? "standard")]));
  const treatmentOf = (l: Line) =>
    String(l?.vat ?? "").trim() || byName.get(String(l?.name ?? "").trim().toLowerCase()) || "standard";

  const subtotalMinor = real.reduce((a, l) => a + lineMinor(l), 0);
  const taxedMinor = real.reduce((a, l) => (treatmentOf(l) === "standard" ? a + lineMinor(l) : a), 0);
  const vatMinor = Math.round((taxedMinor * vatRateBp) / 10000);
  const totalMinor = subtotalMinor + vatMinor;
  return { subtotalMinor, taxedMinor, vatMinor, totalMinor, vatRateBp, amount: Math.round(totalMinor / 100) };
}
