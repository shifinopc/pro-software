/**
 * CLIENT DOCUMENT CHASER.
 *
 * The longest wait in most PRO work is not the government — it is the client: the passport copy not
 * sent, the insurance not renewed, the fee not approved. This agent finds work that is waiting on the
 * client and reminds them on a ladder (2, 5 and 9 days), stopping the moment the thing arrives. If the
 * client still has not answered by day 12, the officer gets a review item: time to pick up the phone.
 *
 * WHAT COUNTS AS WAITING ON THE CLIENT
 *   · a portal request missing documents its service requires — the client uploads them on the request;
 *   · a renewal held because a prerequisite document is missing or expiring (a passport with under six
 *     months, lapsed insurance) — only the client can fix that;
 *   · a fee approval the renewal preparation agent sent, still unanswered.
 *
 * NO MODEL. These reminders go out without anyone reading them first, so the wording is a template
 * filled with facts from the records. Nothing is sent to a suspended client, and nothing at night.
 * Each reminder sent is recorded against the item, which is also what stops it being sent twice.
 */
import { prisma } from "./db.js";
import { decide, requirePerm, AgentActionError, daysFromToday, DAY, type AgentActor } from "./agent-core.js";
import { requestDocStatus } from "./request-docs.js";
import { unmetPrereqs } from "./jobs.js";
import { notifyClientWaiting } from "./notify.js";
import { orgTimezone } from "./orgsettings.js";
import { logActivity } from "./auth.js";
import { publish } from "./realtime.js";
import { emailEnabled } from "./mailer.js";
import { ACTIVE_CLIENT } from "./validate.js";

export const KEY = "document-chaser";
/** Days waiting at which a reminder goes out, then the day the officer is told the client is silent. */
export const LADDER = [2, 5, 9];
export const ESCALATE_DAY = 12;
const NOT_REQUESTS = new Set(["payment notification", "employee exit"]);

type Waiting = {
  key: string; kind: "request-docs" | "held-renewal" | "fee-approval";
  companyId: string; clientName: string; since: string; title: string;
  needs: string[]; refType: string; refId: string; employeeId?: string | null;
  email: { subject: string; heading: string; lines: string[]; ctaLabel: string; ctaPath: string };
  requestId?: string;
};

const fmt = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(String(iso).slice(0, 10)) : NaN;
  return Number.isNaN(t) ? String(iso ?? "") : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};

