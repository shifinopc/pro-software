/**
 * Throwaway check for what the permissions grid governs.
 *
 * The Permissions screen could never answer two questions. Why there is no "+ Add module" beside
 * "+ Create role" — because a module means something only where MODULE_OF binds routes to it, so an
 * invented one would govern nothing and every box ticked under it would enforce nothing, which is
 * the exact lie the enforced matrix was written to end. And which routes the grid does NOT cover:
 * those keep their old hardcoded gate, which is safe but was invisible.
 *
 * What must be true:
 *   - the coverage is read from the ROUTER, so it cannot drift from what was actually registered
 *   - a route counted under a module really is judged by that module's cell
 *   - the panel's claim about ungoverned routes is TRUE: any staff may read, only an admin may write
 *   - exempt routes are exempt because they must be (sign-in cannot require being signed in)
 *
 * Own users. Deletes them afterwards.
 */
import { prisma } from "../src/db.js";
import { coverageOf, MODULES } from "../src/permissions.js";
import bcrypt from "bcryptjs";

const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";
const ADMIN = "zp-admin@example.invalid";
const OFFICER = "zp-officer@example.invalid";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

const sweep = () => prisma.user.deleteMany({ where: { email: { in: [ADMIN, OFFICER] } } });

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  for (const [email, roleId, name] of [[ADMIN, "admin", "ZP Admin"], [OFFICER, "pro_officer", "ZP Officer"]]) {
    await prisma.user.create({ data: { name, email, roleId, status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  }
  const tokOf = async (e: string) => (await call("POST", "/api/auth/login", { email: e, password: PW })).body.token as string;
  const admin = await tokOf(ADMIN);
  const officer = await tokOf(OFFICER);
  if (!admin || !officer) { console.log("could not sign in - is the API running?"); process.exit(1); }

  const cov = (await call("GET", "/api/permissions/coverage", undefined, admin)).body;
  console.log(`routes seen:                             ${cov.total} (${cov.exempt} exempt, ${cov.ungoverned.length} ungoverned)`);
  if (!(cov.total > 100)) fail("the coverage barely saw any routes - it is not reading the router");

  // ── it is read from the router, not from a list ────────────────────────────────────────────
  //
  // Fed a fake router with one route, it must report exactly that. A maintained list would answer
  // the same thing whatever it was handed, which is how such a list drifts unnoticed.
  const fake = coverageOf([{ route: { path: "/api/companies" } }, { route: { path: "/api/zzz-nothing-binds-this" } }]);
  const clients = fake.modules.find(m => m.module === "Clients");
  console.log(`\ncounted from the router it is given:      ${fake.total === 2 && clients?.routes === 1 ? "YES" : "NO"}`);
  if (fake.total !== 2 || clients?.routes !== 1) fail("coverage did not reflect the router it was handed");
  console.log(`an unbound path is reported, not hidden: ${fake.ungoverned.includes("/api/zzz-nothing-binds-this") ? "YES" : "NO"}`);
  if (!fake.ungoverned.includes("/api/zzz-nothing-binds-this")) fail("a route no module governs was not reported");
  console.log(`every module is listed, zeroes included: ${fake.modules.length === MODULES.length ? "YES" : "NO"}`);
  if (fake.modules.length !== MODULES.length) fail("a module was omitted - one governing nothing is exactly the one worth seeing");

  // ── a governed route really is judged by its cell ──────────────────────────────────────────
  //
  // PRO Officer has Settings [0,0,0,0,0,0], and /api/permissions/coverage is bound to Settings.
  const officerCov = await call("GET", "/api/permissions/coverage", undefined, officer);
  console.log(`\na governed route obeys its cell:         ${officerCov.status === 403 ? "YES" : "NO (" + officerCov.status + ")"}`);
  if (officerCov.status !== 403) fail("a route bound to Settings let through a role with no Settings access");
  console.log(`...and the refusal names the cell:       ${officerCov.body?.module === "Settings" ? "YES" : "NO"}`);

  // ── the panel's claim about UNGOVERNED routes is true ──────────────────────────────────────
  //
  // The screen tells an admin these keep the rule they always had. That sentence is worth nothing
  // unless it is checked, so: a non-admin staff member may read one and may not write it.
  const sample = cov.ungoverned.find((p: string) => p === "/api/courier-job-types");
  if (!sample) fail("expected /api/courier-job-types among the ungoverned routes");
  const read = await call("GET", "/api/courier-job-types", undefined, officer);
  console.log(`\nungoverned route: staff may read:        ${read.status === 200 ? "YES" : "NO (" + read.status + ")"}`);
  if (read.status !== 200) fail("a non-admin lost read access to an ungoverned route - the screen's claim is false");
  const write = await call("PUT", "/api/courier-job-types", { rows: [{ name: "ZP Should never save" }] }, officer);
  console.log(`ungoverned route: only admin may write:  ${write.status === 403 ? "YES" : "NO (" + write.status + ")"}`);
  if (write.status !== 403) fail("a non-admin wrote an ungoverned route - the screen's claim is false");
  const left = await prisma.courierJobType.findFirst({ where: { name: "ZP Should never save" } });
  console.log(`...and nothing was written:              ${left === null ? "YES" : "NO"}`);
  if (left !== null) fail("the refused write still changed data");

  // ── sign-in cannot require being signed in ─────────────────────────────────────────────────
  const anon = await call("POST", "/api/auth/login", { email: ADMIN, password: PW });
  console.log(`\nexempt routes really are reachable:      ${anon.status === 200 ? "YES" : "NO (" + anon.status + ")"}`);
  if (anon.status !== 200) fail("an exempt route was gated - nobody could sign in");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
