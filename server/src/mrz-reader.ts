/**
 * THE BUILT-IN PASSPORT READER — no model, nothing leaves the server.
 *
 * Every passport carries two machine-readable lines at the bottom of the photo page (the MRZ): the
 * number, name, nationality, date of birth and expiry, each protected by a check digit. So a passport
 * can be read with plain OCR plus arithmetic: Tesseract (Apache 2.0) reads the characters, and the ICAO
 * 9303 check digits — computed here, not by a library — prove the OCR got them right.
 *
 * WHAT IT CANNOT DO: Iqamas, CRs, work permits and insurance cards have no MRZ; PDFs are not rasterised
 * here; a photo too blurred or skewed for OCR simply finds no MRZ. In all of those cases it returns
 * null with the reason, and intake falls back to a model if one is connected.
 *
 * WHAT A CHECK DIGIT CANNOT CATCH. ICAO check digits weigh each character by its value mod 10, so a
 * swap between two characters of equal value passes — including the OCR confusions L/1 and G/6 in a
 * document number. The reading says so when a number contains L or G, and every reading is still
 * confirmed by a person before it becomes a document.
 *
 * The language data ships inside the package (@tesseract.js-data/eng), so nothing is downloaded at
 * runtime and nothing is cached into the working directory.
 */
import { createRequire } from "node:module";
import type { Extraction } from "./intake-agent.js";

const require = createRequire(import.meta.url);

/** ICAO nationality codes → the ISO alpha-2 codes the app stores. Germany is "D" in an MRZ, not "DEU". */
const ALPHA3: Record<string, string> = {
  SAU: "SA", ARE: "AE", QAT: "QA", KWT: "KW", BHR: "BH", OMN: "OM", IND: "IN", PAK: "PK", BGD: "BD", LKA: "LK",
  NPL: "NP", AFG: "AF", PHL: "PH", IDN: "ID", MYS: "MY", THA: "TH", VNM: "VN", CHN: "CN", MMR: "MM", YEM: "YE",
  JOR: "JO", SYR: "SY", LBN: "LB", IRQ: "IQ", PSE: "PS", TUR: "TR", IRN: "IR", EGY: "EG", SDN: "SD", MAR: "MA",
  TUN: "TN", DZA: "DZ", LBY: "LY", ETH: "ET", ERI: "ER", SOM: "SO", KEN: "KE", UGA: "UG", TZA: "TZ", NGA: "NG",
  GHA: "GH", ZAF: "ZA", GBR: "GB", IRL: "IE", FRA: "FR", D: "DE", DEU: "DE", ITA: "IT", ESP: "ES", PRT: "PT",
  NLD: "NL", POL: "PL", ROU: "RO", UKR: "UA", RUS: "RU", USA: "US", CAN: "CA", BRA: "BR", AUS: "AU", NZL: "NZ",
};

// ── OCR ────────────────────────────────────────────────────────────────────────────────────────
//
// A small pool of Tesseract workers (PASSPORT_OCR_WORKERS, default 1), so with more than one, two
// preparations of the same photo are read at once. The pool is started when
// someone opens the scan dialog (warmPassportReader), not when they press the button, and released
// after ten idle minutes.

// One worker by default: the API container is capped at 512 MB and each worker adds ~130 MB. Two read a
// passport in ~1.5 s instead of ~1.9 s — worth it only where the memory is there.
const POOL_SIZE = Math.min(4, Math.max(1, Number(process.env.PASSPORT_OCR_WORKERS) || 1));
let pool: Promise<any[]> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const busy = new Set<any>();
const waiting: ((w: any) => void)[] = [];

async function startWorker() {
  const { createWorker } = await import("tesseract.js");
  const lang = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
  const w = await createWorker("eng", 1, { langPath: lang.langPath, gzip: lang.gzip, cacheMethod: "none", logger: () => {},
    // Without a handler, tesseract.js THROWS a failed job from inside its message listener — outside any
    // promise — and a single corrupt upload takes the whole API process down. The job's own promise is
    // rejected either way, so the handler only has to exist.
    errorHandler: () => {} } as any);
  await w.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<" });
  return w;
}

