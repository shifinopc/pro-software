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

/**
 * Dunning. The tone escalates with the ladder rung rather than sending the same nag four times, and
 * the amount quoted is what is STILL OUTSTANDING — part payments must be acknowledged, not ignored.
 */
export function notifyInvoiceOverdue(a: {
  companyId?: string | null; number?: string | null; outstanding: number; currency?: string | null;
  dueDate?: string | null; daysOverdue: number; alsoStaff?: boolean; clientName?: string | null;
}) {
  const amt = `${a.currency || "SAR"} ${Number(a.outstanding).toLocaleString()}`;
  const late = a.daysOverdue === 1 ? "1 day" : `${a.daysOverdue} days`;
  const firm = a.daysOverdue >= 30;
  notify({
    rule: "Invoice overdue",
    audience: "client",
    companyId: a.companyId,
    subject: firm
      ? `Overdue ${late}: invoice ${a.number ?? ""} — ${amt}`.trim()
      : `Reminder: invoice ${a.number ?? ""} is ${late} past due`.trim(),
    heading: firm ? "This invoice is seriously overdue" : "A payment reminder",
    lines: [
      `Invoice <b>${esc(a.number ?? "")}</b> was due ${esc(a.dueDate ?? "—")} and is now <b>${esc(late)}</b> past due.`,
      `Outstanding: <b>${esc(amt)}</b>`,
      firm
        ? "Please settle this, or reply to let us know when payment is coming — we'd rather hear from you than chase."
        : "If you've already paid, tell us in the portal and we'll confirm it against the invoice.",
    ],
    cta: { label: "View the invoice", url: `${portalUrl()}/portal/invoices` },
  });
  // At the final rung the team needs to know too — this is no longer a routine reminder.
  if (a.alsoStaff) {
    notify({
      rule: "Invoice overdue",
      audience: "staff",
      subject: `Unpaid ${late}: ${a.number ?? ""}${a.clientName ? ` — ${a.clientName}` : ""}`.trim(),
      heading: "An invoice has gone unpaid for 30 days",
      lines: [
        `<b>${esc(a.number ?? "")}</b>${a.clientName ? ` — ${esc(a.clientName)}` : ""}`,
        `Outstanding: <b>${esc(amt)}</b> · due ${esc(a.dueDate ?? "—")}`,
        "The client has had reminders at 1, 7, 14 and 30 days.",
      ],
      cta: { label: "Open invoices", url: `${consoleUrl()}/invoices` },
    });
  }
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

/**
 * An appointment changed on the STAFF side (confirmed, rescheduled, cancelled, marked attended).
 * This is the gap that mattered: a client could book through the portal and never hear back, because
 * staff act on appointments through the generic CRUD, which had no notification of its own.
 * `what` is the human verb, already decided by the caller from the actual field change.
 */
export function notifyAppointmentChanged(a: {
  companyId?: string | null; type?: string | null; date?: string | null; time?: string | null;
  what: string; note?: string | null;
}) {
  const when = [a.date, a.time].filter(Boolean).join(" ");
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    inApp: { type: "task", title: `Appointment ${a.what}: ${a.type ?? "appointment"}`, message: when || undefined },
    subject: `Your ${a.type ?? "appointment"} has been ${a.what}`,
    heading: `Appointment ${a.what}`,
    lines: [
      a.type ? `Type: <b>${esc(a.type)}</b>` : "",
      when ? `When: <b>${esc(when)}</b>` : "",
      a.note ? esc(a.note) : "",
    ],
    cta: { label: "View your appointments", url: `${portalUrl()}/portal/appointments` },
  });
}

/** An add-on the client asked for has been approved and attached to their own plan. */
export function notifyAddonApproved(a: { companyId?: string | null; serviceName?: string | null; price?: number | null; invoiceNumber?: string | null }) {
  const name = a.serviceName || "The service";
  const charged = (a.price ?? 0) > 0;
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    inApp: { type: "system", title: `Add-on approved: ${name}`, message: charged ? (a.invoiceNumber ? `Invoice ${a.invoiceNumber}` : undefined) : "No charge" },
    subject: `${name} has been added to your plan`,
    heading: "Your add-on has been approved",
    lines: [
      `Service: <b>${esc(name)}</b>`,
      charged
        ? `A one-off fee of <b>${Number(a.price).toLocaleString()}</b> will be invoiced.`
        : "There is no charge for this add-on.",
      "You can request this service from your catalog from now on.",
    ],
    cta: { label: "Open the service catalog", url: `${portalUrl()}/portal/service-catalog` },
  });
}

/**
 * The refusal side of the same request. Sent so the catalog card can go back to offering the button
 * instead of leaving the client waiting on a decision that has already been made.
 */
export function notifyAddonRejected(a: { companyId?: string | null; serviceName?: string | null }) {
  const name = a.serviceName || "The service";
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    inApp: { type: "system", title: `Add-on not approved: ${name}` },
    subject: `About your request for ${name}`,
    heading: "We could not add this to your plan",
    lines: [
      `Service: <b>${esc(name)}</b>`,
      "Your plan is unchanged. Talk to your PRO team if you would still like this service — they can look at other options with you.",
    ],
    cta: { label: "Open the service catalog", url: `${portalUrl()}/portal/service-catalog` },
  });
}
