/**
 * PROPOSALS ARE THE FIRM'S OWN WORD FILE, FILLED IN.
 *
 * The brief was "do not change anything in the design", and the cheapest way to honour that is not
 * to redraw the design at all. The firm's `.docx` — its fonts, its page backgrounds, its eleven
 * images, its exact spacing — is uploaded as the template, its `{{tokens}}` are replaced with the
 * quotation's values, and what comes out is their document with this client's name on it.
 *
 * Which also answers "support any proposal" without a designer screen: a second kind of proposal is
 * a second upload. Nothing here knows anything about business setup, MISA or Outland.
 *
 * Delimiters are `{{ }}` rather than the library's single braces, because a proposal full of
 * currency and percentages has enough lone braces in it already.
 */
import { TemplateHandler, TemplateHandlerOptions } from "easy-template-x";
import { prisma } from "./db.js";

const handler = new TemplateHandler(new TemplateHandlerOptions({
  delimiters: { tagStart: "{{", tagEnd: "}}" },
}));

/** Every token a template asks for, so the picker can say what it needs before it is used. */
export async function tokensIn(docx: Buffer): Promise<string[]> {
  const tags = await handler.parseTags(docx);
  return [...new Set(tags.map(t => t.name).filter(Boolean))].sort();
}

export async function renderDocx(docx: Buffer, data: Record<string, unknown>): Promise<Buffer> {
  return handler.process(docx, data as any);
}

// ── Money ─────────────────────────────────────────────────────────────────────

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function under1000(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
  return ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " and " + under1000(n % 100) : "");
}

/**
 * "Thirty-Five Thousand Saudi Riyals Only" — the line the sample proposal prints under its total.
 *
 * Written out here rather than pulled from a package: this is one sentence in one document, and the
 * halala half needs saying in the local idiom ("and Fifty Halalas") which a generic library gets
 * wrong as often as right.
 */
export function amountInWords(minor: number, currency = "SAR"): string {
  const NAMES: Record<string, [string, string]> = {
    SAR: ["Saudi Riyals", "Halalas"], AED: ["UAE Dirhams", "Fils"], USD: ["US Dollars", "Cents"],
  };
  const [major, sub] = NAMES[currency] ?? [currency, "Cents"];
  const whole = Math.floor(Math.abs(minor) / 100);
  const frac = Math.abs(minor) % 100;

  const groups: Array<[number, string]> = [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1000, "Thousand"]];
  let rest = whole;
  const parts: string[] = [];
  for (const [size, label] of groups) {
    if (rest >= size) { parts.push(under1000(Math.floor(rest / size)) + " " + label); rest %= size; }
  }
  if (rest) parts.push(under1000(rest));
  const words = parts.length ? parts.join(" ") : "Zero";
  return `${words} ${major}` + (frac ? ` and ${under1000(frac)} ${sub}` : "") + " Only";
}

