/**
 * Throwaway check: suspending a client locks every portal user under it out.
 *
 * Uses its OWN disposable client and users so no real client is ever suspended, and deletes them
 * afterwards. The assertions worth having are the negative ones:
 *   - a live session stops working, not just future sign-ins
 *   - the refusal says WHY, so nobody reads it as a password problem
 *   - staff are unaffected — they are not "under" a client
 *   - restoring gives access straight back, with no per-user flag left behind to go stale
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const post = (p: string, body: any, tok?: string) =>
  fetch(API + p, { method: "POST", headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, body: JSON.stringify(body) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
const get = (p: string, tok: string) =>
  fetch(API + p, { headers: { Authorization: "Bearer " + tok } }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const PW = "ProbeOnly!2026";
  const hash = await bcrypt.hash(PW, 10);

  const co = await prisma.company.create({ data: { name: "ZZ Suspend Probe Ltd", cr: "0000", country: "SA", status: "active" } });
  // Two users, because the requirement is EVERY user under the client, not just the one who signed in.
  await prisma.user.create({ data: { name: "ZZ Portal One", email: "zz-portal-1@example.invalid", roleId: "client_admin", status: "active", type: "portal", companyId: co.id, passwordHash: hash } });
  await prisma.user.create({ data: { name: "ZZ Portal Two", email: "zz-portal-2@example.invalid", roleId: "client_admin", status: "active", type: "portal", companyId: co.id, passwordHash: hash } });
  const staff = await prisma.user.create({ data: { name: "ZZ Staff", email: "zz-staff@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: hash } });

  // ── before suspension ──
  const a = await post("/api/auth/portal-login", { email: "zz-portal-1@example.invalid", password: PW });
  console.log(`portal user signs in normally:        ${a.status === 200 ? "YES" : "NO (" + a.status + ")"}`);
  if (a.status !== 200) fail("a portal user of an active client could not sign in");
  const liveToken = a.body.token;

  const s = await post("/api/auth/login", { email: "zz-staff@example.invalid", password: PW });
  const staffToken = s.body.token;
  const before = await get("/api/portal/me", liveToken);
  console.log(`…and their live session works:        ${before.status === 200 ? "YES" : "NO (" + before.status + ")"}`);

  // ── suspend, through the real endpoint a person would use ──
  const sus = await post(`/api/companies/${co.id}/suspend`, { reason: "Probe — outstanding balance" }, staffToken);
  console.log(`\nsuspended via the console endpoint:   ${sus.status === 200 ? "YES" : "NO (" + sus.status + ")"}`);

  // ── the session already open must stop working ──
  const live = await get("/api/portal/me", liveToken);
  console.log(`  the OPEN session stops working:     ${live.status === 403 ? "YES" : "NO — still " + live.status}`);
  if (live.status !== 403) fail("a session open at the moment of suspension kept working");
  console.log(`  …and says why:                      "${live.body.error}"`);
  if (!live.body.suspended) fail("the refusal does not carry suspended:true, so the portal cannot explain it");

  // ── neither user can sign in, not just the one who was online ──
  for (const e of ["zz-portal-1@example.invalid", "zz-portal-2@example.invalid"]) {
    const r = await post("/api/auth/portal-login", { email: e, password: PW });
    console.log(`  ${e.padEnd(30)} sign-in: ${r.status === 403 ? "REFUSED" : "ALLOWED (" + r.status + ")"}`);
    if (r.status !== 403) fail(`${e} could still sign in`);
    if (!/suspend/i.test(String(r.body.error))) fail("the sign-in refusal does not mention suspension");
  }

  // ── staff must be unaffected ──
  const st = await get("/api/companies", staffToken);
  console.log(`  staff console unaffected:           ${st.status === 200 ? "YES" : "NO (" + st.status + ")"}`);
  if (st.status !== 200) fail("suspending a client locked a STAFF user out");

  // ── nothing was copied onto the user rows ──
  const rows = await prisma.user.findMany({ where: { companyId: co.id }, select: { status: true } });
  console.log(`  user rows left untouched:           ${rows.every(r => r.status === "active") ? "YES (all still active)" : "NO — status was copied onto them"}`);
  if (!rows.every(r => r.status === "active")) fail("company status was copied onto users; restoring would blanket-reactivate");

  // ── restore ──
  await post(`/api/companies/${co.id}/restore`, {}, staffToken);
  const back = await post("/api/auth/portal-login", { email: "zz-portal-1@example.invalid", password: PW });
  console.log(`\nrestored → signs in again:            ${back.status === 200 ? "YES" : "NO (" + back.status + ")"}`);
  if (back.status !== 200) fail("restoring the client did not restore portal access");

  // ── clean up ──
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.company.delete({ where: { id: co.id } });
  const left = await prisma.company.count({ where: { name: { startsWith: "ZZ Suspend" } } }) + await prisma.user.count({ where: { email: { contains: "example.invalid" } } });
  console.log(`cleaned up:                           ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
