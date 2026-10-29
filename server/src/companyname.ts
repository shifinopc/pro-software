/**
 * A RENAMED CUSTOMER REACHES THE DOCUMENTS THAT HAVE NOT LEFT THE BUILDING.
 *
 * `Quotation.clientName` and `.service` are TEXT, copied when the quotation was created — it stores
 * a companyId but never looks the name up. That is RIGHT for anything the client has already seen:
 * they hold a document bearing that name, and rewriting ours afterwards would make the two copies
 * disagree about what was issued. It is WRONG for a draft, which has been seen by nobody outside
 * the firm, and which is what somebody is looking at when they correct the customer's name and
 * expect the correction to take.
 *
 * So: unsent follows the company, sent is frozen. The cut is `status`, and `sent` is the first
 * state the client can see — see the comment on the Quotation model.
 *
 * The DEAL TITLE is only touched where it is still the sentence the system generated. Once somebody
 * has typed "Q3 expansion" over it, those are their words and not ours to rewrite — and a deal is an
 * internal record, so there is no issued-document reason to freeze it.
 *
 * Invoices are deliberately NOT here. An invoice is a tax document; what it was raised under is
 * what it stays under.
 *
 * WHY THIS IS NOT INSIDE THE LEAD-EDIT ROUTE ANY MORE. It was, and that route is the only one the
 * LEAD form uses — so correcting a lead's name re-addressed its drafts, and renaming a CLIENT, which
 * goes through the generic company update, did not. That is backwards: the rename that matters most
 * is the one at the end of a business setup, when a person who signed as "Abdullah Al-Ghamdi"
 * becomes "Al-Ghamdi Trading Est." and every draft still says the person's name.
 */
import { prisma } from "./db.js";
import { logAudit } from "./auth.js";

/** Quotations a client has not seen yet. `sent` is the first state that leaves the building. */
const UNSENT = ["draft", "approved"];
/** The title this system writes for itself, and the only one it may rewrite. */
const autoTitle = (name: string) => `New business — ${name}`;

export async function reAddressOnRename(
  company: { id: string; name: string },
  was: string,
  actorId?: string | null,
): Promise<number> {
  const name = company.name;
  if (!was || !name || was === name) return 0;
  const [clients, services, deals] = await Promise.all([
    prisma.quotation.updateMany({
      where: { companyId: company.id, status: { in: UNSENT } },
      data: { clientName: name },
    }),
    prisma.quotation.updateMany({
      where: { companyId: company.id, status: { in: UNSENT }, service: autoTitle(was) },
      data: { service: autoTitle(name) },
    }),
    prisma.opportunity.updateMany({
      where: { companyId: company.id, title: autoTitle(was) },
      data: { title: autoTitle(name) },
    }),
  ]);
  const touched = clients.count + services.count + deals.count;
  if (touched) {
    await logAudit({
      action: "company.renamed", actorId: actorId ?? null, target: company.id,
      detail: `${was} — ${name}: ${clients.count} unsent quotation${clients.count === 1 ? "" : "s"} re-addressed`
        + `, ${services.count} retitled, ${deals.count} deal${deals.count === 1 ? "" : "s"} retitled`,
    });
  }
  return touched;
}
