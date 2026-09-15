/**
 * CRM AGENTS — leads, quotations, won deals and duplicate records.
 *
 * The scheduler already sends follow-up and quotation reminders to the owner (jobs.ts). These agents do
 * the other half: a queue a salesperson works through, which closes itself when the work is logged.
 * None of them sends anything, changes a stage, or merges a record.
 */
import { prisma } from "./db.js";
import { daysFromToday, normName } from "./agent-core.js";
import { runFindings, standardAct, groupBy, plural, money, today, addDays, check, LIST_MAX, type TaskLine } from "./agent-kit.js";

const OPEN_LEAD = ["lead", "prospect"];
const daysSince = (iso?: string | null) => { const d = daysFromToday(iso); return d === null ? null : -d; };
const userNames = async (ids: (string | null | undefined)[]) => {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  const rows = list.length ? await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
  return new Map(rows.map(u => [u.id, u.name]));
};

// ── 1. Lead follow-up ─────────────────────────────────────────────────────────────────────────

export const LEADS = "lead-followup";
const QUIET_DAYS = 7;

export async function runLeadFollowUp() {
  return runFindings(LEADS, ["call-list"], async raise => {
    const leads = await prisma.company.findMany({ where: { lifecycle: { in: OPEN_LEAD } }, select: { id: true, name: true, ownerId: true, createdAt: true, phone: true, contact: true, lifecycle: true }, take: 3000 });
    if (!leads.length) return ["No open leads or prospects."];
    const ids = leads.map(l => l.id);
    const touches = await prisma.interaction.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, cancelledAt: null }, _max: { at: true } });
    const lastTouch = new Map(touches.map(t => [t.companyId, t._max.at]));
    const due = await prisma.interaction.findMany({ where: { companyId: { in: ids }, nextActionAt: { lte: today() + "T23:59:59" }, nextActionDoneAt: null, cancelledAt: null, NOT: { nextAction: null } }, select: { companyId: true, nextAction: true, nextActionAt: true } });
    const dueBy = groupBy(due, d => d.companyId);
    const rows = leads.map(l => {
      const last = lastTouch.get(l.id) ?? null;
      const quiet = daysSince(last ?? l.createdAt);
      const commitments = dueBy.get(l.id) ?? [];
      const overdue = commitments.filter(c => (daysSince(c.nextActionAt) ?? 0) > 0);
      const reason = commitments.length ? `${commitments[0].nextAction} — ${overdue.length ? `${daysSince(overdue[0].nextActionAt)} days overdue` : "due today"}`
        : quiet !== null && quiet >= QUIET_DAYS ? (last ? `no contact for ${quiet} days` : `never contacted since added ${quiet} days ago`) : null;
      return { ...l, quiet, reason, urgent: overdue.length > 0 || (!last && (quiet ?? 0) >= QUIET_DAYS) };
    }).filter(r => r.reason);
    const names = await userNames(rows.map(r => r.ownerId));
    for (const [owner, list] of groupBy(rows, r => r.ownerId ?? "unassigned")) {
      list.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (b.quiet ?? 0) - (a.quiet ?? 0));
      const who = owner === "unassigned" ? "Unassigned leads" : names.get(owner) ?? "A former owner";
      await raise({
        kind: "call-list", key: `calls:${owner}`,
        title: `${who} — ${plural(list.length, "lead")} to call`,
        summary: owner === "unassigned" ? "Nobody owns these, so no salesperson sees them. Give each an owner, then call." : `${list.filter(l => l.urgent).length ? `${list.filter(l => l.urgent).length} overdue or never contacted, ` : ""}quiet for a week or more. The list closes itself as calls are logged.`.replace(/^q/, "Q"),
        output: {
          lists: [{ title: "Call in this order", items: list.slice(0, LIST_MAX).map(l => ({ text: `${l.name}${l.contact ? ` · ${l.contact}` : ""}${l.phone ? ` · ${l.phone}` : ""} — ${l.reason}` })) }],
          facts: [{ label: "Why these", value: `Open follow-ups that are due, and leads with no logged contact for ${QUIET_DAYS}+ days.` }],
        },
      });
    }
  });
}

