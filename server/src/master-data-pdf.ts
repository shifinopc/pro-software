/**
 * THE CLIENT MASTER DATA SHEET — the one page an officer takes to a government counter.
 *
 * Identity at the top (what the authorities know this client by, and the manager whose Nafath
 * approves a login), then every portal the firm holds a login for, numbered.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER DOCUMENT HERE: it is the only one that can print
 * secrets. The vault is built around revealing ONE password at a time — the list route strips
 * `password` before it answers, and a reveal is admin-only and audited — and this sheet is a bulk
 * decrypt of a client's whole vault onto one page. That is a deliberate inversion, so it is paid
 * for in three places:
 *
 *  · `reveal` is OFF by default. The sheet prints a mask, which is the version that is useful for
 *    checking what is on file and harmless to leave on a desk.
 *  · The caller is named ON THE PAGE, with the time, on every page. A sheet that escapes is
 *    traceable to the person who printed it rather than to "someone, at some point".
 *  · The audit row per credential is written by the route, not here — see index.ts. This file is
 *    given plaintext and does not know how to get it, which keeps the decrypt in one place.
 *
 * Nothing is invented: a field that is not recorded is left off rather than printed empty or
 * guessed at. A master data sheet with a plausible-looking wrong CR on it is worse than a short one.
 *
 * Drawn with pdfkit for the same reasons as client-report-pdf.ts: exact control, no LibreOffice in
 * the loop, and a layout that can be checked on a development machine
 * (scripts/master-data-pdf-check.ts).
 *
 * ARABIC. The client's Arabic name prints under the English one, because that is where the firm's
 * own sheet has it and because the name on the counter's screen is the Arabic one. It needs an
 * EMBEDDED font: pdfkit's built-in Helvetica is WinAnsi, which has no Arabic at all, and the
 * letters would come out as blank boxes. Noto Naskh Arabic (SIL OFL, see assets/OFL.txt) is in the
 * repo rather than taken from the host — the API image installs only the fonts LibreOffice needs,
 * and a document whose typography depends on what happens to be installed is a document that
 * changes when the base image does. Joining and right-to-left order are fontkit's doing (pdfkit
 * lays every embedded font out through it), not ours.
 */
import PDFDocument from "pdfkit";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dmy } from "./dates.js";

// ../assets from THIS file, which lands on server/assets both in dev (src/) and once compiled
// (dist/) — and inside the image, where `COPY server/ ./` brings the directory along.
const ARABIC_TTF = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "NotoNaskhArabic.ttf");
// Read once, at import: the file is 300 KB and the sheet is printed per client, per visit.
// Missing font = no Arabic line, never a failed render — an officer waiting at a counter needs the
// CR numbers more than they need the name twice.
const ARABIC: Buffer | null = existsSync(ARABIC_TTF) ? readFileSync(ARABIC_TTF) : null;
const hasArabic = (s: unknown) => /[؀-ۿݐ-ݿ]/.test(String(s ?? ""));

const INK = {
  text: "#1A1523",
  soft: "#4B4757",
  faint: "#8C8899",
  brand: "#26074D",
  accent: "#7C00FF",
  nafath: "#0E9355",
  nafathBg: "#E8F6EE",
  mask: "#9A6B00",
  maskBg: "#FDF3E2",
  bad: "#B42318",
  badBg: "#FEECEC",
  hair: "#EAE6F2",
  tint: "#F8F6FD",
  line: "#F3F0FA",
};

/** One portal line. `password` is already decrypted, or null when there is nothing to print. */
export interface MasterDataRow {
  label: string;
  govCenter?: string | null;
  fileNo?: string | null;
  username?: string | null;
  password?: string | null;
  nafath?: boolean;
  nafathId?: string | null;
  /** True when the stored password will not open with this server's key — see the route. */
  unreadable?: boolean;
  /** Whether a password is stored at all. Known on BOTH sheets; `password` is only sent on one. */
  hasPassword?: boolean;
  notes?: string | null;
  /** The CR this login belongs to, when it is one establishment's rather than the client's. */
  crNumber?: string | null;
}

