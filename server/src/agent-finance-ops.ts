/**
 * FINANCE AGENTS — government fees paid on a client's behalf and never re-charged, and subscriptions
 * that are running without being billed.
 *
 * FEES, AND WHERE UNBILLED WORK ALREADY LOOKS. The Unbilled Work agent reads fees captured on renewal
 * WORKFLOW RUNS. Renewals recorded by hand — the renew dialog on a document, or a renewal done as a
 * plain task — write their fee into the document's history instead, and nothing read it back. This
 * agent reads that history, and skips any entry the Unbilled Work agent has already raised.
 *
 * Both only ever propose a DRAFT invoice, which the accountant approves.
 */
import { prisma } from "./db.js";
import { daysFromToday, normName } from "./agent-core.js";
import { runFindings, standardAct, plural, money, today, addDays, type InvoiceLine } from "./agent-kit.js";
import { ACTIVE_CLIENT } from "./validate.js";

// ── 18. Government fee recovery ───────────────────────────────────────────────────────────────

export const FEES = "fee-recovery";
const FEE_WINDOW = 120;

const mentions = (inv: { services: string | null; items: unknown; notes: string | null }, words: string[]) => {
  const text = `${inv.services ?? ""} ${JSON.stringify(inv.items ?? [])} ${inv.notes ?? ""}`.toUpperCase();
  return words.every(w => text.includes(w));
};

export async function runFeeRecovery() {
  return runFindings(FEES, ["fee"], async raise => {
    const since = addDays(today(), -FEE_WINDOW);
    const docs = await prisma.document.findMany({ where: { supersededAt: null }, select: { id: true, companyId: true, docType: true, person: true, employeeId: true, history: true }, take: 50000 });
    const entries = docs.flatMap(d => ((Array.isArray(d.history) ? d.history : []) as any[])
      .map((h, i) => ({ d, i, at: String(h?.at ?? "").slice(0, 10), fee: Number(h?.fee) || 0, receipt: h?.receipt ?? null, runId: h?.runId ?? h?.instanceId ?? null }))
      .filter(x => x.fee > 0 && x.at >= since && !x.runId));
    if (!entries.length) return ["No hand-recorded renewal fees in the last 120 days."];
    const cos = await prisma.company.findMany({ where: { id: { in: [...new Set(entries.map(e => e.d.companyId))] }, lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true } });
    const invoices = await prisma.invoice.findMany({ where: { companyId: { in: cos.map(c => c.id) }, date: { gte: since }, NOT: { status: "void" } }, select: { companyId: true, date: true, services: true, items: true, notes: true } });
    const unbilledOpen = await prisma.agentTask.findMany({ where: { agent: "unbilled-work", status: { in: ["review", "done"] } }, select: { companyId: true, output: true } });
    for (const e of entries) {
      const co = cos.find(c => c.id === e.d.companyId);
      if (!co) continue;
      const words = [...normName(e.d.docType).slice(0, 1), ...normName(e.d.person).slice(0, 1)];
      const billed = invoices.some(inv => inv.companyId === co.id && String(inv.date ?? "") >= e.at && mentions(inv, words));
      if (billed) continue;
      const already = unbilledOpen.some(u => u.companyId === co.id && JSON.stringify((u.output as any)?.lines ?? []).toUpperCase().includes(words.join(" ")));
      if (already) continue;
      const lines: InvoiceLine[] = [{ name: `${e.d.docType} renewal — government fee (${e.d.person})`, units: 1, price: e.fee }];
      await raise({
        kind: "fee", key: `fee:${e.d.id}:${e.i}`, companyId: co.id, employeeId: e.d.employeeId, refType: "document", refId: e.d.id,
        title: `${money(e.fee)} government fee for ${e.d.person}'s ${e.d.docType} was never re-charged — ${co.name}`,
        summary: `Paid on ${e.at}${e.receipt ? ` (receipt ${e.receipt})` : ""}. No invoice to ${co.name} since then mentions it. If the client's package covers government fees, dismiss it.`,
        output: { amount: e.fee, lines, facts: [{ label: "Recorded", value: e.at }, { label: "Fee", value: money(e.fee) }, ...(e.receipt ? [{ label: "Receipt", value: String(e.receipt) }] : [])], proposal: { text: "Raise a draft invoice for the fee." } },
      });
    }
  });
}

