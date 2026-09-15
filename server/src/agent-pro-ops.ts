/**
 * PRO WORK AGENTS — workflows that stopped moving, employees leaving, tomorrow's appointments, original
 * documents held by the office, and work done by hand so often it should be a workflow.
 *
 * They prepare and list. They never move a step, cancel a visa, book or reschedule anything.
 */
import { prisma } from "./db.js";
import { daysFromToday, normName, currentDoc } from "./agent-core.js";
import { runFindings, standardAct, groupBy, plural, today, addDays, check, LIST_MAX, type TaskLine } from "./agent-kit.js";

const daysSince = (iso?: string | null) => { const d = daysFromToday(iso); return d === null ? null : -d; };

// ── 5. Stuck workflows ────────────────────────────────────────────────────────────────────────

export const STUCK = "stuck-workflow";
const STILL_DAYS = 5;
const APPROVAL_DAYS = 2;
const GROUP_AT = 3; // this many stalled runs with one person become one item

export async function runStuckWorkflows() {
  return runFindings(STUCK, ["no-movement", "unassigned", "approval-waiting"], async raise => {
    const runs = await prisma.workflowInstance.findMany({ where: { status: "running" }, select: { id: true, title: true, companyId: true, clientName: true, startedAt: true }, take: 3000 });
    if (!runs.length) return ["No workflows running."];
    const ids = runs.map(r => r.id);
    const [steps, logs, users] = await Promise.all([
      prisma.workflowTask.findMany({ where: { instanceId: { in: ids } }, select: { id: true, instanceId: true, title: true, status: true, nodeType: true, assigneeId: true, assignee: true, assigneeRole: true, createdAt: true, completedAt: true } }),
      prisma.workflowLog.groupBy({ by: ["instanceId"], where: { instanceId: { in: ids } }, _max: { at: true } }),
      prisma.user.findMany({ where: { type: "staff", status: "active" }, select: { id: true, roleId: true } }),
    ]);
    const lastLog = new Map(logs.map(l => [l.instanceId, l._max.at]));
    const roles = new Set(users.map(u => u.roleId));
    const activeIds = new Set(users.map(u => u.id));
    const stalled: { run: (typeof runs)[number]; still: number; active: typeof steps; facts: { label: string; value: string }[] }[] = [];
    for (const run of runs) {
      const mine = steps.filter(s => s.instanceId === run.id);
      const active = mine.filter(s => s.status === "active");
      const last = [run.startedAt, lastLog.get(run.id), ...mine.flatMap(s => [s.createdAt, s.completedAt])].filter(Boolean).sort().pop() ?? null;
      const still = daysSince(last) ?? 0;
      const facts = [{ label: "Last movement", value: last ? `${still} days ago` : "never recorded" }, { label: "Open steps", value: active.map(s => `${s.title}${s.assignee ? ` (${s.assignee})` : ""}`).join("; ") || "none" }];
      if (!active.length && still >= 1) {
        await raise({ kind: "no-movement", key: `empty:${run.id}`, companyId: run.companyId, refType: "workflow", refId: run.id,
          title: `${run.title} is running with no open step`,
          summary: "Nothing is waiting on anyone, yet the run never finished. It needs completing or cancelling by hand.", output: { facts } });
        continue;
      }
      const orphan = active.filter(s => (!s.assigneeId || !activeIds.has(s.assigneeId)) && (!s.assigneeRole || !roles.has(s.assigneeRole)));
      if (orphan.length) {
        await raise({ kind: "unassigned", key: `orphan:${run.id}`, companyId: run.companyId, refType: "workflow", refId: run.id,
          title: `${plural(orphan.length, "step")} in ${run.title} that nobody can pick up`,
          summary: `${orphan.map(s => s.title).join(", ")} ${orphan.length === 1 ? "has" : "have"} no active person and no role anyone holds.`, output: { facts } });
      }
      const approvals = active.filter(s => s.nodeType === "approval" && (daysSince(s.createdAt) ?? 0) >= APPROVAL_DAYS);
      if (approvals.length) {
        await raise({ kind: "approval-waiting", key: `approval:${run.id}`, companyId: run.companyId, refType: "workflow", refId: run.id,
          title: `Approval waiting ${daysSince(approvals[0].createdAt)} days — ${run.title}`,
          summary: `${approvals.map(s => `${s.title}${s.assignee ? ` with ${s.assignee}` : ""}`).join("; ")}. Everything after it is held.`, output: { facts } });
      }
      if (still >= STILL_DAYS && !orphan.length && !approvals.length) stalled.push({ run, still, active, facts });
    }

    // One person holding many stalled runs is ONE problem — their workload — not one item per run.
    // A batch of renewals landing on one officer otherwise floods the queue with near-identical rows.
    for (const [holder, list] of groupBy(stalled, x => x.active[0]?.assigneeId || x.active[0]?.assignee || x.active[0]?.assigneeRole || "unassigned")) {
      if (list.length < GROUP_AT) {
        for (const { run, still, active, facts } of list) {
          await raise({ kind: "no-movement", key: `still:${run.id}`, companyId: run.companyId, refType: "workflow", refId: run.id,
            title: `${run.title} has not moved for ${still} days`,
            summary: `${active.map(s => s.assignee || s.assigneeRole || "unassigned").filter(Boolean).join(", ")} ${active.length === 1 ? "holds" : "hold"} it. Ask what it is waiting for.`, output: { facts } });
        }
        continue;
      }
      list.sort((a, b) => b.still - a.still);
      const who = list[0].active[0]?.assignee || list[0].active[0]?.assigneeRole || "Nobody";
      const clients = new Set(list.map(x => x.run.companyId)).size;
      await raise({ kind: "no-movement", key: `holder:${holder}`,
        title: `${plural(list.length, "run")} stalled with ${who}`,
        summary: `${list.length} workflow runs for ${plural(clients, "client")} have not moved for ${list[list.length - 1].still}–${list[0].still} days, all waiting on ${who}. Too much work on one person — hand some to a colleague (SLA Rescue proposes who).`,
        output: {
          facts: [{ label: "Held by", value: who }, { label: "Oldest", value: `${list[0].still} days without movement` }],
          lists: [{ title: "Stalled runs, oldest first", items: list.slice(0, LIST_MAX).map(x => ({ text: `${x.run.title}${x.run.clientName ? ` · ${x.run.clientName}` : ""} · ${x.active.map(s => s.title).join(", ")} · ${x.still} days` })) }],
          more: Math.max(0, list.length - LIST_MAX),
        } });
    }
  });
}

