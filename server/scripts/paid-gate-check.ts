/**
 * AN "UNPAID" ANSWER MUST NOT ADVANCE A WORKFLOW.
 *
 *   npx tsx scripts/paid-gate-check.ts [template name]      # default: Iqama Renewal
 *
 * Every fee step in Iqama Renewal asked "paid?", offered "unpaid", and then completed anyway — so a
 * run reached "Renew Iqama" with the work permit fee and the Jawazat fee both recorded unsettled.
 * Jawazat refuses that renewal, which is the point: the fee is what buys it.
 *
 * This reads the graph THE DATABASE ACTUALLY HOLDS, not the rebuild script, because the two drift —
 * the template is also editable in the builder, and a rule deleted there is a gate that is gone.
 *
 * Holding the line is not enough on its own: the step must SAY SO. Violations used to be held by a
 * decision that routed the run straight back, which does stop it — and looks exactly like a refresh,
 * because completing closed the task and re-raised it with the boxes empty. So only a rule passes,
 * and a silent loop is reported as the failure it is.
 *
 * It is written against the shape rather than against three known variables, so a fourth fee added
 * next year is checked the day it is added and nobody has to remember this file exists.
 */
import { prisma } from "../src/db.js";
import { brokenRules } from "../src/workflow.js";

const NAME = process.argv.slice(2).find(a => !a.startsWith("-")) || "Iqama Renewal";
const PAID = "paid", UNPAID = "unpaid";

type Node = { id: string; type: string; label?: string; config?: any };
type Edge = { from: string; to: string; condition?: string };

/** Answers that put the form in the state where `target` is on screen, with `target` set to `value`. */
function answers(caps: any[], target: string, value: string): Record<string, string> {
  const vars: Record<string, string> = {};
  // Anything another field is conditional on gets the value that reveals it.
  for (const c of caps) {
    const cond = c?.showIf;
    if (cond?.var && cond.equals != null) vars[String(cond.var)] = String(cond.equals);
  }
  vars[target] = value;
  return vars;
}

const main = async () => {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: NAME } });
  if (!tpl) { console.error(`No workflow template named "${NAME}".`); process.exit(2); }
  const g = (tpl.graph ?? {}) as { nodes?: Node[]; edges?: Edge[] };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (!nodes.length) { console.error(`"${NAME}" has no steps — this check needs updating.`); process.exit(2); }

  console.log(`${NAME}  (${tpl.id})  active=${tpl.active}\n`);

  const fails: string[] = [];
  let gates = 0;

  for (const n of nodes) {
    const caps: any[] = Array.isArray(n.config?.captures) ? n.config.captures : [];
    for (const cap of caps) {
      const opts = String(cap?.options ?? "").split(",").map(s => s.trim()).filter(Boolean);
      if (!cap?.var || !opts.includes(UNPAID)) continue;
      gates++;
      const v = String(cap.var);
      const where = `${n.label || n.id} → ${cap.label || v}`;

      // Held by a rule?
      const byRule = brokenRules(n.config, answers(caps, v, UNPAID));
      // Held by a decision that sends the run back to this very step?
      const reads = nodes.filter(d => d.type === "decision"
        && (d.config?.branches ?? []).some((b: any) => String(b?.var ?? "") === v));
      const byLoop = reads.find(d => edges.some(e => e.from === d.id && e.to === n.id));

      if (byRule.length) {
        console.log(`  ok    ${where}\n        refused: ${byRule[0].message}`);
        // And it must still complete once the money is recorded, or the step is a dead end.
        const stillBroken = brokenRules(n.config, answers(caps, v, PAID));
        if (stillBroken.length) {
          fails.push(`${where} — refuses "${PAID}" too: ${stillBroken[0].message}. The step cannot be completed at all.`);
        }
      } else if (byLoop) {
        fails.push(`${where} — held only by the decision "${byLoop.label || byLoop.id}", which routes back silently. `
          + `The step completes, re-opens with the boxes empty, and nothing tells the officer why.`);
      } else {
        fails.push(`${where} — "${UNPAID}" completes the step and the run moves on. Nothing stops it.`);
      }
    }
  }

  console.log(`\n${gates} paid/unpaid question(s) checked.`);
  if (!fails.length) return console.log("in order — none of them advance the run unpaid.");
  for (const f of fails) console.log(`\n  FAIL  ${f}`);
  console.log(`\n        Fix: add a rule to that step — { then: { var, op: "eq", value: "paid" }, message }`);
  console.log(`        in scripts/rebuild-${NAME.toLowerCase().replace(/\s+/g, "-")}.ts, then re-run it with --apply.`);
  process.exitCode = 1;
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
