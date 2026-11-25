/**
 * HANDING A TASK OVER MOVES THE WORK, NOT JUST THE COVER SHEET.
 *
 *   npx tsx scripts/task-delegate-check.ts     (needs the API running)
 *
 * The bug this pins down, as it was found on live: task "bs for shifin company" read
 * `assignee = Iqbal` with `assigneeId = NULL`, while the one active step of its run was still
 * `Navas`. Delegating had moved the cover sheet and left the work where it was, so the new owner
 * opened My Tasks and found nothing — a task with a run attached is left out of the plain list on
 * purpose, because the steps ARE the work, and that step was not his.
 *
 * Two separate faults, both asserted here:
 *
 *   · THE MIRROR WITHOUT THE FACT. The old path wrote `assignee` (which the schema calls "the
 *     display mirror") and never `assigneeId`. The console filters by name so the row appeared to
 *     move, while everything keyed on the id — the notification to the new owner, the SLA chase,
 *     the agents — read the task as owned by nobody.
 *   · THE STEPS LEFT BEHIND. The browser moved only the steps it could already see in its own
 *     my-work list, so a non-admin handing on a task whose step belonged to somebody else moved
 *     nothing at all and still said "Reassigned".
 *
 * And the property that keeps it honest: ALL OR NOTHING. A caller who may not move one of the steps
 * does not get to move the task either — moving the task alone is precisely the half-done state
 * this route exists to prevent.
 *
 * Everything it makes is named "ZZ Deleg" and removed at the end, which is also why it refuses to
 * run anywhere but a scratch database.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This writes throwaway users, runs and tasks."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

const TAG = "ZZ Deleg";
const EMAILS = ["zz-deleg-admin", "zz-deleg-officer", "zz-deleg-target", "zz-deleg-holder"]
  .map(s => `${s}@example.invalid`);

async function sweep() {
  const runs = await prisma.workflowInstance.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  const ids = runs.map(r => r.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
  }
  await prisma.task.deleteMany({ where: { title: { startsWith: TAG } } });
  if (ids.length) await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { in: EMAILS } } });
}

async function main() {
  await sweep();

  const mk = (name: string, email: string, roleId: string) =>
    prisma.user.create({ data: { name: `${TAG} ${name}`, email, roleId, status: "active", type: "staff" } });
  const admin = await mk("Admin", EMAILS[0], "super_admin");
  const officer = await mk("Officer", EMAILS[1], "pro_officer");
  const target = await mk("Target", EMAILS[2], "pro_officer");
  const holder = await mk("Holder", EMAILS[3], "pro_officer");
  const co = await prisma.company.create({ data: { name: `${TAG} Client`, country: "SA" } });

  const call = async (token: string, path: string, body?: any) => {
    const r = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  // A run with ONE active step, held by somebody who is not the task's assignee — the live shape.
  const makeRun = async (label: string) => {
    const tpl = await prisma.workflowTemplate.create({ data: {
      name: `${TAG} template ${label}`, country: "SA", entityType: "company", active: false,
      graph: { nodes: [{ id: "start", type: "start", label: "Start" }, { id: "s1", type: "task", label: "Step one" }], edges: [{ from: "start", to: "s1" }] } as any,
    } as any });
    const run = await prisma.workflowInstance.create({ data: {
      templateId: tpl.id, title: `${TAG} run ${label}`, companyId: co.id, clientName: co.name,
      status: "running", variables: {} as any,
    } as any });
    const step = await prisma.workflowTask.create({ data: {
      instanceId: run.id, nodeId: "s1", nodeType: "task", title: `${TAG} WhatsApp group and portal access`,
      status: "active", assigneeId: holder.id, assignee: holder.name, assigneeRole: "pro_officer",
      priority: "high", slaHours: 24,
    } as any });
    return { run, step };
  };

  // THE DRIFT EXACTLY AS LIVE HAD IT: the mirror written, the fact left null.
  const makeTask = (label: string, runId: string | null) => prisma.task.create({ data: {
    title: `${TAG} ${label}`, companyId: co.id, clientName: co.name,
    assignee: officer.name, assigneeId: null,
    status: "todo", priority: "high", ...(runId ? { workflowInstanceId: runId } : {}),
  } as any });

  const adminTok = await tokenForEmail(EMAILS[0]);
  const officerTok = await tokenForEmail(EMAILS[1]);

  console.log("\nthe live shape, repaired");
  const a1 = await makeRun("one");
  const t1 = await makeTask("bs for a client", a1.run.id);
  const r1 = await call(adminTok, `/api/tasks/${t1.id}/delegate`, { assignee: target.name });
  expect(r1.status, 200, "an admin hands it over");
  expect(r1.body?.stepsMoved, 1, "the open step moved with it");
  const t1after = await prisma.task.findUnique({ where: { id: t1.id } });
  expect(t1after?.assignee, target.name, "task shows the new owner");
  // The whole point: the id, not only the name a screen happens to filter on.
  expect(t1after?.assigneeId, target.id, "task CARRIES THE ID");
  const s1after = await prisma.workflowTask.findUnique({ where: { id: a1.step.id } });
  expect(s1after?.assignee, target.name, "step shows the new owner");
  expect(s1after?.assigneeId, target.id, "step carries the id");
  // Naming a person is what takes a step out of the role pool; leaving the role on would keep it
  // in every pro_officer's queue beside the person who now owns it.
  expect(s1after?.assigneeRole, null, "the role queue is cleared");

  console.log("\na task with no run");
  const t2 = await makeTask("a plain task", null);
  const r2 = await call(adminTok, `/api/tasks/${t2.id}/delegate`, { assignee: target.name });
  expect(r2.status, 200, "moves on its own");
  expect(r2.body?.stepsMoved, 0, "and reports no steps");
  expect((await prisma.task.findUnique({ where: { id: t2.id } }))?.assigneeId, target.id, "with the id set");

  console.log("\nwhat it refuses");
  const t3 = await makeTask("a refused one", null);
  const r3 = await call(adminTok, `/api/tasks/${t3.id}/delegate`, { assignee: "Nobody By That Name" });
  expect(r3.status, 400, "a name that is not staff");
  const t3after = await prisma.task.findUnique({ where: { id: t3.id } });
  (t3after?.assignee === officer.name && t3after?.assigneeId === null)
    ? ok("and wrote nothing") : fail(`it wrote something → ${JSON.stringify([t3after?.assignee, t3after?.assigneeId])}`);
  expect((await call(adminTok, `/api/tasks/${t2.id}/delegate`, { assignee: target.name })).status, 409, "handing it to whoever already holds it");
  expect((await call(adminTok, `/api/tasks/${t1.id}/delegate`, {})).status, 400, "no name at all");

  console.log("\nall or nothing — the half-move this exists to prevent");
  const a4 = await makeRun("four");
  const t4 = await makeTask("one an officer may not move", a4.run.id);
  // A plain officer: not an admin, and not a team lead over the person holding the step.
  const r4 = await call(officerTok, `/api/tasks/${t4.id}/delegate`, { assignee: target.name });
  expect(r4.status, 403, "an officer cannot move another's step");
  /only an admin/i.test(String(r4.body?.error ?? ""))
    ? ok("and the refusal says who can") : fail(`unhelpful refusal → ${r4.body?.error}`);
  const t4after = await prisma.task.findUnique({ where: { id: t4.id } });
  const s4after = await prisma.workflowTask.findUnique({ where: { id: a4.step.id } });
  // If the task had moved here and the step had not, the new owner would hold a case they cannot
  // act on — which is the exact state reported from live.
  (t4after?.assignee === officer.name && s4after?.assigneeId === holder.id)
    ? ok("the task stayed put too")
    : fail(`a half-move happened → task=${t4after?.assignee} step=${s4after?.assignee}`);
}

main()
  .catch((e) => { console.error(e); bad++; })
  .finally(async () => {
    await sweep();
    await prisma.$disconnect();
    console.log(bad ? `\n${bad} FAILED` : "\nall good");
    process.exit(bad ? 1 : 0);
  });
