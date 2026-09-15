/**
 * DAILY MANAGER BRIEF — one screen each morning: what is late, what is happening today, what money is
 * expected, what is blocked, who is overloaded, and what the other agents are waiting on.
 *
 * It is read, not acted on: "Mark read" closes it, and tomorrow's replaces it. Every figure is a count
 * of records, named so a manager can go and find them.
 */
import { prisma } from "./db.js";
import { daysFromToday } from "./agent-core.js";
import { runFindings, standardAct, plural, money, today, addDays } from "./agent-kit.js";

export const BRIEF = "manager-brief";
const OPEN_INV = ["pending", "unpaid", "sent", "overdue"];

export async function runManagerBrief() {
  const day = today();
  return runFindings(BRIEF, [], async raise => {
    await prisma.agentTask.updateMany({ where: { agent: BRIEF, status: "review", NOT: { dedupeKey: `brief:${day}` } }, data: { status: "done", decidedAt: new Date().toISOString(), decision: { auto: "Replaced by today's brief" } as any } });
    const weekEnd = addDays(day, 7);
    const [lateTasks, breached, statutory, appts, courier, dueInv, lateInv, steps, agentQueue, newRequests] = await Promise.all([
      prisma.task.findMany({ where: { archived: false, dueDate: { lt: day }, NOT: { status: { in: ["done", "cancelled"] } } }, select: { title: true, assignee: true, clientName: true, dueDate: true } }),
      prisma.workflowTask.findMany({ where: { status: "active", slaState: "breached" }, select: { title: true, assignee: true, instance: { select: { clientName: true } } } }),
      prisma.workflowTask.findMany({ where: { status: "active", statutoryDue: { lte: addDays(day, 3) } }, select: { title: true, statutoryDue: true, instance: { select: { clientName: true } } } }),
      prisma.appointment.findMany({ where: { date: day, NOT: { status: { in: ["Cancelled", "No-show"] } } }, select: { title: true, time: true, clientName: true, employee: true } }),
      prisma.courierShipment.count({ where: { NOT: { status: { in: ["Delivered", "Returned", "Cancelled"] } } } }),
      prisma.invoice.findMany({ where: { status: { in: OPEN_INV }, dueDate: { gte: day, lte: weekEnd } }, select: { amount: true, currency: true } }),
      prisma.invoice.findMany({ where: { status: { in: OPEN_INV }, dueDate: { lt: day } }, select: { amount: true, clientName: true } }),
      prisma.workflowTask.groupBy({ by: ["assignee"], where: { status: "active" }, _count: { _all: true } }),
      prisma.agentTask.groupBy({ by: ["agent"], where: { status: "review", NOT: { agent: BRIEF } }, _count: { _all: true } }),
      prisma.serviceRequest.count({ where: { status: "open" } }),
    ]);
    const blocked = await prisma.task.findMany({ where: { archived: false, NOT: { status: { in: ["done", "cancelled"] } } }, select: { blockedBy: true } }).then(r => r.filter(t => t.blockedBy).length).catch(() => 0);
    const currency = dueInv[0]?.currency ?? "SAR";
    const load = steps.filter(s => s.assignee).sort((a, b) => b._count._all - a._count._all);
    const avg = load.length ? load.reduce((n, s) => n + s._count._all, 0) / load.length : 0;
    const top = (rows: string[], n = 8) => rows.slice(0, n).concat(rows.length > n ? [`…and ${rows.length - n} more`] : []);
    const lists = [
      { title: `Late tasks (${lateTasks.length})`, items: top(lateTasks.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).map(t => `${t.title}${t.clientName ? ` · ${t.clientName}` : ""} · ${t.assignee ?? "unassigned"} · ${Math.max(1, -(daysFromToday(t.dueDate) ?? 0))}d late`)) },
      { title: `Steps past their deadline (${breached.length})`, items: top(breached.map(s => `${s.title} · ${s.instance.clientName ?? ""} · ${s.assignee ?? "unassigned"}`)) },
      { title: `Legal deadlines within 3 days (${statutory.length})`, items: top(statutory.map(s => `${s.title} · ${s.instance.clientName ?? ""} · due ${String(s.statutoryDue).slice(0, 10)}`)) },
      { title: `Appointments today (${appts.length})`, items: top(appts.map(a => `${a.time ?? "--:--"} ${a.title}${a.employee ? ` · ${a.employee}` : ""}${a.clientName ? ` · ${a.clientName}` : ""}`)) },
      { title: "Workload — active steps per person", items: top(load.map(s => `${s.assignee}: ${s._count._all}${avg && s._count._all > avg * 1.6 ? " — well above the others" : ""}`), 6) },
      { title: "Waiting in the agents' queues", items: agentQueue.sort((a, b) => b._count._all - a._count._all).map(a => `${a.agent.replace(/-/g, " ")}: ${a._count._all}`) },
    ].filter(l => l.items.length).map(l => ({ title: l.title, items: l.items.map(text => ({ text })) }));
    const facts = [
      { label: "Cash expected this week", value: `${currency} ${money(dueInv.reduce((n, i) => n + i.amount, 0))} from ${plural(dueInv.length, "invoice")}` },
      { label: "Overdue", value: `${currency} ${money(lateInv.reduce((n, i) => n + i.amount, 0))} across ${plural(lateInv.length, "invoice")}` },
      { label: "New client requests open", value: String(newRequests) },
      { label: "Courier jobs on the move", value: String(courier) },
      { label: "Tasks parked on prerequisites", value: String(blocked) },
    ];
    const headline = [lateTasks.length && plural(lateTasks.length, "late task"), breached.length && `${breached.length} past deadline`, statutory.length && `${statutory.length} legal deadline${statutory.length === 1 ? "" : "s"} close`, appts.length && `${appts.length} appointment${appts.length === 1 ? "" : "s"} today`].filter(Boolean).join(" · ");
    await raise({
      kind: "brief", key: `brief:${day}`,
      title: `Morning brief — ${new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}`,
      summary: headline || "Nothing late, nothing past deadline, no appointments today.",
      output: { facts, lists },
    });
  });
}

export const actBrief = standardAct(BRIEF, { module: "Dashboard", action: "View", what: "read the brief", doneNote: "Read" });
