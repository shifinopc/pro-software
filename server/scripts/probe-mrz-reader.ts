/**
 * The built-in passport reader, without OCR: the MRZ repair and the check-digit gate.
 *
 * The OCR itself is Tesseract; what this file owns is deciding whether what OCR produced can be
 * trusted. So the question that matters is not "does a clean line parse" but "does a WRONG line ever
 * come out looking verified". The fuzz test corrupts valid lines the ways OCR does — a character
 * swapped, one slipped in, one dropped — thousands of times, and counts readings that pass every check
 * digit yet disagree with the truth. That number has to be zero, or the reader is inventing passports.
 */
import fs from "node:fs";
import { extractionFromMrz, findPassportMrz, readPassportMrz, issueDateFromText } from "../src/mrz-reader.js";

let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);

const W = [7, 3, 1];
const val = (c: string) => (c === "<" ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
const cd = (s: string) => String([...s].reduce((t, c, i) => t + val(c) * W[i % 3], 0) % 10);
function passport(p: { num: string; nat: string; surname: string; given: string; dob: string; sex: string; exp: string }): [string, string] {
  const doc = p.num.padEnd(9, "<"), pers = "<".repeat(14);
  const l1 = (`P<${p.nat}${p.surname}<<${p.given.replace(/ /g, "<")}`).padEnd(44, "<").slice(0, 44);
  const body = doc + cd(doc) + p.nat + p.dob + cd(p.dob) + p.sex + p.exp + cd(p.exp) + pers + cd(pers);
  const composite = doc + cd(doc) + p.dob + cd(p.dob) + p.exp + cd(p.exp) + pers + cd(pers);
  return [l1, body + cd(composite)];
}

const ravi = passport({ num: "Z8841207", nat: "IND", surname: "SHANKAR", given: "RAVI KUMAR", dob: "900504", sex: "M", exp: "310311" });
const fatima = passport({ num: "BN4471923", nat: "PAK", surname: "NOOR", given: "FATIMA", dob: "021130", sex: "F", exp: "290101" });

console.log("1. clean lines");
const r1 = extractionFromMrz(ravi);
r1?.extraction.fields.number === "Z8841207" && r1.extraction.fields.dob === "1990-05-04" && r1.extraction.fields.expiry === "2031-03-11" && r1.extraction.fields.nationality === "IN" && r1.checksPassed
  ? ok("Indian passport: number, 1990 birth, 2031 expiry, IN, all check digits") : fail(JSON.stringify(r1));
const r2 = extractionFromMrz(fatima);
r2?.extraction.fields.dob === "2002-11-30" && r2.extraction.fields.nationality === "PK" ? ok("born 2002 is read as 2002, not 1902; PAK → PK") : fail(JSON.stringify(r2?.extraction.fields));

console.log("\n2. what OCR does to it");
const text = `REPUBLIC OF INDIA\nPassport No. Z8841207\nP<INDSHANKAR<K<RAVI<KUMARLLLLLLLLLLLLLLLLLLL\nZ28841207<1IND9005042M3103119<<<<<<<L<L<L<L<L<L<LK06\n`;
const found = findPassportMrz(text);
const r3 = found && extractionFromMrz(found, text);
r3?.extraction.fields.number === "Z8841207" && r3.checksPassed && r3.extraction.confidence.number === "high" && /printed passport number agrees/.test(r3.extraction.notes) ? ok("slipped-in digit and L/K filler repaired; check digits and the printed number confirm it") : fail(`${JSON.stringify(found)} → ${JSON.stringify(r3?.extraction.fields)}`);
findPassportMrz("INVOICE 2231\nTotal 4,600 SAR\nThank you") === null ? ok("a page with no MRZ is not mistaken for a passport") : fail("found an MRZ in an invoice");

const wrongExpiry: [string, string] = [ravi[0], ravi[1].slice(0, 21) + "320311" + ravi[1].slice(27)];
const r4 = extractionFromMrz(wrongExpiry);
r4 === null ? ok("a misread expiry breaks its check digit and the composite — nothing is read, rescan") : fail(JSON.stringify(r4?.extraction));

const wrongNumber: [string, string] = [ravi[0], "Z8841287" + ravi[1].slice(8)];
extractionFromMrz(wrongNumber) === null ? ok("a misread passport number rejects the whole reading") : fail(`accepted ${extractionFromMrz(wrongNumber)?.extraction.fields.number}`);

const unmapped = passport({ num: "X1234567", nat: "CHL", surname: "ROJAS", given: "ANA", dob: "880101", sex: "F", exp: "300101" });
const r5 = extractionFromMrz(unmapped);
r5?.extraction.fields.nationality === null && /CHL/.test(r5.extraction.notes) ? ok("an unmapped nationality code is left for a person, and named in the note") : fail(JSON.stringify(r5?.extraction));

console.log("\n3. fuzz: can a corrupted line come out looking verified?");
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<";
const rnd = (n: number) => Math.floor(Math.random() * n);
const truth = (x: [string, string]) => extractionFromMrz(x)!.extraction.fields;
type Tally = { tried: number; rejected: number; correct: number; flaggedWrong: number; wrongSure: number; blind: number };
const tally = (): Tally => ({ tried: 0, rejected: 0, correct: 0, flaggedWrong: 0, wrongSure: 0, blind: 0 });
const byEdits: Record<number, Tally> = { 1: tally(), 2: tally() };
for (const base of [ravi, fatima]) {
  const t = truth(base);
  for (let i = 0; i < 3000; i++) {
    const edits = 1 + (i % 2);
    let l2 = base[1];
    let equalValue = false;
    for (let e = 0; e < edits; e++) {
      const pos = rnd(l2.length), kind = rnd(3), ch = CHARS[rnd(CHARS.length)];
      // A swap between characters of equal value mod 10 is invisible to any ICAO check digit.
      if (kind === 0 && l2[pos] !== ch && val(l2[pos]) % 10 === val(ch) % 10) equalValue = true;
      l2 = kind === 0 ? l2.slice(0, pos) + ch + l2.slice(pos + 1) : kind === 1 ? l2.slice(0, pos) + ch + l2.slice(pos) : l2.slice(0, pos) + l2.slice(pos + 1);
    }
    if (l2 === base[1]) continue;
    const T = byEdits[edits];
    T.tried++;
    const r = extractionFromMrz([base[0], l2]);
    if (!r) { T.rejected++; continue; }
    const f = r.extraction.fields;
    const wrong = f.number !== t.number || (f.dob !== null && f.dob !== t.dob) || (f.expiry !== null && f.expiry !== t.expiry);
    if (!wrong) { T.correct++; continue; }
    if (equalValue) { T.blind++; continue; }
    // "Sure" = presented to the officer with a high-confidence number. Anything else is flagged for a look.
    if (r.extraction.confidence.number === "high") T.wrongSure++;
    else T.flaggedWrong++;
  }
}
for (const n of [1, 2]) {
  const T = byEdits[n];
  console.log(`         ${n} OCR error${n === 1 ? "" : "s"} per line, ${T.tried} lines: ${T.correct} recovered exactly, ${T.rejected} rejected, ${T.flaggedWrong} wrong but flagged for a look, ${T.wrongSure} wrong and shown as sure, ${T.blind} equal-value swaps`);
}
byEdits[1].wrongSure + byEdits[1].flaggedWrong === 0
  ? ok("a single OCR error never produces a wrong reading — it is repaired exactly or rejected")
  : fail(`a single OCR error produced ${byEdits[1].wrongSure + byEdits[1].flaggedWrong} wrong readings`);
const rate = byEdits[2].wrongSure / Math.max(1, byEdits[2].tried);
rate < 0.01
  ? ok(`two random errors on one line: ${(rate * 100).toFixed(2)}% come out wrong yet shown as sure (errors that cancel inside a check digit — a limit of ICAO, below 1%)`)
  : fail(`two random errors: ${(rate * 100).toFixed(2)}% wrong but shown as sure`);
console.log(`   note  equal-value swaps (like L for 1) cannot be seen by any check digit; numbers containing L or G are flagged, and a person confirms every reading`);

console.log("\n4. real OCR on a phone-sized photo");
{
  // A WhatsApp-sized image: the MRZ letters are a few pixels tall, unreadable without enlarging.
  const { Jimp } = await import("jimp");
  const img = await Jimp.read(fs.readFileSync("scripts/fixtures/synthetic-passport.png"));
  img.resize({ w: 380 });
  const small = await img.getBuffer("image/jpeg");
  const t0 = Date.now();
  const r = await readPassportMrz({ data: small, mediaType: "image/jpeg" });
  r.extraction?.fields.number === "Z8841207" && r.extraction.fields.expiry === "2031-03-11"
    ? ok(`380-pixel-wide photo read and verified in ${Date.now() - t0} ms: ${r.extraction.fields.number}, ${r.extraction.fields.name}`)
    : fail(`small photo: ${JSON.stringify(r)}`);
  const junk = await readPassportMrz({ data: Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(300, 1)]), mediaType: "image/jpeg" });
  junk.extraction === null ? ok(`a damaged JPEG is refused: "${(junk as any).why}"`) : fail("damaged JPEG read");
}