function getPool() {
  if (!pool) {
    pool = Promise.all([...Array(POOL_SIZE)].map(startWorker));
    pool.catch(() => { pool = null; });
  }
  releaseLater();
  return pool;
}

/** Start the OCR workers ahead of the first scan, so the scan itself does not pay for loading them. */
export function warmPassportReader() {
  void getPool().catch(() => {});
}

function releaseLater() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (busy.size) return releaseLater();
    const p = pool; pool = null;
    try { for (const w of (await p) ?? []) await w.terminate(); } catch { /* gone */ }
  }, 10 * 60 * 1000);
  idleTimer.unref?.();
}

/** OCR one image on the next free worker. */
const MRZ_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
const workerMode = new WeakMap<object, "mrz" | "text">();

/** OCR one image on the next free worker — restricted to the MRZ alphabet, or as free page text. */
async function ocr(image: Buffer, mode: "mrz" | "text" = "mrz"): Promise<string> {
  const workers = await getPool();
  const w = workers.find(x => !busy.has(x)) ?? await new Promise<any>(resolve => waiting.push(resolve));
  busy.add(w);
  try {
    if ((workerMode.get(w) ?? "mrz") !== mode) {
      await w.setParameters({ tessedit_char_whitelist: mode === "mrz" ? MRZ_ALPHABET : "" });
      workerMode.set(w, mode);
    }
    return (await w.recognize(image)).data.text as string;
  }
  finally {
    busy.delete(w);
    const next = waiting.shift();
    if (next) next(w);
    releaseLater();
  }
}

// ── finding and repairing the two lines ────────────────────────────────────────────────────────

/**
 * OCR reads the "<" filler as L, K or C, and slips in or drops a character. Repairs that cannot
 * change a checked field are made here; everything else is left to the check-digit search below.
 */
function cleanLine(raw: string, which: 1 | 2) {
  let s = raw.toUpperCase().replace(/[«‹]/g, "<").replace(/[^A-Z0-9<]/g, "");
  if (which === 1) {
    // Names can contain K, L and C, so only two repairs are safe here: "<<" between surname and given
    // names read as "<K<", and the filler after the name.
    return s.replace(/<[KLC]</g, "<<<").replace(/[<KLC]{2,}$/, run => "<".repeat(run.length));
  }
  // Line 2. Letters OCR slipped in between filler characters ("<L<L<") are not there at all.
  let prev = "";
  while (prev !== s) { prev = s; s = s.replace(/<[KLC](?=<)/g, "<"); }
  // A run of three or more filler look-alikes that contains a real "<" is filler.
  return s.replace(/[<KLC]{3,}/g, run => (run.includes("<") ? "<".repeat(run.length) : run));
}
const fit = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + "<".repeat(n - s.length));

/** The two TD3 (passport) lines in OCR output, if present — cleaned, not yet forced to 44 characters. */
export function findPassportMrz(text: string): [string, string] | null {
  const raw = text.split(/\r?\n/).map(l => l.replace(/\s+/g, "")).filter(l => l.length >= 30);
  for (let i = 0; i < raw.length - 1; i++) {
    const a = cleanLine(raw[i], 1), b = cleanLine(raw[i + 1], 2);
    if (a.length >= 38 && a.length <= 50 && /^P[A-Z<]/.test(a) && b.length >= 40 && b.length <= 48 && /\d{6}/.test(b)) return [fit(a, 44), b];
  }
  // The name line is the one OCR mangles most (its filler reads as C, L and K), but everything that is
  // checked — number, nationality, dates — is on line 2. A line shaped like it is read on its own, and
  // the name is left for the officer.
  for (const l of raw) {
    const b = cleanLine(l, 2);
    if (b.length >= 42 && b.length <= 46 && /^[A-Z0-9<]{9}[0-9<OISZ][A-Z<]{3}[0-9OIZSBGT]{6}[0-9OIZSBGT][MFX<]/.test(b)) return ["P<" + "<".repeat(42), b];
  }
  return null;
}

/**
 * Line 2 as OCR read it, and the slips that would put it back to 44 characters, grouped by how many
 * characters each repair invents or throws away. Level 0 only resizes the filler run.
 */
