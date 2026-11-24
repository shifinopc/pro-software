/**
 * THE WORK PERMIT FEE FIELD, REMOVED FROM "Issue Work Permit".
 *
 *   npx tsx scripts/drop-permit-fee-capture.ts            say what it would do
 *   npx tsx scripts/drop-permit-fee-capture.ts --apply    do it
 *
 * Asked for: the firm does not record the permit fee on this step. Three things go, not one —
 * taking only the box out leaves a step nobody can finish:
 *
 *  1. THE CAPTURE `permitAmount` (a money capture, so the payer chips, the receipt number and the
 *     paid-on date go with it — they are parts of that one field, not separate questions).
 *  2. THE RULE `permitPaid eq "paid"` on the same node. `permitPaid` is not stored anywhere: the
 *     engine SYNTHESISES it from the money capture at completion (see workflow.ts, "A MONEY
 *     CAPTURE MUST ANSWER THE RULE THAT GUARDS IT"). With the capture gone nothing writes it, the
 *     rule can never hold, and the step refuses to complete for ever — which is precisely the
 *     failure that comment was written about the last time these two came apart.
 *  3. THE INSTRUCTION LINE, which tells the officer to record a fee that is no longer asked for.
 *
 * ACTIVE TASKS ONLY. A task snapshots its captures when it is created, so open ones keep asking
 * until they are re-pointed — that is what makes this worth a script. `done` and `skipped`
 * snapshots are left exactly as they are: they are the record of what that officer was asked, and
 * rewriting history to match today's form would be a lie about the past. Amounts already recorded
 * live on the run and in Disbursement rows, and neither is touched.
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const TEMPLATE = "Iqama Renewal";
const NODE = "permit";
const VAR = "permitAmount";
const RULE_VAR = "permitPaid";
const NEW_INSTRUCTIONS = "Choose the term and issue the work permit.";

(async () => {
  let changed = 0;

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  if (!tpl) console.log(`· no "${TEMPLATE}" template here`);
  else {
    const graph: any = tpl.graph ?? {};
    const node = (graph.nodes ?? []).find((n: any) => n?.id === NODE);
    if (!node) console.log(`· "${TEMPLATE}" has no node "${NODE}"`);
    else {
      const cfg = node.config ?? {};
      const caps: any[] = Array.isArray(cfg.captures) ? cfg.captures : [];
      const rules: any[] = Array.isArray(cfg.rules) ? cfg.rules : [];
      const keepCaps = caps.filter(c => c?.var !== VAR);
      const keepRules = rules.filter(r => String(r?.then?.var ?? "") !== RULE_VAR);
      const wantInstr = cfg.instructions !== NEW_INSTRUCTIONS;
      if (keepCaps.length === caps.length && keepRules.length === rules.length && !wantInstr) {
        console.log("· the template step no longer asks for the fee");
      } else {
        console.log(`${APPLY ? "FIXING" : "WOULD FIX"} the template step:`);
        if (keepCaps.length !== caps.length) console.log(`    capture ${VAR} removed`);
        if (keepRules.length !== rules.length) console.log(`    rule on ${RULE_VAR} removed (nothing would write it any more)`);
        if (wantInstr) console.log(`    instructions → "${NEW_INSTRUCTIONS}"`);
        if (APPLY) {
          node.config = { ...cfg, captures: keepCaps, rules: keepRules, instructions: NEW_INSTRUCTIONS };
          if (!keepRules.length) delete node.config.rules;
          await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph } });
          changed++;
        }
      }
    }
  }

  // ── open tasks still carrying the question ───────────────────────────────────────────────
  // A TASK SNAPSHOTS ITS INSTRUCTIONS TOO, which the first run of this script missed: twelve open
  // steps went on telling the officer to "record the fee" under a form that no longer asks for one.
  const open = (await prisma.workflowTask.findMany({
    where: { status: "active" }, select: { id: true, title: true, captures: true, instructions: true },
  })).filter(t => (Array.isArray(t.captures) ? (t.captures as any[]) : []).some(c => c?.var === VAR)
    || (t.title === "Issue Work Permit" && t.instructions !== NEW_INSTRUCTIONS));

  if (!open.length) console.log("· no open task still asks for it");
  else {
    console.log(`${APPLY ? "RE-POINTING" : "WOULD RE-POINT"} ${open.length} open task(s)`);
    if (APPLY) {
      for (const t of open) {
        await prisma.workflowTask.update({
          where: { id: t.id },
          data: {
            captures: (Array.isArray(t.captures) ? (t.captures as any[]) : []).filter(c => c?.var !== VAR),
            instructions: NEW_INSTRUCTIONS,
          },
        });
        changed++;
      }
    }
  }

  // Said out loud rather than assumed: a done step keeps the question it was asked.
  const kept = (await prisma.workflowTask.findMany({
    where: { status: { in: ["done", "skipped", "approved"] } }, select: { captures: true },
  })).filter(t => (Array.isArray(t.captures) ? (t.captures as any[]) : []).some(c => c?.var === VAR)).length;
  if (kept) console.log(`· ${kept} finished task(s) keep it — that is the record of what was asked`);

  console.log(APPLY ? `\nDone — ${changed} change(s).` : "\nNothing was changed. Re-run with --apply.");
  await prisma.$disconnect();
})().catch(async (e) => { console.error(String(e?.message ?? e)); await prisma.$disconnect(); process.exit(1); });
