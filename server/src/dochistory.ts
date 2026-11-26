/**
 * WHAT HAPPENED TO ONE DOCUMENT, AND WHO DID IT.
 *
 * Three screens ask the same question of three documents — a quotation, an invoice, a receipt —
 * and the answer was spread across places none of them read: Quotation.history holds every status
 * transition with the person who made it and was written for a drawer that was never built; the
 * Audit table holds the named acts (revise, convert, approve, correct, record a payment) and is
 * only ever read by the audit screen; and the relationship between the three was readable nowhere
 * at all.
 *
 * JOINED ON THE DOCUMENT ID, NOT ITS NUMBER. The numbers look like the obvious key and are the
 * wrong one: `invoice.approve` records `target = <invoice id>`, and this database has nineteen
 * audit rows mentioning "INV-2026-001" belonging to eight different invoices, because numbers get
 * reused by anything that creates and deletes. A cuid appears in exactly one document's lifetime,
 * so matching on it cannot attribute one document's history to another.
 *
 * THE CHAIN COUNTS AS THE DOCUMENT'S OWN HISTORY. "Receipted" is not an event on a receipt as far
 * as a quotation is concerned — it is the last thing that happened to the quotation. So a
 * quotation's timeline includes the invoices raised from it and the money received against those,
 * each labelled with which document in the chain it happened to.
 */
import { prisma } from "./db.js";

export type DocEvent = {
  at: string;
  label: string;
  detail: string | null;
  by: string | null;
  /** Which document in the chain this happened to, when it is not the one being asked about. */
  on: string | null;
};

/** Audit actions worth printing, and what to call them. Anything absent is left out. */
const LABEL: Record<string, string> = {
  "quotation.create": "Created",
  "quotation.revise": "Revised",
  "quotation.convert": "Invoiced",
  "quotation.stage_invoice": "Stage invoice raised",
  "quotation.status": "Status changed",
  "proposal.generated": "Proposal generated",
  "proposal.emailed": "Proposal emailed",
  "invoice.create": "Created",
  "invoice.approve": "Approved",
  "invoice.correct": "Corrected",
  "invoice.void": "Voided",
  "invoice.status": "Status changed",
  "invoice.extend": "Payment date agreed",
  "payment.record": "Payment recorded",
  "payment.delete": "Payment removed",
};

/**
 * A person's name from whatever the audit row has.
 *
 * actorId is a user id and actorEmail is often empty, so a timeline built from the raw columns says
 * "cms5ngm6p0000wfwlwot8clvw" against every line — which is worse than saying nothing, because it
 * looks like data. Resolved in one batch rather than once per row.
 */
async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: want } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map(u => [u.id, u.name || u.email || u.id]));
}

const mentions = (row: { target: string | null; detail: string | null }, id: string) =>
  String(row.target ?? "").includes(id) || String(row.detail ?? "").includes(id);

export type DocKind = "quotation" | "invoice" | "payment";

