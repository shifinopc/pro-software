/**
 * "Renewed Iqama attached", REMOVED FROM THE "Renew Iqama" STEP.
 *
 *   npx tsx scripts/drop-renewed-iqama-checklist.ts            say what it would do
 *   npx tsx scripts/drop-renewed-iqama-checklist.ts --apply    do it
 *
 * Asked for: the firm does not collect the renewed Iqama as a document on this step. The step keeps
 * its three answers (Iqama number, new Iqama expiry, new work permit expiry) — only the required
 * document goes.
 *
 * TWO PLACES, because one is not enough:
 *  1. THE TEMPLATE node `renew`, so new runs never ask for it.
 *  2. OPEN TASKS, which SNAPSHOT their checklist when they are created (workflow.ts, "Snapshot the
 *     effective checklist … so later template edits don't change in-flight runs"). Without this,
 *     every renewal already in flight keeps the box — and it is required, so those steps cannot be
 *     completed until someone ticks a document that is no longer collected.
 *
 * `checklistState` is left alone: if a file reference or a note was recorded against the item it
 * stays as the record of that, and nothing reads it once the item is gone (completion checks the
 * ITEMS, so an empty list is satisfied).
 *
 * FINISHED TASKS ARE NOT TOUCHED. Their snapshot is what that officer was actually asked for, and
 * rewriting it would be a lie about the past.
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const TEMPLATE = "Iqama Renewal";
const NODE = "renew";
const KEY = "renewed_iqama";

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
      const keep = (Array.isArray(cfg.checklist) ? cfg.checklist : []).filter((c: any) => c?.key !== KEY);
      if (keep.length === (Array.isArray(cfg.checklist) ? cfg.checklist.length : 0)) {
        console.log("· the template step no longer asks for it");
      } else {
        console.log(`${APPLY ? "FIXING" : "WOULD FIX"} the template step: checklist item ${KEY} removed`);
        if (APPLY) {
          node.config = { ...cfg, checklist: keep };
          if (!keep.length) delete node.config.checklist;
          await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph } });
          changed++;
        }
      }
    }
  }

  const open = (await prisma.workflowTask.findMany({
    where: { status: "active" }, select: { id: true, title: true, checklist: true },
  })).filter(t => (Array.isArray(t.checklist) ? (t.checklist as any[]) : []).some(c => c?.key === KEY));

  if (!open.length) console.log("· no open task still asks for it");
  else {
    console.log(`${APPLY ? "RE-POINTING" : "WOULD RE-POINT"} ${open.length} open task(s)`);
    if (APPLY) {
      for (const t of open) {
        await prisma.workflowTask.update({
          where: { id: t.id },
          data: { checklist: (t.checklist as any[]).filter(c => c?.key !== KEY) },
        });
        changed++;
      }
    }
  }

  const kept = (await prisma.workflowTask.findMany({
    where: { status: { in: ["done", "skipped", "approved"] } }, select: { checklist: true },
  })).filter(t => (Array.isArray(t.checklist) ? (t.checklist as any[]) : []).some(c => c?.key === KEY)).length;
  if (kept) console.log(`· ${kept} finished task(s) keep it — that is the record of what was asked`);

  console.log(APPLY ? `\nDone — ${changed} change(s).` : "\nNothing was changed. Re-run with --apply.");
  await prisma.$disconnect();
})().catch(async (e) => { console.error(String(e?.message ?? e)); await prisma.$disconnect(); process.exit(1); });
