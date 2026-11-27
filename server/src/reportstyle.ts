/**
 * ONE LOOK FOR EVERY WORKBOOK THIS APP SENDS OUT.
 *
 * The lead report grew a title block, a header band, zebra rows, a frozen pane and an autofilter;
 * the client report was about to grow its own. Two files styled by hand is how one of them ends up
 * with a different header colour the first time anybody edits either — and these go to clients,
 * where "two of our reports look like two different companies" is the whole cost.
 *
 * Deliberately thin: four helpers over ExcelJS, no wrapper around the library. A spreadsheet
 * framework would be a second API to learn for the sake of six fills.
 */
export const INK = "FF26074D";
export const PAPER = "FFF7F5FB";
export const LINE = "FFE6E1F0";
export const MUTED = "FF6F6C7A";

/** The name of the report and what it covers, above the table rather than inside it. */
export function sheetTitle(sheet: any, text: string, sub: string, span: number) {
  sheet.mergeCells(1, 1, 1, span);
  const t = sheet.getCell(1, 1);
  t.value = text;
  t.font = { bold: true, size: 15, color: { argb: INK } };
  sheet.getRow(1).height = 22;
  sheet.mergeCells(2, 1, 2, span);
  const u = sheet.getCell(2, 1);
  u.value = sub;
  u.font = { size: 10, color: { argb: MUTED } };
  sheet.getRow(2).height = 16;
  sheet.getRow(3).height = 6;
}

/**
 * The column band — and the two things that make a long sheet usable: the header stays put while
 * the rows scroll under it, and every column can be filtered without anybody building a table.
 */
export function sheetHeader(sheet: any, row: number, span: number) {
  const r = sheet.getRow(row);
  r.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  r.height = 20;
  r.alignment = { vertical: "middle", wrapText: true };
  for (let c = 1; c <= span; c++) {
    r.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: INK } };
  }
  sheet.views = [{ state: "frozen", ySplit: row }];
  sheet.autoFilter = { from: { row, column: 1 }, to: { row, column: span } };
}

/** Alternating tint and a hairline, so the eye keeps its place across sixteen columns. */
export function sheetZebra(sheet: any, first: number, last: number, span: number) {
  for (let i = first; i <= last; i++) {
    const r = sheet.getRow(i);
    r.alignment = { vertical: "middle" };
    for (let c = 1; c <= span; c++) {
      const cell = r.getCell(c);
      if ((i - first) % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PAPER } };
      cell.border = { bottom: { style: "hair", color: { argb: LINE } } };
    }
  }
}

/** The caveats, in the file. A sheet pasted into an email loses its name and its period with it. */
export function sheetNotes(sheet: any, lines: string[]) {
  sheet.addRow([]);
  for (const t of lines) sheet.addRow([t]).font = { size: 9, color: { argb: MUTED } };
}