// ── 6. Employee exits ─────────────────────────────────────────────────────────────────────────

export const EXIT = "employee-exit";
const EXIT_WORK = [
  { key: "final-exit", title: "Issue the final exit visa", govCenter: "Muqeem", match: /final exit|exit visa/i },
  { key: "qiwa", title: "End the contract on Qiwa", govCenter: "Qiwa", match: /qiwa|contract/i },
  { key: "gosi", title: "Remove from GOSI", govCenter: "GOSI", match: /gosi/i },
  { key: "insurance", title: "Cancel the medical insurance", govCenter: null, match: /insurance/i },
  { key: "settlement", title: "Prepare the final settlement and clearance", govCenter: null, match: /settlement|clearance|eos|end of service/i },
];

export async function runEmployeeExits() {
  return runFindings(EXIT, ["exit"], async raise => {
    const leaving = await prisma.employee.findMany({ where: { exitStatus: { in: ["exit_requested", "exiting"] }, archived: false }, select: { id: true, name: true, code: true, companyId: true, exitStatus: true, exitDate: true, exitReason: true, exitRequestId: true, company: { select: { name: true, roleOwners: true } } }, take: 2000 });
    if (!leaving.length) return ["Nobody is leaving."];
    for (const e of leaving) {
      const [docs, tasks] = await Promise.all([
        prisma.document.findMany({ where: { employeeId: e.id, supersededAt: null }, select: { docType: true, expiryDate: true, renewalRunId: true, renewalTaskId: true } }),
        prisma.task.findMany({ where: { employeeId: e.id, archived: false }, select: { title: true, status: true } }),
      ]);
      const renewing = docs.filter(d => d.renewalRunId || d.renewalTaskId);
      const daysToGo = daysFromToday(e.exitDate);
      const workDone = (m: RegExp) => tasks.find(t => m.test(t.title));
      const checks = [
        check(e.exitDate ? "ok" : "flag", "Last working day", e.exitDate ? `${e.exitDate}${daysToGo !== null ? (daysToGo < 0 ? ` — ${-daysToGo} days ago` : ` — in ${daysToGo} days`) : ""}` : "Not recorded — ask the client."),
        check(renewing.length ? "flag" : "ok", "No renewals running", renewing.length ? `Still renewing ${renewing.map(d => d.docType).join(", ")} — cancel so no fee is spent on someone leaving.` : "Nothing is being renewed."),
        ...EXIT_WORK.map(w => { const t = workDone(w.match); return check(t ? (t.status === "done" ? "ok" : "unknown") : "flag", w.title, t ? `Task “${t.title}” is ${t.status}.` : "No task yet."); }),
        check(daysToGo !== null && daysToGo < 0 && e.exitStatus !== "exited" ? "flag" : "ok", "Closed on time", daysToGo !== null && daysToGo < 0 ? "The last day has passed and the employee is still counted — close the exit once the steps are done." : "Not due yet."),
      ];
      const open = checks.filter(c => c.state === "flag");
      if (!open.length) continue;
      const officer = ((e.company?.roleOwners ?? {}) as any)?.pro_officer ?? null;
      const due = e.exitDate && (daysToGo ?? 0) > 0 ? e.exitDate : addDays(today(), 2);
      const tasks2: TaskLine[] = EXIT_WORK.filter(w => !workDone(w.match)).map(w => ({ title: `${w.title} — ${e.name}${e.code ? ` (${e.code})` : ""}`, dueDate: due, govCenter: w.govCenter, employeeId: e.id, assigneeId: officer }));
      await raise({
        kind: "exit", key: `exit:${e.id}`, companyId: e.companyId, employeeId: e.id,
        title: `${e.name} is leaving ${e.company?.name ?? ""} — ${plural(open.length, "thing")} open`.trim(),
        summary: `${e.exitReason ? `Reason: ${String(e.exitReason).replace(/_/g, " ")}. ` : ""}${open.map(c => c.label).join(", ")}.`,
        output: { checks, tasks: tasks2, proposal: tasks2.length ? { text: `Create ${plural(tasks2.length, "exit task")} so the person stops being counted and charged.` } : undefined },
      });
    }
  });
}

