/**
 * THE SHARED SHAPE OF A FINDING AGENT.
 *
 * Most agents do the same three things: look at the records, open one review item per thing worth a
 * person's attention, and close the ones that went away. The twenty added together share that loop and
 * a small set of actions, so each agent is only its own checks — not its own copy of the plumbing.
 *
 * Actions a person can take (the agent never takes them):
 *   · done     — "I handled it". Always available.
 *   · dismiss  — "not a problem". Stays dismissed.
 *   · tasks    — create the Tasks listed in output.tasks (skipping any that already exist).
 *   · invoice  — create a DRAFT invoice from output.lines, still to be approved in Invoices.
 *   · send     — send output.draft (editable) to the client's portal users and company email.
 */
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, type AgentActor } from "./agent-core.js";
import { nextNumber } from "./sequence.js";
import { figuresFromAmount } from "./money.js";
import { homeCurrency } from "./orgsettings.js";
import { logActivity, logAudit } from "./auth.js";
import { notifyTaskAssigned, sendClientMessage } from "./notify.js";
import { emailEnabled } from "./mailer.js";
import type { PermModule, PermAction } from "./permissions.js";

export type Finding = { kind: string; key: string; title: string; summary: string; companyId?: string | null; employeeId?: string | null; refType?: string | null; refId?: string | null; output?: Record<string, unknown> };
export type TaskLine = { title: string; dueDate?: string | null; assigneeId?: string | null; assignee?: string | null; govCenter?: string | null; employeeId?: string | null; docType?: string | null; items?: string[] };
export type InvoiceLine = { name: string; units: number; price: number };

export const LIST_MAX = 60;
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const money = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * One pass: `collect` raises findings; anything of the listed kinds not raised this time is closed.
 * Kinds the pass could not check (say, nothing to compare against) should be left out of `kinds`.
 */
export async function runFindings(key: string, kinds: string[], collect: (raise: (f: Finding) => Promise<void>) => Promise<string[] | void>) {
  const out = { opened: 0, open: 0, closed: 0, details: [] as string[] };
  const seen = new Map<string, Set<string>>(kinds.map(k => [k, new Set<string>()]));
  const raise = async (f: Finding) => {
    if (!seen.has(f.kind)) seen.set(f.kind, new Set());
    seen.get(f.kind)!.add(f.key);
    const r = await upsertFinding(key, f.key, { kind: f.kind, title: f.title.slice(0, 250), summary: f.summary, companyId: f.companyId ?? null, employeeId: f.employeeId ?? null, refType: f.refType ?? null, refId: f.refId ?? null, output: f.output ?? {} });
    if (r.opened) out.opened++;
  };
  const notes = await collect(raise);
  for (const [kind, keys] of seen) {
    if (!kinds.includes(kind)) continue;
    out.closed += await closeMissing(key, kind, keys, "No longer found");
  }
  out.open = await prisma.agentTask.count({ where: { agent: key, status: "review" } });
  if (Array.isArray(notes)) out.details.push(...notes);
  await markRun(key);
  return out;
}

type ActOpts = { module: PermModule; action?: PermAction; what: string; doneNote?: string };

