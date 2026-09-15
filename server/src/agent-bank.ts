/**
 * BANK RECONCILIATION.
 *
 * The accountant downloads the bank statement and ticks each deposit against an invoice by eye. This
 * agent reads the statement (CSV, from any Saudi bank's export — the columns are found by their
 * headings, in English or Arabic) and, for every deposit:
 *   · recognises one already recorded as a payment, and marks it so, with nothing to do;
 *   · otherwise works out whose money it is and which invoices it pays — by an invoice number written in
 *     the transfer, by a client's payment notice with the same reference, by the client's name with the
 *     exact amount owed, or, least surely, by an amount only one open invoice matches;
 *   · lists the deposits it cannot place, so nothing arrives unexplained.
 *
 * NOTHING IS RECORDED BY ITSELF. Each match is a proposal the accountant confirms, exactly as with a
 * payment notice. A statement uploaded twice, or two overlapping statements, import each line once.
 * Money going out is kept for the record and not matched.
 *
 * No model: every match is text and arithmetic, and each says which rule made it.
 */
import crypto from "node:crypto";
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, normName, type AgentActor } from "./agent-core.js";
import { allocate } from "./agent-collections.js";
import { nextNumber } from "./sequence.js";
import { homeCurrency } from "./orgsettings.js";
import { logActivity, logAudit, logNotification } from "./auth.js";

export const KEY = "bank-reconciliation";
const OPEN = ["pending", "unpaid", "sent", "overdue"];
export class StatementError extends Error { constructor(message: string, public status = 400) { super(message); } }

// ── reading the file ──────────────────────────────────────────────────────────────────────────

export function splitCsv(text: string) {
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) ?? "";
  const delim = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(x => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(x => x.trim())) rows.push(row);
  return rows.map(r => r.map(x => x.trim()));
}

const HEAD = {
  // No \b: an English word boundary never matches around Arabic letters, so التاريخ would be missed.
  date: /(^|[^a-z])date|تاريخ/i,
  description: /(description|details|narration|particulars|remarks|beneficiary|البيان|الوصف|التفاصيل)/i,
  reference: /(reference|ref\.?|cheque|transaction id|رقم المرجع|المرجع)/i,
  credit: /(credit|deposit|money in|دائن|إيداع|ايداع)/i,
  debit: /(debit|withdrawal|money out|مدين|سحب)/i,
  amount: /^(amount|المبلغ|transaction amount)$/i,
};

function toMinor(raw: string): number | null {
  if (!raw) return null;
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw) || /-$/.test(raw) || /\bDR\b/i.test(raw);
  const n = Number(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || !raw.match(/\d/)) return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}
const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let r = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (r) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3})[A-Za-z]*[-/. ](\d{2,4})/))) { d = +r[1]; m = MON[r[2].toLowerCase()]; y = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) { d = +r[1]; m = +r[2]; y = +r[3]; if (m > 12 && d <= 12) [d, m] = [m, d]; } // Saudi exports are day first
  else return null;
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, (m || 0) - 1, d));
  return m && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