/** Everything currently waiting on a client. Recomputed each pass, so anything resolved simply drops out. */
export async function findWaiting(onlyCompanyId?: string): Promise<Waiting[]> {
  const out: Waiting[] = [];
  const clients = await prisma.company.findMany({
    where: { lifecycle: ACTIVE_CLIENT, NOT: { status: "suspended" }, ...(onlyCompanyId ? { id: onlyCompanyId } : {}) },
    select: { id: true, name: true },
  });
  const ids = clients.map(c => c.id);
  const nameOf = new Map(clients.map(c => [c.id, c.name]));

  // 1. Requests missing required documents.
  const requests = await prisma.serviceRequest.findMany({ where: { companyId: { in: ids }, status: { in: ["open", "accepted"] } } });
  for (const rq of requests) {
    if (NOT_REQUESTS.has(String(rq.type ?? "").toLowerCase())) continue;
    const st = await requestDocStatus(rq.id);
    if (!st || !st.missing.length) continue;
    const since = rq.lastClientMsgAt || rq.acceptedAt || new Date().toISOString();
    const list = st.missing.map(m => m.label);
    out.push({
      key: `request:${rq.id}`, kind: "request-docs", companyId: rq.companyId!, clientName: nameOf.get(rq.companyId!) ?? rq.clientName ?? "",
      since, title: `${rq.number ?? "Request"} — ${st.service?.name ?? rq.type ?? "request"}`, needs: list, refType: "serviceRequest", refId: rq.id, requestId: rq.id,
      email: {
        subject: `Still needed for your request ${rq.number ?? ""}: ${list.join(", ")}`.replace("  ", " "),
        heading: "We still need some documents",
        lines: [`To continue with ${st.service?.name ?? rq.type ?? "your request"}${rq.number ? ` (${rq.number})` : ""}, we still need:`, ...list.map(l => `• ${l}`), "Please upload them on the request in your portal. Your PRO team will pick them up straight away."],
        ctaLabel: "Upload in your portal", ctaPath: "/portal/my-requests",
      },
    });
  }

  // 2. Renewals held by a missing or expiring prerequisite.
  const exited = new Set((await prisma.employee.findMany({ where: { OR: [{ archived: true }, { NOT: { exitStatus: "active" } }] }, select: { id: true } })).map(e => e.id));
  const types = await prisma.documentType.findMany({ where: { retired: false } });
  const docs = await prisma.document.findMany({ where: { companyId: { in: ids }, supersededAt: null, renewalRunId: null, NOT: { expiryDate: null } } });
  for (const d of docs) {
    if (d.employeeId && exited.has(d.employeeId)) continue;
    const dt = types.find(t => t.name === d.docType);
    if (!dt) continue;
    const left = daysFromToday(d.expiryDate);
    if (left === null || left > (dt.leadDays ?? 30)) continue;
    const unmet = await unmetPrereqs(dt, d).catch(() => []);
    if (!unmet.length) continue;
    // "Passport valid for at least 6 months (has only 90d left)" — what to provide, then why.
    const needs = unmet.map(u => `${u.need}${u.months ? ` valid for at least ${u.months} month${u.months === 1 ? "" : "s"}` : ""}${u.why ? ` (${u.why})` : ""}`);
    // The hold began when the renewal came due; that is when the client could first have acted.
    const dueFrom = new Date(Date.parse(String(d.expiryDate).slice(0, 10)) - (dt.leadDays ?? 30) * DAY).toISOString();
    out.push({
      key: `held:${d.id}:${unmet.map(u => u.need).sort().join("+")}`, kind: "held-renewal", companyId: d.companyId, clientName: nameOf.get(d.companyId) ?? "",
      since: dueFrom, title: `${d.docType} renewal on hold — ${d.person}`, needs, refType: "document", refId: d.id, employeeId: d.employeeId,
      email: {
        subject: `${d.docType} renewal for ${d.person} is on hold`,
        heading: "A renewal is waiting on you",
        lines: [`${d.person}'s ${d.docType} expires on ${fmt(d.expiryDate)}${left < 0 ? " — it has already expired" : ` (in ${left} days)`}. We cannot start the renewal until we have:`, ...needs.map(n => `• ${n}`), "Please send these to your PRO team, or upload them in your portal, so the renewal can go ahead in time."],
        ctaLabel: "Open your portal", ctaPath: "/portal/renewals",
      },
    });
  }

  // 3. Fee approvals the renewal preparation agent sent that are still unanswered.
  const sent = await prisma.workflowLog.findMany({ where: { action: "agent.fee_request.sent" }, orderBy: { at: "desc" }, take: 500 });
  const seenRun = new Set<string>();
  for (const log of sent) {
    if (seenRun.has(log.instanceId)) continue;
    seenRun.add(log.instanceId);
    const run = await prisma.workflowInstance.findUnique({ where: { id: log.instanceId }, include: { tasks: { where: { status: "active", nodeId: { in: ["fee", "approval"] } } } } });
    if (!run || run.status !== "running" || !run.tasks.length || !run.companyId || !nameOf.has(run.companyId)) continue;
    const v = (run.variables ?? {}) as any;
    out.push({
      key: `fee:${run.id}`, kind: "fee-approval", companyId: run.companyId, clientName: nameOf.get(run.companyId) ?? "",
      since: log.at, title: `Fee approval — ${run.title}`, needs: ["Approval of the renewal fee"], refType: "workflowInstance", refId: run.id, employeeId: v.employeeId ?? null,
      email: {
        subject: `Waiting for your approval: ${v.docType ?? "renewal"} for ${v.person ?? "your employee"}`,
        heading: "We are waiting for your approval",
        lines: [`On ${fmt(log.at)} we sent you the fee for renewing ${v.person ?? "your employee"}'s ${v.docType ?? "document"}.`, "We have not received your approval yet, and the renewal cannot start without it.", "Please reply to that email, or contact your PRO team."],
        ctaLabel: "Open your portal", ctaPath: "/portal/renewals",
      },
    });
  }
  return out;
}

/** Office hours in the firm's own time zone. A reminder at 3 a.m. is a reminder people resent. */
async function officeHours(now = new Date()) {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: await orgTimezone() }).format(now));
    return hour >= 8 && hour < 20;
  } catch { return true; }
}

