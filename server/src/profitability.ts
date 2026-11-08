/**
 * WHICH CLIENTS MAKE MONEY — the question a services firm cannot answer from its invoices alone.
 *
 * Revenue was already knowable: invoices and subscriptions. Pass-through cost was already knowable:
 * government fees on the service, and disbursements the firm fronted. The variable nobody had was
 * what the firm's own time costs, so every margin was really "price minus the bits we happened to
 * record", and a client consuming three times the effort they pay for looked exactly like a good one.
 *
 * STANDARD COSTING, NOT TIMESHEETS. The officers this measures are at government counters, not at
 * desks; a timer they must remember to start is a timer that gets started sometimes, and partial
 * logging is worse than none because the gaps make a client look MORE profitable. So effort is
 * declared once per workflow step (and per service, as a fallback) and multiplied by what the person
 * who completed it costs. Nobody enters anything. It works against history already recorded, because
 * `completedBy` and `completedAt` have been on every step all along.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM:
 *   · Ad-hoc Tasks have an assignee but no service, so their effort is invisible and their cost
 *     reads as zero. That understates cost, which is the safer direction, and `uncostedTasks` says
 *     how many so the number is never mistaken for complete.
 *   · A step whose node declares no effort is UNCOSTED, not free — counted in `uncostedSteps`.
 *   · A person with no `costPerHourMinor` is UNCOSTED, not free — counted in `uncostedPeople`.
 *     Null is not zero; see the field's own note in schema.prisma.
 *
 * A report that quietly treats unknowns as zeroes is how a firm concludes it is more profitable than
 * it is, so every figure here arrives with the count of what it could not see.
 *
 * INTERNAL. `costPerHourMinor` never leaves this module — the caller gets money, not salaries — and
 * nothing here is reachable from the portal.
 */
import { prisma } from "./db.js";

/** All money in MINOR units, matching money.ts. Effort in whole minutes. */
export type ClientMargin = {
  companyId: string;
  name: string;
  revenueMinor: number;        // invoiced + recurring
  passThroughMinor: number;    // government fees + disbursements the firm fronted
  labourMinor: number;         // costed effort x the rate of whoever did it
  marginMinor: number;         // what is left
  marginPct: number | null;    // null when there is no revenue to be a percentage of
  effortMinutes: number;
  uncostedSteps: number;       // completed steps whose node declares no effort
  uncostedPeople: number;      // completed steps done by someone with no rate
  uncostedTasks: number;       // ad-hoc tasks, which carry no service and so no effort
};

const ROUND = (n: number) => Math.round(n);

