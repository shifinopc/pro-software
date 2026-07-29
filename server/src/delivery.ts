// ─────────────────────────────────────────────────────────────
// QUOTATION → DELIVERY
//
// Accepting a quotation used to change one word in a database row. The client had agreed, the firm
// had committed, and nothing anywhere was scheduled — every task in the system had been typed by
// hand. This turns the acceptance into the work it promises: one task per line item, and where the
// line names a service with a bound workflow, a workflow run behind it.
//
// The rules it follows:
//   · idempotent — delivery starts once per quotation, keyed on Task.quotationId
//   · a line that matches no service still becomes a task. We would rather schedule work we cannot
//     classify than silently drop something the client is paying for.
//   · a broken workflow template costs that ONE line its run, not the whole delivery.
import { prisma } from "./db.js";
import { startInstance } from "./workflow.js";
import { nextNumber } from "./sequence.js";
import { logActivity, logNotification } from "./auth.js";
import { notifyRequestAccepted } from "./notify.js";

const nowISO = () => new Date().toISOString();

/** "5 working days" / "3–5 days" / "2 weeks" → a due date, or null when the text says nothing useful. */
export function dueDateFrom(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const s = String(t ?? "");
    if (!s) continue;
    // Take the LAST number in a range ("3–5 days" → 5): quoting the optimistic end of someone
    // else's estimate as a deadline is how a task is late the day it is created.
    const nums = s.match(/\d+/g);
    if (!nums?.length) continue;
    const n = Number(nums[nums.length - 1]);
    if (!(n > 0)) continue;
    const days = /week/i.test(s) ? n * 7 : /month/i.test(s) ? n * 30 : n;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Line items are free text; the catalog is the authority. Exact name first, then a contains match. */
function matchService(lineName: string, services: { id: string; name: string; sla: string | null; time: string | null; docType: string | null; workflowId: string | null }[]) {
  const n = lineName.trim().toLowerCase();
  if (!n) return null;
  return services.find(s => s.name.trim().toLowerCase() === n)
    ?? services.find(s => n.includes(s.name.trim().toLowerCase()) || s.name.trim().toLowerCase().includes(n))
    ?? null;
}

export interface DeliveryResult {
  started: boolean;
  reason?: string;
  tasks: { id: string; title: string; workflowInstanceId: string | null; matched: boolean }[];
  runs: number;
  unmatched: string[];
  failures: string[];
}

export async function startDeliveryForQuotation(quotationId: string, opts: { actor?: string } = {}): Promise<DeliveryResult> {
  const empty: DeliveryResult = { started: false, tasks: [], runs: 0, unmatched: [], failures: [] };
  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return { ...empty, reason: "Quotation not found" };

  // Idempotency. The client can accept in the portal while staff mark it accepted in the console,
  // and the scheduler may re-drive a row; none of that should double-book the officers.
  const existing = await prisma.task.count({ where: { quotationId: q.id } });
  if (existing > 0) return { ...empty, reason: `Delivery already started (${existing} task${existing === 1 ? "" : "s"})` };

  const items = Array.isArray(q.items) ? (q.items as any[]) : [];
  // A quotation written as a single service with no line breakdown still deserves its task.
  const lines: { name: string; units: number }[] = items.length
    ? items.map((it: any) => ({ name: String(it?.name ?? "").trim(), units: Number(it?.units) > 0 ? Number(it.units) : 1 })).filter(l => l.name)
    : (q.service ? [{ name: String(q.service).trim(), units: 1 }] : []);
  if (!lines.length) return { ...empty, reason: "That quotation has no line items to deliver" };

  const services = await prisma.serviceItem.findMany({
    select: { id: true, name: true, sla: true, time: true, docType: true, workflowId: true },
  });

  const out: DeliveryResult = { started: true, tasks: [], runs: 0, unmatched: [], failures: [] };

  for (const line of lines) {
    const svc = matchService(line.name, services);
    if (!svc) out.unmatched.push(line.name);
    // Units are quantities of the same service (3 × Iqama Renewal), so they get their own tasks —
    // one row per thing an officer has to actually go and do.
    for (let i = 0; i < line.units; i++) {
      const suffix = line.units > 1 ? ` (${i + 1}/${line.units})` : "";
      const title = `${svc?.name ?? line.name}${suffix} — ${q.clientName ?? "Client"}`;
      const task = await prisma.task.create({
        data: {
          ref: await nextNumber("task"),
          title,
          companyId: q.companyId ?? null,
          clientName: q.clientName ?? null,
          // Deliberately unassigned: guessing an owner puts work in someone's queue without telling
          // them. It lands in the unassigned queue where it is picked up on purpose.
          assignee: "Unassigned",
          priority: "medium",
          dueDate: dueDateFrom(svc?.sla, svc?.time) ?? "",
          status: "todo",
          docType: svc?.docType ?? null,
          quotationId: q.id,
        },
      });

      let runId: string | null = null;
      if (svc?.workflowId) {
        try {
          const run = await startInstance(svc.workflowId, {
            title: `${svc.name} — ${q.clientName ?? "Client"}`,
            companyId: q.companyId ?? null,
            clientName: q.clientName ?? null,
            variables: { serviceId: svc.id, serviceName: svc.name, quotationId: q.id, quotationNumber: q.number, _trigger: "quotation_accepted", _autoStarted: nowISO() },
          });
          runId = run?.id ?? null;
          if (runId) {
            await prisma.task.update({ where: { id: task.id }, data: { workflowInstanceId: runId } });
            out.runs++;
          }
        } catch (e: any) {
          // The task stands on its own — a template that will not start is a configuration problem,
          // not a reason for the client's work to go missing.
          out.failures.push(`${svc.name}: ${e?.message ?? e}`);
        }
      }
      out.tasks.push({ id: task.id, title, workflowInstanceId: runId, matched: !!svc });
    }
  }

  const n = out.tasks.length;
  logActivity({
    type: "task",
    message: `Delivery started from ${q.number}${q.clientName ? ` — ${q.clientName}` : ""}: ${n} task${n === 1 ? "" : "s"}${out.runs ? `, ${out.runs} workflow run${out.runs === 1 ? "" : "s"}` : ""}`,
    user: opts.actor ?? "System",
  });
  logNotification({
    type: "task",
    title: `Work scheduled — ${q.clientName ?? "client"}`,
    // Say what did NOT get a workflow. Ten of fourteen services have no template bound, so a silent
    // "3 tasks created" would hide that most of them are now waiting on a human to notice.
    message: [
      `${q.number} accepted · ${n} task${n === 1 ? "" : "s"}`,
      out.runs ? `${out.runs} auto-started` : null,
      out.unmatched.length ? `not in catalog: ${out.unmatched.join(", ")}` : null,
      out.failures.length ? `workflow failed: ${out.failures.join("; ")}` : null,
    ].filter(Boolean).join(" · "),
  });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLIENT REQUEST → WORK
//
// The same journey as above, through the other door. Approving a request in the queue used to write
// one word — `status: "resolved"` — and that was the whole of it: no task, no run, no owner, and no
// link to anything. The client was told their request was finished at the moment it was agreed,
// while the work existed only in the memory of whoever had read it.
//
// Rules, deliberately the same as delivery so the two doors behave alike:
//   · idempotent — keyed on Task.requestId, so a double-click cannot double-book anyone
//   · a request matching no catalogue service STILL becomes a task, titled in the client's own
//     words. Three of the five most recent requests are free text; refusing them would mean the
//     ones people actually send are the ones the system ignores.
//   · a workflow that will not start costs the request its run, not its task
// ──────────────────────────────────────────────────────────────────────────────
export interface AcceptResult {
  taskId: string;
  taskRef: string | null;
  workflowInstanceId: string | null;
  serviceId: string | null;
  serviceName: string | null;
  matched: boolean;
  failure?: string;
}

export async function acceptServiceRequest(
  requestId: string,
  opts: { actor?: string; serviceItemId?: string | null; assignee?: string | null; dueDate?: string | null } = {},
): Promise<AcceptResult> {
  const rq = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
  if (!rq) throw new Error("Request not found");
  if (String(rq.status).toLowerCase() === "rejected") throw new Error("That request was rejected — reopen it before accepting");

  // Idempotency, checked on the work rather than the status: a status can be edited by hand, a task
  // cannot appear twice by accident.
  const already = await prisma.task.findFirst({ where: { requestId: rq.id } });
  if (already) throw new Error(`Already accepted — ${already.ref ?? already.title} exists for this request`);

  const services = await prisma.serviceItem.findMany({
    select: { id: true, name: true, sla: true, time: true, docType: true, workflowId: true },
  });
  // An explicit choice from the Accept dialog always wins: the officer looked at it, the matcher only
  // guessed. Falling back to the guess keeps the API usable without the dialog.
  const svc = (opts.serviceItemId ? services.find(s => s.id === opts.serviceItemId) : null)
    ?? matchService(String(rq.type ?? ""), services);

  const label = svc?.name ?? String(rq.type ?? "").trim() ?? "";
  const title = `${label || "Client request"} — ${rq.clientName ?? "Client"}`;

  const task = await prisma.task.create({
    data: {
      ref: await nextNumber("task"),
      title,
      companyId: rq.companyId ?? null,
      clientName: rq.clientName ?? null,
      // Unassigned by default, as delivery does: naming an owner puts work in someone's queue
      // without telling them, and a bound workflow routes its own steps by role anyway.
      assignee: (opts.assignee ?? "").trim() || "Unassigned",
      priority: "medium",
      status: "todo",
      dueDate: opts.dueDate || dueDateFrom(svc?.sla, svc?.time) || "",
      docType: svc?.docType ?? null,
      requestId: rq.id,
    },
  });

  let runId: string | null = null;
  let failure: string | undefined;
  // Described to the client below. Only filled in when a run actually starts, so the acceptance
  // email never promises a process that failed to launch.
  let stepCount = 0;
  let firstStep: string | null = null;
  if (svc?.workflowId) {
    try {
      const run = await startInstance(svc.workflowId, {
        title,
        companyId: rq.companyId ?? null,
        clientName: rq.clientName ?? null,
        variables: {
          serviceId: svc.id, serviceName: svc.name,
          requestId: rq.id, requestNumber: rq.number ?? null,
          ...(svc.docType ? { docType: svc.docType } : {}),
          _trigger: "request_intake", _acceptedAt: nowISO(),
        },
      });
      runId = run?.id ?? null;
      if (runId) {
        await prisma.task.update({ where: { id: task.id }, data: { workflowInstanceId: runId } });
        // Count the human steps in the TEMPLATE, not the tasks created so far: the engine
        // materialises a step only when the token reaches it, so "tasks" is 1 on a seven-step run.
        const tpl = await prisma.workflowTemplate.findUnique({ where: { id: svc.workflowId } }).catch(() => null);
        const nodes: any[] = Array.isArray((tpl?.graph as any)?.nodes) ? (tpl!.graph as any).nodes : [];
        stepCount = nodes.filter(n => n?.type === "task" || n?.type === "approval").length;
        firstStep = (run?.tasks ?? []).find((t: any) => t.status === "active")?.title ?? null;
      }
    } catch (e: any) {
      // The task stands on its own. A template that will not start is a configuration problem, not a
      // reason for the client's work to go missing.
      failure = String(e?.message ?? e);
    }
  }

  await prisma.serviceRequest.update({
    where: { id: rq.id },
    data: {
      status: "accepted",
      taskId: task.id,
      workflowInstanceId: runId,
      serviceItemId: svc?.id ?? null,
      acceptedAt: nowISO(),
    },
  });

  logActivity({
    type: "task",
    message: `Request ${rq.number ?? ""} accepted — ${title}${runId ? " (workflow started)" : ""}`.trim(),
    user: opts.actor ?? "System",
  });
  logNotification({
    type: "task",
    title: `Work started — ${rq.clientName ?? "client"}`,
    // Say plainly when there is no process behind the task. Ten of fourteen services have no
    // template bound, and a bare "task created" would hide that this one is a to-do, not a flow.
    message: [
      `${rq.number ?? "Request"} · ${task.ref ?? title}`,
      runId ? "workflow started" : (svc ? `no workflow bound to ${svc.name}` : "not in the service catalogue"),
      failure ? `workflow failed: ${failure}` : null,
    ].filter(Boolean).join(" · "),
  });

  // The client's side of the same moment. Until now acceptance was visible only to staff — the
  // client's request simply changed colour in the portal one day with nothing to say why.
  notifyRequestAccepted({
    companyId: rq.companyId ?? null,
    number: rq.number ?? null,
    serviceName: svc?.name ?? String(rq.type ?? "") ?? null,
    hasWorkflow: !!runId,
    steps: stepCount,
    firstStep,
  });

  return {
    taskId: task.id, taskRef: task.ref ?? null, workflowInstanceId: runId,
    serviceId: svc?.id ?? null, serviceName: svc?.name ?? null, matched: !!svc, failure,
  };
}
