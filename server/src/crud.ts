import { Router } from "express";
import { prisma } from "./db.js";
import { idleDaysOf } from "./lifecycle.js";
import { homeCountry } from "./orgsettings.js";
import { validate } from "./validate.js";
import { logActivity, logNotification } from "./auth.js";
import { notifyInvoiceRaised, notifyAppointmentChanged, notifyAddonRejected } from "./notify.js";
import { startDeliveryForQuotation } from "./delivery.js";
import { closeAddonDeal } from "./pipeline.js";
import { nextNumber } from "./sequence.js";

// The market this installation operates in now lives in Settings → General, read through
// `homeCountry()`. It used to be `export const HOME_COUNTRY = "SA"` right here, carrying a comment
// that promised it would become a setting when a second market opened. See src/orgsettings.ts.

/**
 * Configuration that belongs to a market rather than to the firm.
 *
 * Sequences, roles and print layout are firm-wide and stay unmarked. These five describe how work is
 * done in a particular country, so a second country pack must be able to keep them apart — otherwise
 * an Emirates ID document type is offered to a Saudi client.
 */
export const COUNTRY_SCOPED_CONFIG = ["documentType", "workflowTemplate", "serviceItem", "package", "checklistRule", "workforceBand", "pipelineStage", "leadSource", "lostReason", "courierJobType", "appointmentType", "courierStatus", "appointmentStatus"];

/**
 * Configuration that can be RETIRED instead of deleted.
 *
 * Uninstalling a pack must not remove a row that real records point at — a document type with
 * documents captured under it, an authority a stored credential belongs to. Those are retired: hidden
 * everywhere, still readable, so old records keep their meaning. Includes workflowTemplate, which the
 * workflow router serves rather than this helper — it filters separately.
 */
export const RETIREABLE = ["documentType", "workflowTemplate", "serviceItem", "package", "checklistRule", "govCenter", "workforceBand", "pipelineStage", "leadSource", "lostReason", "courierJobType", "appointmentType", "courierStatus", "appointmentStatus"];


// Build a friendly activity line for a newly-created record (persisted feed).
// Resolves the owning company name so client-scoped records (employees, documents,
// tasks, subscriptions) surface in that client's Activity tab, which matches on the
// company name inside the message text.
async function activityFor(model: string, data: any): Promise<{ type: string; message: string } | null> {
  let companyName: string | undefined = data.clientName;
  if (!companyName && data.companyId) {
    try { const co = await prisma.company.findUnique({ where: { id: data.companyId } }); companyName = co?.name ?? undefined; } catch { /* non-fatal */ }
  }
  const suffix = companyName ? ` (${companyName})` : "";
  switch (model) {
    case "task": return { type: "task", message: `Task created: ${data.title}${suffix}` };
    case "invoice": return { type: "finance", message: `Invoice ${data.number} created${data.clientName ? ` for ${data.clientName}` : ""}` };
    case "employee": return { type: "client", message: `Employee added: ${data.name}${suffix}` };
    case "document": return { type: "compliance", message: `Document added: ${data.docType} — ${data.person}${suffix}` };
    case "subscription": return { type: "finance", message: `Subscription assigned${suffix}` };
    case "package": return { type: "finance", message: `Service package: ${data.name}` };
    case "clientGroup": return { type: "client", message: `Client group created: ${data.name}` };
    default: return null;
  }
}

// Fields owned by the auth flows (hashing, token invalidation, lockout, reset tokens). They must never
// be settable through the generic CRUD — writing them directly would bypass those flows entirely
// (planting a password hash, reviving a revoked token by resetting tokenVersion, unlocking an account).
// `validate()` only checks field VALUES, so without this the body is passed to Prisma wholesale.
const PROTECTED_FIELDS: Record<string, string[]> = {
  user: ["passwordHash", "tokenVersion", "resetTokenHash", "resetExpires", "failedLogins", "lockedUntil", "mustChangePassword"],
};
const sanitize = (modelName: string, body: any) => {
  const banned = PROTECTED_FIELDS[modelName];
  if (!banned || !body || typeof body !== "object") return body;
  return Object.fromEntries(Object.entries(body).filter(([k]) => !banned.includes(k)));
};

/**
 * Secrets stripped on the way OUT. Blocking writes protected the auth flows but left every bcrypt
 * hash readable by any session allowed to list users — and `resetTokenHash` is enough to take an
 * account over while a reset is in flight. A field nobody outside the auth code should ever see
 * must not be sent, not merely be un-writable.
 *
 * `mustChangePassword` stays readable: the UI needs it and it reveals nothing.
 */
