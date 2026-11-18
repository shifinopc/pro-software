/**
 * Throwaway check: NAMING A CLIENT'S OFFICER MOVES THE WORK ALREADY OPEN FOR THEM.
 *
 * A client created weeks ago has live steps sitting in the pro-officer queue, or on the desk of
 * whoever picked them up. Naming the officer now has to hand those over too — a handover that only
 * applies to work not yet raised leaves the client screen naming somebody who is not doing the work.
 *
 * What must NOT move is a step DELEGATED to a named person: delegation clears `assigneeRole`, which
 * is the per-step override, and a client-level setting does not get to overrule it. Nor anything
 * already finished, nor another client's work.
 *
 * Goes through the REAL route over HTTP as a signed-in admin. Runs against a scratch database and
 * deletes everything it made.
 *
 *   DATABASE_URL=...stimespro_scratch PROBE_API=http://localhost:4101 npx tsx scripts/probe-role-owner-move.ts
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const API = process.env.PROBE_API ?? "http://localhost:4100";
const TAG = "zz-probe-rom";

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

const mkUser = (name: string, email: string, roleId: string, passwordHash: string) =>
  prisma.user.create({ data: { name, email, roleId, type: "staff", status: "active", passwordHash } });

async function main() {
  const before = { user: await prisma.user.count(), co: await prisma.company.count(), task: await prisma.workflowTask.count() };

  const password = "Probe" + randomBytes(3).toString("hex") + "!9";
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  const admin = await mkUser("ZZ Probe Admin", `${TAG}-admin@example.invalid`, "admin", hash);
  const oldPro = await mkUser("ZZ Probe Officer Old", `${TAG}-old@example.invalid`, "pro_officer", hash);
  const newPro = await mkUser("ZZ Probe Officer New", `${TAG}-new@example.invalid`, "pro_officer", hash);
  const other = await mkUser("ZZ Probe Bystander", `${TAG}-by@example.invalid`, "pro_officer", hash);

  const login = await fetch(API + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: admin.email, password }),
  });
  const token = (await login.json().catch(() => ({})) as any).token;
  if (!token) throw new Error("probe could not sign in (" + login.status + ") — is the API on " + API + "?");
  const hdr = { "Content-Type": "application/json", Authorization: "Bearer " + token };

  // The client, created with NO officer named — the case in question.
  const co = await prisma.company.create({ data: { name: "ZZ Probe Client", status: "active" } });
  const otherCo = await prisma.company.create({ data: { name: "ZZ Probe Other Client", status: "active" } });
  const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ ROM PROBE", trigger: "manual", active: true, graph: graph as any } });

  const stepOf = async (companyId: string, title: string) => {
    // `force`: the duplicate guard would refuse the second run for the same client, and five
    // separate live steps is exactly the situation being tested.
    const run = await startInstance(tpl.id, { title, companyId, clientName: "ZZ Probe", force: true });
    const t = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
    if (!t) throw new Error("the template produced no active step");
    return t;
  };

  // 1. open and unclaimed  2. already picked up by someone else  3. delegated to a person
  // 4. already finished     5. another client's work
  const unclaimed = await stepOf(co.id, "Unclaimed");
  const claimed = await stepOf(co.id, "Claimed");
  const delegated = await stepOf(co.id, "Delegated");
  const finished = await stepOf(co.id, "Finished");
  const elsewhere = await stepOf(otherCo.id, "Other client");

  await prisma.workflowTask.update({ where: { id: unclaimed.id }, data: { assignee: null, assigneeId: null } });
  await prisma.workflowTask.update({ where: { id: claimed.id }, data: { assignee: oldPro.name, assigneeId: oldPro.id } });
  // Delegation is what clears the role — that is the per-step override this must respect.
  await prisma.workflowTask.update({ where: { id: delegated.id }, data: { assignee: other.name, assigneeId: other.id, assigneeRole: null } });
  await prisma.workflowTask.update({ where: { id: finished.id }, data: { status: "done", assignee: oldPro.name, assigneeId: oldPro.id } });
  await prisma.workflowTask.update({ where: { id: elsewhere.id }, data: { assignee: null, assigneeId: null } });

  // ── name the officer ──
  console.log("\nnaming the PRO officer on a client that already has open work:");
  const r = await fetch(API + `/api/companies/${co.id}/role-owners/pro_officer`, {
    method: "PUT", headers: hdr, body: JSON.stringify({ userId: newPro.id }),
  });
  const j = await r.json().catch(() => ({})) as any;
  check(r.ok === true, "the call succeeds", { status: r.status, j });
  check(j.moved === 2, "both open role steps moved, without being asked", { moved: j.moved, openTasks: j.openTasks });

  const now = async (id: string) => prisma.workflowTask.findUnique({ where: { id }, select: { assignee: true, assigneeId: true, assigneeRole: true, status: true } });
  const a = await now(unclaimed.id), b = await now(claimed.id), c = await now(delegated.id),
        d = await now(finished.id), e = await now(elsewhere.id);

  check(a?.assigneeId === newPro.id && a?.assignee === newPro.name, "the unclaimed step is now theirs", a);
  check(b?.assigneeId === newPro.id, "a step somebody else had picked up moves too", b);
  check(a?.assigneeRole === "pro_officer", "it is still role-owned work", a?.assigneeRole);
  check(c?.assigneeId === other.id, "a step DELEGATED to a person is left alone", c);
  check(d?.assigneeId === oldPro.id && d?.status === "done", "finished work is not rewritten", d);
  check(e?.assigneeId === null, "another client's work is untouched", e);

  const stored: any = (await prisma.company.findUnique({ where: { id: co.id }, select: { roleOwners: true } }))?.roleOwners;
  check(stored?.pro_officer === newPro.id, "the officer is stored on the client", stored);

  // ── clearing the officer must NOT move anything ──
  console.log("\nclearing the officer:");
  const r2 = await fetch(API + `/api/companies/${co.id}/role-owners/pro_officer`, {
    method: "PUT", headers: hdr, body: JSON.stringify({ userId: "" }),
  });
  const j2 = await r2.json().catch(() => ({})) as any;
  check(r2.ok === true && j2.moved === 0, "nobody named means nothing moves", j2);
  check((await now(unclaimed.id))?.assigneeId === newPro.id, "the work stays with the person who had it", await now(unclaimed.id));

  // ── clean up ──
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: tpl.id }, select: { id: true } });
  const ids = runs.map(x => x.id);
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  await prisma.workflowTemplate.delete({ where: { id: tpl.id } });
  await prisma.audit.deleteMany({ where: { target: { startsWith: "ZZ Probe" } } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ Probe" } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { id: { in: [co.id, otherCo.id] } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });

  const after = { user: await prisma.user.count(), co: await prisma.company.count(), task: await prisma.workflowTask.count() };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  users ${before.user}->${after.user} · companies ${before.co}->${after.co} · tasks ${before.task}->${after.task}`);
  if (JSON.stringify(before) !== JSON.stringify(after)) { console.log("LEFTOVERS — clean up by hand"); bad++; }
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
