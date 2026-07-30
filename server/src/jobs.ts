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
import { startInstance, pickAssignee } from "./workflow.js";
import { nextNumber } from "./sequence.js";
import { notifyDocumentExpiring, notifySlaBreach, notifyInvoiceRaised, notifyInvoiceOverdue, notifyAwait } from "./notify.js";
import { figuresFromAmount } from "./money.js";

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
      data: { type: entry.type, title: entry.title, message: entry.message ?? null, time: "Just now", createdAt: nowISO(), read: false, dedupeKey: key },
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
export type RenewalResult = { considered: number; started: number; released: number; skipped: number; skippedExiting: number; held: number; details: string[] };

/**
 * Renewal prerequisites for one document, from its type's `prereqs` rules.
 *
 * Returns every rule that is NOT satisfied. Reads the whole list — the Compliance screen historically
 * looked only at prereqs[0], so a second rule was configurable but never enforced.
 *
 * A company-scoped requirement (Trade License, Commercial Register…) belongs to the client rather than
 * to the person, so it must not be filtered by `person` — otherwise it could never be satisfied for an
 * employee-scoped document.
 */
/** Whole years between a date of birth and today. Derived, never stored — a stored age is wrong within a year. */
export function ageFrom(dob?: string | null): number | null {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}

/** The attributes a rule may test, and where each one lives. One resolver, so nothing reads a fact
 *  from a second place and disagrees with the first. */
export const PREREQ_ATTRS = ["age", "nationality"] as const;
export type PrereqAttr = (typeof PREREQ_ATTRS)[number];
export const ATTR_LABEL: Record<PrereqAttr, string> = { age: "Age", nationality: "Nationality" };

/**
 * Evaluate one attribute rule against an employee.
 *
 * MISSING DATA IS NEITHER A PASS NOR A FAIL. With no date of birth on file, "is this person over 21"
 * has no true answer, and a silent pass on an age check is the kind of thing that reaches a government
 * portal before anyone notices. It reports "cannot check" and the requirement stays unmet, which holds
 * the work until a human supplies the fact.
 */
