/**
 * A FILTER BOX MUST NOT COST A RENDER PER KEYSTROKE.
 *
 *   npx tsx scripts/search-debounce-check.ts
 *
 * Every state write in this console runs the whole renderVals pass. Measured in the browser, that
 * is 80-170ms whatever the interaction is — and the "New task" workflow search wrote state on every
 * character, so each key cost 109, 111, 127, 142 and 166ms. Typing "baladiya" froze the screen for
 * about a second. With the box keeping its own text and the filter following 160ms later, the same
 * eight characters measured 1ms in total.
 *
 * Two parts, and BOTH are needed: a debounce alone still leaves React restoring the controlled
 * value mid-word, and an uncontrolled box alone still renders per key. The seeding must use the
 * runtime's `sc-camel-` escape hatch — a plain `defaultValue` is lower-cased into a meaningless
 * attribute and silently dropped, so the box would render empty over state that holds the text.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };
const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

console.log("the workflow search box does not write state on every character:");
ok(ui.includes('<input sc-camel-default-value="{{ ntKindQuery }}" onChange="{{ setNtKindQuery }}"'),
  "it is seeded, not controlled — so typing only touches the DOM");
// The space matters: `sc-camel-default-value` ENDS in `value`, so an unanchored match flags the
// very attribute this check just approved. Caught by this check failing on correct code.
ok(!/\svalue="\{\{ ntKindQuery \}\}"/.test(ui), "no controlled binding left to fight the typist");
ok(/clearTimeout\(this\._ntKindT\);\s*\n\s*this\._ntKindT = setTimeout\(\(\) => this\.setState\(\{ ntKindQuery: v9 \}\), 160\);/.test(ui),
  "…and the filter follows on a 160ms debounce, one render for a typing run instead of one per key");
ok(/openTaskModal: \(\) => \(clearTimeout\(this\._ntKindT\),/.test(ui),
  "a pending write cannot resurrect the last search when the modal is opened again");

console.log("\nand the list still reads the debounced value, so what you see matches what you typed:");
ok(/const q = \(this\.state\.ntKindQuery \|\| ''\)\.trim\(\)\.toLowerCase\(\);/.test(ui), "the filter reads it");
ok(/No workflow matches “\{\{ ntKindQuery \}\}”/.test(ui), "so does the empty state");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
