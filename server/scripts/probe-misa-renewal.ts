/**
 * Walk a MISA licence renewal end to end, the way the nightly job would start one.
 *
 * Three things are worth proving here, and only one of them is "the steps run".
 *
 *   1. It RENEWS rather than re-issues. The run carries `documentId`, so the licence must come out
 *      the far end as ONE document with a new number and a new expiry and the old pair in its
 *      history — not as a second live licence sitting beside the first. A company holding two live
 *      investment licences is the failure this design exists to avoid.
 *
 *   2. A company-subject document files against the CLIENT. Everything in this pack until now has
 *      been about a person, and the same issue step behaves differently here: no employeeId, and
 *      the licence is found by company rather than by name.
 *
 *   3. The refusal ending leaves the existing licence ALONE. Onboarding's refusal voids what it
 *      issued, which is right for a hire that never arrived and catastrophic for a renewal — the
 *      licence the company already holds is valid until its own expiry date.
 *
 * Own template, own client, own licence. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "misa-probe@example.invalid";
const PW = "MisaProbe!2026";
const TAG = "ZS misa probe";
const CLIENT = "ZS Misa Probe Client";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

/** Answers that carry the run forward, filled from whatever the step actually asks for. */
const HAPPY: Record<string, string> = {
  checkOutcome: "ready", docReview: "complete", clientApproval: "approved",
  renewalTerm: "1_year", misaOutcome: "approved",
};

