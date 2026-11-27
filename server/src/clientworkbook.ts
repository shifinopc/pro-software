import type { ClientWorkRow, ClientWorkItem } from "./clientwork.js";
import { INK, sheetTitle, sheetHeader, sheetZebra, sheetNotes } from "./reportstyle.js";

/**
 * WHAT WAS DONE FOR EACH CLIENT — the work first, the counts second.
 *
 * The export was five numbers a client: tasks, steps, cases closed, open now. The firm is asked
 * "what did you actually do for us?" and that file cannot answer it — "Al-Ghamdi Group · 4 · 11 ·
 * 1 · 3" is a receipt, the same shape the lead report was in before it was rebuilt.
 *
 * Sheet 1 is every completed item, one row each: which client, what it was, which case it belongs
 * to, when it finished and who finished it. Sheet 2 is the per-client summary that used to be the
 * whole file. Both from the same two reads, so the rows and the totals cannot disagree.
 *
 * A TASK AND A STEP STAY APART, here as in the counts: one Iqama renewal is a single task and
 * eleven steps, and a column that added them would make a client with one renewal look busier than
 * a client with ten phone calls. The Kind column says which each row is.
 */
export async function clientWorkWorkbook(rows: ClientWorkRow[], items: ClientWorkItem[], from: string, to: string) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "STIMES PRO";
  wb.created = new Date();

  // ── Sheet 1 · everything that was finished ────────────────────────────────────────────────
  const ws = wb.addWorksheet("Work done", { properties: { defaultRowHeight: 17 } });
  ws.columns = [
    { key: "client", width: 34 }, { key: "kind", width: 10 }, { key: "title", width: 46 },
    { key: "caseTitle", width: 32 }, { key: "day", width: 13 }, { key: "by", width: 20 },
  ];
  const HEADS = ["Client", "Kind", "What was done", "Case", "Completed", "By"];
  sheetTitle(ws, "Client work", `${from} to ${to} inclusive · ${items.length} item${items.length === 1 ? "" : "s"} finished · oldest first`, HEADS.length);
  ws.getRow(4).values = HEADS;
  sheetHeader(ws, 4, HEADS.length);
  items.forEach(i => ws.addRow({
    client: i.client || "(deleted client)",
    kind: i.kind === "step" ? "Step" : "Task",
    title: i.title,
    // A standalone task belongs to no case, and an em dash reads better than an empty cell when
    // the column beside it is full.
    caseTitle: i.caseTitle || "—",
    day: String(i.completedAt ?? "").slice(0, 10),
    by: i.by || "—",
  }));
  sheetZebra(ws, 5, 4 + items.length, HEADS.length);
  for (let r = 5; r <= 4 + items.length; r++) {
    // Steps are the government work and run to eleven a case; tasks are the one-offs. Tinting the
    // word is what lets somebody skim a client's block and see which kind of month it was.
    const it = items[r - 5];
    ws.getCell(r, 2).font = { bold: true, color: { argb: it.kind === "step" ? "FF7C00FF" : "FF0284C7" } };
    ws.getCell(r, 2).alignment = { horizontal: "center" };
  }
  if (!items.length) ws.addRow({ client: "Nothing was completed in this period." }).font = { italic: true, color: { argb: "FF6F6C7A" } };

  // ── Sheet 2 · the counts that used to be the whole file ───────────────────────────────────
  const sum = wb.addWorksheet("By client", { properties: { defaultRowHeight: 17 } });
  sum.columns = [
    { key: "client", width: 40 }, { key: "tasks", width: 17 }, { key: "steps", width: 24 },
    { key: "casesClosed", width: 15 }, { key: "openNow", width: 12 },
  ];
  const SHEADS = ["Client", "Tasks completed", "Workflow steps completed", "Cases closed", "Open now"];
  sheetTitle(sum, "By client", `${from} to ${to} inclusive · busiest first · clients with nothing are left out`, SHEADS.length);
  sum.getRow(4).values = SHEADS;
  sheetHeader(sum, 4, SHEADS.length);
  rows.forEach(r => sum.addRow(r));
  sheetZebra(sum, 5, 4 + rows.length, SHEADS.length);
  const tot = sum.addRow({
    client: "TOTAL",
    tasks: rows.reduce((n, r) => n + r.tasks, 0),
    steps: rows.reduce((n, r) => n + r.steps, 0),
    casesClosed: rows.reduce((n, r) => n + r.casesClosed, 0),
    openNow: rows.reduce((n, r) => n + r.openNow, 0),
  });
  tot.font = { bold: true };
  for (let c = 1; c <= SHEADS.length; c++) {
    tot.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFE9FA" } };
    tot.getCell(c).border = { top: { style: "thin", color: { argb: INK } } };
  }
  for (let c = 2; c <= SHEADS.length; c++) sum.getColumn(c).alignment = { horizontal: "center" };

  sheetNotes(sum, [
    `Completed between ${from} and ${to} inclusive. "Open now" is as at ${new Date().toISOString().slice(0, 10)}, not a figure about the period.`,
    `Tasks and workflow steps are counted separately on purpose: one renewal is a single task and eleven steps, and adding them would flatter whoever had the most paperwork.`,
    `The Work done sheet lists every item behind these counts.`,
  ]);

  return wb;
}
