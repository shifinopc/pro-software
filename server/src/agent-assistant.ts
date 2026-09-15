/**
 * CONSOLE ASSISTANT — read-only.
 *
 * Staff ask in plain language ("which Iqamas expire this month for Malbriz, and what's blocking
 * each?") and get an answer built from lookups, with links to the records it used.
 *
 * READ-ONLY BY CONSTRUCTION. The model is given lookup tools and nothing else: there is no tool that
 * writes, sends or starts anything, so no question — however it is worded — can change data.
 *
 * THE SAME DATA THE PERSON CAN SEE. Every tool checks the asker's role against the permission matrix
 * before it runs (Compliance to see documents, Finance to see invoices, and so on), and a sales rep
 * only ever sees the clients they own — the same scope the rest of the console applies to them.
 */
import { prisma } from "./db.js";
import { askWithTools, type ToolDef } from "./ai.js";
import { can, type PermModule } from "./permissions.js";
import { claimTask, finishTask, usableModel, AgentActionError, daysFromToday, type AgentActor } from "./agent-core.js";
import { unmetPrereqs } from "./jobs.js";
import { workforceFor } from "./workforce.js";

export const KEY = "console-assistant";

type Link = { kind: "client" | "invoices" | "tasks" | "requests" | "runs"; label: string; client?: string; tab?: string };

const month = (s: string) => /^\d{4}-\d{2}$/.test(s) ? s : null;