// ── 7. Appointment prep ───────────────────────────────────────────────────────────────────────

export const APPT = "appointment-prep";
const DONE_APPT = ["Attended", "Cancelled", "No-show"];

export async function runAppointmentPrep() {
  return runFindings(APPT, ["not-ready"], async raise => {
    const from = today(), to = addDays(today(), 2);
    const appts = await prisma.appointment.findMany({ where: { date: { gte: from, lte: to }, NOT: { status: { in: DONE_APPT } } }, take: 500 });
    if (!appts.length) return ["No appointments in the next two days."];
    for (const a of appts) {
      const issues: ReturnType<typeof check>[] = [];
      if (!a.time) issues.push(check("flag", "Time", "No time recorded."));
      if (!a.location) issues.push(check("flag", "Place", "No location recorded."));
      if (["Requested", "Rescheduled"].includes(a.status)) issues.push(check("flag", "Confirmed", `Still “${a.status}” — confirm the slot.`));
      let emp: { id: string; name: string } | null = null;
      if (a.employee && a.companyId) {
        const tokens = normName(a.employee);
        const staff = await prisma.employee.findMany({ where: { companyId: a.companyId, archived: false }, select: { id: true, name: true } });
        emp = staff.find(s => { const t = normName(s.name); return tokens.length && tokens.every(x => t.includes(x)); }) ?? null;
        if (!emp) issues.push(check("unknown", "Employee", `“${a.employee}” is not an employee on file, so documents could not be checked.`));
      }
      if (emp && a.companyId) {
        for (const docType of ["Passport", "Iqama"]) {
          const d = await currentDoc(docType, a.companyId, emp.id);
          if (!d) { issues.push(check("unknown", docType, "None on file — make sure the officer takes it.")); continue; }
          const left = daysFromToday(d.expiryDate);
          if (left !== null && left < 0) issues.push(check("flag", docType, `Expired ${-left} days ago (${d.expiryDate}).`));
        }
      }
      if (a.taskId) {
        const t = await prisma.task.findUnique({ where: { id: a.taskId }, select: { assigneeId: true, assignee: true } });
        if (t && !t.assigneeId) issues.push(check("flag", "Officer", "The task this appointment belongs to has nobody on it."));
      }
      if (!issues.some(i => i.state === "flag")) continue;
      const when = a.date === from ? "today" : a.date === addDays(from, 1) ? "tomorrow" : a.date;
      await raise({
        kind: "not-ready", key: `appt:${a.id}:${a.date}`, companyId: a.companyId, employeeId: emp?.id ?? null, refType: "appointment", refId: a.id,
        title: `${a.title} ${when}${a.time ? ` at ${a.time}` : ""} — ${plural(issues.filter(i => i.state === "flag").length, "thing")} not ready`,
        summary: `${a.clientName ?? ""}${a.employee ? ` · ${a.employee}` : ""}${a.location ? ` · ${a.location}` : ""}`.replace(/^ · /, ""),
        output: { checks: issues },
      });
    }
  });
}

// ── 8. Original documents held ────────────────────────────────────────────────────────────────

export const ORIGINALS = "originals-tracker";
const HELD_DAYS = 14;
const TERMINAL = ["Delivered", "Returned", "Cancelled", "delivered", "returned", "cancelled"];

