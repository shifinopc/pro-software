/**
 * "INBOX ZERO" MUST NOT BE WHAT A FAILED REQUEST LOOKS LIKE.
 *
 *   npx tsx scripts/inbox-zero-check.ts
 *
 * My Tasks is fed by two requests — plain tasks and workflow steps. When either failed, the rows
 * were simply absent and the screen drew its cheerful empty card: a party popper and "Nothing
 * waiting on you. Inbox zero." A PRO officer with eighty-five open steps was told they had none.
 * That is the worst way for an inbox to break, because it does not look broken: nobody reloads a
 * screen that says it is finished. It cost a morning — a step raised at 03:55 was hunted as
 * "missing" until the API turned out to have been stopped.
 *
 * `_load` has recorded a per-dataset outcome since the day it was written and nothing read it.
 * Now the empty card does. This lifts that decision out of index.html and runs it, rather than
 * grepping for the strings: the point is which of the three states comes out for a given pair of
 * load outcomes, and only evaluating it can answer that.
 */
import fs from "node:fs";
import path from "node:path";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const ui = fs.readFileSync(path.join(import.meta.dirname, "../../index.html"), "utf8");

/** The real source of the decision, pulled out of the render and made callable. */
const cut = (from: string, to: string) => {
  const a = ui.indexOf(from);
  const b = ui.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`inbox-zero-check: could not find ${JSON.stringify(a < 0 ? from : to)} — the screen was rewritten, so update this check`);
  return ui.slice(a, b + to.length);
};
const logic = cut("const _mtLoad9 = this.state.loadState", "=== 'loading');").replace(/this\.state/g, "state");
const props = cut("mwFailed: _mtFailed9.length > 0,", "mwEmptyBorder:");
type Card = { mwFailed: boolean; mwEmptyTitle: string; mwEmptyBody: string };
const run = new Function("state", `${logic}\nreturn { ${props.slice(0, props.lastIndexOf("mwEmptyBorder:"))} };`) as (s: any) => Card;
/** Called with the per-dataset outcomes `_load` records, which is all this decision reads. */
const card = (loadState: Record<string, string>): Card => run({ loadState });

console.log("a queue that loaded says what it means:");
ok(card({}).mwEmptyTitle.includes("Inbox zero"), "never loaded through _load (design samples, local state) — unchanged");
ok(card({ myWorkData: "ok", tasksData: "empty" }).mwEmptyTitle.includes("Inbox zero"), "both loaded and genuinely empty — still inbox zero");
ok(!card({ myWorkData: "ok" }).mwFailed, "…and is not dressed up as a failure");

console.log("\na queue that did NOT load says THAT, which is the whole point:");
for (const st of ["offline", "error"]) {
  const r = card({ myWorkData: st });
  ok(r.mwFailed && /could not be loaded/.test(r.mwEmptyTitle), `${st}: the card reports a failure, not an empty inbox`);
  ok(/not an empty inbox/.test(r.mwEmptyBody) && /workflow steps/.test(r.mwEmptyBody), `${st}: and names what is missing`);
}
ok(/workflow steps and tasks/.test(card({ myWorkData: "offline", tasksData: "error" }).mwEmptyBody),
  "both feeds down — both are named");
ok(/tasks/.test(card({ tasksData: "offline" }).mwEmptyBody) && !/workflow/.test(card({ tasksData: "offline" }).mwEmptyBody),
  "only the task list down — only that one is named");
ok(/expired/i.test(card({ myWorkData: "expired" }).mwEmptyTitle), "a dead session is named as one, not as 'could not load'");
ok(/permission/i.test(card({ tasksData: "denied" }).mwEmptyTitle), "a refusal is named as one — nothing to retry there");

console.log("\nand mid-flight is not 'finished':");
ok(card({ myWorkData: "loading" }).mwEmptyTitle.includes("Loading"), "still loading — says so rather than inbox zero");
ok(!card({ myWorkData: "loading" }).mwFailed, "…without claiming a failure");
ok(card({ myWorkData: "loading", tasksData: "offline" }).mwFailed, "a failure beside a load in flight still reads as the failure");

console.log("\nthe card is wired to it, and the retry can actually clear it:");
ok(ui.includes('<div style="font-weight:700;">{{ mwEmptyTitle }}</div>'), "the card binds the title instead of hardcoding one");
ok(!/>\uD83C\uDF89 Nothing waiting on you/.test(ui), "the literal inbox-zero text is gone from the markup");
ok(/mwRetry: \(\) => \{\s*this\._load\('\/api\/workflow\/my-work'/.test(ui),
  "Try again goes through _load — _opReload does not record the outcome, so a second failure would read as inbox zero");
ok(ui.includes("if (this.state.apiOffline) this.setState({ apiOffline: false });"),
  "a successful load clears the offline banner, so a recovered queue is not shown under 'cannot reach the server'");

/**
 * THE OTHER WAY THIS SCREEN SHOWED AN EMPTY QUEUE, and the more serious one.
 *
 * The banner said "Viewing as Navas · audit-logged" while the session's token was the admin's: a
 * sign-in writes a new token over the impersonated one and left the marker behind. My Tasks filters
 * to the signed-in NAME, so the officer's eighty-five steps were filtered out and the screen
 * truthfully reported an empty inbox — for an account nobody assigns work to. The empty card was
 * right; the header was lying. Worse than the missing rows: anything done in that state is recorded
 * as the admin under a banner promising otherwise.
 */
console.log("\na view-as cannot outlive the session it describes:");
ok(/this\._impCheck = \(me9\) => \{/.test(ui), "there is a check that the marker matches who the token actually is");
ok(/if \(!m9 \|\| !me9 \|\| m9\.name === me9\.name\) return;/.test(ui), "…it compares the two names and leaves a genuine view-as alone");
ok(/\['stimespro:impersonate', 'stimespro:tokenOrig', 'stimespro:userOrig'\]\.forEach\(k9 => localStorage\.removeItem\(k9\)\);/.test(ui),
  "…and on a mismatch drops the marker AND the way back, which is already the current token");
ok(/\{ if \(v && v\.email\) \{ this\._impCheck\(v\);/.test(ui),
  "it runs every time /api/auth/me answers — the only moment the real identity is known");
ok((ui.match(/\['stimespro:impersonate', 'stimespro:tokenOrig', 'stimespro:userOrig'\]/g) || []).length === 2,
  "signing in clears them too, at the cause rather than only at the symptom");
ok(/this\.setState\(\{ auth: 'in', lError: '', lPass: '', impersonate: null, impersonateRole: null \}\)/.test(ui),
  "…and clears the banner's state with it, so it does not survive in the open page");

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
