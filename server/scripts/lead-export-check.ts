/**
 * The lead workbook says what the screen says.
 *
 * Not a snapshot of the XML — what matters is that the four things the sheet exists to show are
 * actually in the cells: the header freezes and filters, the score carries its band's colour, an
 * unowned lead is called out, and a lead with no email and no phone is outlined rather than blank.
 *
 *   npx tsx scripts/lead-export-check.ts
 */
import { prisma } from "../src/db.js";
import { buildLeadWorkbook } from "../src/lead-export.js";

const fail: string[] = [];
const ok = (cond: any, what: string) => { if (!cond) fail.push(what); };

const run = async () => {
  const leads = await prisma.company.findMany({
    where: { lifecycle: { in: ["lead", "prospect"] } },
    select: { id: true, name: true, ownerId: true, email: true, phone: true },
    take: 40,
  });
  if (!leads.length) { console.log("no leads in this database — nothing to check"); return; }

  // Scores made up on purpose: this is about how the sheet DRAWS a score, and the three bands have
  // to be present for the colours to be worth asserting.
  const scores: Record<string, number> = {};
  leads.forEach((l, i) => { scores[l.id] = [85, 55, 12][i % 3]; });

  const ids = leads.map(l => l.id);
  const { wb, leads: count } = await buildLeadWorkbook(ids, scores);
  const ws = wb.getWorksheet("Leads")!;

  ok(count === leads.length, `exported ${count} of ${leads.length}`);
  ok(ws.getRow(1).getCell(1).value === "Leads", "row 1 is the title band");
  ok(ws.getRow(2).getCell(1).value === "Company", "row 2 is the header");
  ok(ws.getRow(2).getCell(16).value === "Added", "sixteen columns");
  ok((ws.views?.[0] as any)?.ySplit === 2, "the header is frozen");
  ok(ws.autoFilter && (ws.autoFilter as any).from.row === 2, "the header filters");

  // ORDER: the sheet opens looking like the screen it came from.
  const firstName = ws.getRow(3).getCell(1).value;
  ok(firstName === leads[0].name, `first row is the first lead (${String(firstName)})`);

  const fillOf = (row: number, col: number) => ((ws.getRow(row).getCell(col).fill as any)?.fgColor?.argb) ?? "";
  const inkOf = (row: number, col: number) => ((ws.getRow(row).getCell(col).font as any)?.color?.argb) ?? "";

  // Three leads, three bands, three colours.
  ok(fillOf(3, 13) === "FFE7F8EF", "a score of 85 is green");
  ok(fillOf(4, 13) === "FFFDF0D5", "a score of 55 is amber");
  ok(fillOf(5, 13) === "FFF4F3F7", "a score of 12 is grey");

  // Unowned is the one fact on the row that means nothing is happening to it.
  const unownedRow = leads.findIndex(l => !l.ownerId);
  if (unownedRow >= 0) {
    const r = unownedRow + 3;
    ok(ws.getRow(r).getCell(15).value === "Unassigned", "an unowned lead reads Unassigned");
    ok(inkOf(r, 15) === "FFC0353A", "and it is red");
  }

  // A lead nobody can reach gets an outline, not a fill: it is an absence being pointed at.
  const contacts = await prisma.contact.findMany({ where: { companyId: { in: ids }, archived: false }, select: { companyId: true, email: true, phone: true } });
  const reachable = new Set(contacts.filter(c => c.email || c.phone).map(c => c.companyId));
  const mute = leads.findIndex(l => !reachable.has(l.id) && !l.email && !l.phone);
  if (mute >= 0) {
    const b = ws.getRow(mute + 3).getCell(7).border as any;
    ok(b && b.top && b.top.color?.argb === "FFC0353A", "a lead with no email and no phone is outlined");
  }

  const last = ws.getRow(ws.rowCount).getCell(1).value;
  ok(typeof last === "string" && /Green 70/.test(last), "the colours carry a legend");

  console.log(fail.length ? "PROBLEMS:\n - " + fail.join("\n - ") : "in order — the sheet shows what the screen shows.");
  if (fail.length) process.exitCode = 1;
};

run().finally(() => prisma.$disconnect());
