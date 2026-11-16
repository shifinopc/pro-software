/**
 * THE CONSOLE STILL RENDERS.
 *
 *   node scripts/smoke.mjs            # against a dev server already running on 5173
 *   BASE=http://localhost:4173 node scripts/smoke.mjs
 *
 * This is the only thing in the repo that RUNS the front end. The console is one 48,000-line file
 * in which the markup names its values as plain text — `{{ qcTotal }}` and 10,000 others — so
 * nothing else checks that those names resolve, that the script parses, or that anything appears.
 * `vite build` bundles the file without reading any of it, and `tsc` covers only `server/`.
 *
 * The failure this exists for happened for real: one `const` was used a few lines above where it
 * was created, and the entire application rendered as the single line
 *
 *     dashboard.renderVals(): Cannot access '_ptSets' before initialization
 *
 * A blank app, shipped by a change that compiled and built cleanly. It was caught only because
 * somebody happened to open a browser.
 *
 * DELIBERATELY SHALLOW. It signs in, opens the screens most likely to break, and demands that each
 * one painted something and raised no uncaught error. It is not a test of what the screens SAY —
 * that is the probe suite's job against the API. This is the smoke alarm: cheap, fast, and it goes
 * off for the whole class of "the page is blank now".
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:5173";
const API = process.env.SMOKE_API || "http://localhost:4100";
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;

/**
 * Screens, and one thing each must actually show. The text is picked to be structural — a heading
 * the screen owns — rather than data, so seeding changes do not make this red.
 */
const SCREENS = [
  ["/dashboard", /STIMES OPERATIONS|Good (morning|afternoon|evening)/i],
  ["/clients", /Clients/i],
  ["/quotations", /Quotations/i],
  ["/invoices", /Invoices/i],
  ["/leads", /Leads/i],
  ["/pipeline", /Pipeline/i],
  ["/settings", /Settings/i],
  ["/proposal-templates", /Proposal Templates/i],
];

let bad = 0;
const ok = (cond, what) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const browser = await chromium.launch();
const page = await browser.newPage();

/**
 * TWO KINDS OF RED, and only one of them is this test's business.
 *
 * `pageerror` is the application throwing — a ReferenceError in render, a null dereference. That is
 * exactly what this exists to catch, and it always fails.
 *
 * Console errors are a mixed bag. A failed request prints one, and so does a request that failed
 * because the API was restarting, or the network blinked, or CI was slow. Failing on those makes
 * the test flaky, and a flaky test is worse than no test: people learn to press the button again.
 * It caught the API restarting under `tsx watch` on the very first real run.
 *
 * So console messages fail only when they name a JavaScript fault. Transport trouble is reported
 * at the end as a note, where a human can judge it.
 */
const errors = [];
const noise = [];
const APP_FAULT = /ReferenceError|TypeError|SyntaxError|RangeError|is not a function|is not defined|Cannot read propert|Cannot access/;
page.on("pageerror", e => errors.push(String((e && e.message) || e)));
page.on("console", m => {
  if (m.type() !== "error") return;
  const t = m.text().slice(0, 200);
  (APP_FAULT.test(t) ? errors : noise).push("console: " + t);
});

try {
  // Signing in through the API rather than the form: this checks that SCREENS render, and a broken
  // sign-in form would otherwise fail all of them with one unhelpful message.
  if (!EMAIL || !PASSWORD) {
    console.log("SMOKE_EMAIL / SMOKE_PASSWORD are not set — give it an account that may read.");
    process.exit(2);
  }
  // Said plainly rather than thrown. An API that is not running is a setup problem, and a page of
  // ECONNREFUSED stack buries that under something that looks like a code fault.
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).catch(e => ({ ok: false, status: 0, _err: String(e?.cause?.code || e?.message || e) }));
  if (r.status === 0) {
    console.log(`the API at ${API} is not answering (${r._err}). Start it, then run this again.`);
    await browser.close();
    process.exit(2);
  }
  if (!r.ok) { console.log(`could not sign in: HTTP ${r.status}`); process.exit(2); }
  const { token } = await r.json();
  if (!token) { console.log("sign-in returned no token"); process.exit(2); }

  // Put the token in BEFORE anything loads. Setting it after a first visit meant that visit booted
  // signed out, fired its calls, and those 401s landed while the next screen was being judged.
  await page.addInitScript(t => {
    try { localStorage.setItem("stimespro:token", t); } catch { /* private mode */ }
  }, token);

  for (const [path, must] of SCREENS) {
    errors.length = 0; noise.length = 0;
    // A navigation that times out is a result, not a reason to stop. Left to throw, it ended the
    // whole run with a Playwright stack and no verdict on any screen — including the ones that had
    // already passed.
    try {
      // "commit", not "domcontentloaded": the console is one 4 MB document, and the browser has to
      // parse all of it before DOMContentLoaded fires — on a loaded machine that alone blew a 45s
      // budget and reported a timeout for a screen that was merely slow. Returning as soon as the
      // navigation commits leaves the waiting to waitForFunction below, which is the wait that
      // actually means something: it ends when the screen has painted its own words.
      await page.goto(BASE + path, { waitUntil: "commit", timeout: 30000 });
    } catch (e) {
      ok(false, `${path} did not even load — ${String(e).split("\n")[0].slice(0, 120)}`);
      continue;
    }
    // The console boots a lot before it paints. Wait for the screen's own words rather than a
    // fixed sleep, so a slow machine does not make this flaky and a fast one does not wait.
    let painted = false;
    try {
      await page.waitForFunction(
        re => new RegExp(re.source, re.flags).test(document.body.innerText || ""),
        { source: must.source, flags: must.flags },
        { timeout: 60000 },
      );
      painted = true;
    } catch { /* reported below, with whatever the page did show */ }

    const text = (await page.evaluate(() => document.body.innerText || "")).trim();
    ok(painted, `${path} painted${painted ? "" : ` — showed instead: ${JSON.stringify(text.slice(0, 160))}`}`);
    // THE ONE THAT MATTERS. A renderVals mistake arrives here, not as a blank page.
    ok(errors.length === 0, `${path} raised nothing${errors.length ? ` — ${errors.slice(0, 2).join(" | ")}` : ""}`);
  }
} finally {
  await browser.close();
}

if (noise.length) {
  // Reported, never fatal: these are requests that did not complete, which on a developer machine
  // usually means the API restarted mid-run. Worth seeing, not worth failing a build over.
  console.log(`\nalso seen, not failed on (${noise.length} transport error(s)):`);
  for (const n of [...new Set(noise)].slice(0, 4)) console.log("  · " + n);
}
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exitCode = bad ? 1 : 0;
