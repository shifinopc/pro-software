import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { crud, type ScopeFn } from "./crud.js";
import { startScheduler, runTick } from "./scheduler.js";
import { workflowRouter } from "./workflow.js";
import { validate } from "./validate.js";
import { prisma } from "./db.js";
import { sendMail, getEmailConfig, verifyEmail } from "./mailer.js";
import { addClient, issueTicket, redeemTicket, publish, connectionCount } from "./realtime.js";
import { notify, notifyNewServiceRequest, notifyRequestReply, notifyInvoiceRaised } from "./notify.js";
import {
  hashPassword, verifyPassword, signToken,
  requireAuth, requireStaff, requirePortal, requireWriteRole, requireReadRole, generateTempPassword,
  encrypt, decrypt, logAudit, logActivity, logNotification, clientIp,
} from "./auth.js";

const app = express();
app.set("trust proxy", 1); // behind a reverse proxy in prod → correct client IPs + rate limiting
app.use(helmet({ contentSecurityPolicy: false })); // security headers incl. HSTS (API is JSON-only)

// Throttle auth endpoints to blunt brute-force (per IP).
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts — try again later" } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests — try again later" } });

// Allow the console + portal origins (local dev and live). Override with CORS_ORIGINS in .env
// (comma-separated). Requests with no Origin (curl, server-to-server) are always allowed.
const DEFAULT_ORIGINS = [
  "http://localhost:5188", "http://localhost:5173", "http://127.0.0.1:5188",
  "https://pro.ionob.in", "https://cp.ionob.in",
];
const allowedOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed by CORS`));
  },
}));
app.use(express.json({ limit: '6mb' })); // raised for base64 logo/file uploads

// ── Public ──
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "connected" });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Auth ──
// Security policy — admin-tunable from Settings → Security, stored in AppSetting "security".
// Every consumer reads through getSecurity() so a saved change applies immediately (no restart);
// values are clamped so a bad write can never lock everyone out with a 0-attempt threshold.
const SEC_DEFAULTS = { minPwLen: 8, lockThreshold: 5, lockMinutes: 15, tokenTtlHours: 12 };
async function getSecurity() {
  const row = await prisma.appSetting.findUnique({ where: { key: "security" } }).catch(() => null);
  const v = (row?.value ?? {}) as Record<string, unknown>;
  const num = (x: unknown, min: number, max: number, dflt: number) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : dflt;
  };
  return {
    minPwLen: num(v.minPwLen, 6, 32, SEC_DEFAULTS.minPwLen),
    lockThreshold: num(v.lockThreshold, 3, 20, SEC_DEFAULTS.lockThreshold),
    lockMinutes: num(v.lockMinutes, 5, 1440, SEC_DEFAULTS.lockMinutes),
    tokenTtlHours: num(v.tokenTtlHours, 1, 168, SEC_DEFAULTS.tokenTtlHours),
  };
}

// Shared login logic for staff + portal. Handles lockout, audit, and tokenVersion.
async function doLogin(req: express.Request, res: express.Response, kind: "staff" | "portal") {
  const { email, password } = req.body ?? {};
  const ip = clientIp(req);
  const sec = await getSecurity();
  const user = await prisma.user.findUnique({ where: { email: String(email || "").toLowerCase() } });

  // Account lockout check
  if (user?.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    await logAudit({ action: "login.locked", actorId: user.id, actorEmail: user.email, ip });
    return res.status(429).json({ error: "Account temporarily locked after too many failed attempts. Try again later." });
  }

  // Deactivated / suspended accounts cannot sign in (staff console OR client portal) until re-activated.
  if (user && user.status && user.status !== "active" && user.status !== "invited") {
    await logAudit({ action: "login.blocked", actorId: user.id, actorEmail: user.email, ip, detail: `status=${user.status}` });
    return res.status(403).json({ error: "This account is inactive. Contact your administrator." });
  }

  const ok = !!user && user.type === kind && !!user.passwordHash && await verifyPassword(String(password || ""), user.passwordHash) && (kind !== "portal" || !!user.companyId);
  if (!ok) {
    if (user) {
      const failed = (user.failedLogins ?? 0) + 1;
      const lockedUntil = failed >= sec.lockThreshold ? new Date(Date.now() + sec.lockMinutes * 60000).toISOString() : null;
      await prisma.user.update({ where: { id: user.id }, data: { failedLogins: lockedUntil ? 0 : failed, lockedUntil } });
    }
    await logAudit({ action: "login.fail", actorId: user?.id ?? null, actorEmail: String(email || "").toLowerCase() || null, ip });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  // Success → reset counters, log, issue token with current tokenVersion
  await prisma.user.update({ where: { id: user!.id }, data: { failedLogins: 0, lockedUntil: null, lastActive: "Just now" } });
  await logAudit({ action: "login.success", actorId: user!.id, actorEmail: user!.email, ip });
  const token = signToken(kind === "staff"
    ? { sub: user!.id, type: "staff", role: user!.roleId, tv: user!.tokenVersion }
    : { sub: user!.id, type: "portal", companyId: user!.companyId!, tv: user!.tokenVersion }, sec.tokenTtlHours);
  if (kind === "staff") return res.json({ token, user: { id: user!.id, name: user!.name, email: user!.email, role: user!.roleId } });
  return res.json({ token, companyId: user!.companyId, name: user!.name, mustChangePassword: !!user!.mustChangePassword });
}

app.post("/api/auth/login", authLimiter, (req, res) => doLogin(req, res, "staff"));
app.post("/api/auth/portal-login", authLimiter, (req, res) => doLogin(req, res, "portal"));

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const user = await prisma.user.findUnique({ where: { id: a.sub } });
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user.id, name: user.name, email: user.email, role: user.roleId, type: user.type, companyId: user.companyId, phone: user.phone ?? null });
});

// Change own password (staff OR portal). Bumps tokenVersion → all other sessions are logged out.
app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const { currentPassword, newPassword } = req.body ?? {};
  const sec = await getSecurity();
  if (!newPassword || String(newPassword).length < sec.minPwLen) return res.status(400).json({ error: `New password must be at least ${sec.minPwLen} characters` });
  const user = await prisma.user.findUnique({ where: { id: a.sub } });
  if (!user || !user.passwordHash) return res.status(404).json({ error: "Not found" });
  if (!(await verifyPassword(String(currentPassword || ""), user.passwordHash))) return res.status(400).json({ error: "Current password is incorrect" });
  if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: "New password must be different from the current one" });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(String(newPassword)), mustChangePassword: false, tokenVersion: { increment: 1 } } });
  await logAudit({ action: "password.change", actorId: user.id, actorEmail: user.email, ip: clientIp(req) });
  // Re-issue a token for THIS session so the caller isn't immediately logged out
  const token = signToken(user.type === "staff"
    ? { sub: user.id, type: "staff", role: user.roleId, tv: user.tokenVersion + 1 }
    : { sub: user.id, type: "portal", companyId: user.companyId!, tv: user.tokenVersion + 1 });
  res.json({ ok: true, token });
});

// Request a password reset. Always responds 200 (never reveals whether the email exists).
app.post("/api/auth/forgot-password", resetLimiter, async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase();
  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  if (user) {
    const raw = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    await prisma.user.update({ where: { id: user.id }, data: { resetTokenHash: hash, resetExpires: expires } });
    // portal users reset on cp., staff on pro.
    const base = user.type === "portal" ? (process.env.PORTAL_URL || "https://cp.ionob.in") : (process.env.CONSOLE_URL || "https://pro.ionob.in");
    const link = `${base}/reset?token=${raw}`;
    await logAudit({ action: "password.reset_requested", actorId: user.id, actorEmail: user.email, ip: clientIp(req) });
    await sendMail({
      to: user.email,
      subject: "Reset your STIMES PRO password",
      text: `Reset your password (valid 1 hour): ${link}`,
      html: `<p>We received a request to reset your STIMES PRO password.</p><p><a href="${link}">Reset your password</a> (valid for 1 hour).</p><p>If you didn't request this, ignore this email.</p>`,
    });
  }
  res.json({ ok: true });
});

// Complete a password reset with the emailed token.
app.post("/api/auth/reset-password", resetLimiter, async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  const secReset = await getSecurity();
  if (!token || !newPassword || String(newPassword).length < secReset.minPwLen) return res.status(400).json({ error: `Invalid token, or password shorter than ${secReset.minPwLen} characters` });
  const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const user = await prisma.user.findFirst({ where: { resetTokenHash: hash } });
  if (!user || !user.resetExpires || new Date(user.resetExpires) < new Date()) return res.status(400).json({ error: "Reset link is invalid or expired" });
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(String(newPassword)), resetTokenHash: null, resetExpires: null, failedLogins: 0, lockedUntil: null, mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  await logAudit({ action: "password.reset", actorId: user.id, actorEmail: user.email, ip: clientIp(req) });
  res.json({ ok: true });
});

// Audit log (staff only)
app.get("/api/audit", requireAuth, requireStaff, async (_req, res) => {
  const rows = await prisma.audit.findMany({ orderBy: { at: "desc" }, take: 200 });
  res.json(rows);
});

// The signed-in user's OWN recent audit trail (any role — self-scoped, safe fields only).
// Powers "Sessions & recent activity" on Profile & Settings.
app.get("/api/auth/my-activity", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const rows = await prisma.audit.findMany({ where: { actorId: a.sub }, orderBy: { at: "desc" }, take: 12 });
  res.json(rows.map(r => ({ action: r.action, target: r.target, detail: r.detail, ip: r.ip, at: r.at })));
});

// ── Client portal (strictly scoped to the authenticated client's company / group) ──
// Resolve the effective subscription resiliently: linked by FK, or scope="company" by refId,
// or inherited from the group (scope="group"). The bare `subscriptions` relation only matches
// the companyId FK, so group-inherited or refId-only subs would otherwise show as "No subscription".
const subsFor = (companyId: string, groupId?: string | null) =>
  prisma.subscription.findMany({
    where: { OR: [{ companyId }, { scope: "company", refId: companyId }, ...(groupId ? [{ scope: "group", refId: groupId }] : [])] },
    include: { package: true },
  });

