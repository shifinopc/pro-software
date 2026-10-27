/**
 * The lead list as a workbook somebody can actually work in.
 *
 * A CSV carries the same facts and none of the reading: 104 rows of undifferentiated text where
 * the three questions anybody opens this file to answer — who is worth calling, who can we
 * reach, and whose is it — take a sort and a squint each. So this is a real sheet:
 *
 *   score      green at 70 and over, amber from 40, grey below — the scorer's own bands
 *   unowned    "Unassigned" in red: an unowned lead appears on nobody's screen, which is the
 *              one fact on the row that means work is not happening
 *   no contact a red-outlined empty cell where the email and phone both are, because a lead
 *              nobody can reach is a row rather than a lead
 *   website    a real hyperlink, as is the email, so the sheet is a place to work from
 *
 * The header freezes and filters, the company name stays put while you read across, and the
 * colours carry a legend at the bottom — a colour nobody can look up is decoration.
 */
import ExcelJS from "exceljs";
import { prisma } from "./db.js";

const FILL = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const PURPLE = "FF4B2A82";
const BAND = FILL("FFFAF8FD");
const GREEN = FILL("FFE7F8EF");
const AMBER = FILL("FFFDF0D5");
const GREY = FILL("FFF4F3F7");
const MISSING_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFC0353A" } },
  left: { style: "thin", color: { argb: "FFC0353A" } },
  bottom: { style: "thin", color: { argb: "FFC0353A" } },
  right: { style: "thin", color: { argb: "FFC0353A" } },
};
const STAGE_INK: Record<string, string> = {
  lead: "FF7C00FF", prospect: "FF0284C7", client: "FF0E9355", lost: "FFC0353A", churned: "FF6F6C7A",
};
const STAGE_LABEL: Record<string, string> = {
  lead: "Lead", prospect: "Prospect", client: "Client", lost: "Lost", churned: "Churned",
};

const COLS: { header: string; width: number }[] = [
  { header: "Company", width: 32 },
  { header: "Website", width: 24 },
  { header: "City", width: 14 },
  { header: "Industry", width: 20 },
  { header: "Contact", width: 24 },
  { header: "Role", width: 16 },
  { header: "Email", width: 30 },
  { header: "Phone", width: 18 },
  { header: "Product", width: 24 },
  { header: "Source", width: 14 },
  { header: "Campaign", width: 16 },
  { header: "Notes", width: 46 },
  { header: "Score", width: 8 },
  { header: "Stage", width: 11 },
  { header: "Managed by", width: 20 },
  { header: "Added", width: 12 },
];

/**
 * `ids` is the list the screen is showing, in the order it shows them — the tab, the search and
 * the product filter are the caller's business, not this function's, and a second copy of those
 * rules here would be one that drifts from the one people can see.
 */