export interface MasterDataInput {
  org: any;
  /** A raster logo (PNG/JPEG) read from disk, or null. pdfkit cannot place an SVG. */
  logo: Buffer | null;
  client: {
    name: string;
    nameAr?: string | null;
    cr?: string | null;
    vatNumber?: string | null;
    gosiNumber?: string | null;
    molId?: string | null;
    chamberNumber?: string | null;
    misaLicense?: string | null;
    companyType?: string | null;
    email?: string | null;
    phone?: string | null;
    shortAddress?: string | null;
    city?: string | null;
  };
  /** The responsible manager, as an employee record. Null when the firm has not said who it is. */
  manager?: { name: string; govId?: string | null; dob?: string | null; phone?: string | null; role?: string | null } | null;
  rows: MasterDataRow[];
  /** False prints a mask in the password column. See the header. */
  reveal: boolean;
  printedBy: string;
  /** ISO. Printed on every page beside `printedBy`. */
  printedAt: string;
}

const MASK = "••••••••";

/**
 * Whether this login has a password at all.
 *
 * `hasPassword` is the route's answer and is true on both sheets; the fallback is for callers that
 * pass plaintext straight in (the fixture check). Without the flag the masked sheet, which is given
 * no passwords by design, could not tell "withheld" from "none recorded".
 */
const has = (r: MasterDataRow) => (r.hasPassword === undefined ? !!String(r.password ?? "").length : r.hasPassword);

