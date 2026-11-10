/**
 * THE FIVE HEAVY LISTS STAY CAPPED.
 *
 *   npx tsx scripts/list-capping-check.ts        (static — reads index.html, needs no server)
 *
 * Measured before the change, on a local copy of live data:
 *
 *   /compliance     14,890 DOM nodes   502 inline SVGs   486 documents
 *   /renewals        8,484             295               285 renewals
 *   /notifications   6,805             501               500 notifications
 *   /task-list       4,892               0               241 tasks
 *
 * …against 4,038ms to load a screen with 19 nodes, and ~9.5ms per row. The server was never the
 * problem: every one of these endpoints answers in under 160ms.
 *
 * Two shapes, because the screens are two shapes. A flat list gets `_pager9` (the pager the eight
 * already-paged lists use). A list grouped by status or age gets a per-group cap with "show the
 * remaining N", because a pager across groups cannot answer which group page 7 belongs to.
 *
 * What this guards is the thing that silently reverts: SLICE BEFORE MAP. The per-row builders are
 * the whole expense, so mapping first and slicing after pays the full cost to throw most of it away
 * — and it looks completely correct on screen, which is why nobody would notice.
 */
import fs from "node:fs";
import path from "node:path";

const file = path.join(import.meta.dirname, "../../index.html");
const src = fs.readFileSync(file, "utf8");

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const has = (needle: string, what: string) =>
  src.includes(needle) ? ok(what) : fail(`${what} — not found: ${JSON.stringify(needle.slice(0, 70))}`);

console.log("the shared pager");
has("const _pager9 = (prefix, all, per, stateKey) =>", "_pager9 is defined once, at the top of renderVals");
// The clamp is what stops "page 7 of a list that now has 2 pages" rendering empty.
has("Math.min(Math.max(1, this.state[stateKey] || 1), pages9)", "the page is clamped to the range that exists");
has("return { slice: all.slice(from9, from9 + per)", "it returns a slice, not the whole array");

console.log("\nflat lists use it");
for (const [call, label] of [
  ["_pager9('rn', matched9, 25, 'rnPage')", "renewals"],
  ["_pager9('dc', matched9, 25, 'docPage')", "documents"],
] as const) has(call, label);

console.log("\n…and slice BEFORE the per-row map, not after");
// rnPage9/dcPage9.slice must be what gets mapped. If someone reinstates `.map(...)` on the full
// array and slices the result, these disappear and the cost comes straight back.
has("const rows9 = rnPage9.slice.map((r9, i9) =>", "renewals maps the slice");
has("const rows9 = dcPage9.slice", "documents maps the slice");

console.log("\ngrouped lists cap per group");
for (const [needle, label] of [
  ["const CX_PER_GROUP9 =", "compliance declares a per-group cap"],
  ["(_cxOpen9[key9] ? all9 : all9.slice(0, CX_PER_GROUP9)).map(_cxRow)", "compliance slices before _cxRow"],
  ["const NT_PER_GROUP9 =", "notifications declares a per-group cap"],
  ["_ntOpen9[g.title] ? all8 : all8.slice(0, NT_PER_GROUP9)", "notifications slices its group"],
  ["const TASK_PER_GROUP9 =", "task list declares a per-group cap"],
  ["(_tkOpen9[title] ? all9 : all9.slice(0, TASK_PER_GROUP9)).map(_taskRow)", "task list slices before _taskRow"],
] as const) has(needle, label);

console.log("\nthe hidden rows are reachable, and the totals still tell the truth");
// A cap that cannot be opened is data loss as far as the person reading the screen is concerned.
const moreShown = (src.match(/moreShown: hidden\d? > 0/g) ?? []).length;
moreShown === 3
  ? ok(`all 3 grouped lists offer the rest (${moreShown} "show more" controls)`)
  : fail(`expected 3 grouped lists to offer the rest, found ${moreShown}`);
const bindings = (src.match(/\{\{ g\.moreLabel \}\}/g) ?? []).length;
bindings === 3
  ? ok("and each one is bound in the template")
  : fail(`expected 3 templates binding g.moreLabel, found ${bindings}`);
// count/footer must report the FULL total, not the capped page — the header is the whole point.
has("count: String(all9.length)", "compliance's group header counts every row, not the shown ones");
has("count: all9.length, rows", "the task bucket header counts every row");
has("rnShown: matched9.length + ' of '", "the renewals footer counts what matched, not the page");
has("matched9.length + ' of ' + pool9", "the documents footer counts what matched, not the page");

console.log("\nchanging a filter returns to page 1");
// Otherwise a filter that leaves fewer pages than the one you were on shows an empty list. The
// clamp above saves it from being broken; this keeps it from being confusing.
for (const [needle, label] of [
  ["rnF: on9 ? null : key9, rnPage: 1", "a renewals tile"],
  ["rnKind: k9, rnPage: 1", "a renewals kind tab"],
  ["rnSort: k9, rnPage: 1", "a renewals sort"],
  ["docSort: k9, docPage: 1", "a documents sort"],
  ["docQ: ev9 && ev9.target ? ev9.target.value : '', docPage: 1", "the documents search box"],
  ["docScope: 'company', docTab: k9, docFolder: null, docPage: 1", "a documents tab"],
] as const) has(needle, label);

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
