/**
 * WHAT WAS DONE FOR EACH CLIENT, BETWEEN TWO DATES.
 *
 * The firm bills by the month and is asked "what did you actually do for us?", and until now the
 * only answer was somebody opening the Tasks list and counting. The Performance screen measures
 * OFFICERS — throughput, SLA record, who is carrying what — which is the same data cut the other
 * way and no use at all when a client asks.
 *
 * TWO NUMBERS, NOT ONE. A task and a workflow step are not the same unit and adding them together
 * produces a figure that cannot survive a question: one Iqama renewal is a single task and eleven
 * steps, so a client with one renewal would otherwise look busier than a client with ten phone
 * calls, or less busy, depending which way you counted. They stay apart, and the third column —
 * cases closed — is the one a client actually recognises, because it is the thing they asked for.
 *
 * A MONTH IS A RANGE. Date-wise and month-wise are the same query, so only the range exists and
 * "this month" is a pair of dates the caller works out. There is no second code path to keep in
 * step with the first.
 *
 * NOTHING IS STORED. Same rule as the sales and ops reports: a number written down is wrong by the
 * next completion, and keeping it true would cost a write on every step anyone finishes.
 */
import { prisma } from "./db.js";

export interface ClientWorkRow {
  companyId: string;
  client: string;
  /** Task rows the client's work produced, finished inside the range. */
  tasks: number;
  /** Workflow steps finished inside the range — the government work, step by step. */
  steps: number;
  /** Runs that reached their end node inside the range. What the client calls "a job done". */
  casesClosed: number;
  /** Still open today. A fact about now, not about the range — said so in the column heading. */
  openNow: number;
}

export interface ClientWorkItem {
  kind: "task" | "step";
  title: string;
  completedAt: string;
  by: string | null;
  /** For a step: the case it belongs to, so a list of eleven steps reads as one renewal. */
  caseTitle: string | null;
}

/** ISO day bounds. `to` is inclusive, which is what a person means by "to the 30th". */
const bounds = (from: string, to: string) => ({ gte: `${from}T00:00:00.000Z`, lte: `${to}T23:59:59.999Z` });

/**
 * One row per client that did anything in the range.
 *
 * Clients with nothing are left out rather than listed as zero: a report with 188 rows of zero is
 * one nobody reads, and "we did nothing for you" is a conversation, not a line item.
 */
export async function clientWork(opts: { from: string; to: string; companyId?: string | null }): Promise<ClientWorkRow[]> {
  const { from, to, companyId } = opts;
  const range = bounds(from, to);
  const scope = companyId ? { companyId } : {};

  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const nameOf = new Map(companies.map(c => [c.id, c.name]));

  const tasks = await prisma.task.groupBy({
    by: ["companyId"],
    where: { ...scope, status: "done", completedAt: range, companyId: { not: null } },
    _count: true,
  });

  // Steps carry no companyId of their own — they hang off the run, which is what knows the client.
  const steps = await prisma.workflowTask.findMany({
    where: { completedAt: range, status: { in: ["done", "approved"] } },
    select: { instance: { select: { companyId: true } } },
  });
  const stepsBy = new Map<string, number>();
  for (const s of steps) {
    const id = s.instance?.companyId;
    if (!id || (companyId && id !== companyId)) continue;
    stepsBy.set(id, (stepsBy.get(id) ?? 0) + 1);
  }

  const closed = await prisma.workflowInstance.groupBy({
    by: ["companyId"],
    where: { ...scope, status: "completed", completedAt: range, companyId: { not: null } },
    _count: true,
  });

  const open = await prisma.workflowTask.findMany({
    where: { status: "active" },
    select: { instance: { select: { companyId: true } } },
  });
  const openBy = new Map<string, number>();
  for (const s of open) {
    const id = s.instance?.companyId;
    if (!id || (companyId && id !== companyId)) continue;
    openBy.set(id, (openBy.get(id) ?? 0) + 1);
  }

  const ids = new Set<string>([
    ...tasks.map(t => t.companyId as string),
    ...stepsBy.keys(),
    ...closed.map(c => c.companyId as string),
  ].filter(Boolean));

  const rows: ClientWorkRow[] = [...ids].map(id => ({
    companyId: id,
    client: nameOf.get(id) ?? "(deleted client)",
    tasks: tasks.find(t => t.companyId === id)?._count ?? 0,
    steps: stepsBy.get(id) ?? 0,
    casesClosed: closed.find(c => c.companyId === id)?._count ?? 0,
    openNow: openBy.get(id) ?? 0,
  }));

  // Busiest first, then by name so the order is stable between two runs of the same report.
  return rows.sort((a, b) => (b.tasks + b.steps) - (a.tasks + a.steps) || a.client.localeCompare(b.client));
}

/** The individual items behind one client's row — what to show when somebody asks "which ones?". */
export async function clientWorkItems(opts: { from: string; to: string; companyId: string }): Promise<ClientWorkItem[]> {
  const range = bounds(opts.from, opts.to);
  const tasks = await prisma.task.findMany({
    where: { companyId: opts.companyId, status: "done", completedAt: range },
    select: { title: true, completedAt: true, completedBy: true },
  });
  const steps = await prisma.workflowTask.findMany({
    where: { completedAt: range, status: { in: ["done", "approved"] }, instance: { companyId: opts.companyId } },
    select: { title: true, completedAt: true, completedBy: true, instance: { select: { title: true } } },
  });
  return [
    ...tasks.map(t => ({ kind: "task" as const, title: t.title, completedAt: t.completedAt!, by: t.completedBy ?? null, caseTitle: null })),
    ...steps.map(s => ({ kind: "step" as const, title: s.title, completedAt: s.completedAt!, by: s.completedBy ?? null, caseTitle: s.instance?.title ?? null })),
  ].sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
}

/**
 * The same month, written for the client rather than for the firm.
 *
 * Steps are grouped under their case: a client reading "Payment for Jawazat, Check Traffic
 * Violations, Renew Iqama…" sees a stranger's checklist, where "Iqama renewal — Ahmed: done" is
 * the thing they asked for. Standalone tasks are listed as themselves.
 */
export async function clientWorkSummary(opts: { from: string; to: string; companyId: string }) {
  const items = await clientWorkItems(opts);
  const byCase = new Map<string, { title: string; steps: number; last: string }>();
  const loose: ClientWorkItem[] = [];
  for (const i of items) {
    if (i.kind === "step" && i.caseTitle) {
      const cur = byCase.get(i.caseTitle) ?? { title: i.caseTitle, steps: 0, last: i.completedAt };
      cur.steps++;
      if (String(i.completedAt) > String(cur.last)) cur.last = i.completedAt;
      byCase.set(i.caseTitle, cur);
    } else loose.push(i);
  }
  const closed = await prisma.workflowInstance.findMany({
    where: { companyId: opts.companyId, status: "completed", completedAt: bounds(opts.from, opts.to) },
    select: { title: true, completedAt: true },
  });
  const done = new Set(closed.map(c => c.title));
  return {
    cases: [...byCase.values()].map(c => ({ ...c, finished: done.has(c.title) })).sort((a, b) => a.title.localeCompare(b.title)),
    tasks: loose.map(t => ({ title: t.title, completedAt: t.completedAt })),
    totals: { cases: byCase.size, casesClosed: closed.length, steps: items.filter(i => i.kind === "step").length, tasks: loose.length },
  };
}
