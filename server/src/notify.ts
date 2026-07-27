// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS — one place that decides WHO hears about an event and HOW.
//
// Until now `logNotification` only wrote an in-app bell row, and `sendMail` was called from exactly
// two places (password reset and the "send test email" button). So a client who never signed in was
// never told anything: not that their request was received, not that a document was expiring, not
// that an invoice was raised.
//
// Rules this module obeys:
//  1. NEVER throw into the caller. A mail server being down must not fail the request that triggered
//     it — every entry point is wrapped and errors are logged, not propagated.
//  2. Respect the admin's toggles in Settings → Notifications (AppSetting "notifRules"). A rule that
//     is switched off sends no email; the in-app row is still written so nothing is lost.
//  3. Say only what we know. No invented names, amounts or dates — the templates take real values.
// ─────────────────────────────────────────────────────────────
import { prisma } from "./db.js";
import { sendMail } from "./mailer.js";
import { logNotification } from "./auth.js";

/** Rule keys mirror the labels rendered in Settings → Notifications so the toggles line up. */
export type RuleKey =
  | "Approval requested"
  | "Renewal due ≤ 30 days"
  | "Invoice overdue"
  | "Request status change"
  | "SLA breached"
  | "Document rejected";

const RULE_DEFAULTS: Record<RuleKey, boolean> = {
  "Approval requested": true,
  "Renewal due ≤ 30 days": true,
  "Invoice overdue": true,
  "Request status change": true,
  "SLA breached": true,
  "Document rejected": false,
};

async function ruleOn(key: RuleKey): Promise<boolean> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "notifRules" } });
    const map = (row?.value ?? {}) as Record<string, unknown>;
    return typeof map[key] === "boolean" ? (map[key] as boolean) : RULE_DEFAULTS[key];
  } catch {
    return RULE_DEFAULTS[key];
  }
}

async function orgName(): Promise<string> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "org" } });
    const v = (row?.value ?? {}) as Record<string, unknown>;
    return String(v.legalName || v.orgName || "STIMES PRO");
  } catch {
    return "STIMES PRO";
  }
}

/** Staff who should hear about client activity. Admins only — pro_officers get the in-app queue. */
async function staffRecipients(): Promise<string[]> {
  try {
    const users = await prisma.user.findMany({
      where: { type: "staff", status: "active", roleId: { in: ["super_admin", "admin"] } },
      select: { email: true },
    });
    return users.map((u) => u.email).filter(Boolean);
  } catch {
    return [];
  }
}

/** Where to reach a client: their portal logins, falling back to the company's own contact address. */
async function clientRecipients(companyId?: string | null): Promise<string[]> {
  if (!companyId) return [];
  try {
    const users = await prisma.user.findMany({
      where: { type: "portal", companyId, status: "active" },
      select: { email: true },
    });
    const emails = users.map((u) => u.email).filter(Boolean);
    if (emails.length) return emails;
    const co = await prisma.company.findUnique({ where: { id: companyId }, select: { email: true } });
    return co?.email ? [co.email] : [];
  } catch {
    return [];
  }
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** House style for every outbound email — plain, legible, and identical across notifications. */
function wrap(org: string, heading: string, lines: string[], cta?: { label: string; url: string }) {
  const body = lines.filter(Boolean).map((l) => `<p style="margin:0 0 10px;">${l}</p>`).join("");
  return `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1A1523;max-width:560px;">
  <div style="background:linear-gradient(110deg,#26074D,#7C00FF);color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;">
    <div style="font-size:15px;font-weight:700;">${esc(org)}</div>
  </div>
  <div style="border:1px solid #EDEBF2;border-top:none;border-radius:0 0 12px 12px;padding:20px;">
    <h2 style="margin:0 0 12px;font-size:16px;">${esc(heading)}</h2>
    ${body}
    ${cta ? `<p style="margin:18px 0 0;"><a href="${esc(cta.url)}" style="background:#7C00FF;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:99px;display:inline-block;">${esc(cta.label)}</a></p>` : ""}
    <p style="margin:18px 0 0;font-size:11px;color:#8C8899;">You're receiving this because you have an account with ${esc(org)}.</p>
  </div>
</div>`;
}

const portalUrl = () => process.env.PORTAL_URL || "https://cp.ionob.in";
const consoleUrl = () => process.env.CONSOLE_URL || "https://pro.ionob.in";

/** Fire-and-forget delivery. Every failure is swallowed so a mail outage can't break a write path. */
async function deliver(to: string[], subject: string, html: string, text: string) {
  const unique = [...new Set(to.filter(Boolean))];
  for (const addr of unique) {
    try {
      await sendMail({ to: addr, subject, html, text });
    } catch (e: any) {
      console.error(`[notify] failed to email ${addr}: ${e?.message ?? e}`);
    }
  }
}

type NotifyArgs = {
  rule: RuleKey;
  /** Always written, regardless of the email toggle, so the in-app bell never loses an event. */
  inApp?: { type: string; title: string; message?: string };
  audience: "staff" | "client";
  companyId?: string | null;
  subject: string;
  heading: string;
  lines: string[];
  cta?: { label: string; url: string };
};

/**
 * The single entry point. Writes the in-app row, then emails the audience if the rule allows it.
 * Deliberately NOT awaited by callers on hot paths — see notify() below.
 */
async function run(args: NotifyArgs) {
  if (args.inApp) await logNotification(args.inApp);
  if (!(await ruleOn(args.rule))) return;
  const to = args.audience === "staff" ? await staffRecipients() : await clientRecipients(args.companyId);
  if (!to.length) return;
  const org = await orgName();
  const html = wrap(org, args.heading, args.lines, args.cta);
  const text = [args.heading, "", ...args.lines.map((l) => l.replace(/<[^>]+>/g, "")), args.cta ? `${args.cta.label}: ${args.cta.url}` : ""]
    .filter(Boolean).join("\n");
  await deliver(to, args.subject, html, text);
}

/** Call this from request handlers. Never awaited — the caller's response must not wait on SMTP. */
export function notify(args: NotifyArgs) {
  run(args).catch((e) => console.error(`[notify] ${args.rule} failed: ${e?.message ?? e}`));
}

/** Awaitable variant for the scheduler, where finishing the job before the tick ends is fine. */
export const notifyAwait = run;

// ── Event helpers ────────────────────────────────────────────
// One function per real event, so the wording lives here rather than being retyped at each call site.

export function notifyNewServiceRequest(a: { companyId?: string | null; clientName?: string | null; type?: string | null; message?: string | null }) {
  const label = a.type || "Service request";
  // Staff: something needs picking up.
  notify({
    rule: "Approval requested",
    inApp: { type: "task", title: `New service request${a.clientName ? ` — ${a.clientName}` : ""}`, message: label },
    audience: "staff",
    subject: `New request: ${label}${a.clientName ? ` — ${a.clientName}` : ""}`,
    heading: "A client has filed a new request",
    lines: [
      `<b>${esc(label)}</b>`,
      a.clientName ? `Client: ${esc(a.clientName)}` : "",
      a.message ? `<span style="white-space:pre-wrap;color:#555;">${esc(a.message)}</span>` : "",
    ],
    cta: { label: "Open the requests queue", url: `${consoleUrl()}/requests-queue` },
  });
  // Client: confirmation that it landed.
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    subject: `We've received your request: ${label}`,
    heading: "Your request has been received",
    lines: [
      `We've logged your request for <b>${esc(label)}</b> and your PRO team will pick it up.`,
      "You'll get an update here as soon as there's progress.",
    ],
    cta: { label: "Track it in your portal", url: `${portalUrl()}/portal/my-requests` },
  });
}

