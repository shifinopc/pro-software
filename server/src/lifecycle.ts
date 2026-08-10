/**
 * Lifecycle history: the record of what the RELATIONSHIP has been.
 *
 * The exact shape of StageTransition, one level up. The pipeline's history answers "how do deals
 * move"; this answers "how do companies move" — lead → prospect → client — which is a different
 * funnel with different owners (marketing and qualification rather than closing).
 *
 * Every writer that creates a company or changes its lifecycle records here: the staff form, the
 * web intake, the booking link, and the lifecycle route. Same rule as the stage table — a history
 * with one forgetful writer is confidently wrong, which is worse than absent.
 */
import { prisma } from "./db.js";

export async function recordLifecycle(db: any, args: {
  companyId: string;
  /** Null = the company entered the system in `to` — an arrival, not a change. */
  from?: string | null;
  to: string;
  changedById?: string | null;
  at: string;
  reason?: string | null;
}) {
  return db.lifecycleTransition.create({
    data: {
      companyId: args.companyId,
      fromLifecycle: args.from ?? null,
      toLifecycle: args.to,
      changedById: args.changedById ?? null,
      changedAt: args.at,
      reason: args.reason ?? null,
    },
  });
}

/**
 * What each marketing effort actually produced.
 *
 * Grouped over COMPANIES carrying a campaign, joined to their WON deals. Three figures per row and
 * all three named, because they answer different questions: how many leads the campaign brought in,
 * how many of those are clients today, and what their won deals came to. Revenue is won-deal value
 * — not invoices, not payments — because attribution is about what the campaign's companies signed
 * for, and the collected-vs-invoiced split already lives on the dashboard under its own names.
 */
export async function campaignPerformance(scope: { companyIds?: string[] | null } = {}) {
  const cos = await prisma.company.findMany({
    where: { campaign: { not: null }, ...(scope.companyIds ? { id: { in: scope.companyIds } } : {}) },
    select: { id: true, campaign: true, lifecycle: true },
  });
  if (!cos.length) return [];
  const wonStages = await prisma.pipelineStage.findMany({ where: { isWon: true }, select: { id: true } });
  const wonDeals = wonStages.length
    ? await prisma.opportunity.findMany({
        where: { companyId: { in: cos.map(c => c.id) }, stageId: { in: wonStages.map(s => s.id) } },
        select: { companyId: true, valueMinor: true },
      })
    : [];
  const byCompany = new Map<string, { count: number; minor: number }>();
  for (const d of wonDeals) {
    const cur = byCompany.get(d.companyId) ?? { count: 0, minor: 0 };
    byCompany.set(d.companyId, { count: cur.count + 1, minor: cur.minor + (d.valueMinor ?? 0) });
  }
  const rows = new Map<string, { companies: number; clients: number; won: number; wonMinor: number }>();
  for (const c of cos) {
    const k = String(c.campaign);
    const cur = rows.get(k) ?? { companies: 0, clients: 0, won: 0, wonMinor: 0 };
    const w = byCompany.get(c.id) ?? { count: 0, minor: 0 };
    rows.set(k, {
      companies: cur.companies + 1,
      clients: cur.clients + (c.lifecycle === "client" ? 1 : 0),
      won: cur.won + w.count,
      wonMinor: cur.wonMinor + w.minor,
    });
  }
  return [...rows.entries()]
    .map(([campaign, v]) => ({ campaign, ...v }))
    .sort((a, b) => b.wonMinor - a.wonMinor || b.companies - a.companies);
}

const DAY = 86_400_000;

