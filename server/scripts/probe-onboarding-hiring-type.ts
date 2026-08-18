/**
 * Throwaway check that the hiring-type onboarding template can actually be run.
 *
 * A workflow graph is easy to author so that it READS correctly and halts on the first real run:
 * a branch key with no edge, a decision with no else, a join that waits for arrivals that never
 * come. None of those fail loudly — the run simply stops with no open task and nobody told.
 *
 * So this walks the graph the way the engine does, and separately asks the real rule evaluator what
 * documents each hiring type produces.
 *
 *   - every decision branch key has an edge, and every decision has an else
 *   - no node is unreachable from start, and no non-end node is a dead end
 *   - the parallel join is fed by exactly as many paths as it waits for
 *   - the three hiring types each resolve to a DIFFERENT document list, and the base row is in all
 *   - a value nobody enumerated lands on the else path rather than nowhere
 *   - every issue_document names a document type that exists in this country
 *
 * Reads only. Creates nothing, changes nothing.
 */
import { prisma } from "../src/db.js";
import { evaluateRule } from "../src/dealchecklist.js";

const TEMPLATE = "Employee Onboarding";
const RULE = "Onboarding documents by hiring type";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  if (!tpl) { console.log("template not found — run add-onboarding-hiring-type.ts first"); process.exit(1); }
  const g: any = tpl.graph;
  const nodes: any[] = g.nodes ?? [];
  const edges: any[] = g.edges ?? [];
  const byId = new Map(nodes.map(n => [n.id, n]));
  console.log(`${TEMPLATE}\n  ${nodes.length} nodes, ${edges.length} edges, active=${tpl.active}\n`);

  const out = (id: string) => edges.filter(e => e.from === id);

  // ── every branch key can be followed, and every decision has an else ───────────────────────
  let decisions = 0;
  for (const n of nodes.filter(x => x.type === "decision")) {
    decisions++;
    const conds = out(n.id).map(e => String(e.condition ?? ""));
    for (const b of (n.config?.branches ?? [])) {
      if (!conds.includes(b.key)) fail(`decision "${n.label}" branch "${b.key}" has no edge — that run stops here`);
    }
    const hasElse = conds.some(c => c === "else" || c === "default" || c === "");
    if (!hasElse) fail(`decision "${n.label}" has no else — an unexpected value halts the run silently`);
  }
  console.log(`every branch wired, every decision has an else:  ${bad === 0 ? "YES" : "NO"} (${decisions} decisions)`);

  // ── reachability, both directions ──────────────────────────────────────────────────────────
  const seen = new Set<string>(["start"]);
  const q = ["start"];
  while (q.length) for (const e of out(q.pop()!)) if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
  const orphans = nodes.filter(n => !seen.has(n.id)).map(n => n.label);
  console.log(`every node reachable from start:                ${orphans.length ? "NO — " + orphans.join(", ") : "YES"}`);
  if (orphans.length) fail("unreachable nodes");

  const deadEnds = nodes.filter(n => n.type !== "end" && !out(n.id).length).map(n => `${n.label} (${n.type})`);
  console.log(`no dead ends outside end nodes:                 ${deadEnds.length ? "NO — " + deadEnds.join(", ") : "YES"}`);
  if (deadEnds.length) fail("a non-end node has nowhere to go");

  // ── the join must not wait for branches that never arrive ──────────────────────────────────
  for (const j of nodes.filter(n => n.type === "parallel_join" || n.type === "join")) {
    const inDeg = edges.filter(e => e.to === j.id).length;
    const split = nodes.find(n => n.type === "parallel_split" || n.type === "split");
    const fanOut = split ? out(split.id).length : 0;
    // NOT a plain fan-out comparison: a branch may be a chain (payroll -> GOSI document -> join), so
    // what matters is how many of the split's branches eventually reach the join, counted by walking
    // each one. Comparing the split's edge count to the join's would have called this a hang.
    const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return out(from).some(e => reaches(e.to, target, seen));
    };
    const arriving = split ? out(split.id).filter(e => reaches(e.to, j.id)).length : 0;
    console.log(`join waits for ${inDeg}, ${arriving} of ${fanOut} branches reach it:  ${inDeg === arriving ? "YES" : "NO"}`);
    if (inDeg !== arriving) fail("the join waits for a different number of paths than actually arrive — it would hang");
  }

  // ── converge point must not be a join ──────────────────────────────────────────────────────
  const contract = byId.get("contract");
  const intoContract = edges.filter(e => e.to === "contract").length;
  console.log(`the 3 hiring paths converge on a plain ${contract?.type}:  ${contract?.type === "task" ? "YES" : "NO"} (${intoContract} in-edges)`);
  if (contract?.type !== "task") fail("the convergence point is a join — only one branch ever arrives, so it would wait forever");

  // ── issue_document nodes must name a type this country has ─────────────────────────────────
  console.log("");
  for (const n of nodes.filter(x => x.type === "issue_document")) {
    const name = n.config?.docType;
    const row = await prisma.documentType.findFirst({ where: { name, country: tpl.country ?? undefined, retired: false } });
    console.log(`document type "${name}" exists:${" ".repeat(Math.max(1, 22 - String(name).length))}${row ? "YES" : "NO"}`);
    if (!row) fail(`issue_document names "${name}", which this country has no document type for — it would still create a document, with no authority and default lead days`);
  }

  // ── every issued document must have somebody to belong to ──────────────────────────────────
  //
  // issue_document builds `person` from vars.applicant || vars.employee, then guards the write with
  // `if (inst.companyId && person)`. An empty person therefore does not fail the step, log anything
  // or mark the run — it just does not create the document. This workflow captured only
  // classification, so all six issue_document nodes wrote NOTHING while every step went green.
  //
  // Checked as reachability, not mere presence: capturing the name somewhere later in the graph
  // would satisfy a "does any node capture it" test and still leave the early documents ownerless.
  const PERSON_VARS = ["applicant", "employee", "applicantName", "employeeId"];
  const setsPerson = (n: any) => (n?.config?.captures ?? []).some((c: any) => PERSON_VARS.includes(c?.var));
  /** Can `target` be reached from start WITHOUT passing a step that names the person? */
  const reachableUnnamed = (target: string) => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (id === target) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      if (setsPerson(byId.get(id))) return false;      // this path names them; stop following it
      return out(id).some(e => walk(e.to));
    };
    return walk("start");
  };
  console.log("");
  for (const n of nodes.filter(x => x.type === "issue_document")) {
    const bad = reachableUnnamed(n.id);
    console.log(`"${n.config?.docType}" always knows whose it is:${" ".repeat(Math.max(1, 14 - String(n.config?.docType).length))}${bad ? "NO" : "YES"}`);
    if (bad) fail(`"${n.config?.docType}" can be reached without the person being captured — it would silently create no document at all`);
  }

  // ── a Saudi national must not be issued an expatriate instrument ───────────────────────────
  //
  // The three hiring types converged before the Work Permit node, so every Saudi national came out
  // of this workflow holding one — a document that does not exist for them, sitting on their record
  // with an expiry the compliance screens would then chase. It is invisible on the canvas because
  // the node is correct and its POSITION is not.
  //
  // Simulated rather than read: walking every edge counts the else branch of each decision and
  // reports a Work Permit on all three paths, which is how the original was reviewed as fine.
  const simulate = (vars: Record<string, string>) => {
    const docs: string[] = [];
    const seen = new Set<string>();
    const step = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = byId.get(id);
      if (!n) return;
      if (n.type === "issue_document") docs.push(String(n.config?.docType));
      if (n.type === "decision") {
        const hit = (n.config?.branches ?? []).find((b: any) => String(vars[b.var] ?? "") === String(b.value));
        const key = hit ? hit.key : "else";
        let next = out(id).filter(e => String(e.condition ?? "") === key);
        if (!next.length) next = out(id).filter(e => ["else", "default", ""].includes(String(e.condition ?? "")));
        for (const e of next) step(e.to);
        return;
      }
      for (const e of out(id)) if (String(e.condition ?? "") !== "reject") step(e.to);
    };
    step("start");
    return docs;
  };

  const happy = { documentsVerified: "pass", transferOutcome: "approved", employeeJoined: "yes", probationOutcome: "yes" };
  const EXPAT_ONLY = ["Work Permit", "Iqama", "Work Visa"];
  console.log("");
  console.log("documents each hiring type is actually issued:");
  for (const h of ["saudi_national", "expat_new_hire", "expat_transfer"]) {
    const docs = simulate({ ...happy, hiringType: h });
    console.log(`  ${h.padEnd(16)} ${docs.join(", ")}`);
    if (h === "saudi_national") {
      const wrong = docs.filter(d => EXPAT_ONLY.includes(d));
      if (wrong.length) fail(`a Saudi national is issued ${wrong.join(" and ")} — an expatriate instrument that does not exist for them`);
    } else if (!docs.includes("Work Permit")) {
      fail(`${h} is never issued a Work Permit, which a non-Saudi cannot work without`);
    }
  }

  // ── the rule really does produce three different lists ─────────────────────────────────────
  const rule = await prisma.checklistRule.findFirst({ where: { name: RULE } });
  if (!rule) { fail("the document rule is missing"); process.exit(1); }
  const rows: any[] = Array.isArray(rule.rows) ? (rule.rows as any[]) : [];
  console.log("\ndocuments each hiring type resolves to:");
  const lists: Record<string, string[]> = {};
  for (const t of ["saudi_national", "expat_new_hire", "expat_transfer"]) {
    const { items, matched } = evaluateRule(rows, { hiringType: t });
    lists[t] = items.map(i => i.key).sort();
    console.log(`  ${t.padEnd(16)} ${String(items.length).padStart(2)} documents  (rows ${matched.join("+")})`);
    if (items.length < 4) fail(`${t} resolved to almost nothing — the rule is not matching`);
  }
  const base = ["offer_signed", "passport_copy", "photo"];
  const allHaveBase = Object.values(lists).every(l => base.every(b => l.includes(b)));
  console.log(`\nthe base row applies to all three:              ${allHaveBase ? "YES" : "NO"}`);
  if (!allHaveBase) fail("the unconditional row did not reach every hiring type");

  const distinct = new Set(Object.values(lists).map(l => l.join("|"))).size;
  console.log(`all three lists differ from each other:         ${distinct === 3 ? "YES" : "NO"}`);
  if (distinct !== 3) fail("two hiring types produced the same documents — the branching is not doing anything");

  const transferOnly = lists.expat_transfer.filter(k => !lists.saudi_national.includes(k));
  console.log(`  transfer asks for: ${transferOnly.join(", ")}`);
  if (!transferOnly.includes("qiwa_consent")) fail("the transfer list does not ask for Qiwa consent — the whole point of the change");

  // ── an unenumerated value must not silently resolve to a full list ─────────────────────────
  const odd = evaluateRule(rows, { hiringType: "something_nobody_listed" });
  console.log(`\nan unknown hiring type gets only the base:      ${odd.items.length === base.length ? "YES" : "NO (" + odd.items.length + ")"}`);
  const oddNode = nodes.find(n => n.id === "d_hiring");
  const elseEdge = out("d_hiring").find(e => (e.condition ?? "") === "else");
  console.log(`...and the graph sends it to a person:          ${elseEdge ? byId.get(elseEdge.to)?.label : "NOWHERE"}`);
  if (!elseEdge) fail("an unknown hiring type has no route");

  // ── this is the only workflow now ─────────────────────────────────────────────────────────
  //
  // Every other template was removed on request, so the check that used to guard the original
  // Employee Onboarding is gone with it. What matters instead is that nothing else crept back and
  // that this one is the live one — an installation whose only workflow is a draft can run nothing.
  const all = await prisma.workflowTemplate.findMany({ select: { name: true, active: true } });
  console.log(`
workflow templates on this installation:       ${all.length}`);
  for (const t of all) console.log(`  ${t.active ? "ACTIVE" : "draft "}  ${t.name}`);
  if (all.length !== 1) fail(`expected one workflow, found ${all.length}`);
  if (!all.every(t => t.active)) fail("the only workflow is a draft, so nothing can run");

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); process.exit(1); });
