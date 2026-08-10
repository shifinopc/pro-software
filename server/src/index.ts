import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { crud, withLiveCounts, type ScopeFn } from "./crud.js";
import { startScheduler, runTick } from "./scheduler.js";
import { workflowRouter } from "./workflow.js";
import { validate, LIFECYCLES, ACTIVE_CLIENT, NON_CLIENT, contactProblem, billingAmountProblem } from "./validate.js";
import { addContact, editContact, setPrimaryContact, removeContact, syncPrimaryContact } from "./contacts.js";
import { stagesFor, validateStages, boardFor, withMoney, statusOf, applyStageFollowUp, openDealFor, dealForAddonRequest, closeAddonDeal, recordTransition, stageAnalytics } from "./pipeline.js";
import { crmDashboard } from "./crmdashboard.js";
import { recordLifecycle, lifecycleAnalytics, campaignPerformance } from "./lifecycle.js";
import { openFollowUps, historyFor, logInteraction, closeFollowUp, lastContactMap, activityFeed, activityCounts, rescheduleFollowUp, cancelFollowUp, followUpCompletion, KIND_LABEL, dayOf } from "./interactions.js";
import { salesReport, periodsWithActivity, periodRange, currentPeriod } from "./salesreport.js";
import { opsReport, opsPeriodsWithActivity } from "./opsreport.js";
import { setupCheck } from "./setupcheck.js";
import { salesRules } from "./salesrules.js";
import { findDuplicates } from "./duplicates.js";
import { nextOwner, nextOwnerFor, rotation, distributeUnowned, assignableOwners, recordAssignment, assignmentHistory } from "./assignment.js";
import { routeFor } from "./routing.js";
import { scoreOpenLeads } from "./leadscore.js";
import { freeSlots, bookSlot } from "./booking.js";
import { visibleUserIds, actableTeamIds } from "./visibility.js";
import { teamViews, teamHistory, addMember, removeMember, setLead, personProblem, todayDay, TEAM_KINDS } from "./teams.js";
import { itemsForStage, effectiveItems, blockersFor, summaryFor } from "./dealchecklist.js";
import { syncMailbox, saveConnection } from "./mailbox.js";
import { authorizeUrl, exchangeCode, providerConfigured, providerFor } from "./mailproviders.js";

/**
 * The OAuth `state`, signed.
 *
 * It carries WHO is connecting. Unsigned, anybody who could reach the callback could attach their
 * own mailbox to somebody else's account — or worse, attach a colleague's mailbox to their own and
 * read it through the CRM. Signed with the same JWT secret and short-lived, because the round trip
 * to a provider and back is measured in seconds.
 */
function signState(payload: { sub: string; provider: "google" | "microsoft" }): string {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", process.env.JWT_SECRET || "dev").update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyState(raw: string): { sub: string; provider: "google" | "microsoft" } | null {
  const [body, sig] = String(raw).split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", process.env.JWT_SECRET || "dev").update(body).digest("base64url");
  // Constant-time: a signature check that returns early leaks how much of it was right.
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const j = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!j.sub || (Date.now() - Number(j.t)) > 10 * 60 * 1000) return null;
    return { sub: String(j.sub), provider: j.provider === "microsoft" ? "microsoft" : "google" };
  } catch { return null; }
}
import { bookingPage } from "./bookingpage.js";
import { siteForKey, receiveEnquiry } from "./webintake.js";
import { prisma } from "./db.js";
import { sendMail, getEmailConfig, verifyEmail, mailHealth } from "./mailer.js";
import { renderEmail, emailContext, orgName, esc as escEmail } from "./emailshell.js";
import { sendInvitation, type InviteResult } from "./invitations.js";
import { addClient, issueTicket, redeemTicket, publish, connectionCount } from "./realtime.js";
import { notify, notifyNewServiceRequest, notifyRequestReply, notifyInvoiceRaised, notifyAddonApproved, notifyAddonRemoved, notifyRequestRejected } from "./notify.js";
import { startDeliveryForQuotation, acceptServiceRequest, previewAcceptServiceRequest } from "./delivery.js";
import { getSequences, saveSequences, nextNumber, SEQ_KINDS, SEQ_LABEL } from "./sequence.js";
import { unmetPrereqs, PREREQ_ATTRS, ATTR_LABEL } from "./jobs.js";
import { COUNTRIES, countryName, countryCurrency } from "./countries.js";
import { workforceAll, workforceFor, recordBand, workforceHistory } from "./workforce.js";
import { listPacks, readPack, savePack, planInstall, applyInstall, installedPacks, planUninstall, applyUninstall, planUpgrade, applyUpgrade } from "./packs.js";
import { homeCountry, homeCurrency, homeMarket } from "./orgsettings.js";
import { figuresFromAmount } from "./money.js";
import {
  hashPassword, verifyPassword, signToken, verifyToken,
  requireAuth, requireStaff, requirePortal, requireWriteRole, requireReadRole, requireHuman, generateTempPassword,
  encrypt, decrypt, logAudit, logActivity, logNotification, clientIp,
} from "./auth.js";

const app = express();
app.set("trust proxy", 1); // behind a reverse proxy in prod → correct client IPs + rate limiting
app.use(helmet({ contentSecurityPolicy: false })); // security headers incl. HSTS (API is JSON-only)

// Throttle auth endpoints to blunt brute-force (per IP).
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: "Too many attempts — try again later" } });
// Generous but bounded: a broken screen can fire several reports in a row, a bot should not.
const reportLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many reports — try again later" } });
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests — try again later" } });
/**
 * Resending an invitation is NOT the same risk as the reset flow above, and must not share its cap.
 *
 * `resetLimiter` throttles an UNAUTHENTICATED endpoint anybody can hit, so five an hour is right
 * there. Resending is authenticated, role-gated, audited, and can only ever mail an address already
 * on a user record — and it is counted per IP, so a whole office behind one connection shares the
 * allowance. At five an hour, onboarding six clients in a morning fails on the sixth with a message
 * about "too many requests" that names nothing the admin did wrong. Thirty leaves the abuse ceiling
 * low while putting it far above any honest day's work.
 */
const inviteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: "Too many invitations sent from here in the last hour — try again shortly" } });

// Allow the console + portal origins (local dev and live). Override with CORS_ORIGINS in .env
// (comma-separated). Requests with no Origin (curl, server-to-server) are always allowed.
const DEFAULT_ORIGINS = [
  "http://localhost:5188", "http://localhost:5173", "http://127.0.0.1:5188",
  "https://pro.ionob.in", "https://cp.ionob.in",
];
const allowedOrigins = (process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map(s => s.trim()).filter(Boolean)
  : DEFAULT_ORIGINS);
/**
 * SAME-ORIGIN IS ALWAYS ALLOWED, and has to be said explicitly.
 *
 * CORS exists to police CROSS-origin requests. But this API also serves a page of its own — the
 * public booking page at /book/:slug — and that page's fetches carry `Origin: <this server>`, which
 * was not on the allowlist. The result was a booking page that rendered its slots (the GET was a
 * plain navigation-adjacent request) and then failed silently on submit with "Could not reach us".
 *
 * It passed every curl test, because curl sends no Origin header at all and the first branch below
 * waves those through. Only driving a real browser surfaced it — which is the argument for doing
 * that rather than trusting a 201 from the command line.
 *
 * Comparing against the request's own Host rather than adding a hardcoded origin keeps this correct
 * on every deployment without anybody remembering to add one more entry to a list.
 */
// The per-request form, because deciding this needs the request: same-origin is recognised by
// comparing the Origin against the Host it arrived on, not by keeping one more hostname in a list
// that somebody has to remember to update per deployment.
app.use(cors((req, cb) => {
  const origin = req.headers.origin;
  const host = req.headers.host;
  const sameOrigin = !!origin && !!host && (origin === `http://${host}` || origin === `https://${host}`);
  if (!origin || sameOrigin || allowedOrigins.includes(origin)) return cb(null, { origin: true, credentials: true });
  cb(new Error(`Origin ${origin} not allowed by CORS`));
}));
/**
 * A website enquiry form becomes a lead.
 *
 * PUBLIC. The only route in the product that writes without a session, so it is deliberately narrow:
 * see webintake.ts for what it can and cannot create. Everything here is the guard rail.
 *
 * Two limiters, because they fail differently. The per-address one stops one machine flooding it;
 * the per-key one stops a leaked key being used from a thousand addresses, which the first cannot
 * see. A real enquiry form sends one request every few minutes at most, so both are generous.
 *
 * The body cap is separate from the app-wide 6mb: nothing here needs more than a few kilobytes, and
 * accepting megabytes on an unauthenticated route is an invitation.
 */
const intakeByIp = rateLimit({
  windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many submissions — try again shortly" },
});
const intakeByKey = rateLimit({
  windowMs: 60 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => String(req.header("x-api-key") ?? "no-key"),
  message: { error: "Too many submissions for this site — try again later" },
});

app.post("/api/public/enquiry", intakeByIp, intakeByKey, express.json({ limit: "32kb" }), async (req, res) => {
  const site = await siteForKey(req.header("x-api-key"));
  // One message for missing, unknown and revoked alike. Distinguishing them tells somebody probing
  // keys which of their guesses used to be real.
  if (!site) return res.status(401).json({ error: "Not authorised" });

  try {
    const out = await receiveEnquiry(req.body, { keyName: site.name, homeCountry: (await homeCountry()) });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    // The caller is a website, not a member of staff: it is told the enquiry was received and
    // nothing else. Whether it became a new lead or joined an existing one is internal, and saying
    // so would let anybody with the key test which addresses are already on file.
    return res.status(202).json({ ok: true, message: "Thank you — we have received your enquiry." });
  } catch (e: any) {
    console.error("[intake] failed:", e?.message ?? e);
    return res.status(500).json({ error: "Could not record that enquiry" });
  }
});

app.use(express.json({ limit: '6mb' })); // raised for base64 logo/file uploads

// ── Public ──
// Opening the API's own port in a browser is a thing people do when something is not working, and
// Express's default "Cannot GET /" answers the wrong question — it looks like a broken deployment
// rather than an API with no front page. This says what is listening and where the real one is.
// Exact path only, so it shadows nothing.
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `STIMES PRO API — this port serves the API only.\n\n` +
    `  health   /api/health\n` +
    `  console  ${process.env.CONSOLE_URL || "http://localhost:5188"}\n`
  );
});

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "connected" });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// The country list the pickers are built from. Served rather than duplicated in the front end: a
// second copy is how the console offers a country the server does not recognise. Static reference
// data, so it needs no auth and no database.
app.get("/api/countries", (_req, res) => {
  res.json(COUNTRIES);
});

// ── Country packs ────────────────────────────────────────────────────────────
// Installable configuration for a market: document types, workflows, services, authorities. Reading
// the list and previewing are safe; applying rewrites configuration, so it takes the same write role
// as any other admin change.
app.get("/api/packs", requireAuth, requireStaff, (_req, res) => {
  res.json({ packs: listPacks(), installed: null });
});
app.get("/api/packs/installed", requireAuth, requireStaff, async (_req, res) => {
  res.json(await installedPacks());
});
// Preview. Runs exactly the planner the install runs, so what this returns is what will happen —
// a preview computed a second way is a preview that can be wrong.
app.post("/api/packs/preview", requireAuth, requireStaff, async (req, res) => {
  try {
    res.json(await planInstall(readPack(String(req.body?.file ?? ""))));
  } catch (e: any) {
    res.status(400).json({ error: `Could not read that pack — ${e?.message ?? e}` });
  }
});
// ── Workforce nationalisation (Saudization / Emiratisation / …) ──────────────
//
// Reading is a plain staff permission: this is a count of records the reader can already see. The
// band is a WRITE — somebody is asserting what an official portal said — so it takes the write role
// and is recorded in the audit log with who said it and when.
app.get("/api/workforce", requireAuth, requireStaff, async (_req, res) => {
  res.json(await workforceAll());
});
/**
 * The recorded trend. Registered BEFORE /:companyId, or "history" would be read as a client id.
 *
 * Every client's series in one request: the Clients list shows a direction beside each band, and
 * one call per row would be a request per client on every render.
 */
app.get("/api/workforce-history", requireAuth, requireStaff, async (req, res) => {
  const days = Math.max(2, Math.min(730, Number(req.query.days) || 90));
  const id = String(req.query.companyId ?? "").trim();
  if (id) return res.json(await workforceHistory(id, days));
  const ids = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true } });
  const out: Record<string, any> = {};
  for (const c of ids) out[c.id] = await workforceHistory(c.id, days);
  res.json(out);
});