export function evalAttrRule(r: any, emp: any): { ok: boolean; label: string; why: string } {
  const attr = String(r?.attr ?? "") as PrereqAttr;
  const op = String(r?.op ?? "gte");
  const want = r?.value;
  const label = ATTR_LABEL[attr] ?? attr ?? "Attribute";

  if (!PREREQ_ATTRS.includes(attr)) return { ok: false, label, why: `is configured with an attribute this system does not know ("${attr}")` };
  if (!emp) return { ok: false, label, why: "cannot be checked — this document is not linked to an employee record" };

  if (attr === "age") {
    const age = ageFrom(emp.dob);
    if (age === null) return { ok: false, label, why: "cannot be checked — no date of birth on file" };
    const n = Number(want);
    if (!Number.isFinite(n)) return { ok: false, label, why: "has no number to compare against" };
    const ok = op === "lte" ? age <= n : op === "lt" ? age < n : op === "gt" ? age > n : op === "eq" ? age === n : age >= n;
    const word = op === "lte" ? "at most" : op === "lt" ? "under" : op === "gt" ? "over" : op === "eq" ? "exactly" : "at least";
    return { ok, label, why: ok ? `is ${age}` : `is ${age} — this needs ${word} ${n}` };
  }

  // nationality: a set test, because the real rules are "one of these" rather than a single value.
  const have = String(emp.nationality ?? "").trim();
  if (!have) return { ok: false, label, why: "cannot be checked — no nationality on file" };
  const list = String(want ?? "").split(",").map((s: string) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return { ok: false, label, why: "has no value to compare against" };
  const hit = list.includes(have.toLowerCase());
  const ok = op === "ne" ? !hit : hit;
  const pretty = String(want).trim();
  return { ok, label, why: ok ? `is ${have}` : (op === "ne" ? `is ${have} — this excludes ${pretty}` : `is ${have} — this needs one of ${pretty}`) };
}

/**
 * ONE rule, evaluated once, in one place.
 *
 * Used by unmetPrereqs (the gate) AND by resumeParkedTasks (the release). They used to hold separate
 * logic, so a park could lift on a rule the gate would still refuse — and when attribute rules arrived
 * the park did not know about them at all, meaning an unmet age requirement could not hold anything.
 * The park now stores the raw rules and hands them back to this function.
 *
 * `subject` is anything carrying { companyId, employeeId?, person? } — a Document, a Task, or the
 * shape the /api/prereq-check route builds for a hypothetical one.
 */
export async function evalOneRule(r: any, subject: { companyId?: string | null; employeeId?: string | null; person?: string | null }, emp?: any):
  Promise<{ ok: true } | { ok: false; need: string; months: number; why: string; docId: string | null; rule: any }> {
  // ── Attribute rules: a fact about the PERSON, not another document ──
  // Rules could only ever say "another document, valid N months". A minimum-age requirement is a real
  // thing a government portal asks for, and there was nothing on the row to compare against.
  if (String(r?.kind ?? "") === "attribute") {
    const who = emp !== undefined ? emp
      : subject.employeeId ? await prisma.employee.findUnique({ where: { id: String(subject.employeeId) } }).catch(() => null) : null;
    const res = evalAttrRule(r, who);
    return res.ok ? { ok: true } : { ok: false, need: res.label, months: 0, why: res.why, docId: null, rule: r };
  }

  const need = String(r?.requiresDocType ?? r?.docType ?? "").trim();
  if (!need) return { ok: true }; // a rule naming nothing cannot be unmet
  const months = Math.max(0, Number(r?.minMonths) || 0);
  const needDt = await prisma.documentType.findFirst({ where: { name: need } }).catch(() => null);
  const byCompany = needDt?.subjectKind === "company";
  // Matched on the EMPLOYEE where one is known — two people can share a name, and clearing a
  // requirement with someone else's document is a false pass that looks like diligence.
  const doc = await prisma.document.findFirst({
    where: {
      docType: need, companyId: subject.companyId ?? undefined, supersededAt: null,
      ...(byCompany ? {} : (subject.employeeId ? { employeeId: subject.employeeId } : (subject.person ? { person: subject.person } : {}))),
    },
    orderBy: [{ expiryDate: "desc" }],
  }).catch(() => null);

  if (!doc) {
    // On file under the name but not linked to this person: a different sentence, and an actionable one.
    if (!byCompany && subject.employeeId && subject.person) {
      const loose = await prisma.document.count({ where: { docType: need, companyId: subject.companyId ?? undefined, supersededAt: null, person: subject.person } }).catch(() => 0);
      if (loose) return { ok: false, need, months, why: "is on file but not linked to this employee", docId: null, rule: r };
    }
    return { ok: false, need, months, why: "is not on file", docId: null, rule: r };
  }
  const exp = parseDate(doc.expiryDate);
  if (exp === null) return { ok: false, need, months, why: "has no expiry date recorded", docId: doc.id, rule: r };
  const limit = new Date();
  limit.setMonth(limit.getMonth() + months);
  if (exp < limit.getTime()) {
    const left = daysUntil(exp);
    return { ok: false, need, months, why: left < 0 ? `expired ${Math.abs(left)}d ago` : `has only ${left}d left`, docId: doc.id, rule: r };
  }
  return { ok: true };
}

export async function unmetPrereqs(dt: any, d: any): Promise<{ need: string; months: number; why: string; docId: string | null; rule?: any }[]> {
  const rules: any[] = Array.isArray(dt?.prereqs) ? dt.prereqs : [];
  if (!rules.length) return [];
  const out: { need: string; months: number; why: string; docId: string | null; rule?: any }[] = [];
  // The employee this document belongs to, loaded once for every attribute rule below.
  const emp = d.employeeId ? await prisma.employee.findUnique({ where: { id: String(d.employeeId) } }).catch(() => null) : null;
  for (const r of rules) {
    const res = await evalOneRule(r, { companyId: d.companyId, employeeId: d.employeeId, person: d.person }, emp);
    if (!res.ok) out.push({ need: res.need, months: res.months, why: res.why, docId: res.docId, rule: res.rule });
  }
  return out;
}


export async function triggerRenewals(): Promise<RenewalResult> {
  const out: RenewalResult = { considered: 0, started: 0, released: 0, skipped: 0, skippedExiting: 0, held: 0, details: [] };

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
      // A superseded row is history, not something to renew — renewing it would create a second
      // live document of the same type, which is the state this whole rule exists to prevent.
      where: { docType, renewalRunId: null, supersededAt: null, NOT: { expiryDate: null } },
      include: { company: { select: { name: true } } },
    });

    for (const d of docs) {
      const exp = parseDate(d.expiryDate);
      if (exp === null) continue;
      if (d.employeeId && leaving.has(d.employeeId)) { out.skippedExiting++; continue; }
      const daysLeft = daysUntil(exp);
      if (daysLeft > lead) continue; // hasn't crossed its lead time yet
      out.considered++;

      // Renewal prerequisites. This path used to ignore them entirely: the gate lived only on the
      // Compliance "Start renewal" button, so the SAME renewal was gated or not purely by which way it
      // began. Nothing is started while a requirement is unmet.
      //
      // HELD, not parked: parking belongs on a Task row, and this path creates only a workflow run —
      // there is nothing here to hold. Leaving `renewalRunId` unclaimed means the next tick simply
      // reconsiders the document, so the renewal starts by itself the hour after the prerequisite is
      // satisfied. Nothing has to remember to come back for it.
      const unmet = await unmetPrereqs(dt, d);
      if (unmet.length) {
        out.held++;
        out.details.push(`HELD ${docType} — ${d.person}: ${unmet.map(u => `${u.need} ${u.why}`).join("; ")}`);
        // Keyed on the document plus what it is waiting for, so it is announced once — but announced
        // again if the reason changes. A silent hold is indistinguishable from a broken trigger.
        await notifyOnce(`renewal-held:${d.id}:${unmet.map(u => u.need).join(",")}`, {
          type: "alert",
          title: `Renewal held: ${docType} — ${d.person}`,
          message: `Waiting on ${unmet.map(u => `${u.need} (${u.why})`).join(", ")} — starts automatically once met`,
        });
        continue;
      }

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
    where: { supersededAt: null, NOT: { expiryDate: null } },
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
      // Recurring invoices used their own shape (SUB-202607-A4B2), so a firm that configured its
      // invoice format got it applied everywhere EXCEPT the invoices it raises most often.
      //
      // Safe to change: the number was never the duplicate-billing guard. That is `lastBilledFor`,
      // checked a few lines above and written inside the SAME transaction as the invoice, so the
      // two cannot drift apart. The period this invoice covers is still recorded — in `services`
      // and on the line item — so nothing is lost by dropping it from the reference.
      //
      // Resolved OUTSIDE the transaction below: it reads the invoice table the transaction writes
      // to, and each loop iteration commits before the next one asks for a number.
      const number = await nextNumber("invoice");
      // ATOMIC: raising the invoice and advancing the billing period must succeed or fail together.
      // Previously these were two separate writes — a crash (or DB error) between them left the
      // client invoiced with `lastBilledFor` unset, so the next tick billed the SAME period again.
      // That guard is the only thing preventing duplicate charges, so it cannot lag behind the invoice.
      try {
        await prisma.$transaction([
          prisma.invoice.create({
            data: {
              number, companyId: who.companyId, clientName: label,
              // Figures frozen at issue rather than re-derived at print time — see money.ts.
              ...(await figuresFromAmount(s.price)), currency: "SAR", status: "draft", // DRAFT: a human releases it
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
    // EVERY rule the park is waiting on, not just the first one.
    //
    // A park used to hold a single `prereqDocId`, while the dialog reported all the unmet rules — so
    // satisfying the first one resumed the task with the second still outstanding. `needs` carries the
    // whole list; the single-rule shape is still read so nothing already parked is stranded.
    // The RAW rules the park is waiting on, whichever kind they are. Older parks carry the single
    // document shape and are read into the same list, so nothing already parked behaves differently.
    const needs: any[] = Array.isArray(bb.needs) && bb.needs.length
      ? bb.needs.filter(Boolean)
      : (() => {
          const t0 = String(bb.requiresDocType ?? bb.waiting ?? "").trim();
          return t0 ? [{ requiresDocType: t0, minMonths: Number(bb.minMonths) || 0, docId: bb.prereqDocId ?? null }] : [];
        })();

    if (needs.length) {
      const unmet: string[] = [];
      // ONE evaluator, shared with the gate that created the park. A second copy here is how a park
      // came to lift on a rule the gate would still refuse — and it knew nothing about attribute rules,
      // so an unmet age requirement could not hold anything.
      const emp = t.employeeId ? await prisma.employee.findUnique({ where: { id: t.employeeId } }).catch(() => null) : null;
      for (const need of needs) {
        const res = await evalOneRule(need, { companyId: t.companyId, employeeId: t.employeeId, person: emp?.name ?? null }, emp);
        if (!res.ok) unmet.push(`${res.need}${res.months ? ` (${res.months}m)` : ""}`);
      }
      met = unmet.length === 0;
      // Progress is worth recording even when the hold stands: "2 of 3 met" is the difference between
      // a task that is moving and one that is stuck, and nothing said which before.
      if (!met && needs.length > 1) {
        const line = `${needs.length - unmet.length} of ${needs.length} met — still waiting on ${unmet.join(", ")}`;
        if (String(bb.progress ?? "") !== line) {
          await prisma.task.update({ where: { id: t.id }, data: { blockedBy: { ...bb, needs, progress: line } as any } });
          out.details.push(`${t.title}: ${line}`);
        }
      }
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
  scanned: number; markedOverdue: number; chased: number; settledButUnmarked: number;
  /** Invoices left alone because the client has an agreed payment date still in the future. */
  onExtension: number;
  /** Clients whose debt is old enough that a human should consider suspending them. */
  suspendRecommended: string[];
  details: string[];
};

/** Days past due at which we chase. Ascending; each fires once. */
const DUNNING_LADDER = [1, 7, 14, 30];
/**
 * Days past due at which the job RECOMMENDS suspension. It never suspends on its own: a mis-keyed
 * amount or an unrecorded bank transfer would otherwise cut off a client who has actually paid.
 */
const SUSPEND_RECOMMEND_DAYS = 45;
/** Statuses that mean "money is owed" — a draft has not been released, a paid one is done. */
const CHASEABLE = new Set(["pending", "unpaid", "sent", "overdue"]);

export async function chaseOverdueInvoices(): Promise<DunningResult> {
  const out: DunningResult = { scanned: 0, markedOverdue: 0, chased: 0, settledButUnmarked: 0, onExtension: 0, suspendRecommended: [], details: [] };
  /** companyId → worst days-overdue seen, for the suspension recommendation at the end. */
  const worstByCompany = new Map<string, { name: string; days: number; owed: number; currency: string }>();

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

    // An agreed payment date pauses everything below: no chaser, and it does not count toward a
    // suspension. Chasing a client who has already agreed a date is how you lose one.
    const promised = parseDate(inv.promisedDate);
    if (promised !== null && daysUntil(promised) >= 0) {
      out.onExtension++;
      out.details.push(`${inv.number}: on extension until ${inv.promisedDate} — not chased`);
      continue;
    }

    // Track the worst debt per client for the suspension recommendation.
    if (inv.companyId) {
      const prev = worstByCompany.get(inv.companyId);
      if (!prev || daysOverdue > prev.days) {
        worstByCompany.set(inv.companyId, {
          name: inv.clientName ?? inv.company?.name ?? "client",
          days: daysOverdue, owed: outstanding, currency: inv.currency,
        });
      }
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

  // Suspension RECOMMENDATION. Deliberately advisory: the job flags, a human decides. Clients already
  // suspended are skipped so the alert doesn't repeat every hour once someone has acted.
  for (const [companyId, w] of worstByCompany) {
    if (w.days < SUSPEND_RECOMMEND_DAYS) continue;
    const co = await prisma.company.findUnique({ where: { id: companyId }, select: { status: true } });
    if (co?.status === "suspended") continue;
    out.suspendRecommended.push(`${w.name} (${w.days}d, ${w.currency} ${w.owed.toLocaleString()})`);
    // Once per client per 7-day window, so a long-running debt nags weekly rather than hourly.
    const bucket = Math.floor(Date.now() / (7 * DAY));
    const first = await notifyOnce(`suspend-rec:${companyId}:${bucket}`, {
      type: "overdue",
      title: `Consider suspending ${w.name}`,
      message: `${w.currency} ${w.owed.toLocaleString()} unpaid for ${w.days} days, no agreed payment date. Suspend from the client's page, or agree an extension on the invoice.`,
    });
    if (first) {
      await notifyAwait({
        rule: "Invoice overdue", audience: "staff",
        subject: `Suspension suggested: ${w.name} — ${w.days}d unpaid`,
        heading: "A client's balance is old enough to consider suspending",
        lines: [
          `<b>${w.name}</b> has ${w.currency} ${w.owed.toLocaleString()} unpaid for <b>${w.days} days</b> with no agreed payment date.`,
          "Nothing has been restricted — suspending is a manual decision. If they've agreed to pay by a date, set that on the invoice instead and the chasing stops.",
        ],
        cta: { label: "Open clients", url: `${process.env.CONSOLE_URL || "https://pro.ionob.in"}/clients` },
      });
    }
  }

  return out;
}

// ── Unapproved draft invoices ────────────────────────────────────────
// Subscription billing raises invoices as DRAFTS for a human to release, and the create form does
// too. Nothing chased a draft that then sat there, so revenue could quietly stall on an invoice
// nobody remembered to approve — the client is never told, so only staff can notice.
export type DraftResult = { scanned: number; nudged: number; details: string[] };

/** Days a draft may sit before staff are reminded. Rungs, not a repeat: each fires once. */
const DRAFT_LADDER = [3, 10, 21];

export async function remindUnapprovedDrafts(): Promise<DraftResult> {
  const out: DraftResult = { scanned: 0, nudged: 0, details: [] };
  const drafts = await prisma.invoice.findMany({
    where: { status: "draft" },
    include: { company: { select: { name: true } } },
  });

  for (const inv of drafts) {
    // `date` is the issue date the draft was raised with; without one there is nothing to age from.
    const raised = parseDate(inv.date);
    if (raised === null) continue;
    out.scanned++;
    const age = -daysUntil(raised);
    // Highest rung reached, so a draft that is already 30 days old doesn't replay 3 → 10 → 21.
    const rung = DRAFT_LADDER.filter(d => age >= d).pop();
    if (rung == null) continue;

    const who = inv.company?.name ?? inv.clientName ?? "a client";
    const sent = await notifyOnce(`draft-invoice:${inv.id}:${rung}`, {
      type: "task",
      title: `Draft invoice waiting ${age} days: ${inv.number}`,
      message: `${who} · ${inv.currency} ${inv.amount.toLocaleString()} — approve it to bill, or void it if it isn't owed.`,
    });
    if (!sent) continue; // this rung already went out

    out.nudged++;
    out.details.push(`${inv.number} — ${who} · ${age}d`);
    await notifyAwait({
      rule: "Approval requested",
      audience: "staff",
      subject: `Draft invoice ${inv.number} has been waiting ${age} days`,
      heading: "A draft invoice is still unapproved",
      lines: [
        `Client: <b>${who}</b>`,
        `Amount: <b>${inv.currency} ${inv.amount.toLocaleString()}</b>`,
        `Raised: ${inv.date}`,
        "Nothing has been billed and the client has not been told. Approve it to issue, or void it if it is not owed.",
      ],
    });
  }
  return out;
}

// ── Orphaned (unassigned) workflow steps ─────────────────────────────
// Auto-assignment happens when a step is CREATED, which leaves two holes: steps created before it
// existed, and steps created while nobody held the required role. Both sit in a shared pile forever.
// This re-attempts them each tick, so hiring someone into a role also clears the backlog waiting on it.
export type AssignResult = { scanned: number; assigned: number; details: string[] };

export async function assignOrphanTasks(): Promise<AssignResult> {
  const out: AssignResult = { scanned: 0, assigned: 0, details: [] };
  const orphans = await prisma.workflowTask.findMany({
    where: { status: "active", assignee: null, NOT: { assigneeRole: null } },
    select: { id: true, title: true, assigneeRole: true },
  });
  for (const t of orphans) {
    out.scanned++;
    const who = await pickAssignee(t.assigneeRole!);
    if (!who) continue; // still nobody in that role — leave it rather than assign the wrong desk
    await prisma.workflowTask.update({ where: { id: t.id }, data: { assignee: who } });
    out.assigned++;
    out.details.push(`${t.title} → ${who}`);
  }
  return out;
}
