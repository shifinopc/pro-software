/**
 * Throwaway check that probation cannot run past its statutory ceiling.
 *
 * Saudi Labour Law article 53 caps the total probation period at 180 days in all cases. The graph
 * had 90 days then an extend branch looping back into another 30 — with no counter, no cap and no
 * exit condition, so a fourth, tenth or fiftieth extension was possible and every one past the
 * ceiling unlawful. Nothing in the workflow could even ask how much probation somebody had served,
 * because a delay node did not count.
 *
 * So this walks the extension loop the way the engine does — accumulating on each delay exactly as
 * the delay handler does — and checks that the ceiling actually stops it, that it stops at the right
 * number rather than one loop late, and that the way out is a decision somebody makes rather than a
 * dead end.
 *
 * Reads the stored graph. Creates nothing.
 */
import { prisma } from "../src/db.js";

const CAP = 180;

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  if (!tpl) { console.log("template not found"); process.exit(1); }
  const g: any = tpl.graph;
  const nodes: any[] = g.nodes ?? [];
  const edges: any[] = g.edges ?? [];
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const out = (id: string) => edges.filter(e => e.from === id);

  // ── the delays have to count, or nothing downstream can ask ────────────────────────────────
  const probation = byId.get("probation"), extend = byId.get("extend");
  const counts = (n: any) => String(n?.config?.accumulateInto ?? "");
  console.log(`the initial probation counts its days:     ${counts(probation) ? "YES (" + counts(probation) + ")" : "NO"}`);
  if (!counts(probation)) fail("the 90-day wait does not accumulate, so no rule can know it happened");
  console.log(`each extension counts its days too:        ${counts(extend) === counts(probation) && counts(extend) ? "YES" : "NO"}`);
  if (counts(extend) !== counts(probation)) fail("the extension counts into a different variable than the probation, so the total is never the total");
  const VAR = counts(probation) || "probationDaysUsed";

  // ── walk the loop the way the engine would ─────────────────────────────────────────────────
  //
  // Simulated rather than asserted structurally: a cap wired to the wrong branch, or compared with
  // the wrong operator, is still "a cap" in the graph and still lets the loop run forever.
  const evalDecision = (node: any, vars: Record<string, any>) => {
    for (const b of (node.config?.branches ?? [])) {
      const have = vars[b.var], want = b.value;
      const n1 = Number(have), n2 = Number(want);
      const numeric = !isNaN(n1) && !isNaN(n2);
      switch (String(b.op ?? "eq")) {
        case "eq":  if (String(have) === String(want)) return b.key; break;
        case "gte": if (numeric && n1 >= n2) return b.key; break;
        case "gt":  if (numeric && n1 > n2) return b.key; break;
        case "lte": if (numeric && n1 <= n2) return b.key; break;
        case "lt":  if (numeric && n1 < n2) return b.key; break;
      }
    }
    return "else";
  };
  const follow = (from: string, key: string) => {
    const hit = out(from).find(e => String(e.condition ?? "") === key);
    return (hit ?? out(from).find(e => ["else", "default", ""].includes(String(e.condition ?? ""))))?.to;
  };

  const vars: Record<string, any> = {};
  const days = (id: string) => Number(byId.get(id)?.config?.days) || 0;
  vars[VAR] = (Number(vars[VAR]) || 0) + days("probation");     // the engine's own accumulate step
  const totals: number[] = [vars[VAR]];
  let extensions = 0, landedOn = "";

  // Somebody who keeps choosing "extend" forever.
  for (let i = 0; i < 40; i++) {
    const capKey = evalDecision(byId.get("d_cap"), vars);
    const next = follow("d_cap", capKey);
    if (next !== "extend") { landedOn = String(next); break; }
    vars[VAR] = (Number(vars[VAR]) || 0) + days("extend");
    totals.push(vars[VAR]);
    extensions++;
  }

  console.log("");
  console.log(`probation days as the loop runs:           ${totals.join(" → ")}`);
  console.log(`extensions allowed before the cap bites:   ${extensions}`);
  console.log(`total never exceeds ${CAP}:                  ${Math.max(...totals) <= CAP ? "YES" : "NO (" + Math.max(...totals) + ")"}`);
  if (Math.max(...totals) > CAP) fail(`probation reached ${Math.max(...totals)} days, past the ${CAP}-day statutory ceiling`);
  if (extensions >= 40) fail("the extension loop never terminated — there is still no cap");

  console.log(`...and the loop ends at a decision:        ${landedOn ? byId.get(landedOn)?.label ?? landedOn : "NOWHERE"}`);
  const final = byId.get(landedOn);
  if (!final) fail("the capped branch leads nowhere");
  else if (final.type === "end") fail(`the cap terminates the run at "${final.label}" on its own — ending somebody's employment is a decision, not a timeout`);

  // ── the way out must be confirm or terminate, and both must be reachable ───────────────────
  const caps = (final?.config?.captures ?? []).map((c: any) => c.var);
  console.log(`the final step asks for a decision:        ${caps.length ? caps.join(", ") : "NOTHING"}`);
  if (!caps.length) fail("the step at the cap captures nothing, so there is no decision to route on");
  const after = out(landedOn)[0]?.to;
  const dec = byId.get(String(after));
  const outcomes = dec ? out(dec.id).map(e => `${e.condition}→${byId.get(e.to)?.label ?? e.to}`) : [];
  console.log(`  ${outcomes.join("  ·  ") || "no outcomes"}`);
  const reaches = (label: RegExp) => outcomes.some(o => label.test(o));
  if (!reaches(/confirm/i)) fail("confirming the employee is not reachable from the cap");
  if (!reaches(/termination|end/i)) fail("ending the employment is not reachable from the cap");

  // ── an extension needs a written agreement, not just a dropdown ────────────────────────────
  const review = byId.get("prob_review");
  const rule = (review?.config?.rules ?? []).find((r: any) => String(r?.when?.value) === "extend");
  console.log("");
  console.log(`extending requires a written agreement:    ${rule ? "YES" : "NO"}`);
  if (rule) console.log(`  "${String(rule.message).slice(0, 92)}"`);
  if (!rule) fail("probation can be extended without recording the written agreement article 53 requires");

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
