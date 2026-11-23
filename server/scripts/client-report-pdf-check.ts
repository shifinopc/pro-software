/**
 * Writes the client work report to a PDF, from the SAME code the route uses, with fixture data.
 *
 *   npx tsx scripts/client-report-pdf-check.ts [out.pdf]
 *
 * It needs no LibreOffice and no database, so the document can be looked at on a development
 * machine - which is the whole reason the report is drawn rather than converted. It also asserts the
 * few things that are worth asserting about a PDF: that it is one, that it has exactly one page for
 * this much content, and that a letterhead field left blank is left off the page.
 */
import { clientReportPdf } from "../src/client-report-pdf.js";
import fs from "node:fs";
import zlib from "node:zlib";

const line = (person: string, num: string, exp: string, detail: string, at: string, after?: [string, string]) => ({
  caseTitle: "Iqama renewal — " + person, person, docType: "Iqama",
  beforeNumber: num, beforeExpiry: exp,
  afterNumber: after ? after[0] : null, afterExpiry: after ? after[1] : null,
  at, detail,
});

const ORG = {
  legalName: "STIMES PRO Business Services LLC",
  address: "King Fahd Road, Al Olaya, Riyadh 12345, Kingdom of Saudi Arabia",
  vatNumber: "300123456700003", crNumber: "1010123456",
  phone: "+966 11 000 0000", email: "info@stimespro.com",
};

const DATA = {
  client: "PRO DESK Company",
  from: "2026-11-01", to: "2026-11-30",
  totals: { cases: 1, casesClosed: 0, steps: 3, tasks: 0 },
  completed: [line("MUHAMMED SHANVEEL NAITHRAM VEETIL", "2623312549", "2026-11-27",
    "Issue Work Permit, Payment for Jawazat, Check Traffic / Other Violations", "2026-11-23",
    ["2623312549", "2027-11-27"])],
  pending: [
    line("MUHAMMED SHANVEEL NAITHRAM VEETIL", "2623312549", "2026-11-27", "Waiting on: Renew Iqama", "2026-11-23"),
    line("NAJEEB RAHIMAN VETTIKKATTIL", "2596068904", "2027-01-07", "Waiting on: Issue Work Permit", "2026-11-23"),
    line("SHABEEB KUDIKKIL PUTHIRIKANDAM", "2386010405", "2026-10-14", "Waiting on: Issue Work Permit", "2026-11-23"),
  ],
  logo: null,
};

const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

/** The drawn text. pdfkit deflates its content streams, so they have to be inflated to be read. */
function textOf(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const end = raw.indexOf("endstream", m.index);
    if (end < 0) continue;
    const body = Buffer.from(raw.slice(m.index + m[0].length, end), "latin1");
    try { out += zlib.inflateSync(body).toString("latin1"); } catch { /* not a deflated stream */ }
  }
  // pdfkit writes the glyphs as hex strings, so the words are only readable once decoded.
  return out.replace(/<([0-9a-fA-F]+)>/g, (_, hex: string) =>
    Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex").toString("latin1"));
}

(async () => {
  const pdf = await clientReportPdf({ org: ORG, ...DATA });
  if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("FAIL: not a PDF");
  if (pages(pdf) !== 1) throw new Error(`FAIL: expected 1 page for this content, got ${pages(pdf)}`);

  // An empty settings row prints no company at all - not an invented one, and not a staff note.
  const bare = await clientReportPdf({ org: {}, ...DATA });
  const text = textOf(bare);
  if (text.includes("STIMES PRO Business Services")) throw new Error("FAIL: invented a company name");
  // The client must never see a note aimed at our own staff.
  if (/Settings/.test(text)) throw new Error("FAIL: printed an internal instruction on a client document");

  // Many rows must paginate rather than run off the page.
  const many = await clientReportPdf({
    org: ORG, ...DATA,
    pending: Array.from({ length: 60 }, (_, i) =>
      line(`EMPLOYEE NUMBER ${i + 1}`, "23860104" + String(i).padStart(2, "0"), "2027-03-01",
        "Waiting on: Issue Work Permit", "2026-11-23")),
  });
  if (pages(many) < 2) throw new Error("FAIL: 60 rows should run onto a second page");

  const out = process.argv[2] ?? "client-report-sample.pdf";
  fs.writeFileSync(out, pdf);
  console.log(`ok: 1 page, blank letterhead handled, 60 rows -> ${pages(many)} pages; wrote ${out}`);
})().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