// ── 19. Subscription billing check ────────────────────────────────────────────────────────────

export const SUBS = "subscription-billing";
const CYCLE_DAYS: Record<string, number> = { monthly: 31, quarterly: 92, "semi-annual": 183, semiannual: 183, annual: 366, yearly: 366 };

export async function runSubscriptionBilling() {
  return runFindings(SUBS, ["not-billed", "addon-unbilled", "price-differs"], async raise => {
    const subs = await prisma.subscription.findMany({ where: { daysLeft: { gt: 0 } }, include: { package: { select: { name: true, basePrice: true, billingCycle: true } } } });
    if (!subs.length) return ["No active subscriptions."];
    for (const s of subs) {
      const companyId = s.companyId ?? (s.scope === "company" ? s.refId : null);
      if (!companyId) continue; // group subscriptions are billed to the group's lead client by the renewal job
      const co = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, lifecycle: true } });
      if (!co || co.lifecycle !== ACTIVE_CLIENT) continue;
      const cycle = CYCLE_DAYS[String(s.package.billingCycle).toLowerCase()] ?? 31;
      const recent = await prisma.invoice.findMany({ where: { companyId, date: { gte: addDays(today(), -(cycle + 7)) }, NOT: { status: "void" } }, select: { number: true, amount: true, services: true, items: true, notes: true, date: true } });
      const pkgWords = normName(s.package.name).slice(0, 2);
      const planInv = recent.filter(i => mentions(i, pkgWords));
      const started = s.startDate && (daysFromToday(s.startDate) ?? 0) <= -7;
      if (started && !recent.length && !s.custom) {
        await raise({ kind: "not-billed", key: `nobill:${s.id}:${s.lastBilledFor ?? "never"}`, companyId,
          title: `${co.name} has had no invoice for ${cycle + 7} days on an active ${s.package.name} plan`,
          summary: `Billed ${s.package.billingCycle} at ${money(s.price)}. Last billed period: ${s.lastBilledFor ?? "never"}.`,
          output: { amount: s.price, lines: [{ name: `${s.package.name} subscription`, units: 1, price: s.price }], facts: [{ label: "Plan", value: `${s.package.name} · ${s.package.billingCycle}` }, { label: "Price", value: money(s.price) }, { label: "Runs", value: `${s.startDate ?? "?"} → ${s.endDate ?? "?"}` }], proposal: { text: "Raise a draft invoice for this period, or check why the renewal job skipped it." } } });
      }
      if (planInv.length && !s.custom && planInv.every(i => i.amount !== s.price && Math.abs(i.amount - Math.round(s.price * 1.15)) > 1)) {
        await raise({ kind: "price-differs", key: `price:${s.id}:${planInv[0].number}`, companyId,
          title: `${co.name}'s last plan invoice ${planInv[0].number} is ${money(planInv[0].amount)}, the plan is ${money(s.price)}`,
          summary: "Neither the price nor the price with VAT. A discount nobody recorded, or the wrong package on the invoice.",
          output: { facts: [{ label: "Invoice", value: `${planInv[0].number} · ${planInv[0].date}` }, { label: "Plan price", value: money(s.price) }] } });
      }
      const addons = ((Array.isArray(s.addons) ? s.addons : []) as any[]).filter(a => a?.price > 0 && !a?.invoiceId);
      if (addons.length) {
        await raise({ kind: "addon-unbilled", key: `addons:${s.id}:${addons.map(a => a.serviceId).sort().join(",")}`, companyId,
          title: `${plural(addons.length, "add-on")} unlocked for ${co.name} with no invoice`,
          summary: `${addons.map(a => `${a.name} (${money(a.price)})`).join(", ")}. The service is in use and was never charged.`,
          output: { amount: addons.reduce((n, a) => n + Number(a.price), 0), lines: addons.map(a => ({ name: `${a.name} — add-on`, units: 1, price: Number(a.price) })), proposal: { text: "Raise a draft invoice for the add-ons." } } });
      }
    }
  });
}

export const actFees = standardAct(FEES, { module: "Finance", what: "close fee findings" });
export const actSubs = standardAct(SUBS, { module: "Finance", what: "close billing findings" });
