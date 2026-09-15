/**
 * UNBILLED WORK.
 *
 * Nothing in the system joins an invoice to the work it bills: an invoice knows its client and its
 * quotation at most. So work gets done and never charged, and nobody can see it. Once a day this agent
 * looks for three kinds of it, and proposes a draft invoice for each:
 *   · a quotation the client ACCEPTED that was never turned into an invoice;
 *   · a client request that was delivered, for a service outside the client's plan, with no invoice
 *     for that service since it was accepted;
 *   · a finished renewal — for a service outside the plan, or where a government fee was recorded on
 *     the run — with no invoice for it since it started.
 *
 * It never raises an invoice by itself. "Create draft invoice" makes a DRAFT the accountant still
 * reviews and approves, so a wrong proposal costs one click to throw away, not a client's trust. A
 * finding dismissed as "covered by the agreement" stays dismissed.
 *
 * "No invoice for it" is judged by name, because there is no link to judge by: an invoice to the same
 * client, on or after the work began, whose service text or line items name the service (or, for a
 * renewal, the document type and the person). That errs towards silence — an unrelated invoice that
 * happens to mention the service hides a finding — which is the right way to be wrong about money.
 */
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, entitledServiceIds, type AgentActor } from "./agent-core.js";
import { nextNumber } from "./sequence.js";
import { figuresFromAmount } from "./money.js";
import { homeCurrency } from "./orgsettings.js";
import { logActivity, logAudit } from "./auth.js";
import { ACTIVE_CLIENT } from "./validate.js";

export const KEY = "unbilled-work";
const LOOKBACK_DAYS = 180;
/** Fee variables the renewal workflows capture when an officer records what the government charged. */
const GOV_FEE_VARS = ["feeAmount", "mcFee", "premium", "govFee", "governmentFee"];

type Line = { name: string; units: number; price: number };

/**
 * Which of a client's deliveries of one thing are covered by an invoice. There is no link, so each
 * invoice naming the thing covers deliveries on or before its date — first one whose person it also
 * names, otherwise the oldest — one per unit on its matching lines (or one, if no line says). Two
 * deliveries and one invoice leaves one unbilled.
 */
