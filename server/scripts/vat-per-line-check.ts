/**
 * VAT IS CHARGED ON THE TAXABLE LINES, NOT ON THE WHOLE DOCUMENT.
 *
 *   npx tsx scripts/vat-per-line-check.ts            # audits whatever database it is pointed at
 *   npx tsx scripts/vat-per-line-check.ts --live     # …including a non-local one
 *
 * One rate multiplied the whole subtotal, so a quotation of professional fees PLUS government fees
 * charged 15% on both — including money the firm collects and hands to the ministry, which is not
 * its own supply. Ten live invoices carried SAR 9,450 of VAT on exactly that, and nothing on screen
 * admitted it: one "VAT 15%" line over one subtotal looks right whatever it was multiplied by.
 *
 * So this is an AUDIT, not a unit test. It reads every quotation and invoice and re-derives the VAT
 * from the lines as the composers now compute it:
 *
 *     taxable base = Σ lines whose treatment is standard
 *     vat          = round(base × rate)
 *
 * A line's treatment is the one FROZEN on it (`item.vat`), falling back to its charge type in the
 * catalogue, falling back to standard. That order matters: a document already issued must keep the
 * treatment it was issued under, however the catalogue is re-rated afterwards.
 *
 * Reads only. It names the documents that disagree and what they would be; it changes nothing,
 * because re-rating an issued document is a decision with a client on the other end of it.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("vat-per-line-check");

type Line = { name?: string; units?: number; price?: number; vat?: string };

const minor = (l: Line) => Math.round((Number(l.units) || 1) * Math.round((Number(l.price) || 0) * 100));
/** The composer writes the VAT total as a line so `amount` stays the grand total; it is not taxed. */
const isVatLine = (l: Line) => /^VAT\s*\(/i.test(String(l.name ?? ""));

async function main() {
  const catalogue = new Map<string, string>();
  // Raw, so the audit runs against a database whose client has not been regenerated — the one
  // moment you most want to ask this question is right after the column has been added.
  const types: any[] = await prisma.$queryRawUnsafe(
    "select name, coalesce(vatTreatment,'standard') as vatTreatment from ChargeType");
  for (const c of types) catalogue.set(String(c.name).trim().toLowerCase(), String(c.vatTreatment));
  const treatment = (l: Line) =>
    String(l.vat ?? "").trim() || catalogue.get(String(l.name ?? "").trim().toLowerCase()) || "standard";

  let checked = 0, wrong = 0, overMinor = 0;
  const rows: string[] = [];

  for (const kind of ["quotation", "invoice"] as const) {
    const docs: any[] = await (prisma as any)[kind].findMany();
    for (const d of docs) {
      // Only documents that stored their figures. The older ones have nothing to compare against,
      // and inventing a comparison for them would report every one of them as broken.
      if (d.totalMinor == null || d.vatRateBp == null) continue;
      // A superseded quotation is history: a later revision replaced it and carries the live
      // figures. Reporting it for ever means this audit never comes back clean, and an audit with
      // three permanent entries is one people stop reading.
      if (d.supersededAt) continue;
      const items: Line[] = Array.isArray(d.items) ? d.items : [];
      if (!items.length) continue;
      checked++;

      const base = items.filter(l => !isVatLine(l) && treatment(l) === "standard").reduce((n, l) => n + minor(l), 0);
      const want = Math.round((base * Number(d.vatRateBp)) / 10000);
      const got = Number(d.vatMinor ?? 0);
      if (want === got) continue;

      wrong++;
      overMinor += got - want;
      const untaxed = items.filter(l => !isVatLine(l) && treatment(l) !== "standard");
      rows.push(
        `  ${String(d.number ?? d.id).padEnd(14)} ${d.status.padEnd(9)}` +
        ` subtotal ${(Number(d.subtotalMinor ?? 0) / 100).toFixed(2).padStart(12)}` +
        ` · VAT ${(got / 100).toFixed(2).padStart(10)} → should be ${(want / 100).toFixed(2).padStart(10)}` +
        (untaxed.length ? `   (untaxed: ${untaxed.map(l => l.name).join(", ")})` : "   (no line is marked untaxed)"),
      );
    }
  }

  console.log(`\n${checked} documents with stored figures\n`);
  if (!wrong) { console.log("  ok    every one charges VAT on its taxable lines"); return; }
  console.log(rows.join("\n"));
  console.log(
    `\n  ${wrong} document${wrong === 1 ? "" : "s"} disagree` +
    `, ${overMinor >= 0 ? "over" : "under"}-charging ${Math.abs(overMinor / 100).toFixed(2)} of VAT in total.`);
  console.log("  Nothing was changed. A draft can be re-saved from the composer; an issued document needs a correction.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
