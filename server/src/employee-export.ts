/**
 * The employee compliance sheet a PRO firm actually hands to a client.
 *
 * A CSV cannot do the one thing this report is for: showing, at a glance, which papers are about to
 * lapse and which are not there at all. So this is a real workbook — the dates carry their urgency
 * in the cell, and a missing document is an outlined empty cell rather than a blank that reads as
 * "nothing to do here".
 *
 *   amber   expiring inside the type's own reminder window
 *   red     already expired
 *   red outline, no fill   nothing on file at all
 *
 * One column per tracked document type, in the order the firm arranged them on the employee card,
 * and ONLY the types that apply to that person: a Saudi national holds no Iqama, so the column is
 * greyed for them rather than scored against them.
 */
import ExcelJS from "exceljs";
import { prisma } from "./db.js";

const FILL = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const AMBER = FILL("FFFDF0D5");
const RED = FILL("FFFBE0E0");
const GREY = FILL("FFF4F3F7");
const MISSING_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFC0353A" } },
  left: { style: "thin", color: { argb: "FFC0353A" } },
  bottom: { style: "thin", color: { argb: "FFC0353A" } },
  right: { style: "thin", color: { argb: "FFC0353A" } },
};

const NATIONAL = /^(sa|ksa|saudi|saudi arabia|saudi arabian|saudi national)$/i;

export async function buildEmployeeWorkbook(companyId?: string, onlyIds?: string[]) {
  const types = await prisma.documentType.findMany({
    where: { subjectKind: "employee", retired: false, onEmployeeCard: true },
    orderBy: [{ cardOrder: "asc" }, { name: "asc" }],
  });
  const employees = await prisma.employee.findMany({
    where: { archived: false, ...(companyId ? { companyId } : {}), ...(onlyIds && onlyIds.length ? { id: { in: onlyIds } } : {}) },
    orderBy: { name: "asc" },
    include: { company: { select: { name: true } } },
  });
  const docs = await prisma.document.findMany({
    where: { supersededAt: null, employeeId: { in: employees.map(e => e.id) } },
    select: { employeeId: true, person: true, docType: true, docNumber: true, expiryDate: true },
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "STIMES PRO";
  wb.created = new Date();
  const ws = wb.addWorksheet("Employees", {
    views: [{ state: "frozen", xSplit: 3, ySplit: 1 }],   // the name stays visible while reading across
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const headers = ["Employee name", "Iqama ID", "Nationality", ...types.map(t => t.name)];
  ws.columns = headers.map((h, i) => ({ header: h, width: i === 0 ? 34 : i < 3 ? 16 : 19 }));

  const head = ws.getRow(1);
  head.height = 22;
  head.eachCell(c => {
    c.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    c.fill = FILL("FF4B2A82");
    c.alignment = { vertical: "middle", horizontal: "left" };
  });

  const iqamaType = types.find(t => /^iqama$/i.test(t.name))?.name ?? "Iqama";
  const today = Date.now();

  for (const e of employees) {
    const mine = docs.filter(d => d.employeeId === e.id);
    const iqamaNo = mine.find(d => d.docType === iqamaType)?.docNumber || e.govId || "";
    const isNat = NATIONAL.test(String(e.nationality ?? "").trim());

    const row = ws.addRow([e.name, iqamaNo, e.nationality ?? "", ...types.map(() => "")]);
    row.height = 18;
    row.getCell(1).font = { bold: true, size: 10 };
    for (let i = 1; i <= 3; i++) row.getCell(i).alignment = { vertical: "middle" };

    types.forEach((t, idx) => {
      const cell = row.getCell(4 + idx);
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.font = { size: 10 };

      const scope = String(t.employeeScope ?? "all");
      const applies = scope === "all" || (isNat ? scope === "nationals" : scope === "expats");
      if (!applies) {
        // Not a gap. Greyed and said out loud, so nobody reads an empty cell as a missing document.
        cell.value = "n/a";
        cell.fill = GREY;
        cell.font = { size: 9, italic: true, color: { argb: "FF8C8899" } };
        return;
      }

      const d = mine.find(x => x.docType === t.name);
      if (!d || !d.expiryDate) {
        cell.value = d ? "no expiry recorded" : "";
        cell.border = MISSING_BORDER;
        if (d) cell.font = { size: 9, italic: true, color: { argb: "FFC0353A" } };
        return;
      }
      const ts = new Date(d.expiryDate).getTime();
      if (isNaN(ts)) { cell.value = d.expiryDate; cell.border = MISSING_BORDER; return; }
      cell.value = new Date(ts);
      cell.numFmt = "yyyy-mm-dd";
      const daysLeft = Math.round((ts - today) / 86400000);
      const lead = t.leadDays ?? 30;
      if (daysLeft < 0) { cell.fill = RED; cell.font = { size: 10, bold: true, color: { argb: "FF9B1C21" } }; }
      else if (daysLeft <= lead) { cell.fill = AMBER; cell.font = { size: 10, bold: true, color: { argb: "FF7A5A12" } }; }
    });
  }

  // A key, because a colour nobody can look up is decoration.
  const legend = ws.addRow([]);
  legend.getCell(1).value = "Amber = expiring soon   ·   Red = expired   ·   Red outline = not on file   ·   n/a = does not apply to this nationality";
  legend.getCell(1).font = { size: 9, italic: true, color: { argb: "FF6F6C7A" } };
  ws.mergeCells(legend.number, 1, legend.number, Math.max(4, headers.length));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  return { wb, employees: employees.length, columns: types.length };
}
