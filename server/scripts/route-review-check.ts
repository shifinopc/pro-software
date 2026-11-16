/**
 * NOTHING REACHES THE OPEN INTERNET WITHOUT SOMEBODY HAVING LOOKED AT IT.
 *
 *   npx tsx scripts/route-review-check.ts        (needs the API running on this database)
 *
 * `probe-permission-coverage` already proves that routes the permission grid does not cover still
 * default to "any staff may read, only an admin may write". That proves the default is SAFE. It
 * does not prove anybody CHOSE it, and it says nothing at all about the routes that answer with no
 * sign-in — which is the list where a mistake is instantly somebody else's problem.
 *
 * This pins that list. OPEN is every route reachable with no token, read from the live router. Add
 * a route without a guard and this goes red until a person writes down why it belongs there — which
 * is the moment the question gets asked.
 *
 * The shape is borrowed from the ioNob World API, where the equivalent spec caught three admin
 * routes that had inherited a fence nobody had reviewed.
 *
 * ADDING A LINE HERE IS THE REVIEW. Do not paste the failure output in to make it green: open the
 * route, decide whether a stranger should be able to call it, and only then write the reason.
 *
 * Read-only. Writes nothing, anywhere.
 */
import { tokenForEmail } from "./_suite-auth.js";
import { assertTarget } from "./_live-guard.js";
import { prisma } from "../src/db.js";

assertTarget("route-review-check");

const API = process.env.SUITE_API ?? "http://localhost:4100";

/**
 * REACHABLE WITH NO SIGN-IN. Every line says why a stranger may call it.
 *
 * Note what is NOT here and does not need to be: the whole `/api/portal` surface. Those are outside
 * the STAFF permission grid — a client is not staff — but they still require a token.
 */
const OPEN: Record<string, string> = {
  "/api": "the API's own name and version — says nothing about anybody",
  "/api/health": "the deploy and the container healthcheck both read it",
  "/api/countries": "a fixed reference list, identical for everyone",
  "/api/auth/login": "signing in cannot require being signed in",
  "/api/auth/portal-login": "the same, for clients",
  "/api/auth/forgot-password": "asked for BY somebody who cannot sign in; rate limited",
  "/api/auth/reset-password": "carries its own single-use token instead of a session",
  "/api/stream": "live updates; carries a one-time ticket because EventSource cannot send a header",
  "/api/error-reports": "a browser that has just crashed may have no usable session; rate limited",
  "/api/public/enquiry": "the public website's contact form posts here; rate limited",
  "/api/public/book/:slug": "the public booking page a client is sent a link to; rate limited",
  "/api/mailbox/callback": "the mail provider redirects the browser here after consent",
  // Meta calls this from its own servers, so it cannot carry one of our tokens. It is not
  // unprotected: every POST is verified against the app secret over the RAW bytes, and an unsigned
  // or wrongly signed one is refused with 403 before anything is read. See src/whatsapp-webhook.ts.
  "/api/whatsapp/webhook": "WhatsApp posts here; authenticated by Meta's signature, not by a token",
};

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

async function adminToken(): Promise<string> {
  try { return await tokenForEmail("suite-admin@local.test"); } catch { /* not the suite seed */ }
  const u = await prisma.user.findFirst({
    where: { type: "staff", roleId: { in: ["admin", "super_admin"] }, status: "active" },
    select: { email: true },
  });
  if (!u) throw new Error("no active admin to read the router with");
  return tokenForEmail(u.email);
}

try {
  const token = await adminToken();
  const r = await fetch(`${API}/api/permissions/coverage`, { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) {
    console.log(`could not read the router: HTTP ${r.status} from ${API}. Is the API running against this database?`);
    process.exit(2);
  }
  const cov: any = await r.json();
  console.log(`the router has ${cov.total} routes under /api\n`);

  const reviewed = new Set(Object.keys(OPEN));
  const live: string[] = cov.openPaths ?? [];
  if (!Array.isArray(cov.openPaths)) {
    console.log("this API does not report openPaths — it is older than this check. Restart it.");
    process.exit(2);
  }

  const unreviewed = live.filter(p => !reviewed.has(p)).sort();
  const vanished = [...reviewed].filter(p => !live.includes(p)).sort();

  console.log(`OPEN — ${live.length} route(s) answer with no sign-in.`);
  ok(unreviewed.length === 0, unreviewed.length
    ? `${unreviewed.length} NOT reviewed:\n         ${unreviewed.join("\n         ")}\n         → open each one. If a stranger should be able to call it, add it to OPEN above with the reason. If not, give it requireAuth.`
    : "every one of them is on the reviewed list");
  // The other direction matters too: a name left behind after its route is gone turns the list into
  // a record of what used to be true, which is worse than having no list.
  ok(vanished.length === 0, vanished.length
    ? `${vanished.length} reviewed but no longer mounted: ${vanished.join(", ")} — delete them from this file`
    : "…and nothing on the list has quietly disappeared from the API");

  // A guard that exists but is not reached protects nothing. If this ever hits zero, the walk is
  // broken rather than the app being wide open.
  ok(live.length > 0 && live.length < cov.total / 2,
    `${live.length} of ${cov.total} routes are open — the rest require a token`);
} finally {
  await prisma.$disconnect();
}

console.log(bad ? `\n${bad} failed` : "\nall good");
/**
 * `process.exitCode`, not `process.exit()`.
 *
 * Exiting hard straight after disconnecting Prisma made libuv abort on Windows — the check printed
 * "all good" and then handed back exit code 127, which is a red build for a green run. Setting the
 * code and letting the process finish on its own lets the handles close first.
 */
process.exitCode = bad ? 1 : 0;