/**
 * A portal user may read their own company AND its siblings in the same group — nothing else.
 * Returns the target company or null. Every per-company portal route must go through this: the
 * token only carries the PRIMARY companyId, so without it a client could pass any id and read
 * another tenant's employees.
 */
async function portalCompanyInScope(auth: any, id: string) {
  const mine = await prisma.company.findUnique({ where: { id: auth.companyId }, select: { id: true, groupId: true } });
  if (!mine) return null;
  if (id === mine.id) return mine;
  if (!mine.groupId) return null; // no group → no siblings → only your own company
  const target = await prisma.company.findUnique({ where: { id }, select: { id: true, groupId: true } });
  return target && target.groupId === mine.groupId ? target : null;
}

app.get("/api/portal/me", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const company = await prisma.company.findUnique({
    where: { id: a.companyId },
    include: { group: true, employeeList: { where: { archived: false } }, documents: true, invoices: true },
  });
  if (!company) return res.status(404).json({ error: "Company not found" });
  const subscriptions = await subsFor(company.id, company.groupId);
  // Group siblings carry their own real counts + subscription so the Companies screen can render
  // live figures instead of reading a hardcoded catalogue.
  const siblings = company.groupId
    ? await prisma.company.findMany({ where: { groupId: company.groupId } })
    : [company];
  const groupCompanies = await Promise.all(siblings.map(async c => ({
    ...c,
    subscriptions: await subsFor(c.id, c.groupId),
    counts: {
      employees: await prisma.employee.count({ where: { companyId: c.id } }),
      documents: await prisma.document.count({ where: { companyId: c.id } }),
      overdue: await prisma.document.count({ where: { companyId: c.id, status: "overdue" } }),
      expiring: await prisma.document.count({ where: { companyId: c.id, status: "expiring" } }),
    },
  })));
  // Org-wide display currency (Settings → General) so the portal renders money in the same unit.
  const orgRow = await prisma.appSetting.findUnique({ where: { key: "org" } }).catch(() => null);
  const orgCurrency = String(((orgRow?.value as any)?.currency) || "SAR — Saudi Riyal").split(" ")[0];
  // The portal used to name a fictional officer ("Rashid Al Mansoori") as the client's PRO contact.
  // There is no per-client officer in the model, so the honest label is the provider's own name.
  const orgName = String(((orgRow?.value as any)?.orgName) || "your PRO team");
  // Attach what has been received against each invoice. Payment has no Prisma relation to Invoice,
  // so it is aggregated here — without it a client who has part-paid still sees the FULL amount
  // outstanding, which is the one number they know to be wrong.
  const paidRows = await prisma.payment.groupBy({
    by: ["invoiceId"],
    where: { companyId: company.id, NOT: { invoiceId: null } },
    _sum: { amount: true },
  });
  const paidBy = new Map(paidRows.map((r) => [r.invoiceId, r._sum.amount ?? 0]));
  const invoices = (company.invoices ?? []).map((inv) => {
    const paidAmount = paidBy.get(inv.id) ?? 0;
    return { ...inv, paidAmount, outstandingAmount: Math.max(0, inv.amount - paidAmount) };
  });
  res.json({
    company: { ...company, invoices, subscriptions }, groupCompanies, orgCurrency, orgName,
    // So the portal can explain the restriction rather than just failing when they try to act.
    suspended: company.status === "suspended",
    suspendedReason: company.status === "suspended" ? company.suspendedReason : null,
  });
});

// Full data for ONE company in the caller's group. The portal switches companies with this; without
// it, secondary companies rendered empty because /me only ever carried the primary's records.
app.get("/api/portal/company/:id", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  if (!(await portalCompanyInScope(a, req.params.id))) return res.status(404).json({ error: "Not found" });
  const company = await prisma.company.findUnique({
    where: { id: req.params.id },
    include: { group: true, employeeList: { where: { archived: false } }, documents: true, invoices: true },
  });
  if (!company) return res.status(404).json({ error: "Not found" });
  res.json({ ...company, subscriptions: await subsFor(company.id, company.groupId) });
});

// Client edits its own contact details. Whitelisted to three fields — the client must never be able
// to write status/overdue/group/salesRep or any other staff-owned column through this route.
app.put("/api/portal/company/:id/profile", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  if (!(await portalCompanyInScope(a, req.params.id))) return res.status(404).json({ error: "Not found" });
  try {
    const { contact, email, phone } = req.body ?? {};
    if (email !== undefined && String(email).trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim()))
      return res.status(400).json({ error: "Enter a valid email address" });
    const updated = await prisma.company.update({
      where: { id: req.params.id },
      data: {
        ...(contact !== undefined ? { contact: String(contact).trim() || null } : {}),
        ...(email !== undefined ? { email: String(email).trim() || null } : {}),
        ...(phone !== undefined ? { phone: String(phone).trim() || null } : {}),
      },
    });
    logActivity({ type: "client", message: `${updated.name} updated their contact details via the portal` });
    res.json({ contact: updated.contact, email: updated.email, phone: updated.phone });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal notifications — DERIVED (company-scoped) from the client's own data: expiring/overdue
// documents, service-request replies & outcomes, and invoices. No separate table; the global
// Notification model has no companyId and belongs to the staff console. Unread is a best-effort flag.
app.get("/api/portal/notifications", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const now = Date.now();
  const nowISO = new Date(now).toISOString();
  const money = (c: any) => `${c.currency || "SAR"} ${Number(c.amount).toLocaleString()}`;
  const [docs, reqs, invs] = await Promise.all([
    prisma.document.findMany({ where: { companyId: a.companyId, NOT: { expiryDate: null } } }),
    prisma.serviceRequest.findMany({ where: { companyId: a.companyId } }),
    prisma.invoice.findMany({ where: { companyId: a.companyId } }),
  ]);
  const out: any[] = [];
  for (const d of docs) {
    const t = new Date(d.expiryDate as string).getTime(); if (isNaN(t)) continue;
    const days = Math.round((t - now) / 86400000);
    const docKey = new Date(t).toISOString(); // stable: derived from the expiry, not the clock
    if (days < 0) out.push({ id: "doc-" + d.id, kind: "alert", title: `${d.docType} — ${d.person} is overdue`, meta: `Compliance · ${Math.abs(days)}d overdue`, ts: nowISO, readTs: docKey, unread: true, cta: "Renew" });
    else if (days <= 30) out.push({ id: "doc-" + d.id, kind: "refresh", title: `Renewal reminder: ${d.docType} — ${d.person}`, meta: `Compliance · ${days} days left`, ts: nowISO, readTs: docKey, unread: true, cta: "Renew" });
  }
  for (const r of reqs) {
    if (r.lastStaffMsgAt && String(r.lastStaffMsgAt) > String(r.clientReadAt || "")) out.push({ id: "req-" + r.id, kind: "check", title: `New reply on ${r.type || "your request"}`, meta: `Support · from your PRO team`, ts: r.lastStaffMsgAt, unread: true, cta: false });
    else if (r.status === "resolved") out.push({ id: "req-" + r.id, kind: "check", title: `${r.type || "Request"} resolved`, meta: `Support · ${r.date || ""}`, ts: r.lastStaffMsgAt || r.date || nowISO, unread: false, cta: false });
    else if (r.status === "rejected") out.push({ id: "req-" + r.id, kind: "alert", title: `${r.type || "Request"} needs your attention`, meta: `Support · ${r.date || ""}`, ts: r.date || nowISO, unread: false, cta: false });
  }
  for (const inv of invs) {
    if (inv.status !== "paid") out.push({ id: "inv-" + inv.id, kind: "invoice", title: `Invoice ${inv.number} issued — ${money(inv)}`, meta: `Billing${inv.dueDate ? ` · due ${inv.dueDate}` : ""}`, ts: inv.date || nowISO, unread: true, cta: "Pay" });
    else out.push({ id: "inv-" + inv.id, kind: "check", title: `Payment received — ${money(inv)}`, meta: `${inv.number}${inv.date ? ` · ${inv.date}` : ""}`, ts: inv.date || nowISO, unread: false, cta: false });
  }
  out.sort((x, y) => String(y.ts).localeCompare(String(x.ts)));
  // Apply the read watermark: anything at or before it has been acknowledged. Derived notifications
  // have no row to flag, so this is what makes "Mark all read" survive a reload.
  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { notifReadAt: true } });
  const readAt = me?.notifReadAt ?? "";
  res.json(out.slice(0, 30).map((n) => {
    const stamp = String((n as any).readTs ?? n.ts);
    return readAt && stamp <= readAt ? { ...n, unread: false } : n;
  }));
});

/** Mark every current notification read, by moving the watermark to now. */
app.post("/api/portal/notifications/read", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    await prisma.user.update({ where: { id: a.sub }, data: { notifReadAt: new Date().toISOString() } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Staff: reset a client's portal login password (resets to the default and forces a change on next login).
// Super Admin: log in as another user (impersonation) — no credentials. Audited. Only super_admin.
app.post("/api/users/:id/login-as", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  if (a.role !== "super_admin") return res.status(403).json({ error: "Only a Super Admin can log in as another user" });
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!u) return res.status(404).json({ error: "User not found" });
  if (u.status && u.status !== "active") return res.status(400).json({ error: "That user account is not active" });
  await logAudit({ action: "user.login_as", actorId: a.sub, target: `${u.email} (${u.id})`, ip: clientIp(req) });
  const token = u.type === "portal" && u.companyId
    ? signToken({ sub: u.id, type: "portal", companyId: u.companyId, tv: u.tokenVersion })
    : signToken({ sub: u.id, type: "staff", role: u.roleId, tv: u.tokenVersion });
  res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.roleId, type: u.type, companyId: u.companyId } });
});

// Admin-only: any staff being able to reset a client's portal password meant a low-privilege role
// could take over that client's portal (and its credential vault). Issues a random one-time password
// that the client is forced to replace on first login.
app.post("/api/companies/:id/reset-portal-password", requireAuth, requireStaff, requireWriteRole, resetLimiter, async (req, res) => {
  const a = (req as any).auth;
  const user = await prisma.user.findFirst({ where: { companyId: req.params.id, type: "portal" } });
  if (!user) return res.status(404).json({ error: "This client has no portal login" });
  const temp = generateTempPassword();
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(temp), mustChangePassword: true, failedLogins: 0, lockedUntil: null, tokenVersion: { increment: 1 } } });
  await logAudit({ action: "portal.password_reset", actorId: a.sub, target: user.email, detail: `company ${req.params.id}`, ip: clientIp(req) });
  res.json({ email: user.email, tempPassword: temp });
});

