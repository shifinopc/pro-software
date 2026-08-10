/**
 * Give every task/approval step a responsible role.
 *
 * A step with no role produces work that lands unassigned and notifies nobody. The engine handles
 * it — falling back to the run-level owner, then to unassigned — but in a business whose deadlines
 * are government deadlines, "sitting in a pile somebody will spot eventually" is how a fine happens.
 *
 * WHY THE ROLES BELOW ARE NOT INVENTED. Each one is read off the pattern the templates already
 * follow, chiefly Iqama Renewal (KSA), which is fully configured:
 *   · government-portal work (Qiwa, Absher, Muqeem, MHRSD)  → pro_officer   (56 steps already)
 *   · money — fees, dues, invoices, contributions           → accountant    (25 steps already)
 *   · approvals                                             → accountant    (18 of 24 already)
 * Where the pattern genuinely does not decide it, the row is marked NEEDS A DECISION and is left
 * alone even with --apply. Guessing on those would put a real step on the wrong desk, which reads
 * as configured and is worse than the blank it replaced.
 *
 * Demo and QA templates are skipped: they exist to be broken.
 *
 * DRY RUN BY DEFAULT.  npx tsx scripts/set-step-roles.ts          → prints the plan
 *                      npx tsx scripts/set-step-roles.ts --apply  → writes it
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

/** label fragment → role. First match wins, so order is significance, not alphabet. */
const RULES: Array<[RegExp, string, string]> = [
  [/settle dues|final salary|invoice|fee|payment|sadad/i, "accountant", "money"],
  [/gosi (contribution|settle)/i, "accountant", "money"],
  [/qiwa|absher|muqeem|mhrsd|work permit|labour contract|iqama|exit visa|visa|permit|passport|medical/i, "pro_officer", "government portal work"],
  [/collect|upload|document|letter|certificate/i, "pro_officer", "document collection"],
];

/** Steps the pattern does not decide. Listed by name so the reason travels with the row. */
const UNDECIDED: Array<[RegExp, string]> = [
  [/gosi dereg/i, "GOSI deregistration is a portal filing (→ pro_officer) but every other GOSI step in the system is an accountant's. Pick one."],
  [/confirm departure|close file/i, "Closing the file could sit with the PRO officer who did the work or with an admin doing the final check."],
];

const SKIP_TEMPLATE = /^(DEMO|QA PROBE|TEST)/i;

async function main() {
  const templates = await prisma.workflowTemplate.findMany({
    where: { retired: false },
    select: { id: true, name: true, active: true, graph: true },
    orderBy: { name: "asc" },
  });

  // A role nobody holds is the same outcome as no role at all — the engine finds no one and leaves
  // the task unassigned. Worth knowing before assigning more work to it.
  const staff = await prisma.user.groupBy({ by: ["roleId"], where: { type: "staff", status: "active" }, _count: { _all: true } });
  const held = new Map(staff.map(s => [s.roleId, s._count._all]));

  let planned = 0, undecided = 0, skipped = 0;
  const writes: Array<{ id: string; graph: any; name: string }> = [];

  for (const t of templates) {
    const graph: any = t.graph ?? {};
    const nodes: any[] = Array.isArray(graph.nodes) ? graph.nodes : [];
    const roleless = nodes.filter(n =>
      (n?.type === "task" || n?.type === "approval") && !n?.config?.assigneeRole && !n?.config?.approverRole);
    if (!roleless.length) continue;

    if (SKIP_TEMPLATE.test(t.name)) {
      console.log(`\n${t.name}  — skipped (demo/QA template), ${roleless.length} step(s) left alone`);
      skipped += roleless.length;
      continue;
    }

    console.log(`\n${t.name}${t.active ? "  [ACTIVE]" : "  [draft]"}`);
    let touched = false;
    for (const n of roleless) {
      const label = String(n.label ?? n.id);
      const stop = UNDECIDED.find(([re]) => re.test(label));
      if (stop) { console.log(`   ?  ${label}\n        NEEDS A DECISION — ${stop[1]}`); undecided++; continue; }

      // An approval with no other signal follows the approval precedent, not the task rules.
      const hit = RULES.find(([re]) => re.test(label));
      const role = hit ? hit[1] : (n.type === "approval" ? "accountant" : null);
      const why = hit ? hit[2] : (n.type === "approval" ? "approval (matches 18 of 24 existing)" : "");
      if (!role) { console.log(`   ?  ${label}\n        NEEDS A DECISION — no rule matches this step's name.`); undecided++; continue; }

      const warn = held.get(role) ? "" : `  ⚠ nobody currently holds "${role}"`;
      console.log(`   →  ${label}\n        ${role}  (${why})${warn}`);
      n.config = { ...(n.config ?? {}), [n.type === "approval" ? "approverRole" : "assigneeRole"]: role };
      planned++; touched = true;
    }
    if (touched) writes.push({ id: t.id, graph, name: t.name });
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${planned} step(s) would get a role · ${undecided} need a decision · ${skipped} skipped (demo/QA)`);
  for (const [role, n] of held) console.log(`   ${role}: ${n} active user(s)`);

  if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply to write it.`); }
  else {
    for (const w of writes) await prisma.workflowTemplate.update({ where: { id: w.id }, data: { graph: w.graph } });
    console.log(`\nAPPLIED to ${writes.length} template(s).`);
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
