/**
 * Restart the Iqama renewals whose step no longer exists.
 *
 * The rebuilt workflow drops the step ids these runs are parked on, and a run finds its step by id —
 * so they cannot advance and cannot be left. They are cancelled and started again on the new five
 * steps, with the subject carried across so each one points at the same employee and the same Iqama.
 *
 * WHAT IS ALREADY RECORDED IS PRINTED BEFORE ANYTHING IS CANCELLED, because it does not survive:
 * fees already paid, references, dates and expiries are re-entered by hand on the new run. Two of
 * these have real payments on them and one has an Iqama already renewed; that was raised and the
 * firm chose to restart anyway. The print-out is what the officer works from.
 *
 *   npx tsx scripts/restart-stranded-iqama-runs.ts            # report only
 *   npx tsx scripts/restart-stranded-iqama-runs.ts --apply
 */
import { prisma } from "../src/db.js";
import { signToken } from "../src/auth.js";

// Through the API, not the table: creating the row directly leaves a run with no first step, because
// it is the engine behind that route that walks the graph and raises step 1.
const API = process.env.SELF_URL || "http://localhost:4100";
const actor = await prisma.user.findFirst({ where: { roleId: "super_admin", type: "staff", status: "active" } });
if (!actor) throw new Error("no super_admin to act as");
const H = { "Content-Type": "application/json", Authorization: "Bearer " + signToken({ sub: actor.id, type: "staff", role: actor.roleId, tv: actor.tokenVersion }, 1) };

const APPLY = process.argv.includes("--apply");
const KEEP = ["employeeId", "documentId", "person", "applicant", "docType", "subjectKind", "currentExpiry", "currentNumber"];

const main = async () => {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Iqama Renewal" } });
  if (!tpl) throw new Error("Iqama Renewal template not found");
  const ids = new Set(((tpl.graph as any)?.nodes ?? []).map((n: any) => String(n.id)));

  const live = await prisma.workflowTask.findMany({
    where: { status: "active", instance: { templateId: tpl.id, status: "running" } },
    include: { instance: true },
  });
  const stranded = live.filter(t => !ids.has(t.nodeId));
  if (!stranded.length) return console.log("nothing stranded — every running step still exists.");

  console.log(`${stranded.length} run(s) to restart.\n`);
  for (const t of stranded) {
    const v = (t.instance.variables ?? {}) as Record<string, any>;
    console.log(`${t.instance.title}`);
    console.log(`   client:  ${t.instance.clientName ?? "—"}`);
    console.log(`   stuck on: ${t.nodeId}`);
    const recorded = Object.entries(v).filter(([k]) => !KEEP.includes(k) && k !== "_joins");
    console.log(`   RECORDED, and lost on restart: ${recorded.length ? recorded.map(([k, val]) => `${k}=${JSON.stringify(val)}`).join(", ") : "nothing"}`);
    const done = await prisma.workflowTask.findMany({ where: { instanceId: t.instance.id, status: "done" }, select: { nodeId: true, completedBy: true, completedAt: true } });
    console.log(`   steps already done: ${done.map(d => `${d.nodeId} (${d.completedBy ?? "?"})`).join(", ") || "none"}`);
    console.log("");
  }

  if (!APPLY) return console.log("report only. Re-run with --apply to cancel and restart these.");

  for (const t of stranded) {
    const v = (t.instance.variables ?? {}) as Record<string, any>;
    const carried: Record<string, any> = {};
    for (const k of KEEP) if (v[k] !== undefined) carried[k] = v[k];

    await prisma.workflowTask.updateMany({ where: { instanceId: t.instance.id, status: { notIn: ["done", "cancelled"] } }, data: { status: "cancelled" } });
    await prisma.workflowInstance.update({ where: { id: t.instance.id }, data: { status: "cancelled", completedAt: new Date().toISOString() } });

    const res = await fetch(API + "/api/workflow/instances", {
      method: "POST", headers: H,
      body: JSON.stringify({ templateId: tpl.id, title: t.instance.title, companyId: t.instance.companyId, variables: carried }),
    });
    const fresh: any = await res.json().catch(() => ({}));
    console.log(`restarted: ${t.instance.title}  ${t.instance.id} -> ${res.status === 201 ? fresh.id : "FAILED " + res.status + " " + (fresh.error ?? "")}`);
  }
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
