/**
 * ONE REQUEST INSTEAD OF EIGHTY.
 *
 * The console asks for about eighty lists when it starts. Measured on the live box: one call to the
 * cheapest of them takes 5ms, eighty of them take 570ms. Almost none of that is the database — it is
 * ~4ms of fixed cost per request (HTTP, routing, verifying the token, looking the user up) paid
 * eighty times to answer questions the server could have answered together.
 *
 * So this runs them together: one token check, one user lookup, one response.
 *
 * IT RUNS THE REAL ROUTES, IN PROCESS. The obvious implementation — a handler that re-queries the
 * eighty things itself — is the dangerous one: each of those routes carries its own guards, and
 * several scope what they return to the caller's role or client. A second copy of those rules is a
 * second place for them to be wrong, and the failure is silent and the worst kind: one role seeing
 * another's data. Nothing here knows what any route returns or who may see it. It builds a request
 * object, hands it to the same Express app, and keeps whatever comes back — so a permission added
 * to a route tomorrow applies here without anybody remembering this file exists.
 *
 * WHAT IT IS NOT. Not a cache: nothing is stored between requests, and every boot runs the routes
 * afresh. Not a proxy: no socket, no second HTTP request, no loopback.
 */
import http from "node:http";
import { Readable } from "node:stream";
import type { Express, Request, Response } from "express";
import { requireAuth, requireStaff } from "./auth.js";

/**
 * The paths the console fetches while starting, taken from `_hydrateAuthed` in index.html.
 *
 * GET only, and listed rather than taken from the caller: a caller that could name any path would
 * turn this into a way to fan one request into hundreds, and an authorisation question ("may this
 * person batch these?") that the individual routes never had to answer. A path the console asks for
 * and this list has not got still works — it just does not come back in the batch, and the console
 * fetches it the old way. That fallback is what makes adding to this list safe to forget.
 */
export const BOOT_PATHS: string[] = [
  "/api/auth/my-activity",
  "/api/settings/org", "/api/settings/perms", "/api/settings/security", "/api/settings/roles",
  "/api/settings/notifRules", "/api/settings/notifDigest", "/api/settings/printBranding",
  "/api/settings/printLayout", "/api/settings/countryRules", "/api/settings/departments",
  "/api/settings/salesRules", "/api/settings/jobRules",
  "/api/permissions", "/api/permissions/coverage",
  "/api/mailbox/status", "/api/email-config", "/api/email-log?days=7",
  "/api/courier-job-types", "/api/checklist-vocabulary", "/api/custom-objects",
  "/api/record-sequences", "/api/error-reports", "/api/document-types", "/api/collateral",
  "/api/workflow/templates", "/api/workflow/checklist-rules", "/api/workflow/field-sets",
  "/api/workflow/instances",
  "/api/companies?lifecycle=lead,prospect,lost,churned",
  "/api/contacts", "/api/contacts?includeArchived=1",
  "/api/pipeline", "/api/pipeline-stages", "/api/lead-sources", "/api/lost-reasons",
  "/api/competitors", "/api/industries", "/api/products", "/api/charge-types", "/api/campaigns",
  "/api/cancel-reasons", "/api/team-performance", "/api/targets-forecast", "/api/inbox",
  "/api/teams?all=1", "/api/follow-ups",
  "/api/interactions", "/api/stage-analytics", "/api/activities",
  "/api/booking-links", "/api/lead-scores", "/api/owner-rotation", "/api/assignment-rules",
  "/api/integrations", "/api/assignable-owners?all=1", "/api/upgrade-requests",
  "/api/activity-log", "/api/subscriptions", "/api/packages", "/api/gov-centers",
  "/api/countries", "/api/packs", "/api/packs/installed", "/api/packs/updates",
  "/api/workforce", "/api/workforce-history?days=90", "/api/setup-check", "/api/groups",
  "/api/service-items", "/api/api-keys", "/api/credentials", "/api/notifications",
  // The rest of what a cold start asks for, found by counting the requests a real sign-in made
  // after the first list was in place: twenty-four were left, and all but the two POSTs below are
  // plain GET lists that were already being fetched anyway.
  //   /api/auth/login and /api/stream-ticket are POSTs and stay out — this batch is GET only.
  //
  // NOT HERE, DELIBERATELY: /api/auth/me, /api/companies, /api/documents, /api/invoices,
  // /api/tasks, /api/service-requests and /api/crm-dashboard. Those are what the dashboard reads,
  // and the console fetches them on their own, alongside this batch. Batching them too meant the
  // first screen showed zeros until everything had arrived — about a second of numbers that look
  // like answers. They are listed as FIRST_PAINT in index.html; putting them back here would have
  // them fetched twice.
  "/api/users", "/api/employees", "/api/payments", "/api/quotations", "/api/audit",
  "/api/sales-report", "/api/proposal-templates", "/api/workflow/my-work",
  "/api/workforce-bands", "/api/workforce-band-sets",
  "/api/appointments", "/api/appointment-statuses", "/api/appointment-types",
  "/api/courier-shipments", "/api/courier-statuses",
  "/api/agents", "/api/agents/connection",
];

