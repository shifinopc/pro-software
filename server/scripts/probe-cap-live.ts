/**
 * Throwaway check that the statutory probation ceiling actually stops a run, by extending until it
 * does.
 *
 * `prob_final` and `d_final` were the last two nodes never executed, written off as untestable
 * because reaching them needs 180 accumulated probation days and no test window is six months long.
 * That is true of waiting and not of the engine: the counter adds a delay's FULL length the moment
 * the run enters it, so three forced extensions walk 90 → 120 → 150 → 180 in about a minute. Nothing
 * is shortened and no template is edited — the delays are exactly the ones that ship, and the only
 * thing being skipped is the sitting around.
 *
 * The ceiling is Labour Law article 53: 180 days total, in all cases. What is checked is not merely
 * that the run stops, but that it stops at the RIGHT number — a cap that fires one loop late is 210
 * days of unlawful probation and looks perfectly healthy on the canvas — and that it stops at a
 * decision rather than ending somebody's employment on a timeout.
 *
 * Own run, own user, own records. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "cap-probe@example.invalid";
const PW = "CapProbe!2026";
const TITLE = "ZS cap probe";
const WHO = "ZS Cap Probe Person";
const CAP = 180;

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: TITLE }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.document.deleteMany({ where: { person: WHO } });
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

const STEPS: Record<string, any> = {
  profile: { applicant: WHO, nationality: "Saudi", mobile: "+966500000002", email: "cap@example.invalid",
    hiringType: "saudi_national", employmentType: "permanent", profession: "Analyst", department: "Finance",
    reportingManager: "Ops Lead", expectedJoining: "2026-09-01", currentLocationStatus: "inside_ksa" },
  collect: { documentsVerified: "pass" },
  insurance_task: { policyNumber: "POL-CAP-1", policyExpiry: "2027-09-01" },
  contract: { contractNumber: "QC-CAP-1", contractEnd: "2027-09-01" },
  payroll: { gosiOutcome: "registered", gosiNumber: "GOSI-CAP-1" },
  joined: { employeeJoined: "yes" },
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "Cap Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  const started = await call("POST", "/api/workflow/instances", tok, {
    templateId: tpl!.id, title: TITLE, companyId: co?.id ?? null, clientName: co?.name ?? null,
  });
  const id = started.body?.id ?? started.body?.instance?.id;
  if (!id) { console.log("could not start a run"); await sweep(); process.exit(1); }

  const live = () => prisma.workflowTask.findMany({ where: { instanceId: id, status: "active" } });
  const complete = async (t: any, vars: Record<string, any>) => {
    const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
    const checklistState: any = {};
    for (const i of items) checklistState[i.key ?? i.label] = { received: true, verified: true };
    return call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
      variables: vars, ...(t.nodeType === "approval" ? { outcome: "approve" } : {}), ...(items.length ? { checklistState } : {}),
    });
  };
  const used = async () => {
    const i = await prisma.workflowInstance.findUnique({ where: { id }, select: { variables: true } });
    return Number((i?.variables as any)?.probationDaysUsed ?? 0);
  };

  // ── up to the first probation wait ────────────────────────────────────────────────────────────
  for (let i = 0; i < 40; i++) {
    const tasks = await live();
    if (!tasks.length) break;
    for (const t of tasks) {
      const r = await complete(t, STEPS[t.nodeId] ?? {});
      if (r.status >= 400) { fail(`"${t.title}" refused — ${String(r.body?.error).slice(0, 110)}`); await sweep(); console.log("\n1 problem(s)"); process.exit(1); }
    }
  }
  console.log(`probation begun, days counted:             ${await used()}`);
  if (await used() !== 90) fail(`the initial probation counted ${await used()} days rather than 90`);

  // ── keep extending, exactly as somebody determined to would ───────────────────────────────────
  const trail: number[] = [await used()];
  let landed = "", extensions = 0;

  for (let round = 0; round < 12; round++) {
    // Only force a wait when the run is actually in one. After the last review the cap sends it
    // straight to a task, and asking to resume then is not a failure — it is the run having arrived.
    let tasks = await live();
    if (!tasks.length) {
      const resumed = await call("POST", `/api/workflow/instances/${id}/resume`, tok, {});
      if (resumed.status !== 200) { fail(`could not force the wait — ${String(resumed.body?.error).slice(0, 100)}`); break; }
      tasks = await live();
    }
    if (!tasks.length) { fail("forcing the wait produced no next step"); break; }
    const t = tasks[0];

    if (t.nodeId === "prob_final") { landed = t.nodeId; break; }
    if (t.nodeId !== "prob_review") { landed = t.nodeId; break; }

    const r = await complete(t, {
      probationOutcome: "extend", extensionAgreed: "yes",
      probationNotes: "Still short of the objectives — extension agreed in writing",
      probationEffective: "2026-12-01",
    });
    if (r.status >= 400) { fail(`extending was refused — ${String(r.body?.error).slice(0, 110)}`); break; }
    // An extension is a review that actually bought more time. The last one does not: the cap has
    // been reached, so the run goes to the confirm-or-end step instead of into another wait, and
    // counting that as a fourth extension would report headroom that does not exist.
    const now = await used();
    if (now > trail[trail.length - 1]) { extensions++; trail.push(now); }
  }

  console.log(`days counted as it is extended:            ${trail.join(" → ")}`);
  console.log(`extensions allowed before it stops:        ${extensions}`);
  const peak = Math.max(...trail);
  console.log(`the total never passes ${CAP}:               ${peak <= CAP ? "YES" : "NO (" + peak + ")"}`);
  if (peak > CAP) fail(`probation reached ${peak} days — past the ${CAP}-day ceiling article 53 sets in all cases`);
  if (extensions >= 12) fail("the extension loop never stopped");

  // ── where it lands, which is the whole point ──────────────────────────────────────────────────
  const at = (await live())[0];
  console.log(`\nthe run stops at:                          ${at ? `"${at.title}"` : "nothing is open"}`);
  if (at?.nodeId !== "prob_final") { fail(`the cap led to "${at?.nodeId ?? landed ?? "nowhere"}" rather than the confirm-or-end step`); await sweep(); console.log(`\n${bad} problem(s)`); process.exit(1); }
  console.log(`  it is a decision, not an automatic end:  YES (${(at.captures as any[])?.map((c: any) => c.var).join(", ")})`);

  const items: any[] = Array.isArray(at.checklist) ? (at.checklist as any[]) : [];
  console.log(`  and the employee has to be told:         ${items.some(i => /limit/i.test(String(i.label))) ? "YES" : "NO"}`);
  if (!items.some(i => /limit/i.test(String(i.label)))) fail("nothing on the final step requires telling the employee their probation has run to its limit");

  // ── and it can still go either way ────────────────────────────────────────────────────────────
  const fin = await complete(at, { probationFinal: "confirm" });
  console.log(`  confirming from the cap is accepted:     ${fin.status === 200 ? "YES" : "NO (" + fin.status + ")"}`);
  if (fin.status !== 200) fail(`the run could not be confirmed at the cap — ${String(fin.body?.error).slice(0, 100)}`);

  const appr = (await live())[0];
  console.log(`  ...and it goes to the approval:          ${appr ? `"${appr.title}"` : "NOTHING"}`);
  if (appr) {
    const ok = await complete(appr, {});
    if (ok.status !== 200) fail(`the confirmation approval was refused — ${String(ok.body?.error).slice(0, 100)}`);
  } else fail("confirming at the cap led nowhere");

  const done = await prisma.workflowInstance.findUnique({ where: { id }, select: { status: true } });
  const logs = await prisma.workflowLog.findMany({ where: { instanceId: id }, select: { nodeId: true, action: true } });
  console.log(`  the run ends at Employee Confirmed:      ${logs.some(l => l.nodeId === "end_ok") ? "YES" : "NO"}`);
  console.log(`  and is marked completed:                 ${done?.status === "completed" ? "YES" : "NO (" + done?.status + ")"}`);
  if (!logs.some(l => l.nodeId === "end_ok")) fail("confirming at the statutory limit does not reach Employee Confirmed");

  const entered = logs.filter(l => l.action === "delay.waiting").length;
  const counted = logs.filter(l => l.action === "delay.counted").length;
  console.log(`\nevery wait counted itself:                 ${counted} counted of ${entered} entered`);
  if (counted !== entered) fail(`${counted} waits counted where ${entered} were entered — a wait that does not count is a ceiling that never arrives`);

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
