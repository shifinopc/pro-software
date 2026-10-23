/**
 * Prove that naming an officer on a client actually changes who gets the work -- and that a step
 * nobody is named for is left in the open rather than pushed onto whoever happens to be free.
 *
 * THIS PROBE USED TO ASSERT A LOAD BALANCER. pickAssignee had one: with no officer named it handed
 * the step to whoever held the role and was carrying least. That was removed deliberately -- see the
 * comment in workflow.ts, which records what it cost: fifty-nine steps sitting with one officer for
 * clients he had no relationship to, while the client screen said "Whoever is free" the whole time,
 * truthfully. Being free is not a reason to be given somebody else's client.
 *
 * The probe was not updated with it, so it failed four assertions for weeks against code that was
 * doing the right thing. What it walks now is the contract as it stands:
 *
 *   1. With no officer named, the answer is NOBODY -- and that is the point. A step with no owner
 *      stays in the role's queue instead of being pushed onto a stranger's desk.
 *   2. ...which is safe only because any holder of the role may act on it. That is the one claim the
 *      whole design rests on, so it is asserted here rather than believed.
 *   3. Naming an officer sends the work there instead, and says why.
 *   4. Naming somebody who has LEFT, been deactivated, or moved to another role is ignored -- never
 *      assigned to. The step waits in the role's queue, as if nobody had been named.
 *   5. A routing rule naming a PERSON still wins. It is about a kind of work rather than a client,
 *      which is narrower, and somebody wrote it on purpose.
 *   6. The job that re-tries orphaned steps honours the officer, and invents nobody when there is
 *      none -- it takes no routing facts, so it was the easy place to quietly hand a client's
 *      backlog to the wrong desk.
 *
 * Own client, own staff, own rules. Deletes everything it makes.
 */import { prisma } from "../src/db.js";
import { pickAssignee, mayActOnTask } from "../src/workflow.js";
import bcrypt from "bcryptjs";

const TAG = "ZS team probe";
const CLIENT = "ZS Team Probe Client";
// A role NOBODY on this installation holds. The first run of this used "pro_officer" and failed
// four assertions against a real local account that holds it and is idle — the balancer was right
// and the probe was wrong. A probe that competes with live data is testing the data.
const ROLE = "zs_probe_officer";

async function sweep() {
  await prisma.assignmentRule.deleteMany({ where: { label: { startsWith: TAG } } });
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: runs.map(r => r.id) } } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: "zs-team-" } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: `${TAG} template` } });
}

