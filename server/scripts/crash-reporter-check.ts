/**
 * A BROWSER EXTENSION'S ERROR MUST NOT BE REPORTED AS THIS APP CRASHING.
 *
 *   npx tsx scripts/crash-reporter-check.ts
 *
 * A content script runs in the page's own world, so when one throws, the page is what
 * window.onerror reports. The console's handler then put a crash card over the screen and filed a
 * problem report — about code nobody here wrote and nobody here can fix.
 *
 * It happened on live: "Cannot read properties of undefined (reading 'M_ID')" on /quotations, with
 * every frame of its stack inside chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/
 * 200.js. An administrator watched the console appear to break and reported it. The old guard only
 * skipped RESOURCE errors — a 404 on an image, which arrives with an element as its target — and
 * that is a different thing entirely.
 *
 * The decision is lifted out of index.html and run here rather than grepped, because what matters
 * is which stacks it rejects and, far more importantly, which it still lets through.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

const cut = (from: string, to: string) => {
  const a = ui.indexOf(from), b = ui.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`crash-reporter-check: could not find ${JSON.stringify(a < 0 ? from : to)} — the reporter was rewritten, so update this check`);
  return ui.slice(a, b + to.length);
};
const src = cut("var EXT_RE =", "}");
const notOurs = new Function(`${src}\nreturn notOurs;`)() as (stack?: string, filename?: string) => boolean;

console.log("an error thrown by an extension is not reported:");
ok(notOurs("TypeError: Cannot read properties of undefined (reading 'M_ID')\n    at Y (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)"),
  "the real one, from live — every frame inside a chrome extension");
ok(notOurs("", "chrome-extension://abc/content.js"), "…recognised from the filename alone, when there is no stack");
ok(notOurs("at x (moz-extension://abc/content.js:1:1)"), "Firefox");
ok(notOurs("at x (safari-web-extension://abc/content.js:1:1)"), "Safari");

console.log("\nand a real crash still is, which is the half that matters:");
ok(!notOurs("TypeError: v.map is not a function\n    at renderVals (http://localhost:5188/:31148:20)"),
  "an ordinary app stack");
ok(!notOurs("TypeError: x is undefined\n    at eval (eval at evalDcLogic (https://pro.ionob.in/support.js:805:16), <anonymous>:14035:35)"),
  "an error inside the runtime's eval'd island — where most of this app's code actually runs");
ok(!notOurs(undefined, undefined), "an error with NO stack and NO filename — reported, because losing a real crash is worse");
ok(!notOurs("", ""), "…and the same when both are empty strings");
ok(!notOurs("at Chrome (https://pro.ionob.in/app.js:1:1)"), "a stack that merely says 'Chrome' is not an extension");

console.log("\nboth handlers use it, and the resource-error guard is untouched:");
ok(/if \(notOurs\(e\.error && e\.error\.stack, e\.filename\)\) return;/.test(ui), "window.onerror consults it");
ok(/if \(notOurs\(r && r\.stack, ''\)\) return;/.test(ui),
  "so does unhandledrejection, which had no guard of any kind before");
ok(/if \(e\.target && e\.target !== window && e\.target\.tagName\) return;/.test(ui),
  "a failed image or script is still skipped the way it always was");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