const SECRET_FIELDS: Record<string, string[]> = {
  user: ["passwordHash", "resetTokenHash", "resetExpires", "tokenVersion", "failedLogins", "lockedUntil"],
};
const redact = (modelName: string, row: any): any => {
  const secret = SECRET_FIELDS[modelName];
  if (!secret || row == null || typeof row !== "object") return row;
  if (Array.isArray(row)) return row.map(r => redact(modelName, r));
  const out: any = { ...row };
  for (const k of secret) delete out[k];
  return out;
};

/**
 * Counts that are DERIVED, never stored.
 *
 * Company.employees / overdue / expiring are columns that were written once and never recomputed, so
 * they drifted the moment a document expired or an employee was added — three of four companies were
 * wrong, and the Clients screen reported "Overdue docs 0" over three overdue documents. Keeping a
 * denormalised counter in sync means catching every write path, including the hourly scheduler that
 * flips document statuses; missing one is exactly how this happened.
 *
 * So the stored values are ignored on read and replaced with the live truth. Two grouped queries
 * cover any number of companies, so this does not grow per row.
 */
export async function withLiveCounts(rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id).filter(Boolean);
  if (!ids.length) return rows;
  const [emps, docs, arrivals, contacts, deals] = await Promise.all([
    prisma.employee.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, archived: false }, _count: { _all: true } }),
    prisma.document.findMany({ where: { companyId: { in: ids }, supersededAt: null }, select: { companyId: true, status: true, expiryDate: true } }),
    // WHEN EACH ONE ARRIVED. `createdAt` cannot answer this — its own comment says "client since",
    // and the staff form never stamped it — so "a lead added this week" was unanswerable from a
    // company row. The arrival transition means exactly one thing. Two more grouped queries; still
    // flat in the number of companies.
    prisma.lifecycleTransition.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, fromLifecycle: null }, _min: { changedAt: true } }),
    // When anybody last logged anything against them — what "idle" is measured from.
    prisma.interaction.groupBy({ by: ["companyId"], where: { companyId: { in: ids } }, _max: { at: true } }),
    // Any deal at all means somebody is on it, so it cannot be idle — see idleDaysOf.
    prisma.opportunity.groupBy({ by: ["companyId"], where: { companyId: { in: ids } }, _count: { _all: true } }),
  ]);
  const arrivedBy = new Map(arrivals.map(a => [a.companyId, a._min.changedAt]));
  const contactedBy = new Map(contacts.map(c => [c.companyId, c._max.at]));
  const dealsBy = new Map(deals.map(d => [d.companyId, d._count._all]));
  const empBy = new Map(emps.map(e => [e.companyId, e._count._all]));
  const ovd = new Map<string, number>(), exp = new Map<string, number>();
  // Two more counts, because the dashboard's health bar had nothing real to divide by. It read
  // `Company.documents`, a field that does not exist on the model — so `Array.isArray(undefined)` was
  // false, the document list was always empty, and every client scored the hardcoded 100% fallback.
  // A client could show 100% with an overdue document listed beside it on the same row.
  const tot = new Map<string, number>(), unk = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const d of docs) {
    if (!d.companyId) continue;
    bump(tot, d.companyId);
    const t = d.expiryDate ? new Date(d.expiryDate).getTime() : NaN;
    const left = isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000);
    // `status` can lag behind the calendar, so the date wins where there is one.
    if (d.status === "overdue" || (left != null && left < 0)) bump(ovd, d.companyId);
    else if (left != null && left <= 30) bump(exp, d.companyId);
    // No usable expiry at all. Counted separately and NOT treated as healthy: "we don't know when this
    // expires" is not the same claim as "this is in good standing", and a compliance score that
    // rounded it up to healthy is the more dangerous of the two readings.
    else if (left == null) bump(unk, d.companyId);
  }
  return rows.map(r => ({
    ...r,
    employees: empBy.get(r.id) ?? 0,
    overdue: ovd.get(r.id) ?? 0,
    expiring: exp.get(r.id) ?? 0,
    documents: tot.get(r.id) ?? 0,
    undated: unk.get(r.id) ?? 0,
    /** When this company entered the system. Null for anything that predates the history table. */
    arrivedAt: arrivedBy.get(r.id) ?? null,
    /** When anybody last logged contact. Null means never — which is not the same as "long ago". */
    lastContactAt: contactedBy.get(r.id) ?? null,
    /**
     * How many deals this company has, of ANY kind — open, won or lost.
     *
     * The number was already being counted here and then spent entirely on `idleDays` below, which
     * meant the screens could not see it. The Leads list needs it to decide whether a lead is safe
     * to offer a delete on, and asking a second time from the browser would be a second count that
     * could disagree with this one.
     *
     * Every kind counts because every kind is a reason not to delete: a lost deal is still a record
     * of a decision, and the company it points at has to keep existing for it to mean anything.
     */
    deals: dealsBy.get(r.id) ?? 0,
    /**
     * Days this lead has been neglected, or null when the question does not apply. From the SAME
     * function the hourly idle-lead notice uses, so the Leads screen's Idle tab and the message
     * somebody received cannot disagree.
     */
    idleDays: idleDaysOf({
      lifecycle: r.lifecycle,
      deals: dealsBy.get(r.id) ?? 0,
      lastContactAt: contactedBy.get(r.id) ?? null,
      arrivedAt: arrivedBy.get(r.id) ?? null,
      createdAt: r.createdAt ?? null,
    }),
  }));
}