// Admin-only: reset ANY user's (staff or portal) password → one-time temp password, forced change on
// first login. Kills any live sessions (tokenVersion++) and clears lockout.
app.post("/api/users/:id/reset-password", requireAuth, requireStaff, requireWriteRole, resetLimiter, async (req, res) => {
  const a = (req as any).auth;
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  const temp = generateTempPassword();
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(temp), mustChangePassword: true, failedLogins: 0, lockedUntil: null, tokenVersion: { increment: 1 } } });
  await logAudit({ action: "user.password_reset", actorId: a.sub, target: user.email, ip: clientIp(req) });
  res.json({ email: user.email, name: user.name, tempPassword: temp });
});

// The portal's Service Catalog rendered a static 17-row price list. This serves the REAL catalog so
// what a client sees (and the fees they're quoted) matches what staff configured.
app.get("/api/portal/service-items", requireAuth, requirePortal, async (_req, res) => {
  const rows = await prisma.serviceItem.findMany({ orderBy: { name: "asc" } });
  res.json(rows);
});

// The portal's Quotations screen used to render a hardcoded QT-338/331/325 list to EVERY client.
// This returns only the signed-in company's real quotations (drafts stay internal).
app.get("/api/portal/quotations", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const rows = await prisma.quotation.findMany({
    where: { companyId: a.companyId, status: { not: "draft" } },
    orderBy: { date: "desc" },
  });
  res.json(rows);
});

// A client acting on their own quotation: accept or reject only, and only their own.
app.put("/api/portal/quotations/:id", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const want = String(req.body?.status ?? "").toLowerCase();
  if (!["approved", "rejected"].includes(want)) return res.status(400).json({ error: "status must be approved or rejected" });
  const q = await prisma.quotation.findUnique({ where: { id: req.params.id } });
  if (!q || q.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
  if (q.status === "draft") return res.status(400).json({ error: "This quotation has not been sent yet" });
  const updated = await prisma.quotation.update({ where: { id: q.id }, data: { status: want } });
  logActivity({ type: "finance", message: `Quotation ${q.number} ${want} by ${q.clientName ?? "client"}`, user: q.clientName ?? "Client" });
  logNotification({ type: "system", title: `Quotation ${want} — ${q.clientName ?? "client"}`, message: `${q.number} · ${q.service ?? ""}`.trim() });
  res.json(updated);
});

app.get("/api/portal/credentials", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const creds = await prisma.siteCredential.findMany({ where: { companyId: a.companyId } });
  // Never return the (encrypted) secret in a list — reveal is a separate, audited call
  res.json(creds.map(({ password, ...rest }: any) => rest));
});

app.get("/api/portal/credentials/:id/reveal", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const c = await prisma.siteCredential.findUnique({ where: { id: req.params.id } });
  if (!c || c.companyId !== a.companyId) return res.status(404).json({ error: "Not found" }); // isolation
  await logAudit({ action: "credential.reveal", actorId: a.sub, target: `${c.label} (${c.id})`, detail: `company ${c.companyId}`, ip: clientIp(req) });
  res.json({ password: decrypt(c.password) });
});

// Portal: client manages its OWN site credentials (company-scoped). Edits are activity-logged so
// they surface in the console client's Activity tab and the staff credential list stays in sync.
app.post("/api/portal/credentials", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { password, label, url, username, notes } = req.body ?? {};
    if (!label || !url) return res.status(400).json({ error: "Label and URL are required" });
    const created = await prisma.siteCredential.create({ data: { companyId: a.companyId, label, url, username: username ?? null, notes: notes ?? null, password: encrypt(String(password ?? "")) } });
    const cn = await coName(a.companyId);
    logActivity({ type: "client", message: `Site credential added (${created.label})${cn ? ` for ${cn}` : ""} — by client`, user: "Client portal" });
    await logAudit({ action: "portal.credential.create", actorId: a.sub, target: `${created.label} (${created.id})`, detail: `company ${a.companyId}`, ip: clientIp(req) });
    const { password: _p, ...safe } = created;
    res.status(201).json(safe);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.put("/api/portal/credentials/:id", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const existing = await prisma.siteCredential.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== a.companyId) return res.status(404).json({ error: "Not found" }); // isolation
    const { password, label, url, username, notes } = req.body ?? {};
    const data: any = {};
    if (label !== undefined) data.label = label;
    if (url !== undefined) data.url = url;
    if (username !== undefined) data.username = username;
    if (notes !== undefined) data.notes = notes;
    if (typeof password === "string" && password.length > 0) data.password = encrypt(password);
    const updated = await prisma.siteCredential.update({ where: { id: req.params.id }, data });
    const cn = await coName(a.companyId);
    logActivity({ type: "client", message: `Site credential updated (${updated.label})${cn ? ` for ${cn}` : ""} — by client`, user: "Client portal" });
    await logAudit({ action: "portal.credential.update", actorId: a.sub, target: `${updated.label} (${updated.id})`, detail: `company ${a.companyId}`, ip: clientIp(req) });
    const { password: _p, ...safe } = updated;
    res.json(safe);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/portal/credentials/:id", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const existing = await prisma.siteCredential.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
    await prisma.siteCredential.delete({ where: { id: req.params.id } });
    const cn = await coName(a.companyId);
    logActivity({ type: "client", message: `Site credential removed (${existing.label})${cn ? ` for ${cn}` : ""} — by client`, user: "Client portal" });
    await logAudit({ action: "portal.credential.delete", actorId: a.sub, target: `${existing.label} (${existing.id})`, ip: clientIp(req) });
    res.status(204).end();
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: read the package catalog (needed to show current tier + next-tier upgrade in the portal)
app.get("/api/portal/packages", requireAuth, requirePortal, async (_req, res) => {
  res.json(await prisma.package.findMany());
});

// Portal: change own password (used both for the forced first-login change and voluntary changes)
app.post("/api/portal/change-password", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const { currentPassword, newPassword } = req.body ?? {};
  const sec = await getSecurity();
  if (!newPassword || String(newPassword).length < sec.minPwLen) return res.status(400).json({ error: `New password must be at least ${sec.minPwLen} characters` });
  // (No shared-default check needed — temp passwords are random now, and the
  // "must differ from current" rule below already blocks reusing the issued one.)
  const user = await prisma.user.findUnique({ where: { id: a.sub } });
  if (!user || user.type !== "portal" || !user.passwordHash) return res.status(404).json({ error: "Not found" });
  if (!(await verifyPassword(String(currentPassword || ""), user.passwordHash))) return res.status(400).json({ error: "Current password is incorrect" });
  if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: "New password must be different from the current one" });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(String(newPassword)), mustChangePassword: false, tokenVersion: { increment: 1 } } });
  await logAudit({ action: "portal.password.change", actorId: user.id, actorEmail: user.email, ip: clientIp(req) });
  // Re-issue this session's token so the client isn't kicked out right after changing
  const token = signToken({ sub: user.id, type: "portal", companyId: user.companyId!, tv: user.tokenVersion + 1 });
  res.json({ ok: true, token });
});

