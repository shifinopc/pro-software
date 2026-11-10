/**
 * THE EXPIRY COUNTDOWN MUST STAND DOWN WHEN SOMEBODY SIGNS IN.
 *
 *   npx tsx scripts/session-expiry-check.ts        (static — reads index.html, needs no server)
 *
 * The bug this guards against, as reported: "after session timeout, the first login gets auto
 * logged out and we need to login again."
 *
 * On the first 401 carrying an Authorization header the console starts a twelve-second countdown
 * and then deletes the token and redirects. The countdown was started once and never cancelled, so
 * signing in inside those twelve seconds — which is exactly what the banner invites you to do —
 * ended with the timer deleting the token you had just earned. The second attempt worked only
 * because that redirect reloads the page and takes the timer with it, which is what made it look
 * intermittent rather than systematic.
 *
 * Reproduced before the fix by storing a sentinel token mid-countdown and watching it vanish.
 *
 * The three properties below are what keep it fixed, and each one fails differently:
 *
 *   · it compares against the token that was REFUSED, so a new one can be recognised
 *   · it stands down only for a DIFFERENT and PRESENT token — a token that merely disappeared
 *     means a logout elsewhere, and then the countdown should still land you on the sign-in page
 *     rather than leave a stale screen up
 *   · standing down clears the banner too, or the screen keeps announcing an expiry that is over
 *
 * Checked statically because the behaviour lives in one block of a 46,000-line single-file app, and
 * the whole failure mode is "a timer nobody cancels" — which is invisible in review and silent at
 * runtime until a user loses a login.
 */
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const has = (needle: string, what: string) =>
  src.includes(needle) ? ok(what) : fail(`${what} — not found: ${JSON.stringify(needle.slice(0, 80))}`);

console.log("the countdown knows which token died");
has("this._expiredFor = dead9;", "it records the token that was refused");

console.log("\n…and stands down for a new one");
has("if (now9 && now9 !== this._expiredFor) {", "a DIFFERENT and PRESENT token cancels the countdown");
has("this.setState({ authExpired: false, authExpiredIn: 0 });", "standing down clears the banner as well as the timer");

console.log("\n…but still signs out a session nobody rescued");
has("location.href = '/dashboard';", "the countdown still redirects when it runs out");
has("localStorage.removeItem('stimespro:token');", "and still clears the dead token");

console.log("\nthe timer handle is released, so a later expiry can start a new countdown");
// `if (!this._expiredTimer)` guards starting one. Leaving the handle set after it fires would mean
// a second expiry in the same page life never starts a countdown at all, and the session would
// then sit there dead with no banner and no redirect.
const nulled = (src.match(/this\._expiredTimer = null;/g) ?? []).length;
nulled >= 2
  ? ok(`the handle is nulled on both exits (${nulled} sites)`)
  : fail(`the handle is nulled at ${nulled} site(s); both the stand-down and the fire path must release it`);

console.log("\nthe countdown is still started only once per dead session");
has("if (!this._expiredTimer) {", "later 401s from the same dead session do not restart it");

console.log(bad ? `\n${bad} problem(s)` : "\nall good");
process.exit(bad ? 1 : 0);
