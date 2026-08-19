/**
 * One government number belongs to one person.
 *
 * Nothing checked, and it got worse with use: eighteen (docType, docNumber) pairs were duplicated
 * across fifty-six documents, including two different people holding Iqama IQ-2233 and Work Visa
 * VISA-9001. A number is how a record is found and how it is reconciled against the portal it came
 * from, so two people sharing one is a record that cannot be trusted either way.
 *
 * DELIBERATELY NOT A DATABASE CONSTRAINT, and not "this number may appear once".
 *
 * The same number legitimately repeats for the SAME person: an Iqama keeps its number across a
 * renewal and across a sponsorship transfer, and a re-issued card is the same document. What must
 * never happen is one number held by two people at once. So the rule is per person, and superseded
 * rows are ignored — they are history, and history is allowed to repeat itself.
 */
import { prisma } from "./db.js";

export type NumberClash = { docType: string; docNumber: string; heldBy: string; documentId: string };

/**
 * The live document that already holds this number for somebody else, if there is one.
 *
 * `null` means the number is free, or is already this person's own. Case and surrounding space are
 * ignored — "iq-2233 " and "IQ-2233" are the same number written by two different people.
 */
export async function numberHeldByAnother(
  docType: string,
  docNumber: string | null | undefined,
  person: string | null | undefined,
  opts: { ignoreDocumentId?: string } = {},
): Promise<NumberClash | null> {
  const num = String(docNumber ?? "").trim();
  if (!num || !docType) return null;

  const rows = await prisma.document.findMany({
    where: { docType, supersededAt: null, ...(opts.ignoreDocumentId ? { NOT: { id: opts.ignoreDocumentId } } : {}) },
    select: { id: true, docNumber: true, person: true, employeeId: true },
  });

  const same = (a: string | null | undefined, b: string | null | undefined) =>
    String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

  for (const r of rows) {
    if (!same(r.docNumber, num)) continue;
    if (same(r.person, person)) continue;      // the same person's own record — a renewal or re-issue
    return { docType, docNumber: num, heldBy: r.person ?? "another record", documentId: r.id };
  }
  return null;
}

/** The refusal, in the words the person reading it needs. */
export function clashMessage(c: NumberClash): string {
  return `${c.docType} ${c.docNumber} is already held by ${c.heldBy}. A government number identifies one person — check the number, or supersede the existing record if this replaces it.`;
}

/**
 * A newly issued document replaces the one it supersedes.
 *
 * The government issues one live Iqama, one live work permit, one live policy. Nothing enforced
 * that: issuing through a workflow only ever created a row, so running an onboarding twice for one
 * person left two identical live records — four such pairs existed for a single employee. Two live
 * rows of the same type is not a harmless copy. Every deadline report counts them both, every
 * renewal reminder fires twice, and the two drift apart the moment somebody corrects one of them.
 *
 * The old row is MARKED, NEVER DELETED. It is the record of what the person actually held, and the
 * only thing that makes a lapse in cover provable after the fact. It leaves the live reports and
 * stays readable, pointing at whatever replaced it.
 *
 * Matched on the subject rather than the number, because a replacement usually carries a NEW number
 * — a renewed Iqama with a new number is exactly the case that must supersede, and matching on the
 * number would miss precisely it.
 */
export async function supersedePriorLive(
  created: { id: string; companyId: string; docType: string; person: string | null; employeeId: string | null },
  by: string,
): Promise<number> {
  if (!created.companyId || !created.docType) return 0;
  const subject: any[] = [];
  if (created.person) subject.push({ person: created.person });
  if (created.employeeId) subject.push({ employeeId: created.employeeId });
  if (!subject.length) return 0;

  const prior = await prisma.document.findMany({
    where: { companyId: created.companyId, docType: created.docType, supersededAt: null, NOT: { id: created.id }, OR: subject },
    select: { id: true, docNumber: true, expiryDate: true, history: true },
  });
  if (!prior.length) return 0;

  const at = new Date().toISOString();
  for (const p of prior) {
    const hist = Array.isArray(p.history) ? (p.history as any[]) : [];
    hist.unshift({ at, by, kind: "superseded", replacedBy: created.id,
      note: `Replaced by a newly issued ${created.docType}` });
    await prisma.document.update({
      where: { id: p.id },
      data: { supersededAt: at, supersededById: created.id, history: hist },
    });
  }
  return prior.length;
}