export function parseStatement(text: string) {
  const rows = splitCsv(text.replace(/^﻿/, ""));
  // The heading row is the first one naming a date column and some money column; banks put titles above it.
  const hi = rows.findIndex(r => r.some(c => HEAD.date.test(c)) && r.some(c => HEAD.credit.test(c) || HEAD.amount.test(c) || HEAD.debit.test(c)));
  if (hi < 0) throw new StatementError("Could not find the column headings. The statement needs Date, Description and Credit/Debit (or Amount) columns — export it from your bank as CSV.");
  const h = rows[hi];
  const col = (re: RegExp, not?: RegExp) => h.findIndex(c => re.test(c) && !(not && not.test(c)));
  const ci = { date: col(HEAD.date), description: col(HEAD.description), reference: col(HEAD.reference), credit: col(HEAD.credit), debit: col(HEAD.debit), amount: col(HEAD.amount) };
  if (ci.credit < 0 && ci.amount < 0) throw new StatementError("The statement has no Credit or Amount column.");
  const lines: { date: string; description: string; reference: string | null; amountMinor: number }[] = [];
  let skipped = 0;
  for (const r of rows.slice(hi + 1)) {
    const date = toIsoDate(r[ci.date] ?? "");
    let amount: number | null = null;
    if (ci.credit >= 0 && toMinor(r[ci.credit] ?? "")) amount = Math.abs(toMinor(r[ci.credit])!);
    else if (ci.debit >= 0 && toMinor(r[ci.debit] ?? "")) amount = -Math.abs(toMinor(r[ci.debit])!);
    else if (ci.amount >= 0) amount = toMinor(r[ci.amount] ?? "");
    if (!date || !amount) { skipped++; continue; }
    const description = [ci.description >= 0 ? r[ci.description] : "", ...r.filter((_, i) => ![ci.date, ci.description, ci.reference, ci.credit, ci.debit, ci.amount].includes(i) && /[A-Za-z؀-ۿ]/.test(r[i] ?? ""))].filter(Boolean).join(" · ").slice(0, 2000);
    lines.push({ date, description, reference: ci.reference >= 0 ? (r[ci.reference] || null) : null, amountMinor: amount });
  }
  return { lines, skipped };
}

// ── matching ──────────────────────────────────────────────────────────────────────────────────

type OpenInv = { id: string; number: string; outstanding: number; dueDate: string | null; currency: string; companyId: string };

async function openInvoicesAll(): Promise<OpenInv[]> {
  const invs = await prisma.invoice.findMany({ where: { status: { in: OPEN }, NOT: { companyId: null } }, orderBy: { dueDate: "asc" } });
  const paid = await prisma.payment.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: invs.map(i => i.id) } }, _sum: { amount: true } });
  const paidBy = new Map(paid.map(p => [p.invoiceId, p._sum.amount ?? 0]));
  return invs.map(i => ({ id: i.id, number: i.number, outstanding: i.amount - (paidBy.get(i.id) ?? 0), dueDate: i.dueDate, currency: i.currency, companyId: i.companyId! })).filter(i => i.outstanding > 0);
}
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const STOP = new Set(["LLC", "LLP", "EST", "ESTABLISHMENT", "COMPANY", "TRADING", "CO", "LTD", "LIMITED", "GROUP", "FOR", "AND", "THE", "SERVICES", "CONTRACTING", "INTERNATIONAL"]);
const nameTokens = (s: string) => normName(s).filter(t => t.length >= 3 && !STOP.has(t));

