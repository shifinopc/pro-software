/**
 * TYPING MUST NOT REDRAW THE WHOLE APPLICATION.
 *
 *   npx tsx scripts/fast-fields-check.ts
 *
 * The console is ONE React component — 47,904 lines, ~2,131 computed binding keys recomputed on
 * every setState. There is no component boundary anywhere to stop a re-render, so a field written
 * as `value="{{ x }}" onChange="{{ setX }}"` pays for the entire app on every character. Measured
 * at 33-90ms per keystroke against 0.2ms for a field that does not.
 *
 * 305 fields are now seeded and read on blur instead. This check is what stops the fast ones
 * quietly becoming slow again: `value=` + `onChange` is the obvious way to write a field, it is
 * what every tutorial shows, and one of them pasted in would restore the stutter with nothing on
 * screen to say so.
 *
 * THREE THINGS ARE CHECKED, and the third is the one that protects data:
 *   1. a fast field is seeded and commits on blur, and is not also bound with value=
 *   2. it publishes data-seed-val, which is how _reseedFast corrects it after any render
 *   3. the fields that must stay live — search and type-ahead — were NOT converted, because a
 *      list that narrows as you type is the feature, not an accident
 *
 * Reads index.html. No database, no browser.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.html"), "utf8");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const tags = html.match(/<(?:input|textarea)\b[^>]*?>/g) ?? [];
const seeded = tags.filter(t => t.includes("sc-camel-default-value="));
const controlled = tags.filter(t => /\svalue="\{\{/.test(t) && /\son(?:Change|Input)="\{\{/.test(t));

console.log(`${tags.length} input/textarea tags · ${seeded.length} seeded · ${controlled.length} still controlled\n`);

/**
 * THREE SHAPES ARE LEGITIMATE, and the check has to know all three or it cries wolf at the two the
 * app had working before any of this:
 *
 *   seed + onBlur                 — the ordinary fast field. Typing costs nothing; blur commits.
 *   seed + onChange + onBlur      — a field whose in-progress value is needed by something on
 *                                   screen. onChange writes a plain buffer (no setState), onBlur
 *                                   commits. Used by the workflow capture form and the settlement
 *                                   rows, and it is still free of per-keystroke renders.
 *   seed + onChange, no onBlur    — a search box that is ALSO seeded, so a re-render cannot wipe
 *                                   what is half-typed. It must keep updating per character,
 *                                   because narrowing the list as you type is the feature.
 *
 * What is never legitimate is `value=` on a seeded field: React takes control back, the seed
 * silently does nothing, and the whole-app render per character returns.
 */
