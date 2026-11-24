/**
 * Draws the client master data sheet from the SAME code the route uses, with fixture data.
 *
 *   npx tsx scripts/master-data-pdf-check.ts [out.pdf]
 *
 * No database and no LibreOffice, so the sheet can be looked at on a development machine.
 *
 * The assertions are about the one property that matters more than the layout: THE MASK IS REAL.
 * A sheet that looks masked while the plaintext sits in the content stream would be the worst
 * possible outcome here — it would be handed around precisely because it looks safe — so the check
 * inflates the drawn text and looks for the passwords themselves.
 */
import { masterDataPdf, type MasterDataRow } from "../src/master-data-pdf.js";
import fs from "node:fs";
import zlib from "node:zlib";

const ORG = {
  legalName: "STIMES PRO Business Services LLC",
  address: "King Fahd Road, Al Olaya, Riyadh 12345, Kingdom of Saudi Arabia",
  vatNumber: "300123456700003", crNumber: "1010123456",
  phone: "+966 11 000 0000", email: "info@stimespro.com",
};

const CLIENT = {
  name: "PRO DESK Company",
  nameAr: "شركة برو ديسك",
  cr: "7054114512",
  vatNumber: "300987654300003",
  molId: "1-4647925",
  gosiNumber: "635228091",
  chamberNumber: "RUH-88213",
  misaLicense: null,
  companyType: "Limited Liability",
  shortAddress: "RQQA4312",
  city: "Riyadh",
  email: "prodesktrading@example.com",
  phone: "+966 56 236 9648",
};

const MANAGER = {
  name: "SHUHAIB CHEKKU VERIALIKKATTIL",
  govId: "2379960533",
  dob: "1988-05-12",
  phone: "+966 56 236 9648",
};

// The nine portals from a real sheet, including the two shapes that are not a plain password: a
// Nafath-only login, and a portal the client is not registered on at all.
const ROWS: MasterDataRow[] = [
  { label: "ZATCA", fileNo: "TIN 3147441623", username: "3147441623", password: "zatca-secret-aaa", notes: "R" },
  { label: "MUQEEM", username: "prodesk", password: "muqeem-secret-bbb", notes: "R" },
  { label: "CHAMBER OF COMMERCE", fileNo: "RUH", username: "Prodesk@123", password: "chamber-secret-ccc", notes: "R" },
  { label: "MINISTRY OF LABOR", username: "2379960533", password: "mol-secret-ddd", notes: "R" },
  { label: "QIWA", username: "2379960533", password: "qiwa-secret-eee", notes: "R", crNumber: "7054114512" },
  { label: "GOSI", fileNo: "635228091", username: "2379960533", password: "gosi-secret-fff", notes: "R" },
  { label: "MUDAD", username: "2379960533", password: "mudad-secret-ggg", notes: "R" },
  { label: "ABSHER", nafath: true, nafathId: "2379960533", password: "", notes: "Nafath app" },
  { label: "MISA", username: null, password: "", notes: "Not registered" },
  // A login this server cannot open: stored, intact, and useless here. This is what 39 of 48 rows
  // looked like on a developer copy of live, and what used to render as an empty cell.
  { label: "SPL", username: "prodesk", unreadable: true, hasPassword: true, notes: "R" },
];

const BASE = {
  org: ORG, logo: null, client: CLIENT, manager: MANAGER, rows: ROWS,
  printedBy: "Local Dev Admin", printedAt: "2026-11-24T09:41:00.000Z",
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
  const dec = out.replace(/<([0-9a-fA-F]+)>/g, (_, hex: string) =>
    Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex").toString("latin1"));
  // LETTER-SPACED TEXT IS NOT ONE STRING. pdfkit writes `characterSpacing` as a kerned array —
  // `[P 100 ASSW 20 ORDS 80 WITHHELD 0] TJ` — so searching the stream for the words as typed finds
  // nothing, which read as "the sheet does not say so" when it does.
  // shortcut: the kerning numbers are stripped by position, and the gaps they leave behind are not
  // distinguishable from real spaces — so anything letter-spaced is asserted on through `squash`
  // below rather than read back verbatim. Nothing printed with spacing carries data.
  return dec.replace(/\[([^\]]*)\]\s*TJ/g, (_s, body: string) => body.replace(/\s-?\d+(\.\d+)?(?=\s|$)/g, ""));
}

/**
 * Whitespace-insensitive comparison.
 *
 * pdfkit kerns the standard fonts, so a word is written as a kerned array and comes back out of the
 * stream split — "NAFATH" as "NAF ATH". For the banners that was a cosmetic nuisance; for the
 * PASSWORD CHECK it is the whole point, because a split secret would have made the mask look proven
 * when the plaintext was in fact sitting in the file.
 */
const squash = (s: string) => s.replace(/\s+/g, "");

const secrets = ROWS.map(r => r.password).filter((p): p is string => !!p);
/**
 * The mask, as it appears in the FILE rather than in the source.
 *
 * The renderer writes U+2022 BULLET, but a standard pdfkit font encodes WinAnsi, where a bullet is
 * byte 0x95 - and this file reads the stream back as latin1. So the thing to look for is 0x95,
 * eight times; searching for the bullet as typed finds nothing and reads as a missing mask.
 */
const MASKCHARS = "".repeat(8);

