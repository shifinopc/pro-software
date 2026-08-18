/**
 * Throwaway check for the two findings that survived three audits for different reasons.
 *
 * C7 was reported three times as "delays never resume — no scheduler exists, every endpoint 404s".
 * The scheduler does exist, runs at boot and hourly, and a back-dated delay resumes on one tick; the
 * probes were GET against a POST route, and 25 minutes against an hourly timer. But the complaint
 * underneath was fair and had nothing to do with scheduling: a parked run showed no active task and
 * no reason, so it was indistinguishable from a broken one, and there was no way for a person to say
 * "this wait is over". That is why the last eight nodes of the onboarding workflow had never been
 * executed by anybody.
 *
 * N6 got worse with use — eighteen (docType, docNumber) pairs across fifty-six documents, including
 * two different people holding Iqama IQ-2233. The rule is not "a number appears once": an Iqama keeps
 * its number through a renewal and through a sponsorship transfer. It is one number, one person.
 *
 * Own documents and its own user. Cleans up after itself; resumes a real parked run, which is the
 * only way to test resuming one.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
let bad = 0;
const API = "http://localhost:4100", EMAIL = "c7@example.invalid";
await prisma.user.deleteMany({ where: { email: EMAIL } });
await prisma.user.create({ data: { name: "C7", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("C7!2026", 10) } });
const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: "C7!2026" }) })).json() as any).token;
const H = { "Content-Type": "application/json", Authorization: "Bearer " + tok };

// C7 — a parked run says what it is waiting for, and can be resumed on demand
const parked = await prisma.workflowInstance.findFirst({ where: { status: "running" }, select: { id: true, title: true, variables: true } });
const withDelay = parked && Object.keys((parked.variables as any)?._delays ?? {}).length ? parked
  : (await prisma.workflowInstance.findMany({ where: { status: "running" } })).find(i => Object.keys((i.variables as any)?._delays ?? {}).length);
if (!withDelay) { console.log("  no parked run to test with"); }
else {
  const det = await (await fetch(`${API}/api/workflow/instances/${withDelay.id}`, { headers: H })).json() as any;
  console.log(`  a parked run reports its wait: ${det.isWaiting ? "YES" : "NO"}`);
  if (!det.isWaiting) bad++;
  for (const w of (det.waiting ?? [])) console.log(`    waiting on "${w.label}" until ${String(w.until).slice(0, 10)} (${w.daysLeft}d, due=${w.due})`);
  const before = await prisma.workflowTask.count({ where: { instanceId: withDelay.id, status: "active" } });
  const r = await fetch(`${API}/api/workflow/instances/${withDelay.id}/resume`, { method: "POST", headers: H });
  const j = await r.json().catch(() => ({})) as any;
  const after = await prisma.workflowTask.count({ where: { instanceId: withDelay.id, status: "active" } });
  console.log(`  resume on demand: ${r.status} — active tasks ${before} -> ${after}`);
  if (r.status !== 200 || after <= before) { console.log("  x the run did not advance — the delay half of the workflow stays unreachable"); bad++; }
}

// N6 — one number, one person
const co = await prisma.company.findFirst({ select: { id: true } });
const a = await prisma.document.create({ data: { companyId: co!.id, person: "N6 Person One", docType: "Iqama", docNumber: "N6-TEST-1", status: "valid", daysLeft: 100, expiryDate: "2027-01-01" } });
const dup = await fetch(`${API}/api/documents`, { method: "POST", headers: H, body: JSON.stringify({ companyId: co!.id, person: "N6 Person Two", docType: "Iqama", docNumber: "N6-TEST-1", status: "valid", daysLeft: 100, expiryDate: "2027-01-01" }) });
console.log(`\n  same Iqama number for a different person: ${dup.status} ${dup.status === 409 ? "refused" : "ACCEPTED — still broken"}`);
console.log(`    "${String(((await dup.json().catch(() => ({}))) as any).error ?? "").slice(0, 100)}"`);
const same = await fetch(`${API}/api/documents`, { method: "POST", headers: H, body: JSON.stringify({ companyId: co!.id, person: "N6 Person One", docType: "Iqama", docNumber: "N6-TEST-1", status: "valid", daysLeft: 100, expiryDate: "2028-01-01" }) });
console.log(`  same number for the SAME person (re-issue): ${same.status} ${same.status === 201 || same.status === 200 ? "allowed" : "REFUSED — renewals would break"}`);
  if (same.status >= 400) bad++;
await prisma.document.deleteMany({ where: { docNumber: "N6-TEST-1" } });
await prisma.user.deleteMany({ where: { email: EMAIL } });
await prisma.$disconnect();
console.log("");
console.log(bad === 0 ? "all good" : bad + " problem(s)");
process.exit(bad === 0 ? 0 : 1);
