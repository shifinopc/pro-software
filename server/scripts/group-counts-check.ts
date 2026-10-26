/**
 * THE GROUP OVERVIEW'S DOCUMENT COUNTS.
 *
 *   npx tsx scripts/group-counts-check.ts
 *
 * `_gOverdue` and `_gExpiring` used to be a filter over every document, run once per company, and
 * four reduces call them across the whole client list — ~500 documents walked 68 times on every
 * render, each walk parsing a Date out of every row. They are now one pass that counts for every
 * company at once: 15.4ms to 0.7ms.
 *
 * THE RULE THAT IS EASY TO BREAK. A document is counted as overdue if its status says so OR its
 * expiry has passed, and as expiring if its expiry is within the next 30 days — and those are not
 * exclusive. A row marked `overdue` that still has three weeks on it counts in BOTH, exactly as it
 * did before, because the point of the rewrite was speed and not a new definition. Writing the loop
 * with `if (over) … else if (expiring) …` reads more naturally and is wrong, and the symptom is a
 * compliance percentage a few points off, which nobody will notice is wrong.
 *
 * It runs the SHIPPED code, lifted out of index.html, so it cannot pass while the console does
 * something else.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "..", "..", "index.html"), "utf8");

const from = html.indexOf("const _gDocCounts = (() => {");
const to = html.indexOf("\n", html.indexOf("const _gExpiring = (coId) =>", from));
if (from < 0 || to < 0) { console.error("Could not find the group counting block in index.html — this check needs updating."); process.exit(2); }
const src = html.slice(from, to);

type Doc = { companyId: string; status?: string; expiryDate?: string | null };
const build = (docs: Doc[]) => {
  const _gDocs = docs;
  const _gDaysLeft = (d9: Doc) => { const t9 = new Date(d9.expiryDate as string); return isNaN(+t9) ? null : Math.ceil((+t9 - Date.now()) / 864e5); };
  return new Function("_gDocs", "_gDaysLeft", `${src}\nreturn { over: _gOverdue, exp: _gExpiring };`)(_gDocs, _gDaysLeft) as
    { over: (id: string) => number; exp: (id: string) => number };
};

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const docs: Doc[] = [
  { companyId: "a", status: "valid", expiryDate: day(10) },    // a: expiring
  { companyId: "a", status: "valid", expiryDate: day(-5) },    // a: overdue (by date)
  { companyId: "a", status: "overdue", expiryDate: day(20) },  // a: BOTH — the case that matters
  { companyId: "a", status: "valid", expiryDate: day(400) },   // a: neither
  { companyId: "a", status: "valid", expiryDate: null },       // a: counted OVERDUE — see below
  { companyId: "b", status: "overdue", expiryDate: day(300) }, // b: overdue by status only
  { companyId: "b", status: "valid", expiryDate: "not a date" },
];

const { over, exp } = build(docs);
const CASES: [string, number, number, string][] = [
  ["a", 3, 2, "overdue by date, by status, and the null-expiry row below; expiring twice"],
  ["b", 1, 0, "status says overdue although the date is far off"],
  ["zz", 0, 0, "a company with no documents at all"],
];

let bad = 0;
for (const [id, wantOver, wantExp, why] of CASES) {
  const got = [over(id), exp(id)];
  const ok = got[0] === wantOver && got[1] === wantExp;
  if (!ok) bad++;
  console.log(`  ${ok ? "ok   " : "FAIL "} ${id}: overdue ${got[0]}, expiring ${got[1]}` +
    (ok ? `   (${why})` : `   expected ${wantOver} and ${wantExp} — ${why}`));
}

// Said separately, because it is the whole reason the loop is written the way it is.
const both = build([{ companyId: "x", status: "overdue", expiryDate: day(7) }]);
if (both.over("x") === 1 && both.exp("x") === 1) console.log("  ok    a row that is overdue AND within 30 days counts in both, as it always did");
else { bad++; console.log(`  FAIL  overlap lost: overdue ${both.over("x")}, expiring ${both.exp("x")} — expected 1 and 1. The loop has become an either/or.`); }

/**
 * A DOCUMENT WITH NO EXPIRY DATE IS COUNTED AS OVERDUE, and this is here to say so out loud.
 *
 * `_gDaysLeft` does `new Date(d.expiryDate)`, and `new Date(null)` is not an invalid date — it is
 * 1 January 1970, so the row reads as half a century overdue. This predates the rewrite above and
 * was NOT changed by it: that change was for speed, and quietly altering a compliance figure while
 * claiming to make it faster is how a performance commit becomes impossible to trust.
 *
 * It is latent rather than live. Every document in the data this was measured against carries a
 * date, and the Documents screen counts undated ones as their own category, so such rows plainly
 * can exist. Pinned here so that whoever decides to fix it sees that this is the deliberate state
 * and not an oversight — change the assertion when the behaviour changes on purpose.
 */
const undated = build([{ companyId: "x", status: "valid", expiryDate: null }]);
if (undated.over("x") === 1) console.log("  ok    a document with NO expiry date counts as overdue (a known quirk, pinned deliberately — see the note above)");
else { bad++; console.log(`  FAIL  the undated-document behaviour changed: overdue ${undated.over("x")}, expected 1. If that was on purpose, update this check and say so in the commit.`); }

console.log(bad ? `\n${bad} wrong.` : "\nin order.");
process.exit(bad ? 1 : 0);
