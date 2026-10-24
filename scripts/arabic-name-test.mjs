/**
 * The Latin → Arabic name transliterator on the Add client form.
 *
 * It is EXTRACTED from index.html rather than copied here, so what is tested is what ships. The
 * function is pure and runs on every keystroke, which is the kind of thing that quietly rots.
 *
 * WHAT THIS IS AND IS NOT. The job is the SOUND of a name, never its meaning: "Knowledge Planet" is
 * كنوليدج بلانيت, not كوكب المعرفة. It is a suggestion the officer corrects, so the bar is "close
 * enough to fix in a letter or two", not "right". The cases below are the ones where being wrong
 * would be embarrassing rather than merely approximate — an initialism rendered as a nonsense word,
 * a name with the vowels in the wrong places, Arabic input mangled by being run through twice.
 *
 *   node scripts/arabic-name-test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

// Everything from the digraph table to the exported helper, lifted whole.
const from = html.indexOf("const _arDigraphs = [");
const to = html.indexOf(".split(/(\\s+)/).map(p => (/\\s/.test(p) ? p : _arWord(p))).join('').trim();", from);
if (from < 0 || to < 0) {
  console.error("FAILED to find the transliterator in index.html — did it move or get renamed?");
  process.exit(1);
}
const src = html.slice(from, html.indexOf(";", to) + 1);
const arabicFromLatin = new Function(src + "\nreturn arabicFromLatin;")();

let bad = 0;
const ok = (m) => console.log("  OK   " + m);
const no = (m) => { console.error("  FAIL " + m); bad++; };
const eq = (got, want, what) => got === want ? ok(`${what} → ${got}`)
  : no(`${what} → ${got}   expected ${want}`);

console.log("ordinary words carry their sound across");
eq(arabicFromLatin("Stone"), "ستون", "Stone");
eq(arabicFromLatin("Plastic"), "بلاستيك", "Plastic");
eq(arabicFromLatin("Contracting"), "كونتراكتينج", "Contracting");
eq(arabicFromLatin("Knowledge Planet"), "كنوليدج بلانيت", "Knowledge Planet");

console.log("\nand not their meaning");
// The whole point. If either of these ever starts returning a translation, something has been
// wired to a service that is answering a different question.
if (arabicFromLatin("Knowledge Planet").includes("كوكب")) no("Knowledge Planet was TRANSLATED, not transliterated");
else ok("Knowledge Planet is not كوكب المعرفة");
if (arabicFromLatin("Golden Sand").includes("ذهب")) no("Golden was TRANSLATED, not transliterated");
else ok("Golden is not ذهبي");

console.log("\ninitialisms are spelled out, not pronounced as words");
eq(arabicFromLatin("LLC"), "إل إل سي", "LLC");
eq(arabicFromLatin("EC"), "إي سي", "EC");
// ...but a short real word is still a word.
eq(arabicFromLatin("FIT"), "فيت", "FIT");

console.log("\nvowels in the right places");
eq(arabicFromLatin("Skyline"), "سكايلين", "Skyline (y is a vowel inside a word)");
eq(arabicFromLatin("Company"), "كومباني", "Company (y is not, at the end)");
eq(arabicFromLatin("Out"), "أوت", "Out (a word opening on a vowel digraph)");
eq(arabicFromLatin("Althuraya"), "الثورايا", "Althuraya (no doubled alef)");

console.log("\nthings that are not Latin words are left alone");
eq(arabicFromLatin("الثريا"), "الثريا", "Arabic input passes through untouched");
eq(arabicFromLatin("Gulf 2000"), "جولف 2000", "digits survive");
eq(arabicFromLatin(""), "", "empty stays empty");
eq(arabicFromLatin(null), "", "null does not throw");
// Run twice: the form re-suggests on every keystroke, so this must be stable.
const once = arabicFromLatin("Malbriz Arabia");
eq(arabicFromLatin(once), once, "re-running on its own output changes nothing");

console.log("\nno output ever comes back empty for a real name");
for (const n of ["Abdul Zahir Bashir Electronic LLC", "BADGER METER", "Hot bake", "ionob Technologies", "MOONPACK PLASTIC COMPANY"]) {
  const got = arabicFromLatin(n);
  if (!got || /[a-z]/i.test(got)) no(`${n} → ${got} (left Latin letters behind)`);
}
ok("every sample name came back as Arabic letters");

console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
