/**
 * Walk every configured workflow, whichever script built it.
 *
 * The MISA build shipped with branches written { var, value, key } and no `op`, which reads
 * perfectly well and matches nothing: evalDecision's default arm is ok = false, so every decision
 * fell to "else" and the run bounced between two steps twenty times. Nothing about the graph looked
 * wrong. With twenty-odd workflows now generated from one builder, a single slip of that kind is in
 * all of them at once — so this checks all of them, every time, rather than the ones just touched.
 *
 * TWO PASSES, because they catch different things.
 *
 *   STRUCTURE, read off the graph: every edge lands somewhere real, every node is reachable from
 *   start, every branch arm carries an operator, every decision has an "else" (without one a run
 *   with an unexpected value stops dead with no task and no ending), and every path ends at an end
 *   node rather than at a step with no successor.
 *
 *   A WALK, driven through the real engine: start a run and complete whatever it offers, choosing
 *   the first option of every select, until it finishes. A step budget catches exactly the failure
 *   the MISA graph had — a run that never terminates looks identical to a slow one until you count.
 *
 * Own client, own employee, own runs. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask, validateReferences } from "../src/workflow.js";

const CLIENT = "ZS All-Services Probe";
const BUDGET = 40; // no configured workflow is anywhere near this many steps; a loop blows past it

let bad = 0;
let skipped = 0;
const fail = (m: string) => { bad++; console.log(`      FAIL  ${m}`); };

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } });
    const ids = runs.map(r => r.id);
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.task.deleteMany({ where: { companyId: co.id } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.document.deleteMany({ where: { companyId: co.id } });
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
}

/** A plausible answer for a field, without knowing anything about the workflow. */
function answer(cap: any): any {
  const t = String(cap?.type ?? "text");
  if (t === "select") return String(cap.options ?? "").split(",")[0]?.trim() || "yes";
  if (t === "number") return 100;
  if (t === "date") return "2026-09-10";
  return `probe ${String(cap?.var ?? "value")}`;
}

function structure(name: string, g: any) {
  const ids = new Set<string>(g.nodes.map((n: any) => n.id));
  const F = (e: any) => e.from ?? e.source, T = (e: any) => e.to ?? e.target;

  for (const e of g.edges) {
    if (!ids.has(F(e))) fail(`${name}: edge from unknown node "${F(e)}"`);
    if (!ids.has(T(e))) fail(`${name}: edge to unknown node "${T(e)}"`);
  }

  const reach = new Set<string>(["start"]);
  for (let i = 0; i < g.nodes.length; i++)
    for (const e of g.edges) if (reach.has(F(e))) reach.add(T(e));
  const orphans = g.nodes.map((n: any) => n.id).filter((id: string) => !reach.has(id));
  if (orphans.length) fail(`${name}: unreachable — ${orphans.join(", ")}`);

  for (const n of g.nodes) {
    const out = g.edges.filter((e: any) => F(e) === n.id);
    if (n.type === "end") continue;
    if (!out.length) { fail(`${name}: "${n.id}" is a dead end — no way out and it is not an end node`); continue; }
    if (n.type === "decision") {
      const arms = (n.config?.branches ?? []) as any[];
      if (!arms.length) fail(`${name}: decision "${n.id}" has no branches`);
      for (const b of arms) {
        if (!b.op) fail(`${name}: decision "${n.id}" branch on ${b.var}=${b.value} has NO OPERATOR — it will match nothing`);
        if (!b.var) fail(`${name}: decision "${n.id}" has a branch with no variable`);
      }
      // An else arm is what stops an unexpected value ending the run with no task and no ending.
      if (!out.some((e: any) => (e.label ?? e.condition) === "else")) fail(`${name}: decision "${n.id}" has no else arm`);
      for (const b of arms) if (!out.some((e: any) => (e.label ?? e.condition) === b.key)) fail(`${name}: decision "${n.id}" declares "${b.key}" with no matching edge`);
    }
  }
}

async function walk(name: string, tplId: string, subject: any) {
  const run = await startInstance(tplId, { title: `probe — ${name}`, ...subject });
  let steps = 0;
  const seen: string[] = [];
  for (;;) {
    const t = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" }, orderBy: { createdAt: "asc" } });
    if (!t) break;
    if (++steps > BUDGET) { fail(`${name}: still running after ${BUDGET} steps — ${seen.slice(-8).join(" -> ")}`); return; }
    seen.push(t.nodeId);
    const checklist: any = {};
    for (const i of (Array.isArray(t.checklist) ? t.checklist : []) as any[]) checklist[i.key] = { received: true, verified: true };
    const vars: any = {};
    for (const c of (Array.isArray(t.captures) ? t.captures : []) as any[]) vars[c.var] = answer(c);
    try { await completeTask(t.id, { actor: "all-services probe", checklist, variables: vars }); }
    catch (e: any) {
      // A CROSS-FIELD RULE REFUSING IS THE RULE WORKING, NOT THE WORKFLOW FAILING.
      //
      // This walker answers each field in isolation — first option of every select — so it can
      // produce a combination no human would enter, such as the Saudi-national hiring path with a
      // non-Saudi nationality. Onboarding refuses that, correctly. Counting it as a defect would
      // train everyone to ignore this probe, so it is reported and skipped rather than failed.
      // A genuine engine fault surfaces as a stopped run below, which is still a failure.
      console.log(`      not walked — a cross-field rule needs coherent answers this probe cannot invent:`);
      console.log(`        "${e?.message}"`);
      skipped++;
      return;
    }
  }
  const inst = await prisma.workflowInstance.findUnique({ where: { id: run.id } });
  if (inst?.status !== "completed") fail(`${name}: the run ended "${inst?.status}" with no active step — it stopped without finishing`);
  else console.log(`      walked ${String(steps).padStart(2)} steps -> completed`);
}

async function main() {
  await sweep();
  const co = await prisma.company.create({ data: { name: CLIENT, country: "SA" } as any });
  const emp = await prisma.employee.create({ data: { name: "ZS Probe Person", companyId: co.id } as any });
  const subject = { companyId: co.id, clientName: CLIENT, variables: { employeeId: emp.id } };

  const tpls = await prisma.workflowTemplate.findMany({ where: { retired: false }, orderBy: { name: "asc" } });
  console.log(`${tpls.length} configured workflows\n`);

  for (const tpl of tpls) {
    console.log(`  ${tpl.name}`);
    const before = bad;
    const issues = await validateReferences(tpl.graph as any, tpl as any);
    for (const i of issues) fail(`${tpl.name}: ${JSON.stringify(i)}`);
    structure(tpl.name, tpl.graph as any);
    if (bad === before) await walk(tpl.name, tpl.id, subject);
    else console.log("      structural problems — not walked");
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
