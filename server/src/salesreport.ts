/**
 * How the selling is actually going.
 *
 * EVERYTHING HERE IS COUNTED WHEN ASKED
 *
 * Not a single figure below is stored. A win rate written down is wrong the moment the next deal
 * closes, and keeping it true would mean a write on every move — which is the bug this codebase
 * keeps finding, so it is not introduced for a number that costs one query.
 *
 * WHAT THE FIGURES REFUSE TO DO
 *
 * A deal with no value on it is counted in the COUNTS and excluded from the MONEY, and the excluded
 * number is reported alongside. The alternative — treating an unpriced deal as zero — quietly drags
 * every average down and makes a good quarter look mediocre, with nothing on screen to explain why.
 *
 * `won` and `lost` are read off the stage, never from a status column, so this report and the board
 * cannot disagree about what happened. See pipeline.ts.
 */
import { prisma } from "./db.js";
import { statusOf, withMoney } from "./pipeline.js";

/** "2026-08" → the first and last instant of that month; "2026-Q3" → of that quarter. */
export function periodRange(period: string): { from: string; to: string; label: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    const from = new Date(Date.UTC(y, mo - 1, 1)).toISOString();
    const to = new Date(Date.UTC(y, mo, 1) - 1).toISOString();
    return { from, to, label: new Date(from).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) };
  }
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q) {
    const y = Number(q[1]), qq = Number(q[2]);
    const from = new Date(Date.UTC(y, (qq - 1) * 3, 1)).toISOString();
    const to = new Date(Date.UTC(y, qq * 3, 1) - 1).toISOString();
    return { from, to, label: `Q${qq} ${y}` };
  }
  return null;
}

/** The period containing today, in month form — what the screen opens on. */
export const currentPeriod = () => new Date().toISOString().slice(0, 7);

type Ranked = { key: string; count: number; valueMinor: number };
const rank = (rows: Array<{ key: string | null; valueMinor: number | null }>): Ranked[] => {
  const m = new Map<string, Ranked>();
  for (const r of rows) {
    const key = String(r.key ?? "").trim() || "Not recorded";
    const cur = m.get(key) ?? { key, count: 0, valueMinor: 0 };
    cur.count++;
    cur.valueMinor += r.valueMinor ?? 0;
    m.set(key, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.valueMinor - a.valueMinor);
};

export async function salesReport(opts: { period?: string; ownerId?: string | null; ownerIds?: string[] | null; companyIds?: string[] | null; teamId?: string | null } = {}) {
  const period = opts.period || currentPeriod();
  const range = periodRange(period);
  if (!range) throw new Error(`"${period}" is not a period — use 2026-08 or 2026-Q3`);

  const where: any = {};
  if (opts.ownerId) where.ownerId = opts.ownerId;
  // A team's deals. Same shape as opsReport: an explicit empty set means an empty report, not the firm's.
  else if (opts.ownerIds) where.ownerId = { in: opts.ownerIds };
  if (opts.companyIds) where.companyId = { in: opts.companyIds };

  const all = await prisma.opportunity.findMany({
    where,
    include: { stage: true, company: { select: { id: true, name: true } } },
    take: 5000,
  });
  const resolved = await Promise.all(all.map(o => withMoney(o as any)));

  // CLOSED INSIDE THE PERIOD — not opened inside it. A deal that took four months to win belongs to
  // the month it was won, which is the month somebody is measured on.
  const closedIn = resolved.filter(o => o.closedAt && o.closedAt >= range.from && o.closedAt <= range.to);
  const won = closedIn.filter(o => o.status === "won");
  const lost = closedIn.filter(o => o.status === "lost");
  const open = resolved.filter(o => o.status === "open");

  const priced = (rows: typeof won) => rows.filter(o => o.valueMinor != null);
  const sum = (rows: typeof won) => rows.reduce((n, o) => n + (o.valueMinor ?? 0), 0);

  const wonValue = sum(won), lostValue = sum(lost);
  const decided = won.length + lost.length;
  const decidedValue = wonValue + lostValue;

  // Days from opening to closing, over the won deals that have both dates. Reported with its own
  // count so "18 days" is never read as covering deals it was not computed from.
  const spans = won
    .filter(o => o.createdAt && o.closedAt)
    .map(o => Math.max(0, Math.round((Date.parse(o.closedAt!) - Date.parse(o.createdAt!)) / 86400000)));

  // WHOSE target this report is measured against, and it follows whose report it is. A team lead
  // looking at their team is not being measured against the firm's number — that would show them a
  // bar they were never asked to fill — and not against their own, which is nil by design because a
  // lead carries no clients. Firm-wide only when the report is firm-wide.
  const targets = await prisma.salesTarget.findMany({ where: { period } });
  const target = (
    opts.ownerId ? targets.find(t => t.ownerId === opts.ownerId)
      : opts.teamId ? targets.find(t => t.teamId === opts.teamId)
        : targets.find(t => !t.ownerId && !t.teamId)
  ) ?? null;

  // Per-owner, resolved to names so the screen never has to hold a second copy of the user list.
  const ownerIds = [...new Set(closedIn.map(o => o.ownerId).filter(Boolean))] as string[];
  const users = ownerIds.length ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map(u => [u.id, u.name]));

  return {
    period, label: range.label, from: range.from, to: range.to,

    won: { count: won.length, valueMinor: wonValue, unpriced: won.length - priced(won).length },
    lost: { count: lost.length, valueMinor: lostValue, unpriced: lost.length - priced(lost).length },
    open: { count: open.length, valueMinor: sum(open), weightedMinor: open.reduce((n, o) => n + (o.weightedMinor ?? 0), 0) },

    // BOTH rates, because they answer different questions and routinely disagree: winning most of
    // the small ones and losing the big one is a good count and a bad quarter.
    winRateByCountBp: decided ? Math.round((won.length * 10000) / decided) : null,
    winRateByValueBp: decidedValue ? Math.round((wonValue * 10000) / decidedValue) : null,
    /** Null rather than zero when nothing closed — no deals decided is not a 0% win rate. */
    decided,

    averageWonMinor: priced(won).length ? Math.round(wonValue / priced(won).length) : null,
    averageDaysToWin: spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null,
    averageDaysSample: spans.length,

    lossReasons: rank(lost.map(o => ({ key: o.lostReason, valueMinor: o.valueMinor }))),
    sources: rank(closedIn.map(o => ({ key: o.source, valueMinor: o.valueMinor }))),
    byOwner: rank(closedIn.map(o => ({ key: o.ownerId ? (nameOf.get(o.ownerId) ?? "Unknown") : null, valueMinor: o.valueMinor })))
      .map(r => ({
        ...r,
        won: closedIn.filter(o => (o.ownerId ? (nameOf.get(o.ownerId) ?? "Unknown") : "Not recorded") === r.key && o.status === "won").length,
      })),

    target: target ? { amountMinor: target.amountMinor, currency: target.currency, note: target.note } : null,
    /** Null when no target is set. 0% against nothing is a made-up figure. */
    progressBp: target && target.amountMinor > 0 ? Math.round((wonValue * 10000) / target.amountMinor) : null,
  };
}

/** The periods that have anything in them, newest first — so the picker offers real choices. */
export async function periodsWithActivity(limit = 18) {
  const rows = await prisma.opportunity.findMany({ where: { closedAt: { not: null } }, select: { closedAt: true } });
  const months = [...new Set(rows.map(r => String(r.closedAt).slice(0, 7)))].sort().reverse();
  const now = currentPeriod();
  return [...new Set([now, ...months])].slice(0, limit);
}
