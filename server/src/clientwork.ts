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
  /** Who it was for. Blank only on a row whose client has since been deleted. */
  companyId?: string | null;
  client?: string;
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
export async function clientWorkItems(opts: { from: string; to: string; companyId?: string | null }): Promise<ClientWorkItem[]> {
  const range = bounds(opts.from, opts.to);
  /**
   * `companyId` is OPTIONAL now — without it this is every client's work, which is what the
   * workbook's first sheet is. The counts answer "how much"; only the items answer "what", and the
   * export carried the counts alone: "Al-Ghamdi Group · 4 · 11 · 1 · 3" tells a reader nothing
   * they can take to the client it is about.
   */
  const scope = opts.companyId ? { companyId: opts.companyId } : { companyId: { not: null } };
  const tasks = await prisma.task.findMany({
    where: { ...scope, status: "done", completedAt: range },
    select: { title: true, completedAt: true, completedBy: true, companyId: true },
  });
  const steps = await prisma.workflowTask.findMany({
    where: {
      completedAt: range, status: { in: ["done", "approved"] },
      instance: opts.companyId ? { companyId: opts.companyId } : { companyId: { not: null } },
    },
    select: { title: true, completedAt: true, completedBy: true, instance: { select: { title: true, companyId: true, clientName: true } } },
  });
  // Named once, here, rather than per row: a lookup per item is a query per item.
  const ids = [...new Set([
    ...tasks.map(t => t.companyId).filter(Boolean) as string[],
    ...steps.map(s => s.instance?.companyId).filter(Boolean) as string[],
  ])];
  const named = ids.length
    ? await prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(named.map(c => [c.id, c.name]));

  return [
    ...tasks.map(t => ({
      kind: "task" as const, title: t.title, completedAt: t.completedAt!, by: t.completedBy ?? null, caseTitle: null,
      companyId: t.companyId ?? null, client: t.companyId ? (nameOf.get(t.companyId) ?? "(deleted client)") : "",
    })),
    ...steps.map(s => ({
      kind: "step" as const, title: s.title, completedAt: s.completedAt!, by: s.completedBy ?? null,
      caseTitle: s.instance?.title ?? null,
      companyId: s.instance?.companyId ?? null,
      client: s.instance?.companyId ? (nameOf.get(s.instance.companyId) ?? s.instance.clientName ?? "(deleted client)") : "",
    })),
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

/**
 * THE CLIENT-FACING REPORT: what changed in the period, and what is still open.
 *
 * The summary above counts work; this names it. A client reading "4 steps" learns nothing about
 * their own paperwork — what they want is "the Iqama that said 2026-11-01 now says 2027-12-01",
 * and, for anything unfinished, what it still says today.
 *
 * BEFORE comes from the run's own variables, not from history. A renewal run records
 * `currentNumber` and `currentExpiry` when it starts — the state of the document it was raised
 * about — so the before/after pair survives even when the new document is filed by hand without
 * retiring the old one, which is how most of them are filed today. AFTER is the document as it
 * stands now. They are equal while nothing has been replaced yet, and that is a true answer.
 */
export interface ReportLine {
  caseTitle: string;
  person: string | null;
  docType: string | null;
  beforeNumber: string | null;
  beforeExpiry: string | null;
  afterNumber: string | null;
  afterExpiry: string | null;
  /** Completed: when it finished. Pending: when the case started. */
  at: string | null;
  /** Completed: the steps closed in the period. Pending: the step it is sitting on. */
  detail: string;
}

const varsOf = (v: unknown): Record<string, any> => (v && typeof v === "object" ? v as any : {});
const str = (v: unknown) => { const s = String(v ?? "").trim(); return s || null; };

export async function clientReportDetail(opts: { from: string; to: string; companyId: string }) {
  const range = bounds(opts.from, opts.to);

  // Every run of this client's that either finished in the range or is still open. One query; the
  // two sections are the same rows split by status, so a case cannot appear in both or in neither.
  const runs = await prisma.workflowInstance.findMany({
    where: {
      companyId: opts.companyId,
      OR: [{ status: "completed", completedAt: range }, { status: { notIn: ["completed", "cancelled"] } }],
    },
    select: { id: true, title: true, status: true, variables: true, startedAt: true, completedAt: true },
  });

  // The documents those runs are about, read as they stand NOW — the "after" half of the pair.
  const docIds = runs.map(r => str(varsOf(r.variables).documentId)).filter(Boolean) as string[];
  const docs = docIds.length
    ? await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, docNumber: true, expiryDate: true } })
    : [];
  const docById = new Map(docs.map(d => [d.id, d]));

  // Steps: the ones closed in the period for the completed half, and whichever step is open now for
  // the pending half. Both in one pass, because a run needs only its own.
  const steps = await prisma.workflowTask.findMany({
    where: { instanceId: { in: runs.map(r => r.id) } },
    select: { instanceId: true, title: true, status: true, completedAt: true },
    orderBy: { completedAt: "asc" },
  });
  const byRun = new Map<string, typeof steps>();
  for (const s of steps) { const a = byRun.get(s.instanceId) ?? []; a.push(s); byRun.set(s.instanceId, a); }

  const lineOf = (r: typeof runs[number], detail: string, at: string | null): ReportLine => {
    const v = varsOf(r.variables);
    const d = str(v.documentId) ? docById.get(String(v.documentId)) : null;
    return {
      caseTitle: r.title, person: str(v.person), docType: str(v.docType),
      beforeNumber: str(v.currentNumber), beforeExpiry: str(v.currentExpiry),
      afterNumber: d ? str(d.docNumber) : null, afterExpiry: d ? str(d.expiryDate) : null,
      at, detail,
    };
  };

  const inRange = (iso: string | null | undefined) =>
    !!iso && String(iso) >= range.gte && String(iso) <= range.lte;

  const completed: ReportLine[] = [];
  const pending: ReportLine[] = [];
  for (const r of runs) {
    const mine = byRun.get(r.id) ?? [];
    if (r.status === "completed") {
      const done = mine.filter(s => ["done", "approved"].includes(String(s.status)) && inRange(s.completedAt));
      completed.push(lineOf(r, done.length ? done.map(s => s.title).join(", ") : "Case closed", r.completedAt ?? null));
      continue;
    }
    // STILL OPEN, BUT IT MAY HAVE MOVED IN THE PERIOD. A case that took three steps this month and
    // is not finished belongs in both halves: the client was told what was done, and what is left.
    const done = mine.filter(s => ["done", "approved"].includes(String(s.status)) && inRange(s.completedAt));
    if (done.length) completed.push(lineOf(r, done.map(s => s.title).join(", "), done[done.length - 1].completedAt ?? null));
    const waiting = mine.find(s => String(s.status) === "active");
    pending.push(lineOf(r, waiting ? "Waiting on: " + waiting.title : "Not started", r.startedAt ?? null));
  }

  const bySubject = (a: ReportLine, b: ReportLine) => (a.person ?? "").localeCompare(b.person ?? "") || a.caseTitle.localeCompare(b.caseTitle);
  return { completed: completed.sort(bySubject), pending: pending.sort(bySubject) };
}
