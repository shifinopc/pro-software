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
import { dmy } from "./dates.js";

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

/**
 * The client's copy, as it is printed.
 *
 * TWO THINGS HERE ARE NOT STYLE CHOICES.
 *
 * 1. THE BODY MUST START WITH A TABLE. LibreOffice's HTML import swallows the first block element
 *    of the body and replaces it with a page break, so a document that opened with `<h1>Firm</h1>`
 *    printed a blank first page and no firm name at all - which is exactly what shipped. Starting
 *    with the letterhead table costs nothing and converts correctly. Measured in the live image: a
 *    body opening with <p> or <div> gives 2 pages with the first element gone, one opening with
 *    <table> gives 1 page with everything on it.
 * 2. NOTHING IS INVENTED. A blank letterhead field prints blank. Name, address, VAT, CR, phone,
 *    email and logo all come from Settings -> General, and a report carrying a company name or tax
 *    number nobody configured is worse than a gap someone notices.
 */
export function clientReportHtml(a: {
  org: any; client: string; from: string; to: string;
  S: { totals: { cases: number; casesClosed: number; steps: number; tasks: number } };
  D: { completed: ReportLine[]; pending: ReportLine[] };
  esc: (v: unknown) => string;
  /** A ready <img> tag, or "" - index.ts reads the file, this file does not know the uploads folder. */
  logoImg: string;
}): string {
  const { org, esc, logoImg } = a;
  const firm = String(org.legalName ?? org.orgName ?? "").trim();
  const idLines = [
    String(org.address ?? "").trim(),
    [org.vatNumber || org.vat ? "VAT " + (org.vatNumber || org.vat) : "",
     org.crNumber || org.cr ? "CR " + (org.crNumber || org.cr) : ""].filter(Boolean).join("  ·  "),
    [String(org.phone ?? "").trim(), String(org.email ?? "").trim()].filter(Boolean).join("  ·  "),
  ].filter(Boolean);

  const day = (v: string | null) => (v ? dmy(String(v).slice(0, 10)) : "—");
  const pair = (n: string | null, e: string | null) =>
    [n, e ? dmy(String(e).slice(0, 10)) : ""].filter(Boolean).join("  ·  ") || "—";

  // LibreOffice's HTML import understands table attributes and simple inline styles, and ignores
  // most of a stylesheet's layout. So the banding, the widths and the rules are written on the
  // elements themselves - a class that only works in a browser is a document that prints plain.
  const row = (i: number, cells: string[]) =>
    `<tr${i % 2 ? ' bgcolor="#FAF8FE"' : ""}>${cells.join("")}</tr>`;
  // `ink` goes on a span INSIDE the cell: LibreOffice ignores colour and weight written on a <td>.
  const td = (v: unknown, ink = "", right = false) =>
    `<td${right ? ' align="right"' : ""} style="padding:2.6mm 3mm; border-bottom:.5pt solid #E4E0EE;">`
    + (ink ? `<span style="${ink}">${esc(v)}</span>` : esc(v)) + "</td>";
  const head = (cols: [string, string][]) => `<tr bgcolor="#26074D">${cols.map(([t, w]) =>
    `<th width="${w}" style="padding:2.4mm 3mm; text-align:left; font-size:7.5pt; color:#FFFFFF;">${esc(t)}</th>`).join("")}</tr>`;
  const title = (text: string) => `<table width="100%" cellspacing="0" cellpadding="0"><tr><td `
    + `style="padding:6mm 0 1.8mm; font-size:8pt; font-weight:bold; letter-spacing:.09em; color:#6F6C7A;">${esc(text)}</td></tr></table>`;
  const empty = (n: number, text: string) =>
    `<tr><td colspan="${n}" style="padding:3mm; color:#6F6C7A; font-size:8.5pt;">${esc(text)}</td></tr>`;

  const doneRows = a.D.completed.map((l, i) => row(i, [
    td(l.person ?? l.caseTitle, "font-weight:bold;"),
    td(l.docType ?? "—"),
    td(pair(l.beforeNumber, l.beforeExpiry)),
    td(pair(l.afterNumber, l.afterExpiry), "color:#0E9355; font-weight:bold;"),
    td(l.detail),
    td(day(l.at), "", true),
  ])).join("") || empty(6, "Nothing was completed in this period.");

  const pendRows = a.D.pending.map((l, i) => row(i, [
    td(l.person ?? l.caseTitle, "font-weight:bold;"),
    td(l.docType ?? "—"),
    td(pair(l.beforeNumber, l.beforeExpiry)),
    td(l.detail, "color:#B8860B;"),
    td(day(l.at), "", true),
  ])).join("") || empty(5, "Nothing is open for this client.");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(a.client)}</title><style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: Arial, sans-serif; color: #1A1523; font-size: 9pt; }
    table { width: 100%; border-collapse: collapse; }
    p { margin: 0; }
  </style></head><body>
    <table width="100%" cellspacing="0" cellpadding="0">
      ${logoImg ? `<tr><td align="center" style="padding-bottom:2mm;">${logoImg}</td></tr>` : ""}
      <tr><td align="center"><p style="font-size:15pt; font-weight:bold; color:#26074D;">${esc(firm)}</p></td></tr>
      ${idLines.length
        ? idLines.map(l => `<tr><td align="center"><p style="font-size:8.5pt; color:#4B4757; padding-top:1mm;">${esc(l)}</p></td></tr>`).join("")
        : (firm ? "" : `<tr><td align="center"><p style="font-size:8.5pt; color:#B8860B; padding-top:1mm;">Add your letterhead in Settings &rarr; General</p></td></tr>`)}
      <tr><td align="center" style="padding-top:4mm; border-bottom:1.5pt solid #26074D;">
        <p style="font-size:7.5pt; letter-spacing:.1em; color:#6F6C7A;">CLIENT WORK REPORT</p>
        <p style="font-size:12pt; font-weight:bold; padding-top:1.5mm;">${esc(a.client)}</p>
        <p style="font-size:8.5pt; color:#4B4757; padding:1mm 0 3.5mm;">${esc(dmy(a.from))} to ${esc(dmy(a.to))}</p>
      </td></tr>
    </table>

    ${title("COMPLETED IN THIS PERIOD")}
    <table width="100%" cellspacing="0" cellpadding="0">
      ${head([["Who", "22%"], ["Document", "9%"], ["Before", "15%"], ["After", "15%"], ["Work done", "29%"], ["Done", "10%"]])}
      ${doneRows}
    </table>

    ${title("STILL PENDING")}
    <table width="100%" cellspacing="0" cellpadding="0">
      ${head([["Who", "26%"], ["Document", "10%"], ["On file now", "20%"], ["Waiting on", "32%"], ["Since", "12%"]])}
      ${pendRows}
    </table>

    <p style="color:#6F6C7A; font-size:8pt; padding-top:5mm;">${a.S.totals.cases} case(s) &middot; ${a.S.totals.casesClosed} completed &middot; ${a.S.totals.steps} steps closed &middot; ${a.S.totals.tasks} separate tasks</p>
  </body></html>`;
}