app.get("/api/workforce/:companyId", requireAuth, requireStaff, async (req, res) => {
  const w = await workforceFor(String(req.params.companyId));
  if (!w) return res.status(404).json({ error: "No such client" });
  res.json(w);
});
app.put("/api/workforce/:companyId/band", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  try {
    const band = String(req.body?.band ?? "").trim();
    // Dated by the reader, not by the clock: a band read on the portal last Tuesday is a fact about
    // last Tuesday, and stamping it "now" would overstate how fresh it is.
    const at = String(req.body?.at ?? "").trim() || new Date().toISOString().slice(0, 10);
    const out = await recordBand(String(req.params.companyId), band, at, req.body?.note ?? null);
    await logAudit({
      action: band ? "workforce.band_recorded" : "workforce.band_cleared",
      actorId: a?.sub, target: out?.companyName ?? String(req.params.companyId),
      detail: band ? `${band} as at ${at} · ratio then ${(out?.bandRatioBp ?? 0) / 100}%` : "cleared",
    });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

// Receive a new version of a country's configuration. This is the route by which an update reaches
// an installation at all — without it, publishing a corrected fee would mean a redeploy. Admin-only
// and audited: it changes what every future install and upgrade on this server will do.
app.post("/api/packs/upload", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  try {
    const out = savePack(req.body?.pack);
    await logAudit({
      action: "pack.upload", actorId: a?.sub, target: `${out.country} ${out.version}`,
      detail: out.replaced ? `${out.file} (replaced an existing file)` : out.file,
    });
    logActivity({ type: "system", message: `Country pack available: ${out.country} ${out.version}`, user: a?.email });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

/**
 * Which installed countries have a newer pack sitting on this server.
 *
 * Computed here rather than in the console so the answer is the same everywhere it is shown — a
 * badge that disagrees with the button it points at is worse than no badge.
 */
app.get("/api/packs/updates", requireAuth, requireStaff, async (_req, res) => {
  const installed = await installedPacks();
  const available = listPacks().filter(p => !p.error);
  const out: Record<string, { from: string; to: string; file: string }> = {};
  for (const [country, inst] of Object.entries(installed)) {
    const newer = available
      .filter(p => String(p.country).toUpperCase() === country)
      // Numeric compare, so 2026.10 counts as newer than 2026.2 rather than sorting as text.
      .filter(p => String(p.version).localeCompare(inst.version, undefined, { numeric: true }) > 0)
      .sort((x, y) => String(y.version).localeCompare(String(x.version), undefined, { numeric: true }))[0];
    if (newer) out[country] = { from: inst.version, to: newer.version, file: newer.file };
  }
  res.json(out);
});

// Upgrade preview — read-only, and the same planner the upgrade runs.
app.post("/api/packs/upgrade-preview", requireAuth, requireStaff, async (req, res) => {
  try { res.json(await planUpgrade(readPack(String(req.body?.file ?? "")))); }
  catch (e: any) { res.status(400).json({ error: `Could not read that pack — ${e?.message ?? e}` }); }
});
// Moving an installed market to a newer pack. This can delete rows the new version dropped, so it
// carries the same admin-only guard as uninstall rather than the lighter one install has.
app.post("/api/packs/upgrade", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  try {
    const pack = readPack(String(req.body?.file ?? ""));
    const out = await applyUpgrade(pack);
    const detail = `${out.added} added · ${out.updated} updated · ${out.revived} revived · ${out.yours} left as yours · ${out.removed} removed · ${out.retired} retired`;
    await logAudit({ action: "pack.upgrade", actorId: a?.sub, target: `${pack.country} → ${pack.version}`, detail });
    logActivity({ type: "system", message: `Country pack upgraded: ${pack.countryName} → ${pack.version} — ${detail}`, user: a?.email });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});
// Uninstall preview — read-only, and the same planner the uninstall runs.
app.post("/api/packs/uninstall-preview", requireAuth, requireStaff, async (req, res) => {
  try { res.json(await planUninstall(String(req.body?.country ?? ""))); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
// The only route here that deletes anything. Admin-only on top of the write role: removing a market's
// configuration is not an everyday change, and the plan has to be seen before it runs.
app.post("/api/packs/uninstall", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  try {
    const country = String(req.body?.country ?? "");
    const out = await applyUninstall(country);
    await logAudit({
      action: "pack.uninstall", actorId: a?.sub, target: country,
      detail: `${out.removed} removed · ${out.retired} retired · ${out.kept} kept`,
    });
    logActivity({ type: "system", message: `Country pack uninstalled: ${country} — ${out.removed} removed, ${out.retired} retired`, user: a?.email });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/packs/install", requireAuth, requireStaff, requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  try {
    const pack = readPack(String(req.body?.file ?? ""));
    // Adoption stamps rows somebody built by hand. It is never inferred — the console asks, and the
    // answer travels here explicitly.
    const out = await applyInstall(pack, { adopt: req.body?.adopt === true });
    await logAudit({
      action: "pack.install", actorId: a?.sub, target: `${pack.country} ${pack.version}`,
      detail: `${out.created} created · ${out.adopted} adopted${out.unresolved.length ? ` · ${out.unresolved.length} unresolved` : ""}`,
    });
    logActivity({ type: "system", message: `Country pack installed: ${pack.countryName} ${pack.version}`, user: a?.email });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message ?? e) });
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

  // A portal user whose client is suspended is refused at the door, with the REASON. Bouncing them
  // after a successful sign-in with a generic "account inactive" would leave them guessing at a
  // password problem; the credentials were right and the account is fine — the client is suspended.
  // Checked here as well as in requireAuth because a token must not be issued at all in that state.
  if (kind === "portal" && user!.companyId) {
    const co = await prisma.company.findUnique({ where: { id: user!.companyId }, select: { name: true, status: true, suspendedReason: true, lifecycle: true } });
    if (co?.status === "suspended") {
      await logAudit({ action: "login.blocked", actorId: user!.id, actorEmail: user!.email, ip, detail: `client suspended: ${co.name}` });
      return res.status(403).json({
        error: "Access to this account is suspended. Please contact us to restore it.",
        suspended: true, reason: co.suspendedReason ?? null,
      });
    }
    // Same rule as requireAuth, applied before a token exists: the portal belongs to clients.
    if (co && co.lifecycle !== ACTIVE_CLIENT) {
      await logAudit({ action: "login.blocked", actorId: user!.id, actorEmail: user!.email, ip, detail: `not a client: ${co.name} (${co.lifecycle})` });
      return res.status(403).json({ error: "This portal is no longer active. Please contact us.", suspended: true, reason: null });
    }
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
  // notifReadAt: the console bell compares each notification's createdAt against this watermark.
  res.json({ id: user.id, name: user.name, email: user.email, role: user.roleId, type: user.type, companyId: user.companyId, phone: user.phone ?? null, notifReadAt: user.notifReadAt ?? null });
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
    const ctxReset = await emailContext();
    const orgReset = ctxReset.org;
    const { html, text } = renderEmail(ctxReset, {
      heading: "Reset your password",
      preheader: "The link is valid for one hour.",
      lines: [
        `We received a request to reset the password for <b>${escEmail(user.email)}</b>.`,
        "Use the button below within the next hour. After that the link stops working and you will need to ask for a new one.",
      ],
      cta: { label: "Reset your password", url: link },
      note: "If you didn't ask for this, no action is needed — your password has not changed, and this link can only be used once.",
    });
    await sendMail({ to: user.email, subject: `Reset your ${orgReset} password`, text, html });
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
    // A DRAFT invoice is unreleased — the billing job raises drafts for a human to check, and staff
    // can still edit or delete one. It must never reach the client, so it is excluded at the SOURCE:
    // that covers every portal screen at once instead of relying on each list to remember. Voided
    // invoices ARE sent — a client should see that a bill they were shown has been cancelled — but
    // they are never payable.
    include: { group: true, employeeList: { where: { archived: false } }, documents: true, invoices: { where: { NOT: { status: "draft" } } } },
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
      documents: await prisma.document.count({ where: { companyId: c.id, supersededAt: null } }),
      overdue: await prisma.document.count({ where: { companyId: c.id, status: "overdue", supersededAt: null } }),
      expiring: await prisma.document.count({ where: { companyId: c.id, status: "expiring", supersededAt: null } }),
    },
  })));
  // Org-wide display currency (Settings → General) so the portal renders money in the same unit.
  const orgRow = await prisma.appSetting.findUnique({ where: { key: "org" } }).catch(() => null);
  const orgCurrency = String(((orgRow?.value as any)?.currency) || "SAR — Saudi Riyal").split(" ")[0];
  // The portal used to name a fictional officer ("Rashid Al Mansoori") as the client's PRO contact.
  // There is no per-client officer in the model, so the honest label is the provider's own name.
  const orgName = String(((orgRow?.value as any)?.orgName) || "your PRO team");
  // Support phone shown in the portal. Blank means the portal hides the Call button rather than
  // printing a number nobody answers — it used to show a hardcoded +971 4 552 8190.
  const orgPhone = String(((orgRow?.value as any)?.phone) || "").trim();
  // Profile → Timezone displayed a literal "GMT+4 · Dubai" to every client, while the org is
  // configured for Riyadh. It is a read-only field, so it should read the real setting.
  const orgTimezone = String(((orgRow?.value as any)?.timezone) || "").trim();
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
    // From the stored total, not `amount`: that column is whole riyals and cannot hold halala, so an
    // invoice of 287.50 reported 288 outstanding — the client was shown, and asked to pay, half a
    // riyal more than the invoice says. Falls back to `amount` only for rows issued before the
    // minor-unit columns existed.
    const total = inv.totalMinor != null ? inv.totalMinor / 100 : inv.amount;
    return { ...inv, paidAmount, outstandingAmount: Math.max(0, total - paidAmount) };
  });
  // Same stale-counter problem as the console: company.employees / overdue / expiring are stored
  // columns nobody recomputes. The client sees their own compliance here, so it has to be counted.
  const _liveEmp = company.employeeList.length;
  const _left = (d: { expiryDate: string | null }): number | null => { const t = d.expiryDate ? new Date(d.expiryDate).getTime() : NaN; return isNaN(t) ? null : Math.ceil((t - Date.now()) / 86_400_000); };
  const _liveOvd = company.documents.filter(d => { const n = _left(d); return d.status === "overdue" || (n != null && n < 0); }).length;
  const _liveExp = company.documents.filter(d => { const n = _left(d); return d.status !== "overdue" && n != null && n >= 0 && n <= 30; }).length;
  res.json({
    company: { ...company, employees: _liveEmp, overdue: _liveOvd, expiring: _liveExp, invoices, subscriptions }, groupCompanies, orgCurrency, orgName, orgPhone, orgTimezone,
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
    include: { group: true, employeeList: { where: { archived: false } }, documents: true, invoices: { where: { NOT: { status: "draft" } } } },
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
  const homeCur = await homeCurrency();
  const money = (c: any) => `${c.currency || homeCur} ${Number(c.amount).toLocaleString()}`;
  const [docs, reqs, invs, addonReqs] = await Promise.all([
    prisma.document.findMany({ where: { companyId: a.companyId, supersededAt: null, NOT: { expiryDate: null } } }),
    prisma.serviceRequest.findMany({ where: { companyId: a.companyId } }),
    // A DRAFT invoice has not been released to the client yet — the billing job raises drafts for a
    // human to check first, so announcing one asks the client to pay a bill nobody has approved.
    // Voided invoices are gone as far as they are concerned.
    prisma.invoice.findMany({ where: { companyId: a.companyId, NOT: { status: { in: ["draft", "void"] } } } }),
    prisma.upgradeRequest.findMany({ where: { companyId: a.companyId, kind: "addon", status: { in: ["approved", "rejected"] } } }),
  ]);
  const out: any[] = [];
  for (const d of docs) {
    const t = new Date(d.expiryDate as string).getTime(); if (isNaN(t)) continue;
    const days = Math.round((t - now) / 86400000);
    const docKey = new Date(t).toISOString(); // stable: derived from the expiry, not the clock
    if (days < 0) out.push({ id: "doc-" + d.id, kind: "alert", title: `${d.docType} — ${d.person} is overdue`, meta: `Compliance · ${Math.abs(days)}d overdue`, ts: nowISO, readTs: docKey, unread: true, cta: "Renew" });
    else if (days <= 30) out.push({ id: "doc-" + d.id, kind: "refresh", title: `Renewal reminder: ${d.docType} — ${d.person}`, meta: `Compliance · ${days} days left`, ts: nowISO, readTs: docKey, unread: true, cta: "Renew" });
    // A completed renewal was invisible here. These notices are derived from the client's own
    // records, and a renewal changes state without leaving anything for the expiry branches above
    // to notice — the client was told the renewal had STARTED and never that it finished. The
    // document's own history is the evidence, so it is read directly.
    const hist = Array.isArray((d as any).history) ? (d as any).history as any[] : [];
    const last = hist.length ? hist[hist.length - 1] : null;
    if (last && last.at) {
      const ago = (now - new Date(String(last.at)).getTime()) / 86400000;
      if (ago >= 0 && ago <= 30) out.push({ id: "docren-" + d.id, kind: "check", title: `${d.docType} — ${d.person} has been renewed`, meta: `Compliance · new expiry ${d.expiryDate || "—"}`, ts: String(last.at), key: String(last.at) });
    }
  }
  for (const r of reqs) {
    if (r.lastStaffMsgAt && String(r.lastStaffMsgAt) > String(r.clientReadAt || "")) out.push({ id: "req-" + r.id, kind: "check", title: `New reply on ${r.type || "your request"}`, meta: `Support · from your PRO team`, ts: r.lastStaffMsgAt, unread: true, cta: false });
    // Acceptance had no branch here, so the one status the client most wants to see — someone has
    // picked this up — arrived only by email, and there is no SMTP configured. Now it shows.
    else if (r.status === "accepted") out.push({ id: "req-" + r.id, kind: "refresh", title: `${r.type || "Request"} — we've started work`, meta: `Support · accepted${r.acceptedAt ? ` ${String(r.acceptedAt).slice(0, 10)}` : ""}`, ts: r.acceptedAt || r.date || nowISO, unread: true, cta: false });
    else if (r.status === "resolved") out.push({ id: "req-" + r.id, kind: "check", title: `${r.type || "Request"} resolved`, meta: `Support · ${r.date || ""}`, ts: r.lastStaffMsgAt || r.date || nowISO, unread: false, cta: false });
    // Carry the reason. "Needs your attention" with nothing attached is the silence this replaces.
    else if (r.status === "rejected") out.push({ id: "req-" + r.id, kind: "alert", title: `${r.type || "Request"} could not be processed`, meta: `Support · ${r.rejectedReason || r.date || ""}`, ts: r.date || nowISO, unread: true, cta: false });
  }
  for (const inv of invs) {
    if (inv.status !== "paid") out.push({ id: "inv-" + inv.id, kind: "invoice", title: `Invoice ${inv.number} issued — ${money(inv)}`, meta: `Billing${inv.dueDate ? ` · due ${inv.dueDate}` : ""}`, ts: inv.date || nowISO, unread: true, cta: "Pay" });
    else out.push({ id: "inv-" + inv.id, kind: "check", title: `Payment received — ${money(inv)}`, meta: `${inv.number}${inv.date ? ` · ${inv.date}` : ""}`, ts: inv.date || nowISO, unread: false, cta: false });
  }
  // The decision on an add-on the client asked for. Without this the catalog card just quietly
  // changes state and nobody is told either way.
  for (const r of addonReqs) {
    const nm = r.serviceName || "the service";
    if (r.status === "approved") {
      out.push({ id: "adn-" + r.id, kind: "check", title: `${nm} was added to your plan`, meta: r.quotedPrice ? `Add-on · one-off SAR ${Number(r.quotedPrice).toLocaleString()}` : "Add-on · no charge", ts: r.date || nowISO, unread: true, cta: false });
    } else {
      out.push({ id: "adn-" + r.id, kind: "alert", title: `We could not add ${nm} to your plan`, meta: "Add-on · talk to your PRO team", ts: r.date || nowISO, unread: true, cta: false });
    }
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

/**
 * Staff bell: mark everything read by moving THIS user's watermark.
 * Deliberately not `notification.read = true`: Notification rows are global, so flipping the column
 * would mark the bell read for every colleague at once. The watermark is per user.
 */
app.post("/api/notifications/read", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  try {
    const at = new Date().toISOString();
    await prisma.user.update({ where: { id: a.sub }, data: { notifReadAt: at } });
    res.json({ ok: true, notifReadAt: at });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Staff: reset a client's portal login password (resets to the default and forces a change on next login).
// Super Admin: log in as another user (impersonation) — no credentials. Audited. Only super_admin.
app.post("/api/users/:id/login-as", requireAuth, requireStaff, requireHuman, async (req, res) => {
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

/**
 * Send the invitation again — the recovery path for a link that was never delivered or has expired.
 *
 * This is NOT the same tool as "reset password" below. A reset overwrites a password the person is
 * still using and kicks them out of live sessions; a resend only issues a new link, which matters for
 * an account that has no password to reset. Reissuing invalidates the previous link, so there is only
 * ever one live invitation per account.
 */
app.post("/api/users/:id/resend-invite", requireAuth, requireStaff, requireWriteRole, requireHuman, inviteLimiter, async (req, res) => {
  const a = (req as any).auth;
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.status && user.status !== "active" && user.status !== "invited") {
    return res.status(400).json({ error: "That account is inactive — reactivate it before inviting them again" });
  }
  const co = user.companyId ? await prisma.company.findUnique({ where: { id: user.companyId }, select: { name: true } }) : null;
  const result = await sendInvitation(user, { companyName: co?.name, invitedBy: a?.email, resend: true });
  await logAudit({ action: "user.invite_resent", actorId: a?.sub, target: user.email, detail: result.emailed ? "emailed" : `not emailed: ${result.error ?? "unknown"}`, ip: clientIp(req) });
  res.json({ name: user.name, ...result });
});

// Admin-only: reset ANY user's (staff or portal) password → one-time temp password, forced change on
// first login. Kills any live sessions (tokenVersion++) and clears lockout.
app.post("/api/users/:id/reset-password", requireAuth, requireStaff, requireWriteRole, requireHuman, resetLimiter, async (req, res) => {
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
    // Two states are internal: `draft` (still being written) and `approved` (signed off but not
    // yet released). The client sees a quotation only once it has actually been sent.
    where: { companyId: a.companyId, status: { notIn: ["draft", "approved"] } },
    orderBy: { date: "desc" },
  });
  res.json(rows);
});

/**
 * This client's own payments. The portal used to derive a "payment history" from paid invoices and
 * label every line "Auto-pay", which was never true — nobody has auto-pay, and a part payment did
 * not appear at all. These are the real records, so a receipt can name the actual method and
 * reference.
 */
app.get("/api/portal/payments", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const rows = await prisma.payment.findMany({ where: { companyId: a.companyId }, orderBy: { date: "desc" }, take: 200 });
  res.json(rows);
});

// A client acting on their own quotation: accept or reject only, and only their own.
app.put("/api/portal/quotations/:id", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const want = String(req.body?.status ?? "").toLowerCase();
  // The client ACCEPTS, REJECTS, or asks for CHANGES. `approved` is our internal sign-off before
  // sending and is not something a client can set.
  if (!["accepted", "rejected", "changes_requested"].includes(want)) return res.status(400).json({ error: "status must be accepted, rejected or changes_requested" });
  const note = String(req.body?.note ?? "").trim();
  // A change request with no note leaves staff guessing what to change, so it is required here
  // rather than optional — the whole point of the state is the message attached to it.
  if (want === "changes_requested" && !note) return res.status(400).json({ error: "Tell us what needs changing" });
  const q = await prisma.quotation.findUnique({ where: { id: req.params.id } });
  if (!q || q.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
  if (["draft", "approved"].includes(String(q.status))) return res.status(400).json({ error: "This quotation has not been sent yet" });
  const updated = await prisma.quotation.update({ where: { id: q.id }, data: { status: want, ...(want === "changes_requested" ? { clientNote: note } : {}) } });
  const verb = want === "changes_requested" ? "sent back with changes" : want;
  logActivity({ type: "finance", message: `Quotation ${q.number} ${verb} by ${q.clientName ?? "client"}`, user: q.clientName ?? "Client" });
  logNotification({ type: "system", title: `Quotation ${verb} — ${q.clientName ?? "client"}`, message: [`${q.number} · ${q.service ?? ""}`.trim(), note].filter(Boolean).join(" — ") });
  // The client agreeing is the moment the firm is committed, so it is the moment the work is
  // scheduled. Failing to schedule must not fail their acceptance — the quotation is already
  // accepted by now, and the notification above is what tells staff either way.
  if (want === "accepted") {
    startDeliveryForQuotation(q.id, { actor: q.clientName ?? "Client" })
      .catch(e => console.error("delivery failed for", q.number, e));
  }
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
    const { name, role, iqamaExpiry, status, customData, govId } = req.body ?? {};
    const created = await prisma.employee.create({
      // Coded on this path too. A client adding staff through the portal must not create people the
      // office cannot tell apart from the ones it already has.
      data: { companyId: a.companyId, name: String(name || ""), code: await nextNumber("employee", { companyId: a.companyId }),
              govId: govId ? String(govId).trim() : null,
              role: role ?? null, iqamaExpiry: iqamaExpiry ?? null, status: status ?? "valid", customData: customData ?? undefined },
    });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
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
    // Staff got an in-app row but no email, so a booking could sit unseen until someone opened the
    // bell. The client's own confirmation comes later, when staff actually confirm the slot.
    notify({
      rule: "Approval requested", audience: "staff",
      inApp: { type: "task", title: `Appointment request${clientName ? ` — ${clientName}` : ""}`, message: `${type} · ${date}${time ? ` ${time}` : ""}` },
      subject: `Appointment requested${clientName ? ` by ${clientName}` : ""}`,
      heading: "A client has requested an appointment",
      lines: [`Type: <b>${type}</b>`, `Requested for: <b>${date}${time ? ` ${time}` : ""}</b>`,
        employee ? `Employee: ${employee}` : "", "Confirm or reschedule it from the Appointments screen."],
    });
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
    // A reschedule request only changes the date once STAFF approve it, so it has to reach them.
    notify({
      rule: "Approval requested", audience: "staff",
      inApp: { type: "task", title: `Reschedule request — ${who}`, message: `${appt.type ?? "Appointment"}: ${appt.date ?? ""} → ${date}${time ? ` ${time}` : ""}` },
      subject: `Reschedule requested by ${who}`,
      heading: "A client wants to move an appointment",
      lines: [`Appointment: <b>${appt.type ?? "Appointment"}</b>`,
        `Currently: ${appt.date ?? "—"}${appt.time ? ` ${appt.time}` : ""}`,
        `Requested: <b>${date}${time ? ` ${time}` : ""}</b>`,
        note ? `Note: ${note}` : "",
        "The date only changes once you approve it."],
    });
    res.json(updated);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Portal: raise a service request (scoped to the authenticated client's company)
// Portal: read the client's own service requests (so they persist across reloads)
app.get("/api/portal/service-requests", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const rows = await prisma.serviceRequest.findMany({ where: { companyId: a.companyId }, orderBy: { id: "desc" } });

  // Attach progress for the requests that started a workflow, so the portal's PROGRESS column has
  // something to show. It has existed since the portal was built and has never been fed by anything.
  //
  // Progress is counted over the template's ACTIONABLE nodes — the steps a person works — not over
  // every node in the graph: counting start, end and decision nodes would tell a client their job is
  // 30% done because the engine passed through two invisible markers.
  const runIds = rows.map(r => r.workflowInstanceId).filter(Boolean) as string[];
  const progress: Record<string, { done: number; total: number; current: string | null; runStatus: string }> = {};
  if (runIds.length) {
    const runs = await prisma.workflowInstance.findMany({
      where: { id: { in: runIds } },
      include: { tasks: true, template: { select: { graph: true } } },
    });
    for (const run of runs) {
      const nodes: any[] = ((run.template?.graph as any)?.nodes ?? []).filter((n: any) => n?.type === "task" || n?.type === "approval");
      const total = nodes.length || run.tasks.length;
      const done = run.tasks.filter(t => ["done", "approved"].includes(String(t.status))).length;
      const active = run.tasks.find(t => String(t.status) === "active");
      progress[run.id] = {
        // A finished run reads as complete even if a branch left some nodes unvisited — the client
        // asked whether their job is done, not how many boxes the graph happens to contain.
        done: run.status === "completed" ? total : Math.min(done, total),
        total,
        current: active?.title ?? null,
        runStatus: run.status,
      };
    }
  }
  // Internal ids are never sent to a client: the run id is machinery, and the portal only needs to
  // know how far along it is.
  res.json(rows.map(({ workflowInstanceId, taskId, serviceItemId, ...r }) => ({
    ...r,
    progress: workflowInstanceId ? (progress[workflowInstanceId] ?? null) : null,
  })));
});
app.post("/api/portal/service-requests", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { type, message, clientName, companyId, attachments } = req.body ?? {};
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
      data: { number: await nextNumber("request"), companyId: target, clientName: co?.name ?? clientName ?? null, type: type ?? null, message: message ?? null, status: "open", date: "Just now", lastClientMsgAt: new Date().toISOString() },
    });
    // Attach the uploaded files to the request, AGAINST the document each one is meant to be.
    // The client sends file ids, never paths: an id is checked against what this account actually
    // uploaded, so nobody can attach another company's file by quoting its URL.
    const wanted = Array.isArray(attachments) ? attachments.slice(0, 25) : [];
    if (wanted.length) {
      const ids = wanted.map((x: any) => String(x?.fileId ?? "")).filter(Boolean);
      const owned = await prisma.fileAsset.findMany({ where: { id: { in: ids }, uploadedBy: a.sub } });
      const byId = new Map(owned.map(f => [f.id, f]));
      const rows = wanted
        .map((x: any) => ({ x, f: byId.get(String(x?.fileId ?? "")) }))
        .filter(({ f }) => !!f)
        .map(({ x, f }) => ({
          requestId: created.id,
          docKey: String(x.key || "other").slice(0, 60),
          label: x.label ? String(x.label).slice(0, 120) : null,
          path: f!.path, name: f!.name, size: f!.size,
          at: new Date().toISOString(),
        }));
      if (rows.length) await prisma.requestAttachment.createMany({ data: rows });
      // Say it plainly rather than silently dropping: a file that did not attach is one the client
      // believes they sent.
      if (rows.length < ids.length) console.warn(`[requests] ${ids.length - rows.length} attachment(s) on ${created.number} referenced files this account does not own`);
    }
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
// Policy: suspending a client LOCKS OUT every portal user under it — no sign-in, and any session
// already open stops working on its next request. Enforced in requireAuth by reading the company
// each time, so restoring the client restores access instantly and no per-user flag has to be kept
// in step. Staff are unaffected; they are not under a client.
//
// This replaced a deliberate read-only policy, and the reason that policy existed still stands: a
// locked-out client cannot see their own visa expiry dates, so a suspension over an unpaid invoice
// can cause a missed deadline that the firm may also carry. Changed on the owner's instruction —
// worth re-reading before anyone widens what suspension is used for.
// Suspension is never automatic: the dunning job recommends, a human decides.

/**
 * Portal write-guard. Now belt-and-braces: a suspended client cannot authenticate at all, so this
 * should never fire for one. Kept because it is the guard that would still hold if the auth-level
 * lockout were ever relaxed back to read-only.
 */
async function requireNotSuspended(req: any, res: any, next: any) {
  const a = req.auth;
  try {
    const co = await prisma.company.findUnique({ where: { id: a.companyId }, select: { status: true, suspendedReason: true } });
    if (co?.status === "suspended") {
      return res.status(403).json({
        error: "This account is suspended. Please contact us to restore access.",
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

// ── Contacts ────────────────────────────────────────────────────────────────────────────────────
//
// Deliberately NOT in the generic CRUD table below. Every write has to hold one invariant — exactly
// one primary contact per company, mirrored onto the company's three legacy columns — and a generic
// PUT would happily set isPrimary on a second row, leaving the mirror pointing at one person and the
// list showing another. Every route here goes through contacts.ts, which is the only writer.

/**
 * The clients a `sales` user may see. Every other staff role sees all of them.
 *
 * Read from `Company.ownerId` — the column on the client, not the JSON array that used to live on
 * the user. Ownership belongs to the client for the same reason a document's expiry belongs to the
 * document: it is a fact about that record, one value, and asking "who owns this?" should not mean
 * loading every user and scanning their arrays.
 *
 * Returning an EMPTY array is a real answer — a salesperson who owns nothing sees nothing. It is
 * `null` that means "no restriction", and only a non-sales role gets that.
 */
/**
 * The day a report should read team membership as at.
 *
 * The END of the period, so a report about March is answered with March's team — otherwise every
 * historical number is quietly recomputed against whoever is in the team today, which is the exact
 * failure the dated rows exist to prevent.
 *
 * Clamped to today, because a membership question about the future has no honest answer: nobody has
 * typed in next month's leavers. For a live period that makes it the current team, which is the best
 * available truth rather than a guess.
 */
function asAtFor(period?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  if (!period) return today;
  const r = periodRange(period);
  if (!r) return today;
  const end = r.to.slice(0, 10);
  return end < today ? end : today;
}

async function salesCompanyIds(req: any, on?: string): Promise<string[] | null> {
  if (req.auth?.role !== "sales") return null;
  // The caller's own book — or their TEAM's, when they lead one. Without this, a sales lead (who
  // per the firm's model owns no clients themselves) would be clamped to companies they personally
  // own: an empty set, which the report machinery correctly treats as "sees nothing". The lead's
  // Performance screen would sit empty while their team closed deals — scoping working perfectly
  // and answering the wrong question.
  // TAKES THE SAME DAY as the report it is scoping. This was left undated when the reports gained a
  // period, which quietly half-fixed the history: the owner filter used the period's team while the
  // company filter used TODAY's, so a rep who left the team took their clients out of last quarter's
  // figures even though the owner filter still counted them. Two scopings of one report disagreeing
  // is worse than either being wrong on its own — the total is short and nothing looks broken.
  const vis = await visibleUserIds(req.auth, on);
  const owners = vis.ids ?? [req.auth.sub];
  const mine = await prisma.company.findMany({ where: { ownerId: { in: owners } }, select: { id: true } });
  return mine.map(c => c.id);
}

app.get("/api/contacts", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const companyId = String(req.query.companyId ?? "").trim();
  if (companyId && scoped && !scoped.includes(companyId)) return res.json([]);
  const where: any = { archived: String(req.query.includeArchived ?? "") === "1" ? undefined : false };
  if (companyId) where.companyId = companyId;
  else if (scoped) where.companyId = { in: scoped };
  res.json(await prisma.contact.findMany({ where, orderBy: [{ isPrimary: "desc" }, { name: "asc" }], take: 1000 }));
});

app.post("/api/contacts", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const vErr = validate("contact", req.body, true);
  if (vErr) return res.status(400).json({ error: vErr });
  const scoped = await salesCompanyIds(req as any);
  const companyId = String(req.body.companyId);
  if (scoped && !scoped.includes(companyId)) return res.status(403).json({ error: "Not one of your clients" });
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { name: true } });
  if (!co) return res.status(404).json({ error: "Client not found" });
  try {
    const c = await addContact(companyId, req.body);
    logActivity({ type: "client", message: `Contact added: ${c!.name} (${co.name})`, user: (req as any).auth?.email });
    res.status(201).json(c);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put("/api/contacts/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const vErr = validate("contact", req.body, false);
  if (vErr) return res.status(400).json({ error: vErr });
  const before = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "Contact not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(before.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try { res.json(await editContact(req.params.id, req.body)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/api/contacts/:id/make-primary", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const c = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "Contact not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(c.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    await setPrimaryContact(c.companyId, c.id);
    res.json({ ok: true, contacts: await prisma.contact.findMany({ where: { companyId: c.companyId, archived: false }, orderBy: [{ isPrimary: "desc" }, { name: "asc" }] }) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/contacts/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const c = await prisma.contact.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "Contact not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(c.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    await removeContact(req.params.id);
    await logAudit({ action: "contact.delete", actorId: (req as any).auth?.sub, target: c.id, detail: c.name, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Lead sources and loss reasons ───────────────────────────────────────────────────────────────
//
// SUGGESTIONS, NOT CONSTRAINTS. Nothing anywhere validates a source or a lost reason against these
// lists, and that is deliberate: every value recorded before the lists existed would fail, and a
// country nobody has configured a list for could not record a loss at all — which would make the
// rule "say why it was lost" impossible to satisfy. The lists exist so the common answers are one
// press and spelled the same way, which is what makes the loss report worth reading.

const PICKLISTS = {
  "lead-sources": "leadSource", "lost-reasons": "lostReason", "competitors": "competitor",
  "industries": "industry", "campaigns": "campaign", "cancel-reasons": "cancelReason",
} as const;
// Which columns actually carry each list's wording — the retire-vs-delete check below reads these.
// Competitor lives only on the deal; sources and reasons on both the deal and the company;
// industry and campaign only on the company.
const PICKLIST_USAGE: Record<string, Array<["opportunity" | "company" | "interaction", string]>> = {
  leadSource: [["opportunity", "source"], ["company", "source"]],
  lostReason: [["opportunity", "lostReason"], ["company", "lostReason"]],
  competitor: [["opportunity", "competitor"]],
  industry: [["company", "industry"]],
  campaign: [["company", "campaign"]],
  // Lives on the INTERACTION, not the company or the deal — the only list here that does. An empty
  // array here would have made `used` always zero, so removing a reason would delete it outright
  // even with cancellations recorded under that wording, breaking the retire-don't-delete rule.
  cancelReason: [["interaction", "cancelReason"]],
};

for (const [path, model] of Object.entries(PICKLISTS)) {
  app.get(`/api/${path}`, requireAuth, requireStaff, async (req, res) => {
    const country = String(req.query.country ?? "").trim() || (await homeCountry());
    res.json(await (prisma as any)[model].findMany({
      where: { country, retired: false },
      orderBy: [{ sort: "asc" }, { name: "asc" }],
    }));
  });

  app.put(`/api/${path}`, requireAuth, requireStaff, requireWriteRole, async (req, res) => {
    const country = String((req.body ?? {}).country ?? "").trim() || (await homeCountry());
    const rows: any[] = Array.isArray((req.body ?? {}).rows ? req.body.rows : []) ? req.body.rows : [];
    const named = rows.filter(r => String(r?.name ?? "").trim());
    const seen = new Set<string>();
    for (const r of named) {
      const k = String(r.name).trim().toLowerCase();
      if (seen.has(k)) return res.status(400).json({ error: `"${String(r.name).trim()}" is in the list twice — the report would split one answer across two rows.` });
      seen.add(k);
    }

    const existing = await (prisma as any)[model].findMany({ where: { country } });
    const keep = new Set(named.map(r => r.id).filter(Boolean));
    // Removing an entry RETIRES it: records already carrying that wording keep their meaning, and
    // the loss report still groups them. Only an entry nothing has ever used is deleted outright.
    for (const row of existing) {
      if (keep.has(row.id)) continue;
      let used = 0;
      for (const [table, field] of PICKLIST_USAGE[model]) {
        used += await (prisma as any)[table].count({ where: { [field]: row.name } });
      }
      if (used > 0) await (prisma as any)[model].update({ where: { id: row.id }, data: { retired: true } });
      else await (prisma as any)[model].delete({ where: { id: row.id } });
    }
    for (const [i, r] of named.entries()) {
      const data = { country, name: String(r.name).trim(), color: r.color ?? null, bg: r.bg ?? null, sort: i, retired: false, ...(r.id ? { packModified: true } : {}) };
      if (r.id) await (prisma as any)[model].update({ where: { id: r.id }, data });
      else await (prisma as any)[model].create({ data });
    }
    await logAudit({ action: `${path}.save`, actorId: (req as any).auth?.sub, target: country, detail: `${named.length} entries`, ip: clientIp(req) });
    res.json(await (prisma as any)[model].findMany({ where: { country, retired: false }, orderBy: [{ sort: "asc" }, { name: "asc" }] }));
  });
}

/**
 * Hand out the companies already sitting unowned.
 *
 * Previews by default. Distributing a book of business is somebody's decision, so it takes a
 * deliberate press — nothing here runs on a timer, and the preview names who would get what before
 * anything is written.
 */
app.post("/api/companies/distribute-unowned", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const apply = (req.body ?? {}).apply === true;
  const out = await distributeUnowned({ apply, actor: (req as any).auth?.sub ?? null });
  if (apply && out.assigned.length) {
    await logAudit({
      action: "companies.distribute",
      actorId: (req as any).auth?.sub,
      target: `${out.assigned.length} company/companies`,
      detail: out.assigned.map(a => `${a.company} → ${a.to}`).join("; ").slice(0, 900),
      ip: clientIp(req),
    });
  }
  res.json(out);
});

/** Who is in the rotation and what each is carrying — so "why did they get it" is answerable. */
app.get("/api/owner-rotation", requireAuth, requireStaff, async (_req, res) => {
  res.json(await rotation());
});

/**
 * Who a client may be assigned to. Served rather than decided in the browser, because the console
 * had its own idea — every active member of staff — and it disagreed with assignment.ts.
 *
 * `include` keeps a current owner on the list even if their role no longer qualifies, so opening a
 * record cannot silently drop the person it is already assigned to.
 */
app.get("/api/assignable-owners", requireAuth, requireStaff, async (req, res) => {
  res.json(await assignableOwners(String(req.query.include ?? "").trim() || null));
});

/**
 * Correct a lead's own details — the mirror of the create route above.
 *
 * WHY IT IS NOT THE GENERIC CRUD PUT
 *
 * `contacts` is a relation, not a column, so Prisma rejects it inside `data` — the create route
 * already strips it for the same reason. And the company's three flat contact columns are a MIRROR
 * of the primary contact with exactly one writer (contacts.ts). Letting an edit form write
 * `contact`/`email`/`phone` directly would give that mirror a second author and the two would drift
 * within a week. So the person is edited through the contacts module, and the mirror follows.
 *
 * WHAT IT REFUSES TO TOUCH
 *
 * Lifecycle. Making a lead a client provisions a portal login, opens a deal and stamps a CR — that
 * is the lifecycle route's job, with its own dialog and its own consequences. A correction form that
 * could quietly do it by changing a dropdown would be a very expensive typo.
 */
app.put("/api/companies/:id/details", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const existing = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  const b = req.body ?? {};
  const contact = b.contact && typeof b.contact === "object" ? b.contact : null;
  const name = String(b.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "A company name is the one thing this cannot be saved without." });
  // Checked HERE too, not only in the browser. A form is a convenience; the route is the rule, and
  // this one is also reachable from anything else that learns the URL.
  const problem = contactProblem(contact);
  if (problem) return res.status(400).json({ error: problem });

  try {
    await prisma.company.update({
      where: { id: existing.id },
      data: {
        name,
        city: b.city ?? null,
        source: b.source ?? null,
        sourceDetail: b.sourceDetail ?? null,
        // `null` is a real choice here — a manager deliberately unassigning — so the key being
        // PRESENT is what decides, not whether it has a value.
        ...("ownerId" in b ? { ownerId: b.ownerId || null } : {}),
      },
    });

    // A person changed it, so no reason is invented: the method IS the explanation. recordAssignment
    // skips a no-op, so saving this form without touching the owner writes nothing.
    if ("ownerId" in b) {
      await recordAssignment(prisma, {
        companyId: existing.id, from: existing.ownerId, to: b.ownerId || null,
        assignedById: a?.sub ?? null, method: "manual",
      });
    }

    if (contact) {
      const primary = await prisma.contact.findFirst({ where: { companyId: existing.id, isPrimary: true } })
        ?? await prisma.contact.findFirst({ where: { companyId: existing.id } });
      const data = { name: String(contact.name ?? "").trim() || name, jobTitle: contact.jobTitle || null, email: contact.email || null, phone: contact.phone || null };
      if (primary) await editContact(primary.id, data);
      else if (data.name) await addContact(existing.id, data);
    }

    await logAudit({ action: "company.edit", actorId: a?.sub, target: `${name} (${existing.id})`, detail: existing.name !== name ? `renamed from ${existing.name}` : undefined, ip: clientIp(req) });
    const updated = await prisma.company.findUnique({ where: { id: existing.id } });
    res.json(updated);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * "Have we already got this company?" — asked while somebody is typing.
 *
 * Deliberately NOT scoped to the caller's own clients. A sales user who cannot see a colleague's
 * client is exactly the person about to enter it a second time, and hiding the match would let them
 * do it. The owner's name comes back with it so they know who to ask.
 */
app.get("/api/companies/duplicates", requireAuth, requireStaff, async (req, res) => {
  res.json(await findDuplicates({
    name: String(req.query.name ?? ""), cr: String(req.query.cr ?? ""),
    email: String(req.query.email ?? ""), phone: String(req.query.phone ?? ""),
    excludeId: String(req.query.excludeId ?? "") || null,
  }));
});

/**
 * What is not set up yet. Counted on request — a cached score would keep congratulating somebody
 * for work they have not done.
 */
app.get("/api/setup-check", requireAuth, requireStaff, async (req, res) => {
  const country = String(req.query.country ?? "").trim() || (await homeCountry());
  res.json(await setupCheck(country));
});

// ── Sales performance ───────────────────────────────────────────────────────────────────────────

/**
 * The Activities screen: what the team has actually been doing, across every client.
 *
 * `?days` bounds the window — the default is a fortnight, because an unbounded log is a screen that
 * gets slower every month and answers a question nobody asked ("what happened in March?"). `?kind`
 * narrows to one sort of contact; `?mine=1` to the caller's own.
 *
 * Counts come back for EVERY kind including the zeroes, so the filter bar keeps its shape as it is
 * used rather than dropping chips as they stop matching.
 */
app.get("/api/activities", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const days = Math.max(1, Math.min(365, Number(req.query.days ?? 14) || 14));
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const kind = String(req.query.kind ?? "").trim();
  const mine = String(req.query.mine ?? "") === "1" ? ((req as any).auth?.sub ?? null) : null;
  const includeAuto = String(req.query.auto ?? "") === "1";
  try {
    const [rows, counts, autoCount] = await Promise.all([
      activityFeed({ companyIds: scoped, ownerId: mine, kinds: kind ? [kind] : null, since, includeAuto, limit: 300 }),
      // Counts ignore the kind filter on purpose — a chip has to show how many it WOULD match, not
      // how many match the filter that is already on.
      activityCounts({ companyIds: scoped, ownerId: mine, since, includeAuto }),
      // How many are being held back, so the screen can offer them by number rather than hiding
      // the fact that anything was excluded at all.
      includeAuto ? Promise.resolve(0) : prisma.interaction.count({
        where: { auto: true, at: { gte: since }, ...(scoped ? { companyId: { in: scoped } } : {}), ...(mine ? { ownerId: mine } : {}) },
      }),
    ]);
    res.json({ rows, counts, since, days, includeAuto, autoCount, scope: scoped ? "own" : "firm" });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// The CRM dashboard: every headline figure for today, in one round trip.
//
// Scoped through the SAME pair as the Pipeline board and the Performance report — salesCompanyIds
// for the companies, visibleUserIds for the deal owners. Deliberately not a third scoping rule: a
// dashboard that shows a rep a firm-wide total while their own board shows their book would make
// them think the board was broken.
//
// Undated, unlike sales-report. This screen answers "where are we NOW", so the as-at date is today
// and there is no period to pick — every figure that is about a month says so in its own name.
app.get("/api/crm-dashboard", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const vis = await visibleUserIds((req as any).auth);
  // WHOSE TARGET, decided by the SAME rule the Performance report uses — the firm's, or the one
  // team you lead, or your own. Resolved here rather than inside the dashboard module so there is
  // one rule in one place; a second copy is how two screens end up measuring against two targets
  // and neither reader knows which they are looking at.
  const period = new Date().toISOString().slice(0, 7);
  const led = await actableTeamIds((req as any).auth);
  const teamId = led && led.length === 1 ? led[0] : null;
  const ownerId = vis.scope === "self" ? (req as any).auth.sub : null;
  const row = await prisma.salesTarget.findFirst({
    where: { period, teamId: teamId ?? null, ownerId: teamId ? null : ownerId },
  });
  const target = row
    ? {
        amountMinor: row.amountMinor,
        label: teamId ? "your team's target" : ownerId ? "your target" : "the firm's target",
      }
    : null;
  try {
    res.json(await crmDashboard({ companyIds: scoped, ownerIds: vis.ids, target }));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// History read back, in one round trip: stage dwell times and death stages, the lifecycle funnel
// and its conversion speeds, and who deals are being lost to. All three begin at the day their
// tables began — each block says so rather than presenting a week of record as an eternal truth.
app.get("/api/stage-analytics", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const country = String(req.query.country ?? "").trim() || (await homeCountry());
  const scoped = await salesCompanyIds(req as any);
  try {
    // `lostTo` already lives inside stageAnalytics — a second competitor grouping here briefly
    // existed and is exactly the two-answers-to-one-question this codebase keeps refusing.
    const [stages, lifecycle, campaigns] = await Promise.all([
      stageAnalytics(country),
      lifecycleAnalytics({ companyIds: scoped }),
      campaignPerformance({ companyIds: scoped }),
    ]);
    res.json({ ...stages, lifecycle, campaigns });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.get("/api/sales-report", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  // Three rungs now, not two, and all three come from ONE place (visibility.ts):
  //   firm — admins, who may also narrow to any one person via ?ownerId
  //   team — somebody with reports: their team's deals, narrowable to one of THEIR OWN people only
  //   self — everyone else, exactly as before
  // The narrowing check matters: without it, ?ownerId would let any team lead read any rep's
  // numbers by guessing an id, and the middle rung would quietly be the top one.
  const period = String(req.query.period ?? "").trim() || undefined;
  // AS AT THE PERIOD, not as at today. People move between teams; asking "who is in this team" of a
  // report about March credits March's deals to whoever happens to be in the team in August. Clamped
  // to today because a membership question about the future has no honest answer — nobody's leaving
  // date has been typed in yet — so the current team is the best available truth for a live period.
  const on = asAtFor(period);
  const scoped = await salesCompanyIds(req as any, on);
  const vis = await visibleUserIds((req as any).auth, on);
  const asked = String(req.query.ownerId ?? "").trim() || null;
  const ownerId = vis.ids === null ? asked : (asked && vis.ids.includes(asked) ? asked : null);
  const ownerIds = ownerId ? null : vis.ids;
  // Exactly one team led → that team's target is the one this report is measured against. Two teams
  // have no single target, and inventing one by adding them up would answer a question nobody asked.
  const led = await actableTeamIds((req as any).auth, on);
  // Not gated on vis.scope. An empty team degrades the VIEW to self-scope — correctly, there is
  // nobody else's work to show — but the target still belongs to the team, and a lead who has been
  // asked for a number before the team is staffed should see it rather than a blank. The rows and
  // the target answer different questions and are allowed to disagree about how many people there are.
  const teamId = !ownerId && led && led.length === 1 ? led[0] : null;
  try {
    // The same default salesReport applies internally — resolved here too so the two halves of the
    // response cannot end up describing different periods when none was asked for.
    const range = periodRange(period || currentPeriod())!;
    res.json({
      report: await salesReport({ period, ownerId, ownerIds, companyIds: scoped, teamId }),
      // What happened to the commitments that came due in the same period. Scoped by exactly the
      // same owner/company filters as the report above, so the two halves of the screen cannot be
      // answering about different people.
      followUps: await followUpCompletion({ from: range.from, to: range.to, companyIds: scoped, ownerId, ownerIds }),
      periods: await periodsWithActivity(),
      scope: ownerId ? "self" : vis.scope,
      // WHICH team, not just that it is a team one. Without it the console can show a team's target
      // and then save the edit against the firm — the bar measuring one thing and the box editing
      // another, which is worse than having no editor.
      teamId,
      teamName: teamId ? (await prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }))?.name ?? null : null,
      // Said out loud, so a lead reading last quarter knows the team was read as it stood then.
      membershipAsAt: on,
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

/**
 * The operations half of Performance: throughput, SLA record, and who is carrying what.
 *
 * SCOPED THE SAME WAY THE SALES ONE IS, and for the same reason. An officer sees their own figures;
 * admins see the team. The alternative — everybody sees everybody — turns a workload view into a
 * comparison nobody agreed to be part of, and it is the kind of screen that changes how people pick
 * up work within a week of being switched on.
 */
app.get("/api/ops-report", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "accountant", "sales"), async (req, res) => {
  // Same three rungs as the sales report, from the same module. A PRO lead sees their people's
  // throughput and open load — unranked, as this report already insists — and can narrow to one of
  // their own reports; they cannot narrow to anybody outside the team by guessing an id.
  const on = asAtFor(String(req.query.period ?? "").trim() || undefined);
  const vis = await visibleUserIds((req as any).auth, on);
  const asked = String(req.query.assigneeId ?? "").trim() || null;
  const assigneeId = vis.ids === null ? asked : (asked && vis.ids.includes(asked) ? asked : null);
  const assigneeIds = assigneeId ? null : vis.ids;
  try {
    res.json({
      report: await opsReport({ period: String(req.query.period ?? "").trim() || undefined, assigneeId, assigneeIds }),
      periods: await opsPeriodsWithActivity(),
      /** So the screen can say "your work" / "your team" rather than implying it is the firm. */
      scope: assigneeId ? "self" : vis.scope,
    });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get("/api/sales-targets", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (_req, res) => {
  res.json(await prisma.salesTarget.findMany({ orderBy: { period: "desc" }, take: 200 }));
});

/**
 * Set or clear a target.
 *
 * An amount of zero CLEARS it rather than storing a target of nothing — "0% of SAR 0" is a figure
 * that means nothing, and the report deliberately reports "no target set" instead.
 */
app.put("/api/sales-targets", requireAuth, requireStaff, async (req, res) => {
  const b = req.body ?? {};
  // NOT blanket requireWriteRole. A team lead is a sales user, so the admin-only gate hid this from
  // the one person who is actually asked what their team will bring in — the control was aimed at
  // "who may change the firm's number", and it caught the team case by accident. Admins keep
  // everything; a lead may set the target of a team THEY LEAD, and nothing else.
  const auth = (req as any).auth;
  const isAdmin = auth?.role === "admin" || auth?.role === "super_admin";
  if (!isAdmin) {
    const wanted = String(b.teamId ?? "").trim();
    const led = await actableTeamIds(auth);
    if (!wanted || !led || !led.includes(wanted)) {
      return res.status(403).json({ error: "You can only set a target for a team you lead" });
    }
  }
  const period = String(b.period ?? "").trim();
  if (!periodRange(period)) return res.status(400).json({ error: `"${period}" is not a period — use 2026-08 or 2026-Q3` });
  const ownerId = b.ownerId || null;
  const teamId = b.teamId || null;
  // A target belongs to the firm, ONE person, or ONE team. Both set is not a smaller target, it is
  // an ambiguous one, and the report would have to pick which it meant.
  if (ownerId && teamId) return res.status(400).json({ error: "A target is for a person or for a team, not both" });
  if (teamId && !(await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } }))) {
    return res.status(400).json({ error: "That team no longer exists" });
  }
  const amountMinor = Math.round(Number(b.amountMinor) || 0);

  if (amountMinor <= 0) {
    await prisma.salesTarget.deleteMany({ where: { period, ownerId, teamId } });
    return res.json({ ok: true, cleared: true });
  }
  const existing = await prisma.salesTarget.findFirst({ where: { period, ownerId, teamId } });
  const data = { period, ownerId, teamId, amountMinor, currency: b.currency || null, country: b.country || null, note: b.note || null };
  const row = existing
    ? await prisma.salesTarget.update({ where: { id: existing.id }, data })
    : await prisma.salesTarget.create({ data: { ...data, createdAt: new Date().toISOString() } });
  await logAudit({ action: "sales-target.set", actorId: (req as any).auth?.sub, target: period, detail: String(amountMinor), ip: clientIp(req) });
  res.json(row);
});

// ── A deal's checklist ─────────────────────────────────────────────────────────────────────────

/** What this deal still owes, with how each item came to be satisfied. */
app.get("/api/opportunities/:id/checklist", requireAuth, requireStaff, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { stage: true } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(opp.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  const company = await prisma.company.findUnique({ where: { id: opp.companyId } });
  res.json(await summaryFor(opp, company, opp.stage));
});

/**
 * Tick or untick a MANUAL item.
 *
 * Document items are refused outright rather than quietly ignored. They are satisfied by a document
 * existing, and letting somebody tick one by hand would create exactly the disagreement between the
 * list and reality that deriving them was meant to prevent — with the hand-tick winning.
 */
app.post("/api/opportunities/:id/checklist", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { stage: true } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(opp.companyId)) return res.status(403).json({ error: "Not one of your clients" });

  const key = String((req.body ?? {}).key ?? "").trim();
  const done = !!(req.body ?? {}).done;
  // The SAME list the reader shows — see effectiveItems. Validating against the snapshot alone
  // refused every item on a deal that had never been moved under a checklist, while displaying them.
  const company0 = await prisma.company.findUnique({ where: { id: opp.companyId } });
  const items = await effectiveItems(opp, company0, opp.stage);
  const item = items.find(i => i.key === key);
  if (!item) return res.status(400).json({ error: "That is not on this deal's checklist" });
  if (String(item.source) === "document") {
    return res.status(400).json({ error: `"${item.label}" is satisfied by the document itself — upload or record it against the client and it ticks on its own.` });
  }

  const me = await prisma.user.findUnique({ where: { id: (req as any).auth?.sub }, select: { name: true } });
  const state: Record<string, any> = (opp.checklistState && typeof opp.checklistState === "object") ? { ...(opp.checklistState as any) } : {};
  if (done) state[key] = { done: true, at: new Date().toISOString(), by: me?.name ?? null };
  else delete state[key];

  const saved = await prisma.opportunity.update({ where: { id: opp.id }, data: { checklistState: state as any }, include: { stage: true } });
  const company = await prisma.company.findUnique({ where: { id: opp.companyId } });
  res.json(await summaryFor(saved, company, saved.stage));
});

/**
 * Waive a required item, with a reason.
 *
 * The escape hatch that makes a blocking checklist survivable. Without it a deal can sit for ever
 * behind an item that no longer applies — a document the client is exempt from, a step done before
 * this system existed — and the only way out is the database.
 *
 * ADMIN ONLY, and recorded. A waiver that anybody could grant is not a control, and one that leaves
 * no trace turns "we checked" into a claim nobody can test afterwards.
 */
app.post("/api/opportunities/:id/checklist/waive", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { stage: true, company: { select: { name: true } } } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });

  const key = String((req.body ?? {}).key ?? "").trim();
  const why = String((req.body ?? {}).reason ?? "").trim();
  if (!why) return res.status(400).json({ error: "Say why this is being waived — a waiver with no reason teaches nobody anything" });
  const company0 = await prisma.company.findUnique({ where: { id: opp.companyId } });
  const items = await effectiveItems(opp, company0, opp.stage);
  const item = items.find(i => i.key === key);
  if (!item) return res.status(400).json({ error: "That is not on this deal's checklist" });

  const me = await prisma.user.findUnique({ where: { id: (req as any).auth?.sub }, select: { name: true } });
  const waived: Record<string, any> = (opp.checklistWaived && typeof opp.checklistWaived === "object") ? { ...(opp.checklistWaived as any) } : {};
  waived[key] = { reason: why, at: new Date().toISOString(), by: me?.name ?? null };

  const saved = await prisma.opportunity.update({ where: { id: opp.id }, data: { checklistWaived: waived as any }, include: { stage: true } });
  await logActivity({ type: "sales", message: `Checklist waived on ${opp.title} (${opp.company?.name}): ${item.label} — ${why}`, user: (req as any).auth?.email });
  await logAudit({ action: "deal.checklist.waive", actorId: (req as any).auth?.sub, target: opp.title, detail: `${item.label}: ${why}`, ip: clientIp(req) });
  const company = await prisma.company.findUnique({ where: { id: opp.companyId } });
  res.json(await summaryFor(saved, company, saved.stage));
});

// ── Teams: who works together, and who leads them ──────────────────────────────────────────────
//
// Every write here goes through teams.ts rather than touching TeamMember/TeamLead directly, because
// the one thing that must never be got wrong is CLOSING the previous row instead of overwriting it.
// A second writer that edits in place turns the history into a lie, and it does so silently.

/** The teams as they stand — or as they stood, with ?on=YYYY-MM-DD. */
app.get("/api/teams", requireAuth, requireStaff, async (req, res) => {
  const kind = String(req.query.kind ?? "").trim();
  if (kind && !TEAM_KINDS.includes(kind as any)) return res.status(400).json({ error: `"${kind}" is not a kind of team` });
  const on = String(req.query.on ?? "").trim() || todayDay();
  res.json(await teamViews({ kind: kind || undefined, on, includeInactive: String(req.query.all ?? "") === "1" }));
});

app.get("/api/teams/:id/history", requireAuth, requireStaff, async (req, res) => {
  const t = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!t) return res.status(404).json({ error: "That team no longer exists" });
  res.json(await teamHistory(t.id));
});

app.post("/api/teams", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim();
  const kind = String(b.kind ?? "").trim();
  if (!name) return res.status(400).json({ error: "Give the team a name — it goes on reports" });
  if (!TEAM_KINDS.includes(kind as any)) return res.status(400).json({ error: "Say whether this is a sales or a PRO team" });
  const clash = await prisma.team.findFirst({ where: { name, kind, active: true } });
  if (clash) return res.status(409).json({ error: `There is already a ${kind} team called "${name}"` });

  const team = await prisma.team.create({
    data: { name, kind, country: b.country || null, active: true, createdAt: new Date().toISOString() },
  });
  await logActivity({ type: "team", message: `Team created: ${name} (${kind})`, user: (req as any).auth?.email });
  res.json((await teamViews({ includeInactive: true })).find(t => t.id === team.id) ?? team);
});

app.put("/api/teams/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const b = req.body ?? {};
  const team = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!team) return res.status(404).json({ error: "That team no longer exists" });
  const data: any = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) return res.status(400).json({ error: "A team needs a name" });
    data.name = name;
  }
  if (b.country !== undefined) data.country = b.country || null;
  // Retiring, not deleting. The team's history is what last quarter's report reads, and a team that
  // can be deleted is a quarter that can stop adding up.
  if (b.active !== undefined) data.active = !!b.active;

  const saved = await prisma.team.update({ where: { id: team.id }, data });
  if (b.active === false) await logActivity({ type: "team", message: `Team retired: ${saved.name}`, user: (req as any).auth?.email });
  res.json((await teamViews({ includeInactive: true })).find(t => t.id === saved.id) ?? saved);
});

/**
 * Change who leads a team. The operation the whole model exists for — one edit, whoever is in it.
 *
 * `userId: null` is a real answer and leaves the team deliberately unled, which the screen then says
 * out loud. It is not the same as "unchanged", which is why the field must be present to act.
 */
app.post("/api/teams/:id/lead", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const team = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!team) return res.status(404).json({ error: "That team no longer exists" });
  if (!("userId" in (req.body ?? {}))) return res.status(400).json({ error: "Say who should lead it, or null for nobody" });

  const userId = req.body.userId || null;
  if (userId) {
    const problem = await personProblem(String(userId), "lead");
    if (problem) return res.status(400).json({ error: problem });
  }
  const on = String((req.body ?? {}).on ?? "").trim() || todayDay();
  await setLead(team.id, userId, on);

  const who = userId ? (await prisma.user.findUnique({ where: { id: String(userId) }, select: { name: true } }))?.name : null;
  await logActivity({
    type: "team",
    message: `Team lead ${who ? `set to ${who}` : "cleared"}: ${team.name}`,
    user: (req as any).auth?.email,
  });
  await logAudit({ action: "team.lead", actorId: (req as any).auth?.sub, target: team.name, detail: who ?? "(nobody)", ip: clientIp(req) });
  res.json((await teamViews({ includeInactive: true, on })).find(t => t.id === team.id));
});

/** Add somebody. Joining closes whatever membership they had — one team per person, see teams.ts. */
app.post("/api/teams/:id/members", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const team = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!team) return res.status(404).json({ error: "That team no longer exists" });
  const userId = String((req.body ?? {}).userId ?? "").trim();
  if (!userId) return res.status(400).json({ error: "Say who is joining" });
  const problem = await personProblem(userId, "member");
  if (problem) return res.status(400).json({ error: problem });

  const on = String((req.body ?? {}).on ?? "").trim() || todayDay();
  await addMember(team.id, userId, on);
  res.json((await teamViews({ includeInactive: true, on })).find(t => t.id === team.id));
});

app.delete("/api/teams/:id/members/:userId", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const team = await prisma.team.findUnique({ where: { id: req.params.id } });
  if (!team) return res.status(404).json({ error: "That team no longer exists" });
  const on = String(req.query.on ?? "").trim() || todayDay();
  await removeMember(team.id, req.params.userId, on);
  res.json((await teamViews({ includeInactive: true, on })).find(t => t.id === team.id));
});

// ── Interactions: what was said, and what was promised ──────────────────────────────────────────

app.get("/api/interactions", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const companyId = String(req.query.companyId ?? "").trim();
  if (companyId) {
    if (scoped && !scoped.includes(companyId)) return res.json([]);
    return res.json(await historyFor(companyId));
  }
  const where: any = {};
  if (scoped) where.companyId = { in: scoped };
  if (req.query.opportunityId) where.opportunityId = String(req.query.opportunityId);
  res.json(await prisma.interaction.findMany({
    where,
    include: { company: { select: { id: true, name: true, lifecycle: true } }, opportunity: { select: { id: true, title: true } } },
    orderBy: { at: "desc" }, take: 500,
  }));
});

/** What is owed today, overdue first. The one screen a salesperson opens in the morning. */
app.get("/api/follow-ups", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const mine = String(req.query.mine ?? "") === "1" ? (req as any).auth?.sub : null;
  res.json(await openFollowUps({ companyIds: scoped, ownerId: mine, on: String(req.query.on ?? "").trim() || undefined }));
});

app.post("/api/interactions", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const b = req.body ?? {};
  const co = await prisma.company.findUnique({ where: { id: String(b.companyId ?? "") }, select: { id: true, name: true } });
  if (!co) return res.status(404).json({ error: "Pick who this was with" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(co.id)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    const row = await logInteraction({ ...b, companyId: co.id, contactId: b.contactId || null, ownerId: b.ownerId || (req as any).auth?.sub || null });
    logActivity({
      type: "sales",
      message: `${KIND_LABEL[row.kind] ?? "Contact"} logged: ${co.name}${row.nextAction ? ` — next: ${row.nextAction} (${dayOf(row.nextActionAt)})` : ""}`,
      user: (req as any).auth?.email,
    });
    res.status(201).json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put("/api/interactions/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const before = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "Entry not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(before.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  const b = req.body ?? {};
  res.json(await prisma.interaction.update({
    where: { id: before.id },
    data: {
      kind: b.kind === undefined ? undefined : String(b.kind),
      at: b.at === undefined ? undefined : (b.at || before.at),
      summary: b.summary === undefined ? undefined : (b.summary || null),
      outcome: b.outcome === undefined ? undefined : (b.outcome || null),
      nextAction: b.nextAction === undefined ? undefined : (b.nextAction || null),
      nextActionAt: b.nextActionAt === undefined ? undefined : (b.nextActionAt || null),
    },
  }));
});

app.post("/api/interactions/:id/done", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const row = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: "Entry not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(row.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try { res.json(await closeFollowUp(row.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Push a follow-up's date forward. Logged to the activity feed like any other decision about work —
// a commitment quietly moving is the thing this feature exists to stop being quiet.
app.post("/api/interactions/:id/reschedule", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const row = await prisma.interaction.findUnique({ where: { id: req.params.id }, include: { company: { select: { name: true } } } });
  if (!row) return res.status(404).json({ error: "Entry not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(row.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    const saved = await rescheduleFollowUp(row.id, { to: String((req.body ?? {}).to ?? ""), reason: (req.body ?? {}).reason });
    logActivity({
      type: "sales",
      message: `Follow-up moved to ${dayOf(saved.nextActionAt)}: ${saved.nextAction} (${row.company.name})`
        + (saved.snoozeCount > 1 ? ` — pushed ${saved.snoozeCount} times, first due ${dayOf(saved.snoozedFrom)}` : "")
        + (saved.snoozeReason ? ` — ${saved.snoozeReason}` : ""),
      user: (req as any).auth?.email,
    });
    res.json(saved);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Abandon a follow-up. A REASON is required — see cancelFollowUp for why this one is demanded
// where a reschedule's is not.
app.post("/api/interactions/:id/cancel", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const row = await prisma.interaction.findUnique({ where: { id: req.params.id }, include: { company: { select: { name: true } } } });
  if (!row) return res.status(404).json({ error: "Entry not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(row.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    const saved = await cancelFollowUp(row.id, String((req.body ?? {}).reason ?? ""));
    logActivity({
      type: "sales",
      message: `Follow-up cancelled: ${saved.nextAction} (${row.company.name}) — ${saved.cancelReason}`,
      user: (req as any).auth?.email,
    });
    res.json(saved);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/interactions/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const row = await prisma.interaction.findUnique({ where: { id: req.params.id } });
  if (!row) return res.status(404).json({ error: "Entry not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(row.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  await prisma.interaction.delete({ where: { id: row.id } });
  res.json({ ok: true });
});

// ── Pipeline stages (configuration) ─────────────────────────────────────────────────────────────
//
// Reads go through here rather than the generic CRUD so the whole SET can be validated on save.
// One stage at a time cannot catch "no won column" or "two lost columns", and neither of those is
// visible until somebody tries to close a deal.

app.get("/api/pipeline-stages", requireAuth, requireStaff, async (req, res) => {
  const country = String(req.query.country ?? "").trim() || (await homeCountry());
  res.json(await stagesFor(country));
});

app.put("/api/pipeline-stages", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const country = String((req.body ?? {}).country ?? "").trim() || (await homeCountry());
  const rows: any[] = Array.isArray((req.body ?? {}).stages) ? req.body.stages : [];
  const err = validateStages(rows);
  if (err) return res.status(400).json({ error: err });

  const existing = await prisma.pipelineStage.findMany({ where: { country } });
  const keep = new Set(rows.map(r => r.id).filter(Boolean));

  // A stage with deals on it is RETIRED, never deleted: the opportunity points at it, and removing
  // the row would leave cards that cannot say which column they were in. Same rule as a document
  // type with documents captured under it.
  for (const s of existing) {
    if (keep.has(s.id)) continue;
    const inUse = await prisma.opportunity.count({ where: { stageId: s.id } });
    if (inUse) await prisma.pipelineStage.update({ where: { id: s.id }, data: { retired: true } });
    else await prisma.pipelineStage.delete({ where: { id: s.id } });
  }

  for (const [i, r] of rows.entries()) {
    // An empty chase window means "no rule", which is different from zero — zero would book a chase
    // due the same day. Blank and null both have to survive as null.
    const chase = r.followUpDays === "" || r.followUpDays == null ? null : Math.max(0, Math.min(365, Number(r.followUpDays) || 0));
    // How long a deal may sit here before it is called stalled. Blank means "use the global
    // setting", which is different from 0 — zero would call every deal stalled the day it arrived.
    // Floored at 1 for exactly that reason.
    const limit = r.maxDays === "" || r.maxDays == null ? null : Math.max(1, Math.min(365, Number(r.maxDays) || 0));
    const data = {
      country, name: String(r.name).trim(), color: r.color ?? null, bg: r.bg ?? null,
      sort: i, probabilityBp: Math.max(0, Math.min(10000, Number(r.probabilityBp) || 0)),
      followUpDays: chase, followUpAction: String(r.followUpAction ?? "").trim() || null,
      maxDays: limit,
      isWon: !!r.isWon, isLost: !!r.isLost, retired: false,
      // The checklist this stage gates on. Only "dynamic" is settable from the editor — a static
      // list typed per stage would be a second place to maintain the same requirements, and the rule
      // is the one that ships inside a country pack. Blank clears the gate entirely.
      checklistSource: String(r.checklistRuleId ?? "").trim() ? "dynamic" : null,
      checklistRuleId: String(r.checklistRuleId ?? "").trim() || null,
      // Editing a pack-installed stage marks it modified, so an upgrade knows not to overwrite it.
      ...(r.id ? { packModified: true } : {}),
    };
    if (r.id) await prisma.pipelineStage.update({ where: { id: r.id }, data });
    else await prisma.pipelineStage.create({ data });
  }
  await logAudit({ action: "pipeline-stages.save", actorId: (req as any).auth?.sub, target: country, detail: `${rows.length} stages`, ip: clientIp(req) });
  res.json(await stagesFor(country));
});

// ── Opportunities ───────────────────────────────────────────────────────────────────────────────

app.get("/api/pipeline", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const country = String(req.query.country ?? "").trim() || (await homeCountry());
  const scoped = await salesCompanyIds(req as any);
  const board = await boardFor(country, { companyIds: scoped, ownerId: String(req.query.ownerId ?? "").trim() || null });
  // Quotations out with no answer. Counted here rather than on the board's own cards because a
  // quotation can exist without a deal behind it, and money already quoted and then forgotten is
  // worth a number at the top of the screen somebody looks at every morning.
  const awaiting = await prisma.quotation.count({
    where: { status: "sent", ...(scoped ? { companyId: { in: scoped } } : {}) },
  });
  res.json({ ...board, awaitingAnswer: awaiting });
});

app.get("/api/opportunities", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  const where: any = {};
  if (scoped) where.companyId = { in: scoped };
  if (req.query.companyId) where.companyId = String(req.query.companyId);
  const rows = await prisma.opportunity.findMany({ where, include: { stage: true }, orderBy: { createdAt: "desc" }, take: 500 });
  res.json(await Promise.all(rows.map(r => withMoney(r as any))));
});

app.post("/api/opportunities", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.title ?? "").trim()) return res.status(400).json({ error: "Give it a title — a pipeline of untitled deals cannot be read" });
  const co = await prisma.company.findUnique({ where: { id: String(b.companyId ?? "") } });
  if (!co) return res.status(404).json({ error: "Pick the company this is for" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(co.id)) return res.status(403).json({ error: "Not one of your clients" });
  // Pursuing a company already written off is a contradiction that would sit in the pipeline
  // forever. Reopen it on the Leads screen first — that is one press, and it says what happened.
  if (co.lifecycle === "lost") return res.status(409).json({ error: `${co.name} is marked lost. Reopen it before adding a deal.` });

  const country = co.country ?? (await homeCountry());
  const stages = await stagesFor(country);
  if (!stages.length) return res.status(409).json({ error: `No pipeline stages are set up for ${countryName(country)}. Add them under Sales Settings first.` });
  // Named stage, or the first open one — never a terminal column, which would record a deal as won
  // or lost at the moment it was created.
  const stage = (b.stageId && stages.find(s => s.id === b.stageId)) || stages.find(s => !s.isWon && !s.isLost) || stages[0];

  const now = new Date().toISOString();
  const created = await prisma.opportunity.create({
    data: {
      number: await nextNumber("opportunity").catch(() => null),
      companyId: co.id, contactId: b.contactId || null, title: String(b.title).trim(),
      valueMinor: b.valueMinor == null || b.valueMinor === "" ? null : Math.round(Number(b.valueMinor)),
      currency: b.currency || countryCurrency(country),
      probabilityBp: b.probabilityBp == null || b.probabilityBp === "" ? null : Math.max(0, Math.min(10000, Number(b.probabilityBp))),
      stageId: stage.id, expectedCloseDate: b.expectedCloseDate || null,
      ownerId: b.ownerId || (req as any).auth?.sub || null, source: b.source || co.source || null,
      country, notes: b.notes || null, createdAt: now, stageAt: now,
    },
    include: { stage: true },
  });
  await recordTransition(prisma, { opportunityId: created.id, toStageId: stage.id, movedById: (req as any).auth?.sub ?? null, at: now });
  logActivity({ type: "sales", message: `Deal opened: ${created.title} (${co.name})`, user: (req as any).auth?.email });
  res.status(201).json(await withMoney(created as any));
});

app.put("/api/opportunities/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const before = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(before.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  const b = req.body ?? {};
  const updated = await prisma.opportunity.update({
    where: { id: before.id },
    data: {
      title: b.title == null ? undefined : String(b.title).trim(),
      contactId: b.contactId === undefined ? undefined : (b.contactId || null),
      valueMinor: b.valueMinor === undefined ? undefined : (b.valueMinor === "" || b.valueMinor === null ? null : Math.round(Number(b.valueMinor))),
      probabilityBp: b.probabilityBp === undefined ? undefined : (b.probabilityBp === "" || b.probabilityBp === null ? null : Math.max(0, Math.min(10000, Number(b.probabilityBp)))),
      expectedCloseDate: b.expectedCloseDate === undefined ? undefined : (b.expectedCloseDate || null),
      ownerId: b.ownerId === undefined ? undefined : (b.ownerId || null),
      source: b.source === undefined ? undefined : (b.source || null),
      notes: b.notes === undefined ? undefined : (b.notes || null),
      // Empty string means "back to derived" — an override somebody can take OFF again matters as
      // much as one they can put on. Anything not in the known set is refused rather than stored,
      // because a typo here would silently vanish a deal from every forecast bucket.
      forecastCategory: b.forecastCategory === undefined ? undefined
        : (["pipeline", "best_case", "commit"].includes(String(b.forecastCategory)) ? String(b.forecastCategory) : null),
      competitor: b.competitor === undefined ? undefined : (String(b.competitor).trim() || null),
    },
    include: { stage: true },
  });
  res.json(await withMoney(updated as any));
});

/**
 * Move a deal to another column.
 *
 * The only route that writes `stageId`, so the two things that must accompany a move happen here
 * and nowhere else: a losing move records WHY, and a closing move stamps when.
 */
app.post("/api/opportunities/:id/move", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { stage: true } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(opp.companyId)) return res.status(403).json({ error: "Not one of your clients" });

  const to = await prisma.pipelineStage.findUnique({ where: { id: String((req.body ?? {}).stageId ?? "") } });
  if (!to || to.retired) return res.status(400).json({ error: "That column does not exist" });
  if (to.country !== opp.country) return res.status(400).json({ error: "That column belongs to another country" });
  if (to.id === opp.stageId) return res.json(await withMoney(opp as any));

  const reason = String((req.body ?? {}).lostReason ?? "").trim();
  if (to.isLost && !reason) return res.status(400).json({ error: "Say why it was lost — that is the whole value of recording it" });

  /**
   * THE STAGE'S CHECKLIST GATES THE MOVE OUT OF IT.
   *
   * Checked against the stage the deal is LEAVING, not the one it is entering: a list is what this
   * column asks you to have finished before the deal goes any further.
   *
   * Losing a deal is exempt on purpose. A deal that dies is precisely the one whose paperwork was
   * never finished, and refusing to record the loss until the client sends documents they are never
   * going to send would push people to leave dead deals sitting in the pipeline — which corrupts
   * every open-pipeline figure on the board to keep a checklist tidy.
   */
  if (!to.isLost) {
    const company = await prisma.company.findUnique({ where: { id: opp.companyId } });
    const outstanding = await blockersFor(opp, company, opp.stage);
    if (outstanding.length) {
      return res.status(409).json({
        // NAMED, every one of them. "Checklist incomplete" sends somebody hunting; the list tells
        // them what to go and get.
        error: `${opp.stage?.name ?? "This stage"} still needs: ${outstanding.map(i => i.label).join(", ")}`,
        blockers: outstanding.map(i => ({ key: i.key, label: i.label, source: i.source, docType: i.docType })),
        canWaive: true,
      });
    }
  }

  const now = new Date().toISOString();
  // Reads BEFORE the transaction — they need no atomicity and would only hold it open.
  const snapshotCompany = await prisma.company.findUnique({ where: { id: opp.companyId } });
  const snapshot = await itemsForStage(to, opp, snapshotCompany);

  /**
   * ONE TRANSACTION for the three writes that must not disagree: the stage change, the history row
   * that records it, and the follow-up swap (retire the old stage's chase, book the new one).
   * A move whose transition never landed makes the analytics confidently wrong; a move whose old
   * chase survived leaves somebody hounding a client about a stage the deal has left.
   *
   * Deliberately NOT in here: the activity line and the win notification. Rolling back a legitimate
   * won deal because a toast failed to insert would be worse than the toast missing.
   */
  const { moved, booked } = await prisma.$transaction(async (tx) => {
    const moved = await tx.opportunity.update({
      where: { id: opp.id },
      data: {
        stageId: to.id, stageAt: now,
        lostReason: to.isLost ? reason : null,
        closedAt: to.isWon || to.isLost ? now : null,
        // SNAPSHOT on arrival. Editing a stage's rule afterwards must not retroactively change what
        // a deal already sitting in it was asked for — the same rule the workflow engine applies to
        // a task's checklist, and for the same reason: people plan around what they were told.
        checklist: snapshot as any,
        // The state belongs to the list it was ticked against. Carrying manual ticks into a
        // different stage's list would mark items nobody ever looked at, and the keys are not even
        // guaranteed to mean the same thing.
        checklistState: {} as any,
        checklistWaived: {} as any,
      },
      include: { stage: true, company: { select: { name: true } } },
    });
    await recordTransition(tx, {
      opportunityId: opp.id, fromStageId: opp.stageId, toStageId: to.id,
      movedById: (req as any).auth?.sub ?? null, at: now,
      lostReason: to.isLost ? reason : null,
    });
    // The stage's own chase window: books the follow-up this stage asks for, and retires the one
    // the previous stage booked. Only ever touches rule-created commitments — and now fails WITH
    // the move rather than leaving a half-moved deal.
    const booked = await applyStageFollowUp(moved as any, to, (req as any).auth?.sub, tx);
    return { moved, booked };
  });

  const st = statusOf(to);
  logActivity({
    type: "sales",
    message: `Deal ${st === "won" ? "won" : st === "lost" ? "lost" : "moved"}: ${moved.title} (${(moved as any).company?.name}) → ${to.name}${reason ? ` — ${reason}` : ""}`,
    user: (req as any).auth?.email,
  });
  if (st === "won") logNotification({ type: "system", title: "Deal won", message: `${moved.title} — ${(moved as any).company?.name}` });
  // Say what was booked. A follow-up that appears in somebody's queue without the move that caused
  // it having mentioned it is the kind of thing people assume is a bug.
  res.json({ ...(await withMoney(moved as any)), followUp: booked ? { action: booked.nextAction, due: booked.nextActionAt } : null });
});

/**
 * Raise the quotation for a deal.
 *
 * From here on the QUOTATION holds the money and this deal reads it — see withMoney. The estimate
 * typed on the card was always a guess, and leaving both live is how a board says SAR 40,000 while
 * the document the client signed says something else.
 *
 * Accepting that quotation is what wins the deal; nobody has to remember to drag the card.
 */
app.post("/api/opportunities/:id/quote", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id }, include: { stage: true, company: true } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(opp.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  if (opp.quotationId) {
    const existing = await prisma.quotation.findUnique({ where: { id: opp.quotationId } });
    if (existing) return res.status(409).json({ error: `Quotation ${existing.number} was already raised from this deal.` });
  }
  if (statusOf(opp.stage) !== "open") return res.status(409).json({ error: "This deal is already closed." });

  const b = req.body ?? {};
  const items = Array.isArray(b.items) && b.items.length
    ? b.items
    : [{ name: opp.title, units: 1, price: (opp.valueMinor ?? 0) / 100 }];
  const gross = items.reduce((n: number, it: any) => n + (Number(it.price) || 0) * (Number(it.units) || 1), 0);
  // The same figure helper the rest of the money paths use, so VAT is worked out one way only —
  // and at the CONFIGURED rate, not one passed in from the caller.
  const figures = await figuresFromAmount(gross);

  const q = await prisma.quotation.create({
    data: {
      number: await nextNumber("quotation"),
      companyId: opp.companyId, clientName: opp.company.name,
      service: opp.title, items,
      amount: Math.round(figures.totalMinor / 100),
      subtotalMinor: figures.subtotalMinor, vatMinor: figures.vatMinor, totalMinor: figures.totalMinor, vatRateBp: figures.vatRateBp,
      status: "draft", date: new Date().toISOString().slice(0, 10),
      validUntil: b.validUntil || null, notes: b.notes || null,
    },
  });
  await prisma.opportunity.update({ where: { id: opp.id }, data: { quotationId: q.id } });
  logActivity({ type: "sales", message: `Quotation ${q.number} raised for ${opp.title} (${opp.company.name})`, user: (req as any).auth?.email });
  res.status(201).json({ quotation: q, opportunity: await withMoney({ ...opp, quotationId: q.id } as any) });
});

app.delete("/api/opportunities/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const opp = await prisma.opportunity.findUnique({ where: { id: req.params.id } });
  if (!opp) return res.status(404).json({ error: "Deal not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(opp.companyId)) return res.status(403).json({ error: "Not one of your clients" });
  // A deal that HAPPENED is not deleted — move it to the lost column, which keeps it in the loss
  // report. Deleting would quietly improve the win rate, which is the one number this is for.
  if (opp.quotationId) return res.status(409).json({ error: "A quotation was raised from this deal. Move it to the lost column instead — deleting it would take it out of the win-rate figures." });
  await prisma.opportunity.delete({ where: { id: opp.id } });
  await logAudit({ action: "opportunity.delete", actorId: (req as any).auth?.sub, target: opp.id, detail: opp.title, ip: clientIp(req) });
  res.json({ ok: true });
});

/**
 * Open a deal for a company, pre-filled from what is already known about it.
 *
 * WHY THIS IS A BUTTON AND NOT A RULE
 *
 * Whether there is business worth pursuing is a judgement somebody makes after speaking to people. A
 * rule that opened a deal for every lead would fill the board with cards nobody had thought about,
 * and a forecast built on those is worse than no forecast. What IS automatable is the friction —
 * finding the company, typing a title, remembering the owner — so all of that is done here.
 *
 * Refuses when an open deal already exists: two live cards for one conversation is how a pipeline
 * starts double-counting the same money.
 */
app.post("/api/companies/:id/open-deal", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const co = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!co) return res.status(404).json({ error: "Company not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(co.id)) return res.status(403).json({ error: "Not one of your clients" });
  const out = await openDealFor(co, {
    title: (req.body ?? {}).title,
    actor: (req as any).auth?.sub,
    homeCountry: (await homeCountry()),
    numberFor: () => nextNumber("opportunity"),
  });
  if ("skipped" in out) {
    const message = out.skipped === "no-stages"
      ? `No pipeline stages are set up for ${countryName(co.country ?? (await homeCountry()))}. Add them under Sales Settings first.`
      : out.skipped === "lost"
        ? `${co.name} is marked lost. Reopen it before opening a deal.`
        : `${co.name} ${out.detail}.`;
    return res.status(409).json({ error: message });
  }

  logActivity({ type: "sales", message: `Deal opened for ${co.name}: ${out.deal.title}`, user: (req as any).auth?.email });
  res.status(201).json(await withMoney(out.deal as any));
});

/**
 * Move a company along the lifecycle: lead → prospect → client, or out to lost / churned.
 *
 * This is the only route that may write `lifecycle`, and it is where the two things that must happen
 * exactly once happen: the CR number is captured on the way in to `client`, and the portal login is
 * provisioned at that same moment and never before. A lead with a portal account could sign in and
 * look at an empty client portal for a firm that has not agreed to work with them yet.
 */
/**
 * How this company came to its current owner — the answer to "why did this lead come to me?".
 *
 * Scoped like everything else: a sales user can read the history of a company in their own book,
 * which is precisely the one they are asking about.
 */
app.get("/api/companies/:id/assignments", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(req.params.id)) return res.status(403).json({ error: "Not one of your clients" });
  try {
    res.json(await assignmentHistory(req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});

app.post("/api/companies/:id/lifecycle", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const co = await prisma.company.findUnique({ where: { id: req.params.id } });
  if (!co) return res.status(404).json({ error: "Company not found" });
  const scoped = await salesCompanyIds(req as any);
  if (scoped && !scoped.includes(co.id)) return res.status(403).json({ error: "Not one of your clients" });

  const to = String((req.body ?? {}).to ?? "").trim();
  if (!LIFECYCLES.includes(to)) return res.status(400).json({ error: `Lifecycle must be one of: ${LIFECYCLES.join(", ")}` });
  if (to === co.lifecycle) return res.status(409).json({ error: `Already ${to}` });

  const cr = String((req.body ?? {}).cr ?? co.cr ?? "").trim();
  const lostReason = String((req.body ?? {}).lostReason ?? "").trim();
  // Both of these are refused rather than defaulted. A CR invented here is a fake number on a real
  // client; a blank lost-reason makes the one report that could improve next quarter useless.
  if (to === ACTIVE_CLIENT && !cr) return res.status(400).json({ error: "A CR number is required to make this a client" });
  if ((to === "lost" || to === "churned") && !lostReason) return res.status(400).json({ error: "Say why it was lost — that is the whole value of recording it" });

  // The change and its history row commit or fail together — a company whose current state
  // disagrees with the last line of its own record is the one inconsistency this table cannot
  // survive, because every conversion figure is computed from these rows.
  // Qualification, offered at promotion and never demanded: a promotion with none recorded is
  // legitimate — somebody in a hurry is not forced to invent a budget. Every field is optional,
  // but what IS sent is validated rather than stored raw.
  const q = (req.body ?? {}).qualification;
  let qual: Record<string, unknown> | null = null;
  if (to === "prospect" && q && typeof q === "object") {
    const budget = q.budget === "" || q.budget == null ? null : Math.round(Number(q.budget) * 100);
    if (budget != null && (!Number.isFinite(budget) || budget < 0)) return res.status(400).json({ error: "The budget has to be a number" });
    const priority = String(q.priority ?? "").trim();
    if (priority && !["low", "medium", "high"].includes(priority)) return res.status(400).json({ error: "Priority is low, medium or high" });
    const dmId = String(q.decisionMakerId ?? "").trim();
    if (dmId) {
      // The decision maker must be one of THIS company's contacts — a contact id from another
      // company would silently attach a stranger to the file.
      const dm = await prisma.contact.findUnique({ where: { id: dmId }, select: { companyId: true } });
      if (!dm || dm.companyId !== co.id) return res.status(400).json({ error: "Pick the decision maker from this company's contacts" });
    }
    const fields = {
      qualRequirement: String(q.requirement ?? "").trim() || null,
      qualBudgetMinor: budget,
      qualDecisionBy: String(q.decisionBy ?? "").trim() || null,
      qualDecisionMakerId: dmId || null,
      qualCurrentSolution: String(q.currentSolution ?? "").trim() || null,
      qualPriority: priority || null,
    };
    // Only counts as a qualification if SOMETHING was said — six empty fields stamped with a date
    // would claim an interview that never happened.
    if (Object.values(fields).some(v => v != null)) qual = { ...fields, qualAt: new Date().toISOString() };
  }

  const nowLc = new Date().toISOString();
  const company = await prisma.$transaction(async (tx) => {
    const updated = await tx.company.update({
      where: { id: co.id },
      data: {
        lifecycle: to,
        cr: to === ACTIVE_CLIENT ? cr : co.cr,
        lostReason: to === "lost" || to === "churned" ? lostReason : null,
        // Taken on the day they became a client, not the day the lead was typed in.
        createdAt: to === ACTIVE_CLIENT && !co.createdAt ? nowLc : co.createdAt,
        ...(qual ?? {}),
      },
    });
    await recordLifecycle(tx, {
      companyId: co.id, from: co.lifecycle, to,
      changedById: a?.sub ?? null, at: nowLc,
      reason: to === "lost" || to === "churned" ? lostReason : null,
    });
    return updated;
  });

  // The portal login, once, on becoming a client. Same rules as the create route: only with a real
  // address, only if that address is not already a user. The account is created with NO password —
  // the invitation link they receive is what sets the first one. See invitations.ts.
  let portalInvite: InviteResult | null = null;
  if (to === ACTIVE_CLIENT) {
    const email = String(company.email || "").toLowerCase();
    if (email.includes("@")) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const pu = await prisma.user.create({
          data: {
            name: company.contact ?? company.name, email, roleId: "client_admin", status: "active",
            lastActive: null, type: "portal", companyId: company.id,
            passwordHash: null, mustChangePassword: true,
          },
        });
        portalInvite = await sendInvitation(pu, { companyName: company.name, invitedBy: a?.email });
        await logAudit({ action: "portal.invited", actorId: a?.sub, target: pu.email, detail: `${company.name} · ${portalInvite.emailed ? "emailed" : "not emailed"}`, ip: clientIp(req) });
      }
    }
  }

  // Promoting to prospect is the moment somebody says there is something here, which is exactly
  // when a deal should exist. Done only when ASKED — the console ticks the box for them and lets
  // them untick it, because a card appearing on the board that nobody chose is how a forecast stops
  // being trusted.
  let openedDeal: { title: string; number: string | null } | null = null;
  if ((req.body ?? {}).openDeal === true) {
    const made = await openDealFor(company, {
      title: (req.body ?? {}).dealTitle,
      actor: a?.sub,
      homeCountry: (await homeCountry()),
      numberFor: () => nextNumber("opportunity"),
      // The deal starts from what qualification learned. From here on the DEAL owns its copies —
      // editing the company's qualification later must not reprice a deal in flight, the same
      // snapshot rule the stage checklist follows.
      valueMinor: (qual?.qualBudgetMinor as number | null) ?? null,
      expectedCloseDate: (qual?.qualDecisionBy as string | null) ?? null,
      notes: (qual?.qualRequirement as string | null) ?? null,
    });
    // A refusal here is not a failure of the lifecycle change: the company has still moved, and the
    // reason it could not have a deal is reported alongside rather than losing the whole request.
    if ("deal" in made) openedDeal = { title: made.deal.title, number: made.deal.number };
    else logActivity({ type: "sales", message: `No deal opened for ${company.name} — ${made.detail}`, user: "System" });
  }

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  logActivity({ type: "client", message: `${co.name}: ${co.lifecycle} → ${to}${lostReason ? ` (${lostReason})` : ""}`, user: me?.name ?? "Staff" });
  await logAudit({ action: "company.lifecycle", actorId: a.sub, target: co.id, detail: `${co.name}: ${co.lifecycle} → ${to}`, ip: clientIp(req) });
  if (to === ACTIVE_CLIENT) logNotification({ type: "system", title: "New client won", message: company.name });
  res.json({ company, ...(portalInvite ? { portalInvite } : {}), ...(openedDeal ? { openedDeal } : {}) });
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

  // An add-on invoice can be voided for two opposite reasons — re-billing it at a different price,
  // or cancelling the add-on altogether. Guessing either way is wrong: keeping it silently gives
  // the service away free, dropping it silently takes a service off a client mid-use. The caller
  // says which, and `keep` is the default so a plain re-bill behaves as it always did.
  let addonRemoved = false;
  if (inv.addonServiceId && (req.body ?? {}).addon === "remove") {
    addonRemoved = await removeAddonFor(inv.companyId, inv.addonServiceId, a.sub, `invoice ${inv.number} voided — ${reason}`);
  }
  // Stop it chasing: the ladder rungs and any arrangement are meaningless once it's cancelled.
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: `dunning:${inv.id}:` } } });
  logActivity({ type: "finance", message: `Invoice ${inv.number} voided — ${reason}`, user: me?.name ?? "Staff" });
  await logAudit({ action: "invoice.void", actorId: a.sub, target: inv.id, detail: `${inv.number} · ${inv.currency} ${inv.amount} · ${reason}` });
  res.json({ invoice, addonRemoved });
});

