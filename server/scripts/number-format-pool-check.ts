/**
 * THE POOLED NUMBER FORMATTER MUST SAY EXACTLY WHAT THE BROWSER SAYS.
 *
 *   npx tsx scripts/number-format-pool-check.ts
 *
 * The console patches `Number.prototype.toLocaleString` to reuse `Intl.NumberFormat` instances
 * instead of letting the built-in construct a fresh one per call. One renderVals makes 286 of those
 * calls, measured at 8.8ms — the largest single item left in a render, and renderVals runs on every
 * state change anywhere in the console.
 *
 * WHAT GOES WRONG IF IT IS WRONG. Every figure in the console goes through this: invoice totals,
 * outstanding balances, quotation lines, payroll, the disbursement ledger. A pool that disagreed
 * with the platform by one decimal place, or that returned another locale's grouping, would restate
 * money everywhere at once and look like a data problem rather than a formatting one. It is also
 * the kind of thing nobody re-reads, which is why this is a check and not a comment.
 *
 * So this extracts the real patch out of index.html, runs it, and compares it against the
 * unpatched built-in — on the exact argument shapes the console actually uses, which it also reads
 * out of index.html, so a new call shape is covered the day it is written rather than the day
 * somebody remembers this file.
 *
 * It imports nothing from the app and runs no browser: Node carries the same ICU.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);

// ── 1. find the patch ────────────────────────────────────────────────────────────────────────
const SENTINEL = "AND FORMATTING MONEY WAS THE LARGEST SINGLE ITEM LEFT";
const at = src.indexOf(SENTINEL);
if (at < 0) {
  fail(
    "the Number.prototype.toLocaleString pool is gone from index.html.\n" +
    "        If that was deliberate, delete this check too — and expect every render to get about\n" +
    "        9ms slower, on every state change, on every screen."
  );
  process.exit(1);
}
// The IIFE AFTER the comment, not before it — the date cache's own IIFE sits just above and
// searching backwards picked that one up, which made this check pass on the wrong code.
const open = src.indexOf("(() => {", at);
const close = src.indexOf("\n})();", open);
if (open < 0 || close < 0) { fail("found the pool's comment but not its IIFE — has it been reshaped?"); process.exit(1); }
const patch = src.slice(open, close + "\n})();".length);
ok(`pool patch extracted (${patch.split(/\r?\n/).length} lines)`);

// The self-check inside the patch is what disables the pool on a mismatch at runtime. Losing it
// would turn a loud failure into a silent one.
if (!/Number\.prototype\.toLocaleString = orig/.test(patch)) {
  fail("the patch no longer restores the original on a mismatch — a bad pool would stay installed");
} else {
  ok("patch still disables itself if it disagrees with the platform at runtime");
}

// ── 2. collect the argument shapes the console really uses ───────────────────────────────────
// Every `.toLocaleString(...)` in the file that is NOT a Date call. Captured as source text and
// evaluated, so the check tests what the call sites pass rather than what this file imagines.
const shapes = new Set<string>();
for (const m of src.matchAll(/\.toLocaleString\(([^()]*(?:\{[^{}]*\})?[^()]*)\)/g)) {
  const args = m[1].trim();
  // Date options are a different vocabulary; those calls are covered by the date cache's own guard.
  if (/\b(day|month|year|hour|minute|second|weekday|timeZone)\b/.test(args)) continue;
  // A forwarded argument list (`toLocaleString(...args)`) says nothing about the shape; the shapes
  // it forwards are whatever its own callers pass, and those appear here in their own right.
  if (args.includes("...")) continue;
  shapes.add(args);
}
if (shapes.size === 0) fail("no Number#toLocaleString call sites found — did the matcher stop matching?");
else ok(`${shapes.size} distinct argument shape(s) in index.html: ${[...shapes].map(s => s || "(no args)").join("  ·  ")}`);

// ── 3. values worth disagreeing over ─────────────────────────────────────────────────────────
// Rounding boundaries, negatives, a negative zero, thousands separators, and the magnitudes real
// money reaches. NaN and Infinity are here because the patch routes them to the original.
const VALUES = [
  0, -0, 1, 0.005, 0.015, 0.125, 1.005, 2.675, 1234.5, -1234.5, 999.995,
  98765.4, -98765.4, 1000000, 12345678.9, 1e21, -1e21, 1 / 3,
  Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, NaN, Infinity, -Infinity,
];

// ── 4. run the patch and compare ─────────────────────────────────────────────────────────────
const pristine = Number.prototype.toLocaleString;
let constructed = 0;
const RealNF = Intl.NumberFormat;
// Counting constructions is how "it is pooled" is actually proved — equal output alone would also
// be true of a patch that pooled nothing and saved nothing.
(Intl as any).NumberFormat = function (...a: any[]) { constructed++; return new (RealNF as any)(...a); };
(Intl as any).NumberFormat.prototype = RealNF.prototype;
(Intl as any).NumberFormat.supportedLocalesOf = RealNF.supportedLocalesOf;

try {
  // eslint-disable-next-line no-eval
  eval(patch);
  if (Number.prototype.toLocaleString === pristine) {
    fail("the patch ran but left the built-in in place — its own self-check rejected it under Node");
  } else {
    ok("patch installed under Node");
  }

  let compared = 0;
  for (const shape of shapes) {
    let args: any[];
    try { args = eval(`[${shape}]`); }
    catch { fail(`could not evaluate the call-site arguments \`${shape}\` — check skipped for that shape`); continue; }
    for (const v of VALUES) {
      const want = pristine.apply(v, args as any);
      const got = Number.prototype.toLocaleString.apply(v, args as any);
      compared++;
      if (got !== want) {
        fail(`toLocaleString(${shape}) on ${String(v)} → pooled ${JSON.stringify(got)}, platform ${JSON.stringify(want)}`);
      }
      // Twice, because the first call is a pool MISS and the second a HIT, and only the second
      // proves the stored formatter is the right one.
      const again = Number.prototype.toLocaleString.apply(v, args as any);
      if (again !== want) fail(`toLocaleString(${shape}) on ${String(v)} differs on the second call (pool hit): ${JSON.stringify(again)} vs ${JSON.stringify(want)}`);
    }
  }
  ok(`${compared} value/shape combination(s) agree with the platform, on both a pool miss and a hit`);

  // One formatter per (locale, options), however many numbers go through it.
  //
  // Measured on a shape nothing above has used, so the count starts from a genuine miss. A shape
  // that was already pooled would report 0 and pass whether or not the counter works at all —
  // which is how a check like this quietly stops checking.
  constructed = 0;
  for (let i = 0; i < 500; i++) (i * 1.37).toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  if (constructed === 0) fail("the Intl.NumberFormat counter never fired — this check cannot see construction, so its result means nothing");
  else if (constructed > 1) fail(`500 calls with one option shape built ${constructed} formatters — the pool is not pooling, so none of the saving is real`);
  else ok(`500 calls with one unseen option shape built exactly ${constructed} formatter — pooled`);

  // Distinct shapes must NOT share a formatter, which is the opposite mistake and the one that
  // would silently restate money.
  const a = (1234.5).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const b = (1234.5).toLocaleString("en-US");
  if (a === b) fail(`two different option shapes returned the same string (${a}) — the pool key is not distinguishing them`);
  else ok(`different option shapes stay separate (${a} vs ${b})`);
} finally {
  Number.prototype.toLocaleString = pristine;
  (Intl as any).NumberFormat = RealNF;
}

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