function lineTwoVariants(b: string): string[][] {
  const refit = (v: string) => {
    if (v.length === 44) return v;
    const m = v.match(/^(.*?)(<{2,})([0-9<]{2})$/);
    if (m) {
      const run = m[2].length - (v.length - 44);
      if (run >= 1) return m[1] + "<".repeat(run) + m[3];
    }
    return v.length < 44 ? v + "<".repeat(44 - v.length) : v;
  };
  const drops = (v: string) => [...Array(v.length)].map((_, i) => v.slice(0, i) + v.slice(i + 1));
  const levels: string[][] = [[refit(b)], [], []];
  if (b.length === 43) for (let i = 0; i <= 43; i++) levels[1].push(b.slice(0, i) + "<" + b.slice(i));
  if (b.length >= 45 && b.length <= 50) {
    const singles = drops(b);
    levels[1] = singles.map(refit);
    if (b.length >= 46) levels[2] = singles.flatMap(one => drops(one).map(refit));
  }
  return levels.map(l => [...new Set(l)].filter(v => v.length === 44));
}

// ── ICAO 9303 check digits, computed on exactly the characters that will be saved ─────────────
//
// Deliberately not a parsing library: one that "autocorrects" characters while parsing can report a
// check digit as valid for a string it quietly changed. Here nothing is changed after verification —
// what passed the check is what gets saved.

const WEIGHTS = [7, 3, 1];
const charValue = (c: string) => (c === "<" ? 0 : c >= "0" && c <= "9" ? c.charCodeAt(0) - 48 : c >= "A" && c <= "Z" ? c.charCodeAt(0) - 55 : -1);
export function checkDigit(s: string): number | null {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = charValue(s[i]);
    if (v < 0) return null;
    total += v * WEIGHTS[i % 3];
  }
  return total % 10;
}

/**
 * Positions in TD3 line 2 that can only ever be digits: the check digits and the two dates. OCR's usual
 * letter-for-digit slips are undone there, and only there — the document number is alphanumeric, so a
 * letter in it is left exactly as read.
 */
const DIGIT_ONLY = new Set([9, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 43]);
const LOOKALIKE: Record<string, string> = { O: "0", Q: "0", D: "0", U: "0", I: "1", L: "1", Z: "2", A: "4", S: "5", G: "6", T: "7", B: "8" };

type Verified = { line2: string; doc: boolean; dob: boolean; exp: boolean; composite: boolean };
function verifyLineTwo(raw: string): Verified | null {
  if (raw.length !== 44) return null;
  const l2 = [...raw].map((c, i) => (DIGIT_ONLY.has(i) && LOOKALIKE[c] ? LOOKALIKE[c] : c)).join("");
  // A check digit is a digit. "<" is worth 0 in a sum, but standing where a check digit belongs it is
  // a misread — accepting it would let a repair pass on a coincidence.
  const same = (field: string, at: number) => { const d = checkDigit(field); return d !== null && /\d/.test(l2[at]) && d === Number(l2[at]); };
  return {
    line2: l2,
    doc: same(l2.slice(0, 9), 9),
    dob: same(l2.slice(13, 19), 19),
    exp: same(l2.slice(21, 27), 27),
    composite: same(l2.slice(0, 10) + l2.slice(13, 20) + l2.slice(21, 43), 43),
  };
}

/** Shaped like a real passport line: a number with filler only at its end, real dates, a sex marker. */
function plausible(l2: string) {
  const date = (s: string) => {
    if (!/^\d{6}$/.test(s)) return false;
    const mm = Number(s.slice(2, 4)), dd = Number(s.slice(4, 6));
    return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
  };
  return /^[A-Z0-9]{6,9}<*$/.test(l2.slice(0, 9)) && /^[A-Z][A-Z<]{2}$/.test(l2.slice(10, 13))
    && date(l2.slice(13, 19)) && /^[MFX<]$/.test(l2[20]) && date(l2.slice(21, 27));
}

