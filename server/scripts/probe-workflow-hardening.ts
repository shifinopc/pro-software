/**
 * Throwaway check for the defects an execution audit reproduced against the running engine.
 *
 * All four are the same shape: the engine routed on data it never checked, or hid a failure from the
 * person responsible for it. None of them failed loudly, which is why they survived every review of
 * the graph — the graph was fine.
 *
 *   C1  completing ONE branch of the four-way split with {"variables":{"_joins":{"join":3}}} forced
 *       the parallel join open. The employee reached Joining Confirmation with payroll, assets and
 *       health insurance still outstanding: no salary account, no GOSI number, no CCHI policy.
 *   C2  completing the profile step with {} returned 200 and the run advanced with no name, no
 *       nationality and no hiring type — the three things every later decision routes on.
 *   C3  nationality "Saudi" with hiring type "expat new hire" was accepted, and the run issued that
 *       Saudi citizen a Work Visa, an Iqama and a Work Permit.
 *   C4  a document that could not be created produced no record, no log line and no sign on the run.
 *
 * Own instance, own user. Deletes both afterwards.
 */
import { prisma } from "../src/db.js";
import { callerVariables, brokenRules } from "../src/workflow.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "wh-probe@example.invalid";
const PW = "WhProbe!2026";
const TITLE = "WH Probe run";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const runs = await prisma.workflowInstance.findMany({ where: { title: TITLE }, select: { id: true } });
  const ids = runs.map(r => r.id);
  if (ids.length) {
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "WH Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  // C1 — the engine's own controls are not the caller's to set
  const inj = callerVariables({ applicant: "Ada", _joins: { join: 3 }, _delays: { probation: "2020-01-01" }, _result: "completed" });
  console.log(`internal variables are refused:            ${inj.rejected.length === 3 ? "YES" : "NO"} (${inj.rejected.join(", ")})`);
  if (!inj.rejected.includes("_joins")) fail("_joins survived — the parallel join can still be forced open");
  if (inj.vars.applicant !== "Ada") fail("a legitimate variable was dropped along with them");
  if ("_joins" in inj.vars) fail("_joins is still present in the accepted set");

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  if (!tpl) { fail("Employee Onboarding is not on this installation"); await sweep(); process.exit(1); }
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });

  const started = await call("POST", "/api/workflow/instances", tok, {
    templateId: tpl.id, title: TITLE, companyId: co?.id ?? null, clientName: co?.name ?? null,
    variables: { _joins: { join: 9 }, seeded: "ok" },
  });
  const instId = started.body?.id ?? started.body?.instance?.id;
  if (!instId) { fail("could not start a run: " + JSON.stringify(started.body).slice(0, 140)); await sweep(); process.exit(1); }
  const fresh = await prisma.workflowInstance.findUnique({ where: { id: instId }, select: { variables: true } });
  const seededJoins = (fresh?.variables as any)?._joins;
  console.log(`...including at instance creation:         ${seededJoins?.join === 9 ? "NO — it was stored" : "YES"}`);
  if (seededJoins?.join === 9) fail("a run can be created with the join counter pre-set, which opens the join on the first arrival");

  // C2 — a step gets what it asks for
  const firstTask = await prisma.workflowTask.findFirst({ where: { instanceId: instId, status: "active" }, select: { id: true, title: true } });
  if (!firstTask) { fail("the run produced no first task"); await sweep(); process.exit(1); }
  const empty = await call("POST", `/api/workflow/tasks/${firstTask.id}/complete`, tok, { variables: {} });
  console.log(`\ncompleting "${firstTask.title}" with {} is refused: ${empty.status >= 400 ? "YES" : "NO (" + empty.status + ")"}`);
  console.log(`  "${String(empty.body?.error ?? "").slice(0, 110)}"`);
  if (empty.status < 400) fail("an empty profile was accepted — the run advances with no name, nationality or hiring type");

  const badOption = await call("POST", `/api/workflow/tasks/${firstTask.id}/complete`, tok, {
    variables: { applicant: "Ada Probe", nationality: "Indian", mobile: "0500000000", email: "a@b.c",
      hiringType: "definitely_not_a_real_option", employmentType: "permanent", profession: "Analyst",
      department: "Ops", reportingManager: "M", expectedJoining: "2026-09-01", currentLocationStatus: "outside_ksa" },
  });
  console.log(`a select value outside its list is refused: ${badOption.status >= 400 ? "YES" : "NO (" + badOption.status + ")"}`);
  if (badOption.status < 400) fail("an unlisted option was accepted, so the decision reading it falls through to else");

  // C3 — the combination has to make sense
  const node = ((tpl.graph as any).nodes ?? []).find((n: any) => n.id === "profile");
  const saudiAsExpat = brokenRules(node?.config, { nationality: "Saudi", hiringType: "expat_new_hire", currentLocationStatus: "inside_ksa" });
  console.log(`\na Saudi national on the expatriate path is refused: ${saudiAsExpat.length ? "YES" : "NO"}`);
  if (saudiAsExpat.length) console.log(`  "${saudiAsExpat[0].slice(0, 100)}"`);
  if (!saudiAsExpat.length) fail("still accepted — this is the run that issued a Saudi citizen a work visa, Iqama and work permit");

  const transferOutside = brokenRules(node?.config, { nationality: "Indian", hiringType: "expat_transfer", currentLocationStatus: "outside_ksa" });
  console.log(`a transfer from outside the Kingdom is refused:     ${transferOutside.length ? "YES" : "NO"}`);
  if (!transferOutside.length) fail("a Qiwa transfer of somebody who is not in the country was accepted");

  const ordinary = brokenRules(node?.config, { nationality: "Indian", hiringType: "expat_new_hire", currentLocationStatus: "outside_ksa" });
  console.log(`an ordinary expatriate hire still passes:          ${ordinary.length === 0 ? "YES" : "NO — " + ordinary[0]}`);
  if (ordinary.length) fail("the rules reject a legitimate combination, which would block real onboarding");

  const saudiProper = brokenRules(node?.config, { nationality: "Saudi Arabian", hiringType: "saudi_national", currentLocationStatus: "inside_ksa" });
  console.log(`...and so does a Saudi on the Saudi path:          ${saudiProper.length === 0 ? "YES" : "NO — " + saudiProper[0]}`);
  if (saudiProper.length) fail("a correct Saudi profile was rejected — the prefix match is too strict");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
