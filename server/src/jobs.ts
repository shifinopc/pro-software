// ─────────────────────────────────────────────────────────────
// AUTOMATION JOBS — the things that act on their own, run by the scheduler tick.
//
// Every job here obeys three rules, because the tick repeats hourly:
//  1. IDEMPOTENT — a second run in the same state must do nothing. Each job carries an explicit
//     marker for this (Document.renewalRunId, WorkflowTask.slaState, Subscription.lastBilledFor,
//     Notification.dedupeKey). Without them the tick bills a client 24×/day and re-notifies forever.
//  2. MIRRORS the existing rule, never invents one. SLA thresholds here match what the SLA Monitor
//     screen renders; if they drift, the scoreboard and the actor disagree.
//  3. NON-FATAL — one job failing must not stop the others or kill the process.
// ─────────────────────────────────────────────────────────────
import { prisma } from "./db.js";
import { logActivity, logNotification } from "./auth.js";
import { startInstance } from "./workflow.js";
import { notifyDocumentExpiring, notifySlaBreach, notifyInvoiceRaised, notifyInvoiceOverdue } from "./notify.js";

const DAY = 86400000;
const HOUR = 3600000;
const nowISO = () => new Date().toISOString();

/** Parse the app's mixed date formats: ISO ("2026-07-16") and display ("15 Aug 2026") both occur. */
export function parseDate(s?: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return isNaN(t) ? null : t;
}
const daysUntil = (ms: number) => Math.round((ms - Date.now()) / DAY);
/** Format back in "15 Aug 2026" style — the format Subscription.endDate already uses. */
const fmtDisplay = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Insert a notification at most once per key. The unique index IS the dedupe — no read-then-write race. */
async function notifyOnce(key: string, entry: { type: string; title: string; message?: string }) {
  try {
    await prisma.notification.create({
      data: { type: entry.type, title: entry.title, message: entry.message ?? null, time: "Just now", read: false, dedupeKey: key },
    });
    return true;
  } catch {
    return false; // unique violation = already sent. Expected, not an error.
  }
}

const PRIORITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, urgent: 3 };
/** Escalation only ever raises priority — never quietly demotes what a human deliberately set high. */
const raisePriority = (current: string, target: string) =>
  (PRIORITY_RANK[target] ?? 0) > (PRIORITY_RANK[current] ?? 0) ? target : current;

// ─────────────────────────────────────────────────────────────
// #2 — EXPIRY-TRIGGERED RENEWALS
// A document crosses its lead time → its renewal starts itself.
// Binding: WorkflowTemplate.trigger = "document_expiry" + triggerConfig = { docType, days }.
// Both existed in the schema and were never read; this is what reads them.
// Strictly OPT-IN: a docType with no bound active template is never auto-renewed. That's deliberate —
// implicit triggering would mass-file renewals across every document the moment this shipped.
// ─────────────────────────────────────────────────────────────
export type RenewalResult = { considered: number; started: number; released: number; skipped: number; skippedExiting: number; details: string[] };

