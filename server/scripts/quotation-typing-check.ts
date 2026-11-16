/**
 * TYPING IN THE QUOTATION DIALOG MUST NOT REDRAW THE APP.
 *
 *   npx tsx scripts/quotation-typing-check.ts
 *
 * Measured before this was fixed: 33-90ms of blocked main thread per keystroke, against 0.2ms in
 * the Add-client form on the same screen. The cause is not this dialog being heavy — it is that a
 * CONTROLLED input makes React flush its change synchronously, so every letter paid for a whole
 * renderVals pass. The Add-client form has always avoided it by seeding the box and reading it on
 * blur, and these boxes now do the same.
 *
 * The reason this check exists rather than a comment: `value="{{ x }}" onChange="{{ setX }}"` is
 * the obvious way to write a field, it is what every other dialog does, and one of them pasted in
 * here would put the stutter back with nothing on screen to say so.
 *
 * Reads index.html. No database, no browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "..", "index.html"), "utf8");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

// The dialog, and only the dialog: the invoice builder is the same shape and is not in scope here.
const start = html.indexOf('<sc-if value="{{ showCreateQuote }}"');
const end = html.indexOf("<!-- View a quotation:", start);
ok(start > 0 && end > start, "the create/edit quotation dialog is where it is expected");
const dlg = html.slice(start, end);

console.log("\nevery typed field is seeded and read on blur:");
for (const [field, marker] of [
  ["line description", 'data-qcl="d"'],
  ["line quantity", 'data-qcl="u"'],
  ["line price", 'data-qcl="p"'],
  ["stage wording", 'data-qct="l"'],
  ["stage percentage", 'data-qct="p"'],
  ["service / subject", 'data-qcf="subject"'],
  ["notes", 'data-qcf="notes"'],
] as [string, string][]) {
  const i = dlg.indexOf(marker);
  if (i < 0) { ok(false, `${field} — no box carries ${marker}`); continue; }
  // The tag this marker sits on, from its "<" to its ">".
  const tag = dlg.slice(dlg.lastIndexOf("<", i), dlg.indexOf(">", i) + 1);
  ok(tag.includes("sc-camel-default-value="), `${field} is seeded, not bound`);
  ok(tag.includes("onBlur="), `${field} commits on blur`);
  // `value=` is the trap: it makes the box controlled again and the stutter returns.
  ok(!/\svalue="\{\{/.test(tag), `${field} has no value= binding`);
  ok(!/onChange="\{\{/.test(tag) && !/onInput="\{\{/.test(tag), `${field} does not write state per keystroke`);
}

/**
 * The other half of the bargain. A seeded box holds the typed text in the DOM until it is left, so
 * state is BEHIND the screen for as long as somebody is typing — and anything that rebuilds the
 * rows from state in that window throws the half-typed row away. Every such handler reads the
 * boxes first, through _qcHarvest.
 */
console.log("\nand everything that rebuilds the rows reads the boxes first:");
ok(dlg.indexOf("const _qcHarvest") < 0, "the harvester is not in the markup (it lives in the script)");
const script = html.slice(html.indexOf("const _qcHarvest"), html.indexOf("const _quoteSubmit"));
ok(script.length > 200, "the harvester is declared before the dialog's handlers");
/**
 * The invariant, stated as what must NOT be in the file rather than as a list of handlers to keep
 * in step with: the rows are only ever rewritten through the harvest. A handler that calls
 * setState on qcLines or qcTerms directly has gone round the back of it, and the row somebody was
 * halfway through typing is what pays for that.
 *
 * Opening the dialog is the one legitimate exception — there is nothing in the boxes yet to read.
 */
const OPENERS = ["openCreateQuote", "const openEditQuote"];
const rawWrites: string[] = [];
const re = /this\.setState\(\{[^}]*\bqc(?:Lines|Terms)\s*:/g;
let m: RegExpExecArray | null;
while ((m = re.exec(html))) {
  const before = html.slice(Math.max(0, m.index - 900), m.index);
  if (OPENERS.some(o => before.lastIndexOf(o) > before.lastIndexOf("},"))) continue;  // inside an opener
  rawWrites.push(html.slice(m.index, m.index + 70).replace(/\s+/g, " "));
}
ok(rawWrites.length === 0,
  rawWrites.length ? `rows written without harvesting: ${rawWrites.join(" | ")}` : "no handler writes the rows behind the harvest's back");

// And the harvest is actually wired to the handlers rather than merely declared.
const uses = (html.match(/_qcEdit9/g) ?? []).length;
ok(uses >= 12, `the harvest is used by the dialog's handlers (${uses} call sites)`);

// The blank-row guard is the one that bit first: judged at render time it refused to add a line
// after you had typed one, because state still held the empty row you had just filled in.
const addLine = html.slice(html.indexOf("addQcLine:"), html.indexOf("addQcLine:") + 500);
ok(addLine.includes("_qcHarvest()"), "the blank-row guard judges the boxes, not the last render");

// Saving is the one that costs money if it is wrong: it ran off state, so a quotation saved while a
// box still had focus was stored as it looked one field ago.
const submit = html.slice(html.indexOf("const _quoteSubmit"), html.indexOf("const _quoteSubmit") + 700);
ok(submit.includes("_qcHarvest()"), "saving reads the boxes, not the state behind them");

// Applying a saved set replaces the stages wholesale — the one case where NOT harvesting would
// also lose the line items, which are nowhere near the thing being changed.
const applySet = html.slice(html.indexOf("qcTermSetOpts:"), html.indexOf("qcTermSetOpts:") + 900);
ok(applySet.includes("_qcEdit9"), "applying a saved set keeps the lines that are being typed");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