/**
 * Take an add-on off a client's subscription. Shared by the "Remove" control on the client's plan
 * and by voiding the invoice that paid for it, so both routes leave the same state behind.
 * Returns whether anything was actually removed — callers report honestly rather than claiming it.
 */
async function removeAddonFor(companyId: string | null, serviceId: string, actorId: string, why: string) {
  if (!companyId) return false;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { groupId: true, name: true } });
  const subs = await subsFor(companyId, company?.groupId);
  const target = subs.find(s => Array.isArray(s.addons) && (s.addons as any[]).some(x => x?.serviceId === serviceId));
  if (!target) return false;
  const addons = (target.addons as any[]).filter(x => x?.serviceId !== serviceId);
  const gone = (target.addons as any[]).find(x => x?.serviceId === serviceId);
  await prisma.subscription.update({ where: { id: target.id }, data: { addons } });
  // The approved request goes back to being undecided rather than staying "approved" for a service
  // the client no longer has — otherwise the portal would refuse to let them ask for it again.
  await prisma.upgradeRequest.updateMany({
    where: { companyId, kind: "addon", serviceId, status: "approved" },
    data: { status: "withdrawn" },
  });
  logActivity({ type: "finance", message: `Add-on removed: ${gone?.name ?? "service"} for ${company?.name ?? "client"} — ${why}` });
  await logAudit({ action: "addon.remove", actorId, target: serviceId, detail: `${gone?.name ?? serviceId} · ${company?.name ?? companyId} · ${why}` });
  notifyAddonRemoved({ companyId, serviceName: gone?.name ?? null });
  return true;
}