// ── 2. Quotation chaser ───────────────────────────────────────────────────────────────────────

export const QUOTES = "quote-chaser";

export async function runQuoteChaser() {
  return runFindings(QUOTES, ["waiting", "lapsed"], async raise => {
    const quotes = await prisma.quotation.findMany({ where: { status: "sent", supersededAt: null }, take: 2000 });
    const cos = await prisma.company.findMany({ where: { id: { in: quotes.map(q => q.companyId).filter(Boolean) as string[] } }, select: { id: true, name: true, contact: true, phone: true, email: true } });
    const coOf = new Map(cos.map(c => [c.id, c]));
    for (const q of quotes) {
      const waited = daysSince(q.sentAt ?? q.date) ?? 0;
      const left = daysFromToday(q.validUntil);
      const value = q.totalMinor != null ? q.totalMinor / 100 : q.amount;
      const co = q.companyId ? coOf.get(q.companyId) : undefined;
      const facts = [
        { label: "Quoted", value: `${money(value)} · ${q.service ?? "services"}` },
        { label: "Sent", value: `${waited} days ago` },
        { label: "Valid until", value: q.validUntil ?? "not set" },
        ...(co ? [{ label: "Contact", value: [co.contact, co.phone, co.email].filter(Boolean).join(" · ") || "no contact on file" }] : []),
      ];
      if (left !== null && left < 0) {
        await raise({ kind: "lapsed", key: `lapsed:${q.id}`, companyId: q.companyId, refType: "quotation", refId: q.id,
          title: `${q.number} expired ${-left} days ago without an answer — ${q.clientName ?? "client"}`,
          summary: "Call to close it either way: re-issue with a new date, or record it as lost with the reason.",
          output: { facts, amount: value } });
      } else if (waited >= 3) {
        const step = waited >= 14 ? "Third follow-up: ask directly whether it is going ahead" : waited >= 7 ? "Second follow-up: offer to walk through the quotation" : "First follow-up: check it arrived and answer questions";
        await raise({ kind: "waiting", key: `waiting:${q.id}:${waited >= 14 ? 3 : waited >= 7 ? 2 : 1}`, companyId: q.companyId, refType: "quotation", refId: q.id,
          title: `${q.number} waiting ${waited} days — ${q.clientName ?? "client"}`,
          summary: `${step}.${left !== null ? ` It is valid for ${left} more day${left === 1 ? "" : "s"}.` : ""}`,
          output: { facts, amount: value, proposal: { text: step } } });
      }
    }
  });
}

// ── 3. Won deal → onboarding ──────────────────────────────────────────────────────────────────

export const WON = "won-onboarding";
const ONBOARD_WINDOW = 45;