const LIVE = /search|filter|lookup|query/i;
const bindOf = (t: string) => (t.match(/sc-camel-default-value="\{\{\s*([^}]+?)\s*\}\}"/) ?? [, "?"])[1]!;
// The handler name counts too: a type-ahead inside a dropdown is bound as `ddFooValue` with a
// placeholder that is itself a binding, so neither says "search" — but its handler is
// `ddFooSetQuery`, and that is what makes it one.
const handlerOf = (t: string) => (t.match(/on(?:Change|Input)="\{\{\s*([^}]+?)\s*\}\}"/) ?? [, ""])[1]!;
const isLive = (t: string) =>
  LIVE.test(bindOf(t)) ||
  LIVE.test(handlerOf(t)) ||
  LIVE.test((t.match(/placeholder="([^"]*)"/) ?? [, ""])[1]!);

console.log("every seeded field is wired a way that does not redraw the app:");
const stillBound = seeded.filter(t => /\svalue="\{\{/.test(t));
ok(stillBound.length === 0,
  stillBound.length ? `${stillBound.length} seeded field is ALSO bound with value= — ${stillBound.map(bindOf).join(", ")}` : "none is also bound with value=");

const noMarker = seeded.filter(t => !t.includes("data-seed-val="));
ok(noMarker.length === 0,
  noMarker.length ? `${noMarker.length} publish no data-seed-val — ${noMarker.map(bindOf).join(", ")}` : `all ${seeded.length} publish data-seed-val for the reseed`);

const orphan = seeded.filter(t => !/onBlur="\{\{/.test(t) && !isLive(t));
ok(orphan.length === 0,
  orphan.length ? `${orphan.length} seeded field commits nowhere — ${orphan.map(bindOf).join(", ")}` : "every non-search seeded field commits on blur");

// A buffer-and-commit field is fine; a seeded field with onChange and no blur had better be a
// search box, or somebody has wired a per-keystroke setState into a fast field.
const perKey = seeded.filter(t => /on(?:Change|Input)="\{\{/.test(t) && !/onBlur="\{\{/.test(t) && !isLive(t));
ok(perKey.length === 0,
  perKey.length ? `${perKey.length} writes state per keystroke — ${perKey.map(bindOf).join(", ")}` : "none writes state per keystroke without a buffer");

console.log("\nthe reseed exists and skips the box being typed in:");
ok(html.includes("_reseedFast()"), "_reseedFast is defined");
ok(/componentDidUpdate\(\)\s*\{[^}]*_reseedFast\(\)/.test(html), "…and runs after every render");
const fn = html.slice(html.indexOf("_reseedFast() {"), html.indexOf("_reseedFast() {") + 900);
// Without this one line the reseed would delete what somebody is typing, on every render.
ok(fn.includes("document.activeElement") && fn.includes("continue"),
  "…and leaves the focused box alone, which is the whole trick");

console.log("\nand what must stay live still updates per keystroke:");
const deadSearch = seeded.filter(t => isLive(t) && !/on(?:Change|Input)="\{\{/.test(t));
ok(deadSearch.length === 0,
  deadSearch.length
    ? `${deadSearch.length} search box now only updates on blur — ${deadSearch.map(bindOf).join(", ")}`
    : "no search or filter box was moved to blur");
for (const live of ["gsQuery", "clSearch", "ldQuery", "emQ", "wfSearch", "ntKindQuery"]) {
  const t = tags.find(x => x.includes(`{{ ${live} }}`));
  ok(!!t && /on(?:Change|Input)="\{\{/.test(t), `${live} still updates per keystroke`);
}

console.log("\npickers and secrets were left alone too:");
for (const ty of ["date", "password", "time", "color"]) {
  const n = seeded.filter(t => t.includes(`type="${ty}"`)).length;
  ok(n === 0, `no ${ty} field was converted${n ? ` — ${n} was` : ""}`);
}

/**
 * A LIVE SEARCH BOX THAT IS NOT DEBOUNCED IS THE WORST CASE IN THE APP.
 *
 * Measured on the Leads screen, with 175 rows behind the box: ONE character blocked the main
 * thread for 1,507-6,693ms — typing a seven-letter name froze the window for roughly twelve
 * seconds. A type-ahead inside a dialog still cost 100-341ms a letter.
 *
 * The filtering cannot move to blur, because narrowing as you type is the feature. So it moves to
 * a pause, and the box is seeded so the LETTERS never wait for the filtering.
 */
console.log("\nand every live box filters on a pause, not on a letter:");
const DEB = /_deb\(|clearTimeout\(this\._/;
const liveBoxes = seeded.filter(isLive);
ok(liveBoxes.length > 30, `${liveBoxes.length} live boxes are seeded, so typing shows instantly`);
ok(html.includes("_deb(key, ms, fn)"), "the debounce helper exists");
// Two factories build every type-ahead in the app, so they cover 22 boxes between them.
const factories = html.match(/\[key \+ 'SetQuery'\]:[^\n]*/g) ?? [];
ok(factories.length === 2, `both dropdown factories found (${factories.length})`);
ok(factories.every(f => DEB.test(f)), "…and both of them debounce");
for (const h of ["setLdQuery", "setClSearch", "emSetQ", "dxSetQ", "setCdEmpQ", "setNtKindQuery"]) {
  const at = html.indexOf(h === "setCdEmpQ" ? "setCdEmpQ =" : h + ":");
  ok(at > 0 && DEB.test(html.slice(at, at + 320)), `${h} filters on a pause`);
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
