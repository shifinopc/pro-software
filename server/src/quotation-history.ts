/**
 * WHAT HAPPENED TO A QUOTATION, in the order it happened.
 *
 * `status` is a single word describing now. It cannot tell "drafted, approved by Fatima, sent an
 * hour later" from "sent straight out", and it never said who did either. The one timestamp that
 * existed, `sentAt`, was added for the chasing jobs rather than for anybody reading the document.
 *
 * So each transition is appended here instead. Four writers change a quotation's status — staff
 * through the generic PUT, the client through the portal, the convert route, and the proposal
 * email when it releases a draft — and all of them come through this function, because a history
 * that four places can bypass is a history nobody can trust.
 */
import { prisma } from "./db.js";
import { promoteOnInvoice } from "./pipeline.js";

export type QuotationEvent = { at: string; from: string | null; to: string; by: string | null };

/** Clamp to something a timeline can print: no objects, no 400-character display names. */
const str = (v: unknown, max = 120): string | null => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/**
 * WHO, as a person's name rather than whatever the caller had to hand.
 *
 * The staff token carries `sub` — a user id — and no name, so every caller either passed an id or
 * fell back to the word "Staff". A timeline whose every row says "Staff" answers nothing, and the
 * question it exists for is exactly who approved this. Resolved here, in the one place, so the
 * four callers can each pass what they have.
 *
 * An id that matches no user keeps its own string: a deleted account is still a better answer than
 * a blank, and an API key name or a client name arrives here already human.
 */
async function nameOf(by: unknown): Promise<string | null> {
  const raw = str(by);
  if (!raw || raw.includes(" ") || raw.includes("@")) return raw;
  try {
    const u = await prisma.user.findUnique({ where: { id: raw }, select: { name: true, email: true } });
    return str(u?.name) ?? str(u?.email) ?? raw;
  } catch {
    return raw;
  }
}

/**
 * Append one transition. Returns the new history, or null when nothing was recorded.
 *
 * NO-OPS ON A NON-TRANSITION. Re-saving a sent quotation sends the same status again, and a
 * timeline that lists "sent, sent, sent" because somebody fixed a typo is worse than none: the
 * reader cannot tell a repeat from a resend.
 *
 * Never throws. This is a record of the work, not the work — a quotation must not fail to send
 * because its history could not be written. The caller is already past the point of no return.
 */
export async function recordQuotationStatus(
  id: string,
  to: string,
  by?: string | null,
  from?: string | null,
): Promise<QuotationEvent[] | null> {
  try {
    const next = str(to, 40);
    if (!next) return null;
    const q = await prisma.quotation.findUnique({
      where: { id },
      select: { status: true, history: true, number: true, companyId: true, clientName: true },
    });
    if (!q) return null;
    // `from` is passed by callers that already read the row before updating it — by then the stored
    // status IS the new one, so reading it here would record "sent → sent" for every transition.
    const prev = from !== undefined ? str(from, 40) : str(q.status, 40);
    if (prev && prev.toLowerCase() === next.toLowerCase()) return null;
    const rows: QuotationEvent[] = Array.isArray(q.history) ? (q.history as any[]).filter(Boolean) as QuotationEvent[] : [];
    // Bounded. A quotation revised back and forth for a year should not carry a column that grows
    // without limit; the oldest entries are the ones a reader scrolls past anyway.
    const out = [...rows, { at: new Date().toISOString(), from: prev, to: next, by: await nameOf(by) }].slice(-40);
    await prisma.quotation.update({ where: { id }, data: { history: out as any } });
    await noteOnTheLead(id, q.companyId, q.number, next, out[out.length - 1].by);
    /**
     * A PROSPECT WHO HAS BEEN BILLED IS A CLIENT.
     *
     * Hooked HERE because this is the one function every writer of a quotation's status already
     * comes through — staff through the generic PUT, the client through the portal, both convert
     * paths, the stage invoices and the proposal email. The reason this function exists is that a
     * history four places can bypass is a history nobody can trust; the same argument applies to a
     * promotion four places could miss.
     *
     * Awaited rather than fired and forgotten, so the response that follows reports the record as
     * it now is. promoteOnInvoice never throws and no-ops unless the company is a lead or a
     * prospect, so a second invoice on the same client costs one read.
     */
    if (next.toLowerCase() === "invoiced") await promoteOnInvoice(q.companyId);
    return out;
  } catch (e) {
    console.error("could not record quotation history for", id, e);
    return null;
  }
}

/**
 * THE SAME EVENT, WHERE THE CLIENT IS READ ABOUT.
 *
 * The drawer's History tells you what happened to the document. Nobody opens a document to find
 * out what is happening with a lead — they open the lead, whose Timeline already carries the
 * calls, the notes, and the "Moved to Quoted" a stage rule writes. A quotation being approved and
 * sent is the most consequential thing that happens between those two entries and it was the one
 * thing missing from them, so the lead's own record skipped from "moved to Quoted" to the client
 * replying, with no sign of the document that was actually sent.
 *
 * Written as the stage rules write theirs: an `auto` note, no chase attached. A follow-up here
 * would compete with the stage's own — applyStageFollowUp retires the previous chase when a deal
 * moves, and a second auto chase from a different writer is how a lead ends up with two.
 */
const TIMELINE_WORDING: Record<string, string> = {
  approved: "approved internally — ready to send",
  sent: "sent to the client",
  accepted: "accepted by the client",
  rejected: "rejected by the client",
  changes_requested: "sent back by the client with changes",
  invoiced: "invoiced",
};

async function noteOnTheLead(
  quotationId: string,
  companyId: string | null,
  number: string | null,
  to: string,
  by: string | null,
) {
  // A quotation can be written against a name with no client record behind it, and Interaction
  // requires a real company — there is no lead whose timeline this would appear on.
  if (!companyId) return;
  // Back to draft is housekeeping, not an event in the client's story.
  const wording = TIMELINE_WORDING[to.trim().toLowerCase()];
  if (!wording) return;
  try {
    // Linked to the DEAL as well when one points at this quotation, so it lands on the deal's own
    // timeline rather than only on the company's.
    const deal = await prisma.opportunity.findFirst({ where: { quotationId }, select: { id: true } });
    const now = new Date().toISOString();
    await prisma.interaction.create({
      data: {
        companyId,
        opportunityId: deal?.id ?? null,
        // Nothing was said to anybody: it is a note that the document moved.
        kind: "note",
        at: now,
        summary: `Quotation ${number ?? ""} ${wording}`.replace(/\s+/g, " ").trim(),
        outcome: by ? `by ${by}` : null,
        auto: true,
        createdAt: now,
      } as any,
    });
  } catch (e) {
    console.error("could not write the lead timeline entry for", quotationId, e);
  }
}