/** Remove an add-on directly from the client's plan, independent of any invoice. */
app.post("/api/companies/:id/remove-addon", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const serviceId = String((req.body ?? {}).serviceId ?? "");
  if (!serviceId) return res.status(400).json({ error: "Which add-on?" });
  const reason = String((req.body ?? {}).reason ?? "").trim() || "removed by staff";
  const ok = await removeAddonFor(req.params.id, serviceId, a.sub, reason);
  if (!ok) return res.status(404).json({ error: "That add-on is not on this client's plan" });
  res.json({ ok: true });
});

/**
 * Retire a document that a newer one has replaced.
 *
 * The columns and the reader-side filtering already existed, but only the WORKFLOW engine ever wrote
 * them — so a document added by hand never retired the one it replaced, and a person ended up with
 * two live Passports, both counted, both driving renewal reminders. This is the same act, available
 * to a human.
 *
 * The old row is KEPT. Its number and expiry are the only record of what the person held before, and
 * a compliance system that forgets that has no audit trail. Every reader filters on
 * `supersededAt: null`, so exactly one document of a type stays authoritative for a subject.
 */
app.post("/api/documents/:id/supersede", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: "Document not found" });
  if (doc.supersededAt) return res.json({ document: doc, alreadySuperseded: true });

  // The replacement, when one is named, must be a real document for the SAME subject and type —
  // otherwise "replaced by" points at something unrelated and the trail lies.
  const byId = req.body?.replacedBy ? String(req.body.replacedBy) : null;
  if (byId) {
    const by = await prisma.document.findUnique({ where: { id: byId } });
    if (!by) return res.status(400).json({ error: "The replacing document no longer exists" });
    if (by.id === doc.id) return res.status(400).json({ error: "A document cannot replace itself" });
    if (by.docType !== doc.docType) return res.status(400).json({ error: `A ${by.docType} cannot replace a ${doc.docType}` });
    const sameSubject = by.employeeId && doc.employeeId ? by.employeeId === doc.employeeId : by.person === doc.person;
    if (!sameSubject) return res.status(400).json({ error: "That document belongs to a different person" });
  }

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const document = await prisma.document.update({
    where: { id: doc.id },
    data: { supersededAt: new Date().toISOString(), supersededById: byId },
  });
  logActivity({
    type: "compliance",
    message: `${doc.docType} for ${doc.person}: an older record (${doc.docNumber ?? "no number"}, exp ${doc.expiryDate ?? "none"}) was superseded`,
    user: me?.name ?? "Staff",
  });
  await logAudit({ action: "document.supersede", actorId: a.sub, target: doc.id, detail: `${doc.docType} · ${doc.person} · exp ${doc.expiryDate ?? "none"}` });
  res.json({ document });
});

