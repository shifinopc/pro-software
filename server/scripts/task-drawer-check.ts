/**
 * THE TASK DRAWER MUST APPLY THE SAME GUARDS THE LIST DOES.
 *
 *   npx tsx scripts/task-drawer-check.ts        (static — reads index.html, needs no server)
 *
 * My Tasks renders the same step twice: once as a row in the list, once as the drawer you open.
 * The list is careful about missing data. The drawer, written later, was not — and both bugs below
 * were found the same way, by opening a real step and watching what happened.
 *
 *   · a `select` capture's options are a comma string from the builder and an array from anything
 *     else (a seed, an import, a script). The drawer called .split on them directly, so one array
 *     threw and white-screened the WHOLE page, not just that field.
 *   · a step with no SLA has no deadline to be late against, which the list says plainly. The
 *     drawer did `slaHours - elapsedH` unguarded: null minus a small number is a small negative
 *     one, which rounds to zero, so every step without an SLA opened announcing "0h over SLA" in
 *     red — a breach warning on a step that cannot breach.
 *
 * Checked as text, because the drawer is one block of a 46,000-line single-file app: there is no
 * seam to call, review does not catch a missing guard, and the first symptom is a user losing a
 * page or trusting a deadline that was never set.
 */
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

console.log("a select capture's options:");
ok(src.includes("options: String(c.options || '').split(',')"),
   "coerced before splitting, so an array cannot white-screen the page");

console.log("\na step with no SLA:");
ok(src.includes("const _hasSla9 = Number(selStep.slaHours) > 0;"),
   "the drawer asks whether there IS an SLA, as the list does");
ok(src.includes("const remH = _hasSla9 ? selStep.slaHours - selStep.elapsedH : null;"),
   "and leaves the remaining hours null rather than computing a fake negative");
ok(src.includes("const _slaLabel9 = !_hasSla9 ? 'No SLA'"),
   "so it reads 'No SLA' instead of '0h over SLA'");
ok(/wdSlaColor: !_capsOk \? '#B8860B' : !_hasSla9 \? '#8C8899'/.test(src),
   "and in grey, not the red that means a breach");

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
