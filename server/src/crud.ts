import { Router } from "express";
import { prisma } from "./db.js";
import { validate } from "./validate.js";
import { logActivity, logNotification } from "./auth.js";
import { notifyInvoiceRaised, notifyAppointmentChanged } from "./notify.js";

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

      const where = w ? { where: w } : {};
      const [total, rows] = await Promise.all([
        model.count({ ...where }),
        model.findMany({ ...where, ...(include ? { include } : {}), skip, take }),
      ]);
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("X-Page-Size", String(take));
      res.setHeader("X-Page-Skip", String(skip));
      // Tell the caller when it is only seeing part of the set, so a silent truncation is detectable.
      if (skip + rows.length < total) res.setHeader("X-Has-More", "true");
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  r.get("/:id", async (req, res) => {
    try {
      const item = await findInScope(req, req.params.id);
      if (!item) return res.status(404).json({ error: "Not found" });
      res.json(item);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  r.post("/", async (req, res) => {
    const err = validate(modelName, req.body, true);
    if (err) return res.status(400).json({ error: err });
    try {
      const created = await model.create({ data: sanitize(modelName, req.body) });
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
      res.status(201).json(created);
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
      res.json(updated);
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
