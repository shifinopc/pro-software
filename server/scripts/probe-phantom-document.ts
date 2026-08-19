/**
 * Check that completing a step does not invent a document nobody applied for.
 *
 * A run carries `docType` in its variables — set when it is started about a document — and the
 * engine writes what a step captured onto that document. The guard on that was only "the step has
 * captures and some were answered", which is true of the FIRST step in onboarding: the intake form.
 *
 * So completing "Create Employee Profile" filed a Work Visa. No number, no expiry, no issue date,
 * `issuedByRunId` null because no issue step had run, and status "valid" — because status is derived
 * from an expiry, and an absent expiry falls back to valid. A visa nobody had applied for, marked
 * valid, on the employee's card and in every compliance count. It was reported by the user as
 * "how did this Work Visa get here", which is exactly the right question.
 *
 * What is checked here is the distinction, not merely the absence: a step that records a NUMBER or an
 * EXPIRY still files its document, because that is the feature working. A step that records a name
 * and a department does not, because those were never facts about a visa.
 *
 * Own template, own run, own employee and documents. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "pd-probe@example.invalid";
const PW = "PdProbe!2026";
const TAG = "ZS phantom doc probe";
const WHO = "ZS Phantom Probe Person";

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
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.document.deleteMany({ where: { person: WHO } });
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

/** One task step collecting whatever it is told to, on a run that is about a Work Visa. */
const graphFor = (caps: any[]) => ({
  nodes: [
    { id: "start", type: "start", label: "Start", config: {} },
    { id: "step", type: "task", label: "The step", config: { assigneeRole: "pro_officer", captures: caps } },
    { id: "end", type: "end", label: "End", config: {} },
  ],
  edges: [{ from: "start", to: "step" }, { from: "step", to: "end" }],
});

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "PD Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  if (!co) { console.log("no company to file against"); await sweep(); process.exit(1); }

  /** Run one step to completion on a Work Visa run, and report what landed in Compliance. */
  const run = async (label: string, caps: any[], answers: Record<string, any>) => {
    const tpl = await prisma.workflowTemplate.create({ data: {
      name: `${TAG} ${label}`, trigger: "manual", entityType: "employee", active: false, country: "SA",
      createdAt: new Date().toISOString(), graph: graphFor(caps) as any,
    } });
    const started = await call("POST", "/api/workflow/instances", tok, {
      templateId: tpl.id, title: `${TAG} ${label}`, companyId: co.id, clientName: co.name,
      // what the console puts on a run started about a document
      variables: { docType: "Work Visa", applicant: WHO },
    });
    const id = started.body?.id ?? started.body?.instance?.id;
    const task = id ? await prisma.workflowTask.findFirst({ where: { instanceId: id, status: "active" } }) : null;
    if (!task) return { docs: [] as any[], refused: "no step was created" };
    const r = await call("POST", `/api/workflow/tasks/${task.id}/complete`, tok, { variables: answers });
    if (r.status >= 400) return { docs: [] as any[], refused: String(r.body?.error).slice(0, 90) };
    const docs = await prisma.document.findMany({ where: { companyId: co.id, person: WHO, docType: "Work Visa" } });
    return { docs, refused: "", instanceId: id as string };
  };

  // ── the intake step: answers about a person, nothing about a visa ──────────────────────────────
  const intake = await run("intake", [
    { var: "applicant", type: "text", label: "Full name" },
    { var: "department", type: "text", label: "Department" },
  ], { applicant: WHO, department: "IT" });

  console.log(`a step recording a name and a department files:  ${intake.docs.length} document(s)`);
  if (intake.refused) fail(`the intake step was refused — ${intake.refused}`);
  if (intake.docs.length) {
    const d: any = intake.docs[0];
    fail(`a Work Visa was invented from answers about a person (number=${d.docNumber ?? "none"}, expiry=${d.expiryDate ?? "none"}, status=${d.status})`);
  }

  // ...and the run says it declined, rather than saying nothing at all
  const logged = intake.instanceId
    ? await prisma.workflowLog.count({ where: { instanceId: intake.instanceId, action: "document.not_created" } })
    : 0;
  console.log(`  ...and the run records why it did not:        ${logged ? "YES" : "NO"}`);
  if (!logged) fail("nothing in the run log explains why no document was filed");

  await prisma.document.deleteMany({ where: { person: WHO } });

  // ── a step that really does record the visa ───────────────────────────────────────────────────
  const issued = await run("issued", [
    { var: "visaNumber", type: "text", label: "Visa number", purpose: "number" },
    { var: "visaExpiry", type: "date", label: "Visa expiry", purpose: "expiry" },
  ], { visaNumber: "WV-ZS-1", visaExpiry: "2027-09-01" });

  console.log("");
  console.log(`a step recording a number and an expiry files:   ${issued.docs.length} document(s)`);
  if (issued.refused) fail(`the issuing step was refused — ${issued.refused}`);
  if (!issued.docs.length) fail("a step that recorded a visa number and expiry filed nothing — the feature is now broken in the other direction");
  else {
    const d: any = issued.docs[0];
    console.log(`  number ${d.docNumber} · expiry ${String(d.expiryDate).slice(0, 10)} · status ${d.status}`);
    if (d.docNumber !== "WV-ZS-1") fail(`the filed document has number ${d.docNumber}`);
    if (!d.expiryDate) fail("the filed document has no expiry, though the step recorded one");
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