async function staff(tag: string, name: string, roleId = ROLE) {
  return prisma.user.create({ data: {
    name, email: `zs-team-${tag}@example.invalid`, roleId, status: "active", type: "staff",
    passwordHash: await bcrypt.hash("ZsTeamProbe!2026", 10),
  } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  const omar = await staff("omar", "ZS Omar (officer)");
  const sara = await staff("sara", "ZS Sara (officer)");
  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA", status: "active", lifecycle: "client" } as any });

  // A real template: the instance carries a foreign key to one, and a run with no template is not a
  // shape this system ever produces.
  const tpl = await prisma.workflowTemplate.create({ data: {
    name: `${TAG} template`, country: "SA", entityType: "company", active: false,
    graph: { nodes: [], edges: [] } as any,
  } as any });

  // Sara is busier, so the balancer should prefer Omar while nobody is named.
  const run = await prisma.workflowInstance.create({ data: {
    templateId: tpl.id, title: `${TAG} run`, companyId: co.id, clientName: CLIENT,
    status: "running", variables: {} as any,
  } as any });
  for (let i = 0; i < 3; i++) {
    await prisma.workflowTask.create({ data: {
      instanceId: run.id, nodeId: `busy${i}`, nodeType: "task", title: `${TAG} filler ${i}`,
      status: "active", assignee: sara.name, assigneeId: sara.id, assigneeRole: ROLE,
    } as any });
  }

  // ── 1. nobody named means NOBODY, not whoever is free ──────────────────────────────────────
  const a = await pickAssignee(ROLE, { companyId: co.id });
  console.log(`nobody named:             ${a?.name ?? "nobody — stays in the role queue"}`);
  if (a) fail(`a client with no named officer was given one anyway: ${a.name}`);

  // ── 2. ...and that is only safe because the role can still act on it ───────────────────────
  //
  // An unowned step is not a lost step: it carries the ROLE, and every holder of that role may act
  // on it. Without this rung in mayActOnTask, "nobody named" would mean work nobody can touch, and
  // the design above would be a bug rather than a decision.
  const unowned = { assigneeRole: ROLE, assignee: null, assigneeId: null };
  const omarMay = await mayActOnTask({ sub: omar.id, role: ROLE }, { name: omar.name }, unowned);
  const saraMay = await mayActOnTask({ sub: sara.id, role: ROLE }, { name: sara.name }, unowned);
  console.log(`an unowned step:          both role holders may act: ${omarMay && saraMay}`);
  if (!omarMay || !saraMay) fail("an unowned step cannot be acted on by the role it is waiting for — it IS lost work");
  // ...but not by somebody outside the role, or it is not waiting for a role at all.
  const outsider = await mayActOnTask({ sub: "someone-else", role: "zs_probe_other" }, { name: "Outsider" }, unowned);
  if (outsider) fail("a step waiting for one role could be acted on by another");

  // ── 3. naming one sends the work there, and says why ───────────────────────────────────────
  await prisma.company.update({ where: { id: co.id }, data: { roleOwners: { [ROLE]: sara.id } as any } });
  const b = await pickAssignee(ROLE, { companyId: co.id });
  console.log(`Sara named on the client: ${b?.name} (${b?.why})`);
  if (b?.id !== sara.id) fail(`the client's named officer was ignored — got ${b?.name}`);
  if (!b?.why) fail("the assignment gave no reason, so nobody can tell why it landed there");

  // The client is what makes the difference: the same role asked WITHOUT a client has no officer to
  // read, so it must come back empty rather than borrowing this one's.
  const noClient = await pickAssignee(ROLE, { companyId: null });
  if (noClient) fail(`a client's officer leaked into an assignment that named no client: ${noClient.name}`);

  // ── 4. a named officer who cannot take it is ignored, never assigned to ────────────────────
  //
  // The step then waits in the role's queue exactly as if nobody had been named — which rung 2
  // above has just shown is workable. The failure this guards against is the opposite one: handing
  // a government filing to somebody who left the firm last month.
  for (const [what, patch] of [
    ["has left", { status: "inactive" }],
    ["moved to another role", { status: "active", roleId: "zs_probe_other" }],
  ] as [string, any][]) {
    await prisma.user.update({ where: { id: sara.id }, data: patch });
    const c = await pickAssignee(ROLE, { companyId: co.id });
    console.log(`Sara ${what}:${" ".repeat(Math.max(1, 17 - what.length))}${c?.name ?? "nobody — back to the role queue"}`);
    if (c?.id === sara.id) fail(`a step was assigned to somebody who ${what}`);
    else if (c) fail(`naming an officer who ${what} handed the client to ${c.name} instead`);
  }
  await prisma.user.update({ where: { id: sara.id }, data: { status: "active", roleId: ROLE } });

  // ── 5. a rule naming a person is narrower and still wins ───────────────────────────────────
  const noura = await staff("noura", "ZS Noura (specialist)");
  await prisma.assignmentRule.create({ data: {
    label: `${TAG} GOSI`, scope: "task", active: true, position: 1,
    whenGovCenter: "GOSI", toUserId: noura.id,
  } as any });
  const d = await pickAssignee(ROLE, { companyId: co.id, govCenter: "GOSI" });
  console.log("");
  console.log(`a GOSI step, Sara named:  ${d?.name} (${d?.why})`);
  if (d?.id !== noura.id) fail("a routing rule naming a person was overruled by the client's officer");
  // …and a step at any other authority still goes to the client's officer.
  const e = await pickAssignee(ROLE, { companyId: co.id, govCenter: "Qiwa" });
  console.log(`a Qiwa step, Sara named:  ${e?.name} (${e?.why})`);
  if (e?.id !== sara.id) fail("the rule leaked beyond the authority it names");

  // ── 6. the orphan retry honours it too ─────────────────────────────────────────────────────
  const orphan = await prisma.workflowTask.create({ data: {
    instanceId: run.id, nodeId: "orphan", nodeType: "task", title: `${TAG} orphan`,
    status: "active", assignee: null, assigneeId: null, assigneeRole: ROLE,
  } as any });
  const { assignOrphanTasks } = await import("../src/jobs.js");
  await assignOrphanTasks();
  const after = await prisma.workflowTask.findUnique({ where: { id: orphan.id }, select: { assignee: true } });
  console.log("");
  console.log(`an orphaned step retried:  ${after?.assignee}`);
  if (after?.assignee !== sara.name) fail(`the orphan job ignored the client's officer and picked ${after?.assignee}`);

  // ...and invents nobody when the client has no officer. This job runs hourly over every unowned
  // step in the system, so a balancer hiding in here would undo the decision above on its own.
  await prisma.company.update({ where: { id: co.id }, data: { roleOwners: {} as any } });
  const orphan2 = await prisma.workflowTask.create({ data: {
    instanceId: run.id, nodeId: "orphan2", nodeType: "task", title: `${TAG} orphan unowned`,
    status: "active", assignee: null, assigneeId: null, assigneeRole: ROLE,
  } as any });
  await assignOrphanTasks();
  const after2 = await prisma.workflowTask.findUnique({ where: { id: orphan2.id }, select: { assignee: true } });
  console.log(`an orphan with no officer: ${after2?.assignee ?? "left alone"}`);
  if (after2?.assignee) fail(`the orphan job handed an unowned step to ${after2.assignee}`);

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