async function proposeFor(line: { id: string; date: string; description: string; reference: string | null; amountMinor: number; currency: string }, ctx: { invoices: OpenInv[]; companies: { id: string; name: string }[] }) {
  const text = `${line.description} ${line.reference ?? ""}`;
  const whole = line.amountMinor / 100;

  // Already recorded? Same amount within five days, and either the reference or the client matches.
  const near = await prisma.payment.findMany({ where: { amount: Math.round(whole), date: { gte: shift(line.date, -5), lte: shift(line.date, 5) } } });
  const recorded = near.find(p => (p.reference && line.reference && squash(p.reference).includes(squash(line.reference))) || (p.reference && squash(text).includes(squash(p.reference)) && squash(p.reference).length >= 5) || (p.clientName && nameTokens(p.clientName).some(t => normName(text).includes(t))));
  if (recorded) return { recorded };

  // Whose money: an invoice number, a payment notice reference, the client's name, or a unique amount.
  const byNumber = ctx.invoices.filter(i => squash(text).includes(squash(i.number)));
  let companyId: string | null = byNumber[0]?.companyId ?? null;
  let how = byNumber.length ? `the invoice number${byNumber.length > 1 ? "s" : ""} ${byNumber.map(i => i.number).join(", ")} in the transfer` : "";
  let confidence = byNumber.length ? "high" : "none";
  if (!companyId && line.reference) {
    const notices = await prisma.serviceRequest.findMany({ where: { type: "Payment notification", status: "open" }, select: { companyId: true, message: true, number: true } });
    const n = notices.find(x => squash(x.message ?? "").includes(squash(line.reference!)) && squash(line.reference!).length >= 5);
    if (n?.companyId) { companyId = n.companyId; how = `the reference matches the client's payment notice ${n.number ?? ""}`.trim(); confidence = "high"; }
  }
  if (!companyId) {
    const words = new Set(normName(text));
    const named = ctx.companies.filter(c => { const t = nameTokens(c.name); return t.length && (t.filter(x => words.has(x)).length >= Math.min(2, t.length)); });
    if (named.length === 1) {
      companyId = named[0].id;
      const owed = ctx.invoices.filter(i => i.companyId === companyId);
      const exact = owed.some(i => i.outstanding === whole) || owed.reduce((s, i) => s + i.outstanding, 0) === whole;
      how = `the client's name in the transfer${exact ? " and the exact amount owed" : ""}`;
      confidence = exact ? "high" : "medium";
    }
  }
  if (!companyId) {
    const same = ctx.invoices.filter(i => i.outstanding === whole);
    if (same.length === 1) { companyId = same[0].companyId; how = "an amount only one open invoice is owed — nothing in the transfer names the client, so check it"; confidence = "low"; }
  }
  if (!companyId) return { companyId: null };
  const mine = ctx.invoices.filter(i => i.companyId === companyId);
  const m = allocate(Math.round(whole), mine, byNumber.map(i => i.number));
  return { companyId, how, confidence, match: m };
}
const shift = (iso: string, days: number) => new Date(Date.parse(iso + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);

/** Match every deposit still waiting. Used after an upload and once a day (new invoices may place old deposits). */
export async function runBank(onlyStatementId?: string) {
  const out = { considered: 0, recorded: 0, proposed: 0, unmatched: 0 };
  const lines = await prisma.bankLine.findMany({ where: { status: { in: ["unmatched", "proposed"] }, amountMinor: { gt: 0 }, ...(onlyStatementId ? { statementId: onlyStatementId } : {}) }, orderBy: { date: "asc" } });
  if (!lines.length) { await markRun(KEY); return out; }
  const invoices = await openInvoicesAll();
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const nameOf = new Map(companies.map(c => [c.id, c.name]));
  const unmatchedBy = new Map<string, typeof lines>();
  const seenProposals = new Set<string>();

  for (const line of lines) {
    out.considered++;
    const p = await proposeFor(line, { invoices, companies });
    if ("recorded" in p && p.recorded) {
      await prisma.bankLine.update({ where: { id: line.id }, data: { status: "recorded", paymentIds: [p.recorded.id] as any, note: `Already recorded as ${p.recorded.number ?? "a payment"}${p.recorded.invoiceNumber ? ` on ${p.recorded.invoiceNumber}` : ""}` } });
      out.recorded++;
      continue;
    }
    const cur = line.currency;
    const amt = (line.amountMinor / 100).toLocaleString();
    if (!p.companyId || !("match" in p) || !p.match?.allocations.length) {
      unmatchedBy.set(line.statementId, [...(unmatchedBy.get(line.statementId) ?? []), line]);
      if (line.status !== "unmatched") await prisma.bankLine.update({ where: { id: line.id }, data: { status: "unmatched" } });
      out.unmatched++;
      continue;
    }
    const m = p.match;
    const key = `line:${line.id}`;
    seenProposals.add(key);
    await upsertFinding(KEY, key, {
      kind: "bank-match", companyId: p.companyId, refType: "bankLine", refId: line.id,
      title: `${cur} ${amt} on ${line.date} → ${nameOf.get(p.companyId)}`,
      summary: `${m.allocations.map(a => `${a.number}: ${a.amount.toLocaleString()}`).join(", ")}. Matched on ${p.how}.${m.unallocated > 0 ? ` ${m.unallocated.toLocaleString()} does not fit an open invoice.` : ""}`,
      output: {
        lineId: line.id, currency: cur, match: m, confidence: p.confidence,
        notice: { method: "Bank transfer", reference: line.reference || line.description.slice(0, 80), paidOn: line.date },
        facts: [{ label: "Bank line", value: `${line.date} · ${cur} ${amt}` }, { label: "Transfer text", value: line.description || "—" }, ...(line.reference ? [{ label: "Reference", value: line.reference }] : [])],
        checks: [
          { label: "Whose money", state: p.confidence === "high" ? "ok" : "flag", note: `${nameOf.get(p.companyId)} — ${p.how}` },
          ...(m.unknownNumbers?.length ? [{ label: "Invoice numbers not open", state: "flag", note: m.unknownNumbers.join(", ") }] : []),
          ...(m.unallocated > 0 ? [{ label: "More than is owed", state: "flag", note: `${m.unallocated.toLocaleString()} left over — an advance, or someone else's money` }] : []),
        ],
      },
    });
    if (line.status !== "proposed") await prisma.bankLine.update({ where: { id: line.id }, data: { status: "proposed" } });
    out.proposed++;
  }

  // One list per statement of the deposits nobody could place.
  const seenGroups = new Set<string>();
  for (const [sid, list] of unmatchedBy) {
    const key = `unmatched:${sid}`;
    seenGroups.add(key);
    await upsertFinding(KEY, key, {
      kind: "bank-unmatched", refType: "bankStatement", refId: sid,
      title: `${list.length} deposit${list.length === 1 ? "" : "s"} could not be matched — ${list[0].fileName ?? "bank statement"}`,
      summary: "No invoice number, payment notice, client name or unique amount placed these. Record them by hand from Invoices, or leave them if they are not client payments.",
      output: { lists: [{ title: "Deposits", items: list.map(l => ({ text: `${l.date} · ${l.currency} ${(l.amountMinor / 100).toLocaleString()} · ${l.description.slice(0, 120)}${l.reference ? ` · ref ${l.reference}` : ""}` })) }], lineIds: list.map(l => l.id) },
    });
  }
  if (!onlyStatementId) {
    await closeMissing(KEY, "bank-match", seenProposals, "No longer needs matching");
    await closeMissing(KEY, "bank-unmatched", seenGroups, "All deposits placed");
  }
  await markRun(KEY);
  return out;
}

export async function importStatement(input: { fileName: string; text: string; actor: AgentActor }) {
  await requirePerm(input.actor, "Finance", "Create", "import bank statements");
  if (!input.text || input.text.length > 3_000_000) throw new StatementError("Upload a CSV bank statement under 3 MB.");
  const { lines, skipped } = parseStatement(input.text);
  if (!lines.length) throw new StatementError("No transactions were found under the headings.");
  const statementId = `st_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const currency = await homeCurrency();
  const seenInFile = new Map<string, number>();
  let added = 0, duplicates = 0;
  for (const l of lines) {
    const base = `${l.date}|${l.amountMinor}|${squash(l.description).slice(0, 120)}|${squash(l.reference ?? "")}`;
    const nth = (seenInFile.get(base) ?? 0) + 1;
    seenInFile.set(base, nth);
    const fingerprint = crypto.createHash("sha256").update(`${base}|${nth}`).digest("hex");
    try {
      await prisma.bankLine.create({ data: { statementId, fileName: input.fileName.slice(0, 200), ...l, currency, fingerprint, status: l.amountMinor > 0 ? "unmatched" : "ignored", note: l.amountMinor > 0 ? null : "Money out — not matched", uploadedBy: input.actor.id, createdAt: new Date().toISOString() } });
      added++;
    } catch (e: any) {
      if (e?.code === "P2002") duplicates++; else throw e;
    }
  }
  const result = added ? await runBank(statementId) : { considered: 0, recorded: 0, proposed: 0, unmatched: 0 };
  await logAudit({ action: "bank.statement.import", actorId: input.actor.id, target: statementId, detail: `${input.fileName}: ${added} new, ${duplicates} already imported, ${skipped} unreadable` });
  return { statementId, lines: lines.length, added, duplicates, skipped, ...result };
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That item no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This item is already ${t.status}.`, 409);
  const o = (t.output ?? {}) as any;
  if (action === "dismiss") {
    await requirePerm(actor, "Finance", "Edit", "set bank lines aside");
    const ids: string[] = o.lineIds ?? (o.lineId ? [o.lineId] : []);
    await prisma.bankLine.updateMany({ where: { id: { in: ids } }, data: { status: "ignored", decidedBy: actor.id, decidedAt: new Date().toISOString(), note: "Set aside — not a client payment" } });
    return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || "Not a client payment" });
  }
  if (action !== "record") throw new AgentActionError("Unknown action.");
  await requirePerm(actor, "Finance", "Create", "record payments");
  const line = await prisma.bankLine.findUnique({ where: { id: o.lineId } });
  if (!line || !["proposed", "unmatched"].includes(line.status)) throw new AgentActionError("That bank line has already been dealt with.", 409);
  const recorded: string[] = [], paymentIds: string[] = [];
  for (const a of (o.match?.allocations ?? []) as { invoiceId: string; number: string; amount: number }[]) {
    const inv = await prisma.invoice.findUnique({ where: { id: a.invoiceId } });
    if (!inv) continue;
    const paid = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    const amt = Math.min(a.amount, inv.amount - (paid._sum.amount ?? 0));
    if (amt <= 0) continue;
    const settled = (paid._sum.amount ?? 0) + amt >= inv.amount;
    const number = await nextNumber("receipt");
    const [payment] = await prisma.$transaction([
      prisma.payment.create({ data: { number, invoiceId: inv.id, invoiceNumber: inv.number, companyId: inv.companyId, clientName: inv.clientName, amount: amt, method: "Bank transfer", reference: (line.reference || line.description).slice(0, 180), date: line.date, notes: `From the bank statement line of ${line.date}, confirmed by ${actor.name} (bank reconciliation agent).` } }),
      ...(settled && inv.status !== "paid" ? [prisma.invoice.update({ where: { id: inv.id }, data: { status: "paid" } })] : []),
    ]);
    paymentIds.push(payment.id);
    recorded.push(`${inv.number} ${amt.toLocaleString()}${settled ? " (settled)" : ""}`);
    await logAudit({ action: "payment.record", actorId: actor.id, target: `${inv.number} (${number})`, detail: `amount=${amt} settled=${settled} via bank reconciliation` });
    if (settled) logNotification({ type: "payment", title: `Payment received: ${inv.number}`, message: inv.clientName ?? undefined });
  }
  if (!recorded.length) throw new AgentActionError("Those invoices are already settled — nothing to record.", 409);
  await prisma.bankLine.update({ where: { id: line.id }, data: { status: "matched", paymentIds: paymentIds as any, decidedBy: actor.id, decidedAt: new Date().toISOString() } });
  // The client's own "I've paid" notice for this money is answered by the bank, not left open.
  const notices = await prisma.agentTask.findMany({ where: { agent: "collections", kind: "payment-match", status: "review", companyId: t.companyId } });
  for (const n of notices) {
    const no = (n.output ?? {}) as any;
    if (Number(no.notice?.amount) === Math.round(line.amountMinor / 100)) {
      await prisma.agentTask.update({ where: { id: n.id }, data: { status: "done", decidedAt: new Date().toISOString(), decision: { auto: "Recorded from the bank statement" } as any } });
      if (n.refId) await prisma.serviceRequest.update({ where: { id: n.refId }, data: { status: "resolved" } }).catch(() => {});
    }
  }
  logActivity({ type: "finance", message: `Bank deposit of ${line.date} recorded: ${recorded.join(", ")}`, user: actor.name });
  await decide(t.id, "done", actor, { recorded });
  return { ok: true, message: `Recorded ${recorded.join(", ")}.` };
}

