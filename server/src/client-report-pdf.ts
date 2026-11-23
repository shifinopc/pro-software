/**
 * The client work report, drawn as a PDF.
 *
 * WHY THIS IS NOT HTML CONVERTED BY LIBREOFFICE, like every other document here.
 *
 * It was, and the converter could not print it. Its HTML import drops `fo:color` from a table cell,
 * so white headings on a coloured band came out black; it ignores padding-top, valign and a
 * paragraph's margin, so a filled header band always had its label stuck to the top edge with dead
 * space beneath; it merges two adjacent tables into one; and it swallows the first block element of
 * the body outright. Each of those cost a round trip to find, and none can be worked around in the
 * markup - they are decisions the importer makes.
 *
 * Drawing the page directly fixes all of it at once, and has two further advantages that matter
 * more than the one dependency it costs: the output does not depend on a LibreOffice being present,
 * so it can be checked on a development machine (scripts/client-report-pdf-check.ts), and the
 * layout is arithmetic rather than a guess about what survived.
 *
 * Nothing here is invented. Every letterhead field is printed only if it is set in
 * Settings -> General, and a blank one is left off silently: this document goes to the client, so
 * it must never carry a company name or a tax number nobody configured, and must never carry a note
 * to our own staff either.
 */
import PDFDocument from "pdfkit";
import { dmy } from "./dates.js";
import type { ReportLine } from "./clientwork.js";

const INK = {
  text: "#1A1523",
  soft: "#4B4757",
  faint: "#8C8899",
  brand: "#26074D",
  accent: "#7C00FF",
  good: "#0E9355",
  goodBg: "#E8F6EE",
  wait: "#9A6B00",
  waitBg: "#FDF3E2",
  hair: "#EAE6F2",
  tint: "#F8F6FD",
};

/** A column: its heading, its share of the width, and how its text is set. */
interface Col {
  label: string;
  width: number;
  get: (l: ReportLine) => string;
  ink?: string;
  bold?: boolean;
  right?: boolean;
  /** Draw the value as a tinted pill rather than plain text. */
  pill?: { fill: string; ink: string };
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
  [n, e ? dmy(String(e).slice(0, 10)) : ""].filter(Boolean).join(" · ") || "—";

export function clientReportPdf(a: ClientReportInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
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
  const bottom = doc.page.height - 46;
  const full = right - left;
  clearBottomMargin();

  const font = (bold: boolean, size: number, color: string) =>
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);

  // ── Letterhead ─────────────────────────────────────────────────────────────────────────────
  // A rule across the very top, then the firm centred under it. The rule is what makes the page
  // read as stationery rather than as a printout.
  doc.rect(left, doc.y - 10, full, 2.5).fill(INK.brand);
  doc.y += 10;

  const firm = String(a.org?.legalName ?? a.org?.orgName ?? "").trim();
  const idLines = [
    String(a.org?.address ?? "").trim(),
    [a.org?.vatNumber || a.org?.vat ? "VAT " + (a.org.vatNumber || a.org.vat) : "",
     a.org?.crNumber || a.org?.cr ? "CR " + (a.org.crNumber || a.org.cr) : ""].filter(Boolean).join("     ·     "),
    [String(a.org?.phone ?? "").trim(), String(a.org?.email ?? "").trim()].filter(Boolean).join("     ·     "),
  ].filter(Boolean);

  const centre = (text: string, size: number, color: string, bold = false, gap = 3, spacing = 0) => {
    font(bold, size, color);
    doc.text(text, left, doc.y, { width: full, align: "center", characterSpacing: spacing });
    doc.y += gap;
  };

  if (a.logo) {
    try {
      doc.image(a.logo, left + full / 2 - 26, doc.y, { height: 36 });
      doc.y += 44;
    } catch { /* an unreadable image prints no image, not a broken report */ }
  }
  if (firm) centre(firm, 17, INK.brand, true, 6);
  idLines.forEach(l => centre(l, 8.5, INK.faint, false, 2.5));

  doc.y += firm || idLines.length ? 14 : 0;
  centre("CLIENT WORK REPORT", 7.5, INK.accent, true, 5, 1.6);
  centre(a.client, 15, INK.text, true, 4);
  centre(`${dmy(a.from)}  to  ${dmy(a.to)}`, 9, INK.soft, false, 14);

  // ── The four numbers, as tiles ─────────────────────────────────────────────────────────────
  const tiles: [string, number][] = [
    ["Cases", a.totals.cases],
    ["Completed", a.totals.casesClosed],
    ["Steps closed", a.totals.steps],
    ["Separate tasks", a.totals.tasks],
  ];
  const tw = (full - 12 * (tiles.length - 1)) / tiles.length;
  // `doc.text` MOVES doc.y, so the row's top has to be taken once. Reading doc.y per tile walked
  // the tiles down the page and pushed the tables onto a second one.
  const tileY = doc.y;
  tiles.forEach(([label, value], i) => {
    const x = left + i * (tw + 12);
    doc.roundedRect(x, tileY, tw, 42, 6).fill(INK.tint);
    font(true, 17, INK.brand);
    doc.text(String(value), x, tileY + 8, { width: tw, align: "center" });
    font(false, 7.5, INK.faint);
    doc.text(label.toUpperCase(), x, tileY + 29, { width: tw, align: "center", characterSpacing: 0.8 });
  });
  doc.y = tileY + 42 + 22;