export async function runWonOnboarding() {
  return runFindings(WON, ["start-delivery"], async raise => {
    const since = addDays(today(), -ONBOARD_WINDOW);
    const accepted = await prisma.quotation.findMany({ where: { status: { in: ["accepted", "invoiced"] }, supersededAt: null, OR: [{ date: { gte: since } }, { sentAt: { gte: since } }] }, take: 500 });
    const wonStages = (await prisma.pipelineStage.findMany({ where: { isWon: true }, select: { id: true } })).map(s => s.id);
    const won = wonStages.length ? await prisma.opportunity.findMany({ where: { stageId: { in: wonStages }, closedAt: { gte: since } }, select: { id: true, title: true, companyId: true, quotationId: true, ownerId: true, closedAt: true }, take: 500 }) : [];
    const companyIds = [...new Set([...accepted.map(q => q.companyId), ...won.map(o => o.companyId)].filter(Boolean) as string[])];
    if (!companyIds.length) return ["No deals won in the last 45 days."];
    const [cos, subs, portal, staffCount, tasksFromQuotes] = await Promise.all([
      prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, lifecycle: true, cr: true, email: true, ownerId: true, groupId: true } }),
      prisma.subscription.findMany({ where: { OR: [{ companyId: { in: companyIds } }, { scope: "company", refId: { in: companyIds } }] }, select: { companyId: true, refId: true, daysLeft: true } }),
      prisma.user.findMany({ where: { type: "portal", companyId: { in: companyIds } }, select: { companyId: true } }),
      prisma.employee.groupBy({ by: ["companyId"], where: { companyId: { in: companyIds }, archived: false }, _count: { _all: true } }),
      prisma.task.findMany({ where: { quotationId: { in: accepted.map(q => q.id) } }, select: { quotationId: true } }),
    ]);
    const started = new Set(tasksFromQuotes.map(t => t.quotationId));
    const invoiced = new Set((await prisma.invoice.findMany({ where: { quotationId: { in: accepted.map(q => q.id) } }, select: { quotationId: true } })).map(i => i.quotationId));
    for (const co of cos) {
      const quotes = accepted.filter(q => q.companyId === co.id);
      const deals = won.filter(o => o.companyId === co.id);
      const hasSub = subs.some(s => (s.companyId === co.id || s.refId === co.id) && (s.daysLeft ?? 0) > 0);
      const hasPortal = portal.some(p => p.companyId === co.id);
      const staff = staffCount.find(s => s.companyId === co.id)?._count._all ?? 0;
      const notStarted = quotes.filter(q => !started.has(q.id));
      const notInvoiced = quotes.filter(q => !invoiced.has(q.id));
      const checks = [
        check(co.lifecycle === "client" ? "ok" : "flag", "Marked as a client", co.lifecycle === "client" ? "Lifecycle is client." : `Still “${co.lifecycle}” — promote it so it is billed and counted.`),
        check(co.cr ? "ok" : "flag", "CR number", co.cr ? co.cr : "Missing — needed for a client record."),
        check(hasSub ? "ok" : "flag", "Package", hasSub ? "Has an active subscription." : "No active package yet."),
        check(hasPortal ? "ok" : "flag", "Portal access", hasPortal ? "A portal user exists." : "No portal user — the client cannot upload or follow requests."),
        check(staff ? "ok" : "flag", "Employees", staff ? `${staff} on file.` : "No employees imported yet."),
        check(notStarted.length ? "flag" : "ok", "Work started", notStarted.length ? `Nothing started for ${notStarted.map(q => q.number).join(", ")}.` : "Delivery is under way."),
        check(notInvoiced.length ? "flag" : "ok", "Invoiced", notInvoiced.length ? `${notInvoiced.map(q => q.number).join(", ")} not invoiced yet.` : "Invoiced."),
      ];
      const open = checks.filter(c => c.state === "flag");
      if (!open.length) continue;
      const due = addDays(today(), 3);
      const tasks: TaskLine[] = [
        ...(co.lifecycle !== "client" || !co.cr ? [{ title: `Onboarding: complete the client record for ${co.name} (CR, lifecycle)`, dueDate: due, assigneeId: co.ownerId }] : []),
        ...(!hasSub ? [{ title: `Onboarding: set up the package for ${co.name}`, dueDate: due, assigneeId: co.ownerId }] : []),
        ...(!hasPortal ? [{ title: `Onboarding: invite ${co.name} to the client portal`, dueDate: due, assigneeId: co.ownerId }] : []),
        ...(!staff ? [{ title: `Onboarding: import ${co.name}'s employees`, dueDate: addDays(today(), 7), assigneeId: co.ownerId }] : []),
        ...notStarted.map(q => ({ title: `Onboarding: start delivery of ${q.number} for ${co.name}`, dueDate: due, assigneeId: co.ownerId, items: [q.service ?? ""].filter(Boolean) })),
      ];
      await raise({
        kind: "start-delivery", key: `won:${co.id}`, companyId: co.id,
        title: `${co.name} said yes — ${plural(open.length, "thing")} to set up`,
        summary: `${[...quotes.map(q => q.number), ...deals.map(d => d.title)].slice(0, 4).join(", ")} won. Still open: ${open.map(c => c.label).join(", ")}.`,
        output: { checks, tasks, proposal: tasks.length ? { text: `Create ${plural(tasks.length, "onboarding task")} so none of this is forgotten.` } : undefined },
      });
    }
  });
}

