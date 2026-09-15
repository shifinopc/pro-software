/**
 * COLLECTIONS AGENT.
 *
 * Two jobs.
 *
 * 1. MATCHING. A client says "I've paid" in the portal. The agent pairs that notice with the open
 *    invoices it covers — by the invoice numbers they quoted, by an exact amount, or by the whole
 *    balance — and prepares the receipts. The accountant checks the money landed and confirms; only
 *    then is a Payment written. Money the firm has not seen never enters the ledger on its own.
 *
 * 2. REMINDERS THAT FIT THE CLIENT. The overdue ladder (1, 7, 14, 30 days) already sends reminders.
 *    With this agent on, each one gains a sentence written from that client's own history: a client
 *    who always pays on time is told it was probably missed; one who usually pays two weeks late is
 *    told so, plainly; one who promised a date and missed it is reminded of the promise.
 *
 * NO MODEL. These reminders go out automatically, without anyone reading them first, so their wording
 * is built from the payment records and nothing else. A model writing unsupervised mail to clients
 * about money is not a risk worth the nicer prose.
 */
import { prisma } from "./db.js";
import { claimTask, finishTask, agentSetting, decide, requirePerm, AgentActionError, parseDay, DAY, type AgentActor } from "./agent-core.js";
import { logActivity, logAudit, logNotification } from "./auth.js";
import { nextNumber } from "./sequence.js";

export const KEY = "collections";
const OPEN = ["pending", "unpaid", "sent", "overdue"];

/** Reads back the notice the portal wrote (index.ts, /api/portal/payment-notice). */
export function parseNotice(message: string | null) {
  const m = String(message ?? "");
  const amount = Number((m.match(/payment of ([\d,.]+)/i)?.[1] ?? "").replace(/,/g, "")) || null;
  const method = m.match(/Method:\s*(.+)/i)?.[1]?.trim() ?? null;
  const reference = m.match(/Reference:\s*(.+)/i)?.[1]?.trim() ?? null;
  const paidOn = m.match(/Paid on:\s*(.+)/i)?.[1]?.trim() ?? null;
  const against = m.match(/Against invoices:\s*(.+)/i)?.[1] ?? "";
  const invoiceNumbers = against.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return { amount, method: method === "not stated" ? null : method, reference, paidOn, invoiceNumbers };
}

async function openInvoices(companyId: string) {
  const invs = await prisma.invoice.findMany({ where: { companyId, status: { in: OPEN } }, orderBy: [{ dueDate: "asc" }] });
  const out: { id: string; number: string; outstanding: number; dueDate: string | null; currency: string }[] = [];
  for (const inv of invs) {
    const paid = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    const outstanding = inv.amount - (paid._sum.amount ?? 0);
    if (outstanding > 0) out.push({ id: inv.id, number: inv.number, outstanding, dueDate: inv.dueDate, currency: inv.currency });
  }
  return out;
}

type Allocation = { invoiceId: string; number: string; amount: number; outstanding: number };

export function allocate(amount: number, invoices: Awaited<ReturnType<typeof openInvoices>>, quoted: string[]) {
  const quotedLc = quoted.map(q => q.toLowerCase());
  const named = invoices.filter(i => quotedLc.includes(i.number.toLowerCase()));
  const unknownNumbers = quoted.filter(q => !invoices.some(i => i.number.toLowerCase() === q.toLowerCase()));
  const fill = (list: typeof invoices) => {
    let left = amount; const alloc: Allocation[] = [];
    for (const i of list) { if (left <= 0) break; const a = Math.min(left, i.outstanding); alloc.push({ invoiceId: i.id, number: i.number, amount: a, outstanding: i.outstanding }); left -= a; }
    return { alloc, left };
  };
  if (named.length) {
    const { alloc, left } = fill(named);
    const covers = named.reduce((s, i) => s + i.outstanding, 0);
    return { how: "the invoice numbers the client quoted", confidence: amount === covers ? "high" : "medium", allocations: alloc, unallocated: left, shortBy: Math.max(0, covers - amount), unknownNumbers };
  }
  const exact = invoices.filter(i => i.outstanding === amount);
  if (exact.length === 1) return { how: "an invoice with exactly this amount outstanding", confidence: "high", allocations: [{ invoiceId: exact[0].id, number: exact[0].number, amount, outstanding: exact[0].outstanding }], unallocated: 0, shortBy: 0, unknownNumbers };
  const total = invoices.reduce((s, i) => s + i.outstanding, 0);
  if (invoices.length && total === amount) return { how: "the client's whole outstanding balance", confidence: "high", allocations: fill(invoices).alloc, unallocated: 0, shortBy: 0, unknownNumbers };
  if (invoices.length) {
    const { alloc, left } = fill(invoices);
    return { how: "oldest invoices first — no number or amount matched, so check this", confidence: "low", allocations: alloc, unallocated: left, shortBy: 0, unknownNumbers };
  }
  return { how: "nothing — this client has no open invoices", confidence: "none", allocations: [] as Allocation[], unallocated: amount, shortBy: 0, unknownNumbers };
}