  // ── Tables ─────────────────────────────────────────────────────────────────────────────────
  const PAD = 7;
  const HEAD_H = 21;
  const FS = 8.5;

  /** The heading band. Drawn again at the top of every page the table runs onto. */
  const drawHead = (cols: Col[], y: number) => {
    doc.roundedRect(left, y, full, HEAD_H, 4).fill(INK.brand);
    let x = left;
    font(true, 7, "#FFFFFF");
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + PAD, y + 7,
        { width: c.width - PAD * 2, align: c.right ? "right" : "left", lineBreak: false, characterSpacing: 0.7 });
      x += c.width;
    }
    return y + HEAD_H;
  };

  const table = (cols: Col[], rows: ReportLine[], emptyText: string) => {
    let y = drawHead(cols, doc.y);

    if (!rows.length) {
      font(false, FS, INK.faint);
      doc.text(emptyText, left + PAD, y + PAD + 1, { width: full - PAD * 2 });
      doc.y = y + PAD * 2 + 12;
      return;
    }

    rows.forEach((l, i) => {
      // Measure first: the tallest cell decides the row, and a row is never split across pages.
      const texts = cols.map(c => c.get(l));
      const h = Math.max(...cols.map((c, j) => {
        font(!!c.bold, FS, INK.text);
        return doc.heightOfString(texts[j], { width: c.width - PAD * 2 });
      })) + PAD * 2;

      if (y + h > bottom) {
        doc.addPage();
        y = drawHead(cols, doc.page.margins.top);
      }

      let x = left;
      cols.forEach((c, j) => {
        if (c.pill && texts[j] && texts[j] !== "—") {
          // A pill is sized from the text, so a long value still reads as one tag.
          font(true, 7.5, c.pill.ink);
          const w = Math.min(doc.widthOfString(texts[j]) + 16, c.width - PAD);
          doc.roundedRect(x + PAD, y + PAD - 1, w, 14, 7).fill(c.pill.fill);
          font(true, 7.5, c.pill.ink);
          doc.text(texts[j], x + PAD + 8, y + PAD + 3, { lineBreak: false });
        } else {
          font(!!c.bold, FS, c.ink ?? INK.text);
          doc.text(texts[j], x + PAD, y + PAD, { width: c.width - PAD * 2, align: c.right ? "right" : "left" });
        }
        x += c.width;
      });
      doc.moveTo(left, y + h).lineTo(right, y + h).lineWidth(0.5).strokeColor(INK.hair).stroke();
      y += h;
    });

    doc.y = y;
  };

  const section = (text: string) => {
    // A small square of the accent colour, then the label. Cheaper than a rule and easier to find.
    doc.rect(left, doc.y + 1.5, 3, 9).fill(INK.accent);
    font(true, 9, INK.brand);
    doc.text(text.toUpperCase(), left + 9, doc.y, { width: full - 9, characterSpacing: 0.8 });
    doc.y += 6;
  };

  const w = (frac: number) => full * frac;

  section("Completed in this period");
  table([
    { label: "Who", width: w(0.2), get: l => l.person ?? l.caseTitle, bold: true },
    { label: "Document", width: w(0.095), get: l => l.docType ?? "—" },
    { label: "Was", width: w(0.16), get: l => pair(l.beforeNumber, l.beforeExpiry), ink: INK.soft },
    { label: "Now", width: w(0.16), get: l => pair(l.afterNumber, l.afterExpiry), pill: { fill: INK.goodBg, ink: INK.good } },
    { label: "Work done", width: w(0.265), get: l => l.detail, ink: INK.soft },
    { label: "Completed", width: w(0.12), get: l => day(l.at), right: true, ink: INK.faint },
  ], a.completed, "Nothing was completed in this period.");

  doc.y += 20;
  section("Still pending");
  table([
    { label: "Who", width: w(0.25), get: l => l.person ?? l.caseTitle, bold: true },
    { label: "Document", width: w(0.1), get: l => l.docType ?? "—" },
    { label: "On file now", width: w(0.2), get: l => pair(l.beforeNumber, l.beforeExpiry), ink: INK.soft },
    { label: "Waiting on", width: w(0.33), get: l => l.detail.replace(/^Waiting on:\s*/i, ""), pill: { fill: INK.waitBg, ink: INK.wait } },
    { label: "Open since", width: w(0.12), get: l => day(l.at), right: true, ink: INK.faint },
  ], a.pending, "Nothing is open for this client.");

  // ── Footer on every page ───────────────────────────────────────────────────────────────────
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // A fixed offset from the page edge, not from the bottom margin: that margin is deliberately
    // zero here, and `height + 8` would be off the page - which made pdfkit add a page per page.
    const y = doc.page.height - 30;
    doc.moveTo(left, y - 8).lineTo(right, y - 8).lineWidth(0.5).strokeColor(INK.hair).stroke();
    font(false, 7.5, INK.faint);
    doc.text(firm || a.client, left, y, { width: full / 2, lineBreak: false });
    doc.text(range.count > 1 ? `Page ${i + 1} of ${range.count}` : "", left + full / 2, y,
      { width: full / 2, align: "right", lineBreak: false });
  }

  doc.end();
  return done;
}
