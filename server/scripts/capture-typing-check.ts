/**
 * TYPING AN AMOUNT MUST NOT COST A WHOLE SCREEN REDRAW PER CHARACTER.
 *
 *   npx tsx scripts/capture-typing-check.ts
 *
 * Every box on a step's form wrote to app state on each character, and each write recomputes the
 * entire console — one 24,700-line pass that does not care what changed. Measured on the money
 * field: 100-170ms a keystroke, so typing a four-digit fee froze the screen for most of a second,
 * and the officer typing it is standing at a ministry counter.
 *
 * The boxes commit on BLUR now — the bargain the add-client form already made — which buys back
 * every keystroke but introduces the trap this check is really about: between a keystroke and
 * leaving the box, the text exists ONLY in the DOM. A chip on this form is a <div>, which takes no
 * focus, so clicking one fires no blur; without somewhere to keep that text, picking a term right
 * after typing a fee would read, fill and complete the form without the fee in it. Money typed and
 * silently dropped is a worse bug than the one being fixed.
 *
 * So keystrokes land in a buffer outside state (no render) and are folded back into `cap` on the
 * way out, which is the piece worth running rather than grepping: this lifts that fold out of
 * index.html and puts answers through it.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

/** The real fold, pulled out of the render and made callable. */
const cut = (from: string, to: string) => {
  const a = ui.indexOf(from);
  const b = ui.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`capture-typing-check: could not find ${JSON.stringify(a < 0 ? from : to)} — the form was rewritten, so update this check`);
  return ui.slice(a, b + to.length);
};
const foldSrc = cut("const cap = (() => {", "})();").replace(/this\._capPend/g, "pend");
const fold = new Function("stepId", "pend", "_capRaw9", `const selStep = { id: stepId };\n${foldSrc}\nreturn cap;`) as
  (stepId: string, pend: Record<string, string>, raw: any) => any;

const STEP = "task-1";
const key = (v: string, sub = "") => `${STEP}|${v}|${sub}`;

console.log("what is typed but not yet committed is still part of the form:");
ok(fold(STEP, {}, { sadadNumber: "A1" }).sadadNumber === "A1", "nothing pending — the answer is the stored one");
ok(fold(STEP, { [key("sadadNumber")]: "A2" }, { sadadNumber: "A1" }).sadadNumber === "A2",
  "a plain box being typed in wins over the value it was seeded with");
ok(fold(STEP, { [key("payableAmount", "amount")]: "1450" }, {}).payableAmount?.amount === "1450",
  "a money box too, which holds an object and patches one key of it");
ok(fold(STEP, { [key("payableAmount", "amount")]: "1450" }, {}).payableAmount?.paid === true,
  "…and the answer it builds still carries paid:true, so the rules that ask stay satisfiable");
ok(fold(STEP, { [key("payableAmount", "reference")]: "SAD-9" }, { payableAmount: { amount: "1450", payer: "client" } }).payableAmount?.amount === "1450",
  "typing the receipt number does not wipe the amount beside it");
ok(fold(STEP, { [key("payableAmount", "reference")]: "SAD-9" }, { payableAmount: { amount: "1450", payer: "client" } }).payableAmount?.payer === "client",
  "…nor who paid, which no box on screen was touching");
ok(fold(STEP, { ["other-task|sadadNumber|"]: "X" }, { sadadNumber: "A1" }).sadadNumber === "A1",
  "a buffer entry from a DIFFERENT step is ignored — two drawers must not bleed into each other");
ok(fold(STEP, { [key("sadadNumber")]: "A1" }, { sadadNumber: "A1" }) === undefined
  || JSON.stringify(fold(STEP, { [key("sadadNumber")]: "A1" }, { sadadNumber: "A1" })) === JSON.stringify({ sadadNumber: "A1" }),
  "an entry that matches what is already stored changes nothing");

console.log("\nthe boxes commit on leaving, and every keystroke lands in the buffer first:");
ok(/const _capType9 = \(v9, k9\) => \(e\) => \{ this\._capPend\[_capKey9\(v9, k9\)\] = e\.target\.value; \};/.test(ui),
  "a keystroke writes to the buffer and calls no setState, which is the whole saving");
for (const [onChange, onBlur, what] of [
  ["c.m.typeAmount", "c.m.setAmount", "the money amount"],
  ["c.m.typeReference", "c.m.setReference", "the receipt number"],
  ["c.type", "c.set", "a plain text answer"],
] as const) {
  ok(ui.includes(`onChange="{{ ${onChange} }}" onBlur="{{ ${onBlur} }}"`), `${what} commits on blur`);
}
// The space matters: `sc-camel-default-value` ENDS in `value`, so an unanchored match flags the very
// fields this check just approved. The same trap has now caught three checks in this file's history.
ok(!/\svalue="\{\{ c\.m\.amount \}\}"/.test(ui) && !/\svalue="\{\{ c\.m\.reference \}\}"/.test(ui),
  "…and is seeded rather than bound, so React stops restoring it mid-word");
