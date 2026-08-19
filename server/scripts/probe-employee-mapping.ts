/**
 * Check that creating the personnel record survives a field being renamed, and that it refuses to
 * go live when it cannot.
 *
 * `createsEmployee` is the flag that turns a run's answers into a person on the client's books, and
 * everything the run issues afterwards links to that person rather than to text that spells their
 * name. The variable names it read — applicant, nationality, profession, employmentType — were
 * written into the engine, which was safe exactly as long as fields could not be renamed.
 *
 * They can now, on the step and in a field set. So the interesting case is not "an employee is
 * created" — that already worked — it is what happens when somebody renames the field the name
 * comes from. Before the mapping, the answer was: the step completes, the run carries on, and NO
 * EMPLOYEE IS CREATED AT ALL, with nothing anywhere saying so. That is the failure that left 57 of
 * 65 documents on this installation with nobody behind them, so it is the one worth a probe.
 *
 * Own template, own run, own employee. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { validateReferences } from "../src/workflow.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "em-probe@example.invalid";
const PW = "EmProbe!2026";
const TAG = "ZS employee mapping probe";
const WHO = "ZS Mapping Probe Person";

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
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

/** A one-step workflow that collects a name under whatever variable it is told to use. */
const graphFor = (nameVar: string, mapped: string | null) => ({
  nodes: [
    { id: "start", type: "start", label: "Start", config: {} },
    { id: "profile", type: "task", label: "Create the person", config: {
      assigneeRole: "pro_officer",
      createsEmployee: true,
      ...(mapped ? { employeeFields: { name: mapped, role: "jobTitle" } } : {}),
      captures: [
        { var: nameVar, label: "Full name", type: "text" },
        { var: "jobTitle", label: "Job title", type: "text" },
      ],
    } },
    { id: "end", type: "end", label: "Done", config: {} },
  ],
  edges: [{ from: "start", to: "profile" }, { from: "profile", to: "end" }],
});

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "EM Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }
  const co = await prisma.company.findFirst({ select: { id: true } });
  if (!co) { console.log("no company to attach a person to"); await sweep(); process.exit(1); }

  /** Run one graph end to end and report whether a person came out of it. */
  const runWith = async (label: string, nameVar: string, mapped: string | null) => {
    const tpl = await prisma.workflowTemplate.create({ data: {
      name: `${TAG} ${label}`, trigger: "manual", entityType: "employee", active: false, country: "SA",
      createdAt: new Date().toISOString(), graph: graphFor(nameVar, mapped) as any,
    } });
    const started = await call("POST", "/api/workflow/instances", tok, { templateId: tpl.id, title: `${TAG} ${label}`, companyId: co.id });
    const id = started.body?.id ?? started.body?.instance?.id;
    const task = id ? await prisma.workflowTask.findFirst({ where: { instanceId: id, status: "active" } }) : null;
    if (!task) return { made: null as any, refused: "the run produced no step" };
    const r = await call("POST", `/api/workflow/tasks/${task.id}/complete`, tok, {
      variables: { [nameVar]: WHO, jobTitle: "Analyst" },
    });
    if (r.status >= 400) return { made: null as any, refused: String(r.body?.error).slice(0, 90) };
    const emp = await prisma.employee.findFirst({ where: { companyId: co.id, name: WHO } });
    return { made: emp, refused: "" };
  };

  // ── the ordinary case, on the names the engine always used ────────────────────────────────────
  const a = await runWith("default", "applicant", null);
  console.log(`with the original field names, a person is created: ${a.made ? "YES" : "NO"}`);
  if (!a.made) fail(`the unchanged mapping created nobody${a.refused ? " — " + a.refused : ""}`);
  await prisma.employee.deleteMany({ where: { name: WHO } });

  // ── the field is renamed and the mapping follows it ───────────────────────────────────────────
  const b = await runWith("renamed", "fullName", "fullName");
  console.log(`after renaming the field and repointing the map:    ${b.made ? "YES" : "NO"}`);
  if (!b.made) fail(`a renamed field with the mapping updated still created nobody${b.refused ? " — " + b.refused : ""}`);
  else console.log(`  ...and their job title came across:               ${b.made.role === "Analyst" ? "YES" : `NO (${b.made.role})`}`);
  if (b.made && b.made.role !== "Analyst") fail("the mapped job title was not written to the employee record");
  await prisma.employee.deleteMany({ where: { name: WHO } });

  // ── the field is renamed and the mapping is NOT updated ───────────────────────────────────────
  //
  // This is the whole point. The step completes perfectly happily; the damage is entirely silent,
  // so the guard has to be at activation, before any run exists to be damaged.
  const c = await runWith("orphan", "fullName", null);
  console.log("");
  console.log(`a rename nobody repointed creates a person:         ${c.made ? "YES — nothing was caught" : "NO"}`);
  if (c.made) fail("a run created an employee from a variable the graph does not capture, which should be impossible");

  const orphanTpl = await prisma.workflowTemplate.findFirst({ where: { name: `${TAG} orphan` } });
  const issues = await validateReferences(orphanTpl?.graph, { country: "SA" });
  const hit = issues.find(i => /creates an employee record from/.test(i.message));
  console.log(`  ...and the validator says so before it goes live: ${hit ? "YES" : "NO"}`);
  if (hit) console.log(`    "${hit.message.slice(0, 96)}"`);
  if (!hit) fail("nothing reported a step that creates an employee from a variable no step captures");
  if (hit && hit.level !== "error") fail(`the broken name mapping is only a ${hit.level} — activation would be allowed`);

  const live = await call("PUT", `/api/workflow/templates/${orphanTpl!.id}`, tok, { active: true });
  console.log(`  ...and activating it is refused:                  ${live.status >= 400 ? "YES" : "NO (" + live.status + ")"}`);
  if (live.status < 400) fail("a workflow whose employee step can never create anybody was allowed to go live");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