async function uncovered<T extends { at: string; hint?: string | null }>(companyId: string, deliveries: T[], words: string[]): Promise<T[]> {
  const want = words.map(w => w.toLowerCase()).filter(w => w.length > 2);
  if (!want.length || !deliveries.length) return deliveries;
  const names = (i: { services: string | null; items: unknown }) => `${i.services ?? ""} ${JSON.stringify(i.items ?? [])}`.toLowerCase();
  const invs = (await prisma.invoice.findMany({ where: { companyId, NOT: { status: "void" } }, select: { date: true, services: true, items: true } }))
    .filter(i => want.every(w => names(i).includes(w)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const open = [...deliveries].sort((a, b) => a.at.localeCompare(b.at));
  for (const inv of invs) {
    const lines = (Array.isArray(inv.items) ? inv.items : []) as any[];
    const units = lines.filter(l => want.every(w => String(l?.name ?? "").toLowerCase().includes(w))).reduce((n, l) => n + (Number(l.units) || 1), 0) || 1;
    for (let u = 0; u < units; u++) {
      const eligible = (d: T) => d.at.slice(0, 10) <= String(inv.date ?? "9999");
      const text = names(inv);
      const named = open.findIndex(d => eligible(d) && !!d.hint && d.hint.length > 2 && text.includes(d.hint.toLowerCase()));
      const idx = named >= 0 ? named : open.findIndex(eligible);
      if (idx < 0) break;
      open.splice(idx, 1);
    }
  }
  return open;
}

export async function runUnbilled() {
  const out = { found: 0, closed: 0, details: [] as string[] };
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const clients = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true } });
  const nameOf = new Map(clients.map(c => [c.id, c.name]));
  const services = await prisma.serviceItem.findMany({ select: { id: true, name: true, govFee: true, serviceFee: true, workflowId: true, docType: true } });
  const entitled = new Map<string, Set<string>>();
  const planHas = async (companyId: string, serviceId: string) => {
    if (!entitled.has(companyId)) entitled.set(companyId, await entitledServiceIds(companyId));
    return entitled.get(companyId)!.has(serviceId);
  };
  const seen = new Set<string>();
  const raise = async (key: string, d: { title: string; summary: string; companyId: string; refType: string; refId: string; output: unknown }) => {
    seen.add(key);
    const r = await upsertFinding(KEY, key, { kind: "unbilled", ...d });
    if (r.opened) { out.found++; out.details.push(d.title); }
  };

  // 1. Accepted quotations never invoiced.
  const quotes = await prisma.quotation.findMany({ where: { status: "accepted", companyId: { in: [...nameOf.keys()] } } });
  for (const q of quotes) {
    if (await prisma.invoice.findFirst({ where: { quotationId: q.id }, select: { id: true } })) continue;
    const tasks = await prisma.task.findMany({ where: { quotationId: q.id }, select: { status: true } });
    const done = tasks.filter(t => t.status === "done").length;
    const total = q.totalMinor != null ? q.totalMinor / 100 : q.amount;
    if (!(total > 0)) continue;
    await raise(`quote:${q.id}`, {
      title: `${q.number} accepted but never invoiced — ${nameOf.get(q.companyId!)}`,
      summary: `${q.service ?? "Quotation"} for ${total.toLocaleString()} was accepted${tasks.length ? `; ${done} of ${tasks.length} task${tasks.length === 1 ? "" : "s"} done` : ""}. No invoice has been raised from it.`,
      companyId: q.companyId!, refType: "quotation", refId: q.id,
      output: { source: "quotation", quotationId: q.id, amount: total, lines: (q.items ?? []) as any, facts: [
        { label: "Quotation", value: `${q.number} · ${q.service ?? ""}` }, { label: "Amount", value: total.toLocaleString() }, { label: "Work", value: tasks.length ? `${done} of ${tasks.length} tasks done` : "No tasks linked" },
      ] },
    });
  }

  // 2. Delivered requests for services outside the plan.
  const requests = await prisma.serviceRequest.findMany({ where: { companyId: { in: [...nameOf.keys()] }, serviceItemId: { not: null }, acceptedAt: { gte: since } } });
  const deliveredRequests = new Map<string, { at: string; rq: typeof requests[number]; completedAt: string | null; hint: string | null }[]>();
  for (const rq of requests) {
    const svc = services.find(s => s.id === rq.serviceItemId);
    if (!svc || svc.govFee + svc.serviceFee <= 0) continue;
    const run = rq.workflowInstanceId ? await prisma.workflowInstance.findUnique({ where: { id: rq.workflowInstanceId }, select: { status: true, completedAt: true, title: true, variables: true } }) : null;
    const delivered = run ? run.status === "completed" : String(rq.status).toLowerCase() === "resolved";
    if (!delivered || await planHas(rq.companyId!, svc.id)) continue;
    // Who the work was for, when the run says: "Exit visa — Nora" → "Nora".
    const person = String((run?.variables as any)?.person ?? run?.title?.split("—")[1] ?? "").trim().split(/\s+/)[0] || null;
    const quoted = await prisma.quotation.findFirst({ where: { companyId: rq.companyId, status: { in: ["accepted", "invoiced", "sent", "approved"] }, service: { contains: svc.name } } });
    if (quoted) continue; // billed, or being billed, through a quotation
    const k = `${rq.companyId}|${svc.id}`;
    deliveredRequests.set(k, [...(deliveredRequests.get(k) ?? []), { at: rq.acceptedAt!, rq, completedAt: run?.completedAt ?? null, hint: person }]);
  }
  for (const [k, list] of deliveredRequests) {
    const [companyId, serviceId] = k.split("|");
    const svc = services.find(s => s.id === serviceId)!;
    for (const { rq, completedAt } of await uncovered(companyId, list, [svc.name])) {
    const run = { completedAt };
    const lines: Line[] = [...(svc.govFee ? [{ name: `${svc.name} — government fee`, units: 1, price: svc.govFee }] : []), ...(svc.serviceFee ? [{ name: `${svc.name} — service fee`, units: 1, price: svc.serviceFee }] : [])];
    await raise(`request:${rq.id}`, {
      title: `${svc.name} delivered, not invoiced — ${nameOf.get(rq.companyId!)}`,
      summary: `${rq.number ?? "A request"} for ${svc.name} was delivered${run?.completedAt ? ` on ${run.completedAt.slice(0, 10)}` : ""}. The service is not in the client's plan, and no invoice for it has been raised since it was accepted.`,
      companyId: rq.companyId!, refType: "serviceRequest", refId: rq.id,
      output: { source: "request", serviceName: svc.name, amount: svc.govFee + svc.serviceFee, lines, facts: [
        { label: "Request", value: `${rq.number ?? ""} · ${svc.name}` }, { label: "In the client's plan", value: "No" }, { label: "Price list", value: `government ${svc.govFee.toLocaleString()} + service ${svc.serviceFee.toLocaleString()}` },
      ] },
    });
    }
  }

  // 3. Finished renewals.
  const runs = await prisma.workflowInstance.findMany({ where: { status: "completed", completedAt: { gte: since }, companyId: { in: [...nameOf.keys()] } } });
  for (const run of runs) {
    const v = (run.variables ?? {}) as any;
    if (v._trigger !== "document_expiry") continue;
    const svc = services.find(s => s.workflowId === run.templateId);
    const captured = GOV_FEE_VARS.map(k => Number(v[k])).find(n => Number.isFinite(n) && n > 0) ?? 0;
    const inPlan = svc ? await planHas(run.companyId!, svc.id) : false;
    let lines: Line[] = [];
    let why = "";
    if (svc && !inPlan) {
      const gov = captured || svc.govFee;
      lines = [...(gov ? [{ name: `${svc.name} — government fee${v.person ? ` (${v.person})` : ""}`, units: 1, price: gov }] : []), ...(svc.serviceFee ? [{ name: `${svc.name} — service fee`, units: 1, price: svc.serviceFee }] : [])];
      why = "The service is not in the client's plan.";
    } else if (captured) {
      lines = [{ name: `${v.docType ?? svc?.name ?? "Renewal"} — government fee${v.person ? ` (${v.person})` : ""}`, units: 1, price: captured }];
      why = svc ? "The service is in the client's plan, but a government fee was recorded on the renewal and has not been re-charged." : "A government fee was recorded on the renewal and has not been re-charged.";
    }
    const total = lines.reduce((s, l) => s + l.price * l.units, 0);
    if (!(total > 0)) continue;
    const words = svc && !inPlan ? [svc.name, String(v.person ?? "").split(" ")[0]] : [String(v.docType ?? ""), String(v.person ?? "").split(" ")[0]];
    if (!(await uncovered(run.companyId!, [{ at: run.startedAt ?? since }], words.filter(Boolean))).length) continue;
    await raise(`run:${run.id}`, {
      title: `${run.title} finished, not invoiced — ${nameOf.get(run.companyId!)}`,
      summary: `Completed ${run.completedAt?.slice(0, 10) ?? ""}. ${why} Proposed: ${total.toLocaleString()}.`,
      companyId: run.companyId!, refType: "workflowInstance", refId: run.id,
      output: { source: "renewal", amount: total, lines, facts: [
        { label: "Renewal", value: run.title }, { label: "In the client's plan", value: svc ? (inPlan ? "Yes" : "No") : "No service linked to this workflow" },
        ...(captured ? [{ label: "Government fee recorded on the run", value: captured.toLocaleString() }] : []),
      ] },
    });
  }

  out.closed = await closeMissing(KEY, "unbilled", seen, "Invoiced, or no longer unbilled");
  await markRun(KEY);
  return out;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That finding no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This finding is already ${t.status}.`, 409);
  if (action === "dismiss") {
    await requirePerm(actor, "Finance", "Edit", "close billing findings");
    return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || "Covered by the client's agreement" });
  }
  if (action !== "invoice") throw new AgentActionError("Unknown action.");
  await requirePerm(actor, "Finance", "Create", "raise invoices");
  const o = (t.output ?? {}) as any;
  const today = new Date().toISOString().slice(0, 10);
  const company = t.companyId ? await prisma.company.findUnique({ where: { id: t.companyId }, select: { name: true } }) : null;
  let invoice;

  if (o.source === "quotation") {
    // Exactly what the quotation route does: the quotation's own figures, carried across.
    const q = await prisma.quotation.findUnique({ where: { id: o.quotationId } });
    if (!q) throw new AgentActionError("The quotation no longer exists.", 404);
    if (String(q.status).toLowerCase() !== "accepted") throw new AgentActionError(`${q.number} is now ${q.status}.`, 409);
    if (await prisma.invoice.findFirst({ where: { quotationId: q.id } })) throw new AgentActionError(`${q.number} has already been invoiced.`, 409);
    const number = await nextNumber("invoice");
    [invoice] = await prisma.$transaction([
      prisma.invoice.create({ data: {
        number, companyId: q.companyId, clientName: q.clientName,
        ...(q.totalMinor != null ? { subtotalMinor: q.subtotalMinor, vatMinor: q.vatMinor, totalMinor: q.totalMinor, vatRateBp: q.vatRateBp, amount: Math.round(q.totalMinor / 100) } : await figuresFromAmount(q.amount)),
        status: "draft", date: today, services: q.service ?? null, items: q.items ?? [], notes: q.notes ?? null, quotationId: q.id,
      } }),
      prisma.quotation.update({ where: { id: q.id }, data: { status: "invoiced" } }),
    ]);
  } else {
    const lines: Line[] = Array.isArray(o.lines) ? o.lines : [];
    const total = lines.reduce((s, l) => s + Number(l.price) * Number(l.units || 1), 0);
    if (!(total > 0)) throw new AgentActionError("There is nothing to invoice.");
    const figures = await figuresFromAmount(total);
    invoice = await prisma.invoice.create({ data: {
      number: await nextNumber("invoice"), companyId: t.companyId, clientName: company?.name ?? null, ...figures,
      currency: await homeCurrency(), status: "draft", date: today,
      services: lines.map(l => l.name).join("; ").slice(0, 1000), items: lines as any,
      notes: `Raised from "${t.title}" by the Unbilled Work agent. Check the amounts before approving.`,
    } });
  }
  logActivity({ type: "finance", message: `Draft invoice ${invoice.number} raised from unbilled work${company?.name ? ` — ${company.name}` : ""}`, user: actor.name });
  await logAudit({ action: "invoice.create", actorId: actor.id, target: invoice.number, detail: `from ${t.dedupeKey} via Unbilled Work agent` });
  await decide(t.id, "done", actor, { invoiced: invoice.number });
  return { ok: true, message: `Draft invoice ${invoice.number} created. Review and approve it in Invoices.` };
}