const money = (minor: number) => (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/**
 * One date format for the whole document, matching the sample's "06. 10. 2026".
 *
 * The validity line reads as prose ("5th November 2026") and the reference block as digits, so both
 * shapes are offered and the template chooses by which token it uses.
 */
const fmtDots = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(String(iso) + (String(iso).length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(+d)) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}. ${p(d.getUTCMonth() + 1)}. ${d.getUTCFullYear()}`;
};
const fmtLong = (iso?: string | null) => {
  if (!iso) return "";
  const d = new Date(String(iso) + (String(iso).length === 10 ? "T00:00:00Z" : ""));
  if (isNaN(+d)) return String(iso);
  const day = d.getUTCDate();
  const ord = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  return `${day}${ord} ${d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })} ${d.getUTCFullYear()}`;
};

/**
 * Everything a template may ask for, built from the quotation.
 *
 * Deliberately flat and generous: a template is somebody else's Word file, and the cost of offering
 * a token nobody uses is nothing, while the cost of missing one is a document that cannot be
 * produced until a developer adds a line here.
 */
export async function proposalData(quotationId: string): Promise<Record<string, unknown> | null> {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return null;

  const co = q.companyId ? await prisma.company.findUnique({ where: { id: q.companyId } }) : null;
  const org = (await prisma.appSetting.findUnique({ where: { key: "org" } }))?.value as any ?? {};
  const currency = String(org.currency ?? "SAR").split(/[\s—-]/)[0] || "SAR";

  // The owner is whoever the client's work belongs to, falling back to the firm. A proposal signed
  // "presented by" nobody reads as unfinished.
  const ownerId = (co?.roleOwners as any)?.pro_officer ?? null;
  const owner = ownerId ? await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true } }) : null;

  const rawItems: any[] = Array.isArray(q.items) ? (q.items as any[]) : [];
  const items = rawItems.map((it, i) => {
    // `price` is stored in MAJOR units on the line (225 = SAR 225) while the document totals are in
    // minor (22500). Mixing the two is how a proposal prints a hundredth of its own total.
    const units = Number(it.units ?? it.qty ?? 1) || 1;
    const lineMinor = Math.round(Number(it.price ?? 0) * 100) * units;
    return {
      "item.no": String(i + 1),
      "item.description": String(it.name ?? it.description ?? ""),
      "item.units": String(units),
      "item.amount": money(lineMinor),
    };
  });

  // FALL BACK TO THE LINES WHEN THE STORED TOTALS SAY NOTHING.
  //
  // The console's builder computes subtotal/vat/total as you type, but a quotation created any other
  // way — the API, an import, an older row — can carry five priced lines and a total of zero. A
  // proposal that prints "Total 0" and "In Words: Zero Saudi Riyals Only" under five real services
  // is worse than one that refuses to print, so the lines are the fallback and they are already
  // here.
  const linesMinor = items.reduce((a, _it, i) => {
    const raw = rawItems[i] ?? {};
    return a + Math.round(Number(raw.price ?? 0) * 100) * (Number(raw.units ?? raw.qty ?? 1) || 1);
  }, 0);
  const storedTotal = q.totalMinor ?? q.subtotalMinor ?? Math.round(Number(q.amount ?? 0) * 100);
  const totalMinor = storedTotal || linesMinor;
  const subtotalMinor = q.subtotalMinor || totalMinor;

  // A proposal with no schedule recorded still has to print terms, and "all of it, on signing" is
  // the honest reading of no schedule — not a blank page where the payment terms should be.
  const rawMs: any[] = Array.isArray(q.milestones) ? (q.milestones as any[]) : [];
  const milestones = (rawMs.length ? rawMs : [{ label: "upon signing", pct: 100 }]).map(m => {
    const pct = Number(m.pct ?? 0);
    const amountMinor = m.amountMinor != null ? Number(m.amountMinor) : Math.round(totalMinor * (pct / 100));
    return {
      "milestone.label": String(m.label ?? ""),
      "milestone.pct": pct ? String(pct) : "",
      "milestone.amount": money(amountMinor),
    };
  });

  return {
    "client.name": q.clientName ?? co?.name ?? "",
    "client.cr": co?.cr ?? "",
    "client.contact": co?.contact ?? "",
    "client.email": co?.email ?? "",
    "client.phone": co?.phone ?? "",

    "owner.name": owner?.name ?? org.orgName ?? "",
    "owner.email": owner?.email ?? "",

    "org.name": org.legalName ?? org.orgName ?? "",
    "org.vat": org.vat ?? "",
    "org.cr": org.cr ?? "",
    "org.phone": org.supportPhone ?? "",

    "proposal.ref": q.number ?? "",
    "proposal.date": fmtDots(q.date),
    "proposal.dateLong": fmtLong(q.date),
    "proposal.validUntil": fmtLong(q.validUntil),
    "proposal.validUntilShort": fmtDots(q.validUntil),
    "proposal.subject": q.service ?? "",
    "proposal.notes": q.notes ?? "",

    "total.amount": money(totalMinor),
    "total.subtotal": money(subtotalMinor),
    "total.vat": money(q.vatMinor ?? 0),
    "total.words": amountInWords(totalMinor, currency),
    "total.currency": currency,

    items,
    milestones,
  };
}
