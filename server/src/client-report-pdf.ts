/**
 * The client work report, drawn as a PDF.
 *
 * WHY THIS IS NOT HTML CONVERTED BY LIBREOFFICE, like every other document here.
 *
 * It was, and the converter could not print it. Its HTML import drops `fo:color` from a table cell,
 * so white headings on a coloured band came out black; it ignores padding-top, valign and a
 * paragraph's margin, so a filled header band always had its label stuck to the top edge with dead
 * space beneath; it merges two adjacent tables into one; and it swallows the first block element of
 * the body outright. Each of those cost a round trip to find, and none of them can be worked around
 * in the markup - they are decisions the importer makes.
 *
 * Drawing the page directly fixes all of it at once, and has two further advantages that matter
 * more than the one dependency it costs: the output does not depend on a LibreOffice being present,
 * so it can be checked on a development machine (scripts/client-report-pdf-check.ts), and the
 * layout is arithmetic rather than a guess about what survived.
 *
 * Nothing here is invented. Every letterhead field is printed only if it is set in
 * Settings -> General; a blank one is left off, because a report carrying a company name or a tax
 * number nobody configured is worse than a gap someone notices.
 */
import PDFDocument from "pdfkit";
import { dmy } from "./dates.js";
import type { ReportLine } from "./clientwork.js";

const INK = {
  text: "#1A1523",
  soft: "#4B4757",
  faint: "#6F6C7A",
  brand: "#26074D",
  good: "#0E9355",
  wait: "#B8860B",
  rule: "#E4E0EE",
  band: "#F7F4FD",
};

/** A column: its heading, its share of the width, and how its text is set. */
interface Col {
  label: string;
  width: number;
  get: (l: ReportLine) => string;
  ink?: string;
  bold?: boolean;
  right?: boolean;
}

export interface ClientReportInput {
  org: any;
  client: string;
  from: string;
  to: string;
  totals: { cases: number; casesClosed: number; steps: number; tasks: number };
  completed: ReportLine[];
  pending: ReportLine[];
  /** A raster logo (PNG/JPEG) read from disk, or null. pdfkit cannot place an SVG. */
  logo: Buffer | null;
}

const day = (v: string | null) => (v ? dmy(String(v).slice(0, 10)) : "—");
const pair = (n: string | null, e: string | null) =>
  [n, e ? dmy(String(e).slice(0, 10)) : ""].filter(Boolean).join("  ·  ") || "—";