export async function runOriginalsTracker() {
  return runFindings(ORIGINALS, ["held", "late"], async raise => {
    const ships = await prisma.courierShipment.findMany({ take: 5000, orderBy: { at: "asc" } });
    if (!ships.length) return ["No courier jobs recorded."];
    // Inbound and delivered = the office has it. An outbound job for the same document later = handed back.
    const held = ships.filter(s => s.direction === "inbound" && /deliver/i.test(s.status) && !ships.some(o => o.direction === "outbound" && o.companyId === s.companyId && (s.documentId ? o.documentId === s.documentId : o.description === s.description) && String(o.at ?? "") >= String(s.at ?? "")));
    for (const [co, rows] of groupBy(held.filter(s => (daysSince(s.at) ?? 0) >= HELD_DAYS), s => s.companyId)) {
      await raise({ kind: "held", key: `held:${co}`, companyId: co,
        title: `${plural(rows.length, "original")} held for over ${HELD_DAYS} days — ${rows[0].clientName ?? "client"}`,
        summary: "Collected from the client and never sent back. Return them, or note why they are still needed.",
        output: { lists: [{ title: "Held", items: rows.slice(0, LIST_MAX).map(s => ({ text: `${s.ref} · ${s.description ?? "document"} · received ${daysSince(s.at)} days ago${s.toPlace ? ` · at ${s.toPlace}` : ""}` })) }] } });
    }
    const late = ships.filter(s => !TERMINAL.includes(s.status) && s.eta && (daysFromToday(s.eta) ?? 0) < 0);
    for (const s of late) {
      await raise({ kind: "late", key: `late:${s.id}`, companyId: s.companyId, refType: "courier", refId: s.id,
        title: `${s.ref} is ${-(daysFromToday(s.eta) ?? 0)} days past its expected date — ${s.clientName ?? "client"}`,
        summary: `${s.description ?? "Shipment"} · ${s.status}${s.carrier ? ` · ${s.carrier}` : ""}. Check where it is.`,
        output: { facts: [{ label: "Route", value: `${s.fromPlace ?? "?"} → ${s.toPlace ?? "?"}` }, { label: "Direction", value: s.direction }] } });
    }
  });
}

// ── 9. Repeat work that should be a workflow ──────────────────────────────────────────────────

export const REPEAT = "repeat-work";
const REPEAT_MIN = 5;

export async function runRepeatWork() {
  return runFindings(REPEAT, ["pattern"], async raise => {
    const since = addDays(today(), -90);
    const [services, requests, tasks] = await Promise.all([
      prisma.serviceItem.findMany({ where: { retired: false }, select: { id: true, name: true, workflowId: true } }),
      prisma.serviceRequest.findMany({ where: { acceptedAt: { gte: since }, NOT: { serviceItemId: null } }, select: { serviceItemId: true, workflowInstanceId: true } }),
      prisma.task.findMany({ where: { workflowInstanceId: null, OR: [{ dueDate: { gte: since } }, { status: { not: "done" } }] }, select: { title: true, docType: true, companyId: true }, take: 20000 }),
    ]);
    for (const svc of services.filter(s => !s.workflowId)) {
      const n = requests.filter(r => r.serviceItemId === svc.id).length;
      if (n < 3) continue;
      await raise({ kind: "pattern", key: `service:${svc.id}`,
        title: `${svc.name} was requested ${n} times in 90 days with no workflow`,
        summary: "Every one was run by hand. A workflow gives it the same steps, checklist and deadlines each time.",
        output: { facts: [{ label: "Service", value: svc.name }, { label: "Requests accepted", value: String(n) }] } });
    }
    // Hand-made tasks: the words that repeat once names, numbers and references are stripped away.
    const shape = (t: { title: string; docType: string | null }) => t.docType ? `renew ${t.docType.toLowerCase()}` : t.title.toLowerCase().replace(/\b[a-z]{2,}-\d+\b|\d+/g, "").split(/[—–:·(]/)[0].trim().split(/\s+/).slice(0, 4).join(" ");
    for (const [label, rows] of groupBy(tasks, t => { const s = shape(t); return s.length >= 6 ? s : null; })) {
      if (rows.length < REPEAT_MIN) continue;
      const clients = new Set(rows.map(r => r.companyId)).size;
      if (clients < 2) continue;
      await raise({ kind: "pattern", key: `task:${label}`,
        title: `“${label}” was created by hand ${rows.length} times for ${clients} clients`,
        summary: "The same work, typed in each time. Turn it into a service with a workflow so nothing is skipped.",
        output: { lists: [{ title: "Examples", items: rows.slice(0, 8).map(r => ({ text: r.title })) }] } });
    }
  });
}

export const actStuck = standardAct(STUCK, { module: "Workflow", what: "close workflow findings" });
export const actExit = standardAct(EXIT, { module: "Clients", what: "close exit checklists" });
export const actAppt = standardAct(APPT, { module: "Tasks", what: "close appointment checks" });
export const actOriginals = standardAct(ORIGINALS, { module: "Tasks", what: "close courier findings" });
export const actRepeat = standardAct(REPEAT, { module: "Workflow", what: "close workflow suggestions" });