(async () => {
  // ── 1. Masked (the default) ────────────────────────────────────────────────────────────────
  const masked = await masterDataPdf({ ...BASE, reveal: false });
  if (masked.subarray(0, 5).toString() !== "%PDF-") throw new Error("FAIL: not a PDF");
  if (pages(masked) !== 1) throw new Error(`FAIL: 9 portals should be one page, got ${pages(masked)}`);

  const mText = squash(textOf(masked));
  for (const s of secrets) {
    if (mText.includes(squash(s))) throw new Error(`FAIL: a withheld password is in the file (${s.slice(0, 6)}…)`);
  }
  if (!mText.includes("PASSWORDSWITHHELD")) throw new Error("FAIL: the masked sheet does not say so");
  if (!mText.includes("PrintedbyLocalDevAdmin")) throw new Error("FAIL: no traceability line");
  // Nafath is a state, not a missing password: the row says so instead of printing a blank.
  if (!mText.includes("NAFATH")) throw new Error("FAIL: the Nafath row lost its tag");
  // THE THREE NON-PASSWORD STATES MUST STAY APART. Each one sends somebody somewhere different:
  // to the Nafath app, to the admin who holds the key, or to the client to ask for a password.
  if (!mText.includes(squash("KEY MISSING"))) throw new Error("FAIL: an unopenable login printed as something else");
  if (mText.split("KEYMISSING").length !== 2) throw new Error("FAIL: expected exactly one unreadable row");

  // ── 2. Revealed ────────────────────────────────────────────────────────────────────────────
  const shown = await masterDataPdf({ ...BASE, reveal: true });
  const sText = squash(textOf(shown));
  for (const s of secrets) {
    if (!sText.includes(squash(s))) throw new Error(`FAIL: reveal did not print ${s.slice(0, 6)}…`);
  }
  if (!sText.includes("CONTAINSPASSWORDS")) throw new Error("FAIL: the revealed sheet is not marked confidential");

  // ── 3. Nothing is invented ─────────────────────────────────────────────────────────────────
  const bare = await masterDataPdf({
    ...BASE, reveal: false, org: {}, manager: null,
    client: { name: "Nameless Client Co" },
  });
  const bText = squash(textOf(bare));
  if (bText.includes(squash("STIMES PRO Business Services"))) throw new Error("FAIL: invented a company name");
  if (bText.includes("RESPONSIBLEMANAGER")) throw new Error("FAIL: printed a manager card with no manager");
  if (bText.includes("CRNUMBER") || bText.includes("MISALICENCE")) {
    throw new Error("FAIL: printed an identity card for a field that is not recorded");
  }

  // ── 4. A client with no logins at all, and one with many ───────────────────────────────────
  const none = await masterDataPdf({ ...BASE, reveal: false, rows: [] });
  // A masked sheet is given NO passwords by the route, so it must not then report every login as
  // having none. These two rows are exactly the shape the route sends.
  const routeShaped = squash(textOf(await masterDataPdf({
    ...BASE, reveal: false,
    rows: [{ label: "QIWA", username: "u", hasPassword: true }, { label: "MISA", username: "u", hasPassword: false }],
  })));
  if (!routeShaped.includes(squash(MASKCHARS))) throw new Error("FAIL: a withheld password did not print as a mask");
  if (!routeShaped.includes("MISA")) throw new Error("FAIL: the row with no password vanished");

  if (!squash(textOf(none)).includes(squash("No portal logins are on file"))) throw new Error("FAIL: empty vault says nothing");

  const many = await masterDataPdf({
    ...BASE, reveal: false,
    rows: Array.from({ length: 40 }, (_, i) => ({ ...ROWS[0], label: `PORTAL NUMBER ${i + 1}`, password: "x" })),
  });
  if (pages(many) < 2) throw new Error("FAIL: 40 portals should run onto a second page");

  // ── 5. The Arabic name ─────────────────────────────────────────────────────────────────────
  //
  // Checked through the EMBEDDED FONT rather than the text, because an Identity-H subset writes
  // glyph ids and not characters - the Arabic is unreadable in the byte stream by design. What can
  // be proved here is the thing that actually breaks: that the Naskh font was embedded when there
  // is Arabic to set, and that a Latin "Arabic name" does not drag 300 KB of font into every sheet
  // to print the client's name a second time.
  const embedsNaskh = (pdf: Buffer) => pdf.toString("latin1").includes("NotoNaskhArabic");
  if (!embedsNaskh(shown)) throw new Error("FAIL: an Arabic name did not embed the Arabic font");
  // `bare` is the client with nothing on file but a name - no nameAr, so no font.
  if (embedsNaskh(bare)) throw new Error("FAIL: embedded the Arabic font with no Arabic to print");
  const latinAr = await masterDataPdf({ ...BASE, reveal: false, client: { ...CLIENT, nameAr: "Pro Desk Co" } });
  if (embedsNaskh(latinAr)) throw new Error("FAIL: treated a Latin name in the Arabic field as Arabic");

  const out = process.argv[2] ?? "master-data-sample.pdf";
  fs.writeFileSync(out, shown);
  console.log(`ok: masked sheet leaks nothing, reveal prints all ${secrets.length}, 1 page, 40 rows -> ${pages(many)} pages; wrote ${out}`);
})().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
