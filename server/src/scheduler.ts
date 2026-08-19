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
import { sendDueDigests, pruneDigests } from "./digest.js";
import { mailHealth, pruneMailLog } from "./mailer.js";
import { triggerRenewals, checkWorkforceBands, checkFollowUps, raiseRenewalDeals, chaseQuotations, checkIdleLeads, escalateSla, watchStatutory, renewSubscriptions, resumeParkedTasks, chaseOverdueInvoices, remindUnapprovedDrafts, assignOrphanTasks } from "./jobs.js";
import { resumeDueDelays } from "./workflow.js";
import { captureWorkforceSnapshots } from "./workforce.js";

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
  // Superseded rows keep their old status as history; recomputing them would resurrect an expired
  // passport into the overdue counters after it had already been replaced.
  const docs = await prisma.document.findMany({ where: { supersededAt: null } });
  // Types that have no expiry at all, so a missing date on one of their documents is the answer
  // rather than a gap. Without this, "nobody has entered the expiry yet" and "this record does not
  // have one" were the same null and both came out as "unknown".
  const permanent = new Set((await prisma.documentType.findMany({ where: { neverExpires: true }, select: { name: true } })).map(t => t.name));

  const now = Date.now();
  const out: RecomputeResult = { scanned: 0, changed: 0, skippedInProgress: 0, undated: 0, transitions: [] };

  for (const d of docs) {
    const t = d.expiryDate ? new Date(d.expiryDate).getTime() : NaN;

    // A record that cannot expire is permanently valid, not permanently unknown. It has no deadline,
    // so it belongs in no deadline report — which is what put seven GOSI registrations in the SLA
    // Monitor at "0d left" with an Escalate button beside them.
    if (permanent.has(d.docType)) {
      if (d.status !== "valid" || d.daysLeft !== 0 || d.expiryDate != null) {
        await prisma.document.update({ where: { id: d.id }, data: { status: "valid", daysLeft: 0, expiryDate: null } });
        out.changed++;
        out.transitions.push({ docType: d.docType, person: d.person, from: d.status, to: "valid", daysLeft: 0 });
      }
      out.scanned++;
      continue;
    }

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
  // `held` counts too: a tick that started nothing because every candidate was waiting on a
  // prerequisite is a real outcome, and logging nothing would read as "the trigger did not run".
  if ("started" in renewals && (renewals.started || renewals.released || renewals.held)) {
    await logAudit({
      action: "cron.renewals_triggered",
      target: `${renewals.started} started, ${renewals.released} released${renewals.held ? `, ${renewals.held} held on prerequisites` : ""}`,
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

  // Separate from the SLA pass above on purpose: an SLA breach is a promise this office made, a
  // statutory breach is a deadline in law. One asks somebody to hurry; the other has already cost
  // money, and in the GOSI case has closed the door rather than delayed it.
  const statutory = await safely("statutory", watchStatutory);
  if ("raised" in statutory && statutory.raised.length) {
    await logAudit({
      action: "cron.statutory_breached",
      target: `${statutory.breached} deadline(s) passed`,
      detail: [`source=${source}`, statutory.raised.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
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

  // Workflow `delay` nodes. The engine parks the run; this is what wakes it. Before this the node
  // logged its intended wait and continued immediately, so nothing in the product ever actually waited.
  const delays = await safely("delays", resumeDueDelays);
  if ("resumed" in delays && delays.resumed) {
    await logAudit({
      action: "cron.delays_resumed",
      target: `${delays.resumed} run(s) resumed after a delay${delays.waiting ? `, ${delays.waiting} still waiting` : ""}`,
      detail: [`source=${source}`, delays.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  // Nationalisation bands. Everything this needs already existed — the ratio, the thresholds, the
  // distance to the next band — and nothing watched it. A number nobody looks at is not a control.
  // Record where every client stands today, BEFORE the band job reads it — so the row exists even
  // if the alerting throws, and so a day is never missed for a reason unrelated to the workforce.
  // History cannot be backfilled: an employee record does not say when it was added.
  const wfSnap = await safely("workforce-history", () => captureWorkforceSnapshots());

  const wfBands = await safely("workforce", checkWorkforceBands);
  if ("checked" in wfBands && (wfBands.dropped || wfBands.nearEdge)) {
    await logAudit({
      action: "cron.workforce_bands",
      target: `${wfBands.dropped} dropped, ${wfBands.nearEdge} close to the edge`,
      detail: [`source=${source}`, wfBands.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  // What somebody said they would do, and the deals nobody has said anything about. The pipeline is
  // only as good as the chasing, and the chasing is the part that gets forgotten.
  // Every connected mailbox, pulled. One index built for the whole pass rather than per mailbox:
  // the contact list does not change between two syncs a second apart, and rebuilding it per rep
  // would make the cost of this job scale with headcount for no gain.
  const mailbox = await safely("mailbox-sync", async () => {
    const { buildMatchIndex, syncMailbox } = await import("./mailbox.js");
    const { providerFor } = await import("./mailproviders.js");
    const conns = await prisma.mailboxConnection.findMany({ where: { status: { not: "disconnected" } }, select: { userId: true, provider: true } });
    if (!conns.length) return { mailboxes: 0, stored: 0, failed: 0, details: [] as string[] };
    const index = await buildMatchIndex();
    let stored = 0, failed = 0;
    const details: string[] = [];
    for (const c of conns) {
      const out = await syncMailbox(c.userId, providerFor(c.provider), index);
      stored += out.stored;
      if (out.error) { failed++; details.push(out.error.slice(0, 120)); }
    }
    return { mailboxes: conns.length, stored, failed, details };
  });
  if ("mailboxes" in mailbox && (mailbox.stored || mailbox.failed)) {
    await logAudit({
      action: "cron.mailbox_sync",
      target: `${mailbox.stored} message(s) from ${mailbox.mailboxes} mailbox(es)`,
      detail: [`source=${source}`, mailbox.failed ? `${mailbox.failed} failed: ${mailbox.details.join("; ")}` : ""].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const followUps = await safely("follow-ups", checkFollowUps);
  if ("due" in followUps && (followUps.overdue || followUps.stale)) {
    await logAudit({
      action: "cron.follow_ups",
      target: `${followUps.due} due (${followUps.overdue} overdue), ${followUps.stale} deals gone quiet`,
      detail: [`source=${source}`, followUps.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  // Subscriptions that will not renew themselves. Raised BEFORE they lapse, so somebody can still
  // do something about it — the lapse notice below fires once it is already too late.
  const renewalDeals = await safely("renewal-deals", raiseRenewalDeals);
  if ("created" in renewalDeals && renewalDeals.created) {
    await logAudit({
      action: "cron.renewal_deals",
      target: `${renewalDeals.created} renewal deal(s) raised of ${renewalDeals.considered} approaching`,
      detail: [`source=${source}`, renewalDeals.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  // Money already quoted and then forgotten — the most expensive silence in the product. Runs
  // BEFORE billing so a quotation about to lapse is raised in the same tick that bills for the
  // work already won, rather than a cycle later.
  // Leads nothing is happening to: no deal, no contact, in no column, on no queue.
  const idle = await safely("idle-leads", checkIdleLeads);
  if ("nudged" in idle && idle.nudged) {
    await logAudit({
      action: "cron.idle_leads",
      target: `${idle.nudged} lead(s) with nothing happening, of ${idle.checked}`,
      detail: [`source=${source}`, idle.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const quotes = await safely("quote-chase", chaseQuotations);
  if ("chased" in quotes && (quotes.chased || quotes.expiringSoon || quotes.lapsed)) {
    await logAudit({
      action: "cron.quotes_chased",
      target: `${quotes.chased} unanswered, ${quotes.expiringSoon} about to lapse, ${quotes.lapsed} lapsed`,
      detail: [`source=${source}`, quotes.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
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

  const drafts = await safely("drafts", remindUnapprovedDrafts);
  if ("nudged" in drafts && drafts.nudged) {
    await logAudit({
      action: "cron.draft_invoices_nudged",
      target: `${drafts.nudged} of ${drafts.scanned} drafts still unapproved`,
      detail: [`source=${source}`, drafts.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  const orphans = await safely("orphan-tasks", assignOrphanTasks);
  if ("assigned" in orphans && orphans.assigned) {
    await logAudit({
      action: "cron.tasks_assigned",
      target: `${orphans.assigned} of ${orphans.scanned} unassigned steps given an owner`,
      detail: [`source=${source}`, orphans.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }

  // LAST, deliberately: every job above may have queued something, and running the digest after
  // them means a reminder raised this morning goes out in this morning's digest rather than waiting
  // a full day for the next one.
  const digest = await safely("digest", () => sendDueDigests());
  if ("sent" in digest && digest.sent) {
    await logAudit({
      action: "cron.digests_sent",
      target: `${digest.sent} digest(s), ${digest.items} item(s)`,
      detail: [`source=${source}`, digest.details.join("; ")].filter(Boolean).join(" · ").slice(0, 900),
    });
  }
  // Cheap and idempotent, so it rides along rather than needing a schedule of its own.
  await safely("digest-prune", () => pruneDigests().then(removed => ({ removed })));
  await safely("mail-log-prune", () => pruneMailLog().then(removed => ({ removed })));

  /**
   * Mail that did not arrive, said out loud.
   *
   * DELIBERATELY IN-APP ONLY. Emailing somebody about an email that failed is how a broken relay
   * turns one fault into a loop — every notification about the failure fails, and notifies about
   * that. `logNotification` writes the bell row and nothing else, which is exactly what is wanted:
   * a human sees it next time they open the console, and the log panel in Settings → Email has the
   * detail. Keyed by the day so a relay that is down all afternoon raises one row, not two hundred.
   */
  const mail = await safely("mail-health", () => mailHealth(1));
  if ("failed" in mail && mail.failed > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const first = await prisma.notification.create({
      data: {
        type: "system", time: "Just now", createdAt: new Date().toISOString(), read: false,
        dedupeKey: `mail-failed:${day}`,
        title: `${mail.failed} email${mail.failed === 1 ? "" : "s"} could not be sent`,
        message: `${mail.recent[0]?.error ?? "See Settings → Email for the log."} — most recent: ${mail.recent[0]?.to ?? "?"}`.slice(0, 2000),
      },
    }).then(() => true).catch(() => false); // unique violation = already raised today
    if (first) {
      await logAudit({
        action: "cron.mail_failures",
        target: `${mail.failed} failed in the last 24h`,
        detail: [`source=${source}`, mail.recent.slice(0, 3).map(r => `${r.to}: ${r.error ?? "?"}`).join("; ")].filter(Boolean).join(" · ").slice(0, 900),
      });
    }
  }

  // Every job that ran belongs in the result. A job missing from here ran invisibly — the tick
  // response is the only place anyone can see what the hourly pass actually did.
  return { source, ms: Date.now() - started, compliance, renewals, sla, statutory, billing, parked, dunning, drafts, orphans, workforce: wfBands, workforceHistory: wfSnap, followUps, renewalDeals, quotes, idleLeads: idle, digest, mail };
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
        "held" in r.renewals && r.renewals.held && `held ${r.renewals.held}`,
        "escalated" in r.sla && r.sla.escalated.length && `sla ${r.sla.escalated.length}`,
        "raised" in r.statutory && r.statutory.raised.length && `statutory ${r.statutory.raised.length}`,
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
