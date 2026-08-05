/**
 * Invoice figures, in one place.
 *
 * Every invoice used to store a single whole-riyal `amount`, and the print view divided it back out at
 * whatever the Print Layout VAT rate said that day. Two things were wrong with that on a tax document:
 * the subtotal printed did not match the lines (VAT had been rounded to a whole riyal on save, so the
 * division could not return the original figure), and changing the rate setting silently rewrote the
 * breakdown of every invoice ever issued — including the numbers inside its ZATCA QR.
 *
 * So the figures are computed once, here, in MINOR UNITS with integer arithmetic, and stored on the
 * invoice with the rate frozen beside them.
 */
import { prisma } from "./db.js";

export type InvoiceFigures = { subtotalMinor: number; vatMinor: number; totalMinor: number; vatRateBp: number; amount: number };

/**
 * The KSA standard rate, used when Print Layout has never been saved.
 *
 * This is not a guess for its own sake: the console's Print Layout screen already DISPLAYS 15 as its
 * default, so a fresh install showed "VAT rate 15" while this function returned 0 and every invoice
 * was issued with no VAT at all. Since the rate is now frozen onto each invoice, that would have been
 * permanent rather than something a later settings change could correct. The two defaults have to be
 * the same number or the screen is lying about what will be billed.
 */
const DEFAULT_VAT_RATE = 15;

/** The configured VAT rate as basis points (1500 = 15.00%). Read once per invoice, then frozen on it. */
export async function currentVatRateBp(): Promise<number> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "printLayout" } });
    const raw = ((row?.value ?? {}) as any)?.invoice?.vatRate;
    // Distinguish "never configured" from "deliberately zero-rated". A plain `|| DEFAULT` would
    // silently overwrite a considered 0% with 15%, which is the more expensive mistake of the two.
    const unset = raw === undefined || raw === null || raw === "";
    const rate = unset ? DEFAULT_VAT_RATE : Number(raw);
    return Math.round((Number.isFinite(rate) ? rate : DEFAULT_VAT_RATE) * 100);
  } catch {
    return Math.round(DEFAULT_VAT_RATE * 100);
  }
}

/**
 * Split a VAT-INCLUSIVE total into its parts.
 *
 * Inclusive, deliberately: it is how the print view has always read the stored amount, so every
 * existing caller keeps billing exactly what it billed before. Whether a fee configured on a workflow
 * step should instead be treated as ex-VAT is a pricing decision, not a rounding one — it would change
 * what clients are charged, so it is not being changed quietly here.
 */
export function figuresFromGross(grossMinor: number, vatRateBp: number): InvoiceFigures {
  const total = Math.max(0, Math.round(grossMinor));
  const subtotal = vatRateBp > 0 ? Math.round((total * 10000) / (10000 + vatRateBp)) : total;
  return {
    subtotalMinor: subtotal,
    vatMinor: total - subtotal,
    totalMinor: total,
    vatRateBp,
    // Whole units, for the reports/dunning/lists that read `amount`. Derived here so there is one writer.
    amount: Math.round(total / 100),
  };
}

/** Convenience for the callers that hold a whole-currency amount (the shape every one of them has). */
export async function figuresFromAmount(amount: number): Promise<InvoiceFigures> {
  return figuresFromGross(Math.round((Number(amount) || 0) * 100), await currentVatRateBp());
}

/**
 * Split an amount the author declared to be EX-VAT: VAT is added on top.
 *
 * The mirror of `figuresFromGross`. A workflow step's fee is the one amount in the system whose
 * meaning is genuinely ambiguous — SAR 500 might be what the client pays, or what we charge before
 * tax — so the node says which, and this is the branch for "before tax".
 */
export function figuresFromNet(netMinor: number, vatRateBp: number): InvoiceFigures {
  const subtotal = Math.max(0, Math.round(netMinor));
  const vat = Math.round((subtotal * vatRateBp) / 10000);
  const total = subtotal + vat;
  return { subtotalMinor: subtotal, vatMinor: vat, totalMinor: total, vatRateBp, amount: Math.round(total / 100) };
}

/**
 * Figures for an amount whose VAT treatment the author chose.
 *
 * `includesVat` defaults to true because that is how every existing caller has always been read —
 * flipping the default would silently change what clients are charged on flows already in use.
 */
export async function figuresForFee(amount: number, includesVat: boolean): Promise<InvoiceFigures> {
  const minor = Math.round((Number(amount) || 0) * 100);
  const rateBp = await currentVatRateBp();
  return includesVat ? figuresFromGross(minor, rateBp) : figuresFromNet(minor, rateBp);
}