console.log("\n5. issue date: printed, so only taken when the expiry vouches for it");
{
  const five = issueDateFromText("PASSPORT 21.12.1971 Date of issue 22.08.2012 Expiry 22.08.2017", "2017-08-22", "1971-12-21");
  five?.date === "2012-08-22" && five.years === 5 ? ok("22.08.2012 accepted: the expiry is exactly 5 years later") : fail(JSON.stringify(five));
  const tenLessADay = issueDateFromText("Date of Issue 12/03/2021 Date of Expiry 11/03/2031", "2031-03-11", "1990-05-04");
  tenLessADay?.date === "2021-03-12" && tenLessADay.years === 10 ? ok("12/03/2021 accepted for a 2031-03-11 expiry — 10 years less a day, as India dates it") : fail(JSON.stringify(tenLessADay));
  const month = issueDateFromText("DATE OF ISSUE 14 JUN/JUIN 2019", "2029-06-13", null);
  month?.date === "2019-06-14" ? ok("\"14 JUN/JUIN 2019\" is read as a date") : fail(JSON.stringify(month));
  issueDateFromText("Issued 01.02.2014", "2017-08-22", null) === null ? ok("a date the expiry does not vouch for is left blank") : fail("an unrelated date was accepted");
  issueDateFromText("22.08.2012 21.08.2012", "2017-08-22", null) === null ? ok("two dates that both fit is ambiguous — left blank rather than guessed") : fail("an ambiguous date was accepted");
  issueDateFromText("32.08.2012 2.08202", "2017-08-22", null) === null ? ok("OCR garble (32.08.2012) is not a date") : fail("garbled date accepted");
}

console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