/** The standard act(): done, dismiss, tasks, invoice, send — whichever the finding carries. */
export function standardAct(key: string, opts: ActOpts) {
  return async (taskId: string, action: string, input: any, actor: AgentActor) => {
    const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
    if (!t || t.agent !== key) throw new AgentActionError("That item no longer exists.", 404);
    if (t.status !== "review") throw new AgentActionError(`This item is already ${t.status}.`, 409);
    const o = (t.output ?? {}) as any;

    if (action === "dismiss") {
      await requirePerm(actor, opts.module, opts.action ?? "Edit", opts.what);
      return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
    }
    if (action === "done") {
      await requirePerm(actor, opts.module, opts.action ?? "Edit", opts.what);
      await decide(t.id, "done", actor, { handled: opts.doneNote ?? "Handled" });
      return { ok: true, message: "Marked as handled." };
    }

    if (action === "tasks") {
      await requirePerm(actor, "Tasks", "Create", "create tasks");
      const lines = (Array.isArray(o.tasks) ? o.tasks : []) as TaskLine[];
      if (!lines.length) throw new AgentActionError("There are no tasks to create.");
      const co = t.companyId ? await prisma.company.findUnique({ where: { id: t.companyId }, select: { name: true } }) : null;
      const made: string[] = [];
      for (const l of lines) {
        // A second click, or the same finding raised again later, must not create the work twice.
        if (await prisma.task.findFirst({ where: { title: l.title, companyId: t.companyId, archived: false, NOT: { status: { in: ["done", "cancelled"] } } } })) continue;
        const task = await prisma.task.create({ data: {
          ref: await nextNumber("task"), title: l.title, companyId: t.companyId, clientName: co?.name ?? null,
          dueDate: l.dueDate ?? null, priority: "medium", status: "todo",
          assignee: l.assignee || "Unassigned", assigneeId: l.assigneeId ?? null,
          govCenter: l.govCenter ?? null, employeeId: l.employeeId ?? null, docType: l.docType ?? null,
          customData: { agent: key, ...(l.items?.length ? { items: l.items } : {}) } as any,
        } });
        made.push(task.ref ?? task.title);
        if (task.assigneeId) notifyTaskAssigned({ assigneeId: task.assigneeId, title: task.title, dueDate: task.dueDate, clientName: co?.name, why: t.title.slice(0, 200) });
      }
      await logAudit({ action: "agent.tasks", actorId: actor.id, target: t.dedupeKey, detail: `${key}: ${made.join(", ")}`.slice(0, 900) });
      logActivity({ type: "task", message: `${plural(made.length, "task")} created from “${t.title}”`, user: actor.name });
      await decide(t.id, "done", actor, { tasksCreated: made.length });
      return { ok: true, message: made.length ? `Created ${plural(made.length, "task")}: ${made.join(", ")}.` : "Those tasks already exist." };
    }

    if (action === "invoice") {
      await requirePerm(actor, "Finance", "Create", "raise invoices");
      const lines = (Array.isArray(o.lines) ? o.lines : []) as InvoiceLine[];
      const total = lines.reduce((s, l) => s + Number(l.price) * Number(l.units || 1), 0);
      if (!(total > 0)) throw new AgentActionError("There is nothing to invoice.");
      const co = t.companyId ? await prisma.company.findUnique({ where: { id: t.companyId }, select: { name: true } }) : null;
      const invoice = await prisma.invoice.create({ data: {
        number: await nextNumber("invoice"), companyId: t.companyId, clientName: co?.name ?? null, ...(await figuresFromAmount(total)),
        currency: await homeCurrency(), status: "draft", date: today(),
        services: lines.map(l => l.name).join("; ").slice(0, 1000), items: lines as any,
        notes: `Raised from “${t.title}” by an agent. Check the amounts before approving.`,
      } });
      logActivity({ type: "finance", message: `Draft invoice ${invoice.number} raised by ${actor.name} from an agent finding${co?.name ? ` — ${co.name}` : ""}`, user: actor.name });
      await logAudit({ action: "invoice.create", actorId: actor.id, target: invoice.number, detail: `from ${key}:${t.dedupeKey}` });
      await decide(t.id, "done", actor, { invoiced: invoice.number });
      return { ok: true, message: `Draft invoice ${invoice.number} created. Review and approve it in Invoices.` };
    }

    if (action === "send") {
      await requirePerm(actor, "Clients", "Edit", "send messages to clients");
      const subject = String(input?.subject ?? o.draft?.subject ?? "").trim();
      const body = String(input?.body ?? o.draft?.body ?? "").trim();
      if (!subject || !body) throw new AgentActionError("The message needs a subject and a body.");
      const sent = await sendClientMessage({ companyId: t.companyId, subject, heading: subject, body });
      if (!sent.to.length) throw new AgentActionError("This client has no portal user or company email address to send to.", 409);
      const mailOn = await emailEnabled();
      logActivity({ type: "client", message: `Sent to the client: ${subject}`, user: actor.name });
      await decide(t.id, "done", actor, { sent: { to: sent.to, subject, edited: subject !== o.draft?.subject || body !== o.draft?.body, delivered: mailOn } });
      return { ok: true, message: mailOn ? `Sent to ${sent.to.join(", ")}.` : "Email is not set up on this server, so the message was logged but not delivered." };
    }

    throw new AgentActionError("Unknown action.");
  };
}

/** Group rows by a key, keeping insertion order. */
export function groupBy<T>(rows: T[], keyOf: (r: T) => string | null | undefined) {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = keyOf(r); if (!k) continue; const list = m.get(k); if (list) list.push(r); else m.set(k, [r]); }
  return m;
}

/** A check line for the review dialog: ok / flag / unknown. */
export const check = (state: "ok" | "flag" | "unknown", label: string, note: string) => ({ state, label, note });