// Portal: add an employee to the authenticated client's own company
app.post("/api/portal/employees", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  const vErr = validate("employee", req.body, true);
  if (vErr) return res.status(400).json({ error: vErr });
  try {
    const { name, role, iqamaExpiry, status, customData } = req.body ?? {};
    const created = await prisma.employee.create({
      data: { companyId: a.companyId, name: String(name || ""), role: role ?? null, iqamaExpiry: iqamaExpiry ?? null, status: status ?? "valid", customData: customData ?? undefined },
    });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Portal: read admin-defined custom employee fields (so the portal's Add Employee form renders them)
app.get("/api/portal/custom-fields", requireAuth, requirePortal, async (_req, res) => {
  res.json(await prisma.customField.findMany({ where: { entity: "employee" }, orderBy: { sortOrder: "asc" } }));
});

// Portal: read the entity-bound Form Builder forms (kind=form) so the portal Add-Employee form mirrors the console.
app.get("/api/portal/custom-objects", requireAuth, requirePortal, async (_req, res) => {
  res.json(await prisma.customObject.findMany({ where: { kind: "form" } }));
});

// Portal: read admin-defined document types (so the portal can render the right fields when uploading a document)
app.get("/api/portal/document-types", requireAuth, requirePortal, async (_req, res) => {
  res.json(await prisma.documentType.findMany({ orderBy: { name: "asc" } }));
});

// Portal: add a document (scoped to the authenticated client's company) → flows into Compliance
app.post("/api/portal/documents", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { person, docType, expiryDate, status, daysLeft, customData } = req.body ?? {};
    if (!docType) return res.status(400).json({ error: "Document type is required" });
    const created = await prisma.document.create({
      data: { companyId: a.companyId, person: String(person || ""), docType: String(docType), expiryDate: expiryDate ?? null, status: status ?? "valid", daysLeft: Number(daysLeft) || 0, customData: customData ?? undefined },
    });
    res.status(201).json(created);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: the client's own appointments (read) + booking (creates a Requested appointment for staff
// to confirm). Rescheduling/cancelling stays a STAFF action — clients raise a reschedule request.
app.get("/api/portal/appointments", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  res.json(await prisma.appointment.findMany({ where: { companyId: a.companyId }, orderBy: { id: "desc" } }));
});
app.post("/api/portal/appointments", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { type, employee, date, time, clientName } = req.body ?? {};
    if (!type || !date) return res.status(400).json({ error: "Type and date are required" });
    const created = await prisma.appointment.create({
      data: { title: `${type}${clientName ? ` — ${clientName}` : ""}`, type: String(type), companyId: a.companyId, clientName: clientName ?? null, employee: employee ?? null, date: String(date), time: time ?? null, status: "Requested",
        history: [{ at: new Date().toISOString(), by: clientName || "Client", event: "Created", detail: `Requested for ${date}${time ? ` ${time}` : ""}` }] },
    });
    logActivity({ type: "client", message: `Appointment requested${clientName ? ` by ${clientName}` : ""}: ${type} · ${date}`, user: clientName ?? "Client" });
    logNotification({ type: "task", title: `Appointment request${clientName ? ` — ${clientName}` : ""}`, message: `${type} · ${date}${time ? ` ${time}` : ""}` });
    res.status(201).json(created);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: request a reschedule (structured). Stores the proposed slot on the appointment for STAFF to
// approve/decline in the console — the date only changes when staff approve.
app.post("/api/portal/appointments/:id/reschedule-request", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const appt = await prisma.appointment.findUnique({ where: { id: req.params.id } });
    if (!appt || appt.companyId !== a.companyId) return res.status(404).json({ error: "Appointment not found" });
    if (appt.status === "Cancelled" || appt.status === "Attended") return res.status(400).json({ error: "This appointment can no longer be rescheduled" });
    const { date, time, note, by } = req.body ?? {};
    if (!date) return res.status(400).json({ error: "Pick the preferred new date" });
    const who = by || appt.clientName || "Client";
    const hist = Array.isArray(appt.history) ? (appt.history as any[]) : [];
    const updated = await prisma.appointment.update({ where: { id: appt.id }, data: {
      pendingReschedule: { date: String(date), time: time ?? null, note: note ?? null, by: who, at: new Date().toISOString() },
      history: [...hist, { at: new Date().toISOString(), by: who, event: "Reschedule requested", detail: `${date}${time ? ` ${time}` : ""}${note ? ` · ${note}` : ""}` }],
    } });
    logActivity({ type: "client", message: `Reschedule requested by ${who}: ${appt.type ?? "appointment"} → ${date}${time ? ` ${time}` : ""}`, user: who });
    logNotification({ type: "task", title: `Reschedule request — ${who}`, message: `${appt.type ?? "Appointment"}: ${appt.date ?? ""} → ${date}${time ? ` ${time}` : ""}` });
    res.json(updated);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: raise a service request (scoped to the authenticated client's company)
// Portal: read the client's own service requests (so they persist across reloads)
app.get("/api/portal/service-requests", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  res.json(await prisma.serviceRequest.findMany({ where: { companyId: a.companyId }, orderBy: { id: "desc" } }));
});
app.post("/api/portal/service-requests", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { type, message, clientName, companyId } = req.body ?? {};
    // A group login can file for any company in its group, so honour an explicit companyId — but only
    // after checking it is actually in scope, never straight from the request body.
    let target = a.companyId;
    if (companyId && companyId !== a.companyId) {
      if (!(await portalCompanyInScope(a, String(companyId)))) return res.status(403).json({ error: "That company isn't on your account" });
      target = String(companyId);
    }
    const co = await prisma.company.findUnique({ where: { id: target }, select: { name: true } });
    // Stamp lastClientMsgAt on creation so a brand-new request counts as unread for staff — the
    // opening message is a client message, even though it predates the thread.
    const created = await prisma.serviceRequest.create({
      data: { companyId: target, clientName: co?.name ?? clientName ?? null, type: type ?? null, message: message ?? null, status: "open", date: "Just now", lastClientMsgAt: new Date().toISOString() },
    });
    logActivity({ type: "client", message: `Service request from ${co?.name ?? clientName ?? "a client"}: ${type ?? "request"}`, user: co?.name ?? clientName ?? "Client" });
    // Tells the staff inbox AND acknowledges to the client by email. Not awaited: SMTP must never
    // hold up the client's response.
    notifyNewServiceRequest({ companyId: target, clientName: co?.name ?? clientName, type, message });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Billing suspension & payment extensions ──────────────────────────
// Policy: a suspended client can still SIGN IN and SEE everything — documents, expiry dates,
// invoices. What they lose is the ability to ask for new work. Withholding compliance data would
// make them miss a visa deadline, which harms the client far more than it pressures them, and the
// firm carries the consequences of that too.
// Suspension is never automatic: the dunning job recommends, a human decides.

/** Portal write-guard. Read routes never use this; nor does reporting a payment or replying. */
async function requireNotSuspended(req: any, res: any, next: any) {
  const a = req.auth;
  try {
    const co = await prisma.company.findUnique({ where: { id: a.companyId }, select: { status: true, suspendedReason: true } });
    if (co?.status === "suspended") {
      return res.status(403).json({
        error: "New requests are paused on this account while there's an outstanding balance. You can still view everything, and telling us about a payment will lift it.",
        suspended: true, reason: co.suspendedReason ?? null,
      });
    }
    next();
  } catch { next(); } // a lookup failure must not lock a client out of their own account
}

app.post("/api/companies/:id/suspend", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const co = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!co) return res.status(404).json({ error: "Client not found" });
  const reason = String((req.body ?? {}).reason ?? "").trim() || "Outstanding balance";
  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const company = await prisma.company.update({
    where: { id: co.id },
    data: { status: "suspended", suspendedAt: new Date().toISOString(), suspendedReason: reason },
  });
  logActivity({ type: "finance", message: `Account suspended: ${co.name} — ${reason}`, user: me?.name ?? "Staff" });
  await logAudit({ action: "company.suspend", actorId: a.sub, target: co.id, detail: `${co.name} · ${reason}` });
  res.json({ company });
});

app.post("/api/companies/:id/restore", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const co = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!co) return res.status(404).json({ error: "Client not found" });
  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const company = await prisma.company.update({
    where: { id: co.id },
    data: { status: "active", suspendedAt: null, suspendedReason: null },
  });
  logActivity({ type: "finance", message: `Account restored: ${co.name}`, user: me?.name ?? "Staff" });
  await logAudit({ action: "company.restore", actorId: a.sub, target: co.id, detail: co.name });
  res.json({ company });
});

/**
 * Void an invoice. It is NEVER deleted — an issued tax document that disappears is worse than one
 * marked cancelled, and reports/audits need the trail. Refuses when money has already been received
 * against it: that would leave an orphaned payment and hide real cash.
 */
app.post("/api/invoices/:id/void", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (String(inv.status) === "void") return res.status(409).json({ error: "This invoice is already void" });

  const paid = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
  const received = paid._sum.amount ?? 0;
  if (received > 0)
    return res.status(409).json({
      error: `${inv.currency} ${received.toLocaleString()} has already been received against this invoice. Remove or reallocate the payment before voiding it.`,
    });

  const reason = String((req.body ?? {}).reason ?? "").trim();
  if (!reason) return res.status(400).json({ error: "A reason is required — it stays on the record" });

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const invoice = await prisma.invoice.update({
    where: { id: inv.id },
    data: { status: "void", voidedAt: new Date().toISOString(), voidReason: reason },
  });
  // Stop it chasing: the ladder rungs and any arrangement are meaningless once it's cancelled.
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: `dunning:${inv.id}:` } } });
  logActivity({ type: "finance", message: `Invoice ${inv.number} voided — ${reason}`, user: me?.name ?? "Staff" });
  await logAudit({ action: "invoice.void", actorId: a.sub, target: inv.id, detail: `${inv.number} · ${inv.currency} ${inv.amount} · ${reason}` });
  res.json({ invoice });
});

/** Edit an employee's details, appending to the same history[] the exit flow writes. */
app.post("/api/employees/:id/edit", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  const { name, role, iqamaExpiry } = req.body ?? {};
  const nextName = String(name ?? "").trim();
  if (!nextName) return res.status(400).json({ error: "Name is required" });
  if (iqamaExpiry && isNaN(new Date(String(iqamaExpiry)).getTime()))
    return res.status(400).json({ error: "That expiry date isn't a valid date" });

  // Record what actually changed, so the history is a diff rather than "edited".
  const changes: string[] = [];
  if (nextName !== emp.name) changes.push(`name: ${emp.name} → ${nextName}`);
  const nextRole = role == null ? emp.role : String(role).trim() || null;
  if (nextRole !== emp.role) changes.push(`role: ${emp.role ?? "—"} → ${nextRole ?? "—"}`);
  const nextExpiry = iqamaExpiry == null ? emp.iqamaExpiry : String(iqamaExpiry).trim() || null;
  if (nextExpiry !== emp.iqamaExpiry) changes.push(`Iqama expiry: ${emp.iqamaExpiry ?? "—"} → ${nextExpiry ?? "—"}`);
  if (!changes.length) return res.json({ employee: emp, unchanged: true });

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const employee = await prisma.employee.update({
    where: { id: emp.id },
    data: {
      name: nextName, role: nextRole, iqamaExpiry: nextExpiry,
      history: [...(Array.isArray(emp.history) ? (emp.history as any[]) : []),
        { at: new Date().toISOString(), event: "edited", by: me?.name ?? "Staff", detail: changes.join(" · ") }],
    },
  });
  logActivity({ type: "client", message: `Employee updated: ${nextName} (${changes.join(", ")})`, user: me?.name ?? "Staff" });
  await logAudit({ action: "employee.edit", actorId: a.sub, target: emp.id, detail: changes.join(" · ") });
  res.json({ employee });
});

/** Agree a payment date. Pauses dunning for that invoice and stops it driving a suspension. */
app.post("/api/invoices/:id/extend", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  const { promisedDate, note, clear } = req.body ?? {};
  if (clear) {
    const invoice = await prisma.invoice.update({ where: { id: inv.id }, data: { promisedDate: null, promisedNote: null } });
    await logAudit({ action: "invoice.extend.clear", actorId: a.sub, target: inv.id, detail: inv.number });
    return res.json({ invoice });
  }
  const when = String(promisedDate ?? "").trim();
  if (!when || isNaN(new Date(when).getTime())) return res.status(400).json({ error: "A valid payment date is required" });
  if (new Date(when).getTime() < Date.now() - 86400000)
    return res.status(400).json({ error: "The agreed date is in the past — pick a future date" });
  const invoice = await prisma.invoice.update({
    where: { id: inv.id },
    data: { promisedDate: when, promisedNote: String(note ?? "").trim() || null },
  });
  // Clear the ladder rungs already sent so a later slip re-chases from the start rather than being
  // permanently silenced by rungs consumed before the arrangement was made.
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: `dunning:${inv.id}:` } } });
  logActivity({ type: "finance", message: `Payment extension on ${inv.number} until ${when}${inv.clientName ? ` — ${inv.clientName}` : ""}` });
  await logAudit({ action: "invoice.extend", actorId: a.sub, target: inv.id, detail: `${inv.number} → ${when}` });
  res.json({ invoice });
});