function answer(caps: any[], override: Record<string, any> = {}): Record<string, any> {
  const v: Record<string, any> = {};
  for (const c of caps ?? []) {
    const k = String(c.var ?? ""); if (!k) continue;
    if (k in override) { v[k] = override[k]; continue; }
    if (HAPPY[k] !== undefined) { v[k] = HAPPY[k]; continue; }
    if (k === "newLicenceNumber") { v[k] = "MISA-NEW-2029"; continue; }
    if (k === "newExpiry") { v[k] = "2029-06-30"; continue; }
    const opts: any[] = String(c.options ?? "").split(",").map((x: string) => x.trim()).filter(Boolean);
    if (opts.length) { v[k] = opts[0]; continue; }
    if (String(c.type) === "date") { v[k] = "2026-10-01"; continue; }
    if (String(c.type) === "number") { v[k] = 2000; continue; }
    v[k] = "ZS-" + k;
  }
  return v;
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "MISA Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "MISA Licence Renewal" } });
  if (!tpl) { console.log("the MISA template is not built — run add-misa-renewal.ts first"); await sweep(); process.exit(1); }

  const co = await prisma.company.create({ data: { name: CLIENT, status: "active" } as any });
  // The licence as it stands today: one live company-subject document, due for renewal.
  const licence = await prisma.document.create({ data: {
    companyId: co.id, person: CLIENT, employeeId: null, docType: "MISA Investment Licence",
    docNumber: "MISA-OLD-2026", expiryDate: "2026-09-30", status: "expiring", daysLeft: 40,
    issuingAuthority: "MISA",
  } as any });
  console.log(`the client holds one licence: ${licence.docNumber}, expiring ${licence.expiryDate}`);

  // ── started the way the nightly job starts it ────────────────────────────────────────────────
  const started = await call("POST", "/api/workflow/instances", tok, {
    templateId: tpl.id, title: `${TAG} renewal`, companyId: co.id, clientName: CLIENT,
    variables: { documentId: licence.id, docType: "MISA Investment Licence", person: CLIENT,
                 currentExpiry: licence.expiryDate, currentNumber: licence.docNumber, _trigger: "document_expiry" },
  });
  const id = started.body?.id ?? started.body?.instance?.id;
  if (!id) { fail(`could not start the renewal — ${String(started.body?.error).slice(0, 90)}`); await sweep(); process.exit(1); }

  const live = () => prisma.workflowTask.findMany({ where: { instanceId: id, status: "active" } });
  const walked: string[] = [];
  for (let i = 0; i < 40; i++) {
    const tasks = await live();
    if (!tasks.length) break;
    for (const t of tasks) {
      const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
      const state: any = {};
      for (const x of items) state[x.key ?? x.label] = { received: true, verified: true };
      const r = await call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
        variables: answer(t.captures as any[]), ...(items.length ? { checklistState: state } : {}),
      });
      if (r.status >= 400) { fail(`"${t.title}" refused — ${String(r.body?.error).slice(0, 110)}`); await sweep(); console.log(`\n${bad} problem(s)`); process.exit(1); }
      walked.push(t.title);
    }
  }
  console.log(`\nwalked ${walked.length} steps:`);
  console.log("  " + walked.join(" → "));

  // ── one licence, renewed — not two ──────────────────────────────────────────────────────────
  const after = await prisma.document.findMany({ where: { companyId: co.id, docType: "MISA Investment Licence" } });
  const liveOnes = after.filter((d: any) => !d.supersededAt);
  console.log("");
  console.log(`licences on the company now:               ${after.length} (${liveOnes.length} live)`);
  if (liveOnes.length !== 1) fail(`the company holds ${liveOnes.length} live investment licences — a renewal must leave exactly one`);

  const cur: any = liveOnes[0];
  console.log(`  number:                                  ${cur?.docNumber}`);
  console.log(`  expiry:                                  ${cur?.expiryDate}`);
  console.log(`  still filed against the client:          ${cur?.person === CLIENT && !cur?.employeeId ? "YES" : "NO"}`);
  if (cur?.docNumber !== "MISA-NEW-2029") fail(`the live licence still shows ${cur?.docNumber} — the new number was not recorded`);
  if (String(cur?.expiryDate).slice(0, 10) !== "2029-06-30") fail(`the live licence expires ${cur?.expiryDate} — the new expiry was not recorded`);
  if (cur?.employeeId) fail("a company licence was filed against an employee");

  const hist: any[] = Array.isArray(cur?.history) ? (cur.history as any[]) : [];
  const keptOld = hist.some(h => String(h?.oldNumber ?? "") === "MISA-OLD-2026" || String(h?.oldExpiry ?? "").startsWith("2026-09-30"));
  console.log(`  the previous licence kept as history:    ${keptOld ? "YES" : "NO"}`);
  if (!keptOld) fail("the old number and expiry are not in the licence's history — the renewal left no audit trail");

  const run = await prisma.workflowInstance.findUnique({ where: { id }, select: { status: true } });
  console.log(`  the run finished:                        ${run?.status === "completed" ? "YES" : "NO (" + run?.status + ")"}`);
  if (run?.status !== "completed") fail(`the renewal finished in state "${run?.status}"`);

  // ── and a refusal leaves the existing licence alone ──────────────────────────────────────────
  const lic2 = await prisma.document.create({ data: {
    companyId: co.id, person: CLIENT, employeeId: null, docType: "Commercial Registration",
    docNumber: "CR-1", expiryDate: "2027-01-31", status: "valid", daysLeft: 200,
  } as any });
  const r2 = await call("POST", "/api/workflow/instances", tok, {
    templateId: tpl.id, title: `${TAG} refused`, companyId: co.id, clientName: CLIENT,
    variables: { documentId: cur.id, docType: "MISA Investment Licence", person: CLIENT },
  });
  const id2 = r2.body?.id ?? r2.body?.instance?.id;
  for (let i = 0; i < 40 && id2; i++) {
    const tasks = await prisma.workflowTask.findMany({ where: { instanceId: id2, status: "active" } });
    if (!tasks.length) break;
    for (const t of tasks) {
      const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
      const state: any = {};
      for (const x of items) state[x.key ?? x.label] = { received: true, verified: true };
      // refuse at the government step
      const over = t.nodeId === "misa_review" ? { misaOutcome: "rejected" } : {};
      await call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
        variables: answer(t.captures as any[], over), ...(items.length ? { checklistState: state } : {}),
      });
    }
  }
  const afterRefusal = await prisma.document.findFirst({ where: { id: cur.id } });
  console.log("");
  console.log(`after a MISA refusal, the existing licence: ${afterRefusal && !(afterRefusal as any).supersededAt ? "still live" : "WITHDRAWN"}`);
  if (!afterRefusal || (afterRefusal as any).supersededAt) {
    fail("a refused renewal withdrew the licence the company already holds — it is valid until its own expiry date");
  }
  await prisma.document.delete({ where: { id: lic2.id } }).catch(() => {});

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