export async function docHistory(kind: DocKind, id: string): Promise<{
  number: string | null;
  title: string | null;
  events: DocEvent[];
} | null> {
  // The document, and everything in its chain, so one pass over the audit covers all of it.
  let number: string | null = null;
  let title: string | null = null;
  const ids = new Map<string, string | null>(); // id -> the document label to show against it
  let transitions: any[] = [];

  if (kind === "quotation") {
    const q = await prisma.quotation.findUnique({
      where: { id },
      select: { id: true, number: true, clientName: true, service: true, history: true },
    });
    if (!q) return null;
    number = q.number;
    title = [q.clientName, q.service].filter(Boolean).join(" — ") || null;
    transitions = Array.isArray(q.history) ? (q.history as any[]).filter(Boolean) : [];
    ids.set(q.id, null);
    const invs = await prisma.invoice.findMany({ where: { quotationId: q.id }, select: { id: true, number: true } });
    for (const v of invs) ids.set(v.id, v.number);
    const pays = await prisma.payment.findMany({
      where: { invoiceId: { in: invs.map(v => v.id) } },
      select: { id: true, number: true },
    });
    for (const p of pays) ids.set(p.id, p.number);
  } else if (kind === "invoice") {
    const v = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, number: true, clientName: true, services: true, quotationId: true },
    });
    if (!v) return null;
    number = v.number;
    title = [v.clientName, v.services].filter(Boolean).join(" — ") || null;
    ids.set(v.id, null);
    // The quotation contributes the act that CREATED this invoice: "Invoiced" on a quotation is the
    // same moment as "raised" on the invoice it made, and the invoice has no record of its own.
    if (v.quotationId) {
      const q = await prisma.quotation.findUnique({ where: { id: v.quotationId }, select: { number: true } });
      ids.set(v.quotationId, q?.number ?? null);
    }
    const pays = await prisma.payment.findMany({ where: { invoiceId: v.id }, select: { id: true, number: true } });
    for (const p of pays) ids.set(p.id, p.number);
  } else {
    const p = await prisma.payment.findUnique({
      where: { id },
      select: { id: true, number: true, clientName: true, invoiceId: true, invoiceNumber: true },
    });
    if (!p) return null;
    number = p.number;
    title = [p.clientName, p.invoiceNumber ? "against " + p.invoiceNumber : ""].filter(Boolean).join(" — ") || null;
    ids.set(p.id, null);
    // The bill this settled, and the quotation behind it: a receipt with one line on its timeline
    // answers nothing, and "what was this payment for" is the question somebody opening it has.
    if (p.invoiceId) {
      const v = await prisma.invoice.findUnique({ where: { id: p.invoiceId }, select: { number: true, quotationId: true } });
      ids.set(p.invoiceId, v?.number ?? p.invoiceNumber ?? null);
      if (v?.quotationId) {
        const q = await prisma.quotation.findUnique({ where: { id: v.quotationId }, select: { number: true } });
        ids.set(v.quotationId, q?.number ?? null);
      }
    }
  }

  const keys = [...ids.keys()];
  // One query per id rather than a scan of the whole table: neither half of a `contains` can use an
  // index, and the chain is a handful of documents.
  const seen = new Set<string>();
  const rows: any[] = [];
  for (const k of keys) {
    const got = await prisma.audit.findMany({
      where: { OR: [{ target: { contains: k } }, { detail: { contains: k } }] },
      select: { id: true, action: true, actorId: true, actorEmail: true, target: true, detail: true, at: true },
    });
    for (const r of got) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
  }

  const names = await namesFor(rows.map(r => r.actorId).filter(Boolean));
  const events: DocEvent[] = [];
  for (const r of rows) {
    const label = LABEL[r.action];
    // Unlabelled actions are the scheduled jobs and anything that merely mentioned an id in passing.
    // A timeline is a list of acts on this document, not of times it was looked at.
    if (!label) continue;
    // Which document in the chain this row is about: the id it names that is not the subject.
    const owner = keys.find(k => ids.get(k) && mentions(r, k)) ?? null;
    events.push({
      at: r.at,
      label,
      detail: r.detail ?? r.target ?? null,
      by: (r.actorId && names.get(r.actorId)) || r.actorEmail || (r.actorId ? r.actorId : "System"),
      on: owner ? ids.get(owner) ?? null : null,
    });
  }

  // The quotation's own transitions, which exist nowhere in the audit: approved, sent, accepted and
  // rejected all go through the generic PUT or the portal, and none of them was ever audited.
  for (const h of transitions) {
    if (!h || !h.at || !h.to) continue;
    events.push({
      at: String(h.at),
      label: String(h.to).replace(/_/g, " ").replace(/^./, c => c.toUpperCase()),
      detail: h.from ? "from " + h.from : null,
      by: h.by || null,
      on: null,
    });
  }

  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  /**
   * ONE ACT IS ONE LINE, however many places recorded it.
   *
   * Converting a quotation writes BOTH a status transition (sent -> invoiced, with who) and an
   * audit row (quotation.convert, with which stage and which invoice), within the same second. Both
   * are wanted — neither carries the other's information — but printing them as two lines says the
   * quotation was invoiced twice, which on a staged quotation is a thing that genuinely happens and
   * must stay distinguishable. The later, more detailed row wins and keeps the earlier one's actor
   * if it has none of its own.
   */
  const merged: DocEvent[] = [];
  for (const e of events) {
    const twin = merged.find(m =>
      m.label.toLowerCase() === e.label.toLowerCase()
      && m.on === e.on
      && Math.abs(Date.parse(m.at) - Date.parse(e.at)) < 5000);
    if (!twin) { merged.push(e); continue; }
    if ((e.detail || "").length > (twin.detail || "").length) twin.detail = e.detail;
    twin.by = twin.by || e.by;
  }
  return { number, title, events: merged };
}
