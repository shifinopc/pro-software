import { prisma } from "./db.js";
import { figuresForLines, planStages, sameMoment, type Stage } from "./stages.js";
import { nextNumber } from "./sequence.js";
import { businessToday } from "./dates.js";

/**
 * RAISING A PAYMENT STAGE AS AN INVOICE — the one copy of it.
 *
 * This lived inside index.ts, reachable only from the two HTTP routes that bill a stage by hand.
 * That was right while a stage fell due "when something happens in the real world that this
 * system is not the one to know about". A workflow step called "MISA licence approved" IS the
 * system knowing, so the engine has to be able to raise the same bill the same way — and a second
 * implementation of a tax invoice is the last thing this codebase needs.
 */
const nextInvoiceNumber = () => nextNumber("invoice");
/**
 * WHICH STAGES AN INVOICE COVERS. One normally, several when it billed a whole moment.
 *
 * Its own function because three readers ask it — the schedule view, the refusal that stops a
 * stage being billed twice, and the "is this the last one" test — and a merged invoice that one of
 * them failed to understand would let the same stage be invoiced again.
 */
export const coveredStages = (inv: { milestoneIndex: number | null; milestoneIndexes?: any }): number[] => {
  const many = Array.isArray(inv.milestoneIndexes) ? inv.milestoneIndexes.map(Number).filter(Number.isInteger) : [];
  if (many.length) return many;
  return inv.milestoneIndex == null ? [] : [inv.milestoneIndex];
};

/**
 * ONE BILL PER PAYMENT MOMENT, not per stage.
 *
 * A stage is one percentage of one fee kind, because that is what lets stage 4 carry no VAT while
 * stage 3 carries 15% — the government fee is outside scope and the professional fee is not. But
 * "50% on signing" of a quotation carrying both is TWO stages and ONE moment, and the client was
 * getting two invoices for it on the same day, then two more when the licence came through.
 *
 * So the stages sharing a label are raised as one invoice. Their lines are concatenated, so each
 * line still carries its own fee kind and VAT treatment and the tax stays right per line; the
 * invoice records every index it covers.
 */