// ── ZATCA QR for printed tax invoices ────────────────────────────────
// Saudi e-invoicing mandates a QR carrying a base64 TLV payload with five tags: seller name, seller
// VAT number, invoice timestamp, invoice total (incl. VAT) and the VAT amount. Rendered server-side
// with a real encoder so the printed code actually scans — the print designer used to show a
// decorative checkerboard, which on a tax document is worse than showing nothing.
function zatcaTlv(fields: { seller: string; vat: string; stamp: string; total: string; vatTotal: string }) {
  const tlv = (tag: number, value: string) => {
    const buf = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([tag, buf.length]), buf]);
  };
  return Buffer.concat([
    tlv(1, fields.seller), tlv(2, fields.vat), tlv(3, fields.stamp),
    tlv(4, fields.total), tlv(5, fields.vatTotal),
  ]).toString("base64");
}

app.get("/api/zatca-qr.svg", requireAuth, requireStaff, async (req, res) => {
  const q: any = req.query ?? {};
  const seller = String(q.seller ?? "").trim();
  const vat = String(q.vat ?? "").trim();
  // Without a seller name AND VAT registration number the payload is not a valid ZATCA code, so
  // refuse rather than emit a scannable-but-wrong one.
  if (!seller || !vat) return res.status(400).json({ error: "Seller name and VAT number are required for a ZATCA QR" });
  const payload = zatcaTlv({
    seller, vat,
    stamp: String(q.stamp ?? new Date().toISOString()),
    total: String(q.total ?? "0"),
    vatTotal: String(q.vatTotal ?? "0"),
  });
  try {
    const svg = await QRCode.toString(payload, { type: "svg", margin: 0, width: Number(q.size) || 120,
      errorCorrectionLevel: "M", color: { dark: "#000000", light: "#FFFFFF" } });
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-store");
    res.send(svg);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Client tells us they have paid ───────────────────────────────────
// No payment provider is connected, so the portal CANNOT take money. What it can do honestly is let
// the client declare a transfer they've made. This deliberately does NOT write a Payment row: money
// the firm hasn't seen must not enter the ledger. It raises a request staff verify, then settle with
// the existing atomic POST /api/payments/record.
app.post("/api/portal/payment-notice", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const { amount, method, reference, paidOn, invoiceNumbers, notes } = req.body ?? {};
  const amt = Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: "A positive amount is required" });

  const company = await prisma.company.findUnique({ where: { id: a.companyId }, select: { name: true } });
  const refs: string[] = Array.isArray(invoiceNumbers) ? invoiceNumbers.map(String).filter(Boolean) : [];
  const message = [
    `Client reports a payment of ${amt.toLocaleString()}`,
    `Method: ${method ? String(method) : "not stated"}`,
    reference ? `Reference: ${String(reference)}` : null,
    paidOn ? `Paid on: ${String(paidOn)}` : null,
    refs.length ? `Against invoices: ${refs.join(", ")}` : "Not allocated to a specific invoice",
    String(notes ?? "").trim() ? `Notes: ${String(notes).trim()}` : null,
    "— Verify the funds, then record it against the invoice to settle it.",
  ].filter(Boolean).join("\n");

  try {
    const created = await prisma.serviceRequest.create({
      data: { companyId: a.companyId, clientName: company?.name ?? null, type: "Payment notification",
        message, status: "open", date: "Just now", lastClientMsgAt: new Date().toISOString() },
    });
    logActivity({ type: "client", message: `Payment reported by ${company?.name ?? "a client"}: ${amt.toLocaleString()}`, user: company?.name ?? "Client" });
    notify({ rule: "Approval requested", audience: "staff",
      inApp: { type: "task", title: `Payment reported — ${company?.name ?? "client"}`, message: `${amt.toLocaleString()} · ${method ?? "method not stated"}${reference ? ` · ${reference}` : ""}` },
      subject: `Payment reported by ${company?.name ?? "a client"}`,
      heading: "A client says they have paid",
      lines: [`Amount: <b>${amt.toLocaleString()}</b>`, `Method: ${method ?? "not stated"}`, reference ? `Reference: ${reference}` : "", "Verify the funds have landed, then record the payment against the invoice to settle it."],
      cta: { label: "Open the requests queue", url: (process.env.CONSOLE_URL || "https://pro.ionob.in") + "/requests-queue" } });
    await logAudit({ action: "portal.payment.notice", actorId: a.sub, target: created.id, detail: `${amt} ${method ?? ""} ${reference ?? ""}`.trim() });
    res.status(201).json({ request: created });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** Invalidate every token this portal user holds (bumping tokenVersion). Real "sign out everywhere". */
app.post("/api/portal/sign-out-everywhere", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    await prisma.user.update({ where: { id: a.sub }, data: { tokenVersion: { increment: 1 } } });
    await logAudit({ action: "portal.signout.everywhere", actorId: a.sub, target: a.sub });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Employee offboarding ─────────────────────────────────────────────
// Split deliberately: the CLIENT requests an exit, only STAFF can complete it. A client marking
// someone exited themselves would silently stop compliance tracking on a still-live visa.
const EXIT_REASONS = ["resignation", "termination", "end_of_contract", "transfer", "other"];

/** Client-initiated. Opens ONE service request and freezes the employee's renewals immediately. */
app.post("/api/portal/employees/:id/exit-request", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  const emp = await prisma.employee.findUnique({ where: { id: req.params.id }, include: { company: { select: { name: true } } } });
  if (!emp || emp.companyId !== a.companyId) return res.status(404).json({ error: "Employee not found" });
  if (emp.archived || emp.exitStatus !== "active")
    return res.status(409).json({ error: "An exit is already in progress for this employee" });

  const { exitDate, reason, services, notes } = req.body ?? {};
  if (!exitDate) return res.status(400).json({ error: "A last working day is required" });
  const why = EXIT_REASONS.includes(String(reason)) ? String(reason) : "other";
  const picked: string[] = Array.isArray(services) ? services.map(String).filter(Boolean) : [];

  const message = [
    `Employee exit requested: ${emp.name}${emp.role ? ` (${emp.role})` : ""}`,
    `Last working day: ${exitDate}`,
    `Reason: ${why.replace(/_/g, " ")}`,
    picked.length ? `Services requested: ${picked.join(", ")}` : "Services: client asked us to advise",
    String(notes ?? "").trim() ? `Notes: ${String(notes).trim()}` : null,
  ].filter(Boolean).join("\n");

  try {
    // Atomic: the request, the status freeze, and releasing any in-flight renewal must land together.
    // If the freeze were a second call that failed, we'd have an exit on file AND a renewal running.
    const [request] = await prisma.$transaction([
      prisma.serviceRequest.create({
        data: { companyId: a.companyId, clientName: emp.company?.name ?? null, type: "Employee exit",
          message, status: "open", date: "Just now", lastClientMsgAt: new Date().toISOString() },
      }),
      prisma.employee.update({
        where: { id: emp.id },
        data: { exitStatus: "exit_requested", exitDate: String(exitDate), exitReason: why,
          history: [...(Array.isArray(emp.history) ? (emp.history as any[]) : []),
            { at: new Date().toISOString(), event: "exit_requested", by: "client",
              detail: `Last working day ${exitDate} · ${why.replace(/_/g, " ")}${picked.length ? ` · ${picked.join(", ")}` : ""}` }],
        },
      }),
      // Stop any renewal already claimed for this person — renewing the visa of someone who is
      // leaving is exactly the outcome this feature exists to prevent.
      prisma.document.updateMany({ where: { employeeId: emp.id, NOT: { renewalRunId: null } }, data: { renewalRunId: null } }),
    ]);
    await prisma.employee.update({ where: { id: emp.id }, data: { exitRequestId: request.id } });

    logActivity({ type: "client", message: `Exit requested for ${emp.name} (last day ${exitDate})`, user: emp.company?.name ?? "Client" });
    notify({ rule: "Approval requested", audience: "staff",
      inApp: { type: "task", title: `Employee exit — ${emp.name}`, message: `${emp.company?.name ?? "Client"} · last working day ${exitDate}` },
      subject: `Employee exit requested: ${emp.name}`,
      heading: "A client has requested an employee exit",
      lines: [`<b>${emp.name}</b>${emp.role ? ` (${emp.role})` : ""}`, `Client: ${emp.company?.name ?? "—"}`, `Last working day: ${exitDate}`, "Renewals for this employee have already been stopped."],
      cta: { label: "Open the requests queue", url: (process.env.CONSOLE_URL || "https://pro.ionob.in") + "/requests-queue" } });
    await logAudit({ action: "employee.exit.request", actorId: a.sub, target: emp.id, detail: `${emp.name} · ${exitDate} · ${why}` });
    res.status(201).json({ request, employee: await prisma.employee.findUnique({ where: { id: emp.id } }) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/** Staff-only. Moves the exit along: "exiting" while services run, "exited" archives the record. */
app.post("/api/employees/:id/exit", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  const stage = String((req.body ?? {}).stage ?? "");
  if (!["exiting", "exited", "cancel"].includes(stage))
    return res.status(400).json({ error: "stage must be exiting, exited or cancel" });
  if (emp.exitStatus === "active" && stage !== "exiting")
    return res.status(409).json({ error: "No exit has been requested for this employee" });

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const note = String((req.body ?? {}).note ?? "").trim();
  // "cancel" puts them back to fully active — the employee stayed, so renewals must resume.
  const data: any = stage === "cancel"
    ? { exitStatus: "active", archived: false, exitDate: null, exitReason: null, exitRequestId: null }
    : { exitStatus: stage, archived: stage === "exited" };
  data.history = [...(Array.isArray(emp.history) ? (emp.history as any[]) : []),
    { at: new Date().toISOString(), event: `exit_${stage}`, by: me?.name ?? "PRO team", detail: note || null }];

  const employee = await prisma.employee.update({ where: { id: emp.id }, data });
  if (stage === "exited" && emp.exitRequestId)
    await prisma.serviceRequest.updateMany({ where: { id: emp.exitRequestId, status: "open" }, data: { status: "resolved" } });

  logActivity({ type: "task", message: stage === "exited" ? `Exit completed: ${emp.name}` : stage === "cancel" ? `Exit cancelled: ${emp.name} stays` : `Exit in progress: ${emp.name}` });
  await logAudit({ action: `employee.exit.${stage}`, actorId: a.sub, target: emp.id, detail: `${emp.name}${note ? ` · ${note}` : ""}` });
  res.json({ employee });
});

// ── Realtime (SSE): live typing + instant message delivery ───────────
// Two steps: authenticate normally to get a short-lived ticket, then open the stream with it
// (EventSource can't set headers, and a JWT in a query string would land in access logs).
app.post("/api/stream-ticket", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  if (a.type === "portal") {
    if (!a.companyId) return res.status(403).json({ error: "No company on this account" });
    return res.json({ ticket: issueTicket({ kind: "portal", userId: a.sub, companyId: a.companyId }) });
  }
  res.json({ ticket: issueTicket({ kind: "staff", userId: a.sub }) });
});

app.get("/api/stream", (req, res) => {
  const who = redeemTicket(req.query.ticket);
  if (!who) return res.status(401).json({ error: "Invalid or expired stream ticket" });
  addClient(req, res, who);
});

/** Someone is composing. Fire-and-forget: nothing is stored, it just fans out to the other side. */
app.post("/api/service-requests/:id/typing", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const r = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: "Not found" });
  const me = await prisma.user.findUnique({ where: { id: a.sub } });
  publish("typing", { requestId: r.id, companyId: r.companyId, from: "staff", name: me?.name ?? "PRO team" });
  res.json({ ok: true });
});

app.post("/api/portal/service-requests/:id/typing", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const r = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
  if (!r || r.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
  const me = await prisma.user.findUnique({ where: { id: a.sub } });
  publish("typing", { requestId: r.id, companyId: r.companyId, from: "client", name: me?.name ?? r.clientName ?? "Client" });
  res.json({ ok: true });
});

// ── Service request threads ──────────────────────────────────────────
// Staff see everything; the portal never sees `internal` notes. That filter is enforced here rather
// than in the client, so a stray fetch can't leak an internal note.
const nowStamp = () => new Date().toISOString();

// Portal: read this request's thread (own company only, internal notes stripped) + mark it read.
app.get("/api/portal/service-requests/:id/messages", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const r = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
  if (!r || r.companyId !== a.companyId) return res.status(404).json({ error: "Not found" }); // isolation
  const msgs = await prisma.serviceRequestMessage.findMany({ where: { requestId: r.id, internal: false }, orderBy: { at: "asc" } });
  await prisma.serviceRequest.update({ where: { id: r.id }, data: { clientReadAt: nowStamp() } });
  res.json(msgs);
});

// Portal: reply. A reply to a resolved/rejected request REOPENS it — otherwise a client's follow-up
// disappears into a closed ticket that nobody looks at again.
app.post("/api/portal/service-requests/:id/messages", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const r = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!r || r.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
    const body = String(req.body?.body ?? "").trim();
    if (!body) return res.status(400).json({ error: "Message is required" });
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const at = nowStamp();
    const msg = await prisma.serviceRequestMessage.create({
      data: { requestId: r.id, authorType: "client", authorName: me?.name ?? r.clientName ?? "Client", body, internal: false, at },
    });
    const reopened = r.status !== "open";
    await prisma.serviceRequest.update({
      where: { id: r.id },
      data: { lastClientMsgAt: at, clientReadAt: at, ...(reopened ? { status: "open" } : {}) },
    });
    logActivity({ type: "client", message: `${reopened ? "Request reopened" : "Client replied"} — ${r.clientName ?? "client"} (${r.type ?? "request"})`, user: r.clientName ?? "Client" });
    logNotification({ type: "task", title: `${reopened ? "Request reopened" : "Client replied"}${r.clientName ? ` — ${r.clientName}` : ""}`, message: body.slice(0, 120) });
    // Live delivery — the console drawer appends this without polling.
    publish("message", { requestId: r.id, companyId: r.companyId, message: msg, reopened, clientName: r.clientName, type: r.type });
    res.status(201).json({ message: msg, reopened });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Staff: full thread (internal notes included) + mark read.
app.get("/api/service-requests/:id/messages", requireAuth, requireStaff, async (req, res) => {
  const msgs = await prisma.serviceRequestMessage.findMany({ where: { requestId: req.params.id }, orderBy: { at: "asc" } });
  await prisma.serviceRequest.updateMany({ where: { id: req.params.id }, data: { staffReadAt: nowStamp() } });
  res.json(msgs);
});

// Staff: reply, or leave an internal note (`internal: true` — never shown to the client).
app.post("/api/service-requests/:id/messages", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  try {
    const r = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!r) return res.status(404).json({ error: "Not found" });
    const body = String(req.body?.body ?? "").trim();
    if (!body) return res.status(400).json({ error: "Message is required" });
    const internal = !!req.body?.internal;
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const at = nowStamp();
    const msg = await prisma.serviceRequestMessage.create({
      data: { requestId: r.id, authorType: "staff", authorName: me?.name ?? "Staff", body, internal, at },
    });
    // An internal note is not a reply to the client: it must not advance the request or mark the
    // client as having unread mail.
    await prisma.serviceRequest.update({
      where: { id: r.id },
      data: { staffReadAt: at, ...(internal ? {} : { lastStaffMsgAt: at }) },
    });
    if (!internal) logActivity({ type: "client", message: `Replied to ${r.clientName ?? "client"} (${r.type ?? "request"})`, user: me?.name ?? "Staff" });
    // Live delivery. An internal note goes to STAFF ONLY — the portal must never receive it, so the
    // audience is narrowed here rather than relying on the client to hide it.
    publish("message", { requestId: r.id, companyId: r.companyId, message: msg, clientName: r.clientName, type: r.type }, { to: internal ? "staff" : "all" });
    // Email the client so a reply reaches them even if they never open the portal. Internal notes
    // are staff-only and must never be emailed out.
    if (!internal) notifyRequestReply({ companyId: r.companyId, requestType: r.type, body });
    res.status(201).json(msg);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: request a package upgrade (scoped to the authenticated client's company)
app.post("/api/portal/upgrade-requests", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { clientName, fromPackageId, toPackageId, note } = req.body ?? {};
    const created = await prisma.upgradeRequest.create({
      data: { companyId: a.companyId, clientName: clientName ?? "", fromPackageId, toPackageId, note, status: "pending", date: "Today" },
    });
    logActivity({ type: "finance", message: `${clientName || "A client"} requested a package upgrade`, user: clientName || "Client" });
    logNotification({ type: "system", title: `Upgrade request${clientName ? ` — ${clientName}` : ""}`, message: "Pending approval" });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Staff data API (authenticated staff; writes require admin/super_admin) ──
// Sales users only see the companies assigned to them.
app.get("/api/companies", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const a = (req as any).auth;
  if (a.role === "sales") {
    const u = await prisma.user.findUnique({ where: { id: a.sub } });
    const ids = Array.isArray(u?.assignedClientIds) ? (u!.assignedClientIds as string[]) : [];
    return res.json(await prisma.company.findMany({ where: { id: { in: ids } }, take: 500 }));
  }
  res.json(await prisma.company.findMany({ take: 500 })); // hard cap: this list was unbounded
});

// Create a company AND auto-provision a portal login for it (default password "client123").
app.post("/api/companies", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const vErr = validate("company", req.body, true);
  if (vErr) return res.status(400).json({ error: vErr });
  try {
    const company = await prisma.company.create({ data: req.body });
    // Only provision a portal user when there's a real email address (skip "—" placeholders).
    // The one-time password is random and returned ONCE here — it is never recoverable afterwards,
    // only re-issued via reset-portal-password.
    let portalTempPassword: string | null = null;
    const email = String(company.email || "").toLowerCase();
    if (email.includes("@")) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) {
        portalTempPassword = generateTempPassword();
        await prisma.user.create({
          data: {
            name: company.contact ?? company.name,
            email,
            roleId: "client_admin",
            status: "active",
            lastActive: "Just now",
            type: "portal",
            companyId: company.id,
            passwordHash: await hashPassword(portalTempPassword),
            mustChangePassword: true, // force the client to set their own password on first login
          },
        });
      }
    }
    logActivity({ type: "client", message: `New client onboarded: ${company.name}`, user: (req as any).auth?.email });
    logNotification({ type: "system", title: "New client added", message: company.name });
    res.status(201).json(portalTempPassword ? { ...company, portalTempPassword } : company);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Encrypted credential vault (staff): list without secret, dedicated reveal, encrypt on create
app.get("/api/credentials", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (_req, res) => {
  const creds = await prisma.siteCredential.findMany({ take: 500 }); // hard cap
  res.json(creds.map(({ password, ...rest }: any) => rest));
});
app.get("/api/credentials/:id/reveal", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (req, res) => {
  const a = (req as any).auth;
  const c = await prisma.siteCredential.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "Not found" });
  await logAudit({ action: "credential.reveal", actorId: a.sub, target: `${c.label} (${c.id})`, detail: `company ${c.companyId}`, ip: clientIp(req) });
  res.json({ password: decrypt(c.password) });
});
// Resolve a company name for credential activity lines (so they show in that client's Activity tab).
async function coName(companyId?: string | null): Promise<string> {
  if (!companyId) return "";
  try { const c = await prisma.company.findUnique({ where: { id: companyId } }); return c?.name ?? ""; } catch { return ""; }
}
app.post("/api/credentials", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { password, ...rest } = req.body ?? {};
    const created = await prisma.siteCredential.create({ data: { ...rest, password: encrypt(String(password ?? "")) } });
    const cn = await coName(created.companyId);
    logActivity({ type: "client", message: `Site credential added (${created.label})${cn ? ` for ${cn}` : ""}`, user: (req as any).auth?.email });
    await logAudit({ action: "credential.create", actorId: (req as any).auth?.sub, target: `${created.label} (${created.id})`, detail: `company ${created.companyId}`, ip: clientIp(req) });
    const { password: _p, ...safe } = created;
    res.status(201).json(safe);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.put("/api/credentials/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { password, id: _id, ...rest } = req.body ?? {};
    const data: any = { ...rest };
    // Only re-encrypt when a new password is actually provided (blank = keep existing).
    if (typeof password === "string" && password.length > 0) data.password = encrypt(password);
    const updated = await prisma.siteCredential.update({ where: { id: req.params.id }, data });
    const cn = await coName(updated.companyId);
    logActivity({ type: "client", message: `Site credential updated (${updated.label})${cn ? ` for ${cn}` : ""}`, user: (req as any).auth?.email });
    await logAudit({ action: "credential.update", actorId: (req as any).auth?.sub, target: `${updated.label} (${updated.id})`, detail: `company ${updated.companyId}`, ip: clientIp(req) });
    const { password: _p, ...safe } = updated;
    res.json(safe);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/credentials/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const c = await prisma.siteCredential.findUnique({ where: { id: req.params.id } });
    await prisma.siteCredential.delete({ where: { id: req.params.id } });
    if (c) { const cn = await coName(c.companyId); logActivity({ type: "client", message: `Site credential removed (${c.label})${cn ? ` for ${cn}` : ""}`, user: (req as any).auth?.email }); await logAudit({ action: "credential.delete", actorId: (req as any).auth?.sub, target: `${c.label} (${c.id})`, ip: clientIp(req) }); }
    res.status(204).end();
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Create a user. Two modes, both hashing the password (never stored in the clear):
//  • password provided        → active account with that password.
//  • no password ("invite")   → a random one-time temp password is generated and returned ONCE,
//                               the account is marked must-change-password. Admin / Super Admin only.
app.post("/api/users", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const { name, email, roleId, password, assignedClientIds, status, type, mustChangePassword, companyId } = req.body ?? {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
  const mail = String(email || "").trim().toLowerCase();
  if (!mail.includes("@")) return res.status(400).json({ error: "A valid email is required" });
  // Invite flow: no password supplied (or the UI explicitly asked to invite) → we generate a temp
  // password and mark the account invited. A password is only required for the direct-set flow.
  const invite = !password || status === "invited";
  const secU = await getSecurity();
  if (!invite && String(password).length < secU.minPwLen) return res.status(400).json({ error: `Password must be at least ${secU.minPwLen} characters` });
  const existing = await prisma.user.findUnique({ where: { email: mail } });
  if (existing) return res.status(409).json({ error: "A user with this email already exists" });
  const tempPassword = invite ? generateTempPassword() : null;
  try {
    const created = await prisma.user.create({
      data: {
        name: String(name).trim(),
        email: mail,
        roleId: roleId || "pro_officer",
        status: status || (invite ? "invited" : "active"),
        lastActive: invite ? null : "Just now",
        type: type === "portal" ? "portal" : "staff",
        companyId: type === "portal" ? (companyId || null) : null,
        passwordHash: await hashPassword(String(invite ? tempPassword : password)),
        assignedClientIds: assignedClientIds ?? undefined,
        mustChangePassword: invite ? (mustChangePassword !== false) : !!mustChangePassword,
      },
    });
    await logAudit({ action: "user.create", actorId: a?.sub, target: `${created.email} (${created.id})`, detail: `role ${created.roleId}${invite ? " · invite" : ""}`, ip: clientIp(req) });
    logActivity({ type: "client", message: `New team member created: ${created.name} — ${created.roleId}` });
    const { passwordHash, resetTokenHash, resetExpires, ...safe } = created as any;
    res.status(201).json({ ...safe, ...(tempPassword ? { tempPassword } : {}) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Activate / deactivate (suspend) a user. Deactivating bumps tokenVersion so any live sessions are
// invalidated immediately AND future logins are blocked (see the status gate in doLogin). Admin only.
app.put("/api/users/:id/status", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const status = String((req.body ?? {}).status || "").toLowerCase();
  if (!["active", "inactive", "suspended"].includes(status)) return res.status(400).json({ error: "status must be active, inactive or suspended" });
  if (req.params.id === a?.sub && status !== "active") return res.status(400).json({ error: "You cannot deactivate your own account" });
  try {
    const data: any = { status };
    if (status !== "active") data.tokenVersion = { increment: 1 }; // kill existing sessions
    const u = await prisma.user.update({ where: { id: req.params.id }, data });
    await logAudit({ action: "user.status", actorId: a?.sub, target: `${u.email} (${u.id})`, detail: `→ ${status}`, ip: clientIp(req) });
    const { passwordHash, resetTokenHash, resetExpires, ...safe } = u as any;
    res.json(safe);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Record a payment ATOMICALLY. The console used to POST /api/payments and then PUT the invoice to
// "paid" as two separate calls: a failure (or a closed tab) between them left money recorded against
// an invoice that still reads unpaid, or an invoice marked paid with no payment row behind it.
// Settlement is decided server-side from the sum of payments, so a part payment can't mark it paid.
app.post("/api/payments/record", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const { invoiceId, amount, method, reference, date, notes, settle } = req.body ?? {};
  const inv = invoiceId ? await prisma.invoice.findUnique({ where: { id: String(invoiceId) } }) : null;
  if (!inv) return res.status(404).json({ error: "Invoice not found" });

  const paidBefore = await prisma.payment.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
  const already = paidBefore._sum.amount ?? 0;
  // `settle: true` means "close the balance" (the Mark-paid button). The remaining amount is worked
  // out here rather than in the browser, so marking an invoice paid after a part payment records only
  // what is actually still owed instead of a second full-amount row.
  const amt = settle ? inv.amount - already : Math.round(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0)
    return res.status(400).json(settle
      ? { error: "This invoice is already settled" }
      : { error: "A positive amount is required" });
  const settled = already + amt >= inv.amount;

  try {
    const [payment] = await prisma.$transaction([
      prisma.payment.create({
        data: {
          invoiceId: inv.id, invoiceNumber: inv.number, companyId: inv.companyId, clientName: inv.clientName,
          amount: amt, method: method ? String(method) : null, reference: reference ? String(reference) : null,
          date: date ? String(date) : new Date().toISOString().slice(0, 10), notes: notes ? String(notes) : null,
        },
      }),
      // Only flip the invoice when the payments actually cover it.
      ...(settled && inv.status !== "paid"
        ? [prisma.invoice.update({ where: { id: inv.id }, data: { status: "paid" } })]
        : []),
    ]);
    if (settled) {
      logActivity({ type: "finance", message: `Invoice ${inv.number} settled${inv.clientName ? ` — ${inv.clientName}` : ""}` });
      logNotification({ type: "payment", title: `Payment received: ${inv.number}`, message: inv.clientName ?? undefined });
    }
    await logAudit({ action: "payment.record", actorId: (req as any).auth?.sub, target: `${inv.number} (${payment.id})`, detail: `amount=${amt} settled=${settled}`, ip: clientIp(req) });
    res.status(201).json({ payment, settled });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// A package that any client is subscribed to cannot be deleted — its subscriptions (and their
// billing) would dangle. Registered before the generic CRUD router so it matches first.
app.delete("/api/packages/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const inUse = await prisma.subscription.count({ where: { packageId: req.params.id } });
  if (inUse) return res.status(409).json({ error: `Cannot delete — ${inUse} client subscription${inUse === 1 ? "" : "s"} still use${inUse === 1 ? "s" : ""} this package` });
  try {
    const pkg = await prisma.package.delete({ where: { id: req.params.id } });
    await logAudit({ action: "package.delete", actorId: (req as any).auth?.sub, target: pkg.name, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Generic CRUD for the remaining entities (staff auth + write-role guard)
const entities: [string, string][] = [
  ["companies", "company"],   // list handled above; :id/POST/PUT/DELETE fall through to crud
  ["groups", "clientGroup"],
  ["packages", "package"],
  ["subscriptions", "subscription"],
  ["employees", "employee"],
  ["documents", "document"],
  ["invoices", "invoice"],
  ["users", "user"],
  ["sales-reps", "salesRep"],
  ["upgrade-requests", "upgradeRequest"],
  ["service-requests", "serviceRequest"],
  ["kanban", "kanbanCard"],
  ["activities", "activity"],
  ["notifications", "notification"],
  ["custom-fields", "customField"],
  ["document-types", "documentType"],
  ["custom-objects", "customObject"],
  ["custom-records", "customRecord"],
  ["print-layouts", "printLayout"],
  ["gov-centers", "govCenter"],
  ["appointments", "appointment"],
  ["courier-shipments", "courierShipment"],
  ["payments", "payment"],
  ["quotations", "quotation"],
  ["service-items", "serviceItem"],
];
// Role-scoped READ guards for sensitive collections (writes stay admin-only via requireWriteRole).
// Client-org data → roles that work with clients; users (teammate PII) → admins only. Everything
// else (invoices, documents, packages, employees, activities…) stays readable by any staff.
const readRole: Record<string, string[]> = {
  companies:     ["super_admin", "admin", "pro_officer", "sales"],
  groups:        ["super_admin", "admin", "pro_officer", "sales"],
  "sales-reps":  ["super_admin", "admin", "pro_officer", "sales"],
  users:         ["super_admin", "admin"],
};
// Row-level scope for the `sales` role: it may only touch its assigned clients. GET /api/companies
// filtered for sales already, but /:id and the client-owned collections did not — a scoped list with
// unscoped records is no restriction at all. `field` is the column that points at the company.
const salesScope = (field: "id" | "companyId"): ScopeFn => async (req: any) => {
  if (req.auth?.role !== "sales") return null; // every other role is gated by readRole above
  const u = await prisma.user.findUnique({ where: { id: req.auth.sub } });
  const ids = Array.isArray(u?.assignedClientIds) ? (u!.assignedClientIds as string[]) : [];
  return { [field]: { in: ids } };
};
const scopes: Record<string, ScopeFn> = {
  companies:     salesScope("id"),
  employees:     salesScope("companyId"),
  documents:     salesScope("companyId"),
  invoices:      salesScope("companyId"),
  subscriptions: salesScope("companyId"),
  quotations:    salesScope("companyId"),
  payments:      salesScope("companyId"),
  appointments:  salesScope("companyId"),
  "service-requests": salesScope("companyId"),
};
// Read-side relation includes the UI renders directly.
const includes: Record<string, Record<string, any>> = {
  subscriptions: { package: true },
};
for (const [path, modelName] of entities) {
  const guards: any[] = [requireAuth, requireStaff];
  if (readRole[path]) guards.push(requireReadRole(...readRole[path]));
  guards.push(requireWriteRole, crud(modelName, scopes[path], includes[path]));
  app.use(`/api/${path}`, ...guards);
}

// Tasks: operational staff do the day-to-day work, so PRO officers may create/update tasks
// (not just admins). Deleting a task stays admin-only. GET is open to all staff (via requireStaff).
const taskWriteGate = (req: any, res: any, next: any) => {
  const role = req.auth?.role;
  const isAdmin = role === "admin" || role === "super_admin";
  if (req.method === "GET" || isAdmin) return next();
  if (role === "pro_officer" && (req.method === "POST" || req.method === "PUT")) return next();
  return res.status(403).json({ error: "You don't have permission to modify tasks" });
};
app.use("/api/tasks", requireAuth, requireStaff, taskWriteGate, crud("task", salesScope("companyId")));

// BPM workflow engine (templates + instances + task inbox). Own auth guards per route.
app.use("/api/workflow", workflowRouter);

app.get("/api", (_req, res) => {
  res.json({
    name: "STIMES PRO API",
    auth: ["POST /api/auth/login", "POST /api/auth/portal-login", "GET /api/auth/me"],
    portal: ["GET /api/portal/me", "GET /api/portal/credentials", "GET /api/portal/credentials/:id/reveal"],
    staff: entities.map(([p]) => `/api/${p}`),
  });
});

// ── Email / SMTP configuration (Settings → Email) ───────────────────
// Kept OFF the generic settings routes below: the stored password must never be readable, so this
// endpoint returns a masked view and the generic handlers refuse the "email" key entirely.
app.get("/api/email-config", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (_req, res) => {
  const cfg = await getEmailConfig();
  const { pass, ...safe } = cfg;
  res.json({ ...safe, hasPassword: !!pass });
});

app.put("/api/email-config", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, async (req, res) => {
  try {
    const b = req.body ?? {};
    const existing = await prisma.appSetting.findUnique({ where: { key: "email" } });
    const prev = (existing?.value && typeof existing.value === "object" ? existing.value : {}) as Record<string, unknown>;
    const port = Number(b.port);
    const value: Record<string, unknown> = {
      host: String(b.host ?? "").trim(),
      port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : 587,
      secure: !!b.secure,
      user: String(b.user ?? "").trim(),
      from: String(b.from ?? "").trim(),
      enabled: b.enabled !== false,
      // An empty password field means "unchanged" — the UI never receives the secret to send back.
      pass: typeof b.pass === "string" && b.pass !== "" ? b.pass : (prev.pass ?? ""),
    };
    await prisma.appSetting.upsert({ where: { key: "email" }, update: { value: value as any }, create: { key: "email", value: value as any } });
    await logAudit({
      action: "settings.email_update", actorId: (req as any).auth?.sub, target: value.host as string,
      detail: `port=${value.port} secure=${value.secure} user=${value.user || "(none)"} enabled=${value.enabled}`, ip: clientIp(req),
    });
    const { pass, ...safe } = await getEmailConfig();
    res.json({ ...safe, hasPassword: !!pass });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Verify the SMTP connection (no mail sent), or send a real test message to `to`.
app.post("/api/email-config/test", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, async (req, res) => {
  const to = String(req.body?.to ?? "").trim();
  const v = await verifyEmail();
  if (!v.ok) return res.status(400).json({ error: v.error || "Could not connect to the mail server" });
  if (!to) return res.json({ ok: true, verified: true, sent: false });
  try {
    const r = await sendMail({
      to,
      subject: "STIMES PRO — test email",
      text: "This is a test message from STIMES PRO. Your email settings are working.",
      html: "<p>This is a test message from <b>STIMES PRO</b>.</p><p>Your email settings are working.</p>",
    });
    await logAudit({ action: "settings.email_test", actorId: (req as any).auth?.sub, target: to, ip: clientIp(req) });
    return res.json({ ok: true, verified: true, sent: r.sent });
  } catch (e: any) { return res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Org-wide settings (console Settings → General etc.) — one JSON row per area, keyed ("org", …).
// Readable by any staff; writes gated by the role matrix like every other admin write.
const SETTINGS_PROTECTED = new Set(["email"]); // has secrets — use /api/email-config instead
app.get("/api/settings/:key", requireAuth, requireStaff, async (req, res) => {
  if (SETTINGS_PROTECTED.has(req.params.key)) return res.status(403).json({ error: "Use /api/email-config" });
  const row = await prisma.appSetting.findUnique({ where: { key: req.params.key } });
  res.json(row?.value ?? {});
});
app.put("/api/settings/:key", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  if (SETTINGS_PROTECTED.has(req.params.key)) return res.status(403).json({ error: "Use /api/email-config" });
  try {
    const value = req.body ?? {};
    const row = await prisma.appSetting.upsert({
      where: { key: req.params.key },
      update: { value },
      create: { key: req.params.key, value },
    });
    await logAudit({ action: "settings.update", actorId: (req as any).auth?.sub, target: req.params.key, detail: JSON.stringify(value).slice(0, 400) });
    res.json(row.value);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── File uploads (logos, document scans, attachments) ──
// Files land in server/uploads-files and are served publicly at /files/<name>. The client sends
// base64 JSON (no multipart dependency); size is capped by the 6mb JSON body limit.
const FILES_DIR = path.resolve(process.cwd(), "uploads-files");
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
// User-uploaded files are served on the API origin. Neutralize active content: a per-response CSP
// blocks all sub-resource loads + sandboxes the document, and nosniff stops content-type guessing.
// SVGs still render inside <img> (scripts never execute there); a direct hit can't run script or
// exfiltrate. HTML/XML/SVG are additionally forced to download rather than render inline.
app.use("/files", express.static(FILES_DIR, {
  maxAge: "1h",
  setHeaders: (res, filePath) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    if (/\.(svg|html?|xml|xhtml)$/i.test(filePath)) res.setHeader("Content-Disposition", "attachment");
  },
}));
// Staff upload anything; a PORTAL client may upload too, but only its own document scans — the
// kind is forced so a client can't overwrite branding assets like the org logo.
app.post("/api/upload", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const { name, data } = req.body ?? {};
  const kind = a?.type === "portal" ? "document" : (req.body ?? {}).kind;
  if (!data || typeof data !== "string") return res.status(400).json({ error: "data (base64) is required" });
  // Only these types are stored. A name with any OTHER extension is rejected rather than silently
  // renamed — it used to fall back to ".png", so a client's .txt/.docx attachment was written as a
  // PNG and could never be opened again.
  const named = String(name || "").trim();
  const extMatch = named ? named.match(/\.(png|jpe?g|svg|webp|pdf)$/i) : null;
  if (named && !extMatch) return res.status(400).json({ error: "Only PNG, JPG, SVG, WEBP or PDF files can be uploaded" });
  const safeExt = (extMatch ? extMatch[0] : ".png").toLowerCase();
  const buf = Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64");
  if (!buf.length || buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: "File must be under 4 MB" });
  const fname = `${(kind || "file").replace(/[^a-z0-9-]/gi, "")}-${Date.now()}${safeExt}`;
  fs.writeFileSync(path.join(FILES_DIR, fname), buf);
  const asset = await prisma.fileAsset.create({
    data: { kind: String(kind || "file"), name: String(name || fname), path: "/files/" + fname, size: buf.length, uploadedBy: a?.sub ?? null, at: new Date().toISOString() },
  });
  await logAudit({ action: "file.upload", actorId: a?.sub, target: asset.path, detail: `${asset.kind} · ${buf.length}b`, ip: clientIp(req) });
  res.status(201).json({ id: asset.id, path: asset.path, name: asset.name });
});

// ── API keys: list (safe fields), create (full key returned ONCE), revoke ──
app.get("/api/api-keys", requireAuth, requireStaff, async (_req, res) => {
  const rows = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: k.revoked })));
});
app.post("/api/api-keys", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const name = String((req.body ?? {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Key name is required" });
  const raw = "sk_" + crypto.randomBytes(24).toString("base64url");
  const row = await prisma.apiKey.create({
    data: { name, prefix: raw.slice(0, 10) + "…", keyHash: crypto.createHash("sha256").update(raw).digest("hex"), createdAt: new Date().toISOString() },
  });
  await logAudit({ action: "apikey.create", actorId: a?.sub, target: `${name} (${row.id})`, ip: clientIp(req) });
  res.status(201).json({ id: row.id, name: row.name, prefix: row.prefix, key: raw }); // raw key: shown once, never stored
});
app.delete("/api/api-keys/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  try {
    const row = await prisma.apiKey.update({ where: { id: req.params.id }, data: { revoked: true } });
    await logAudit({ action: "apikey.revoke", actorId: a?.sub, target: `${row.name} (${row.id})`, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Sign out everywhere: bump tokenVersion (invalidates every issued JWT) and re-issue THIS session's.
app.post("/api/auth/logout-all", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const u = await prisma.user.update({ where: { id: a.sub }, data: { tokenVersion: { increment: 1 } } });
  await logAudit({ action: "auth.logout_all", actorId: u.id, actorEmail: u.email, ip: clientIp(req) });
  const token = signToken(u.type === "staff"
    ? { sub: u.id, type: "staff", role: u.roleId, tv: u.tokenVersion }
    : { sub: u.id, type: "portal", companyId: u.companyId!, tv: u.tokenVersion });
  res.json({ ok: true, token });
});

const port = Number(process.env.PORT) || 4100;
// Manual/external tick — lets you run the jobs on demand, or point a real cron at this endpoint if
// you'd rather schedule outside the process (and must, if you ever run more than one instance).
app.post("/api/cron/tick", requireAuth, requireStaff, requireWriteRole, async (_req, res) => {
  try { res.json(await runTick("manual")); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.listen(port, () => {
  console.log(`STIMES PRO API (auth enabled) → http://localhost:${port}`);
  // The heartbeat. Single-instance only: if this is ever scaled out, disable it and drive
  // /api/cron/tick from one external scheduler instead, or every instance will tick.
  startScheduler();
});
