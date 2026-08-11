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
import { startInstance, describeTemplate, resolveStaffByName } from "./workflow.js";
import { nextNumber } from "./sequence.js";
import { logActivity, logNotification } from "./auth.js";
import { notifyRequestAccepted, notifyTaskAssigned } from "./notify.js";
import { winOpportunityForQuotation } from "./pipeline.js";

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

  // An accepted quotation IS a won deal. Done here rather than on the two accept routes because
  // this is the one function both of them — the portal's and the console's — already run through;
  // hooking them separately is how one of them ends up not doing it. Deliberately before the
  // idempotency check below: re-driving a quotation whose tasks already exist must still be able to
  // move a deal that was left open, and winOpportunityForQuotation is itself a no-op once won.
  await winOpportunityForQuotation(q.id).catch(e => console.error("could not close the deal for", q.number, e));

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

  /**
   * STILL A LEAD, ALREADY BEING WORKED FOR.
   *
   * Accepting a quotation wins the deal and schedules the work, but it does NOT make the company a
   * client — that needs a CR number, and only a person holds the commercial registration it comes
   * off. So the two halves of the system can drift apart quietly: officers running tasks for a
   * company the CRM still calls a lead, with no CR on file and no portal login to see any of it.
   *
   * Deliberately a notice and not an automatic conversion. Inventing a CR is not an option, and
   * converting without one would either fail or write a client record with a hole in it — the very
   * thing the required field exists to prevent. Telling somebody at the moment it becomes true is
   * the most the system can honestly do.
   *
   * Placed after the work is scheduled and inside the once-per-quotation path, so it cannot fire for
   * a delivery that did not happen and cannot repeat on a re-drive.
   *
   * try/catch for the same reason every other notification here has one: a lead that is now doing
   * paid work is worth saying, and never worth failing a delivery over.
   */
  try {
    if (q.companyId) {
      const co = await prisma.company.findUnique({
        where: { id: q.companyId },
        select: { name: true, lifecycle: true, cr: true },
      });
      if (co && co.lifecycle !== "client") {
        logNotification({
          type: "system",
          title: `${co.name} is not a client yet`,
          message: `They accepted ${q.number} and work has started, but the record is still marked "${co.lifecycle}"`
            + `${co.cr ? "" : " with no CR number"}. Open the lead and use "Won — turn into a client" to set it up.`,
        });
      }
    }
  } catch (e) {
    console.error("[delivery] could not raise the not-yet-a-client notice:", (e as any)?.message ?? e);
  }

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

/**
 * What accepting this request would do, before anyone commits to it.
 *
 * Answered here rather than in the console so it goes through the SAME service matcher and the same
 * engine description that acceptance uses — a preview derived from a second guess would be a new way
 * to be wrong. It also returns the catalogue, because the match is only a guess and an officer shown
 * a wrong service needs to be able to correct it rather than just read about it.
 */
export async function previewAcceptServiceRequest(requestId: string, serviceItemId?: string | null) {
  const rq = await prisma.serviceRequest.findUnique({ where: { id: requestId } });
  if (!rq) throw new Error("Request not found");

  const services = await prisma.serviceItem.findMany({
    select: { id: true, name: true, sla: true, time: true, docType: true, workflowId: true },
    orderBy: { name: "asc" },
  });
  const chosen = serviceItemId ? services.find(s => s.id === serviceItemId) ?? null : null;
  const svc = chosen ?? matchService(String(rq.type ?? ""), services);
  const desc = svc?.workflowId ? await describeTemplate(svc.workflowId) : null;

  // Already accepted is checked on the work, exactly as acceptance does, so the dialog can say so
  // instead of offering a button that will fail.
  const already = await prisma.task.findFirst({ where: { requestId: rq.id }, select: { ref: true, title: true } });

  return {
    requestNumber: rq.number ?? null,
    requestType: rq.type ?? null,
    clientName: rq.clientName ?? null,
    alreadyAccepted: already ? (already.ref ?? already.title ?? "a task") : null,
    rejected: String(rq.status).toLowerCase() === "rejected",
    // Whether the service was chosen by the officer or guessed from the request text — the officer
    // should know which, because a guess is worth checking and a choice is not.
    serviceId: svc?.id ?? null,
    serviceName: svc?.name ?? null,
    matched: !!svc,
    guessed: !!svc && !chosen,
    dueDate: dueDateFrom(svc?.sla, svc?.time) || null,
    docType: svc?.docType ?? null,
    hasWorkflow: !!svc?.workflowId,
    templateName: desc?.name ?? null,
    steps: desc?.steps ?? 0,
    firstStep: desc?.firstStep ?? null,
    // An empty template is bound but cannot run — worth saying before the click, not after.
    templateEmpty: !!svc?.workflowId && !!desc && !desc.hasSteps,
    services: services.map(s => ({ id: s.id, name: s.name, hasWorkflow: !!s.workflowId })),
  };
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
      // Unassigned by default: a bound workflow routes its own steps by role anyway. The old reason
      // beside this — "naming an owner puts work in someone's queue without telling them" — no longer
      // holds: naming one now emails them (see below), so the default is about routing, not silence.
      assignee: (opts.assignee ?? "").trim() || "Unassigned",
      assigneeId: (await resolveStaffByName(opts.assignee))?.id ?? null,
      priority: "medium",
      status: "todo",
      dueDate: opts.dueDate || dueDateFrom(svc?.sla, svc?.time) || "",
      docType: svc?.docType ?? null,
      requestId: rq.id,
    },
  });

  // Naming somebody on acceptance now tells them, rather than dropping work into a queue they only
  // find by looking. Silent when nobody was named — the workflow routes its own steps.
  if (task.assigneeId) {
    notifyTaskAssigned({
      assigneeId: task.assigneeId, title: task.title, clientName: task.clientName,
      dueDate: task.dueDate || null, why: `accepted for ${rq.clientName ?? "a client"}`,
    });
  }

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
        // Asked of the engine so the number quoted here and the one the Accept preview showed the
        // officer beforehand cannot come from two different rules.
        const desc = await describeTemplate(svc.workflowId);
        stepCount = desc?.steps ?? 0;
        // The real run's active task, where the preview could only read the graph. Same value in
        // practice; this one is the truth because the token has actually arrived.
        firstStep = (run?.tasks ?? []).find((t: any) => t.status === "active")?.title ?? desc?.firstStep ?? null;
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