type Answer = { status: number; body: unknown };

/**
 * Run one path through the app and keep what it answered.
 *
 * The response is a real ServerResponse so that everything Express does to it — `res.json`,
 * `res.status`, the header helpers — works as it does for any request. What it is NOT given is a
 * socket: `write` and `end` are replaced so the bytes land in an array instead of on a connection
 * that does not exist.
 *
 * `accept-encoding: identity` matters. The compression middleware wraps `write`/`end` when the
 * caller accepts gzip, and it would hand back compressed bytes that this then tried to parse as
 * text. Asking for no encoding keeps the body readable; the outer response is compressed once,
 * on the way out, as it always was.
 */
function runInProcess(app: Express, parent: Request, path: string): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    const req = new Readable({ read() { this.push(null); } }) as unknown as http.IncomingMessage & { auth?: unknown };
    req.method = "GET";
    req.url = path;
    req.headers = { ...parent.headers, "accept-encoding": "identity" };
    (req as any).connection = (parent as any).connection;
    (req as any).socket = (parent as any).socket;
    // The verified principal, carried over so requireAuth does not repeat the work. See auth.ts.
    (req as any).auth = (parent as any).auth;

    const res = new http.ServerResponse(req as http.IncomingMessage) as http.ServerResponse & { json?: unknown };
    const chunks: Buffer[] = [];
    let settled = false;
    // A route that never answers must not hold the whole batch open.
    const timer = setTimeout(() => settle({ status: 504, body: null }), 10_000);
    const settle = (a: Answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(a);
    };
    const finish = () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (text) { try { body = JSON.parse(text); } catch { body = null; } }
      settle({ status: res.statusCode || 200, body });
    };
    (res as any).write = (chunk: any) => { if (chunk) chunks.push(Buffer.from(chunk)); return true; };
    (res as any).end = (chunk?: any) => { if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk)); finish(); return res; };

    // Express calls this when no route matched.
    try { (app as any).handle(req, res, () => settle({ status: 404, body: null })); }
    catch { settle({ status: 500, body: null }); }
  });
}

export function mountBoot(app: Express) {
  /**
   * The paths are answered in parallel, which is only interleaving — Node runs one thread — but it
   * lets the database waits overlap, which is where the remaining time goes once the eighty
   * repetitions of the fixed cost are gone.
   *
   * A path that fails comes back as its status with a null body rather than failing the batch: the
   * console already treats a failed list as "not loaded yet" and falls back to fetching it, and one
   * route having a bad day should not blank the whole screen.
   */
  app.get("/api/boot", requireAuth, requireStaff, async (req: Request, res: Response) => {
    const answers = await Promise.all(BOOT_PATHS.map(p => runInProcess(app, req, p).then(a => [p, a] as const)));
    const out: Record<string, Answer> = {};
    for (const [p, a] of answers) out[p] = a;
    res.json({ paths: out });
  });
}