ok(!/defaultValue="\{\{/.test(ui), "no plain defaultValue, which this runtime silently drops");
ok(ui.includes('<input value="{{ c.m.paidOn }}" onChange="{{ c.m.setPaidOn }}" type="date"'),
  "the date stays live — it is a picker, and one redraw per pick is the right price");

console.log("\nnothing typed is lost to a click that fires no blur:");
ok(/Object\.keys\(fill9\)\.forEach\(k9 => \{ _capDone9\(k9, 'amount'\); _capDone9\(k9, ''\); \}\);/.test(ui),
  "a term chip drops the buffered keystroke for the box it is about to fill — otherwise the stale one would shadow the fill for ever");
ok(/_clearRule\(\); _capDone9\(c\.var, k\);/.test(ui) && /_clearRule\(\); _capDone9\(c\.var, ''\);/.test(ui),
  "and a committed box drops its own entry, for the same reason");
ok(ui.includes("const cur9 = (typeof cap[c.var] === 'object' && cap[c.var]) ? cap[c.var] : {};"),
  "a money patch re-reads through the folded form, not the object captured at render");
ok((ui.match(/this\._capPend = \{\}/g) || []).length >= 3,
  "closing the drawer empties the buffer, so a reopened step is not answered by last time's typing");

console.log("\nand a filled fee actually reaches the box:");
// A seeded box ignores a new value unless it is mounted afresh. These two identical inputs, one
// shown at a time, are how it gets mounted: the pick flips which one that is.
ok((ui.match(/sc-camel-default-value="\{\{ c\.m\.amount \}\}"/g) || []).length === 2,
  "two identical amount boxes, under flipA and flipB");
ok(/<sc-if value="\{\{ c\.m\.flipA \}\}"/.test(ui) && /<sc-if value="\{\{ c\.m\.flipB \}\}"/.test(ui),
  "…each under its own sc-if, which is what mounts and unmounts them");
ok(ui.includes("flipA: _flip9, flipB: !_flip9"), "…and exactly one of them is on screen");
ok(ui.includes("const _flip9 = (this.state.wdFillN || 0) % 2 === 0;"), "the flip follows a counter");
ok(/\.\.\.\(Object\.keys\(fill9\)\.length \? \{ wdFillN: \(this\.state\.wdFillN \|\| 0\) \+ 1 \} : \{\}\)/.test(ui),
  "…bumped only when a fill wrote something, so an amount being typed is never yanked out from under the officer");

/**
 * AND THE LAST BOX ON THE SCREEN, which is the one that would have lost real money.
 *
 * Each required document on a step carries a "Ref / receipt no." box, and the Verify button sits
 * beside it as a <span> — so leaving that box by pressing Verify fires no blur at all. It gets the
 * same buffer, under a key namespace of its own, and the two folds must not read each other's
 * entries: a checklist key landing in the ANSWERS object would be a variable nobody declared.
 */
console.log("\nand the receipt box beside each document is on the same footing:");
{
  const chkSrc = cut("const chk = (() => {", "})();").replace(/this\._capPend/g, "pend");
  const chkFold = new Function("stepId", "pend", "_chkRaw9", `const selStep = { id: stepId };\nconst _chkPre9 = selStep.id + '|chk:';\n${chkSrc}\nreturn chk;`) as
    (stepId: string, pend: Record<string, string>, raw: any) => any;
  const ck = (pend: Record<string, string>, raw: any = {}) => chkFold(STEP, pend, raw);
  ok(ck({ [`${STEP}|chk:iqama`]: "RCPT-1" }).iqama?.ref === "RCPT-1",
    "a receipt number typed but not committed is still on the item");
  ok(ck({ [`${STEP}|chk:iqama`]: "RCPT-1" }, { iqama: { received: true, verified: true } }).iqama?.verified === true,
    "…without dropping the ticks already on it, which is what Verify is about to read");
  ok(ck({ [`other|chk:iqama`]: "RCPT-1" }).iqama === undefined, "…and a different step's entry is ignored");
  ok(fold(STEP, { [`${STEP}|chk:iqama`]: "RCPT-1" }, {})["chk:iqama"] === undefined,
    "a checklist entry never leaks into the answers — it would be a variable the step never declared");
  ok(ui.includes('onChange="{{ i.typeRef }}" onBlur="{{ i.setRef }}"'), "the box commits on blur");
  ok(ui.includes("delete this._capPend[_chkKey9(it.key)];"), "…dropping its own entry when it does");
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