export async function runCollections(onlyRequestId?: string) {
  const out = { considered: 0, matched: 0, details: [] as string[] };
  const notices = await prisma.serviceRequest.findMany({ where: { status: "open", type: "Payment notification", ...(onlyRequestId ? { id: onlyRequestId } : {}) }, take: 100 });
  for (const rq of notices) {
    if (!rq.companyId) continue;
    out.considered++;
    const task = await claimTask(KEY, `notice:${rq.id}`, { kind: "payment-match", title: `${rq.number ?? "Payment notice"} — ${rq.clientName ?? "client"}`, companyId: rq.companyId, refType: "serviceRequest", refId: rq.id });
    if (!task) continue;
    try {
      const n = parseNotice(rq.message);
      if (!n.amount) { await finishTask(task.id, "review", { summary: "The notice has no amount the agent could read. Match it by hand.", output: { notice: n } }); continue; }
      const invs = await openInvoices(rq.companyId);
      const m = allocate(n.amount, invs, n.invoiceNumbers);
      const currency = invs[0]?.currency ?? "SAR";
      const lines = m.allocations.map(a => `${a.number}: ${currency} ${a.amount.toLocaleString()}${a.amount < a.outstanding ? ` (part of ${a.outstanding.toLocaleString()})` : ""}`);
      await finishTask(task.id, "review", {
        summary: m.allocations.length
          ? `${currency} ${n.amount.toLocaleString()} → ${lines.join(", ")}. Matched on ${m.how}.${m.unallocated > 0 ? ` ${m.unallocated.toLocaleString()} left over.` : ""}`
          : `${currency} ${n.amount.toLocaleString()} reported, but ${m.how}.`,
        output: { notice: n, currency, match: m, checks: [
          { label: "Amount read from the notice", state: "ok", note: `${currency} ${n.amount.toLocaleString()}${n.reference ? ` · ref ${n.reference}` : ""}${n.paidOn ? ` · paid ${n.paidOn}` : ""}` },
          { label: "Matched invoices", state: m.confidence === "high" ? "ok" : m.allocations.length ? "flag" : "unknown", note: m.how },
          ...(m.unknownNumbers.length ? [{ label: "Invoice numbers not found", state: "flag", note: `${m.unknownNumbers.join(", ")} — not open on this client` }] : []),
          ...(m.unallocated > 0 && m.allocations.length ? [{ label: "More than is owed", state: "flag", note: `${currency} ${m.unallocated.toLocaleString()} does not fit any open invoice` }] : []),
          { label: "Funds received in the bank", state: "unknown", note: "Only the accountant can confirm the money actually landed." },
        ] },
      });
      out.matched++;
      out.details.push(`${rq.number}: ${m.confidence} — ${lines.join(", ") || "no match"}`);
    } catch (e: any) {
      await finishTask(task.id, "failed", { error: String(e?.message ?? e).slice(0, 1000) });
    }
  }
  return out;
}

/**
 * The sentence added to one overdue reminder. Null when the agent is off or the history says nothing
 * worth saying — the standard reminder is then sent unchanged.
 */