export function masterDataPdf(a: MasterDataInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Pagination is ours: pdfkit adds a page of its own whenever a line would cross the bottom
  // margin, even at an explicit position, which doubles every break this code makes.
  const clearBottomMargin = () => { doc.page.margins.bottom = 0; };
  doc.on("pageAdded", clearBottomMargin);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - 58;        // above the two footer lines
  const full = right - left;
  clearBottomMargin();

  const font = (bold: boolean, size: number, color: string) =>
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);

  // One weight, not two: Noto Naskh ships a variable font and pdfkit takes its default instance,
  // so there is no bold to register. The Arabic line is a size larger instead.
  if (ARABIC) { try { doc.registerFont("Arabic", ARABIC); } catch { /* a corrupt file prints no Arabic */ } }

  const centre = (text: string, size: number, color: string, bold = false, gap = 3, spacing = 0) => {
    font(bold, size, color);
    doc.text(text, left, doc.y, { width: full, align: "center", characterSpacing: spacing });
    doc.y += gap;
  };

  // ── Letterhead ─────────────────────────────────────────────────────────────────────────────
  doc.rect(left, doc.y - 10, full, 2.5).fill(INK.brand);
  doc.y += 10;

  const firm = String(a.org?.legalName ?? a.org?.orgName ?? "").trim();
  const idLines = [
    String(a.org?.address ?? "").trim(),
    [a.org?.vatNumber || a.org?.vat ? "VAT " + (a.org.vatNumber || a.org.vat) : "",
     a.org?.crNumber || a.org?.cr ? "CR " + (a.org.crNumber || a.org.cr) : ""].filter(Boolean).join("     ·     "),
    [String(a.org?.phone ?? "").trim(), String(a.org?.email ?? "").trim()].filter(Boolean).join("     ·     "),
  ].filter(Boolean);

  if (a.logo) {
    try {
      doc.image(a.logo, left + full / 2 - 26, doc.y, { height: 34 });
      doc.y += 42;
    } catch { /* an unreadable image prints no image, not a broken sheet */ }
  }
  if (firm) centre(firm, 16, INK.brand, true, 6);
  idLines.forEach(l => centre(l, 8, INK.faint, false, 2.5));

  doc.y += firm || idLines.length ? 13 : 0;
  centre("CLIENT MASTER DATA", 7.5, INK.accent, true, 5, 1.6);

  // The Arabic name only when there IS one and it is actually Arabic: a company whose Arabic field
  // was filled in with Latin letters would otherwise print its English name twice.
  const nameAr = String(a.client.nameAr ?? "").trim();
  const showAr = !!(ARABIC && nameAr && hasArabic(nameAr));
  centre(a.client.name, 15, INK.text, true, showAr ? 3 : 12);
  if (showAr) {
    doc.font("Arabic").fontSize(15).fillColor(INK.soft);
    doc.text(nameAr, left, doc.y, { width: full, align: "center" });
    doc.y += 12;
  }

  // ── Who the firm deals with, then what the authorities know the company by ─────────────────
  //
  // MANAGER FIRST, which is the order the firm's own sheet uses and the order a counter asks in:
  // the person is who turns up, and every registration below is held in their name. It was under
  // the registrations, where a four-column strip read as a footnote to them.
  //
  // THE NAME GETS ITS OWN COLUMN WIDTH. A Saudi full name is four or five words and wrapped onto
  // two lines when every column was an equal quarter, which pushed it out of line with the ID and
  // date beside it.
  const row = (
    label: string,
    bits: [string, string][],
    y: number,
    weights: number[],
    accent: boolean,
  ) => {
    const H = 42;
    if (accent) {
      doc.roundedRect(left, y, full, H, 5).lineWidth(0.8).strokeColor(INK.hair).stroke();
      doc.rect(left, y + 6, 2.5, H - 12).fill(INK.accent);
    }
    font(true, 6.5, INK.accent);
    doc.text(label.toUpperCase(), left + 10, y + 7, { lineBreak: false, characterSpacing: 0.9 });
    const total = weights.reduce((t, w2) => t + w2, 0);
    let x = left + 10;
    bits.forEach(([k, v], i) => {
      const w2 = ((full - 20) * (weights[i] ?? 1)) / total;
      font(false, 6.5, INK.faint);
      doc.text(k.toUpperCase(), x, y + 20, { width: w2 - 8, lineBreak: false, characterSpacing: 0.6 });
      font(true, 9.5, INK.text);
      doc.text(v, x, y + 29, { width: w2 - 8, lineBreak: false, ellipsis: true });
      x += w2;
    });
    return y + H + 10;
  };

  /** Only what is recorded. An empty card is a question nobody asked, and a column of "—" reads as
   *  a system that lost the data rather than a client with no MISA licence. */
  const kept = (pairs: [string, string | null | undefined][]): [string, string][] =>
    pairs.filter((pp): pp is [string, string] => !!String(pp[1] ?? "").trim())
      .map(([k, v]) => [k, String(v).trim()] as [string, string]);

  if (a.manager) {
    const m = a.manager;
    const bits = kept([
      ["Name", m.name],
      ["National ID", m.govId],
      ["Date of Birth", m.dob ? dmy(String(m.dob).slice(0, 10)) : ""],
      ["Mobile", m.phone],
    ]);
    // The name takes twice a column; the three short values share the rest evenly.
    doc.y = row("Responsible manager", bits, doc.y, bits.map(b => (b[0] === "Name" ? 2.1 : 1)), true);
  }

  // ── The registrations, as a grid of label/value cards ──────────────────────────────────────
  const addr = [a.client.shortAddress, a.client.city].filter(Boolean).join(" · ");
  const facts = kept([
    ["CR Number", a.client.cr],
    // The firm's own sheet calls this "Company MoI No", so the sheet does too — this document is a
    // reproduction of theirs, and a label nobody uses is a label nobody checks.
    ["Company MoI No", a.client.molId],
    ["VAT Number", a.client.vatNumber],
    ["GOSI Number", a.client.gosiNumber],
    ["Chamber Number", a.client.chamberNumber],
    ["MISA Licence", a.client.misaLicense],
    ["Entity Type", a.client.companyType],
    ["National Address", addr],
    ["Email", a.client.email],
    ["Mobile", a.client.phone],
  ]);

  const GAP = 10;
  const CARD_H = 30;
  const cardW = (full - GAP) / 2;
  const gy = doc.y;
  facts.forEach(([label, value], i) => {
    const x = left + (i % 2) * (cardW + GAP);
    const y = gy + Math.floor(i / 2) * (CARD_H + 6);
    doc.roundedRect(x, y, cardW, CARD_H, 5).fill(INK.tint);
    font(false, 6.5, INK.faint);
    doc.text(label.toUpperCase(), x + 9, y + 5, { width: cardW - 18, lineBreak: false, characterSpacing: 0.7 });
    font(true, 10, INK.text);
    doc.text(value, x + 9, y + 15, { width: cardW - 18, lineBreak: false, ellipsis: true });
  });
  if (facts.length) doc.y = gy + Math.ceil(facts.length / 2) * (CARD_H + 6) + 10;

  // ── Portals ────────────────────────────────────────────────────────────────────────────────
  const PAD = 6;
  const HEAD_H = 20;
  const FS = 8.5;

  interface Col {
    label: string;
    width: number;
    get: (r: MasterDataRow, i: number) => string;
    ink?: string;
    bold?: boolean;
    mono?: boolean;
    right?: boolean;
    /** Values that read as a state rather than as data get a tinted tag. */
    pill?: (r: MasterDataRow) => { fill: string; ink: string } | null;
  }

  const cols: Col[] = [
    { label: "#", width: 22, get: (_r, i) => String(i + 1), ink: INK.faint, right: true },
    { label: "Portal", width: 118, get: r => r.label || r.govCenter || "—", bold: true },
    { label: "File / Sub. No", width: 88, get: r => String(r.fileNo ?? "").trim() || "—", ink: INK.soft },
    { label: "User", width: 112, get: r => String(r.username ?? r.nafathId ?? "").trim() || "—", mono: true, ink: INK.soft },
    {
      label: "Password",
      width: 101,
      mono: true,
      // FOUR STATES, NOT TWO. Nafath (no password exists), unreadable (one exists and this server
      // cannot open it), withheld, and the password itself. The first three are tags, because each
      // of them is a fact about the login rather than a value to copy — and the one that must never
      // collapse into a blank is `unreadable`: a blank here says "no password recorded" to somebody
      // standing at a counter.
      get: r => (r.nafath ? "NAFATH"
        : r.unreadable ? "KEY MISSING"
        : !has(r) ? "—"
        : a.reveal ? String(r.password ?? "") : MASK),
      pill: r => (r.nafath ? { fill: INK.nafathBg, ink: INK.nafath }
        : r.unreadable ? { fill: INK.badBg, ink: INK.bad }
        : has(r) && !a.reveal ? { fill: INK.maskBg, ink: INK.mask } : null),
    },
    { label: "Remarks", width: 74, get: r => String(r.notes ?? "").trim() || "", ink: INK.faint },
  ];

  const drawHead = (y: number) => {
    doc.roundedRect(left, y, full, HEAD_H, 4).fill(INK.brand);
    let x = left;
    font(true, 6.5, "#FFFFFF");
    for (const c of cols) {
      doc.text(c.label.toUpperCase(), x + PAD, y + 7,
        { width: c.width - PAD * 2, align: c.right ? "right" : "left", lineBreak: false, characterSpacing: 0.7 });
      x += c.width;
    }
    return y + HEAD_H;
  };

  font(true, 9, INK.brand);
  const capTop = doc.y + (doc.currentLineHeight() - 6.4) / 2;
  doc.rect(left, capTop, 2.5, 6.4).fill(INK.accent);
  font(true, 9, INK.brand);
  doc.text("GOVERNMENT PORTALS", left + PAD, doc.y, { width: full - PAD, characterSpacing: 0.8 });
  doc.y += 6;

  let y = drawHead(doc.y);
  if (!a.rows.length) {
    font(false, FS, INK.faint);
    doc.text("No portal logins are on file for this client.", left + PAD, y + PAD + 1, { width: full - PAD * 2 });
    y += PAD * 2 + 12;
  }

  a.rows.forEach((r, i) => {
    const texts = cols.map(c => c.get(r, i));
    const h = Math.max(22, Math.max(...cols.map((c, j) => {
      font(!!c.bold, FS, INK.text);
      return doc.heightOfString(texts[j], { width: c.width - PAD * 2 });
    })) + PAD * 2);

    if (y + h > bottom) {
      doc.addPage();
      y = drawHead(doc.page.margins.top);
    }

    // Zebra, drawn before the text so it sits under it.
    if (i % 2 === 1) doc.rect(left, y, full, h).fill(INK.line);

    let x = left;
    cols.forEach((c, j) => {
      const tag = c.pill ? c.pill(r) : null;
      if (tag) {
        font(true, 7, tag.ink);
        const w = Math.min(doc.widthOfString(texts[j]) + 14, c.width - PAD);
        doc.roundedRect(x + PAD, y + (h - 14) / 2, w, 14, 7).fill(tag.fill);
        font(true, 7, tag.ink);
        doc.text(texts[j], x + PAD + 7, y + (h - 14) / 2 + 4, { lineBreak: false });
      } else {
        doc.font(c.mono ? (c.bold ? "Courier-Bold" : "Courier") : c.bold ? "Helvetica-Bold" : "Helvetica")
          .fontSize(c.mono ? FS - 0.5 : FS).fillColor(c.ink ?? INK.text);
        doc.text(texts[j], x + PAD, y + PAD + 1, { width: c.width - PAD * 2, align: c.right ? "right" : "left" });
      }
      x += c.width;
    });

    // A login filed against one establishment is not interchangeable with the client's own, so the
    // CR is said on the row rather than left to the label.
    if (String(r.crNumber ?? "").trim()) {
      font(false, 6.5, INK.faint);
      doc.text("CR " + String(r.crNumber).trim(), left + 22 + PAD, y + h - PAD - 3,
        { width: 118 - PAD * 2, lineBreak: false });
    }

    doc.moveTo(left, y + h).lineTo(right, y + h).lineWidth(0.5).strokeColor(INK.hair).stroke();
    y += h;
  });
  doc.y = y;

  // ── Footer on every page ───────────────────────────────────────────────────────────────────
  // The traceability line, and it is the reason this document may exist at all: a page found on a
  // desk names the client, the person who printed it and when, whether or not it carries secrets.
  const range = doc.bufferedPageRange();
  const stamp = `${dmy(a.printedAt.slice(0, 10))} ${a.printedAt.slice(11, 16)}`;
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const fy = doc.page.height - 44;
    doc.moveTo(left, fy - 8).lineTo(right, fy - 8).lineWidth(0.5).strokeColor(INK.hair).stroke();
    font(true, 7, a.reveal ? INK.mask : INK.faint);
    doc.text(
      a.reveal
        ? `CONFIDENTIAL — CONTAINS PASSWORDS · UNCONTROLLED COPY · DESTROY AFTER USE`
        : `PASSWORDS WITHHELD · UNCONTROLLED COPY`,
      left, fy, { width: full, align: "center", lineBreak: false, characterSpacing: 0.6 });
    font(false, 7, INK.faint);
    doc.text(`${a.client.name}${firm ? " · " + firm : ""}`, left, fy + 11, { width: full * 0.62, lineBreak: false, ellipsis: true });
    doc.text(`Printed by ${a.printedBy} · ${stamp}${range.count > 1 ? ` · Page ${i + 1} of ${range.count}` : ""}`,
      left + full * 0.38, fy + 11, { width: full * 0.62, align: "right", lineBreak: false });
  }

  doc.end();
  return done;
}
