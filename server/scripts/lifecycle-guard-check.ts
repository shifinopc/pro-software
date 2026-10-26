/**
 * A COMPANY'S LIFECYCLE CANNOT BE SET THROUGH THE GENERIC ROUTE.
 *
 *   npx tsx scripts/lifecycle-guard-check.ts        (needs the dev API running on :4100)
 *
 * PUT /api/companies/:id/details refuses `lifecycle` on purpose — "a correction form must not be
 * able to turn a lead into a client, which provisions a portal login and opens a deal". That
 * refusal lived on one of the two routes that can write a company. The generic PUT took whatever it
 * was handed.
 *
 * The escalation is the smaller half of it. POST /:id/lifecycle does the rest of what the change
 * means — the portal login, the opened deal, the dated transition. Setting the column alone leaves
 * a row that says "client" with none of that: not a client, and no longer a lead, which is harder
 * to spot and harder to undo than a refusal.
 *
 * LOCAL ONLY, and on a company it creates and deletes itself. It drives the real HTTP route rather
 * than re-implementing the rule, because the rule only matters where the request actually arrives.
 */
import { prisma } from "../src/db.js";
import { signToken } from "../src/auth.js";

const API = process.env.API_BASE ?? "http://localhost:4100";

const host = String(process.env.DATABASE_URL ?? "").split("@")[1] ?? "";
if (!/^(localhost|127\.0\.0\.1)/.test(host)) { console.error("This writes test rows — local database only. Refusing."); process.exit(2); }

const staff = await prisma.user.findFirst({ where: { type: "staff", status: "active" }, select: { id: true, type: true, roleId: true, companyId: true, tokenVersion: true } });
if (!staff) { console.error("No active staff user to sign a token for."); process.exit(2); }
// Minting a token reads the user and changes nothing about them — no password is touched.
const token = signToken({ sub: staff.id, type: staff.type, role: staff.roleId, companyId: staff.companyId, tv: staff.tokenVersion } as any);

try {
  await fetch(`${API}/api/countries`);
} catch {
  console.error(`The dev API is not answering on ${API}. Start it (cd server && pnpm dev) and run this again.`);
  process.exit(2);
}

const co = await prisma.company.create({ data: { name: "zz-lifecycle-guard-probe", lifecycle: "lead", createdAt: new Date().toISOString() } });
const put = (body: any) => fetch(`${API}/api/companies/${co.id}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
  body: JSON.stringify(body),
});
const lifecycleNow = async () => (await prisma.company.findUnique({ where: { id: co.id }, select: { lifecycle: true } }))?.lifecycle;

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };

try {
  // 1. The escalation itself.
  const r1 = await put({ name: co.name, lifecycle: "client" });
  if (r1.status === 409) console.log("  ok    turning a lead into a client here is refused (409)");
  else fail(`promoting a lead through the generic PUT answered ${r1.status}, expected 409`);
  const after1 = await lifecycleNow();
  if (after1 === "lead") console.log("  ok    and the row is untouched — still a lead");
  else fail(`the row was changed anyway: lifecycle is now "${after1}"`);

  // 2. A caller echoing the row back unchanged must not be rejected for a field it never meant to
  //    touch — otherwise the guard breaks every "send the whole object" client there is.
  const r2 = await put({ name: co.name, lifecycle: "lead", city: "Riyadh" });
  if (r2.ok) console.log("  ok    echoing the SAME lifecycle back is allowed");
  else fail(`echoing the unchanged lifecycle answered ${r2.status}, expected 200 — the guard is too strict`);

  // 3. Ordinary edits still work. The client edit form posts to this route and must keep working.
  const r3 = await put({ name: co.name, industry: "Testing" });
  const after3 = await prisma.company.findUnique({ where: { id: co.id }, select: { industry: true } });
  if (r3.ok && after3?.industry === "Testing") console.log("  ok    an ordinary field still saves through this route");
  else fail(`a normal edit answered ${r3.status} and left industry as "${after3?.industry}"`);
} finally {
  await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
}

console.log(bad ? `\n${bad} wrong.` : "\nin order.");
await prisma.$disconnect();
process.exit(bad ? 1 : 0);