const century = (yymmdd: string, kind: "birth" | "expiry") => {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2)), nowYY = new Date().getUTCFullYear() % 100;
  const year = kind === "birth" ? (yy > nowYY ? 1900 + yy : 2000 + yy) : (yy >= 70 ? 1900 + yy : 2000 + yy);
  const iso = `${year}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
};

/**
 * Turn two MRZ lines into the intake agent's reading, trusting only what the check digits confirm.
 *
 * Repairs are tried in order of how little they change. At the first level where any repair passes
 * every check digit, all of those repairs must agree on the number and dates — if two different
 * repairs both pass, the line is ambiguous and nothing is read. Guessing between them is how a wrong
 * passport number would come out looking verified.
 */
export function extractionFromMrz(read: [string, string], pageText = ""): { extraction: Extraction; checksPassed: boolean } | null {
  const levels = lineTwoVariants(read[1]);
  let chosen: Verified | null = null;
  let complete = false;
  let repaired = false;
  let confirmedByPrint = false;
  // The number is also printed in the page's visual zone. OCR of that print is independent evidence,
  // used only to choose between repairs the check digits cannot tell apart — never to override them.
  const printed = pageText.toUpperCase().replace(/[^A-Z0-9\n]/g, "");
  const onPage = (n: string) => n.length >= 7 && printed.split("\n").some(line => !line.includes("<") && line.includes(n.slice(-7)));
  for (let level = 0; level < levels.length && !chosen; level++) {
    const passing = levels[level].map(verifyLineTwo).filter((v): v is Verified => !!v && plausible(v.line2) && v.doc && v.dob && v.exp && v.composite);
    if (!passing.length) continue;
    const keyOf = (v: Verified) => v.line2.slice(0, 10) + v.line2.slice(13, 20) + v.line2.slice(21, 28);
    // A dropped character inside the document number, "repaired" by padding with filler, looks exactly
    // like a legitimately short number — and the composite repeats the number's own check, so it adds
    // nothing. Those repairs stand only if the printed number on the page agrees.
    const paddedNumber = (v: Verified) => read[1].length === 43 && [...v.line2.slice(0, 10)].findIndex((c, i) => c !== read[1][i]) !== -1;
    let pool = passing.filter(v => !paddedNumber(v) || onPage(v.line2.slice(0, 9).replace(/<+$/, "")));
    if (!pool.length) return null;
    if (new Set(pool.map(keyOf)).size > 1) {
      pool = pool.filter(v => onPage(v.line2.slice(0, 9).replace(/<+$/, "")));
      if (new Set(pool.map(keyOf)).size !== 1) return null;
      confirmedByPrint = true;
    }
    chosen = pool[0];
    complete = true;
    repaired = level > 0;
  }
  // Nothing verified completely. Only an unrepaired line may still give a partial reading — the
  // number with its own check digit AND the composite, a date left blank because its digit failed.
  if (!chosen) {
    const v = levels[0].map(verifyLineTwo).find(x => x && plausible(x.line2));
    if (v && v.doc && v.composite) chosen = v;
  }
  if (!chosen) return null;
  const l2 = chosen.line2;
  // A passport number longer than nine characters continues in the personal-number field; rare, and
  // not handled here rather than handled wrongly.
  if (l2[9] === "<") return null;

  const number = l2.slice(0, 9).replace(/<+$/, "");
  const rawNat = l2.slice(10, 13).replace(/</g, "");
  const nationality = ALPHA3[rawNat] ?? null;
  const name = nameFromLineOne(read[0]);
  // L and G weigh the same as 1 and 6 in a check digit, so those two OCR confusions are invisible to it.
  const blindSpot = /[LG]/.test(number);
  // A reading that needed characters invented or removed to verify is likely right, not certainly:
  // two errors can cancel inside a check digit. It is shown as needing a look unless the printed
  // number on the page agrees.
  const numberSure = !blindSpot && (!repaired || confirmedByPrint || onPage(number));

  const extraction: Extraction = {
    documentType: "Passport",
    isIdentityDocument: true,
    fields: {
      number,
      expiry: chosen.exp ? century(l2.slice(21, 27), "expiry") : null,
      expiryHijri: null,
      issueDate: null,
      name,
      nationality,
      dob: chosen.dob ? century(l2.slice(13, 19), "birth") : null,
    },
    confidence: {
      number: numberSure ? "high" : "medium",
      expiry: chosen.exp ? (repaired ? "medium" : "high") : "none",
      expiryHijri: "none",
      issueDate: "none",
      // The MRZ has no check digit on the name, and long names are cut to fit 39 characters.
      name: name ? "medium" : "none",
      nationality: nationality ? "high" : "none",
      dob: chosen.dob ? (repaired ? "medium" : "high") : "none",
    },
    notes: [
      "Read from the passport's machine-readable zone by the built-in reader — no model was used; the number and dates were verified by their check digits.",
      repaired ? `OCR slipped on this line; it was repaired and re-verified${confirmedByPrint || onPage(number) ? ", and the printed passport number agrees" : " — compare the number and dates with the page"}.` : "",
      blindSpot ? "The number contains L or G, which a check digit cannot tell apart from 1 or 6 — compare it with the page." : "",
      !chosen.exp ? "The expiry date failed its check digit, so it was not filled in." : "",
      !chosen.dob ? "The date of birth failed its check digit, so it was not filled in." : "",
      rawNat && !nationality ? `Nationality code "${rawNat}" is not one this system maps — choose it by hand.` : "",
      "The name is as printed in the MRZ, which can be shortened and has no check digit — compare it with the page.",
    ].filter(Boolean).join(" "),
  };
  return { extraction, checksPassed: complete };
}

/** "P<FINVIRTANEN<<MARIA<OLIVIA<<<" → "MARIA OLIVIA VIRTANEN". Null when the name line was not read. */
export function nameFromLineOne(l1: string): string | null {
  let namePart = l1.slice(5).replace(/<+$/, "");
  // Every MRZ name has "<<" between surname and given names. When OCR read it as "K<" or "<C", the first
  // such pair is that separator — otherwise the whole name would come out as one surname.
  if (!namePart.includes("<<")) namePart = namePart.replace(/[KCL]<|<[KCL]/, "<<");
  const [surname, ...given] = namePart.split("<<");
  return [given.join(" ").replace(/</g, " ").trim(), (surname ?? "").replace(/</g, " ").trim()].filter(Boolean).join(" ").replace(/\s+/g, " ") || null;
}

/**
 * The name line has no check digit, and OCR slips on it differently at each enlargement — reading the
 * "<" between names as C ("MARIACOLIVIA") or inventing a letter ("KRAVI"). Readings of the same length
 * are merged character by character: where one pass saw "<" and another a C, K or L, the "<" wins,
 * because OCR turns filler into those letters far more often than the reverse. Readings of a different
 * length (an invented letter) are outvoted by the length most passes agree on.
 */
export function bestLineOne(readings: string[]): string | null {
  const real = readings.filter(l => /^P[A-Z<][A-Z<]{3}[A-Z]/.test(l)).map(l => l.slice(0, 44));
  if (!real.length) return null;
  const nameLength = (l: string) => l.slice(5).replace(/<+$/, "").length;
  const groups = new Map<number, string[]>();
  for (const l of real) groups.set(nameLength(l), [...(groups.get(nameLength(l)) ?? []), l]);
  const separators = (ls: string[]) => ls.reduce((n, l) => n + (l.slice(5).replace(/<+$/, "").match(/</g) ?? []).length, 0);
  const group = [...groups.values()].sort((a, b) => b.length - a.length || separators(b) - separators(a))[0];
  // Merging is only safe when the readings line up: every difference must be a "<" against a C, K or
  // L. A reading shifted by an invented letter lines up with nothing, and then the passes simply vote.
  const filler = (c: string) => c === "<" || c === "C" || c === "K" || c === "L";
  const aligned = group.every(l => [...l].every((c, i) => c === group[0][i] || (filler(c) && filler(group[0][i]) && (c === "<" || group[0][i] === "<"))));
  if (!aligned) {
    const votes = new Map<string, number>();
    for (const l of group) votes.set(l, (votes.get(l) ?? 0) + 1);
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || separators([b[0]]) - separators([a[0]]))[0][0];
  }
  let merged = "";
  for (let i = 0; i < 44; i++) {
    const chars = group.map(l => l[i] ?? "<");
    if (chars.includes("<") && chars.every(c => c === "<" || c === "C" || c === "K" || c === "L")) { merged += "<"; continue; }
    const counts = new Map<string, number>();
    for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
    merged += [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return merged;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const isoOf = (y: number, m: number, d: number) => {
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/** Every date printed on the page, in the forms passports use: 22.08.2012, 22/08/2012, 22 AUG 2012, 22 AUG/AOÛ 12. */
export function datesInText(text: string): string[] {
  const t = text.toUpperCase().replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0");
  const out = new Set<string>();
  for (const m of t.matchAll(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})\b/g)) { const iso = isoOf(+m[3], +m[2], +m[1]); if (iso) out.add(iso); }
  for (const m of t.matchAll(/\b(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\b/g)) { const iso = isoOf(+m[1], +m[2], +m[3]); if (iso) out.add(iso); }
  for (const m of t.matchAll(/\b(\d{1,2})\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-ZÀ-Ü]*(?:\s*\/\s*[A-ZÀ-Ü]{2,5})?\s*(\d{4}|\d{2})\b/g)) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const iso = isoOf(y, MONTHS[m[2]], +m[1]); if (iso) out.add(iso);
  }
  return [...out];
}

/**
 * The issue date, but only one the expiry vouches for. The printed date has no check digit, so a date
 * is taken only if the passport's verified expiry is exactly 5 or 10 years after it — or a day either
 * side, since some countries date the expiry the day before the anniversary. Exactly one such date, or
 * none: two candidates means OCR cannot be trusted to have picked the right one.
 */
export function issueDateFromText(text: string, expiry: string | null, dob: string | null): { date: string; years: number } | null {
  if (!expiry) return null;
  const exp = Date.parse(expiry + "T00:00:00Z");
  const hits = new Map<string, number>();
  for (const d of datesInText(text)) {
    if (d === expiry || d === dob) continue;
    const t = Date.parse(d + "T00:00:00Z");
    for (const years of [5, 10]) {
      const anniversary = new Date(t); anniversary.setUTCFullYear(anniversary.getUTCFullYear() + years);
      if (Math.abs(exp - anniversary.getTime()) <= 86_400_000) hits.set(d, years);
    }
  }
  if (hits.size !== 1) return null;
  const [[date, years]] = [...hits.entries()];
  return { date, years };
}

/** Real image bytes, not just a name ending in .png. */
function looksLikeImage(b: Buffer) {
  if (b.length < 64) return false;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const webp = b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP";
  return png || jpg || webp;
}

/**
 * The same photo, prepared for OCR. Phone photos and WhatsApp forwards are small — the MRZ letters can
 * be eight pixels tall, which Tesseract cannot read — so the bottom of the page, where the MRZ always
 * is, is cropped, enlarged and flattened to grey. Big scans are never shrunk below their own size:
 * shrinking loses the detail that made them readable. The image is decoded once and cloned per pass.
 */
/** share: the bottom part of the page to keep. from/to: a band of the page instead (0 = top, 1 = bottom). */
type Pass = { share: number; width: number; from?: number; to?: number };
const PASSES: Pass[] = [{ share: 0.3, width: 1150 }, { share: 0.25, width: 1000 }, { share: 0.2, width: 900 }, { share: 0.35, width: 1500 }, { share: 1, width: 1150 }];

async function decoder(data: Buffer): Promise<((p: Pass) => Promise<Buffer>) | null> {
  let Jimp: any;
  try { ({ Jimp } = await import("jimp")); } catch { return null; }
  let base: any;
  try { base = await Jimp.read(data); } catch { return null; } // WEBP and other formats Jimp cannot decode
  return async (p) => {
    const { share, width: target } = p;
    const img = base.clone();
    const { width, height } = img.bitmap;
    const top = Math.floor(height * (1 - share));
    if (p.from !== undefined && p.to !== undefined) img.crop({ x: 0, y: Math.floor(height * p.from), w: width, h: Math.floor(height * (p.to - p.from)) });
    else if (share < 1) img.crop({ x: 0, y: top, w: width, h: height - top });
    const scale = Math.min(4, width > 2400 ? target / width : Math.max(1, target / width));
    if (Math.abs(scale - 1) > 0.05) img.resize({ w: Math.round(width * scale) });
    img.greyscale().contrast(0.4).normalize();
    return img.getBuffer("image/png");
  };
}

type Reading = { extraction: Extraction; checksPassed: boolean };

/**
 * Read a passport image. Null (with why) when there is no MRZ this reader can trust.
 *
 * Two preparations are read at once. Usually both verify and their name lines agree, and the reading is
 * done in about a second. Only when they disagree, or nothing verified, are more passes read — the
 * whole page last, because it carries the printed number that settles an ambiguous repair.
 */
export async function readPassportMrz(file: { data: Buffer; mediaType: string }): Promise<Reading | { extraction: null; why: string }> {
  if (!file.mediaType.startsWith("image/")) return { extraction: null, why: "The built-in reader works on photos and scans (JPG, PNG, WEBP), not PDFs." };
  if (!looksLikeImage(file.data)) return { extraction: null, why: "The file is not a readable JPG, PNG or WEBP image." };

  const prepare = await decoder(file.data);
  const images: (() => Promise<Buffer>)[] = prepare ? PASSES.map(p => () => prepare(p)) : [async () => file.data];
  let pageText = "";
  const nameLines: string[] = [];
  const numbers = new Set<string>();
  const found: { verified: Reading | null; partial: Reading | null } = { verified: null, partial: null };
  let sawZone = false;
  let failedAll = true;

  const readOne = async (make: () => Promise<Buffer>) => {
    let text: string;
    try { text = await ocr(await make()); failedAll = false; } catch { return; }
    pageText += "\n" + text;
    const lines = findPassportMrz(text);
    if (!lines) return;
    sawZone = true;
    if (!lines[0].startsWith("P<<<<<")) nameLines.push(lines[0]);
    const out = extractionFromMrz(lines, pageText);
    if (out?.checksPassed) { numbers.add(`${out.extraction.fields.number}|${out.extraction.fields.dob}|${out.extraction.fields.expiry}`); found.verified ??= out; }
    else if (out && !found.partial) found.partial = out;
  };
  // Settled when a reading verified and at least two name lines of the same length back it up.
  const settled = () => {
    if (!found.verified) return false;
    const lengths = nameLines.map(l => l.slice(5).replace(/<+$/, "").length);
    return lengths.some((n, i) => lengths.indexOf(n) !== i);
  };

  try {
    let next = 0;
    // First two in parallel.
    await Promise.all(images.slice(0, 2).map(readOne));
    next = 2;
    while (!settled() && next < images.length) {
      // A verified number with an unsettled name needs one more vote; nothing verified needs the rest.
      await readOne(images[next++]);
      if (found.verified && nameLines.length >= 3) break;
    }
  } catch { /* each pass handles its own failure */ }

  if (failedAll) return { extraction: null, why: "The image could not be opened for reading — it may be damaged." };
  // Two passes that verified different numbers or dates cannot both be right: believe neither.
  if (numbers.size > 1) return { extraction: null, why: "Two readings of this passport disagreed while both passing their checks — rescan it straight and in focus." };
  const result = found.verified ?? found.partial;
  if (result) {
    const l1 = bestLineOne(nameLines);
    if (l1) result.extraction.fields.name = nameFromLineOne(l1);
    // The issue date is not in the MRZ, only printed on the page. One more read of the whole page as
    // ordinary text, and a date is kept only when the verified expiry vouches for it.
    const f = result.extraction.fields;
    if (result.checksPassed && f.expiry) {
      try {
        // The printed data sits just above the MRZ on a data page; on a two-page spread it is the lower
        // half. That band first, the whole page second — stopping at the first date the expiry vouches for.
        let issued: { date: string; years: number } | null = null;
        const bands: Pass[] = prepare ? [{ share: 1, width: 1100, from: 0.45, to: 0.88 }, { share: 1, width: 1100 }] : [];
        for (const band of bands) {
          issued = issueDateFromText(await ocr(await prepare!(band), "text"), f.expiry, f.dob);
          if (issued) break;
        }
        if (issued) {
          f.issueDate = issued.date;
          result.extraction.confidence.issueDate = "medium";
          result.extraction.notes += ` The issue date was read from the printed page and accepted because the expiry is exactly ${issued.years} years later.`;
        }
      } catch { /* the reading stands without it */ }
    }
    return result;
  }
  return sawZone
    ? { extraction: null, why: "A machine-readable zone was found, but it could not be verified by its check digits — rescan it straight and in focus." }
    : { extraction: null, why: "No passport machine-readable zone was found. It may not be a passport, or the photo is too blurred, rotated or skewed." };
}