export async function clientMargins(opts: { from?: string; to?: string } = {}): Promise<ClientMargin[]> {
  const { from, to } = opts;
  const within = (iso: string | null | undefined) =>
    !!iso && (!from || iso >= from) && (!to || iso <= to);

  const [companies, invoices, subs, disbursements, steps, people, services] = await Promise.all([
    prisma.company.findMany({ select: { id: true, name: true } }),
    prisma.invoice.findMany({ select: { companyId: true, status: true, totalMinor: true, amount: true, date: true } }),
    prisma.subscription.findMany({ select: { companyId: true, price: true, endDate: true } }),
    // `at` (recorded) is required; `paidAt` (actually paid) is nullable. Filtering a period on
    // paidAt alone silently drops every row where nobody filled it in — real money, invisible.
    prisma.disbursement.findMany({ select: { companyId: true, amountMinor: true, payer: true, recharge: true, paidAt: true, at: true } }),
    // The client and the template both live on the INSTANCE, not on the step — a step knows which
    // node it is, not which service it belongs to.
    prisma.workflowTask.findMany({
      where: { status: { in: ["done", "approved"] } },
      select: {
        completedBy: true, completedAt: true, effortMinutes: true,
        instance: { select: { companyId: true, templateId: true } },
      },
    }),
    prisma.user.findMany({ select: { id: true, email: true, costPerHourMinor: true } }),
    prisma.serviceItem.findMany({ select: { workflowId: true, govFee: true, effortMinutes: true } }),
  ]);

  // `completedBy` is an email or an id depending on how old the row is, so both are indexed rather
  // than assuming — an unmatched person would otherwise silently become an uncosted one.
  const rateOf = new Map<string, number | null>();
  for (const u of people) { rateOf.set(u.id, u.costPerHourMinor); if (u.email) rateOf.set(u.email, u.costPerHourMinor); }

  // A service is bound to a workflow template, which is how a completed step knows what it cost the
  // firm in government fees and what effort it was supposed to take.
  const svcByTemplate = new Map<string, { govFee: number; effortMinutes: number }>();
  for (const s of services) if (s.workflowId) svcByTemplate.set(s.workflowId, { govFee: s.govFee, effortMinutes: s.effortMinutes });

  const blank = (): Omit<ClientMargin, "companyId" | "name" | "marginMinor" | "marginPct"> => ({
    revenueMinor: 0, passThroughMinor: 0, labourMinor: 0, effortMinutes: 0,
    uncostedSteps: 0, uncostedPeople: 0, uncostedTasks: 0,
  });
  const acc = new Map<string, ReturnType<typeof blank>>();
  const bucket = (id: string | null | undefined) => {
    if (!id) return null;
    let b = acc.get(id); if (!b) acc.set(id, b = blank());
    return b;
  };

  // ── revenue ──────────────────────────────────────────────────────────────────────────────────
  // Draft and void invoices are not revenue; a draft is a document somebody is still writing.
  for (const v of invoices) {
    const st = String(v.status ?? "").toLowerCase();
    if (st === "draft" || st === "void") continue;
    if ((from || to) && !within(v.date)) continue;
    const b = bucket(v.companyId); if (!b) continue;
    b.revenueMinor += v.totalMinor ?? (v.amount ?? 0) * 100;
  }
  // Recurring revenue is a rate, not an event, so it is only counted when no period is asked for —
  // apportioning a monthly price across an arbitrary range would be inventing invoices.
  //
  // A Subscription has no status column: what it has is an end date. One that has already ended is
  // not current revenue, and one with no end date runs until somebody ends it.
  if (!from && !to) {
    const today = new Date().toISOString().slice(0, 10);
    for (const s of subs) {
      if (s.endDate && s.endDate.slice(0, 10) < today) continue;
      const b = bucket(s.companyId); if (!b) continue;
      b.revenueMinor += (s.price ?? 0) * 100;
    }
  }

  // ── pass-through: what the firm paid out on the client's behalf ──────────────────────────────
  // A fee the CLIENT paid directly never cost the firm anything, and one the firm chose to absorb
  // (recharge off) is a cost it keeps. Both are excluded from what is billed on, included in cost.
  for (const d of disbursements) {
    if (d.payer === "client") continue;
    if ((from || to) && !within(d.paidAt ?? d.at)) continue;
    const b = bucket(d.companyId); if (!b) continue;
    b.passThroughMinor += d.amountMinor ?? 0;
  }

  // ── labour, and the government fee the step implies ──────────────────────────────────────────
  for (const t of steps) {
    if ((from || to) && !within(t.completedAt)) continue;
    const b = bucket(t.instance?.companyId); if (!b) continue;

    const svc = t.instance?.templateId ? svcByTemplate.get(t.instance.templateId) : undefined;
    if (svc?.govFee) b.passThroughMinor += svc.govFee * 100;

    // The step's own snapshot first; the service's figure only as a fallback, because a service
    // total spread over an unknown number of steps would be counted once per step.
    const minutes = t.effortMinutes ?? null;
    if (minutes == null) { b.uncostedSteps++; continue; }
    b.effortMinutes += minutes;

    const rate = t.completedBy ? rateOf.get(t.completedBy) ?? null : null;
    if (rate == null) { b.uncostedPeople++; continue; }
    b.labourMinor += ROUND((minutes / 60) * rate);
  }

  // Ad-hoc tasks carry no service and so no effort. Counted, never costed — see the note at the top.
  const adhoc = await prisma.task.groupBy({
    by: ["companyId"],
    where: { status: { in: ["done", "completed"] } },
    _count: { _all: true },
  }).catch(() => [] as { companyId: string | null; _count: { _all: number } }[]);
  for (const row of adhoc) { const b = bucket(row.companyId); if (b) b.uncostedTasks += row._count._all; }

  const nameOf = new Map(companies.map(c => [c.id, c.name]));
  return [...acc.entries()]
    .map(([companyId, b]) => {
      const marginMinor = b.revenueMinor - b.passThroughMinor - b.labourMinor;
      return {
        companyId, name: nameOf.get(companyId) ?? "(deleted client)",
        ...b, marginMinor,
        marginPct: b.revenueMinor > 0 ? Math.round((marginMinor / b.revenueMinor) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => a.marginMinor - b.marginMinor);   // worst first — that is the list worth reading
}