export async function buildLeadWorkbook(ids: string[], scoreById: Record<string, number> = {}) {
  const rows = await prisma.company.findMany({
    where: { id: { in: ids } },
    include: { contacts: { where: { archived: false }, select: { name: true, jobTitle: true, email: true, phone: true, isPrimary: true } } },
  });
  // Two lookups rather than two relations: Company has no `owner` relation (only `ownerId`), and
  // "Added" is the arrival TRANSITION — `createdAt` means "client since" and is empty on a lead,
  // which is the same reason the list screen computes it this way.
  const ownerIds = [...new Set(rows.map(r => r.ownerId).filter(Boolean) as string[])];
  const [users, arrivals] = await Promise.all([
    ownerIds.length ? prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    prisma.lifecycleTransition.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, fromLifecycle: null }, _min: { changedAt: true } }),
  ]);
  const ownerName = new Map(users.map(u => [u.id, u.name]));
  const arrivedAt = new Map(arrivals.map(a => [a.companyId, a._min.changedAt]));
  // The caller's order, not the database's: the sheet should open looking like the screen it
  // came from, and `findMany` with an `in` makes no promise about order at all.
  const byId = new Map(rows.map(r => [r.id, r]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean) as typeof rows;

  const wb = new ExcelJS.Workbook();
  wb.creator = "STIMES PRO";
  wb.created = new Date();
  const ws = wb.addWorksheet("Leads", {
    views: [{ state: "frozen", xSplit: 1, ySplit: 2 }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = COLS.map(c => ({ width: c.width }));

  // ── the band across the top ───────────────────────────────────────────────────────────────
  const title = ws.getRow(1);
  title.height = 26;
  title.getCell(1).value = "Leads";
  title.getCell(1).font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  title.getCell(COLS.length - 3).value =
    `${ordered.length} ${ordered.length === 1 ? "lead" : "leads"}  ·  ${new Date().toISOString().slice(0, 10)}`;
  title.getCell(COLS.length - 3).font = { size: 10, color: { argb: "FFD9C8F5" } };
  title.getCell(COLS.length - 3).alignment = { horizontal: "right", vertical: "middle" };
  ws.mergeCells(1, COLS.length - 3, 1, COLS.length);
  for (let i = 1; i <= COLS.length; i++) {
    const c = title.getCell(i);
    c.fill = FILL(PURPLE);
    c.alignment = { vertical: "middle", ...(i === 1 ? { indent: 1 } : c.alignment) };
  }

  const head = ws.getRow(2);
  head.height = 20;
  COLS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    cell.fill = FILL("FF6D3BB0");
    cell.alignment = { vertical: "middle", horizontal: c.header === "Score" ? "center" : "left" };
  });

  // ── the leads ─────────────────────────────────────────────────────────────────────────────
  ordered.forEach((l, n) => {
    const primary = l.contacts.find(c => c.isPrimary) ?? l.contacts[0] ?? null;
    const email = primary?.email ?? l.email ?? "";
    const phone = primary?.phone ?? l.phone ?? "";
    const score = scoreById[l.id];
    const owner = (l.ownerId && ownerName.get(l.ownerId)) || "";
    const added = String(arrivedAt.get(l.id) ?? l.createdAt ?? "").slice(0, 10);

    const row = ws.addRow([
      l.name, l.website ?? "", l.city ?? "", l.industry ?? "",
      primary?.name ?? l.contact ?? "", primary?.jobTitle ?? "",
      email, phone, l.service ?? "", l.source ?? "", l.campaign ?? "", l.sourceDetail ?? "",
      typeof score === "number" ? score : "", STAGE_LABEL[l.lifecycle] ?? l.lifecycle,
      owner || "Unassigned", added,
    ]);
    row.height = 17;
    row.eachCell({ includeEmpty: true }, c => {
      c.font = { size: 10 };
      c.alignment = { vertical: "middle" };
      if (n % 2 === 1) c.fill = BAND;
    });
    row.getCell(1).font = { size: 10, bold: true };

    // Links, so the sheet is a place to work from rather than a printout of one.
    if (l.website) {
      const href = /^https?:\/\//i.test(l.website) ? l.website : `https://${l.website}`;
      row.getCell(2).value = { text: l.website, hyperlink: href };
      row.getCell(2).font = { size: 10, color: { argb: "FF7C00FF" }, underline: true };
    }
    if (email) {
      row.getCell(7).value = { text: email, hyperlink: `mailto:${email}` };
      row.getCell(7).font = { size: 10, color: { argb: "FF7C00FF" }, underline: true };
    }

    // A lead nobody can reach. Outlined rather than filled: it is the ABSENCE being pointed at,
    // and a solid block of colour on an empty cell reads as a value.
    if (!email && !phone) {
      row.getCell(7).border = MISSING_BORDER;
      row.getCell(8).border = MISSING_BORDER;
    }

    // The score, in the scorer's own bands — the same three the screen colours the number with.
    const sc = row.getCell(13);
    sc.alignment = { vertical: "middle", horizontal: "center" };
    if (typeof score === "number") {
      sc.font = { size: 10, bold: true, color: { argb: score >= 70 ? "FF0B7A46" : score >= 40 ? "FF7A5A12" : "FF6F6C7A" } };
      sc.fill = score >= 70 ? GREEN : score >= 40 ? AMBER : GREY;
    }

    const st = row.getCell(14);
    st.font = { size: 10, bold: true, color: { argb: STAGE_INK[l.lifecycle] ?? "FF1A1523" } };

    // Unowned is the one thing on the row that means nothing is happening to it.
    const own = row.getCell(15);
    if (!owner) own.font = { size: 10, italic: true, color: { argb: "FFC0353A" } };

    const when = row.getCell(16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(added)) { when.value = new Date(added + "T00:00:00Z"); when.numFmt = "yyyy-mm-dd"; }
    when.alignment = { vertical: "middle", horizontal: "center" };
  });

  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: COLS.length } };

  // A key, because a colour nobody can look up is decoration.
  const legend = ws.addRow([]);
  legend.getCell(1).value =
    "Green 70+ · amber 40–69 · grey under 40   ·   red \"Unassigned\" = nobody is working it   ·   red outline = no email and no phone on file";
  legend.getCell(1).font = { size: 9, italic: true, color: { argb: "FF6F6C7A" } };
  ws.mergeCells(legend.number, 1, legend.number, COLS.length);

  return { wb, leads: ordered.length };
}