export function notifyRequestReply(a: { companyId?: string | null; requestType?: string | null; body: string }) {
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    subject: `Update on your request${a.requestType ? `: ${a.requestType}` : ""}`,
    heading: "Your PRO team has replied",
    lines: [
      a.requestType ? `Request: <b>${esc(a.requestType)}</b>` : "",
      `<span style="white-space:pre-wrap;">${esc(a.body)}</span>`,
    ],
    cta: { label: "Reply in your portal", url: `${portalUrl()}/portal/my-requests` },
  });
}

export function notifyInvoiceRaised(a: { companyId?: string | null; number?: string | null; amount?: number | null; currency?: string | null; dueDate?: string | null }) {
  const amt = a.amount != null ? `${a.currency || "SAR"} ${Number(a.amount).toLocaleString()}` : "";
  notify({
    rule: "Invoice overdue",
    audience: "client",
    companyId: a.companyId,
    subject: `Invoice ${a.number ?? ""} from your PRO team`.trim(),
    heading: `Invoice ${a.number ?? ""} is ready`.trim(),
    lines: [amt ? `Amount due: <b>${esc(amt)}</b>` : "", a.dueDate ? `Due: ${esc(a.dueDate)}` : ""],
    cta: { label: "View the invoice", url: `${portalUrl()}/portal/invoices` },
  });
}

export function notifyDocumentExpiring(a: { companyId?: string | null; docType?: string | null; person?: string | null; expiryDate?: string | null; daysLeft: number }) {
  const who = a.person ? ` — ${a.person}` : "";
  const when = a.daysLeft < 0 ? `expired ${Math.abs(a.daysLeft)} day(s) ago` : `expires in ${a.daysLeft} day(s)`;
  notify({
    rule: "Renewal due ≤ 30 days",
    audience: "client",
    companyId: a.companyId,
    subject: `${a.docType ?? "Document"}${who} ${a.daysLeft < 0 ? "has expired" : `expires in ${a.daysLeft} days`}`,
    heading: "A document needs renewing",
    lines: [
      `<b>${esc(a.docType ?? "Document")}${esc(who)}</b> ${esc(when)}${a.expiryDate ? ` (${esc(a.expiryDate)})` : ""}.`,
      "Your PRO team is on it — no action is needed unless they ask you for something.",
    ],
    cta: { label: "See your renewals", url: `${portalUrl()}/portal/renewals` },
  });
}

export function notifySlaBreach(a: { title: string; detail: string }) {
  notify({
    rule: "SLA breached",
    inApp: { type: "overdue", title: a.title, message: a.detail },
    audience: "staff",
    subject: `SLA breached: ${a.title}`,
    heading: "An SLA has been breached",
    lines: [`<b>${esc(a.title)}</b>`, esc(a.detail)],
    cta: { label: "Open the SLA monitor", url: `${consoleUrl()}/sla-monitor` },
  });
}