/** Edit an employee's details, appending to the same history[] the exit flow writes. */
app.post("/api/employees/:id/edit", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const emp = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  const b = req.body ?? {};
  const nextName = String(b.name ?? "").trim();
  if (!nextName) return res.status(400).json({ error: "Name is required" });
  if (b.iqamaExpiry && isNaN(new Date(String(b.iqamaExpiry)).getTime()))
    return res.status(400).json({ error: "That expiry date isn't a valid date" });
  if (b.dob && isNaN(new Date(String(b.dob)).getTime()))
    return res.status(400).json({ error: "That date of birth isn't a valid date" });

  /**
   * Every field is OPTIONAL and omitting one leaves it alone.
   *
   * `undefined` means "not sent" and `null`/"" means "clear it" — a caller that only knows about
   * three fields (the old Edit dialog, a script) must not blank the eight it has never heard of.
   */
  const keep = <T>(sent: any, current: T, coerce: (v: any) => T): T =>
    sent === undefined ? current : coerce(sent);
  const str = (v: any) => (v == null ? null : String(v).trim() || null);

  // Record what actually changed, so the history is a diff rather than "edited".
  const changes: string[] = [];
  const note = (label: string, from: any, to: any) => {
    if (String(from ?? "") !== String(to ?? "")) changes.push(`${label}: ${from ?? "—"} → ${to ?? "—"}`);
  };

  const nextRole = keep(b.role, emp.role, str);
  const nextExpiry = keep(b.iqamaExpiry, emp.iqamaExpiry, str);
  const nextDob = keep(b.dob, emp.dob, str);
  const nextNat = keep(b.nationality, emp.nationality, str);
  const nextType = keep(b.employmentType, emp.employmentType, str);
  const nextCat = keep(b.jobCategory, emp.jobCategory, str);
  // Minor units, like every other money value here — a salary held as a float is the rounding bug
  // the invoices already had, waiting to happen against a wage floor.
  const nextSalary = b.salary === undefined ? emp.salary
    : (b.salary === null || b.salary === "" ? null : Math.round(Number(b.salary)));
  if (nextSalary != null && !Number.isFinite(nextSalary)) return res.status(400).json({ error: "That salary isn't a number" });

  const cur: any = (emp.customData && typeof emp.customData === "object") ? emp.customData : {};
  const nextCustom = { ...cur };
  if (b.department !== undefined) nextCustom.department = str(b.department);
  if (b.joinDate !== undefined) nextCustom.joinDate = str(b.joinDate);
  if (b.visaQuota !== undefined) nextCustom.visaQuota = Number(b.visaQuota) || 1;

  note("name", emp.name, nextName);
  note("role", emp.role, nextRole);
  note("Iqama expiry", emp.iqamaExpiry, nextExpiry);
  note("date of birth", emp.dob, nextDob);
  note("nationality", emp.nationality, nextNat);
  note("salary", emp.salary, nextSalary);
  note("employment type", emp.employmentType, nextType);
  note("job category", emp.jobCategory, nextCat);
  note("department", cur.department, nextCustom.department);
  note("joining date", cur.joinDate, nextCustom.joinDate);
  note("visa quota", cur.visaQuota, nextCustom.visaQuota);
  if (!changes.length) return res.json({ employee: emp, unchanged: true });

  const me = await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true } });
  const employee = await prisma.employee.update({
    where: { id: emp.id },
    data: {
      name: nextName, role: nextRole, iqamaExpiry: nextExpiry,
      dob: nextDob, nationality: nextNat, salary: nextSalary,
      employmentType: nextType, jobCategory: nextCat, customData: nextCustom,
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

// ── Quotation → invoice ──────────────────────────────────────────────
// An accepted quotation used to be a dead end: the only row action was Print, so someone retyped the
// figures into the invoice form with nothing linking the two. This raises the invoice from the
// quotation's own line items, as a DRAFT — the same lifecycle every other invoice follows, so it
// still has to be approved before the client is billed.
/**
 * Are this document type's prerequisites met for a given subject?
 *
 * ONE evaluator, on the server. The console carried its own copy of these rules for the New-task
 * dialog, so the same requirement could be judged two ways: the dialog let work start while the
 * nightly job held it, or the reverse. Attribute rules would have had to be written twice to match.
 *
 * Body: { docType, employeeId?, companyId? }  →  { unmet: [{ need, months, why }] }
 */
app.post("/api/prereq-check", requireAuth, requireStaff, async (req, res) => {
  try {
    const { docType, employeeId, companyId } = req.body ?? {};
    const dt = await prisma.documentType.findFirst({ where: { name: String(docType ?? "") } });
    if (!dt) return res.json({ unmet: [], note: "No such document type" });
    // The evaluator reads the SUBJECT off this shape, the same way it does for a real document.
    const subject = {
      companyId: companyId ? String(companyId) : null,
      employeeId: employeeId ? String(employeeId) : null,
      person: employeeId ? (await prisma.employee.findUnique({ where: { id: String(employeeId) }, select: { name: true } }))?.name ?? "" : "",
    };
    res.json({ unmet: await unmetPrereqs(dt, subject) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

/**
 * What the client actually sent with a request, and what is still missing.
 *
 * `missing` is computed against the service's own required list rather than left to the officer to
 * work out from a pile of files: chasing a client for a document that arrived three days ago is the
 * failure this whole feature exists to stop.
 */
app.get("/api/service-requests/:id/attachments", requireAuth, requireStaff, async (req, res) => {
  const rq = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
  if (!rq) return res.status(404).json({ error: "Not found" });
  const files = await prisma.requestAttachment.findMany({ where: { requestId: rq.id }, orderBy: { at: "asc" } });
  // Match on the agreed service where one was chosen, else on the typed name.
  const svc = rq.serviceItemId
    ? await prisma.serviceItem.findUnique({ where: { id: rq.serviceItemId } })
    : await prisma.serviceItem.findFirst({ where: { name: String(rq.type ?? "") } });
  const required: any[] = Array.isArray(svc?.requiredDocs) ? (svc!.requiredDocs as any[]) : [];
  const have = new Set(files.map(f => f.docKey));
  res.json({
    files,
    required,
    missing: required.filter(d => d && d.required !== false && !have.has(d.key)).map(d => ({ key: d.key, label: d.label })),
  });
});

// What accepting would do. Read-only, so it needs no write role: an officer who can see the queue
// should be able to see what a decision entails, whether or not they are the one allowed to take it.
app.get("/api/service-requests/:id/accept-preview", requireAuth, requireStaff, async (req, res) => {
  try {
    const svcId = req.query.serviceItemId ? String(req.query.serviceItemId) : null;
    res.json(await previewAcceptServiceRequest(req.params.id, svcId));
  } catch (e: any) {
    res.status(404).json({ error: String(e?.message ?? e) });
  }
});

// Accept a client request and turn it into work. See delivery.ts for why this mirrors quotation
// delivery so exactly: they are two doors into the same thing, and behaving differently at one of
// them is how a client's request quietly becomes nobody's job.
app.post("/api/service-requests/:id/accept", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { serviceItemId, assignee, dueDate } = req.body ?? {};
    const out = await acceptServiceRequest(req.params.id, {
      actor: a?.email ?? a?.sub,
      serviceItemId: serviceItemId ? String(serviceItemId) : null,
      assignee: assignee ? String(assignee) : null,
      dueDate: dueDate ? String(dueDate) : null,
    });
    await logAudit({ action: "request.accepted", actorId: a?.sub, target: req.params.id, detail: [out.taskRef, out.serviceName, out.workflowInstanceId ? "run started" : "no run"].filter(Boolean).join(" · ") });
    res.json(out);
  } catch (e: any) {
    // "Already accepted" is a conflict, not a server fault — the console shows it as a plain message.
    const msg = String(e?.message ?? e);
    res.status(/already accepted/i.test(msg) ? 409 : 400).json({ error: msg });
  }
});

// Rejecting used to be a bare status flip with nothing recorded and nothing the client could read.
// The reason is required, and it is written where the portal can show it.
app.post("/api/service-requests/:id/reject", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const reason = String((req.body ?? {}).reason ?? "").trim();
  if (!reason) return res.status(400).json({ error: "A reason is required — the client sees it" });
  try {
    const rq = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!rq) return res.status(404).json({ error: "Request not found" });
    const done = await prisma.task.findFirst({ where: { requestId: rq.id } });
    if (done) return res.status(409).json({ error: `Work has already started for this request (${done.ref ?? done.title})` });
    const out = await prisma.serviceRequest.update({ where: { id: rq.id }, data: { status: "rejected", rejectedReason: reason } });
    await logAudit({ action: "request.rejected", actorId: a?.sub, target: rq.id, detail: reason.slice(0, 200) });
    logActivity({ type: "client", message: `Request ${rq.number ?? ""} rejected — ${reason}`.trim(), user: a?.email });
    // The reason is required precisely so it can be sent — a decline the client only discovers by
    // refreshing the portal is the thing this replaces.
    notifyRequestRejected({
      companyId: rq.companyId ?? null,
      number: rq.number ?? null,
      serviceName: String(rq.type ?? "") || null,
      reason,
    });
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

app.post("/api/quotations/:id/convert", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const q = await prisma.quotation.findUnique({ where: { id: req.params.id } });
  if (!q) return res.status(404).json({ error: "Quotation not found" });
  const st = String(q.status).toLowerCase();
  if (st === "invoiced") return res.status(409).json({ error: `${q.number} has already been invoiced` });
  if (st !== "accepted") return res.status(409).json({ error: `${q.number} is ${st} — only a quotation the client accepted can be invoiced` });
  // Read the stored total where there is one: `amount` is whole riyals, so a quotation under SAR 0.50
  // rounds to 0 there and would be refused despite having a real figure.
  const qGross = q.totalMinor != null ? Number(q.totalMinor) : Math.round((Number(q.amount) || 0) * 100);
  if (!(qGross > 0)) return res.status(400).json({ error: "That quotation has no amount to invoice" });
  // Belt and braces: the status check above can't see an invoice raised before `invoiced` was set.
  const already = await prisma.invoice.findFirst({ where: { quotationId: q.id } });
  if (already) return res.status(409).json({ error: `${q.number} was already invoiced as ${already.number}` });

  const number = await nextInvoiceNumber();

  const today = new Date().toISOString().slice(0, 10);
  const [invoice] = await prisma.$transaction([
    prisma.invoice.create({
      data: {
        number, companyId: q.companyId, clientName: q.clientName,
        // The quotation's own figures, carried across exactly. Re-deriving from `q.amount` would
        // reintroduce the rounding the quotation had already resolved, and the invoice would then
        // bill a different subtotal from the quotation the client accepted. Older quotations have no
        // stored figures, so those still fall back to splitting the amount — see money.ts.
        ...(q.totalMinor != null
          ? {
              subtotalMinor: q.subtotalMinor, vatMinor: q.vatMinor,
              totalMinor: q.totalMinor, vatRateBp: q.vatRateBp,
              amount: Math.round(q.totalMinor / 100),
            }
          : await figuresFromAmount(q.amount)),
        status: "draft", date: today,
        services: q.service ?? null, items: q.items ?? [], notes: q.notes ?? null,
        quotationId: q.id,
      },
    }),
    prisma.quotation.update({ where: { id: q.id }, data: { status: "invoiced" } }),
  ]);
  logActivity({ type: "finance", message: `Invoice ${number} raised from quotation ${q.number}${q.clientName ? ` — ${q.clientName}` : ""}` });
  await logAudit({ action: "quotation.convert", actorId: a.sub, target: q.id, detail: `${q.number} → ${number}` });
  res.status(201).json({ invoice });
});

// ── Manual SLA escalation ────────────────────────────────────────────
// The SLA Monitor's "Escalate" used to be a setState that flipped the row to "Escalated ✓ · manager
// notified" — nobody was notified and the flag died on reload. This does what the hourly escalateSla
// job does for an automatic breach: raise the task's priority, stamp escalatedAt, and tell the
// admins. Persistence comes from those columns (and, for a compliance document, from the
// notification's dedupeKey) rather than from browser state, so a reload shows the truth.
app.post("/api/sla/escalate", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const { taskId, docId, label, note } = req.body ?? {};
  const who = (await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true, email: true } }))
    ?? { name: null, email: null };
  const byLine = `Escalated by ${who.name || who.email || "a staff user"}${note ? ` — ${note}` : ""}`;

  if (taskId) {
    const t = await prisma.workflowTask.findUnique({ where: { id: taskId }, include: { instance: { select: { clientName: true } } } });
    if (!t) return res.status(404).json({ error: "That step no longer exists — refresh the board" });
    if (t.status !== "active") return res.status(409).json({ error: "That step is already closed" });
    if (t.escalatedAt) return res.status(409).json({ error: "Already escalated" });
    const stamp = new Date().toISOString();
    await prisma.workflowTask.update({ where: { id: t.id }, data: { priority: "urgent", escalatedAt: stamp, slaState: "breached" } });
    const title = `Escalated: ${t.title}${t.instance?.clientName ? ` (${t.instance.clientName})` : ""}`;
    await logAudit({ action: "sla.escalate", actorId: a.sub, target: t.id, detail: `${t.title}${note ? ` · ${note}` : ""}` });
    notify({ rule: "SLA breached", audience: "staff",
      inApp: { type: "overdue", title, message: byLine },
      subject: title, heading: "A step has been escalated",
      lines: [byLine, `Step: <b>${t.title}</b>`, "Priority raised to urgent. Open the SLA Monitor to reassign or re-prioritise."] });
    return res.json({ ok: true, escalatedAt: stamp, priority: "urgent" });
  }

  if (docId) {
    const d = await prisma.document.findUnique({ where: { id: docId } });
    if (!d) return res.status(404).json({ error: "That document no longer exists — refresh the board" });
    const title = `Escalated: ${d.docType} — ${d.person}`;
    // dedupeKey doubles as the persisted "already escalated" flag for documents, which have no
    // escalatedAt column of their own.
    try {
      await prisma.notification.create({
        data: { type: "overdue", title, message: byLine, time: "Just now", createdAt: new Date().toISOString(), read: false, dedupeKey: `sla-esc:doc:${d.id}` },
      });
    } catch {
      return res.status(409).json({ error: "Already escalated" });
    }
    await logAudit({ action: "sla.escalate", actorId: a.sub, target: d.id, detail: `${d.docType} — ${d.person}${note ? ` · ${note}` : ""}` });
    notify({ rule: "SLA breached", audience: "staff",
      subject: title, heading: "A compliance document has been escalated",
      lines: [byLine, `Document: <b>${d.docType} — ${d.person}</b>`,
        d.expiryDate ? `Expiry: ${d.expiryDate}` : "No expiry date recorded.",
        "Open Compliance to act on this document."] });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "Nothing to escalate" });
});

// ── Invoice approval ─────────────────────────────────────────────────
// Every invoice is created as a DRAFT and only becomes a real receivable once someone approves it.
// That is what makes the draft stage safe to edit: nothing has been sent, nothing is owed, and the
// client has not been told about it. Approval is the single moment the bill becomes real, so it is
// also the only place the "you have been invoiced" email goes out.
app.post("/api/invoices/:id/approve", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const inv = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!inv) return res.status(404).json({ error: "Invoice not found" });
  if (String(inv.status).toLowerCase() !== "draft")
    return res.status(409).json({ error: `${inv.number} is already approved` });
  if (!inv.companyId && !inv.clientName)
    return res.status(400).json({ error: "Set a client before approving this invoice" });
  if (!(Number(inv.amount) > 0))
    return res.status(400).json({ error: "An invoice with no amount cannot be approved" });
  // Conditional update, not a plain update: read-then-write leaves a window where two clicks both
  // pass the check above and the client is emailed the same invoice twice. Only the request that
  // actually flips the row out of `draft` goes on to notify.
  const claimed = await prisma.invoice.updateMany({ where: { id: inv.id, status: "draft" }, data: { status: "pending" } });
  if (claimed.count === 0) return res.status(409).json({ error: `${inv.number} is already approved` });
  const invoice = await prisma.invoice.findUnique({ where: { id: inv.id } });
  if (!invoice) return res.status(404).json({ error: "Invoice not found" });
  logActivity({ type: "finance", message: `Invoice ${inv.number} approved${inv.clientName ? ` — ${inv.clientName}` : ""}` });
  await logAudit({ action: "invoice.approve", actorId: a.sub, target: inv.id, detail: `${inv.number} · ${inv.currency} ${inv.amount}` });
  notifyInvoiceRaised({ companyId: invoice.companyId, number: invoice.number, amount: invoice.amount, currency: invoice.currency, dueDate: invoice.dueDate });
  res.json({ invoice });
});