export async function triggerRenewals(): Promise<RenewalResult> {
  const out: RenewalResult = { considered: 0, started: 0, released: 0, skipped: 0, skippedExiting: 0, details: [] };

  // Re-arm documents whose renewal is over (finished, cancelled, or the run was deleted). Without this
  // a stuck pointer would block that document from ever auto-renewing again.
  const inFlight = await prisma.document.findMany({ where: { NOT: { renewalRunId: null } } });
  for (const d of inFlight) {
    const run = await prisma.workflowInstance.findUnique({ where: { id: d.renewalRunId! } });
    if (!run || run.status !== "running") {
      await prisma.document.update({ where: { id: d.id }, data: { renewalRunId: null } });
      out.released++;
    }
  }

  // Never renew for someone who is leaving. The document query below has no relation to Employee, so
  // without this a departed employee's Iqama/visa keeps auto-starting renewal workflows — and billing
  // the client — forever. Gate on exitStatus (which flips the moment an exit is REQUESTED) as well as
  // archived (the final state), because the point is to stop BEFORE the offboarding work is finished.
  const leaving = new Set(
    (await prisma.employee.findMany({
      where: { OR: [{ archived: true }, { NOT: { exitStatus: "active" } }] },
      select: { id: true },
    })).map((e) => e.id),
  );

  const templates = await prisma.workflowTemplate.findMany({ where: { active: true, trigger: "document_expiry" } });
  for (const tpl of templates) {
    const cfg = (tpl.triggerConfig ?? {}) as any;
    const docType = String(cfg.docType ?? "").trim();
    if (!docType) { out.skipped++; continue; } // trigger set but never bound to a type — inert, not an error

    const dt = await prisma.documentType.findFirst({ where: { name: docType } });
    // Lead time: the template's own override wins, else the DocumentType's, else 30.
    const lead = Number(cfg.days) > 0 ? Number(cfg.days) : (dt?.leadDays ?? 30);

    const docs = await prisma.document.findMany({
      where: { docType, renewalRunId: null, NOT: { expiryDate: null } },
      include: { company: { select: { name: true } } },
    });

    for (const d of docs) {
      const exp = parseDate(d.expiryDate);
      if (exp === null) continue;
      if (d.employeeId && leaving.has(d.employeeId)) { out.skippedExiting++; continue; }
      const daysLeft = daysUntil(exp);
      if (daysLeft > lead) continue; // hasn't crossed its lead time yet
      out.considered++;

      try {
        // Hand the engine everything issue_document needs to RENEW (not re-issue): documentId makes it
        // archive old→new into history[] instead of creating a duplicate document.
        const run = await startInstance(tpl.id, {
          title: `${docType} renewal — ${d.person}`,
          companyId: d.companyId,
          clientName: d.company?.name ?? null,
          variables: {
            documentId: d.id, docType, person: d.person, employeeId: d.employeeId ?? null,
            currentExpiry: d.expiryDate, currentNumber: d.docNumber ?? null,
            fee: dt?.defaultFee ?? null, _trigger: "document_expiry", _autoStarted: nowISO(),
          },
        });
        // Claim the document immediately so the next tick skips it.
        await prisma.document.update({ where: { id: d.id }, data: { renewalRunId: run!.id } });
        out.started++;
        out.details.push(`${docType} — ${d.person} (${daysLeft}d)`);
        const first = await notifyOnce(`renewal:${run!.id}`, {
          type: daysLeft < 0 ? "overdue" : "expiring",
          title: `Renewal started: ${docType} — ${d.person}`,
          message: `${daysLeft < 0 ? `Expired ${Math.abs(daysLeft)}d ago` : `Expires in ${daysLeft}d`} · auto-started from ${tpl.name}`,
        });
        // Tell the client their document is being renewed — but only on the FIRST tick that starts
        // this run. notifyOnce returning false means we already sent it, and the hourly tick would
        // otherwise email them every hour.
        if (first) await notifyDocumentExpiring({ companyId: d.companyId, docType, person: d.person, expiryDate: d.expiryDate, daysLeft });
        logActivity({ type: "task", message: `Auto-renewal started: ${docType} — ${d.person} (${tpl.name})` });
      } catch (e: any) {
        // A broken template must not stall every other document behind it.
        out.skipped++;
        out.details.push(`FAILED ${docType} — ${d.person}: ${e?.message ?? e}`);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// #3 — SLA ESCALATION
// The SLA Monitor computed breach state inside the React render and persisted nothing, so nothing
// could act on it. These rules MIRROR that screen exactly:
//   workflow step: remaining = slaHours - elapsed; breached < 0; at_risk <= 25% of budget left
//   document:      breached when daysLeft < 0; at_risk when daysLeft <= 7
// Acts once per TRANSITION (slaState), not once per tick.
// ─────────────────────────────────────────────────────────────
export type SlaResult = { evaluated: number; atRisk: number; breached: number; escalated: string[] };

const DOC_SLA_AT_RISK_DAYS = 7; // matches the SLA Monitor screen

export async function escalateSla(): Promise<SlaResult> {
  const out: SlaResult = { evaluated: 0, atRisk: 0, breached: 0, escalated: [] };

  // ── Workflow steps with an SLA budget ──
  const tasks = await prisma.workflowTask.findMany({
    where: { status: "active", NOT: { slaHours: null } },
    include: { instance: { select: { title: true, clientName: true } } },
  });
  for (const t of tasks) {
    const started = parseDate(t.createdAt);
    if (started === null || !t.slaHours) continue;
    out.evaluated++;

    const remH = t.slaHours - (Date.now() - started) / HOUR;
    const state = remH < 0 ? "breached" : remH <= t.slaHours * 0.25 ? "at_risk" : "on_track";
    if (state === t.slaState) continue; // already acted on this state — say nothing
    if (state === "on_track") { await prisma.workflowTask.update({ where: { id: t.id }, data: { slaState: state } }); continue; }

    const who = t.instance?.clientName ? ` (${t.instance.clientName})` : "";
    const priority = raisePriority(t.priority, state === "breached" ? "urgent" : "high");
    await prisma.workflowTask.update({
      where: { id: t.id },
      data: { slaState: state, priority, escalatedAt: nowISO() },
    });
    const slaTitle = `SLA ${state === "breached" ? "BREACHED" : "at risk"}: ${t.title}${who}`;
    const slaDetail = `${state === "breached" ? `${Math.abs(Math.round(remH))}h over` : `${Math.round(remH)}h left`} of a ${t.slaHours}h target · ${t.assigneeRole ?? "unassigned"} · priority → ${priority}`;
    const firstSla = await notifyOnce(`sla:${t.id}:${state}`, {
      type: state === "breached" ? "overdue" : "expiring",
      title: slaTitle,
      message: slaDetail,
    });
    // Only a real breach emails the team, and only once — "at risk" stays in the in-app queue so the
    // hourly tick can't turn a busy day into an inbox full of warnings.
    if (firstSla && state === "breached") await notifySlaBreach({ title: slaTitle, detail: slaDetail });
    logActivity({ type: "task", message: `SLA ${state}: ${t.title}${who} — priority ${priority}` });
    state === "breached" ? out.breached++ : out.atRisk++;
    out.escalated.push(`${t.title} → ${state}`);
  }

  // ── Documents: expiry IS the deadline ──
  const docs = await prisma.document.findMany({
    where: { NOT: { expiryDate: null } },
    include: { company: { select: { name: true } } },
  });
  for (const d of docs) {
    const exp = parseDate(d.expiryDate);
    if (exp === null) continue;
    out.evaluated++;
    const daysLeft = daysUntil(exp);
    const state = daysLeft < 0 ? "breached" : daysLeft <= DOC_SLA_AT_RISK_DAYS ? "at_risk" : "on_track";
    if (state === "on_track") continue;

    // Keyed by state, so each document escalates once on entering at_risk and once on breaching.
    const sent = await notifyOnce(`sla:doc:${d.id}:${state}`, {
      type: state === "breached" ? "overdue" : "expiring",
      title: `${state === "breached" ? "OVERDUE" : "Expiring"}: ${d.docType} — ${d.person}`,
      message: `${d.company?.name ?? ""}${d.company?.name ? " · " : ""}${daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}${d.renewalRunId ? " · renewal underway" : " · no renewal started"}`,
    });
    if (!sent) continue; // already escalated at this level

    // Escalate the work, not just the alert: raise the linked renewal task if one exists.
    if (d.renewalTaskId) {
      const task = await prisma.task.findUnique({ where: { id: d.renewalTaskId } });
      if (task) await prisma.task.update({ where: { id: task.id }, data: { priority: raisePriority(task.priority, state === "breached" ? "urgent" : "high") } });
    }
    if (d.renewalRunId) {
      const steps = await prisma.workflowTask.findMany({ where: { instanceId: d.renewalRunId, status: "active" } });
      for (const s of steps) await prisma.workflowTask.update({ where: { id: s.id }, data: { priority: raisePriority(s.priority, state === "breached" ? "urgent" : "high") } });
    }
    state === "breached" ? out.breached++ : out.atRisk++;
    out.escalated.push(`${d.docType} — ${d.person} → ${state}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// #5 — SUBSCRIPTION RENEWAL + RECURRING INVOICES
// autoRenew and the engine's draft_invoice node both existed and neither was ever reached.
// Invoices are raised as DRAFT, never sent — automation may prepare money, a human releases it.
// ─────────────────────────────────────────────────────────────
export type BillingResult = { scanned: number; renewed: number; invoiced: number; lapsed: number; details: string[] };

/** Roll a period forward by the package's billing cycle, preserving the day-of-month where possible. */
function addCycle(ms: number, cycle: string): number {
  const d = new Date(ms);
  const c = (cycle || "monthly").toLowerCase();
  const months = c.startsWith("year") || c === "annual" || c === "annually" ? 12 : c.startsWith("quarter") ? 3 : c.startsWith("week") ? 0 : 1;
  if (months === 0) return ms + 7 * DAY;
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  if (d.getDate() < day) d.setDate(0); // clamp 31 Jan +1mo → 28/29 Feb, never spill into March
  return d.getTime();
}

const MAX_CATCHUP = 12; // a long-dormant subscription bills in arrears, but never unboundedly

export async function renewSubscriptions(): Promise<BillingResult> {
  const out: BillingResult = { scanned: 0, renewed: 0, invoiced: 0, lapsed: 0, details: [] };
  const subs = await prisma.subscription.findMany({
    include: { package: { select: { name: true, billingCycle: true } }, company: { select: { id: true, name: true } } },
  });

  for (const s of subs) {
    let end = parseDate(s.endDate);
    if (end === null) continue;
    out.scanned++;

    // Keep daysLeft honest whether or not it renews — it had the same never-recomputed drift as documents.
    const refreshDays = async (e: number) => {
      const dl = daysUntil(e);
      if (dl !== s.daysLeft) await prisma.subscription.update({ where: { id: s.id }, data: { daysLeft: dl } });
      return dl;
    };

    if (daysUntil(end) > 0) { await refreshDays(end); continue; } // still current

    const who = await resolveSubscriber(s);
    if (!who) {
      // Orphaned subscription (no company, refId resolves to nothing). Refuse to bill: an invoice
      // attributed to nobody is worse than no invoice. Flag it for a human once.
      await refreshDays(end);
      out.details.push(`ORPHAN ${s.package.name} (${s.id}) — no company or group; not billed`);
      await notifyOnce(`sub:orphan:${s.id}`, {
        type: "system", title: `Subscription has no client: ${s.package.name}`,
        message: `Expired ${s.endDate} but isn't linked to a company or group, so it can't be invoiced. Fix the link or delete it.`,
      });
      continue;
    }

    if (!s.autoRenew) {
      // Expired with auto-renew off: it lapses. Say so once; never bill without consent.
      await refreshDays(end);
      if (await notifyOnce(`sub:lapsed:${s.id}:${s.endDate}`, {
        type: "system", title: `Subscription lapsed: ${s.package.name}`,
        message: `${who.name} · ended ${s.endDate} · auto-renew is off — renew manually or the client is unsubscribed`,
      })) out.lapsed++;
      continue;
    }

    // Roll forward, raising one draft invoice per elapsed period (arrears are billed, not skipped).
    let cycles = 0;
    while (daysUntil(end) <= 0 && cycles < MAX_CATCHUP) {
      const periodEnd = new Date(end).toISOString();
      if (s.lastBilledFor === periodEnd) { end = addCycle(end, s.package.billingCycle); cycles++; continue; } // already billed

      const next = addCycle(end, s.package.billingCycle);
      const label = who.name;
      const number = `SUB-${new Date(end).getFullYear()}${String(new Date(end).getMonth() + 1).padStart(2, "0")}-${s.id.slice(-4).toUpperCase()}`;
      // ATOMIC: raising the invoice and advancing the billing period must succeed or fail together.
      // Previously these were two separate writes — a crash (or DB error) between them left the
      // client invoiced with `lastBilledFor` unset, so the next tick billed the SAME period again.
      // That guard is the only thing preventing duplicate charges, so it cannot lag behind the invoice.
      try {
        await prisma.$transaction([
          prisma.invoice.create({
            data: {
              number, companyId: who.companyId, clientName: label,
              amount: s.price, currency: "SAR", status: "draft", // DRAFT: a human releases it
              date: new Date().toISOString().slice(0, 10),
              dueDate: new Date(next).toISOString().slice(0, 10),
              services: `${s.package.name} — ${s.package.billingCycle} subscription (${fmtDisplay(end)} → ${fmtDisplay(next)})`,
              items: [{ name: `${s.package.name} subscription · ${s.package.billingCycle}`, units: 1, price: s.price }],
            },
          }),
          prisma.subscription.update({
            where: { id: s.id },
            data: { endDate: fmtDisplay(next), lastBilledFor: periodEnd, lastRenewedAt: nowISO(), daysLeft: daysUntil(next) },
          }),
        ]);
        out.invoiced++;
      } catch (e: any) {
        out.details.push(`billing FAILED ${s.package.name} (${label}): ${e?.message ?? e}`);
        break; // nothing was written — retry next tick
      }
      s.lastBilledFor = periodEnd;
      end = next; cycles++;
      out.renewed++;
      out.details.push(`${s.package.name} — ${label} → ${fmtDisplay(next)} (SAR ${s.price})`);
      logActivity({ type: "finance", message: `Subscription auto-renewed: ${s.package.name} — ${label} → ${fmtDisplay(next)} · draft invoice ${number}` });
      await notifyOnce(`sub:renewed:${s.id}:${periodEnd}`, {
        type: "system", title: `Subscription renewed: ${s.package.name}`,
        message: `${label} · draft invoice ${number} for SAR ${s.price} is ready to review`,
      });
    }
    if (cycles >= MAX_CATCHUP) out.details.push(`${s.package.name}: stopped at ${MAX_CATCHUP} catch-up periods — needs manual review`);
  }
  return out;
}

/**
 * Who gets billed. `companyId` is the direct link, but it's nullable and some rows only carry
 * scope+refId, so fall back to resolving refId as a company (scope="company") or a group.
 * Returns null when the subscriber can't be identified at all — the caller must NOT invent an invoice.
 */
async function resolveSubscriber(s: { scope: string; refId: string; companyId?: string | null; company?: { id: string; name: string } | null }): Promise<{ companyId: string | null; name: string } | null> {
  if (s.company) return { companyId: s.company.id, name: s.company.name };
  if (s.scope === "company") {
    const c = await prisma.company.findUnique({ where: { id: s.refId } }).catch(() => null);
    if (c) return { companyId: c.id, name: c.name };
  }
  if (s.scope === "group") {
    const g = await prisma.clientGroup.findUnique({ where: { id: s.refId } }).catch(() => null);
    if (g) return { companyId: null, name: g.name }; // group-scoped: billed to the group, no single company
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// #5 — PARKED-TASK AUTO-RESUME
// A renewal task can be parked on a prerequisite (task.blockedBy = { reason, prereqDocId?, runIds?,
// autoResume?, resumeWorkflowId? }). Nothing ever cleared that flag — "Resume when ready" was a dead
// button and the park never lifted on its own. This job resumes a parked task when its prerequisite
// is actually met:
//   • prereqDocId set  → that document is back to status "valid"
//   • runIds set       → every referenced workflow run has finished (not "running")
// On resume: blockedBy is cleared (status untouched), staff are notified, and if autoResume +
// resumeWorkflowId were requested the Phase-2 workflow is started and linked to the task.
// ─────────────────────────────────────────────────────────────
export type ResumeResult = { scanned: number; resumed: number; details: string[] };

export async function resumeParkedTasks(): Promise<ResumeResult> {
  const out: ResumeResult = { scanned: 0, resumed: 0, details: [] };
  const tasks = await prisma.task.findMany({ where: { archived: false, NOT: { status: "done" } } });
  for (const t of tasks) {
    const bb = t.blockedBy as any;
    if (!bb || typeof bb !== "object") continue;
    out.scanned++;

    let met = false;
    if (bb.prereqDocId) {
      const doc = await prisma.document.findUnique({ where: { id: String(bb.prereqDocId) } }).catch(() => null);
      met = !!doc && String(doc.status).toLowerCase() === "valid";
    } else if (Array.isArray(bb.runIds) && bb.runIds.length) {
      const runs = await prisma.workflowInstance.findMany({ where: { id: { in: bb.runIds.map(String) } } });
      // A deleted run can't block forever; only a still-running one holds the park.
      met = runs.every(r => r.status !== "running");
    }
    if (!met) continue;

    await prisma.task.update({ where: { id: t.id }, data: { blockedBy: null as any } });
    out.resumed++;
    out.details.push(`${t.title} (${bb.reason ?? "prerequisite met"})`);
    logNotification({ type: "task", title: `Task resumed: ${t.title}`, message: `Prerequisite met — ${bb.reason ?? "ready to proceed"}` });
    logActivity({ type: "task", message: `Parked task resumed automatically: ${t.title}` });

    if (bb.autoResume && bb.resumeWorkflowId) {
      try {
        const run = await startInstance(String(bb.resumeWorkflowId), {
          title: t.title, companyId: t.companyId ?? null, clientName: t.clientName ?? null,
          variables: { _resumedFromTask: t.id, docType: t.docType ?? null },
        });
        await prisma.task.update({ where: { id: t.id }, data: { workflowInstanceId: run!.id } });
        out.details.push(`→ Phase-2 workflow started for ${t.title}`);
      } catch (e: any) { out.details.push(`Phase-2 start FAILED for ${t.title}: ${e?.message ?? e}`); }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// #5 — INVOICE DUNNING
// An invoice past its due date used to go overdue SILENTLY: "Overdue" was computed in the UI from
// dueDate and never persisted, so nothing could act on it — no chase to the client, no flag for the
// team, and reports that read `status` never saw it.
//
// This job does two separate things:
//   a) PERSISTS the overdue status, so the database agrees with what the screens show.
//   b) Chases the client on a fixed ladder (1 / 7 / 14 / 30 days past due).
//
// Idempotency is the whole game here, because the tick runs HOURLY. Each rung is sent at most once
// per invoice via Notification.dedupeKey — without that a client gets 24 chasers a day.
// Never chases: drafts (nobody has released them), paid invoices, or anything already settled by
// payments even if the status column hasn't caught up.
// ─────────────────────────────────────────────────────────────
export type DunningResult = {
  scanned: number; markedOverdue: number; chased: number; settledButUnmarked: number; details: string[];
};

/** Days past due at which we chase. Ascending; each fires once. */
const DUNNING_LADDER = [1, 7, 14, 30];
/** Statuses that mean "money is owed" — a draft has not been released, a paid one is done. */
const CHASEABLE = new Set(["pending", "unpaid", "sent", "overdue"]);

export async function chaseOverdueInvoices(): Promise<DunningResult> {
  const out: DunningResult = { scanned: 0, markedOverdue: 0, chased: 0, settledButUnmarked: 0, details: [] };

  const invoices = await prisma.invoice.findMany({
    where: { NOT: { dueDate: null }, status: { in: [...CHASEABLE] } },
    include: { company: { select: { name: true } } },
  });

  for (const inv of invoices) {
    const due = parseDate(inv.dueDate);
    if (due === null) continue; // unparseable due date — leave it alone rather than guess
    out.scanned++;

    const daysOverdue = -daysUntil(due);
    if (daysOverdue < 1) continue; // not due yet (or due today) — nothing to chase

    // Settlement is decided from the PAYMENTS, not the status column: a part-paid invoice may still
    // owe money, and a fully-paid one whose status was never flipped must not be chased.
    const paid = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    const outstanding = inv.amount - (paid._sum.amount ?? 0);
    if (outstanding <= 0) {
      // Fully covered but still marked unpaid — correct the record instead of chasing.
      if (inv.status !== "paid") {
        await prisma.invoice.update({ where: { id: inv.id }, data: { status: "paid" } });
        out.settledButUnmarked++;
        out.details.push(`${inv.number}: payments cover it — marked paid`);
      }
      continue;
    }

    // (a) Persist the overdue flag so the DB matches what every screen already shows.
    if (inv.status !== "overdue") {
      await prisma.invoice.update({ where: { id: inv.id }, data: { status: "overdue" } });
      out.markedOverdue++;
      logActivity({ type: "finance", message: `Invoice ${inv.number} is overdue (${daysOverdue}d)${inv.clientName ? ` — ${inv.clientName}` : ""}` });
    }

    // (b) Chase on the ladder: the highest rung reached that hasn't been sent yet.
    const rung = [...DUNNING_LADDER].reverse().find((d) => daysOverdue >= d);
    if (rung == null) continue;

    const first = await notifyOnce(`dunning:${inv.id}:${rung}`, {
      type: "overdue",
      title: `Invoice ${inv.number} overdue ${rung}d${inv.clientName ? ` — ${inv.clientName}` : ""}`,
      message: `${inv.currency} ${outstanding.toLocaleString()} outstanding · due ${inv.dueDate}`,
    });
    if (!first) continue; // this rung already went out — the hourly tick must not repeat it

    await notifyInvoiceOverdue({
      companyId: inv.companyId,
      number: inv.number,
      outstanding,
      currency: inv.currency,
      dueDate: inv.dueDate,
      daysOverdue,
      // The last rung also alerts the team: at 30 days past due this stops being a reminder.
      alsoStaff: rung === DUNNING_LADDER[DUNNING_LADDER.length - 1],
      clientName: inv.clientName ?? inv.company?.name ?? null,
    });
    out.chased++;
    out.details.push(`${inv.number}: ${rung}d rung · ${inv.currency} ${outstanding.toLocaleString()} outstanding`);
  }

  return out;
}
