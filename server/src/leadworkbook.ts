import type { leadStatusReport } from "./lifecycle.js";

type Report = Awaited<ReturnType<typeof leadStatusReport>>;

/**
 * THE LEAD REPORT AS A WORKBOOK — the leads first, the counts second.
 *
 * It used to be one sheet of five numbers per salesperson and a stage tally. That answers "how
 * many" and nothing else: opened by the firm it could not say which lead was where, who owned it,
 * or when anybody last spoke to it — accurate, and unusable.
 *
 * Sheet 1 is every lead the report counted, one row each, longest silence first. Sheet 2 is the
 * summary that used to be the whole file. Both are built from ONE report object, so the rows and
 * the totals cannot drift.
 *
 * In its own file rather than inline in the route so that it can be RUN without an HTTP request —
 * a spreadsheet nobody can open while building it is a spreadsheet nobody checks.
 */
export async function leadStatusWorkbook(rep: Report, from: string, to: string) {
  const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "STIMES PRO";
    wb.created = new Date();

    // ── House style, defined once ────────────────────────────────────────────────────────────
    // Both sheets are dressed by the same three helpers rather than each carrying its own fills
    // and widths: two sheets styled by hand is how one of them ends up with a different header
    // colour the first time anybody edits either.
    const INK = "FF26074D", PAPER = "FFF7F5FB", LINE = "FFE6E1F0";
    const title = (sheet: any, text: string, sub: string, span: number) => {
      sheet.mergeCells(1, 1, 1, span);
      const t = sheet.getCell(1, 1);
      t.value = text;
      t.font = { bold: true, size: 15, color: { argb: INK } };
      sheet.getRow(1).height = 22;
      sheet.mergeCells(2, 1, 2, span);
      const u = sheet.getCell(2, 1);
      u.value = sub;
      u.font = { size: 10, color: { argb: "FF6F6C7A" } };
      sheet.getRow(2).height = 16;
      sheet.getRow(3).height = 6;
    };
    const header = (sheet: any, row: number, span: number) => {
      const r = sheet.getRow(row);
      r.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
      r.height = 20;
      r.alignment = { vertical: "middle", wrapText: true };
      for (let c = 1; c <= span; c++) {
        r.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
      }
      // Frozen BELOW the header row, so a thousand leads scroll under their own column names.
      sheet.views = [{ state: "frozen", ySplit: row }];
      sheet.autoFilter = { from: { row, column: 1 }, to: { row, column: span } };
    };
    const zebra = (sheet: any, first: number, last: number, span: number) => {
      for (let i = first; i <= last; i++) {
        const r = sheet.getRow(i);
        r.alignment = { vertical: "middle" };
        for (let c = 1; c <= span; c++) {
          const cell = r.getCell(c);
          if ((i - first) % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PAPER } };
          cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
        }
      }
    };

    // ── Sheet 1 · every lead ─────────────────────────────────────────────────────────────────
    const leads = rep.leads ?? [];
    const ws = wb.addWorksheet("Leads", { properties: { defaultRowHeight: 17 } });
    ws.columns = [
      { key: "name", width: 34 }, { key: "owner", width: 18 }, { key: "lifecycle", width: 11 },
      { key: "stage", width: 15 }, { key: "movement", width: 22 }, { key: "deal", width: 28 },
      { key: "value", width: 14 }, { key: "source", width: 16 }, { key: "campaign", width: 16 },
      { key: "city", width: 14 }, { key: "phone", width: 17 }, { key: "email", width: 26 },
      { key: "firstSeen", width: 12 }, { key: "lastContact", width: 13 }, { key: "idle", width: 11 },
      { key: "next", width: 34 },
    ];
    const HEADS = ["Lead", "Owner", "Lifecycle", "Pipeline stage", "In this period", "Deal",
      "Deal value", "Source", "Campaign", "City", "Phone", "Email",
      "First seen", "Last contact", "Days silent", "Next follow-up"];
    title(ws, "Lead status", `${from} to ${to} · ${leads.length} lead${leads.length === 1 ? "" : "s"} · what moved in the period first, then the longest silence`, HEADS.length);
    ws.getRow(4).values = HEADS;
    header(ws, 4, HEADS.length);
    leads.forEach(l => ws.addRow({
      name: l.name, owner: l.owner, lifecycle: l.lifecycle, stage: l.stage, movement: l.movement,
      deal: l.deal,
      // A number, not a string: a value column people cannot total is a value column people retype.
      value: l.valueMinor != null ? l.valueMinor / 100 : null,
      source: l.source, campaign: l.campaign, city: l.city, phone: l.phone, email: l.email,
      firstSeen: l.firstSeen, lastContact: l.lastContact || "never",
      idle: l.idleDays, next: l.nextFollowUp,
    }));
    zebra(ws, 5, 4 + leads.length, HEADS.length);
    ws.getColumn("value").numFmt = "#,##0.00";
    ws.getColumn("value").alignment = { horizontal: "right" };
    ws.getColumn("idle").alignment = { horizontal: "center" };
    for (let i = 5; i <= 4 + leads.length; i++) {
      const l = leads[i - 5];
      // Colour carries the two facts somebody opens this file to find: what the lead IS, and how
      // long nobody has touched it. Red at a month of silence, amber at a fortnight.
      ws.getCell(i, 3).font = {
        bold: true,
        color: { argb: l.lifecycle === "Client" ? "FF0E9355" : l.lifecycle === "Lost" ? "FFC0353A" : l.lifecycle === "Prospect" ? "FF7C00FF" : "FF4B4757" },
      };
      if (l.idleDays == null || l.idleDays >= 30) ws.getCell(i, 15).font = { bold: true, color: { argb: "FFC0353A" } };
      else if (l.idleDays >= 14) ws.getCell(i, 15).font = { bold: true, color: { argb: "FFB7791F" } };
      if (!l.lastContact) ws.getCell(i, 14).font = { italic: true, color: { argb: "FFC0353A" } };
    }
    if (!leads.length) {
      ws.addRow({ name: "No leads in this period." }).font = { italic: true, color: { argb: "FF6F6C7A" } };
    }

    // ── Sheet 2 · the summary that used to be the whole file ─────────────────────────────────
    const sum = wb.addWorksheet("Summary", { properties: { defaultRowHeight: 17 } });
    sum.columns = [
      { key: "owner", width: 30 }, { key: "newLeads", width: 13 }, { key: "toProspect", width: 19 },
      { key: "toClient", width: 16 }, { key: "lost", width: 10 }, { key: "openAtEnd", width: 13 },
    ];
    const SHEADS = ["Salesperson", "New leads", "Moved to prospect", "Became clients", "Lost", "Still open"];
    title(sum, "By salesperson", `${from} to ${to} inclusive · each company counted once per column`, SHEADS.length);
    sum.getRow(4).values = SHEADS;
    header(sum, 4, SHEADS.length);
    rep.rows.forEach(r => sum.addRow(r));
    zebra(sum, 5, 4 + rep.rows.length, SHEADS.length);
    const tot = sum.addRow({ owner: "TOTAL", ...rep.totals });
    tot.font = { bold: true };
    for (let c = 1; c <= SHEADS.length; c++) {
      tot.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFE9FA" } };
      tot.getCell(c).border = { top: { style: "thin", color: { argb: INK } } };
    }
    for (let c = 2; c <= SHEADS.length; c++) sum.getColumn(c).alignment = { horizontal: "center" };

    if (rep.stages.length) {
      sum.addRow([]);
      const h = sum.addRow(["OPEN LEADS BY STAGE (as at today)"]);
      h.font = { bold: true, size: 11, color: { argb: INK } };
      rep.stages.forEach(st => sum.addRow({ owner: st.name, newLeads: st.count }));
    }
    // The period and the caveats travel WITH the file: a sheet pasted into an email loses its
    // name, and a count with no period and no definitions on it is a number nobody can check.
    sum.addRow([]);
    [
      `${from} to ${to} inclusive. Each company counted once per column. "Still open" is its state as at ${to}.`,
      `Credited to the client's current owner.${rep.since ? ` Lifecycle history begins ${rep.since}.` : ""}`,
      `The Leads sheet lists every company behind these figures. "Days silent" counts from the last logged contact of any kind.`,
    ].forEach(t => { sum.addRow([t]).font = { size: 9, color: { argb: "FF6F6C7A" } }; });

  return wb;
}