// An approved invoice is a document the client has been sent; editing it behind their back would
// make the copy they hold disagree with ours. Corrections go through void + reissue instead.
// Registered BEFORE the generic /api/invoices CRUD mount so it runs first and falls through on GET.
app.use("/api/invoices", requireAuth, requireStaff, async (req, res, next) => {
  if (req.method !== "PUT" && req.method !== "PATCH") return next();
  const id = req.path.replace(/^\//, "").split("/")[0];
  if (!id) return next();
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv) return next(); // let the CRUD layer answer 404 in its own shape
  if (String(inv.status).toLowerCase() !== "draft")
    return res.status(409).json({ error: `${inv.number} has been approved — void it and reissue to change it` });
  next();
});

// ── Money on a billing document is checked here, not only in the browser ──────────────────────
// The console refuses a negative price and a quantity below one, but that was the ONLY guard: a
// direct POST of `units: -5, price: -100` was accepted and stored a document totalling 575.00,
// because negative × negative is positive and nothing on this side looked. See
// billingAmountProblem() for why an invoice is never allowed to carry a negative line.
for (const route of ["/api/invoices", "/api/quotations"]) {
  app.use(route, requireAuth, requireStaff, (req, res, next) => {
    if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next();
    const problem = billingAmountProblem(req.body);
    return problem ? res.status(400).json({ error: problem }) : next();
  });
}

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
      data: { number: await nextNumber("request"), companyId: a.companyId, clientName: company?.name ?? null, type: "Payment notification",
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

  // Resolved before the transaction opens: it reads the same table the transaction writes to.
  const exitReqNo = await nextNumber("request");
  try {
    // Atomic: the request, the status freeze, and releasing any in-flight renewal must land together.
    // If the freeze were a second call that failed, we'd have an exit on file AND a renewal running.
    const [request] = await prisma.$transaction([
      prisma.serviceRequest.create({
        data: { number: exitReqNo, companyId: a.companyId, clientName: emp.company?.name ?? null, type: "Employee exit",
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

/** A client's own upgrade / add-on requests, so the portal can show what is already in review. */
app.get("/api/portal/upgrade-requests", requireAuth, requirePortal, async (req, res) => {
  const a = (req as any).auth;
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  res.json(await prisma.upgradeRequest.findMany({
    where: { companyId: a.companyId!, ...(kind ? { kind } : {}) },
    orderBy: { id: "desc" },
    take: 100,
  }));
});

/**
 * Client asks for ONE locked service to be added on top of the tier they already have, instead of
 * being pushed to a whole new package. No price is quoted here — staff set it at approval.
 */
app.post("/api/portal/addon-requests", requireAuth, requirePortal, requireNotSuspended, async (req, res) => {
  const a = (req as any).auth;
  try {
    const { serviceId, note } = req.body ?? {};
    if (!serviceId) return res.status(400).json({ error: "Pick a service" });
    const svc = await prisma.serviceItem.findUnique({ where: { id: String(serviceId) } });
    if (!svc) return res.status(404).json({ error: "That service is no longer in the catalog" });

    const company = await prisma.company.findUnique({ where: { id: a.companyId! } });
    const subs = await subsFor(a.companyId!, company?.groupId);
    // Already entitled? Then there is nothing to request — via the plan, or an earlier add-on.
    // Same rule the portal draws its locks from: the plan's service list decides, and nothing else.
    const entitled = subs.some(s => {
      const pkgIds = Array.isArray(s.package?.serviceIds) ? (s.package!.serviceIds as string[]) : [];
      const addons = Array.isArray(s.addons) ? (s.addons as any[]) : [];
      return pkgIds.includes(svc.id) || addons.some(x => x?.serviceId === svc.id);
    });
    if (entitled) return res.status(409).json({ error: `${svc.name} is already available on your plan` });

    // One open request per service — a client clicking twice must not create a second review item.
    const open = await prisma.upgradeRequest.findFirst({
      where: { companyId: a.companyId!, kind: "addon", serviceId: svc.id, status: { in: ["pending", "escalated"] } },
    });
    if (open) return res.status(409).json({ error: `You have already requested ${svc.name} — it is with your PRO team` });

    const created = await prisma.upgradeRequest.create({
      data: {
        companyId: a.companyId!, clientName: company?.name ?? "", kind: "addon",
        serviceId: svc.id, serviceName: svc.name, note: note ?? null,
        status: "pending", date: new Date().toISOString().slice(0, 10),
      },
    });
    // Put it on the pipeline. A client asking to buy something is the strongest buying signal this
    // product ever gets, and until now it landed entirely outside the board — approved, invoiced,
    // and counted in the accounts having never been in a forecast.
    const boarded = await dealForAddonRequest(created, { homeCountry: (await homeCountry()), numberFor: () => nextNumber("opportunity") })
      .catch(e => { console.error("could not board the add-on request", e); return null; });

    logActivity({ type: "finance", message: `${company?.name ?? "A client"} requested the add-on "${svc.name}"${boarded ? " — on the board as a deal" : ""}`, user: company?.name ?? "Client" });
    notify({
      rule: "Approval requested", audience: "staff",
      inApp: { type: "task", title: `Add-on requested — ${company?.name ?? "client"}`, message: svc.name },
      subject: `Add-on requested: ${svc.name}`,
      heading: "A client wants a service added to their plan",
      lines: [`Client: <b>${company?.name ?? "—"}</b>`, `Service: <b>${svc.name}</b>`,
        note ? `Note: ${note}` : "",
        "Approve it with a price to unlock the service for this client only and raise the invoice."],
    });
    res.status(201).json(created);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * Staff approve an add-on with the price they are charging THIS client.
 * Three things happen together: the service is attached to that client's own subscription, a one-off
 * draft invoice is raised for the fee, and the client is told. The add-on is written to
 * Subscription.addons and never to Package.serviceIds — the package is shared by every client on the
 * tier, so unlocking it there would hand the service to all of them.
 */
app.post("/api/upgrade-requests/:id/approve-addon", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const a = (req as any).auth;
  const price = Math.round(Number(req.body?.price));
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: "Enter the price for this add-on" });

  const reqRow = await prisma.upgradeRequest.findUnique({ where: { id: req.params.id } });
  if (!reqRow) return res.status(404).json({ error: "Request not found" });
  if (reqRow.kind !== "addon") return res.status(400).json({ error: "That is a package upgrade, not an add-on" });
  // Escalated is still undecided — it only means the queue flagged it as waiting too long.
  if (!["pending", "escalated"].includes(reqRow.status)) return res.status(409).json({ error: `That request is already ${reqRow.status}` });
  if (!reqRow.serviceId) return res.status(400).json({ error: "The request has no service on it" });

  const company = await prisma.company.findUnique({ where: { id: reqRow.companyId } });
  const subs = await subsFor(reqRow.companyId, company?.groupId);
  // Attach to the client's OWN subscription. A group-scoped subscription is shared by sibling
  // companies, so it is only used when the client has nothing of their own.
  const target = subs.find(s => s.companyId === reqRow.companyId || (s.scope === "company" && s.refId === reqRow.companyId)) ?? subs[0];
  if (!target) return res.status(409).json({ error: "That client has no active subscription to attach an add-on to" });

  const addons = Array.isArray(target.addons) ? (target.addons as any[]) : [];
  if (addons.some(x => x?.serviceId === reqRow.serviceId)) {
    return res.status(409).json({ error: "That service is already on this client's plan" });
  }

  const number = await nextInvoiceNumber();
  const today = new Date().toISOString().slice(0, 10);
  const label = `${reqRow.serviceName ?? "Service"} — plan add-on`;

  // Order matters: the invoice must be first so the destructure below picks it up. A zero-priced
  // add-on raises nothing, so there is no invoice to pick up either.
  const [maybeInvoice] = await prisma.$transaction([
    // Draft, like every other invoice: a human releases it.
    ...(price > 0 ? [prisma.invoice.create({
      data: {
        number, companyId: reqRow.companyId, clientName: company?.name ?? reqRow.clientName,
        ...(await figuresFromAmount(price)), status: "draft", date: today, services: label,
        items: [{ name: label, units: 1, price }],
        addonServiceId: reqRow.serviceId,
      },
    })] : []),
    prisma.subscription.update({
      where: { id: target.id },
      data: { addons: [...addons, { serviceId: reqRow.serviceId, name: reqRow.serviceName, price, addedAt: new Date().toISOString(), by: a.sub }] },
    }),
    prisma.upgradeRequest.update({ where: { id: reqRow.id }, data: { status: "approved", quotedPrice: price } }),
  ]);

  // The price somebody just agreed is what this deal was worth. Won here rather than left open, so
  // client-initiated business counts in the win rate instead of vanishing into the accounts.
  const wonDeal = await closeAddonDeal(reqRow.id, { won: true, priceMinor: price > 0 ? Math.round(price * 100) : null })
    .catch(e => { console.error("could not close the add-on deal", e); return null; });

  logActivity({ type: "finance", message: `Add-on approved: ${reqRow.serviceName} for ${company?.name ?? "client"}${price > 0 ? ` · ${price}` : " · no charge"}` });
  await logAudit({ action: "addon.approve", actorId: a.sub, target: reqRow.id, detail: `${reqRow.serviceName} → ${company?.name ?? reqRow.companyId} · ${price}` });
  notifyAddonApproved({ companyId: reqRow.companyId, serviceName: reqRow.serviceName, price, invoiceNumber: price > 0 ? number : null });
  res.json({ ok: true, addedTo: target.id, invoice: price > 0 ? (maybeInvoice as any) : null, deal: wonDeal ? { title: wonDeal.title, stage: wonDeal.stage.name } : null });
});

// ── Staff data API (authenticated staff; writes require admin/super_admin) ──
// Sales users only see the companies assigned to them.
app.get("/api/companies", requireAuth, requireStaff, requireReadRole("super_admin", "admin", "pro_officer", "sales"), async (req, res) => {
  const a = (req as any).auth;

  /**
   * Which lifecycles to return. Defaults to CLIENTS ONLY.
   *
   * The default is the safe one on purpose. Every existing caller of this route — the client list,
   * the invoice and employee pickers, the dashboard counts — was written when a Company was a client
   * by definition, and none of them says so out loud. Had the default been "everything", each of
   * those would have started quietly including leads the day the column shipped, and the first
   * anyone would know is a prospect appearing on an invoice.
   *
   *   ?lifecycle=lead,prospect   the CRM screens ask for what they want
   *   ?lifecycle=all             everything, for the combined list
   */
  const asked = String(req.query.lifecycle ?? "").trim();
  const lifecycle =
    asked === "all" ? undefined
    : asked ? { in: asked.split(",").map(s => s.trim()).filter(s => LIFECYCLES.includes(s)) }
    : ACTIVE_CLIENT;
  const where: any = lifecycle === undefined ? {} : { lifecycle };

  if (a.role === "sales") {
    // One filter, no id list: a salesperson's clients are simply the ones they own.
    return res.json(await withLiveCounts(await prisma.company.findMany({ where: { ...where, ownerId: a.sub }, take: 500 })));
  }
  // Live counts here too: this explicit route is registered BEFORE the generic CRUD, so it wins
  // for /api/companies and would otherwise still serve the stale stored columns.
  res.json(await withLiveCounts(await prisma.company.findMany({ where, take: 500 }))); // hard cap: this list was unbounded
});

// Create a company AND auto-provision a portal login for it. The password is RANDOM per client and
// shown once (see below) — this comment used to name a shared default that the code stopped using,
// which in a public repo is just a hint to go and try it.
app.post("/api/companies", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const vErr = validate("company", req.body, true);
  if (vErr) return res.status(400).json({ error: vErr });
  try {
    // Clients are created here, NOT through the generic CRUD path, so the country default has to be
    // stated in both places. Without it a client added tomorrow arrives with no country and silently
    // drops out of anything that filters by one — which is the whole point of having the column.
    // `contacts` is a relation, not a column — it arrives from the Add-client form as the people to
    // create alongside the company, and Prisma rejects it inside `data`.
    const { contacts: incomingContacts, ...body } = req.body ?? {};

    // The same rule as the edit route. Creating was the looser of the two, which is backwards — a
    // bad address typed once at creation is the one that never gets looked at again.
    for (const c of Array.isArray(incomingContacts) ? incomingContacts : []) {
      const problem = contactProblem(c);
      if (problem) return res.status(400).json({ error: problem });
    }

    // Nobody named an owner. A record with none is invisible to every sales user, so one is chosen —
    // but ONLY when the field is empty, and only when there is somebody in the rotation to choose.
    // An explicit owner, including a deliberate null from a manager who wants to allocate it later,
    // is never overridden: `ownerId` present in the body means somebody decided.
    let autoOwner: { id: string; name: string } | null = null;
    // The router's own words for WHY it chose this person ("Riyadh + Website"). It was already
    // computed and thrown away; it is the whole answer to "why did this lead come to me?".
    let autoOwnerWhy: string | null = null;
    if (!("ownerId" in body) || body.ownerId === undefined) {
      const rules = await salesRules();
      // Routed on the lead's own facts, falling back to workload when no rule matches.
      if (rules.autoAssignOwner) {
        const routed = await nextOwnerFor({
          source: body?.source ?? null, city: body?.city ?? null,
          country: body?.country ?? null, service: body?.service ?? null,
        });
        autoOwner = routed.owner;
        autoOwnerWhy = routed.why;
      }
    }

    const company = await prisma.company.create({
      data: { ...body, country: body?.country || (await homeCountry()), ...(autoOwner ? { ownerId: autoOwner.id } : {}) },
    });
    // The arrival row IS the capture date. `createdAt` could not carry it: its own comment says
    // "client since", the web intake stamped it at arrival anyway, and this route never stamped it
    // at all — three behaviours for one column. The history table has exactly one.
    await recordLifecycle(prisma, { companyId: company.id, to: company.lifecycle, changedById: (req as any).auth?.sub ?? null, at: new Date().toISOString() });
    // Whoever it landed on, and by which mechanism. An owner named in the request is a decision
    // somebody made; one chosen by the router is a rule firing, and the two must not look alike.
    if (company.ownerId) {
      await recordAssignment(prisma, {
        companyId: company.id, from: null, to: company.ownerId,
        assignedById: (req as any).auth?.sub ?? null,
        method: autoOwner ? "auto" : "manual",
        reason: autoOwner ? autoOwnerWhy : null,
      });
    }
    if (autoOwner) logActivity({ type: "sales", message: `${company.name} assigned to ${autoOwner.name}`, user: "System" });

    // The people. Created through addContact so the first one becomes primary and the company's
    // three mirror columns are written by the one function allowed to write them.
    for (const c of Array.isArray(incomingContacts) ? incomingContacts : []) {
      if (c && String(c.name ?? "").trim()) await addContact(company.id, c);
    }
    // No contacts sent, but the old-style columns were: keep them in step rather than leaving a
    // company whose mirror says one thing and whose contact list is empty.
    if (!Array.isArray(incomingContacts) && (company.contact || company.email || company.phone)) {
      await addContact(company.id, { name: company.contact || company.name, email: company.email, phone: company.phone });
    }

    // Only provision a portal user when there's a real email address (skip "—" placeholders).
    // The one-time password is random and returned ONCE here — it is never recoverable afterwards,
    // only re-issued via reset-portal-password.
    //
    // Not for a lead or a prospect: they have not agreed to anything, and an account that can sign
    // in to an empty portal is a support call at best. The login is provisioned when they become a
    // client, on the lifecycle route.
    let portalInvite: InviteResult | null = null;
    const email = company.lifecycle === ACTIVE_CLIENT ? String(company.email || "").toLowerCase() : "";
    if (email.includes("@")) {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (!existing) {
        const pu = await prisma.user.create({
          data: {
            name: company.contact ?? company.name,
            email,
            roleId: "client_admin",
            status: "active",
            lastActive: null,
            type: "portal",
            companyId: company.id,
            // No password at all until the invitation link is used — see invitations.ts.
            passwordHash: null,
            mustChangePassword: true,
          },
        });
        portalInvite = await sendInvitation(pu, { companyName: company.name, invitedBy: (req as any).auth?.email });
        await logAudit({ action: "portal.invited", actorId: (req as any).auth?.sub, target: pu.email, detail: `${company.name} · ${portalInvite.emailed ? "emailed" : "not emailed"}`, ip: clientIp(req) });
      }
    }
    // Say what actually happened. A lead announced as an onboarded client is a message the whole
    // office reads and acts on — somebody opens the file expecting signed paperwork.
    const isClient = company.lifecycle === ACTIVE_CLIENT;
    logActivity({
      type: isClient ? "client" : "sales",
      message: isClient ? `New client onboarded: ${company.name}` : `New ${company.lifecycle}: ${company.name}`,
      user: (req as any).auth?.email,
    });
    if (isClient) logNotification({ type: "system", title: "New client added", message: company.name });
    res.status(201).json(portalInvite ? { ...company, portalInvite } : company);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Encrypted credential vault (staff): list without secret, dedicated reveal, encrypt on create
app.get("/api/credentials", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (_req, res) => {
  const creds = await prisma.siteCredential.findMany({ take: 500 }); // hard cap
  res.json(creds.map(({ password, ...rest }: any) => rest));
});
app.get("/api/credentials/:id/reveal", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireHuman, async (req, res) => {
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
app.post("/api/users", requireAuth, requireStaff, requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  const { name, email, roleId, password, status, type, mustChangePassword, companyId } = req.body ?? {};
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
        // An invited account has NO password — the emailed link is what sets the first one.
        passwordHash: invite ? null : await hashPassword(String(password)),
        mustChangePassword: invite ? (mustChangePassword !== false) : !!mustChangePassword,
      },
    });
    const co = created.companyId ? await prisma.company.findUnique({ where: { id: created.companyId }, select: { name: true } }) : null;
    const inviteResult = invite ? await sendInvitation(created, { companyName: co?.name, invitedBy: a?.email }) : null;
    await logAudit({
      action: invite ? "user.invited" : "user.create", actorId: a?.sub, target: `${created.email} (${created.id})`,
      detail: `role ${created.roleId}${invite ? ` · invite ${inviteResult!.emailed ? "emailed" : "NOT emailed"}` : ""}`, ip: clientIp(req),
    });
    logActivity({ type: "client", message: `New team member created: ${created.name} — ${created.roleId}` });
    const { passwordHash, resetTokenHash, resetExpires, ...safe } = created as any;
    res.status(201).json({ ...safe, ...(inviteResult ? { invite: inviteResult } : {}) });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Activate / deactivate (suspend) a user. Deactivating bumps tokenVersion so any live sessions are
// invalidated immediately AND future logins are blocked (see the status gate in doLogin). Admin only.
app.put("/api/users/:id/status", requireAuth, requireStaff, requireWriteRole, requireHuman, async (req, res) => {
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

  // Outside the transaction: it reads the payments table, and deriving it inside would be reading
  // the same rows the transaction is about to write to.
  const receiptNo = await nextNumber("receipt");
  try {
    const [payment] = await prisma.$transaction([
      prisma.payment.create({
        data: {
          number: receiptNo,
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
  // Nationalisation bands per country — Nitaqat and its equivalents. Configuration, so it goes
  // through the same CRUD, country-scoping and retire rules as every other config table.
  ["workforce-bands", "workforceBand"],
  ["packages", "package"],
  ["subscriptions", "subscription"],
  ["employees", "employee"],
  ["documents", "document"],
  ["invoices", "invoice"],
  ["users", "user"],
  ["upgrade-requests", "upgradeRequest"],
  ["service-requests", "serviceRequest"],
  ["activities", "activity"],
  ["notifications", "notification"],
  ["document-types", "documentType"],
  ["custom-objects", "customObject"],
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
  users:         ["super_admin", "admin"],
};
// Row-level scope for the `sales` role: it may only touch the clients it owns. GET /api/companies
// filtered for sales already, but /:id and the client-owned collections did not — a scoped list with
// unscoped records is no restriction at all. `field` is the column that points at the company.
//
// Reads the owner column on the client, so this and the list route above answer "whose client is
// this?" the same way. They used to share a JSON array, which is how a scope and a list drift apart.
const salesScope = (field: "id" | "companyId"): ScopeFn => async (req: any) => {
  if (req.auth?.role !== "sales") return null; // every other role is gated by readRole above
  const mine = await prisma.company.findMany({ where: { ownerId: req.auth.sub }, select: { id: true } });
  return { [field]: { in: mine.map(c => c.id) } };
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
/**
 * The next invoice number, from the one place that knows all of them.
 *
 * The console used to build it as `4 + (number of invoices)`, which is not a sequence: delete or
 * void anything, or start from a non-contiguous set, and it hands back a number that already
 * exists. Two invoices sharing a number on a tax document is a real problem, and `number` has no
 * unique constraint to catch it.
 */
const nextInvoiceNumber = () => nextNumber("invoice");
app.get("/api/invoices/next-number", requireAuth, requireStaff, async (_req, res) => {
  res.json({ number: await nextInvoiceNumber() });
});

/** Same for quotations, which had the same count-based bug (`QT-` + 339 + how many exist). */
app.get("/api/quotations/next-number", requireAuth, requireStaff, async (_req, res) => {
  res.json({ number: await nextNumber("quotation") });
});
// Shipments raised by hand used to be numbered `CR- + Date.now().slice(-5)` in the browser — a
// timestamp wearing a reference's clothes, which collides and sorts by nothing useful. Same
// configured sequence as every other document now, and the same one the workflow's courier step uses.
app.get("/api/courier-shipments/next-number", requireAuth, requireStaff, async (_req, res) => {
  res.json({ number: await nextNumber("courier") });
});

// ── Record sequences: the configured shape of every document reference ──
// Returns the next number alongside each format so the screen can show what the change will
// actually produce, rather than a sample the sequence might not agree with.
app.get("/api/record-sequences", requireAuth, requireStaff, async (_req, res) => {
  const cfg = await getSequences();
  const preview: Record<string, string> = {};
  for (const k of SEQ_KINDS) preview[k] = await nextNumber(k);
  res.json({ sequences: cfg, next: preview });
});

app.put("/api/record-sequences", requireAuth, requireStaff, requireWriteRole, requireReadRole("super_admin", "admin"), async (req, res) => {
  const a = (req as any).auth;
  const saved = await saveSequences(req.body?.sequences ?? req.body);
  const preview: Record<string, string> = {};
  for (const k of SEQ_KINDS) preview[k] = await nextNumber(k);
  await logAudit({ action: "settings.record_sequences", actorId: a?.sub, detail: SEQ_KINDS.map(k => `${k}=${saved[k].pattern}`).join(" ") });
  logActivity({ type: "system", message: `Record sequences updated — ${SEQ_KINDS.map(k => `${SEQ_LABEL[k]} ${preview[k]}`).join(", ")}` });
  res.json({ sequences: saved, next: preview });
});

/**
 * A user telling us something went wrong — a dead URL, a crash, or a problem they hit and chose to
 * report. Deliberately accepts UNAUTHENTICATED posts: the screens most worth hearing about are the
 * ones that failed before a session existed, and a report nobody can file is a report we never get.
 * Rate-limited and length-capped instead, and the identity is taken from the token when there is
 * one rather than from the body, so a report cannot claim to be from someone else.
 */
// notify.ts keeps its escaper private, and these lines carry text a user typed.
const htmlSafe = (v: unknown) => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
app.post("/api/error-reports", reportLimiter, async (req, res) => {
  const cap = (v: unknown, n: number) => (v == null ? null : String(v).slice(0, n));
  const b = req.body ?? {};
  let actorId: string | null = null, actorName: string | null = null, companyId: string | null = null;
  const raw = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (raw) {
    try {
      const a: any = verifyToken(raw);
      actorId = a.sub ?? null;
      companyId = a.companyId ?? null;
      const u = a.sub ? await prisma.user.findUnique({ where: { id: a.sub }, select: { name: true, email: true } }) : null;
      actorName = u?.name ?? u?.email ?? null;
    } catch { /* an expired token is not a reason to drop the report */ }
  }
  try {
    const kind = ["not_found", "crash", "manual"].includes(String(b.kind)) ? String(b.kind) : "manual";
    const row = await prisma.errorReport.create({
      data: {
        kind, app: String(b.app) === "portal" ? "portal" : "console",
        path: cap(b.path, 500), message: cap(b.message, 2000), detail: cap(b.detail, 8000),
        userAgent: cap(req.headers["user-agent"], 500), note: cap(b.note, 2000),
        actorId, actorName, companyId, createdAt: new Date().toISOString(),
      },
    });
    const who = actorName ?? (companyId ? "a client" : "someone signed out");
    const what = kind === "not_found" ? `Dead link: ${row.path ?? "?"}` : kind === "crash" ? `Crash: ${row.message ?? "unknown error"}` : `Problem reported on ${row.path ?? "?"}`;
    logActivity({ type: "system", message: `${what} — reported by ${who}` });
    notify({
      rule: "Approval requested", audience: "staff",
      inApp: { type: "alert", title: what, message: `Reported by ${who}` },
      subject: `STIMES PRO — ${what}`,
      heading: "Someone reported a problem",
      lines: [`Where: <b>${htmlSafe(row.path ?? "—")}</b>`, `Who: ${htmlSafe(who)}`,
        row.note ? `They said: ${htmlSafe(row.note)}` : "", row.message ? `Error: ${htmlSafe(row.message)}` : ""],
    });
    res.status(201).json({ ok: true, id: row.id });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── The inbox for the above ──
// Reports were being written and emailed and nothing could list them, so the record of what is
// broken existed only in whoever's mailbox happened to get the alert. Admin-only: a report carries
// a path, a stack and the reporter's identity.
app.get("/api/error-reports", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (req, res) => {
  const status = String(req.query.status ?? "").trim();
  const rows = await prisma.errorReport.findMany({
    where: status && status !== "all" ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const counts = await prisma.errorReport.groupBy({ by: ["status"], _count: true });
  res.json({
    rows,
    counts: counts.reduce((m, c) => ({ ...m, [c.status]: c._count }), {} as Record<string, number>),
  });
});

app.put("/api/error-reports/:id", requireAuth, requireStaff, requireWriteRole, requireReadRole("super_admin", "admin"), async (req, res) => {
  const a = (req as any).auth;
  const want = String(req.body?.status ?? "").toLowerCase();
  if (!["new", "seen", "closed"].includes(want)) return res.status(400).json({ error: "status must be new, seen or closed" });
  try {
    const row = await prisma.errorReport.update({ where: { id: req.params.id }, data: { status: want } });
    await logAudit({ action: "errorreport.status", actorId: a?.sub, target: row.id, detail: want });
    res.json(row);
  } catch (e: any) { res.status(404).json({ error: "Not found" }); }
});

// Read-side relation includes the UI renders directly.
const includes: Record<string, Record<string, any>> = {
  subscriptions: { package: true },
};

/**
 * Deleting a catalog service, with the references checked first.
 *
 * The generic CRUD delete would drop the row and leave dangling ids behind: a package still listing
 * it in serviceIds, a client still carrying it as a paid add-on, a request waiting to be priced. The
 * service is a name and an id that other records point at by id — nothing in the schema enforces
 * that, so it is enforced here. Registered BEFORE the generic router so this handler wins.
 *
 * Anything still in flight (an open request for the service) counts as in use: withdrawing a service
 * out from under a client who is waiting on it is worse than refusing the delete.
 */
app.delete("/api/service-items/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  const id = req.params.id;
  const svc = await prisma.serviceItem.findUnique({ where: { id } });
  if (!svc) return res.status(404).json({ error: "Not found" });

  const [packages, subs, openReqs] = await Promise.all([
    prisma.package.findMany({ select: { id: true, name: true, serviceIds: true } }),
    prisma.subscription.findMany({ select: { id: true, companyId: true, addons: true } }),
    prisma.upgradeRequest.findMany({
      where: { kind: "addon", serviceId: id, status: { in: ["pending", "escalated"] } },
      select: { clientName: true },
    }),
  ]);

  const inPackages = packages.filter(p => Array.isArray(p.serviceIds) && (p.serviceIds as string[]).includes(id));
  const subsWith = subs.filter(s => Array.isArray(s.addons) && (s.addons as any[]).some(x => x?.serviceId === id));
  const clientNames = subsWith.length
    ? (await prisma.company.findMany({ where: { id: { in: subsWith.map(s => s.companyId).filter(Boolean) as string[] } }, select: { name: true } })).map(c => c.name)
    : [];

  const blockers: string[] = [];
  if (inPackages.length) blockers.push(`${inPackages.length === 1 ? "the plan" : "the plans"} ${inPackages.map(p => p.name).join(", ")}`);
  if (subsWith.length) blockers.push(`${subsWith.length} client ${subsWith.length === 1 ? "plan" : "plans"} as a paid add-on${clientNames.length ? ` (${clientNames.slice(0, 3).join(", ")}${clientNames.length > 3 ? "…" : ""})` : ""}`);
  if (openReqs.length) blockers.push(`${openReqs.length} open add-on ${openReqs.length === 1 ? "request" : "requests"}`);

  if (blockers.length) {
    return res.status(409).json({
      error: `"${svc.name}" is still in use — remove it from ${blockers.join(" and ")} first.`,
      blockers: { packages: inPackages.map(p => p.name), clients: clientNames, openRequests: openReqs.length },
    });
  }

  await prisma.serviceItem.delete({ where: { id } });
  logActivity({ type: "client", message: `Catalog service removed: ${svc.name}` });
  await logAudit({ action: "service-item.delete", actorId: (req as any).auth.sub, target: id, detail: svc.name });
  res.status(204).end();
});

/**
 * Which packages / clients / open requests a service is attached to. The console asks before
 * offering Delete, so a service that cannot be removed says why instead of failing on the click.
 */
app.get("/api/service-items/:id/usage", requireAuth, requireStaff, async (req, res) => {
  const id = req.params.id;
  const [packages, subs, openReqs] = await Promise.all([
    prisma.package.findMany({ select: { name: true, serviceIds: true } }),
    prisma.subscription.findMany({ select: { companyId: true, addons: true } }),
    prisma.upgradeRequest.count({ where: { kind: "addon", serviceId: id, status: { in: ["pending", "escalated"] } } }),
  ]);
  const inPackages = packages.filter(p => Array.isArray(p.serviceIds) && (p.serviceIds as string[]).includes(id)).map(p => p.name);
  const subsWith = subs.filter(s => Array.isArray(s.addons) && (s.addons as any[]).some(x => x?.serviceId === id));
  const clients = subsWith.length
    ? (await prisma.company.findMany({ where: { id: { in: subsWith.map(s => s.companyId).filter(Boolean) as string[] } }, select: { name: true } })).map(c => c.name)
    : [];
  res.json({ packages: inPackages, clients, openRequests: openReqs, canDelete: !inPackages.length && !clients.length && !openReqs });
});
// The `/api/users` managerId guard stood here. It refused a portal account a manager, a lead who
// was not active staff, and anybody reporting to themselves. managerId is gone, but NONE of those
// rules are: they are properties of team membership, not of that column, and they now live on the
// teams API in teams.ts where the membership is actually written. Deleting them here without
// carrying them there is how a rule quietly stops being enforced.

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
/**
 * What this system is actually connected to.
 *
 * Every field here is READ, never declared. A channel is "connected" because its configuration
 * resolves and its log has traffic — not because a row somewhere says so. That distinction is the
 * whole point of the screen: an integrations page whose status is itself a stored setting tells you
 * what somebody once typed, which is the opposite of what you open it to find out.
 *
 * Channels that do not exist yet are listed with `available: false` and what they would need. They
 * are named rather than hidden because "we cannot do WhatsApp yet" is a real answer to somebody
 * looking for WhatsApp, and an empty screen is not.
 */

// ── Mailbox sync ────────────────────────────────────────────────────────────────────────────
//
// A person connects their OWN mailbox, and only their own. There is no route by which an admin
// connects somebody else's — a grant somebody did not personally give is not consent, and the
// whole feature rests on being able to say that honestly to the staff it reads.
app.get("/api/mailbox/status", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const conn = await prisma.mailboxConnection.findUnique({ where: { userId: a.sub } });
  const google = providerConfigured("google");
  const microsoft = providerConfigured("microsoft");
  res.json({
    // Never the tokens. Not redacted, not partially — they are simply not in the shape.
    connected: !!conn && conn.status !== "disconnected",
    provider: conn?.provider ?? null,
    address: conn?.address ?? null,
    status: conn?.status ?? null,
    lastSyncAt: conn?.lastSyncAt ?? null,
    lastError: conn?.lastError ?? null,
    available: { google, microsoft },
    // Said plainly rather than left for somebody to infer from two false flags.
    setupNote: google || microsoft ? null
      : "No mail provider is configured yet. An admin needs to register an app on the firm's own Google Workspace or Microsoft 365 tenant and add its client id and secret to the server environment.",
  });
});

app.get("/api/mailbox/connect", requireAuth, requireStaff, async (req, res) => {
  const provider = String(req.query.provider ?? "google") === "microsoft" ? "microsoft" : "google";
  if (!providerConfigured(provider)) return res.status(400).json({ error: `${provider === "google" ? "Google" : "Microsoft"} is not configured on this server yet.` });
  // The state carries WHO is connecting, signed, so the callback cannot be replayed to attach
  // somebody else's mailbox to this account.
  const state = signState({ sub: (req as any).auth.sub, provider });
  res.json({ url: authorizeUrl(provider, state) });
});

app.get("/api/mailbox/callback", async (req, res) => {
  const code = String(req.query.code ?? "");
  const state = String(req.query.state ?? "");
  const parsed = verifyState(state);
  if (!code || !parsed) return res.status(400).type("html").send("<p>That sign-in link is no longer valid. Please start again from Settings.</p>");
  try {
    const t = await exchangeCode(parsed.provider, code);
    await saveConnection(parsed.sub, parsed.provider, t.address, t);
    await logAudit({ action: "mailbox.connected", actorId: parsed.sub, target: t.address, detail: parsed.provider });
    res.type("html").send(`<p>Mailbox <b>${t.address.replace(/[<>&]/g, "")}</b> connected. You can close this tab.</p>`);
  } catch (e: any) {
    res.status(400).type("html").send(`<p>Could not connect that mailbox: ${String(e?.message ?? e).replace(/[<>&]/g, "")}</p>`);
  }
});

app.post("/api/mailbox/disconnect", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const conn = await prisma.mailboxConnection.findUnique({ where: { userId: a.sub } });
  if (!conn) return res.json({ ok: true });
  // The row goes entirely, tokens with it. Marking it "disconnected" and keeping the tokens would
  // leave a live grant sitting in the database belonging to somebody who believes they revoked it.
  await prisma.mailboxConnection.delete({ where: { userId: a.sub } });
  await logAudit({ action: "mailbox.disconnected", actorId: a.sub, target: conn.address, detail: "tokens deleted" });
  res.json({ ok: true });
});

/** Sync my own mailbox now. The hourly tick does this too; this is for "did it work?". */
app.post("/api/mailbox/sync", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const conn = await prisma.mailboxConnection.findUnique({ where: { userId: a.sub } });
  if (!conn) return res.status(400).json({ error: "No mailbox is connected." });
  res.json(await syncMailbox(a.sub, providerFor(conn.provider)));
});

// ── Booking links ───────────────────────────────────────────────────────────────────────────
//
// Two public endpoints and one public page. The slug travels in a URL, so it is public whatever
// anybody intends; these are written so a slug-holder can do exactly two things — read a list of
// free times, and take one. Reading is throttled harder than most GETs because the response is
// derived (it queries a diary), and booking harder still because it writes.
const bookReadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: "Too many requests — try again shortly" } });
const bookWriteLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many bookings from here in the last hour — please call us instead" } });

app.get("/api/public/book/:slug", bookReadLimiter, async (req, res) => {
  const link = await prisma.bookingLink.findFirst({ where: { slug: String(req.params.slug), active: true } });
  // An inactive and a non-existent link answer identically. Distinguishing them would let somebody
  // with a list of guesses learn which slugs the firm has ever used.
  if (!link) return res.status(404).json({ error: "This booking link is no longer available." });
  const who = await prisma.user.findUnique({ where: { id: link.userId }, select: { name: true } });
  const { zone, slots } = await freeSlots(link);
  // Only what the page needs to draw itself. Not the rep's email, not their id, not the diary the
  // slots were derived from.
  res.json({ title: link.title, blurb: link.blurb, minutes: link.minutes, with: who?.name ?? "our team", zone, slots });
});

app.post("/api/public/book/:slug", bookWriteLimiter, async (req, res) => {
  const out = await bookSlot(String(req.params.slug), req.body ?? {});
  res.status(out.ok ? 201 : 400).json(out);
});

/** The page itself — self-contained, so it works even while the console bundle is being deployed. */
app.get("/book/:slug", bookReadLimiter, async (req, res) => {
  const slug = String(req.params.slug).replace(/[^a-zA-Z0-9_-]/g, "");
  res.type("html").send(bookingPage(slug));
});

// Console-side management. Ordinary auth; a link is configuration like any other.
app.get("/api/booking-links", requireAuth, requireStaff, async (_req, res) => {
  const links = await prisma.bookingLink.findMany({ orderBy: { createdAt: "asc" } });
  const users = await prisma.user.findMany({ where: { type: "staff" }, select: { id: true, name: true } });
  const byId = new Map(users.map(u => [u.id, u.name]));
  res.json(links.map(l => ({ ...l, userName: byId.get(l.userId) ?? "(nobody)" })));
});

app.put("/api/booking-links", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, async (req, res) => {
  const rows = Array.isArray(req.body?.links) ? req.body.links : null;
  if (!rows) return res.status(400).json({ error: "Send { links: [...] }" });
  const seen = new Set<string>();
  for (const l of rows) {
    const slug = String(l?.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return res.status(400).json({ error: `"${l?.slug ?? ""}" is not a usable link address — letters, numbers and hyphens only.` });
    if (seen.has(slug)) return res.status(400).json({ error: `Two links share the address "${slug}". Each one needs its own.` });
    seen.add(slug);
    if (!String(l?.title ?? "").trim()) return res.status(400).json({ error: "Every link needs a title — it is what the visitor sees they are booking." });
    if (!String(l?.userId ?? "").trim()) return res.status(400).json({ error: `"${l.title}" does not say whose diary it books.` });
    if (Number(l.dayEnd) <= Number(l.dayStart)) return res.status(400).json({ error: `"${l.title}" finishes before it starts.` });
    if (Number(l.minutes) < 5) return res.status(400).json({ error: `"${l.title}" is shorter than five minutes.` });
  }
  const now = new Date().toISOString();
  await prisma.$transaction([
    prisma.bookingLink.deleteMany({}),
    ...rows.map((l: any) => prisma.bookingLink.create({
      data: {
        userId: String(l.userId), slug: String(l.slug).trim().toLowerCase(), title: String(l.title).trim(),
        blurb: l.blurb || null, active: l.active !== false,
        minutes: Number(l.minutes) || 30, bufferMins: Number(l.bufferMins) || 0,
        dayStart: Number(l.dayStart) || 9, dayEnd: Number(l.dayEnd) || 17,
        workDays: String(l.workDays || "7,1,2,3,4"), daysAhead: Number(l.daysAhead) || 14,
        noticeHours: Number(l.noticeHours) || 4, createdAt: now, updatedAt: now,
      },
    })),
  ]);
  await logAudit({ action: "booking.links.saved", actorId: (req as any).auth?.sub, target: "Booking links", detail: `${rows.length} link(s)` });
  res.json(await prisma.bookingLink.findMany({ orderBy: { createdAt: "asc" } }));
});

/**
 * How promising each open lead is, and the arithmetic behind it.
 *
 * Derived on every read. There is no score column and no job keeping one fresh, because a stored
 * score is wrong the moment somebody logs a call — and a number that is quietly out of date is
 * worse than no number, since nothing on screen says so.
 */
app.get("/api/lead-scores", requireAuth, requireStaff, async (_req, res) => {
  res.json(await scoreOpenLeads());
});

// ── Assignment rules ────────────────────────────────────────────────────────────────────────
// Ordered, first match wins, no match falls back to the load balancer that has always been there.
app.get("/api/assignment-rules", requireAuth, requireStaff, async (_req, res) => {
  res.json(await prisma.assignmentRule.findMany({ orderBy: [{ scope: "asc" }, { position: "asc" }] }));
});
app.put("/api/assignment-rules", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, async (req, res) => {
  const rows = Array.isArray(req.body?.rules) ? req.body.rules : null;
  if (!rows) return res.status(400).json({ error: "Send { rules: [...] }" });
  for (const r of rows) {
    if (!String(r?.label ?? "").trim()) return res.status(400).json({ error: "Every rule needs a name — it is what the audit line will say." });
    if (r.scope !== "lead" && r.scope !== "task") return res.status(400).json({ error: `"${r.label}" must apply to leads or to tasks.` });
    // A rule with a condition and no target routes nothing; a rule with neither is a catch-all that
    // sends everything somewhere, which is a thing you can mean but never by accident.
    if (!String(r.toUserId ?? "").trim() && !String(r.toRole ?? "").trim())
      return res.status(400).json({ error: `"${r.label}" does not say who the work goes to.` });
  }
  const now = new Date().toISOString();
  await prisma.$transaction([
    prisma.assignmentRule.deleteMany({}),
    ...rows.map((r: any, i: number) => prisma.assignmentRule.create({
      data: {
        scope: r.scope, position: i, active: r.active !== false, label: String(r.label).trim(),
        whenSource: r.whenSource || null, whenCity: r.whenCity || null, whenCountry: r.whenCountry || null,
        whenGovCenter: r.whenGovCenter || null, whenService: r.whenService || null,
        toUserId: r.toUserId || null, toRole: r.toRole || null,
        createdAt: now, updatedAt: now,
      },
    })),
  ]);
  await logAudit({ action: "assignment.rules.saved", actorId: (req as any).auth?.sub, target: "Assignment rules", detail: `${rows.length} rule(s) saved` });
  res.json(await prisma.assignmentRule.findMany({ orderBy: [{ scope: "asc" }, { position: "asc" }] }));
});
/** Dry-run: what WOULD happen to a lead or a step with these facts, and which rule decided it. */
app.post("/api/assignment-rules/test", requireAuth, requireStaff, async (req, res) => {
  const { scope, ...facts } = req.body ?? {};
  if (scope !== "lead" && scope !== "task") return res.status(400).json({ error: "scope must be lead or task" });
  const routed = await routeFor(scope, facts);
  const who = routed.userId ? await prisma.user.findUnique({ where: { id: routed.userId }, select: { name: true } }) : null;
  res.json({ ...routed, name: who?.name ?? null });
});

app.get("/api/integrations", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (_req, res) => {
  const cfg = await getEmailConfig();
  const health = await mailHealth(7);
  const keys = await prisma.apiKey.count({ where: { revoked: false } });
  const keysAll = await prisma.apiKey.count();

  res.json({
    channels: [
      {
        key: "smtp", name: "Outbound email (SMTP)", available: true,
        connected: !!(cfg.enabled && cfg.host && cfg.user),
        // Configured-but-switched-off is its own state: the credentials are right and nothing is
        // being sent, which reads as broken unless the screen says which of the two it is.
        detail: !cfg.host ? "No SMTP server set"
          : !cfg.enabled ? `Configured for ${cfg.host}, but sending is switched off`
          : `Sending through ${cfg.host} as ${cfg.from || cfg.user}`,
        stats: { sent: health.sent, failed: health.failed, skipped: health.skipped, days: 7 },
        screen: "Email",
      },
      {
        key: "web-intake", name: "Website enquiry form", available: true,
        connected: keys > 0,
        detail: keys > 0
          ? `${keys} live key${keys === 1 ? "" : "s"} can post enquiries` + (keysAll > keys ? ` · ${keysAll - keys} revoked` : "")
          : "No key issued — a website form has nothing to post to",
        stats: null, screen: "Security",
      },
      {
        key: "whatsapp", name: "WhatsApp", available: false, connected: false,
        detail: "Not built. Needs a WhatsApp Business Platform number (Meta Cloud API or a provider such as 360dialog/Twilio) — see the note on this screen before choosing.",
        stats: null, screen: null,
      },
      // Built, but its availability is genuinely conditional: without an OAuth app registered on
      // the firm's own tenant there is nothing for a rep to connect TO. Reported as three states
      // rather than two, because "we have not set this up" and "this product cannot do it" are
      // different answers and only one of them has an action attached.
      await (async () => {
        const g = providerConfigured("google"), m = providerConfigured("microsoft");
        const conns = await prisma.mailboxConnection.findMany({ where: { status: { not: "disconnected" } }, select: { status: true } });
        const stored = await prisma.emailMessage.count();
        const broken = conns.filter(c => c.status === "needs_reconnect").length;
        return {
          key: "mailbox", name: "Salesperson mailbox sync",
          available: g || m,
          connected: conns.length > 0 && broken < conns.length,
          detail: !(g || m)
            ? "Ready, but no mail provider is configured. Register an app on the firm's own Google Workspace or Microsoft 365 tenant and add its client id and secret to the server environment — an internal app, consented once by an admin for the whole domain."
            : conns.length === 0
            ? `Ready via ${[g && "Google", m && "Microsoft 365"].filter(Boolean).join(" and ")}. Nobody has connected a mailbox yet — each person connects their own from Settings.`
            : `${conns.length} mailbox${conns.length === 1 ? "" : "es"} connected${broken ? `, ${broken} needing to be reconnected` : ""} · ${stored} matched message${stored === 1 ? "" : "s"} on client records`,
          stats: null, screen: null,
        };
      })(),
    ],
  });
});

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

    // A From line with no email address in it authenticates fine and then fails at MAIL FROM with a
    // bare "451 Invalid from" — which reads as a broken mail server rather than a typo in one field.
    // Catch it here, where it can be named. Blank is allowed: that falls back to the SMTP_FROM default.
    const from = String(b.from ?? "").trim();
    const ADDR = "[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+";
    const wellFormed = (v: string) => new RegExp(`^(${ADDR}|.*<\\s*${ADDR}\\s*>)$`).test(v);
    if (from && !wellFormed(from)) {
      return res.status(400).json({
        error: `"${from}" is a name, not an address. Use name@yourdomain.com, or ${from} <name@yourdomain.com>.`,
      });
    }

    // Held to the same standard as `from`, and for a sharper reason: a malformed reply-to does not
    // bounce back to us — the client presses Reply, their mail client accepts the address, and the
    // message goes nowhere anybody will ever look. Blank is fine and means "replies are not read",
    // which the footer then says out loud.
    const replyTo = String(b.replyTo ?? "").trim();
    if (replyTo && !wellFormed(replyTo)) {
      return res.status(400).json({
        error: `"${replyTo}" is not a reply address. Use name@yourdomain.com, or leave it blank if nobody reads replies.`,
      });
    }

    const value: Record<string, unknown> = {
      host: String(b.host ?? "").trim(),
      port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.round(port) : 587,
      secure: !!b.secure,
      user: String(b.user ?? "").trim(),
      from,
      replyTo,
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

/**
 * What has actually been leaving the building. Read-only, admin-only.
 *
 * Bodies are never stored, so this cannot leak a reset link or a client's document details — it is
 * addresses, subjects, and the transport's own words about what went wrong.
 */
app.get("/api/email-log", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), async (req, res) => {
  const days = Math.min(90, Math.max(1, Number((req.query.days as string) ?? 7) || 7));
  const health = await mailHealth(days);
  const rows = await prisma.mailLog.findMany({
    where: { at: { gte: health.since } },
    orderBy: { at: "desc" },
    take: 200,
    select: { to: true, subject: true, status: true, kind: true, error: true, at: true },
  });
  res.json({ ...health, days, rows });
});

// Verify the SMTP connection (no mail sent), or send a real test message to `to`.
app.post("/api/email-config/test", requireAuth, requireStaff, requireReadRole("super_admin", "admin"), requireWriteRole, async (req, res) => {
  const to = String(req.body?.to ?? "").trim();
  const v = await verifyEmail();
  if (!v.ok) return res.status(400).json({ error: v.error || "Could not connect to the mail server" });
  if (!to) return res.json({ ok: true, verified: true, sent: false });
  try {
    // The test mail is the one an admin judges the system by, so it goes through the same shell as
    // every client-facing message — and it states the settings that delivered it, because "it
    // arrived" is only useful if you can see WHICH configuration arrived.
    const cfg = await getEmailConfig();
    const ctxTest = await emailContext();
    const org = ctxTest.org;
    const { html, text } = renderEmail(ctxTest, {
      heading: "Your email settings are working",
      preheader: `Delivered through ${cfg.host} — this configuration is live.`,
      lines: [
        `This is a test message from <b>${escEmail(org)}</b>, sent from Settings → Email.`,
        "It was delivered using the settings below. Anything this system sends from now on — password resets, client notifications, invoice reminders — goes out the same way and looks like this.",
      ],
      facts: [
        { label: "Server", value: escEmail(cfg.host) },
        { label: "Port", value: `${cfg.port} · ${cfg.secure ? "SSL/TLS" : "STARTTLS"}` },
        { label: "Username", value: escEmail(cfg.user || "— none (unauthenticated relay)") },
        { label: "From", value: escEmail(cfg.from) },
        { label: "Reply-to", value: escEmail(cfg.replyTo || "— none, replies go nowhere") },
        { label: "Sent", value: escEmail(new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC") },
      ],
      note: "You received this because somebody pressed <b>Send test</b> in the console. No client was contacted.",
    });
    const r = await sendMail({ to, subject: `${org} — test email`, text, html });
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
// NOT served by express.static — reachable only through GET /api/files/:id, which checks the caller.
const PRIVATE_FILES_DIR = path.resolve(process.cwd(), "uploads-private");
if (!fs.existsSync(PRIVATE_FILES_DIR)) fs.mkdirSync(PRIVATE_FILES_DIR, { recursive: true });
// Kinds that carry a person's identity papers. Everything else (logos, print headers) stays public
// because an <img> tag cannot send a token.
const PRIVATE_KINDS = new Set(["document", "attachment"]);
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
  // A person's identity papers do not go in a publicly served folder. Branding does — an <img> tag
  // carries no Authorization header, so a logo behind auth simply would not render.
  const isPrivate = PRIVATE_KINDS.has(String(kind || ""));
  // Random, not `${kind}-${Date.now()}`. A millisecond timestamp is guessable inside a known window,
  // so the old names let anyone walk the folder and pull other clients' passport scans.
  const fname = `${crypto.randomBytes(16).toString("hex")}${safeExt}`;
  fs.writeFileSync(path.join(isPrivate ? PRIVATE_FILES_DIR : FILES_DIR, fname), buf);
  const asset = await prisma.fileAsset.create({
    data: {
      kind: String(kind || "file"), name: String(name || fname),
      // A private file is addressed by id through a route that checks the caller, never by a path
      // anyone holding the URL can fetch.
      path: isPrivate ? "" : "/files/" + fname,
      size: buf.length, uploadedBy: a?.sub ?? null,
      companyId: a?.type === "portal" ? (a.companyId ?? null) : null,
      private: isPrivate,
      at: new Date().toISOString(),
    },
  });
  // Stored separately from `path` so the private route can find the file on disk without the URL
  // ever naming it. Written after create because the name is keyed to the asset id.
  if (isPrivate) {
    fs.renameSync(path.join(PRIVATE_FILES_DIR, fname), path.join(PRIVATE_FILES_DIR, asset.id + safeExt));
    await prisma.fileAsset.update({ where: { id: asset.id }, data: { path: "/api/files/" + asset.id } });
  }
  const outPath = isPrivate ? "/api/files/" + asset.id : asset.path;
  await logAudit({ action: "file.upload", actorId: a?.sub, target: outPath, detail: `${asset.kind} · ${buf.length}b${isPrivate ? " · private" : ""}`, ip: clientIp(req) });
  res.status(201).json({ id: asset.id, path: outPath, name: asset.name });
});

/**
 * Read a private file. Staff may read any; a portal client may read only files belonging to their
 * own company. The file never sits in the served folder, so this check cannot be walked around by
 * guessing a URL — which is exactly what `/files/document-<timestamp>.png` allowed.
 */
app.get("/api/files/:id", requireAuth, async (req, res) => {
  const a = (req as any).auth;
  const asset = await prisma.fileAsset.findUnique({ where: { id: req.params.id } });
  if (!asset) return res.status(404).json({ error: "Not found" });
  if (!asset.private) return res.redirect(asset.path); // public asset, nothing to gate
  if (a?.type === "portal" && asset.companyId !== a.companyId) return res.status(404).json({ error: "Not found" });
  const onDisk = fs.readdirSync(PRIVATE_FILES_DIR).find(f => f.startsWith(asset.id));
  if (!onDisk) return res.status(404).json({ error: "The file is no longer on the server" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  // Named for the human, not for the disk: the client sees "passport.pdf", not a cuid.
  res.setHeader("Content-Disposition", `inline; filename="${String(asset.name || onDisk).replace(/[^\w. -]/g, "_")}"`);
  res.sendFile(path.join(PRIVATE_FILES_DIR, onDisk));
});

// ── API keys: list (safe fields), create (full key returned ONCE), revoke ──
app.get("/api/api-keys", requireAuth, requireStaff, requireHuman, async (_req, res) => {
  const rows = await prisma.apiKey.findMany({ orderBy: { createdAt: "desc" } });
  res.json(rows.map(k => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: k.revoked })));
});
app.post("/api/api-keys", requireAuth, requireStaff, requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  const name = String((req.body ?? {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Key name is required" });
  // Read unless write is asked for explicitly: the safer of the two is what you get by default.
  const scope = String((req.body ?? {}).scope || "read").toLowerCase() === "write" ? "write" : "read";
  const raw = "sk_" + crypto.randomBytes(24).toString("base64url");
  const row = await prisma.apiKey.create({
    data: { name, scope, prefix: raw.slice(0, 10) + "…", keyHash: crypto.createHash("sha256").update(raw).digest("hex"), createdAt: new Date().toISOString() },
  });
  await logAudit({ action: "apikey.create", actorId: a?.sub, target: `${name} (${row.id})`, detail: `scope=${scope}`, ip: clientIp(req) });
  res.status(201).json({ id: row.id, name: row.name, prefix: row.prefix, scope: row.scope, key: raw }); // raw key: shown once, never stored
});
app.delete("/api/api-keys/:id", requireAuth, requireStaff, requireWriteRole, requireHuman, async (req, res) => {
  const a = (req as any).auth;
  try {
    const row = await prisma.apiKey.update({ where: { id: req.params.id }, data: { revoked: true } });
    await logAudit({ action: "apikey.revoke", actorId: a?.sub, target: `${row.name} (${row.id})`, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Sign out everywhere: bump tokenVersion (invalidates every issued JWT) and re-issue THIS session's.
app.post("/api/auth/logout-all", requireAuth, requireHuman, async (req, res) => {
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