export function clientReportPdf(a: ClientReportInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 34, bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // PAGINATION IS OURS, NOT PDFKIT'S. Writing text whose line would cross the bottom margin makes
  // pdfkit add a page of its own, even when the position is given explicitly - so a report that
  // breaks its own pages got a second, empty break on top of each one (20 rows came out as 4 pages).
  // Dropping the bottom margin moves pdfkit's trigger to the page edge, which this code never
  // reaches, while `bottom` below stays the line the table actually respects.
  const clearBottomMargin = () => { doc.page.margins.bottom = 0; };
  doc.on("pageAdded", clearBottomMargin);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - 34;
  const full = right - left;
  clearBottomMargin();

  // ── Letterhead, centred ────────────────────────────────────────────────────────────────────
  const firm = String(a.org?.legalName ?? a.org?.orgName ?? "").trim();
  const idLines = [
    String(a.org?.address ?? "").trim(),
    [a.org?.vatNumber || a.org?.vat ? "VAT " + (a.org.vatNumber || a.org.vat) : "",
     a.org?.crNumber || a.org?.cr ? "CR " + (a.org.crNumber || a.org.cr) : ""].filter(Boolean).join("   ·   "),
    [String(a.org?.phone ?? "").trim(), String(a.org?.email ?? "").trim()].filter(Boolean).join("   ·   "),
  ].filter(Boolean);

  const centre = (text: string, size: number, color: string, bold = false, gap = 3) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
    doc.text(text, left, doc.y, { width: full, align: "center" });
    doc.y += gap;
  };

  if (a.logo) {
    try {
      // Centred, height-capped; pdfkit keeps the aspect ratio from the height alone.
      doc.image(a.logo, left + full / 2 - 30, doc.y, { height: 40 });
      doc.y += 48;
    } catch { /* an unreadable image prints no image, not a broken report */ }
  }
  if (firm) centre(firm, 16, INK.brand, true, 5);
  if (idLines.length) idLines.forEach(l => centre(l, 8.5, INK.soft, false, 2));
  // ">" rather than an arrow: Helvetica's WinAnsi encoding has no arrow glyph, and one printed here
  // came out as two stray characters.
  else if (!firm) centre("Add your letterhead in Settings > General", 8.5, INK.wait, false, 2);

  doc.y += 6;
  centre("CLIENT WORK REPORT", 7.5, INK.faint, true, 4);
  centre(a.client, 13, INK.text, true, 3);
  centre(`${dmy(a.from)} to ${dmy(a.to)}`, 8.5, INK.soft, false, 10);

  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1.2).strokeColor(INK.brand).stroke();
  doc.y += 16;

  // ── Tables ─────────────────────────────────────────────────────────────────────────────────
  const PAD = 6;           // cell padding, left/right and top/bottom
  const HEAD_H = 20;       // header band height - fixed, so the caps can be centred in it
  const FS = 8.5;          // body text size

  /** The heading band. Drawn again at the top of every page the table runs onto. */
  const drawHead = (cols: Col[], y: number) => {
    doc.rect(left, y, full, HEAD_H).fill(INK.brand);
    let x = left;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#FFFFFF");
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + PAD, y + (HEAD_H - 7.5) / 2 - 1,
        { width: c.width - PAD * 2, align: c.right ? "right" : "left", lineBreak: false });
      x += c.width;
    }
    return y + HEAD_H;
  };

  const table = (cols: Col[], rows: ReportLine[], emptyText: string) => {
    let y = drawHead(cols, doc.y);

    if (!rows.length) {
      doc.font("Helvetica").fontSize(FS).fillColor(INK.faint);
      doc.text(emptyText, left + PAD, y + PAD, { width: full - PAD * 2 });
      doc.y = y + PAD * 2 + 11;
      return;
    }

    rows.forEach((l, i) => {
      // Measure first: the tallest cell decides the row, and a row is never split across pages.
      const texts = cols.map(c => c.get(l));
      const h = Math.max(...cols.map((c, j) => {
        doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS);
        return doc.heightOfString(texts[j], { width: c.width - PAD * 2 });
      })) + PAD * 2;

      if (y + h > bottom) {
        doc.addPage();
        y = drawHead(cols, doc.page.margins.top);
      }

      if (i % 2) doc.rect(left, y, full, h).fill(INK.band);
      let x = left;
      cols.forEach((c, j) => {
        doc.font(c.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor(c.ink ?? INK.text);
        doc.text(texts[j], x + PAD, y + PAD, { width: c.width - PAD * 2, align: c.right ? "right" : "left" });
        x += c.width;
      });
      doc.moveTo(left, y + h).lineTo(right, y + h).lineWidth(0.5).strokeColor(INK.rule).stroke();
      y += h;
    });

    doc.y = y;
  };

  const section = (text: string) => {
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK.brand);
    doc.text(text.toUpperCase(), left, doc.y, { width: full, characterSpacing: 0.6 });
    doc.y += 4;
  };

  const w = (frac: number) => full * frac;

  section("Completed in this period");
  table([
    { label: "Who", width: w(0.21), get: l => l.person ?? l.caseTitle, bold: true },
    { label: "Document", width: w(0.09), get: l => l.docType ?? "—" },
    { label: "Before", width: w(0.155), get: l => pair(l.beforeNumber, l.beforeExpiry) },
    { label: "After", width: w(0.155), get: l => pair(l.afterNumber, l.afterExpiry), ink: INK.good, bold: true },
    { label: "Work done", width: w(0.28), get: l => l.detail },
    { label: "Done", width: w(0.11), get: l => day(l.at), right: true },
  ], a.completed, "Nothing was completed in this period.");

  doc.y += 18;
  section("Still pending");
  table([
    { label: "Who", width: w(0.25), get: l => l.person ?? l.caseTitle, bold: true },
    { label: "Document", width: w(0.1), get: l => l.docType ?? "—" },
    { label: "On file now", width: w(0.2), get: l => pair(l.beforeNumber, l.beforeExpiry) },
    { label: "Waiting on", width: w(0.33), get: l => l.detail, ink: INK.wait },
    { label: "Since", width: w(0.12), get: l => day(l.at), right: true },
  ], a.pending, "Nothing is open for this client.");

  // ── Totals ─────────────────────────────────────────────────────────────────────────────────
  const t = a.totals;
  const summary = `${t.cases} case(s)   ·   ${t.casesClosed} completed   ·   ${t.steps} steps closed   ·   ${t.tasks} separate tasks`;
  if (doc.y + 34 > bottom) doc.addPage();
  doc.y += 16;
  doc.rect(left, doc.y, full, 22).fill(INK.band);
  doc.font("Helvetica").fontSize(8.5).fillColor(INK.soft);
  doc.text(summary, left, doc.y + 7, { width: full, align: "center" });

  // Page numbers, once the total is known.
  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(7.5).fillColor(INK.faint);
      // A fixed offset from the page edge, not from the bottom margin: that margin is deliberately
      // zero here, and `height + 8` would be off the page - which made pdfkit add a page per page.
      doc.text(`${i + 1} of ${range.count}`, left, doc.page.height - 26,
        { width: full, align: "right", lineBreak: false });
    }
  }

  doc.end();
  return done;
}
