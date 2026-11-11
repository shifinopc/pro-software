/**
 * A STEP THAT MOVES TO ANOTHER ROLE MUST SAY SO, NOT LOOK LIKE A HANG.
 *
 *   npx tsx scripts/step-handover-check.ts
 *
 * Completing a step used to ask the template graph "is there anything after this?", answer yes, and
 * hold the sheet open promising "Opening the next step of this run…" while it re-read the officer's
 * own queue three times. When the next step belonged to the accountant it was never going to be in
 * that queue, so after ~2s the sheet closed with no explanation and the case was gone from both My
 * Tasks and the Task List. Nothing was broken — it had been handed over — but it read as a loss.
 *
 * Two things were wrong. The graph is the wrong source (a drawer opened from My Tasks never loads
 * one, so the answer was always the fallback "yes"), and "is there a next step" is the wrong
 * question. The completion response IS the run with every task on it, including the one just
 * created, so where it went is known before the overlay is drawn.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };
const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

console.log("the answer comes from the engine, not from a graph the drawer may not have:");
ok(/this\._afterStepDone = \(instanceId9, doneId9, inst9\) => \{/.test(ui), "the run travels with the completion");
ok(/r2\.json\(\)\.catch\(\(\) => null\)\.then\(inst2 => \{/.test(ui) && /this\._afterStepDone\(selStep\.instanceId, selStep\.id, inst2\);/.test(ui),
  "…because the response body is read instead of discarded");
ok(!/_nextStepRoles/.test(ui), "and the graph-walking version that could not see the role is gone");

console.log("\nthe three outcomes are each said plainly:");
ok(/wdHandover: to9 \}\);/.test(ui), "handed over — the overlay names who has it");
ok(/'Now with ' \+ _wdHand9 \+ ' — it has left your queue\.'/.test(ui), "…in words that explain the disappearance from the queue");
ok(/wdAdvancingLast: true, wdHandover: '' \}\);/.test(ui), "finished — said at once rather than looked for");
ok(/'Every step of this run is done\.'/.test(ui), "…in its own words");
ok(/const _wdNote9 = /.test(ui) && (ui.match(/wdAdvancingNote: _wdNote9/g) || []).length === 2,
  "both places that draw the overlay read one definition, so they cannot disagree");

console.log("\nand neither of those paths polls a queue it will not be in:");
const body = ui.slice(ui.indexOf("this._afterStepDone = ("), ui.indexOf("const wfStepDefs ="));
const hand = body.slice(body.indexOf("if (open9.length && !mine9.length)"), body.indexOf("if (!open9.length)"));
ok(/return setTimeout\(/.test(hand) && !/look9\(\)/.test(hand), "the handover returns instead of falling through to the retries");
ok(/this\._opReload\('workflow\/my-work', 'myWorkData'\);/.test(hand), "…but still re-reads the queue, so the finished step leaves it");

console.log("\nwhose step it is, decided the same way the queue decides:");
const line = (body.match(/const mine9 = open9\.filter\([\s\S]*?\);/) || [])[0];
ok(!!line, "the ownership test is where this check thinks it is");
const isMine = new Function("open9", "myName9", "myRole9", `${line}\nreturn mine9;`) as (o: any[], n: string, r: string) => any[];
const T = (assignee: any, assigneeRole: any) => ({ assignee, assigneeRole });
ok(isMine([T("Navas", "pro_officer")], "Navas", "pro_officer").length === 1, "named as me — mine");
ok(isMine([T("Muhammed Fazil", "pro_officer")], "Navas", "pro_officer").length === 0, "named as a colleague in my role — NOT mine, it is their work now");
ok(isMine([T(null, "pro_officer")], "Navas", "pro_officer").length === 1, "unassigned in my role — mine to pick up");
ok(isMine([T(null, "accountant")], "Navas", "pro_officer").length === 0, "unassigned in another role — the handover this is all about");
ok(isMine([T(null, null)], "Navas", "pro_officer").length === 1, "no role at all — open work, so mine");
ok(isMine([T(null, "accountant"), T(null, "pro_officer")], "Navas", "pro_officer").length === 1,
  "a parallel split where one branch is mine is not a handover");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