/**
 * HOW LONG A LEAD HAS BEEN NEGLECTED — the one definition.
 *
 * A lead is in no pipeline column (no deal to go stale) and owes no follow-up (nobody promised
 * anything), so neither of the deal-facing alarms can see it. This is what catches it.
 *
 * Returns days idle, or NULL when the question does not apply — which is three distinct cases, all
 * of them "not neglected" rather than "fine":
 *   · already a client, or written off — nobody is meant to be chasing it
 *   · has a deal of any kind — even a lost one means a decision was reached
 *   · no date at all — predates the history, and nagging about day one of an unknown is noise
 *
 * PROSPECTS COUNT, not just leads. The hourly job has always chased both, and a prospect nobody has
 * opened a deal for is if anything the more neglected of the two — somebody said there was something
 * there and then stopped. Restricting this to `lead` would have quietly switched half that job off.
 *
 * Extracted because the hourly job and the Leads screen both need it. Written twice it would drift,
 * and a screen whose "Idle" tab disagrees with the notification people received is worse than no
 * tab: it teaches them the tab is wrong.
 */
export function idleDaysOf(
  lead: { lifecycle: string; deals: number; lastContactAt?: string | null; arrivedAt?: string | null; createdAt?: string | null },
  now: number = Date.now(),
): number | null {
  if (lead.lifecycle !== "lead" && lead.lifecycle !== "prospect") return null;
  if (lead.deals > 0) return null;
  // Measured from the last thing that HAPPENED, falling back to when it arrived. `createdAt` is the
  // last resort only — it means "client since" and is empty on most leads.
  const since = Date.parse(String(lead.lastContactAt ?? lead.arrivedAt ?? lead.createdAt ?? ""));
  if (!Number.isFinite(since)) return null;
  return Math.floor((now - since) / DAY);
}
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * The relationship funnel, and how fast companies move through it.
 *
 * Counts are CURRENT state (from Company), because "how many prospects do we have" is a question
 * about now. Durations are from the transitions, completed hops only, and each figure carries its
 * sample size — an average over two companies is an anecdote wearing a decimal point. `since` is
 * returned so the screen can say when the record began instead of presenting a week of history as
 * an eternal truth.
 */
export async function lifecycleAnalytics(scope: { companyIds?: string[] | null } = {}) {
  const coWhere = scope.companyIds ? { id: { in: scope.companyIds } } : {};
  const current = await prisma.company.groupBy({ by: ["lifecycle"], where: coWhere, _count: { _all: true } });
  const counts = new Map(current.map(c => [c.lifecycle, c._count._all]));

  const rows = await prisma.lifecycleTransition.findMany({
    where: scope.companyIds ? { companyId: { in: scope.companyIds } } : {},
    orderBy: [{ companyId: "asc" }, { changedAt: "asc" }],
    take: 20000,
  });

  // First time each company reached each state — repeat visits (reopened lost leads) do not reset
  // the clock, because "how long did it take" means the first time it happened.
  const firstAt = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const per = firstAt.get(r.companyId) ?? new Map<string, number>();
    if (!per.has(r.toLifecycle)) per.set(r.toLifecycle, Date.parse(r.changedAt));
    // An arrival row's FROM state never happened; only `to` states count as reached.
    firstAt.set(r.companyId, per);
  }

  const hop = (from: string, to: string) => {
    const xs: number[] = [];
    for (const per of firstAt.values()) {
      const a = per.get(from), b = per.get(to);
      if (a != null && b != null && b >= a) xs.push((b - a) / DAY);
    }
    return { avgDays: avg(xs), samples: xs.length };
  };

  return {
    funnel: ["lead", "prospect", "client"].map(s => ({ state: s, count: counts.get(s) ?? 0 })),
    lost: counts.get("lost") ?? 0,
    churned: counts.get("churned") ?? 0,
    conversion: {
      leadToProspect: hop("lead", "prospect"),
      prospectToClient: hop("prospect", "client"),
      leadToClient: hop("lead", "client"),
    },
    // Reduced, not rows[0] — the query orders by COMPANY first, so the first row is whichever
    // company sorts lowest, not whichever change came earliest.
    since: rows.length ? rows.reduce((m, r) => (r.changedAt < m ? r.changedAt : m), rows[0].changedAt).slice(0, 10) : null,
    recorded: rows.length,
  };
}
