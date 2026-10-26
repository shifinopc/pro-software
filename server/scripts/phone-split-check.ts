/**
 * SPLITTING A STORED PHONE NUMBER INTO ITS DIAL CODE AND THE REST.
 *
 *   npx tsx scripts/phone-split-check.ts
 *
 * The Add lead form shows the country code as a picker, so it has to take the numbers already on
 * file apart. That column holds whatever has been typed into it over the years — the cases below
 * are real values from the live database, not invented ones — and getting it wrong is not a display
 * bug: the split decides what gets written back, so reading "0591257033" as international would
 * save somebody's phone number with its first digits cut off.
 *
 * It runs the SHIPPED function rather than a copy. A re-implementation here would pass happily
 * while the console did something else, which is the one thing a check like this must not do: the
 * code is lifted out of index.html and evaluated against the real country list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COUNTRIES } from "../src/countries.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

// Bounded by its own declaration and the line after the function ends, so a change to either end
// fails loudly here instead of silently testing half of it.
const from = html.indexOf("const _dialList9 = _countryList.filter");
const to = html.indexOf("const _chips9 =", from);
if (from < 0 || to < 0) { console.error("Could not find _splitPhone9 in index.html — this check needs updating."); process.exit(2); }
const src = html.slice(from, to);
if (!src.includes("_splitPhone9")) { console.error("Found the dial list but not _splitPhone9 — this check needs updating."); process.exit(2); }

const split: (v: string) => { dial: string; local: string } =
  new Function("_countryList", `${src} return _splitPhone9;`)(COUNTRIES);

// value → [expected dial shown, expected number box]. '' as the dial means "nothing detected", and
// the form then shows its +966 default with the number left exactly as it was stored.
const CASES: [string, string, string][] = [
  // Said outright.
  ["+966501080092", "+966", "501080092"],
  ["+971567483008", "+971", "567483008"],
  ["00966509801528", "+966", "509801528"],
  // No plus, but it cannot be local: no leading zero and long enough to carry a country code.
  ["966533675383", "+966", "533675383"],
  ["9660538777476", "+966", "0538777476"],
  ["97433909072", "+974", "33909072"],
  ["61 410852277", "+61", "410852277"],
  // Local, and must be left alone. A leading zero is how a Saudi mobile is written; nine digits
  // cannot be an international number at all.
  ["0591257033", "", "0591257033"],
  ["592261238", "", "592261238"],
  // Nothing on file.
  ["", "", ""],
  // Longest prefix wins: +97 is in no list here, but +971 must beat any shorter match.
  ["+97150000000", "+971", "50000000"],
];

let bad = 0;
for (const [input, dial, local] of CASES) {
  const got = split(input);
  const ok = got.dial === dial && got.local === local;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${JSON.stringify(input).padEnd(18)} → ${JSON.stringify(got.dial).padEnd(7)} ${JSON.stringify(got.local)}` +
    (ok ? "" : `   expected ${JSON.stringify(dial)} ${JSON.stringify(local)}`));
}

// Every country offered in the picker must carry a dial code, or it is an option that cannot be
// chosen — the list and the picker are the same list, so this is the place to notice.
const noDial = COUNTRIES.filter(c => !(c as any).dial).map(c => c.code);
if (noDial.length) { bad++; console.log(`  FAIL  no dial code on: ${noDial.join(", ")}`); }
else console.log(`  ok    all ${COUNTRIES.length} countries carry a dial code`);

console.log(bad ? `\n${bad} wrong.` : "\nin order.");
process.exit(bad ? 1 : 0);
