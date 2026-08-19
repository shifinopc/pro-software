/**
 * Throwaway check that issuing a document replaces the one it supersedes — and nothing else.
 *
 * Running an onboarding twice for one person used to leave two identical live records. Four such
 * pairs existed for a single employee, and each one meant the deadline report counted the document
 * twice and the renewal reminder fired twice.
 *
 * The failure mode of the FIX is worse than the bug, so most of this probe is about reach: a rule
 * that retires "the previous one" too eagerly silently marks a colleague's live permit as replaced,
 * and the first anyone hears of it is when the reminder never comes. So this checks that it retires
 * the right row, keeps it readable, and leaves other people and other document types alone.
 *
 * Own company, own people. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { supersedePriorLive } from "../src/docnumber.js";

const P1 = "RS Probe Person", P2 = "RS Probe Colleague";

const sweep = () => prisma.document.deleteMany({ where: { person: { in: [P1, P2] } } });

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();
  const co = await prisma.company.findFirst({ select: { id: true } });
  const mk = (person: string, docType: string, docNumber: string, expiryDate: string) =>
    prisma.document.create({ data: { companyId: co!.id, person, docType, docNumber, expiryDate, status: "valid", daysLeft: 100 } });

  const first  = await mk(P1, "Iqama", "RS-1001", "2027-01-01");
  const other  = await mk(P1, "Work Permit", "RS-WP-1", "2027-01-01");   // same person, different type
  const mate   = await mk(P2, "Iqama", "RS-2002", "2027-01-01");         // different person, same type

  // the re-issue: a renewed Iqama carries a NEW number, which is why this matches on the subject
  const second = await mk(P1, "Iqama", "RS-1099", "2029-01-01");
  const n = await supersedePriorLive({ id: second.id, companyId: co!.id, docType: "Iqama", person: P1, employeeId: null }, "probe");

  console.log(`re-issuing retires the earlier record:     ${n === 1 ? "YES" : "NO (" + n + ")"}`);
  const live = await prisma.document.count({ where: { person: P1, docType: "Iqama", supersededAt: null } });
  console.log(`exactly one live Iqama remains:            ${live === 1 ? "YES" : "NO (" + live + ")"}`);
  if (live !== 1) fail(`${live} live Iqamas for one person — the renewal reminder fires ${live} times`);

  const old = await prisma.document.findUnique({ where: { id: first.id } });
  console.log(`the retired one is kept, not overwritten:  ${old?.docNumber === "RS-1001" && old?.expiryDate === "2027-01-01" ? "YES" : "NO"}`);
  if (old?.docNumber !== "RS-1001" || old?.expiryDate !== "2027-01-01") fail("superseding rewrote the record it was supposed to preserve — the proof of what was held is gone");
  console.log(`  ...and points at what replaced it:       ${old?.supersededById === second.id ? "YES" : "NO"}`);
  if (old?.supersededById !== second.id) fail("the retired record does not say what replaced it");
  const h: any[] = Array.isArray(old?.history) ? (old!.history as any[]) : [];
  if (!h.some(e => e.kind === "superseded")) fail("nothing in the record's own history says it was replaced");

  // ── reach ─────────────────────────────────────────────────────────────────────────────────────
  const mateRow = await prisma.document.findUnique({ where: { id: mate.id }, select: { supersededAt: true } });
  console.log(`\na colleague's Iqama is untouched:          ${mateRow?.supersededAt === null ? "YES" : "NO"}`);
  if (mateRow?.supersededAt) fail("issuing for one person retired somebody else's live document — their reminders now never fire");

  const otherRow = await prisma.document.findUnique({ where: { id: other.id }, select: { supersededAt: true } });
  console.log(`the same person's Work Permit is untouched: ${otherRow?.supersededAt === null ? "YES" : "NO"}`);
  if (otherRow?.supersededAt) fail("issuing an Iqama retired the same person's Work Permit — a different document entirely");

  const again = await supersedePriorLive({ id: second.id, companyId: co!.id, docType: "Iqama", person: P1, employeeId: null }, "probe");
  console.log(`re-running retires nothing further:        ${again === 0 ? "YES" : "NO (" + again + ")"}`);
  if (again !== 0) fail("the rule retires a row twice, so it would eventually retire the live one");

  const stillLive = await prisma.document.findUnique({ where: { id: second.id }, select: { supersededAt: true } });
  if (stillLive?.supersededAt) fail("the newly issued document retired ITSELF — nothing live is left at all");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep(); await prisma.$disconnect(); process.exit(1); });
