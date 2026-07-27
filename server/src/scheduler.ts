// ─────────────────────────────────────────────────────────────
// SCHEDULER — the system's heartbeat.
// Nothing here ran on a timer before: `daysLeft`/`status` were written once at creation and never
// revisited, so compliance state silently drifted (a document could be days overdue and still be
// labelled "expiring"). This ticks and re-derives it from `expiryDate`.
//
// Jobs must be IDEMPOTENT — the tick runs at boot and hourly, so anything that creates records needs
// its own guard. The recompute below is pure derivation, so repeating it is free and self-healing.
// ─────────────────────────────────────────────────────────────
import { prisma } from "./db.js";
import { logAudit } from "./auth.js";
import { triggerRenewals, escalateSla, renewSubscriptions, resumeParkedTasks, chaseOverdueInvoices } from "./jobs.js";

const DAY = 86400000;

export type RecomputeResult = {
  scanned: number;
  changed: number;
  skippedInProgress: number;
  /** Documents whose expiry is missing or unparseable — tracked, not silently ignored. */
  undated: number;
  transitions: { docType: string; person: string; from: string; to: string; daysLeft: number }[];
};

/**
 * Re-derive daysLeft + status from expiryDate for every document.
 * Mirrors the rule used when a workflow issues a document (workflow.ts `statusOf`):
 *   daysLeft < 0            → overdue
 *   daysLeft <= leadDays    → expiring   (leadDays from the DocumentType, default 30)
 *   otherwise               → valid
 */
export async function recomputeCompliance(): Promise<RecomputeResult> {
  const types = await prisma.documentType.findMany({ select: { name: true, leadDays: true } });
  const leadFor = new Map(types.map(t => [t.name, t.leadDays ?? 30]));
  // ALL documents, not just dated ones. An undated document used to be invisible here and keep its
  // creation-time default of "valid" forever — a compliance system reporting a document it knows
  // nothing about as compliant. They are now marked "unknown" so a human is asked for the date.
  const docs = await prisma.document.findMany();

  const now = Date.now();
  const out: RecomputeResult = { scanned: 0, changed: 0, skippedInProgress: 0, undated: 0, transitions: [] };

  for (const d of docs) {
    const t = d.expiryDate ? new Date(d.expiryDate).getTime() : NaN;
    if (isNaN(t)) {
      // Missing or unparseable ("6786786"). We cannot invent an expiry date — the honest state is
      // "we don't know", and an unparseable string is normalised away so it can't masquerade as one.
      out.undated++;
      const inFlight = d.status === "in_progress";
      const needsFix = !inFlight && (d.status !== "unknown" || (d.expiryDate != null && isNaN(t)));
      if (needsFix) {
        await prisma.document.update({
          where: { id: d.id },
          data: { status: "unknown", daysLeft: 0, ...(d.expiryDate != null ? { expiryDate: null } : {}) },
        });
        out.changed++;
        out.transitions.push({ docType: d.docType, person: d.person, from: d.status, to: "unknown", daysLeft: 0 });
      }
      continue;
    }
    out.scanned++;

    const daysLeft = Math.round((t - now) / DAY);
    // A renewal in flight owns the status. Recomputing it would stomp "in_progress" back to
    // expiring/overdue and silently erase the fact that someone is already working on it.
    const renewalInFlight = d.status === "in_progress";
    if (renewalInFlight) out.skippedInProgress++;

    const lead = leadFor.get(d.docType) ?? 30;
    const status = daysLeft < 0 ? "overdue" : daysLeft <= lead ? "expiring" : "valid";

    const daysSame = d.daysLeft === daysLeft;
    const statusSame = renewalInFlight || d.status === status;
    if (daysSame && statusSame) continue;

    await prisma.document.update({
      where: { id: d.id },
      data: { daysLeft, ...(renewalInFlight ? {} : { status }) },
    });
    out.changed++;
    if (!statusSame) out.transitions.push({ docType: d.docType, person: d.person, from: d.status, to: status, daysLeft });
  }
  return out;
}

/** Run one job in isolation: a job that throws is recorded and the rest of the tick continues. */
async function safely<T>(name: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); }
  catch (e: any) { console.error(`[cron] ${name} failed:`, e?.message ?? e); return { error: String(e?.message ?? e) }; }
}

