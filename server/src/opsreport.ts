/**
 * How the WORK is actually going — the operations half of Performance.
 *
 * There was a Performance screen and it was entirely about selling: won, lost, win rate, targets.
 * The officers running the government steps — the people the clients are actually paying for — had
 * nothing. Not throughput, not an SLA record, not even a view of who is carrying what.
 *
 * WHY IT COULD NOT HAVE BEEN BUILT BEFORE
 *
 * `WorkflowTask` has carried `completedBy`, `completedAt`, `slaHours` and `slaState` all along, but
 * the assignee was a DISPLAY NAME. Two officers called Ahmed were one string, and a rename orphaned
 * the row, so no figure attributed to a person could be trusted. `assigneeId` is what makes this
 * honest; everything here is grouped by it, never by name.
 *
 * WHAT THESE NUMBERS DELIBERATELY DO NOT CLAIM
 *
 * A completed step is not a unit of effort. A visa renewal and a document reprint both count one,
 * so a raw total flatters whoever handles volume and penalises whoever gets the hard cases. There is
 * no ranking here and no score: the rows come back in a stable order, the caller shows them as a
 * list of people rather than a league table, and the screen says so out loud. Measuring people with
 * a number they can game is how you get officers cherry-picking easy work.
 *
 * NOTHING IS STORED. Same rule as salesreport.ts — a figure written down is wrong by the next tick,
 * and keeping it true costs a write on every completion.
 */
import { prisma } from "./db.js";
import { periodRange, currentPeriod } from "./salesreport.js";

const DAY = 86400000;

export interface OfficerRow {
  userId: string;
  name: string;
  role: string;
  /** Steps they finished inside the period. */
  completed: number;
  /** Of those, how many were still inside their SLA when they finished. */
  onTime: number;
  /** …and how many had already breached. Null slaState means no SLA was set — counted separately. */
  late: number;
  noSla: number;
  /** Median, not mean: one step parked for three months would drag an average past usefulness. */
  medianDays: number | null;
  /** Steps still open on their desk right now — a fact about today, not about the period. */
  openNow: number;
  /** Of those, how many are already past their SLA. */
  openBreached: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export async function opsReport(opts: { period?: string; assigneeId?: string | null; assigneeIds?: string[] | null } = {}) {
  const period = opts.period || currentPeriod();
  const range = periodRange(period);
  if (!range) throw new Error(`"${period}" is not a period — use 2026-08 or 2026-Q3`);

  // FINISHED inside the period, not started inside it. A step opened in June and finished in August
  // belongs to August — the month somebody actually did the work and would be asked about.
  const doneWhere: any = { status: { in: ["done", "approved"] }, completedAt: { gte: range.from, lte: range.to } };
  const openWhere: any = { status: "active" };
  // One person, or a SET of people — a team is a set, and a lead's report is exactly their team's
  // rows. An empty array means "someone with visibility over nobody", which correctly returns an
  // empty report rather than everyone's.
  if (opts.assigneeId) { doneWhere.assigneeId = opts.assigneeId; openWhere.assigneeId = opts.assigneeId; }
  else if (opts.assigneeIds) { doneWhere.assigneeId = { in: opts.assigneeIds }; openWhere.assigneeId = { in: opts.assigneeIds }; }

  const [done, open] = await Promise.all([
    prisma.workflowTask.findMany({
      where: doneWhere,
      select: { assigneeId: true, createdAt: true, completedAt: true, slaState: true, slaHours: true, nodeType: true, title: true, instance: { select: { clientName: true } } },
      take: 5000,
    }),
    prisma.workflowTask.findMany({
      where: openWhere,
      select: { assigneeId: true, slaState: true, createdAt: true, title: true, assigneeRole: true },
      take: 5000,
    }),
  ]);

  // Everybody who appears on either side, resolved once. Includes people with open work and no
  // completions — leaving them out would show a busy officer as having done nothing.
  const ids = [...new Set([...done, ...open].map(t => t.assigneeId).filter(Boolean))] as string[];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, roleId: true } })
    : [];
  const byId = new Map(users.map(u => [u.id, u]));

  const rows: OfficerRow[] = users
    .map(u => {
      const mine = done.filter(t => t.assigneeId === u.id);
      const mineOpen = open.filter(t => t.assigneeId === u.id);
      const spans = mine
        .filter(t => t.createdAt && t.completedAt)
        .map(t => Math.max(0, Math.round((Date.parse(t.completedAt!) - Date.parse(t.createdAt!)) / DAY)));
      return {
        userId: u.id,
        name: u.name,
        role: u.roleId,
        completed: mine.length,
        onTime: mine.filter(t => t.slaHours != null && t.slaState !== "breached").length,
        late: mine.filter(t => t.slaState === "breached").length,
        noSla: mine.filter(t => t.slaHours == null).length,
        medianDays: median(spans),
        openNow: mineOpen.length,
        openBreached: mineOpen.filter(t => t.slaState === "breached").length,
      };
    })
    // Alphabetical, NOT by output. The order of a list of people is itself a claim, and sorting by
    // volume turns a workload view into a ranking nobody asked for.
    .sort((a, b) => a.name.localeCompare(b.name));

  // Work nobody has picked up. Deliberately its own figure rather than a row in the table: it is not
  // somebody's performance, it is the queue's.
  const unassigned = open.filter(t => !t.assigneeId);
  const unassignedByRole = new Map<string, number>();
  for (const t of unassigned) {
    const k = t.assigneeRole ?? "no role set";
    unassignedByRole.set(k, (unassignedByRole.get(k) ?? 0) + 1);
  }

  const allSpans = done
    .filter(t => t.createdAt && t.completedAt)
    .map(t => Math.max(0, Math.round((Date.parse(t.completedAt!) - Date.parse(t.createdAt!)) / DAY)));

  const withSla = done.filter(t => t.slaHours != null);
  const breached = done.filter(t => t.slaState === "breached");

  return {
    period, label: range.label, from: range.from, to: range.to,

    completed: done.length,
    /** How many of the completed steps had an SLA at all — the denominator for the rate below. */
    withSla: withSla.length,
    breached: breached.length,
    /**
     * Basis points, and NULL when no completed step had an SLA. "100% on time" out of nothing
     * measured is the kind of number that gets quoted in a meeting and cannot be defended.
     */
    onTimeRateBp: withSla.length ? Math.round(((withSla.length - breached.length) * 10000) / withSla.length) : null,

    medianDays: median(allSpans),
    /** The sample the median came from, so it is never read as covering steps it excluded. */
    medianSample: allSpans.length,

    openNow: open.length,
    openBreached: open.filter(t => t.slaState === "breached").length,
    unassigned: unassigned.length,
    unassignedByRole: [...unassignedByRole.entries()].map(([role, count]) => ({ role, count })).sort((a, b) => b.count - a.count),

    officers: rows,
    /** True when nobody has an id yet — an honest "this cannot be attributed" rather than an empty table. */
    unattributed: done.filter(t => !t.assigneeId).length,
  };
}

/** The months that have completed work in them, newest first, so the picker offers real choices. */
export async function opsPeriodsWithActivity(limit = 18) {
  const rows = await prisma.workflowTask.findMany({
    where: { completedAt: { not: null } },
    select: { completedAt: true },
    take: 5000,
  });
  const months = [...new Set(rows.map(r => String(r.completedAt).slice(0, 7)))].sort().reverse();
  const now = currentPeriod();
  return [...new Set([now, ...months])].slice(0, limit);
}