export async function runChaser(opts: { onlyCompanyId?: string; ignoreHours?: boolean; now?: number } = {}) {
  const out = { waiting: 0, reminded: 0, escalated: 0, resolved: 0, noAddress: 0, details: [] as string[] };
  const now = opts.now ?? Date.now();
  const items = await findWaiting(opts.onlyCompanyId);
  const live = new Set(items.map(i => i.key));
  const hoursOk = opts.ignoreHours || await officeHours(new Date(now));

  for (const w of items) {
    out.waiting++;
    let row = await prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: KEY, dedupeKey: w.key } } });
    if (row && (row.status === "dismissed" || (row.status === "done" && !(row.decision as any)?.auto))) continue;
    const baseOutput = { kind: w.kind, since: w.since, needs: w.needs, clientName: w.clientName };
    if (!row) {
      row = await prisma.agentTask.create({ data: { agent: KEY, dedupeKey: w.key, kind: "waiting", status: "watching", title: w.title, companyId: w.companyId, employeeId: w.employeeId ?? null, refType: w.refType, refId: w.refId, createdAt: new Date(now).toISOString(), summary: `Waiting on the client for: ${w.needs.join("; ")}`, output: { ...baseOutput, reminders: [] } as any } });
    } else if (row.status === "done") {
      // It came back (a new gap after the client had provided everything): watch it again from scratch.
      row = await prisma.agentTask.update({ where: { id: row.id }, data: { status: "watching", decision: undefined as any, decidedAt: null, output: { ...baseOutput, reminders: [] } as any } });
    }
    const o = (row.output ?? {}) as any;
    const sent: { rung: number; at: string; to: string[] }[] = Array.isArray(o.reminders) ? o.reminders : [];
    // Something already waiting a long time when first found starts the ladder then, at its first
    // reminder — the client is never told to expect a phone call before they have been asked once.
    const start = Math.max(Date.parse(w.since), Date.parse(row.createdAt) - LADDER[0] * DAY);
    const days = Math.floor((now - start) / DAY);
    const waitedDays = Math.floor((now - Date.parse(w.since)) / DAY);

    if (days >= ESCALATE_DAY && row.status !== "review") {
      await prisma.agentTask.update({ where: { id: row.id }, data: {
        status: "review", finishedAt: new Date(now).toISOString(),
        summary: `Still waiting after ${waitedDays} days and ${sent.length} reminder${sent.length === 1 ? "" : "s"} for: ${w.needs.join("; ")}. Worth a call.`,
        output: { ...o, ...baseOutput, reminders: sent, days } as any,
      } });
      out.escalated++;
      continue;
    }
    if (row.status === "review") continue;

    const rung = [...LADDER].reverse().find(d => days >= d);
    if (rung === undefined || sent.some(s => s.rung === rung) || !hoursOk) {
      await prisma.agentTask.update({ where: { id: row.id }, data: { summary: `Waiting ${days} day${days === 1 ? "" : "s"} for: ${w.needs.join("; ")}`, output: { ...o, ...baseOutput, reminders: sent, days } as any } });
      continue;
    }
    const nth = LADDER.indexOf(rung) + 1;
    const res = await notifyClientWaiting({ companyId: w.companyId, ...w.email, subject: nth > 1 ? `Reminder: ${w.email.subject}` : w.email.subject });
    if (!res.to.length) {
      out.noAddress++;
      await prisma.agentTask.update({ where: { id: row.id }, data: { status: "review", finishedAt: new Date(now).toISOString(), summary: `${w.clientName} has no portal user or email address, so they cannot be reminded about: ${w.needs.join("; ")}.`, output: { ...o, ...baseOutput, reminders: sent, days, noAddress: true } as any } });
      continue;
    }
    if (res.ruleOn === false) {
      await prisma.agentTask.update({ where: { id: row.id }, data: { summary: `Waiting ${days} days for: ${w.needs.join("; ")}. Not reminded — "Client documents needed" is switched off in Settings → Notifications.`, output: { ...o, ...baseOutput, reminders: sent, days } as any } });
      continue;
    }
    // On a request, the reminder also lands in its thread, where the client uploads the documents.
    if (w.requestId) {
      const at = new Date(now).toISOString();
      const body = [w.email.lines[0], ...w.needs.map(n => `• ${n}`), "Please upload them on this request."].join("\n");
      const msg = await prisma.serviceRequestMessage.create({ data: { requestId: w.requestId, authorType: "staff", authorName: "PRO team (automatic reminder)", body, internal: false, at } });
      await prisma.serviceRequest.update({ where: { id: w.requestId }, data: { lastStaffMsgAt: at } });
      publish("message", { requestId: w.requestId, companyId: w.companyId, message: msg }, { to: "all" });
    }
    sent.push({ rung, at: new Date(now).toISOString(), to: res.to, delivered: await emailEnabled() } as any);
    await prisma.agentTask.update({ where: { id: row.id }, data: { summary: `Reminder ${nth} of ${LADDER.length} sent (day ${days}) for: ${w.needs.join("; ")}`, output: { ...o, ...baseOutput, reminders: sent, days } as any } });
    logActivity({ type: "client", message: `Reminder ${nth} sent to ${w.clientName}: ${w.needs.join(", ")}`, user: "Client Document Chaser" });
    out.reminded++;
    out.details.push(`${w.title}: reminder ${nth}`);
  }

  // Whatever is no longer waiting was provided (or the work moved on): close it.
  const open = await prisma.agentTask.findMany({ where: { agent: KEY, status: { in: ["watching", "review"] }, ...(opts.onlyCompanyId ? { companyId: opts.onlyCompanyId } : {}) } });
  for (const t of open) {
    if (live.has(t.dedupeKey)) continue;
    const o = (t.output ?? {}) as any;
    await prisma.agentTask.update({ where: { id: t.id }, data: { status: "done", finishedAt: new Date(now).toISOString(), decidedAt: new Date(now).toISOString(), decision: { auto: "The client provided it" } as any, summary: `Provided after ${(o.reminders ?? []).length} reminder${(o.reminders ?? []).length === 1 ? "" : "s"}: ${(o.needs ?? []).join("; ")}` } });
    out.resolved++;
  }
  return out;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That item no longer exists.", 404);
  if (!["watching", "review"].includes(t.status)) throw new AgentActionError(`This item is already ${t.status}.`, 409);
  await requirePerm(actor, "Clients", "Edit", "manage client reminders");
  if (action === "done") return decide(t.id, "done", actor, { note: String(input?.note ?? "") || "Followed up by phone" });
  // Stop chasing: the officer has agreed another arrangement with the client. It stays stopped.
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || "Stop reminding" });
  throw new AgentActionError("Unknown action.");
}
