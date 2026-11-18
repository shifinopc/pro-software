/**
 * Throwaway check: WHEN A CLIENT HAS SEVERAL LOGINS FOR ONE PORTAL, which one does the step get?
 *
 * The case the CR column was added for is a client with three establishments and three Qiwa
 * registrations. The case this probe is really about is the other one: two logins for the same
 * portal that the CR does NOT separate — both filed against the client as a whole, or a client with
 * a single CR — where the only thing telling them apart is whose login it is. Two Nafath logins
 * have no username at all, so without the national ID in the payload the list is two identical
 * lines and the officer is no better off than with the arbitrary pick this replaced.
 *
 * Goes through the REAL route over HTTP, as a signed-in admin, because what is being checked is the
 * route's answer and not a copy of its logic written here. It creates a disposable admin, a second
 * CR, four credentials, a template and a run, and deletes all of it.
 *
 *   npx tsx scripts/probe-cred-ambiguous.ts
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";
import { encrypt } from "../src/auth.js";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const API = process.env.PROBE_API ?? "http://localhost:4100";
const EMAIL = "zz-probe-cred@example.invalid";

const graph = {
  nodes: [
    { id: "n1", type: "trigger", label: "Start" },
    { id: "n2", type: "task", label: "File at Qiwa", config: { assigneeRole: "pro_officer", govCenter: "Qiwa" } },
    { id: "n3", type: "end", label: "Done" },
  ],
  edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
};

let bad = 0;
const check = (ok: boolean, what: string, saw?: unknown) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || saw === undefined ? "" : "  — saw: " + JSON.stringify(saw)}`);
  if (!ok) bad++;
};

async function main() {
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  if (!co) throw new Error("no company on file");
  const before = {
    cred: await prisma.siteCredential.count(),
    est: await prisma.establishment.count(),
    user: await prisma.user.count(),
  };

  // ── a disposable admin, so no real account's password is touched ──
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  const password = "Probe" + randomBytes(3).toString("hex") + "!9";
  const me = await prisma.user.create({ data: {
    name: "ZZ Probe Admin", email: EMAIL, roleId: "admin", type: "staff", status: "active",
    passwordHash: await bcrypt.hash(password, 10),
  } });
  const login = await fetch(API + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  const token = (await login.json().catch(() => ({})) as any).token;
  if (!token) throw new Error("probe could not sign in (" + login.status + ") — is the API on " + API + "?");
  const hdr = { Authorization: "Bearer " + token };

  // ── the fixtures ──
  // A second CR, so the per-CR half can be exercised at all.
  const est = await prisma.establishment.create({ data: {
    companyId: co.id, crNumber: "ZZ-PROBE-9999", name: "ZZ Probe branch", kind: "branch", city: "Probe City",
  } });
  const mk = (data: any) => prisma.siteCredential.create({ data: {
    companyId: co.id, label: "Qiwa", url: "https://qiwa.sa", govCenter: "Qiwa", password: encrypt(""), ...data,
  } });
  // TWO NAFATH LOGINS AGAINST THE CLIENT AS A WHOLE. Same label (it is the portal's name), no
  // username on either: the national ID is the only thing that differs. This is the case.
  const wideA = await mk({ nafath: true, nafathId: "1111111111" });
  const wideB = await mk({ nafath: true, nafathId: "2222222222" });
  const crCred = await mk({ nafath: true, nafathId: "3333333333", establishmentId: est.id });

  const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ CRED AMBIG PROBE", trigger: "manual", active: true, graph: graph as any } });

  // `variables` is where a run's CR actually lives — the duplicate-run guard reads it from there
  // too. Passed as a top-level option it is silently dropped, and the step then looks like a run
  // that names no CR.
  const ask = async (vars: Record<string, unknown>) => {
    const run = await startInstance(tpl.id, { title: "Ambig probe", companyId: co.id, clientName: co.name, variables: vars });
    const step = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
    if (!step) throw new Error("the template produced no active step");
    const r = await fetch(API + `/api/workflow/tasks/${step.id}/credential`, { headers: hdr });
    const j = await r.json().catch(() => ({})) as any;
    await prisma.workflowLog.deleteMany({ where: { instanceId: run.id } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: run.id } });
    await prisma.workflowInstance.delete({ where: { id: run.id } });
    return j;
  };

  // ── 1. no CR on the run: two client-wide logins, so it must refuse to choose ──
  console.log("\nrun with no CR (two client-wide Qiwa logins):");
  const a = await ask({});
  check(a.found === false && a.ambiguous === true, "refuses to choose rather than picking one", { found: a.found, ambiguous: a.ambiguous });
  const ids = (a.choices ?? []).map((c: any) => c.id).sort();
  check(ids.length === 2 && ids.join() === [wideA.id, wideB.id].sort().join(), "hands over exactly the two client-wide logins", ids);
  // THE POINT OF THE WHOLE CHECK: the two lines must not read the same.
  const shown = (a.choices ?? []).map((c: any) => [c.label, c.cr, c.username, c.nafathId].join("|"));
  check(new Set(shown).size === shown.length, "the choices are distinguishable on screen", shown);
  check((a.choices ?? []).every((c: any) => c.nafathId), "each choice carries the Nafath number", shown);
  check((a.choices ?? []).every((c: any) => c.url), "each choice carries its url, so it can be used in place");
  check(a.canReveal === true, "the ambiguous answer says whether this admin may reveal", a.canReveal);
  check(!JSON.stringify(a).includes("password"), "no password anywhere in the payload");

  // ── 2. the run names the branch CR: that one login wins outright ──
  console.log("\nrun naming the branch CR:");
  const b = await ask({ establishmentId: est.id });
  check(b.found === true && b.id === crCred.id, "picks that CR's own login", { found: b.found, id: b.id });
  check(typeof b.cr === "string" && b.cr.includes("ZZ-PROBE-9999"), "names the CR on the answer", b.cr);
  check(b.alternatives === 2, "says how many other logins exist", b.alternatives);
  check(!JSON.stringify(b).includes("password"), "no password anywhere in the payload");

  // ── 3. one client-wide login left: no CR, no ambiguity ──
  console.log("\nrun with no CR, after one of the two is removed:");
  await prisma.siteCredential.delete({ where: { id: wideB.id } });
  const c = await ask({});
  check(c.found === true && c.id === wideA.id, "answers directly when there is only one", { found: c.found, id: c.id });
  check(c.cr === null, "a client-wide login reports no CR", c.cr);

  // ── clean up ──
  await prisma.workflowTemplate.delete({ where: { id: tpl.id } });
  await prisma.siteCredential.deleteMany({ where: { id: { in: [wideA.id, wideB.id, crCred.id] } } });
  await prisma.establishment.delete({ where: { id: est.id } });
  await prisma.user.delete({ where: { id: me.id } });

  const now = {
    cred: await prisma.siteCredential.count(),
    est: await prisma.establishment.count(),
    user: await prisma.user.count(),
  };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  credentials ${before.cred}->${now.cred} · establishments ${before.est}->${now.est} · users ${before.user}->${now.user}`);
  if (before.cred !== now.cred || before.est !== now.est || before.user !== now.user) { console.log("LEFTOVERS — clean up by hand"); bad++; }
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