// ── 4. Duplicate leads and clients ────────────────────────────────────────────────────────────

export const DUPES = "crm-duplicates";
const digits = (s?: string | null) => String(s ?? "").replace(/\D/g, "").slice(-9);

export async function runCrmDuplicates() {
  return runFindings(DUPES, ["duplicate-company", "duplicate-contact"], async raise => {
    const cos = await prisma.company.findMany({ where: { NOT: { lifecycle: { in: ["lost", "churned"] } } }, select: { id: true, name: true, cr: true, phone: true, email: true, lifecycle: true }, take: 10000 });
    const groups: { why: string; rows: typeof cos }[] = [];
    const add = (why: string, m: Map<string, typeof cos>) => { for (const [, rows] of m) if (new Set(rows.map(r => r.id)).size > 1) groups.push({ why, rows }); };
    add("same CR number", groupBy(cos, c => String(c.cr ?? "").replace(/\D/g, "").length >= 6 ? String(c.cr).replace(/\D/g, "") : null));
    add("same phone number", groupBy(cos, c => digits(c.phone).length === 9 ? digits(c.phone) : null));
    add("same email address", groupBy(cos, c => c.email && /@/.test(c.email) ? c.email.trim().toLowerCase() : null));
    add("same name", groupBy(cos, c => { const n = normName(c.name).filter(t => !["LLC", "EST", "CO", "LTD", "COMPANY", "TRADING"].includes(t)).join(" "); return n.length >= 6 ? n : null; }));
    const done = new Set<string>();
    for (const g of groups) {
      const ids = [...new Set(g.rows.map(r => r.id))].sort();
      const key = ids.join("+");
      if (done.has(key)) continue;
      done.add(key);
      await raise({
        kind: "duplicate-company", key: `co:${key}`, companyId: ids[0],
        title: `${ids.length} records look like the same company — ${g.rows[0].name}`,
        summary: `They share the ${g.why}. Keep one and move the others' contacts, deals and history onto it.`,
        output: { lists: [{ title: "Records", items: g.rows.map(r => ({ text: `${r.name} · ${r.lifecycle}${r.cr ? ` · CR ${r.cr}` : ""}${r.phone ? ` · ${r.phone}` : ""}${r.email ? ` · ${r.email}` : ""}` })) }] },
      });
    }
    const contacts = await prisma.contact.findMany({ where: { archived: false, NOT: { email: null } }, select: { id: true, name: true, email: true, companyId: true }, take: 20000 });
    const coName = new Map(cos.map(c => [c.id, c.name]));
    for (const [email, rows] of groupBy(contacts, c => c.email && /@/.test(c.email) ? c.email.trim().toLowerCase() : null)) {
      const companies = [...new Set(rows.map(r => r.companyId))];
      if (companies.length < 2 || /^(info|admin|hr|contact|sales|accounts)@/.test(email)) continue;
      await raise({
        kind: "duplicate-contact", key: `contact:${email}`, companyId: companies[0],
        title: `${email} is a contact at ${companies.length} companies`,
        summary: "Either one person moved jobs, or two company records are really one.",
        output: { lists: [{ title: "Where", items: rows.map(r => ({ text: `${r.name} · ${coName.get(r.companyId) ?? "another company"}` })) }] },
      });
    }
  });
}

export const actLeads = standardAct(LEADS, { module: "Sales", what: "close sales follow-ups" });
export const actQuotes = standardAct(QUOTES, { module: "Sales", what: "close quotation follow-ups" });
export const actWon = standardAct(WON, { module: "Sales", what: "close onboarding items" });
export const actDupes = standardAct(DUPES, { module: "Clients", what: "close duplicate findings" });
