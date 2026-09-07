/**
 * Prove that naming an officer on a client actually changes who gets the work — and, just as
 * important, that it can never be the reason a step ends up with nobody.
 *
 * The default is a load balancer: whoever holds the role and is carrying least. It is the right
 * default and the wrong only answer, because an officer who knows a client's file is worth more than
 * an officer who is free this minute. What this walks:
 *
 *   1. With no officer named, the balancer decides — and it really is the least-loaded person, not
 *      just the first one alphabetically.
 *   2. Naming one sends the work there instead, and says why.
 *   3. Naming somebody who has LEFT, been deactivated, or moved to another role is ignored: the
 *      balancer takes over. A client team is a preference; an unassigned task is a failure, and the
 *      preference must never be able to cause one.
 *   4. A routing rule naming a PERSON still wins. It is about a kind of work rather than a client,
 *      which is narrower, and somebody wrote it on purpose.
 *   5. The job that re-tries orphaned steps honours the officer too — it takes no routing facts, so
 *      it was the easy place to quietly hand a client's backlog to the wrong desk.
 *
 * Own client, own staff, own rules. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { pickAssignee } from "../src/workflow.js";
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

  // ── 1. the balancer, with nobody named ─────────────────────────────────────────────────────
  const a = await pickAssignee(ROLE, { companyId: co.id });
  console.log(`nobody named:            ${a?.name}${a?.why ? ` (${a.why})` : " (least loaded)"}`);
  if (a?.id !== omar.id) fail(`the balancer should have picked the idle officer, got ${a?.name}`);

  // ── 2. naming one overrides it, and says why ───────────────────────────────────────────────
  await prisma.company.update({ where: { id: co.id }, data: { roleOwners: { [ROLE]: sara.id } as any } });
  const b = await pickAssignee(ROLE, { companyId: co.id });
  console.log(`Sara named on the client: ${b?.name} (${b?.why})`);
  if (b?.id !== sara.id) fail(`the client's named officer was ignored — got ${b?.name}`);
  if (!b?.why) fail("the assignment gave no reason, so nobody can tell why it landed there");

  // The client is what makes the difference: the same role, asked without a client, still balances.
  const noClient = await pickAssignee(ROLE, { companyId: null });
  if (noClient?.id !== omar.id) fail("a client's officer leaked into an assignment that named no client");

  // ── 3. a named officer who cannot take it is ignored, never assigned to ────────────────────
  for (const [what, patch] of [
    ["has left", { status: "inactive" }],
    ["moved to another role", { status: "active", roleId: "zs_probe_other" }],
  ] as [string, any][]) {
    await prisma.user.update({ where: { id: sara.id }, data: patch });
    const c = await pickAssignee(ROLE, { companyId: co.id });
    console.log(`Sara ${what}:${" ".repeat(Math.max(1, 16 - what.length))}${c?.name ?? "NOBODY"}`);
    if (!c) fail(`naming someone who ${what} left the step with nobody — a preference must never stall work`);
    else if (c.id !== omar.id) fail(`expected the balancer to take over, got ${c.name}`);
  }
  await prisma.user.update({ where: { id: sara.id }, data: { status: "active", roleId: ROLE } });

  // ── 4. a rule naming a person is narrower and still wins ───────────────────────────────────
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

  // ── 5. the orphan retry honours it too ─────────────────────────────────────────────────────
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

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