export async function ask(question: string, actor: AgentActor & { companyScope?: string[] | null }) {
  const q = String(question ?? "").trim();
  if (!q) throw new AgentActionError("Ask a question.");
  if (q.length > 1000) throw new AgentActionError("Keep the question under 1000 characters.");
  const model = await usableModel(KEY);
  if (!model) throw new AgentActionError("The console assistant needs a model. An admin can connect one in Configure → Agents.", 409);

  const links = new Map<string, Link>();
  const link = (l: Link) => links.set(`${l.kind}:${l.client ?? ""}:${l.tab ?? ""}:${l.label}`, l);
  const gate = async (mod: PermModule) => { if (!(await can(actor.role, mod, "View"))) throw new Error(`Your role cannot view ${mod}, so this lookup is not available to you.`); };
  const scope = actor.role === "sales" ? { ownerId: actor.id } : {};
  const clientWhere = async (name?: string) => {
    if (!name) return actor.role === "sales" ? { company: scope } : {};
    const cos = await prisma.company.findMany({ where: { name: { contains: name }, ...scope }, select: { id: true } });
    return { companyId: { in: cos.map(c => c.id) } };
  };

  const tools: ToolDef[] = [
    {
      name: "find_clients",
      description: "Find clients by (part of) their name. Returns id, name, status, lifecycle and headcount.",
      input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      run: async ({ name }) => {
        await gate("Clients");
        const rows = await prisma.company.findMany({ where: { name: { contains: String(name ?? "") }, ...scope }, take: 15, select: { id: true, name: true, status: true, lifecycle: true } });
        rows.forEach(r => link({ kind: "client", label: r.name, client: r.name, tab: "Overview" }));
        const counts = await prisma.employee.groupBy({ by: ["companyId"], where: { companyId: { in: rows.map(r => r.id) }, archived: false }, _count: { _all: true } });
        return rows.map(r => ({ name: r.name, status: r.status, lifecycle: r.lifecycle, employees: counts.find(c => c.companyId === r.id)?._count._all ?? 0 }));
      },
    },
    {
      name: "list_documents",
      description: "List current (not superseded) compliance documents. Filter by client name, document type (Iqama, Passport, Work Permit, Health Insurance, Commercial Registration...), person name, expiry month (YYYY-MM), or expiring within N days (negative = already expired). Each result says whether a renewal is running.",
      input_schema: { type: "object", properties: { client: { type: "string" }, docType: { type: "string" }, person: { type: "string" }, expiryMonth: { type: "string", description: "YYYY-MM" }, expiringWithinDays: { type: "number" }, limit: { type: "number" } } },
      run: async (i) => {
        await gate("Compliance");
        const where: any = { supersededAt: null, ...(await clientWhere(i.client)) };
        if (i.docType) where.docType = { contains: String(i.docType) };
        if (i.person) where.person = { contains: String(i.person) };
        if (month(String(i.expiryMonth ?? ""))) where.expiryDate = { startsWith: i.expiryMonth };
        let rows = await prisma.document.findMany({ where, take: 300, orderBy: { expiryDate: "asc" }, select: { id: true, docType: true, docNumber: true, person: true, expiryDate: true, renewalRunId: true, company: { select: { name: true } } } });
        if (typeof i.expiringWithinDays === "number") rows = rows.filter(r => { const d = daysFromToday(r.expiryDate); return d !== null && d <= i.expiringWithinDays; });
        rows = rows.slice(0, Math.min(Number(i.limit) || 50, 100));
        rows.forEach(r => r.company && link({ kind: "client", label: `${r.company.name} documents`, client: r.company.name, tab: "Documents" }));
        return rows.map(r => ({ documentId: r.id, client: r.company?.name, docType: r.docType, number: r.docNumber, person: r.person, expiry: r.expiryDate, daysLeft: daysFromToday(r.expiryDate), renewalRunning: !!r.renewalRunId }));
      },
    },
    {
      name: "renewal_blockers",
      description: "For one document (documentId from list_documents): the renewal run's current steps and what is blocking it — missing or rejected checklist items, block reasons recorded by officers, or unmet prerequisites that stopped the renewal starting.",
      input_schema: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
      run: async ({ documentId }) => {
        await gate("Compliance");
        const d = await prisma.document.findUnique({ where: { id: String(documentId) }, include: { company: { select: { name: true, ownerId: true } } } });
        if (!d || (actor.role === "sales" && d.company?.ownerId !== actor.id)) return { error: "Document not found" };
        if (!d.renewalRunId) {
          const dt = await prisma.documentType.findFirst({ where: { name: d.docType } });
          const unmet = dt ? await unmetPrereqs(dt, d).catch(() => []) : [];
          return { renewalRunning: false, prerequisitesMissing: unmet.map(u => u.why), note: unmet.length ? "The renewal is held until these are met." : "No renewal has started — it may not be due yet, or no renewal workflow is active for this type." };
        }
        const run = await prisma.workflowInstance.findUnique({ where: { id: d.renewalRunId }, include: { tasks: { where: { status: "active" } } } });
        if (!run) return { renewalRunning: false };
        link({ kind: "runs", label: run.title });
        const v = (run.variables ?? {}) as any;
        return {
          renewalRunning: run.status === "running", run: run.title, status: run.status, startedAt: run.startedAt,
          blockReasons: Object.entries(v).filter(([k, val]) => /blockReason$/i.test(k) && val).map(([, val]) => val),
          activeSteps: run.tasks.map(t => {
            const state = (t.checklistState ?? {}) as any;
            const items = (Array.isArray(t.checklist) ? t.checklist : []) as any[];
            return {
              step: t.title, waitingOn: t.assignee || t.assigneeRole, since: t.createdAt, sla: t.slaState,
              missing: items.filter(it => it.required && !state[it.key]?.received).map(it => it.label),
              rejected: items.filter(it => state[it.key]?.rejected).map(it => `${it.label}${state[it.key]?.note ? ` — ${state[it.key].note}` : ""}`),
            };
          }),
        };
      },
    },
    {
      name: "list_invoices",
      description: "List invoices, optionally for one client and by status (overdue, unpaid, pending, paid, draft). Includes amount outstanding.",
      input_schema: { type: "object", properties: { client: { type: "string" }, status: { type: "string" }, limit: { type: "number" } } },
      run: async (i) => {
        await gate("Finance");
        const where: any = { ...(await clientWhere(i.client)) };
        if (i.status) where.status = String(i.status);
        const rows = await prisma.invoice.findMany({ where, take: Math.min(Number(i.limit) || 30, 100), orderBy: { dueDate: "asc" } });
        const out = [];
        for (const r of rows) {
          const paid = await prisma.payment.aggregate({ where: { invoiceId: r.id }, _sum: { amount: true } });
          out.push({ number: r.number, client: r.clientName, status: r.status, amount: r.amount, outstanding: r.amount - (paid._sum.amount ?? 0), currency: r.currency, due: r.dueDate, promisedDate: r.promisedDate });
        }
        link({ kind: "invoices", label: "Invoices" });
        return out;
      },
    },
    {
      name: "workforce_band",
      description: "A client's Nitaqat position: headcount, nationals, weighted ratio, computed band and distance to the next band.",
      input_schema: { type: "object", properties: { client: { type: "string" } }, required: ["client"] },
      run: async ({ client }) => {
        await gate("Clients");
        const co = await prisma.company.findFirst({ where: { name: { contains: String(client) }, ...scope }, select: { id: true, name: true } });
        if (!co) return { error: "Client not found" };
        const wf = await workforceFor(co.id);
        link({ kind: "client", label: `${co.name} workforce`, client: co.name, tab: "Workforce" });
        return wf && { client: co.name, total: wf.total, nationals: wf.nationals, expats: wf.expats, unknownNationality: wf.unknown, ratioPct: wf.ratioMinBp / 100, band: wf.computedBand?.name ?? null, recordedBand: wf.band, nextBand: wf.nextBand, ladder: wf.bandSet?.name };
      },
    },
    {
      name: "list_open_tasks",
      description: "Open tasks (not done), optionally for one client or one assignee name.",
      input_schema: { type: "object", properties: { client: { type: "string" }, assignee: { type: "string" }, limit: { type: "number" } } },
      run: async (i) => {
        await gate("Tasks");
        const where: any = { archived: false, NOT: { status: "done" }, ...(await clientWhere(i.client)) };
        if (i.assignee) where.assignee = { contains: String(i.assignee) };
        const rows = await prisma.task.findMany({ where, take: Math.min(Number(i.limit) || 30, 100), orderBy: { dueDate: "asc" }, select: { ref: true, title: true, status: true, assignee: true, dueDate: true, clientName: true, blockedBy: true } });
        link({ kind: "tasks", label: "Tasks" });
        return rows.map(r => ({ ...r, blockedBy: (r.blockedBy as any)?.reason ?? null }));
      },
    },
    {
      name: "list_requests",
      description: "Client service requests, optionally for one client and by status (open, accepted, resolved, rejected).",
      input_schema: { type: "object", properties: { client: { type: "string" }, status: { type: "string" } } },
      run: async (i) => {
        await gate("Clients");
        const where: any = { ...(await clientWhere(i.client)) };
        if (i.status) where.status = String(i.status);
        const rows = await prisma.serviceRequest.findMany({ where, take: 40, orderBy: { lastClientMsgAt: "desc" }, select: { number: true, type: true, status: true, clientName: true, date: true, message: true } });
        link({ kind: "requests", label: "Requests queue" });
        return rows.map(r => ({ ...r, message: String(r.message ?? "").slice(0, 300) }));
      },
    },
  ];

  const task = await claimTask(KEY, `q:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, { kind: "question", title: q.slice(0, 200), createdBy: actor.id, model });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await askWithTools({
      model, question: q, tools,
      system: `You answer questions from staff of a PRO (government relations) firm in Saudi Arabia, using the lookup tools on its operations system. Today is ${today}.
- Answer only from what the tools return. If the tools return nothing relevant, say so plainly. Never guess names, numbers, dates or amounts.
- If a tool says the person's role cannot view something, tell them that part is not available to them.
- You cannot change anything. If asked to do something, say what they would do in the console instead.
- Be brief and concrete: lead with the answer, then a short list. Plain text with "-" bullets, no tables, no markdown headings.`,
    });
    await finishTask(task!.id, "done", { summary: res.answer.slice(0, 600), output: { question: q, answer: res.answer, links: [...links.values()].slice(0, 12), lookups: res.used.map(u => u.tool) } });
    return { answer: res.answer, links: [...links.values()].slice(0, 12), lookups: res.used.length };
  } catch (e: any) {
    await finishTask(task!.id, "failed", { error: String(e?.message ?? e).slice(0, 1000), output: { question: q } });
    throw e;
  }
}