// Optional row-level scope: returns a Prisma `where` fragment restricting which rows the caller may
// touch (or null for unrestricted). Without it, a role-scoped list (e.g. sales → assigned clients)
// is trivially bypassed via /:id, which is exactly the "scoped list, unscoped record" bug class.
export type ScopeFn = (req: any) => Promise<Record<string, any> | null>;

// Generic REST CRUD for a Prisma model delegate (e.g. "company", "package").
// `include` (optional) is a Prisma include applied to reads, for relations the UI renders
// (e.g. subscriptions → package name on the tier cards).
export function crud(modelName: string, scope?: ScopeFn, include?: Record<string, any>) {
  const model = (prisma as any)[modelName];
  const r = Router();
  const whereFor = async (req: any) => (scope ? await scope(req) : null);
  // Fetch a row only if it's inside the caller's scope — otherwise it doesn't exist, as far as they know.
  // Combine with AND, never object-spread: a scope keyed on the same column (e.g. companies →
  // { id: { in: [...] } }) would otherwise overwrite the requested id and match the wrong row.
  const findInScope = async (req: any, id: string) => {
    const w = await whereFor(req);
    return model.findFirst({ where: w ? { AND: [{ id }, w] } : { id }, ...(include ? { include } : {}) });
  };

  // Every collection used to return the ENTIRE table, so a client with thousands of documents would
  // ship all of them on every screen load. Paging is opt-in and BACKWARD COMPATIBLE: the response is
  // still a plain JSON array (both front ends map over it directly), with the paging facts in
  // headers. A hard cap applies even when no params are given, so nothing can run away.
  const MAX_TAKE = 500;
  r.get("/", async (req, res) => {
    try {
      const w = await whereFor(req);
      const q: any = req.query ?? {};
      const asInt = (v: unknown, dflt: number, lo: number, hi: number) => {
        const n = parseInt(String(v ?? ""), 10);
        return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
      };
      // `page` is 1-based and sugar over skip/take; explicit skip wins if both are sent.
      const take = asInt(q.take ?? q.limit, MAX_TAKE, 1, MAX_TAKE);
      const page = asInt(q.page, 1, 1, 1_000_000);
      const skip = q.skip != null ? asInt(q.skip, 0, 0, 10_000_000) : (page - 1) * take;

      // Retired configuration is hidden from every list by default.
      //
      // A pack uninstall retires rather than deletes anything real records depend on, and a row that is
      // "retired" but still offered in every picker is not retired at all — it is just labelled. One
      // filter here covers every collection served by this helper, which is why they all go through it.
      // `?includeRetired=1` is the escape hatch for a screen that genuinely wants the history.
      const wantRetired = String(q.includeRetired ?? "") === "1";
      const retiredFilter = (!wantRetired && RETIREABLE.includes(modelName)) ? { retired: false } : {};
      const merged = { ...(w ?? {}), ...retiredFilter };
      const where = Object.keys(merged).length ? { where: merged } : {};
      const [total, rows] = await Promise.all([
        model.count({ ...where }),
        model.findMany({ ...where, ...(include ? { include } : {}), skip, take }),
      ]);
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("X-Page-Size", String(take));
      res.setHeader("X-Page-Skip", String(skip));
      // Tell the caller when it is only seeing part of the set, so a silent truncation is detectable.
      if (skip + rows.length < total) res.setHeader("X-Has-More", "true");
      res.json(redact(modelName, modelName === "company" ? await withLiveCounts(rows) : rows));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get("/:id", async (req, res) => {
    try {
      const item = await findInScope(req, req.params.id);
      if (!item) return res.status(404).json({ error: "Not found" });
      res.json(redact(modelName, modelName === "company" ? (await withLiveCounts([item]))[0] : item));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post("/", async (req, res) => {
    const err = validate(modelName, req.body, true);
    if (err) return res.status(400).json({ error: err });
    try {
      // Last line of defence on document numbering. The column has no unique constraint, so without
      // this two invoices could carry the same number — and on a tax document that is not a cosmetic
      // clash. Refused rather than silently renumbered: the caller should know its number was stale.
      if ((modelName === "invoice" || modelName === "quotation") && req.body?.number) {
        const clash = await model.findFirst({ where: { number: String(req.body.number) }, select: { id: true } });
        if (clash) return res.status(409).json({ error: `${req.body.number} already exists — reload and try again` });
      }
      // Tasks and receipts are numbered here because they have no dedicated create route — every
      // one of them arrives through this router. Only filled in when absent, so an import or a
      // caller supplying its own reference keeps it.
      const data = sanitize(modelName, req.body);
      if (modelName === "task" && !data.ref) data.ref = await nextNumber("task");
      if (modelName === "payment" && !data.number) data.number = await nextNumber("receipt");
      if (modelName === "serviceRequest" && !data.number) data.number = await nextNumber("request");
      // Every new employee gets a code, because a name is not an identity: two people called Mohammed
      // Ali were indistinguishable to every picker and to every piece of code matching a document to a
      // person. Only filled when absent, so an import carrying the client's own codes keeps them.
      if (modelName === "employee" && !data.code) data.code = await nextNumber("employee", { companyId: data.companyId });
      // Record when a client was taken on, so "Client since" can stop being invented.
      if (modelName === "company" && !data.createdAt) data.createdAt = new Date().toISOString();
      // Which country's law a client is judged under. Backfilling existing rows was only half the job:
      // without this, the client added tomorrow arrives with no country and quietly drops out of
      // anything that filters by one. Named in a single place so that when a second market opens this
      // becomes an org setting rather than a value hunted through the codebase.
      if (modelName === "company" && !data.country) data.country = await homeCountry();
      // Configuration belongs to a market too. Without this, a document type or template created after
      // a second country pack is installed has no country and shows up in every client's pickers
      // regardless of where they operate — the same "backfilled but not defaulted" gap that had to be
      // fixed twice already today, once for clients and once for government centers.
      if (COUNTRY_SCOPED_CONFIG.includes(modelName) && !data.country) data.country = await homeCountry();
      // An employee counts toward one country's workforce — their employer's unless stated otherwise.
      if (modelName === "employee" && !data.workCountry && data.companyId) {
        const co = await prisma.company.findUnique({ where: { id: data.companyId }, select: { country: true } }).catch(() => null);
        data.workCountry = co?.country ?? await homeCountry();
      }
      const created = await model.create({ data });
      // Persisted activity feed + notifications for compliance-critical events
      const act = await activityFor(modelName, created);
      if (act) logActivity(act);
      if (modelName === "document" && (created.status === "expiring" || created.status === "overdue")) {
        logNotification({ type: created.status, title: `${created.status === "overdue" ? "Overdue" : "Expiring"}: ${created.docType} — ${created.person}`, message: created.expiryDate ? `Due ${created.expiryDate}` : undefined });
      }
      // Email the client that they've been invoiced. A DRAFT is deliberately silent — the billing job
      // raises drafts for a human to release, and a client must not be chased for an unreleased bill.
      if (modelName === "invoice" && created.status && created.status !== "draft") {
        notifyInvoiceRaised({ companyId: created.companyId, number: created.number, amount: created.amount, currency: created.currency, dueDate: created.dueDate });
      }
      res.status(201).json(redact(modelName, created));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  r.put("/:id", async (req, res) => {
    const err = validate(modelName, req.body, false);
    if (err) return res.status(400).json({ error: err });
    try {
      const before = await findInScope(req, req.params.id);
      if (!before) return res.status(404).json({ error: "Not found" });
      const updated = await model.update({ where: { id: req.params.id }, data: sanitize(modelName, req.body) });
      if (modelName === "invoice" && req.body?.status === "paid") {
        logActivity({ type: "finance", message: `Invoice ${updated.number} marked paid` });
        logNotification({ type: "payment", title: `Payment received: ${updated.number}`, message: updated.clientName ?? undefined });
      }
      // Staff act on appointments through this generic PUT, so a client could book through the portal
      // and never hear back. The verb comes from what ACTUALLY changed, compared against the row as it
      // was — announcing "rescheduled" when only a note was edited would be its own small lie.
      if (modelName === "appointment") {
        const stChanged = req.body?.status != null && String(req.body.status) !== String((before as any).status ?? "");
        const whenChanged =
          (req.body?.date != null && String(req.body.date) !== String((before as any).date ?? "")) ||
          (req.body?.time != null && String(req.body.time) !== String((before as any).time ?? ""));
        const st = String(updated.status ?? "").toLowerCase();
        // Nothing relevant moved → say nothing. Editing a title or a note must not re-announce the
        // status the appointment already had; the first version of this checked the CURRENT status
        // rather than whether it CHANGED, and re-sent "confirmed" on every unrelated edit.
        const what = !stChanged && !whenChanged ? null
          : whenChanged ? "rescheduled"
          : st === "cancelled" ? "cancelled"
          : st === "confirmed" ? "confirmed"
          : st === "attended" ? "marked attended"
          : `set to ${updated.status}`;
        if (what) {
          notifyAppointmentChanged({
            companyId: updated.companyId, type: updated.type, date: updated.date, time: updated.time, what,
          });
        }
      }
      // A quotation reaching `sent` is the moment the clock starts on the client's answer. Stamped
      // on the TRANSITION, so re-saving an already-sent quotation does not restart the wait and let
      // a stale one escape being chased.
      if (modelName === "quotation"
        && String(req.body?.status ?? "").toLowerCase() === "sent"
        && String((before as any).status ?? "").toLowerCase() !== "sent"
        && !(updated as any).sentAt) {
        await prisma.quotation.update({ where: { id: updated.id }, data: { sentAt: new Date().toISOString() } });
        (updated as any).sentAt = new Date().toISOString();
      }
      // A quotation reaching `accepted` schedules the work it describes — whether the client
      // accepted it in the portal or staff recorded the acceptance here. Gated on the TRANSITION,
      // so re-saving an already-accepted quotation doesn't try again (startDelivery is idempotent
      // as well, but a no-op is cheaper than a lookup that discovers it).
      // Reassigning a task told the user "logged to activity" and logged nothing — activityFor()
      // only runs on create. Either the claim goes or the entry does; the entry is the useful half,
      // because who a piece of work moved to and when is exactly what someone reconstructs later.
      if (modelName === "task" && req.body?.assignee != null
        && String(req.body.assignee) !== String((before as any).assignee ?? "")) {
        logActivity({
          type: "task",
          message: `Task reassigned: ${(updated as any).title} — ${(before as any).assignee || "Unassigned"} → ${(updated as any).assignee || "Unassigned"}`,
          user: (req as any).auth?.keyName ?? "Staff",
        });
      }
      if (modelName === "quotation"
        && String(req.body?.status ?? "").toLowerCase() === "accepted"
        && String((before as any).status ?? "").toLowerCase() !== "accepted") {
        startDeliveryForQuotation(updated.id, { actor: (req as any).auth?.keyName ?? "Staff" })
          .catch(e => console.error("delivery failed for", (updated as any).number, e));
      }
      // Turning down an add-on request. Approval has its own route (it needs a price), so this only
      // has to cover the refusal — otherwise the client's card would sit on "Requested" for good.
      if (modelName === "upgradeRequest" && (updated as any).kind === "addon"
        && String(req.body?.status ?? "").toLowerCase() === "rejected"
        && String((before as any).status ?? "").toLowerCase() !== "rejected") {
        notifyAddonRejected({ companyId: (updated as any).companyId, serviceName: (updated as any).serviceName });
        // …and the deal it raised is lost, with a reason. Business the client asked for and did not
        // get belongs in the loss report like any other — otherwise the only client-initiated deals
        // that ever appear are the ones that succeeded, and the win rate flatters itself.
        await closeAddonDeal((updated as any).id, {
          won: false,
          reason: String(req.body?.rejectedReason ?? "").trim() || "Add-on request turned down",
        }).catch(e => console.error("could not close the add-on deal", e));
      }
      res.json(redact(modelName, updated));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete("/:id", async (req, res) => {
    try {
      if (!(await findInScope(req, req.params.id))) return res.status(404).json({ error: "Not found" });
      await model.delete({ where: { id: req.params.id } });
      res.status(204).end();
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return r;
}
