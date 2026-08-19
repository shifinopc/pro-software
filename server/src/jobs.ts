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
import { homeCurrency } from "./orgsettings.js";
import { jobRules } from "./jobrules.js";
import { logActivity, logNotification } from "./auth.js";
import { workforceFor, bandsFor } from "./workforce.js";
import { startInstance, pickAssignee } from "./workflow.js";
import { sameCountry, countryNationality } from "./countries.js";
import { nextNumber } from "./sequence.js";
import { notifyDocumentExpiring, notifySlaBreach, notifyInvoiceRaised, notifyInvoiceOverdue, notifyAwait } from "./notify.js";
// The sales-chasing reminders, addressed to whoever owns the record rather than to every admin.
import { notifyFollowUpDue, notifyGoneQuiet, notifyQuoteChase, notifyRenewalDeal, notifyTaskAssigned, notifyTaskLate } from "./notify.js";
import { figuresFromAmount } from "./money.js";
import { ACTIVE_CLIENT } from "./validate.js";
import { salesRules } from "./salesrules.js";
import { openFollowUps, lastContactMap } from "./interactions.js";
import { idleDaysOf } from "./lifecycle.js";
import { healthOf } from "./dealhealth.js";
import { stagesFor, recordTransition } from "./pipeline.js";

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
  //
  // Both sides go through the country resolver, so a rule written as "Saudi" matches an employee
  // stored as "SA" — and "KSA" matches both. Nationality is stored as an ISO code now, and a rule is
  // free text an admin typed; comparing those two directly would have quietly stopped every
  // nationality rule from ever matching, which is a failure that looks exactly like a passing check.
  const have = String(emp.nationality ?? "").trim();
  if (!have) return { ok: false, label, why: "cannot be checked — no nationality on file" };
  const list = String(want ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (!list.length) return { ok: false, label, why: "has no value to compare against" };
  const hit = list.some((w: string) => sameCountry(w, have));
  const ok = op === "ne" ? !hit : hit;
  const pretty = String(want).trim();
  // Report the readable name, not the stored code: "is IN — this needs one of Saudi" helps nobody.
  const haveLabel = countryNationality(have);
  return { ok, label, why: ok ? `is ${haveLabel}` : (op === "ne" ? `is ${haveLabel} — this excludes ${pretty}` : `is ${haveLabel} — this needs one of ${pretty}`) };
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

  // retired: false as well as active — a retired template is refused by startInstance anyway, so
  // without this the job would pick it up every hour and log the same refusal forever.
  const templates = await prisma.workflowTemplate.findMany({ where: { active: true, retired: false, trigger: "document_expiry" } });
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

// The at-risk window is a setting now — see jobrules.ts. It was 7 days here.

export async function escalateSla(): Promise<SlaResult> {
  const rules = await jobRules();
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

    // Measured against the DUE DATE when there is one, because that is the date the task carries and
    // the date every screen shows. Falling back to createdAt + slaHours keeps older rows working, but
    // a due date somebody set deliberately must not be quietly ignored in favour of the arithmetic it
    // was set to override.
    const due = parseDate(t.dueDate);
    const remH = due !== null
      ? (due - Date.now()) / HOUR
      : t.slaHours - (Date.now() - started) / HOUR;
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
    // …and separately, the person it actually belongs to. The line above reports across the queue to
    // admins; this names one task to one desk. Both states go here, unlike the admin version: "your
    // step is about to be late" is the one message that can still prevent the breach.
    if (firstSla) {
      notifyTaskLate({
        assigneeId: t.assigneeId, title: t.title, state: state === "breached" ? "breached" : "at risk",
        hoursOver: state === "breached" ? Math.abs(Math.round(remH)) : null,
        clientName: t.instance?.clientName ?? null,
      });
    }
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
    const state = daysLeft < 0 ? "breached" : daysLeft <= rules.docSlaAtRiskDays ? "at_risk" : "on_track";
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

// The catch-up ceiling is a setting now — see jobrules.ts. It was 12 periods here.

export async function renewSubscriptions(): Promise<BillingResult> {
  const rules = await jobRules();
  const out: BillingResult = { scanned: 0, renewed: 0, invoiced: 0, lapsed: 0, details: [] };
  const subs = await prisma.subscription.findMany({
    include: { package: { select: { name: true, billingCycle: true } }, company: { select: { id: true, name: true, lifecycle: true } } },
  });

  for (const s of subs) {
    let end = parseDate(s.endDate);
    if (end === null) continue;
    // Never invoice a company that is not a client. A churned client keeps its subscription row —
    // that is its billing history — and an hourly job that reads only `endDate` would go on raising
    // invoices against a firm that left months ago, which is the kind of thing that reaches them
    // through their accountant rather than through us.
    if (s.company && s.company.lifecycle !== ACTIVE_CLIENT) continue;
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
    while (daysUntil(end) <= 0 && cycles < rules.maxCatchUpPeriods) {
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
              // The firm's configured currency, not a literal. Deliberately NOT the client's own
              // country's — changing what an existing client is billed in is a decision for a human,
              // not a side effect of this cleanup.
              ...(await figuresFromAmount(s.price)), currency: await homeCurrency(), status: "draft", // DRAFT: a human releases it
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
    if (cycles >= rules.maxCatchUpPeriods) out.details.push(`${s.package.name}: stopped at ${rules.maxCatchUpPeriods} catch-up periods — needs manual review`);
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
// The threshold is a setting now — see jobrules.ts. It was 45 days here.
/** Statuses that mean "money is owed" — a draft has not been released, a paid one is done. */
const CHASEABLE = new Set(["pending", "unpaid", "sent", "overdue"]);

export async function chaseOverdueInvoices(): Promise<DunningResult> {
  const rules = await jobRules();
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
    if (w.days < rules.suspendRecommendDays) continue;
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
    await prisma.workflowTask.update({ where: { id: t.id }, data: { assignee: who.name, assigneeId: who.id } });
    out.assigned++;
    out.details.push(`${t.title} → ${who.name}`);
    // Work that appears on somebody's desk while they are not looking at the console.
    notifyTaskAssigned({ assigneeId: who.id, title: t.title, why: `it was waiting for a ${t.assigneeRole}` });
  }
  return out;
}

// ─────────────────────────────────────────────────
// #9 — WORKFORCE BANDS
// A client falls out of its nationalisation band, or gets close to falling out of it.
//
// Everything needed for this already existed — the ratio, the configured thresholds, how far the next
// band is — and nothing watched it. A number nobody is looking at is not a control; the whole point of
// computing a band is that somebody hears about it when it moves.

export type WorkforceAlertResult = { checked: number; dropped: number; improved: number; nearEdge: number; details: string[] };

/**
 * How close to the floor of the current band counts as "about to fall out".
 *
 * Percentage points, not a percentage OF the ratio: regulators publish bands in points, so a warning
 * expressed the same way is one a person can act on without converting anything.
 */
// The edge width is a setting now — see jobrules.ts. It was 2 points here.

export async function checkWorkforceBands(): Promise<WorkforceAlertResult> {
  const rules = await jobRules();
  const out: WorkforceAlertResult = { checked: 0, dropped: 0, improved: 0, nearEdge: 0, details: [] };
  const companies = await prisma.company.findMany({
    // Clients only. A lead has no workforce here to have a band about, and interrupting somebody
    // about a prospect's imaginary compliance position is how an alert channel gets muted.
    where: { NOT: { country: null }, lifecycle: ACTIVE_CLIENT },
    select: { id: true, name: true, country: true, workforceBandSeen: true },
  });

  for (const co of companies) {
    const w = await workforceFor(co.id);
    // No staff, or no thresholds configured for the country: there is no band to have an opinion
    // about, and inventing one would raise an alert for a compliance position that does not exist.
    if (!w || !w.total || !w.computedBand) continue;
    out.checked++;

    const bands = await bandsFor(co.country);
    const rank = (name: string) => bands.findIndex(b => b.name === name);
    const now = w.computedBand.name;
    const was = co.workforceBandSeen;
    const pct = (bp: number) => (bp / 100).toFixed(2) + "%";

    if (was && was !== now) {
      const fell = rank(now) >= 0 && rank(was) >= 0 && rank(now) < rank(was);
      if (fell) {
        out.dropped++;
        out.details.push(`${co.name}: ${was} → ${now}`);
        // Keyed on the transition, not the clock: the same fall is announced once, but a client that
        // recovers and falls again is a new event and says so.
        await notifyOnce(`wf-drop:${co.id}:${was}->${now}`, {
          type: "compliance",
          title: `${co.name} dropped from ${was} to ${now}`,
          message: `Nationalisation is ${pct(w.ratioMinBp)} — ${w.nationals} of ${w.total} counted toward ${w.countryLabel}.`,
        });
        logActivity({ type: "compliance", message: `${co.name}: workforce band fell from ${was} to ${now} (${pct(w.ratioMinBp)})` });
      } else {
        // Improving is not an alert. It is worth recording, not worth interrupting anybody for.
        out.improved++;
        logActivity({ type: "compliance", message: `${co.name}: workforce band improved from ${was} to ${now} (${pct(w.ratioMinBp)})` });
      }
    }

    if (was !== now) {
      await prisma.company.update({ where: { id: co.id }, data: { workforceBandSeen: now, workforceBandSeenAt: nowISO() } });
    }

    // Close to the floor of the band it is currently in. Skipped for the lowest band — there is
    // nothing below it to fall into, so "about to drop" would be a warning about nothing.
    const band = bands.find(b => b.name === now);
    const isLowest = band ? !bands.some(b => b.minBp < band.minBp) : true;
    if (band && !isLowest) {
      const margin = w.ratioMinBp - band.minBp;
      if (margin >= 0 && margin <= rules.bandEdgePoints * 100) {
        out.nearEdge++;
        out.details.push(`${co.name}: ${pct(margin)} above the ${now} floor`);
        // The key carries the band AND the whole-point margin, so it re-fires if the gap narrows
        // further but not on every tick while it sits still.
        await notifyOnce(`wf-edge:${co.id}:${now}:${Math.floor(margin / 100)}`, {
          type: "compliance",
          title: `${co.name} is close to falling out of ${now}`,
          message: `${pct(w.ratioMinBp)} against a ${pct(band.minBp)} floor — ${pct(margin)} of headroom. One departure could move it.`,
        });
      }
    }
  }
  return out;
}

/**
 * Chase what people said they would do.
 *
 * Two separate silences are worth interrupting somebody about, and they are not the same:
 *
 *   - a FOLLOW-UP came due. Somebody wrote down a commitment with a date and that date has arrived.
 *   - a DEAL went quiet. Nobody promised anything, which is the problem: an open opportunity with
 *     no contact for weeks is the one that is quietly dying while the board still counts it.
 *
 * The second only fires where there is no open follow-up already: a deal somebody is actively
 * chasing on Sunday does not also need "nobody has touched this". Two alerts about one thing is how
 * a notification list stops being read.
 */
// How long counts as stale is a setting now — see jobrules.ts. It was 14 days here.

export interface FollowUpResult {
  due: number; overdue: number; stale: number; details: string[];
}

export async function checkFollowUps(): Promise<FollowUpResult> {
  const rules = await jobRules();
  const out: FollowUpResult = { due: 0, overdue: 0, stale: 0, details: [] };
  const on = new Date().toISOString().slice(0, 10);

  // ── commitments that have come due ──
  const owed = await openFollowUps({ on });
  for (const f of owed) {
    out.due++;
    if (f.overdue) out.overdue++;
    const who = f.ownerId ? await prisma.user.findUnique({ where: { id: f.ownerId }, select: { name: true } }) : null;
    // Keyed on the DAY as well as the entry, so an overdue commitment is raised again each morning
    // rather than once and then never — but still only once per day, however often the tick runs.
    // The bell row and the email are ONE decision: `notifyOnce` returns false when this event has
    // already been raised, and the mail rides on that same answer. Deduping the email separately
    // would eventually let the two drift, which is how people stop trusting either.
    const freshFollowUp = await notifyOnce(`followup:${f.id}:${on}`, {
      type: "system",
      title: f.overdue
        ? `Overdue by ${f.daysLate} day${f.daysLate === 1 ? "" : "s"}: ${f.nextAction}`
        : `Due today: ${f.nextAction}`,
      message: `${f.company.name}${f.opportunity ? ` — ${f.opportunity.title}` : ""}${who ? ` · ${who.name}` : ""}`,
    });
    if (freshFollowUp) {
      notifyFollowUpDue({
        ownerId: f.ownerId, companyId: f.company.id, companyName: f.company.name,
        // `nextAction` is nullable on the column but never null here — openFollowUps only returns
        // entries that HAVE one. The fallback is for the type, not for a case that occurs.
        action: f.nextAction ?? "Follow up", dealTitle: f.opportunity?.title ?? null, daysLate: f.overdue ? f.daysLate : 0,
      });
    }
    out.details.push(`${f.company.name}: ${f.nextAction}${f.overdue ? ` (${f.daysLate}d late)` : ""}`);
  }

  // ── open deals that are not moving ──
  //
  // The verdict comes from dealhealth.ts, which is now the ONLY place either measure of "not moving"
  // is worked out. This loop used to compute days-since-contact itself while the Sales Dashboard
  // computed days-in-stage, and both called the result "stalled" — so a deal could be stalled on one
  // surface and healthy on the other, with neither saying which it meant.
  const openDeals = await prisma.opportunity.findMany({
    include: { stage: true, company: { select: { id: true, name: true, lifecycle: true } } },
    take: 1000,
  });
  const live = openDeals.filter(d => !d.stage.isWon && !d.stage.isLost && d.company.lifecycle !== "lost");
  if (live.length) {
    const contacted = await lastContactMap(live.map(d => d.companyId));
    const owedCompanies = new Set(owed.map(f => f.companyId));
    const on = new Date().toISOString().slice(0, 10);
    for (const d of live) {
      if (owedCompanies.has(d.companyId)) continue; // already being chased
      const health = healthOf({
        deal: d, stage: d.stage,
        lastContactAt: contacted[d.companyId] ?? null,
        staleDealDays: rules.staleDealDays,
        on,
      });
      // Only the two states that mean nobody is working it. `at-risk` is a slipped forecast date,
      // which is a conversation with a manager rather than a notification at 3am.
      if (health.state !== "stalled" && health.state !== "quiet") continue;
      out.stale++;
      const days = (health.state === "stalled" ? health.daysInStage : health.daysQuiet) ?? 0;
      // Keyed by the week, so it repeats as the gap widens without nagging daily. The state is in
      // the key too: a deal that goes from quiet to stalled is worth saying again.
      const raised = await notifyOnce(`deal-stale:${d.id}:${health.state}:${Math.floor(days / 7)}`, {
        type: "system",
        title: health.state === "stalled"
          ? `Stalled ${days} days in ${d.stage.name}: ${d.title}`
          : `No contact in ${days} days: ${d.title}`,
        // The reasons, verbatim from the same module the dashboard prints. One wording, two surfaces.
        message: `${d.company.name} — ${health.reasons.join("; ")}.`,
      });
      if (raised) {
        out.details.push(`${d.company.name}: ${d.title} ${health.state} ${days}d`);
        notifyGoneQuiet({ ownerId: d.ownerId, companyId: d.companyId, what: "this deal", name: d.title, days, kind: "deal" });
      }
    }
  }
  return out;
}

/**
 * A subscription about to lapse is a deal somebody has to go and win.
 *
 * ONLY the ones with auto-renew OFF. An auto-renewing subscription bills itself and needs no
 * selling; putting it on the board would fill the pipeline with revenue nobody has to work for,
 * and every forecast built on that board would then be counting money twice — once as recurring
 * and once as new business.
 *
 * Raised BEFORE the end date, not after. `renewSubscriptions` already announces a lapse once it has
 * happened, which is the point at which it is too late to do anything about it.
 *
 * Idempotency is the unique `originKey`, not a lookup: the tick re-reads the same subscription every
 * hour, and a find-then-create races with itself. Same reasoning as notifyOnce.
 */
// The lead time is a setting now — see jobrules.ts. It was 45 days here.

export interface RenewalDealResult { considered: number; created: number; skipped: number; details: string[] }

export async function raiseRenewalDeals(): Promise<RenewalDealResult> {
  const rules = await jobRules();
  const out: RenewalDealResult = { considered: 0, created: 0, skipped: 0, details: [] };

  const subs = await prisma.subscription.findMany({
    where: { autoRenew: false },
    include: { package: { select: { name: true } }, company: { select: { id: true, name: true, country: true, lifecycle: true } } },
    take: 1000,
  });

  for (const s of subs) {
    const end = parseDate(s.endDate);
    if (end === null) continue;
    const days = daysUntil(end);
    // Not yet worth raising, or already long gone — a deal opened for a subscription that lapsed
    // last year is not work, it is clutter.
    if (days > rules.renewalLeadDays || days < -rules.renewalGraceDays) continue;
    out.considered++;

    const who = await resolveSubscriber(s);
    // Group-scoped subscriptions have no single company to hang a deal on. Skipped rather than
    // guessed at: picking one member of the group would put the renewal on the wrong file.
    if (!who?.companyId) { out.skipped++; continue; }
    if (s.company && s.company.lifecycle !== ACTIVE_CLIENT) { out.skipped++; continue; }

    const country = s.company?.country ?? null;
    const stages = await stagesFor(country);
    if (!stages.length) {
      out.skipped++;
      out.details.push(`${who.name}: no pipeline stages for ${country ?? "no country"} — renewal not raised`);
      continue;
    }
    const first = stages.find(st => !st.isWon && !st.isLost) ?? stages[0];

    try {
      const nowISOv = nowISO();
      const renewal = await prisma.opportunity.create({
        data: {
          // The key carries the PERIOD as well as the subscription, so next year's renewal is a new
          // deal rather than being suppressed by this year's.
          originKey: `renewal:${s.id}:${s.endDate}`,
          number: await nextNumber("opportunity").catch(() => null),
          companyId: who.companyId,
          title: `Renew ${s.package.name}`,
          valueMinor: s.price ? s.price * 100 : null,
          stageId: first.id,
          expectedCloseDate: String(s.endDate).slice(0, 10),
          source: "renewal",
          country,
          notes: `Raised automatically: this subscription ends ${s.endDate} and auto-renew is off.`,
          createdAt: nowISOv, stageAt: nowISOv,
        },
      });
      await recordTransition(prisma, { opportunityId: renewal.id, toStageId: first.id, at: nowISOv });
      out.created++;
      out.details.push(`${who.name}: ${s.package.name} ends ${s.endDate}`);
      if (await notifyOnce(`renewal-deal:${s.id}:${s.endDate}`, {
        type: "system",
        title: `Renewal to win: ${who.name}`,
        message: `${s.package.name} ends ${s.endDate} and auto-renew is off. A deal is on the board.`,
      })) {
        notifyRenewalDeal({ companyId: who.companyId, clientName: who.name, title: `${s.package.name} renewal`, endDate: s.endDate });
      }
    } catch {
      // Unique violation on originKey = already raised. Expected on every tick after the first.
      out.skipped++;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// #13 — QUOTATIONS NOBODY HAS ANSWERED
//
// The most expensive silence in the product: work already priced, sent, and then forgotten. Nothing
// chased these before, so a quotation could sit in `sent` until it lapsed and nobody would know
// unless they happened to open the list.
//
// THREE MOMENTS, EACH SAID ONCE
//
//   no answer     — N days after it was SENT (not after it was dated; see Quotation.sentAt)
//   about to lapse — a few days before validUntil, while there is still time to act
//   lapsed         — its validity has passed and it was never answered
//
// Each is a different thing to do about it, which is why they are separate rather than one repeated
// reminder. `notifyOnce` keys them per quotation per moment, so the hourly tick cannot repeat any.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never marks the deal lost. A client going quiet is not a decision, and auto-losing would put a
// loss into the win-rate figures that nobody decided and no reason explains.
// ─────────────────────────────────────────────────────────────

export interface QuoteChaseResult {
  scanned: number;
  chased: number;
  expiringSoon: number;
  lapsed: number;
  details: string[];
}

export async function chaseQuotations(): Promise<QuoteChaseResult> {
  const out: QuoteChaseResult = { scanned: 0, chased: 0, expiringSoon: 0, lapsed: 0, details: [] };
  const rules = await salesRules();

  // Only `sent`. A draft is not the client's problem yet, and accepted/rejected/invoiced are answers.
  const quotes = await prisma.quotation.findMany({ where: { status: "sent" }, take: 1000 });

  for (const q of quotes) {
    // Fall back to the issue date for rows written before sentAt existed. Stated rather than silent:
    // those are chased slightly early, which is the safer direction for money already quoted.
    const sent = parseDate(q.sentAt ?? q.date);
    if (sent === null) continue;
    out.scanned++;

    const waiting = Math.max(0, Math.floor((Date.now() - sent) / DAY));
    const who = q.clientName ?? "a client";
    // Who to tell: the deal's owner where the quotation came from one, so it reaches the person who
    // will actually pick up the phone rather than the whole office.
    // `ownerId`/`companyId` were missing from this select, so the intent above was never actually
    // deliverable — the reminder had no way to reach a person. They are read now.
    const opp = await prisma.opportunity.findFirst({ where: { quotationId: q.id }, select: { title: true, ownerId: true, companyId: true } });
    const about = opp ? `${opp.title} — ${who}` : who;
    const chaseTo = { ownerId: opp?.ownerId ?? null, companyId: opp?.companyId ?? q.companyId ?? null };

    const until = parseDate(q.validUntil);
    const daysLeft = until === null ? null : Math.floor((until - Date.now()) / DAY);

    // ── lapsed ──
    if (daysLeft !== null && daysLeft < 0) {
      if (rules.quoteExpiryNotice && await notifyOnce(`quote:lapsed:${q.id}`, {
        type: "finance",
        title: `Quotation lapsed unanswered: ${q.number}`,
        message: `${about} · valid until ${q.validUntil} · ${waiting} days with no answer. Re-issue it or close the deal — it is no longer a live offer.`,
      })) {
        out.lapsed++; out.details.push(`LAPSED ${q.number} (${who})`);
        notifyQuoteChase({ ...chaseTo, number: q.number, clientName: who, state: "lapsed", days: Math.abs(daysLeft), validUntil: q.validUntil });
      }
      continue;
    }

    // ── about to lapse ──
    if (daysLeft !== null && daysLeft <= rules.quoteExpiryWarnDays) {
      if (await notifyOnce(`quote:expiring:${q.id}`, {
        type: "finance",
        title: `Quotation about to lapse: ${q.number}`,
        message: `${about} · valid until ${q.validUntil}, ${daysLeft === 0 ? "today" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`}. Still unanswered after ${waiting} days.`,
      })) {
        out.expiringSoon++; out.details.push(`EXPIRING ${q.number} (${who}, ${daysLeft}d)`);
        notifyQuoteChase({ ...chaseTo, number: q.number, clientName: who, state: "expiring", days: daysLeft, validUntil: q.validUntil });
      }
      continue;
    }

    // ── no answer ──
    if (waiting >= rules.quoteChaseDays) {
      if (await notifyOnce(`quote:silent:${q.id}`, {
        type: "finance",
        title: `No answer on quotation ${q.number}`,
        message: `${about} · sent ${waiting} days ago${q.validUntil ? ` · valid until ${q.validUntil}` : " · no validity date set"}. Worth a call.`,
      })) {
        out.chased++; out.details.push(`SILENT ${q.number} (${who}, ${waiting}d)`);
        notifyQuoteChase({ ...chaseTo, number: q.number, clientName: who, state: "silent", days: waiting, validUntil: q.validUntil });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// #14 — LEADS NOTHING IS HAPPENING TO
//
// A lead with no deal is in no pipeline column, so the stale-deal nudge cannot see it — there is no
// deal to be stale. It is not on the follow-up queue either, because nobody promised anything. It is
// simply invisible: typed in once, and then nowhere.
//
// This is the one gap in the sales side where forgetting costs nothing visible until a quarter later
// when somebody asks what happened to all the enquiries.
// ─────────────────────────────────────────────────────────────

// Days a lead may sit untouched: a setting now — see jobrules.ts. It was 10 days here.

export interface IdleLeadResult { checked: number; nudged: number; details: string[] }

export async function checkIdleLeads(): Promise<IdleLeadResult> {
  const rules = await jobRules();
  const out: IdleLeadResult = { checked: 0, nudged: 0, details: [] };

  const leads = await prisma.company.findMany({
    where: { lifecycle: { in: ["lead", "prospect"] } },
    select: { id: true, name: true, createdAt: true, ownerId: true, lifecycle: true },
    take: 1000,
  });

  for (const lead of leads) {
    out.checked++;

    const deals = await prisma.opportunity.count({ where: { companyId: lead.id } });
    const lastTouch = await prisma.interaction.findFirst({
      where: { companyId: lead.id },
      orderBy: { at: "desc" },
      select: { at: true },
    });
    const arrival = await prisma.lifecycleTransition.findFirst({
      where: { companyId: lead.id, fromLifecycle: null },
      orderBy: { changedAt: "asc" },
      select: { changedAt: true },
    });

    // ONE definition, shared with the Leads screen's Idle tab — see idleDaysOf. Written twice these
    // would drift, and a tab that disagrees with the notification people received teaches them the
    // tab is wrong. Null covers all three "does not apply" cases: not a lead, has a deal, no date.
    const idle = idleDaysOf({
      lifecycle: lead.lifecycle,
      deals,
      lastContactAt: lastTouch?.at ?? null,
      arrivedAt: arrival?.changedAt ?? null,
      createdAt: lead.createdAt,
    });
    if (idle === null || idle < rules.idleLeadDays) continue;

    // Keyed on the WEEK, so a lead that stays idle is mentioned once a week rather than once ever —
    // saying it a single time and never again is how something quietly stays forgotten.
    const week = new Date().toISOString().slice(0, 10);
    if (await notifyOnce(`idle-lead:${lead.id}:${week}`, {
      type: "system",
      title: `Nothing happening: ${lead.name}`,
      message: `A ${lead.lifecycle} with no deal and no contact for ${idle} days. Open a deal for them or mark it lost — either is better than it sitting here.`,
    })) {
      out.nudged++; out.details.push(`${lead.name} (${idle}d)`);
      notifyGoneQuiet({ ownerId: lead.ownerId, companyId: lead.id, what: "this lead", name: lead.name, days: idle, kind: "lead" });
    }
  }
  return out;
}
