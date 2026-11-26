/**
 * A GATE THAT OPENS WHEN THE MONEY ARRIVES.
 *
 * "G0 — Finance confirms the advance" waits for a person to say the 50% is in the bank. Once the
 * approver can SEE the figures (see /tasks/:id/money) the next question answers itself: when the
 * receipt that settles that stage invoice is recorded, there is nothing left for the gate to
 * establish. Leaving it open is a step whose only remaining content is somebody noticing.
 *
 * ON THE PAYMENT, NOT ON A TIMER. The trigger is the receipt being recorded, so there is no window
 * in which the advance is paid and the work is still blocked, and no job scanning for something
 * that may never happen.
 *
 * ONLY A NODE THAT ASKS FOR IT. A template marks the step `requiresAdvance: true`; every other
 * approval is untouched. An approval is somebody's signature, and turning all of them into
 * arithmetic because one of them could be is how a review board becomes a rubber stamp.
 *
 * ONLY WHEN IT IS COVERED IN FULL. A short payment leaves the gate open: "close enough" is a
 * decision with a name on it, and the approver has the shortfall on screen to make it with.
 *
 * Never throws. A payment must not fail to record because the workflow bookkeeping did — the money
 * has arrived either way, and the gate staying shut is the safe failure.
 */
import { prisma } from "./db.js";
import { completeTask } from "./workflow.js";

export type GateRelease = { taskId: string; title: string; instanceId: string; note: string };

export async function releaseAdvanceGates(invoiceId: string, receiptNumber?: string | null, when?: string | null): Promise<GateRelease[]> {
  const out: GateRelease[] = [];
  try {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, number: true, quotationId: true, totalMinor: true, amount: true },
    });
    // A gate belongs to a case, and a case is reached from the quotation. An invoice raised outside
    // that chain — an ad-hoc bill — has no gate to open, which is not a failure.
    if (!inv?.quotationId) return out;

    // Is THIS invoice covered? The gate is about this stage, not the client's account.
    const dueMinor = inv.totalMinor ?? Math.round((Number(inv.amount) || 0) * 100);
    const got = await prisma.payment.aggregate({
      where: { invoiceId: inv.id },
      _sum: { amountMinor: true, amount: true },
    });
    const receivedMinor = got._sum.amountMinor ?? (got._sum.amount ?? 0) * 100;
    if (receivedMinor < dueMinor) return out;

    // The cases this quotation opened. Found through Task.quotationId rather than by querying the
    // instance's JSON variables, which MySQL cannot index — same link delivery wrote.
    const links = await prisma.task.findMany({
      where: { quotationId: inv.quotationId, NOT: { workflowInstanceId: null } },
      select: { workflowInstanceId: true },
    });
    const instanceIds = [...new Set(links.map(l => l.workflowInstanceId!).filter(Boolean))];
    if (!instanceIds.length) return out;

    const waiting = await prisma.workflowTask.findMany({
      where: { instanceId: { in: instanceIds }, nodeType: "approval", status: "active" },
      select: { id: true, title: true, instanceId: true, nodeId: true },
    });
    if (!waiting.length) return out;

    // Which of them asked to be settled by money. Read from the template the case is running, so a
    // firm decides this per step rather than it being true of every approval everywhere.
    const insts = await prisma.workflowInstance.findMany({
      where: { id: { in: instanceIds } },
      select: { id: true, templateId: true },
    });
    const tpls = await prisma.workflowTemplate.findMany({
      where: { id: { in: [...new Set(insts.map(i => i.templateId).filter(Boolean) as string[])] } },
    });
    const graphOf = new Map(tpls.map(t => [t.id, (t as any).graph ?? null]));
    const tplOfInstance = new Map(insts.map(i => [i.id, i.templateId]));

    const asks = (instanceId: string, nodeId: string | null) => {
      if (!nodeId) return false;
      const g: any = graphOf.get(String(tplOfInstance.get(instanceId) ?? ""));
      const node = (g?.nodes ?? []).find((n: any) => String(n?.id) === String(nodeId));
      return node?.requiresAdvance === true;
    };

    for (const t of waiting) {
      if (!asks(t.instanceId, t.nodeId)) continue;
      const note = `Settled by ${receiptNumber ?? "a receipt"}${when ? ` on ${when}` : ""} — ${inv.number} paid in full. Approved automatically.`;
      await completeTask(t.id, {
        // Named as the rule, not as whoever happened to key the receipt in: nobody signed this.
        actor: "Finance (automatic)",
        outcome: "approve",
        variables: { decisionNote: note },
      });
      out.push({ taskId: t.id, title: t.title, instanceId: t.instanceId, note });
    }
    return out;
  } catch (e) {
    console.error("[advance-gate] could not release gates for invoice", invoiceId, (e as any)?.message ?? e);
    return out;
  }
}