/**
 * One pass of every scheduled job. Safe to call by hand (POST /api/cron/tick) or on a timer.
 * Order is deliberate: recompute first so everything downstream reads fresh daysLeft, then trigger
 * renewals (which may create the very steps the SLA job then evaluates), then escalate, then bill.
 */
export async function runTick(source: "boot" | "timer" | "manual" = "timer") {
  const started = Date.now();
  const compliance = await recomputeCompliance();
  // Only audit when something actually moved — a recurring "nothing changed" line is just noise.
  if (compliance.changed) {
    const moved = compliance.transitions.map(t => `${t.docType} — ${t.person}: ${t.from}→${t.to}`).join("; ");
    await logAudit({
      action: "cron.compliance_recompute",
      target: `${compliance.changed}/${compliance.scanned} documents${compliance.undated ? ` · ${compliance.undated} undated` : ""}`,
      detail: [`source=${source}`, moved && `status changes: ${moved}`].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const renewals = await safely("renewals", triggerRenewals);
  if ("started" in renewals && (renewals.started || renewals.released)) {
    await logAudit({
      action: "cron.renewals_triggered",
      target: `${renewals.started} started, ${renewals.released} released`,
      detail: [`source=${source}`, renewals.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const sla = await safely("sla", escalateSla);
  if ("escalated" in sla && sla.escalated.length) {
    await logAudit({
      action: "cron.sla_escalated",
      target: `${sla.breached} breached, ${sla.atRisk} at risk`,
      detail: [`source=${source}`, sla.escalated.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const parked = await safely("parked", resumeParkedTasks);
  if ("resumed" in parked && parked.resumed) {
    await logAudit({
      action: "cron.parked_resumed",
      target: `${parked.resumed} task(s) resumed`,
      detail: [`source=${source}`, parked.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const billing = await safely("billing", renewSubscriptions);
  if ("renewed" in billing && (billing.renewed || billing.lapsed)) {
    await logAudit({
      action: "cron.subscriptions_renewed",
      target: `${billing.renewed} renewed, ${billing.invoiced} draft invoices, ${billing.lapsed} lapsed`,
      detail: [`source=${source}`, billing.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const dunning = await safely("dunning", chaseOverdueInvoices);
  if ("chased" in dunning && (dunning.chased || dunning.markedOverdue || dunning.settledButUnmarked)) {
    await logAudit({
      action: "cron.invoices_chased",
      target: `${dunning.chased} chased, ${dunning.markedOverdue} marked overdue, ${dunning.settledButUnmarked} auto-settled`,
      detail: [`source=${source}`, dunning.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  return { source, ms: Date.now() - started, compliance, renewals, sla, billing, parked, dunning };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the heartbeat: once at boot (so a restart immediately heals any drift), then hourly.
 * Hourly rather than daily because the recompute is idempotent and cheap — it costs one query per
 * hour and keeps status at most an hour stale instead of up to a day.
 */
export function startScheduler() {
  if (timer) return () => {};
  const tick = async (source: "boot" | "timer") => {
    try {
      const r = await runTick(source);
      const bits = [
        r.compliance.changed && `compliance ${r.compliance.changed}/${r.compliance.scanned}`,
        "started" in r.renewals && r.renewals.started && `renewals ${r.renewals.started}`,
        "escalated" in r.sla && r.sla.escalated.length && `sla ${r.sla.escalated.length}`,
        "renewed" in r.billing && r.billing.renewed && `billed ${r.billing.invoiced}`,
        "chased" in r.dunning && r.dunning.chased && `chased ${r.dunning.chased}`,
      ].filter(Boolean);
      if (bits.length) console.log(`[cron] ${bits.join(" · ")} (${r.ms}ms)`);
    } catch (e: any) {
      console.error("[cron] tick failed:", e?.message ?? e); // never let a job kill the process
    }
  };
  tick("boot");
  timer = setInterval(() => tick("timer"), 60 * 60 * 1000);
  timer.unref?.(); // don't hold the process open on shutdown
  return () => { if (timer) clearInterval(timer); timer = null; };
}