export async function reminderNote(inv: { id: string; number: string; companyId: string | null; clientName?: string | null; rung: number; promisedDate?: string | null; currency: string }) {
  if (!inv.companyId || !(await agentSetting(KEY)).enabled) return null;
  const history = await prisma.invoice.findMany({ where: { companyId: inv.companyId, status: "paid", NOT: { id: inv.id } }, orderBy: { date: "desc" }, take: 12, select: { id: true, dueDate: true } });
  const lateness: number[] = [];
  for (const h of history) {
    const due = parseDay(h.dueDate);
    const last = await prisma.payment.findFirst({ where: { invoiceId: h.id }, orderBy: { date: "desc" }, select: { date: true } });
    const paid = parseDay(last?.date);
    if (due !== null && paid !== null) lateness.push(Math.round((paid - due) / DAY));
  }
  const others = (await openInvoices(inv.companyId)).filter(i => i.id !== inv.id && parseDay(i.dueDate) !== null && parseDay(i.dueDate)! < Date.now());
  const promised = parseDay(inv.promisedDate);

  let note: string | null = null;
  let profile = "no history";
  if (promised !== null && promised < Date.now()) {
    profile = "broke a promise";
    note = `You told us to expect payment by ${new Date(promised).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, and we have not received it yet.`;
  } else if (lateness.length >= 3) {
    const onTime = lateness.filter(d => d <= 3).length / lateness.length;
    const avgLate = Math.round(lateness.filter(d => d > 0).reduce((a, b) => a + b, 0) / Math.max(1, lateness.filter(d => d > 0).length));
    if (onTime >= 0.75) { profile = "usually on time"; note = "Your invoices are almost always paid on time, so this one may simply have been missed."; }
    else if (avgLate >= 7) { profile = `usually ~${avgLate} days late`; note = `Your recent invoices have been settled about ${avgLate} days after their due date. Settling this one now avoids further reminders.`; }
  }
  if (others.length) {
    const total = others.reduce((s, i) => s + i.outstanding, 0);
    note = `${note ? note + " " : ""}You also have ${others.length} other overdue invoice${others.length === 1 ? "" : "s"}, ${inv.currency} ${total.toLocaleString()} in total.`;
  }
  if (!note) return null;
  const t = await claimTask(KEY, `reminder:${inv.id}:${inv.rung}`, { kind: "reminder", title: `Reminder — ${inv.number}${inv.clientName ? ` · ${inv.clientName}` : ""}`, companyId: inv.companyId, refType: "invoice", refId: inv.id });
  if (t) await finishTask(t.id, "done", { summary: `${inv.rung}-day reminder tailored (${profile}): "${note}"`, output: { profile, note, paidHistory: lateness } });
  return note;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That task no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This task is already ${t.status}.`, 409);
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  if (action !== "record") throw new AgentActionError("Unknown action.");

  await requirePerm(actor, "Finance", "Create", "record payments");
  const o = (t.output ?? {}) as any;
  const allocations: Allocation[] = o.match?.allocations ?? [];
  if (!allocations.length) throw new AgentActionError("Nothing was matched. Record this payment by hand from Invoices.");
  const recorded: string[] = [];
  for (const a of allocations) {
    const inv = await prisma.invoice.findUnique({ where: { id: a.invoiceId } });
    if (!inv) throw new AgentActionError(`${a.number} no longer exists.`, 409);
    const paid = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    const outstanding = inv.amount - (paid._sum.amount ?? 0);
    // Somebody may have recorded part of it since the match was made. Never over-settle.
    const amt = Math.min(a.amount, outstanding);
    if (amt <= 0) continue;
    const settled = (paid._sum.amount ?? 0) + amt >= inv.amount;
    const number = await nextNumber("receipt");
    await prisma.$transaction([
      prisma.payment.create({ data: {
        number, invoiceId: inv.id, invoiceNumber: inv.number, companyId: inv.companyId, clientName: inv.clientName, amount: amt,
        method: o.notice?.method ?? null, reference: o.notice?.reference ?? null,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.notice?.paidOn ?? "")) ? o.notice.paidOn : new Date().toISOString().slice(0, 10),
        notes: `Confirmed by ${actor.name} from the client's payment notice (collections agent match).`,
      } }),
      ...(settled && inv.status !== "paid" ? [prisma.invoice.update({ where: { id: inv.id }, data: { status: "paid" } })] : []),
    ]);
    recorded.push(`${inv.number} ${amt.toLocaleString()}${settled ? " (settled)" : ""}`);
    await logAudit({ action: "payment.record", actorId: actor.id, target: `${inv.number} (${number})`, detail: `amount=${amt} settled=${settled} via collections agent` });
    if (settled) logNotification({ type: "payment", title: `Payment received: ${inv.number}`, message: inv.clientName ?? undefined });
  }
  if (t.refId) await prisma.serviceRequest.update({ where: { id: t.refId }, data: { status: "resolved" } }).catch(() => {});
  logActivity({ type: "finance", message: `Payment notice confirmed: ${recorded.join(", ")}`, user: actor.name });
  await decide(t.id, "done", actor, { recorded });
  return { ok: true, message: recorded.length ? `Recorded ${recorded.join(", ")}.` : "Those invoices were already settled — nothing recorded." };
}