export async function raiseStageInvoice(q: any, group: Stage[], opts: { date?: string; isLast?: boolean } = {}) {
  const stage = group[0];
  const lines = group.flatMap(st => st.lines);
  const figures = await figuresForLines(lines, Number(q.vatRateBp ?? 0) || 0);
  /**
   * THE LAST STAGE TAKES THE REMAINDER OF THE TAX.
   *
   * The NET already foots: planStages gives the final stage of each fee what is left rather than
   * its percentage, because 50/30/20 of a figure ending in an odd halala leaves the client short or
   * over for ever. The TAX had no such rule. Each stage rounds its own VAT and the quotation rounds
   * once over the whole taxable base, so five roundings against one drifted — measured on QT-001-R1:
   * stages 9,825.57 against a quotation saying 9,825.56, one halala the client never agreed to.
   *
   * So the stage that COMPLETES the schedule is charged the difference between the quotation's VAT
   * and what the other invoices actually carry. Read from the invoices rather than recomputed,
   * because what they carry is what the client was asked for — and a void one is not a bill, so it
   * does not count.
   *
   * Only when the quotation stored a VAT figure of its own. An older row that never did has nothing
   * to reconcile against, and inventing a target would be worse than the halala.
   */
  let vatMinor = figures.vatMinor;
  if (opts.isLast && q.vatMinor != null) {
    const others = await prisma.invoice.aggregate({
      where: { quotationId: q.id, NOT: { status: "void" } },
      _sum: { vatMinor: true },
    });
    const left = Number(q.vatMinor) - (others._sum.vatMinor ?? 0);
    // Never negative, and never a correction so large it is hiding a different problem: a stage
    // whose own VAT and the remainder disagree by more than a rounding is not a rounding.
    if (left >= 0 && Math.abs(left - figures.vatMinor) <= 100) vatMinor = left;
  }
  const totalMinor = figures.subtotalMinor + vatMinor;
  const number = await nextInvoiceNumber();
  const today = opts.date ?? businessToday();
  // What the client reads on the bill: the stage's own wording, and the fee it is a share of.
  // The three shipped kinds have keys older than the column that holds them, so they are named;
  // a kind the firm typed itself IS the word they want and is used as it stands. Same map as the
  // proposal's, because the schedule on the document and the label on the invoice raised from it
  // must not call the same fee two different things.
  const FEE_WORD: Record<string, string> = { prof: "Professional Fees", gov: "Government Fees", foreign: "Foreign Company Fees" };
  // Every share this bill is made of — "100% of Foreign Company Fees · 50% of Professional Fees"
  // — so a merged invoice says what it merged rather than naming only its first stage.
  const shares = group
    .map(st => (st.pct && st.basis && st.basis !== "total" ? `${st.pct}% of ${FEE_WORD[st.basis] ?? st.basis}` : ""))
    .filter(Boolean);
  const ofLabel = shares.join(" · ");
  const services = [q.service, stage.label || `Stage ${stage.index + 1}`].filter(Boolean).join(" — ");
  return prisma.invoice.create({
    data: {
      number, companyId: q.companyId, clientName: q.clientName,
      subtotalMinor: figures.subtotalMinor, vatMinor,
      totalMinor, vatRateBp: figures.vatRateBp,
      amount: Math.round(totalMinor / 100),
      status: "draft", date: today,
      services, items: lines as any, notes: q.notes ?? null,
      quotationId: q.id,
      // The first of the group, so every reader that only ever asked "which stage is this" still
      // gets an answer; the full set is beside it.
      milestoneIndex: stage.index,
      milestoneIndexes: group.length > 1 ? (group.map(st => st.index) as any) : undefined,
      milestoneLabel: [stage.label, ofLabel].filter(Boolean).join(" · ") || null,
    },
  });
}
/**
 * EVERY STAGE DUE AT ONE MOMENT, BILLED — asked for by name rather than by index.
 *
 * The routes bill "the next one"; a workflow bills "the one the terms tie to this event", and it
 * knows the event in the firm s own words: "Upon approval of the MISA Licence". Matched the same
 * way the routes group a moment, so a stage spelling out which fee it is joins the bare one.
 *
 * IDEMPOTENT, because a step can be completed twice and a run can be re-driven: a moment already
 * invoiced returns what is there and raises nothing. A voided invoice does not count, which is
 * the same rule the schedule view follows.
 */
export async function raiseMomentInvoice(quotationId: string, moment: string) {
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return { raised: null as any, reason: "no quotation" };
  const totalMinor = q.totalMinor != null ? Number(q.totalMinor) : Math.round((Number(q.amount) || 0) * 100);
  const stages = planStages((q.items as any) ?? [], (q.milestones as any) ?? [], totalMinor);
  if (!stages.length) return { raised: null as any, reason: `${q.number} has no payment schedule` };
  const raised = await prisma.invoice.findMany({
    where: { quotationId: q.id, status: { not: "void" } },
    select: { number: true, milestoneIndex: true, milestoneIndexes: true },
  });
  if (raised.some(i => i.milestoneIndex == null)) return { raised: null as any, reason: `${q.number} was invoiced in full` };
  const done = new Set<number>(raised.flatMap(i => coveredStages(i as any)));
  /**
   * `*` MEANS WHATEVER IS LEFT.
   *
   * The last step of a setup does not bill a named moment — it bills the balance, whatever stages
   * the schedule still has outstanding. Naming the final moment would work until a quotation
   * worded it differently, and then the run would finish with money unbilled and nothing saying
   * so. "Everything not yet invoiced" is the fact the step actually knows.
   */
  const everything = String(moment).trim() === "*";
  const group = stages.filter(st => st.subtotalMinor > 0 && (everything || sameMoment(st.label, moment)));
  if (!group.length) return { raised: null as any, reason: everything ? "nothing left to bill" : `no billable stage reads "${moment}"` };
  const left = group.filter(st => !done.has(st.index));
  if (!left.length) return { raised: null as any, reason: "already invoiced" };
  const inGroup = new Set(left.map(st => st.index));
  const isLast = !stages.some(st => !inGroup.has(st.index) && !done.has(st.index) && st.subtotalMinor > 0);
  const invoice = await raiseStageInvoice(q, left, { isLast });
  return { raised: invoice, reason: null as any, quotation: q.number, stages: left.map(st => st.index) };
}
