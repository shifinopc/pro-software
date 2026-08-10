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
// One house style, shared with the password-reset and test emails — see emailshell.ts.
import { renderEmail, emailContext, orgName, esc } from "./emailshell.js";
import { digestSettings, queueForDigest } from "./digest.js";
import { homeCurrency } from "./orgsettings.js";

/** Plain text out of one of the trusted HTML fragments callers pass in `lines`. */
const stripHtml = (s: string) =>
  s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();

/** Rule keys mirror the labels rendered in Settings → Notifications so the toggles line up. */
export type RuleKey =
  | "Approval requested"
  | "Renewal due ≤ 30 days"
  | "Invoice overdue"
  | "Request status change"
  | "SLA breached"
  | "Document rejected"
  // ── addressed to whoever owns the record, not to everybody ──────────────────────────────────
  // These existed as in-app rows only, which meant the entire sales-chasing layer was invisible to
  // anybody not sitting in the console. They get their own keys so an admin can silence the ones
  // their team does not want without losing the client-facing mail above.
  | "Follow-up due"
  | "Deal has gone quiet"
  | "Quotation needs chasing"
  | "Renewal became a deal"
  | "New website enquiry"
  // ── addressed to the person the work sits with (this is what reaches a pro_officer) ──────────
  | "Work assigned to you"
  | "Your task is running late";

const RULE_DEFAULTS: Record<RuleKey, boolean> = {
  "Approval requested": true,
  "Renewal due ≤ 30 days": true,
  "Invoice overdue": true,
  "Request status change": true,
  "SLA breached": true,
  "Document rejected": false,
  "Follow-up due": true,
  // Off by default. It fires on a timer rather than on something a person did, so it is the one most
  // likely to arrive daily and be filtered away — taking the useful mail above with it. An office
  // that wants it can switch it on; one that gets it unasked learns to ignore this sender.
  "Deal has gone quiet": false,
  "Quotation needs chasing": true,
  "Renewal became a deal": true,
  "New website enquiry": true,
  "Work assigned to you": true,
  "Your task is running late": true,
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

/**
 * Staff who should hear about client activity ACROSS the whole book: admins only, deliberately.
 * An officer does not need to know about every client's invoice — they need to know about their own
 * work, which is what `audience: "assignee"` is for.
 */
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

/**
 * The person who owns this record — and what to do when nobody does.
 *
 * Every CRM reminder in jobs.ts is addressed to somebody in particular: chase THIS quote, ring THIS
 * lead, that deal of YOURS has not moved. Sending those to the whole admin list is how a notification
 * channel becomes noise nobody reads, so ownership is resolved to one mailbox.
 *
 * THE UNOWNED CASE IS THE INTERESTING ONE. A lead nobody owns, with a follow-up nobody will do, is
 * precisely the record most likely to be dropped — so silence is the worst possible answer. It falls
 * back to the admins, and `orphan` comes back true so the caller can SAY that nobody owns it rather
 * than mailing an admin a reminder that reads as though it were theirs.
 */
async function ownerRecipients(a: { ownerId?: string | null; companyId?: string | null; anyRole?: boolean }): Promise<{ to: string[]; orphan: boolean; name: string | null }> {
  try {
    let ownerId = a.ownerId ?? null;
    if (!ownerId && a.companyId) {
      const co = await prisma.company.findUnique({ where: { id: a.companyId }, select: { ownerId: true } });
      ownerId = co?.ownerId ?? null;
    }
    if (ownerId) {
      const u = await prisma.user.findUnique({ where: { id: ownerId }, select: { email: true, name: true, status: true, type: true } });
      // A departed or suspended owner is the same problem as no owner: nobody is reading that inbox.
      if (u?.email && u.type === "staff" && u.status === "active") return { to: [u.email], orphan: false, name: u.name };
    }
    return { to: await staffRecipients(), orphan: true, name: null };
  } catch {
    return { to: [], orphan: true, name: null };
  }
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
  /**
   * `owner`    — the salesperson who owns the record.
   * `assignee` — the person the task sits with. THE ONLY WAY A pro_officer EVER GETS EMAIL: every
   *              other audience resolves to admins or to the client, so an officer could do all the
   *              work in the product and never receive a single message about it.
   */
  audience: "staff" | "client" | "owner" | "assignee";
  companyId?: string | null;
  /** For `audience: "owner"`. Falls back to the company's owner, then to the admins. */
  ownerId?: string | null;
  /** For `audience: "assignee"`. Any active staff role — not just admins. */
  assigneeId?: string | null;
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
  // `assignee` shares the owner resolver: the rules are identical — one active staff mailbox, with
  // the admins picking it up when there is nobody. Only the wording differs.
  const owner = args.audience === "owner" ? await ownerRecipients({ ownerId: args.ownerId, companyId: args.companyId })
    : args.audience === "assignee" ? await ownerRecipients({ ownerId: args.assigneeId })
    : null;
  const to = args.audience === "staff" ? await staffRecipients()
    : owner ? owner.to
    : await clientRecipients(args.companyId);
  if (!to.length) return;

  // ── digest mode ────────────────────────────────────────────────────────────────────────────
  // Only owner-addressed mail is ever held. A client waiting on an answer, and an admin being told
  // an SLA broke, both need it now — see the note at the top of digest.ts.
  if (args.audience === "owner" || args.audience === "assignee") {
    const cfg = await digestSettings();
    if (cfg.mode === "daily") {
      // The subject line is already a one-line summary written for an inbox, so it is reused rather
      // than a second one being invented that could drift from it.
      const detail = args.lines.map(stripHtml).filter(Boolean).find(l => l !== stripHtml(args.heading)) ?? null;
      for (const email of [...new Set(to)]) {
        await queueForDigest({
          email, rule: args.rule,
          title: args.subject.slice(0, 500),
          detail: detail ? detail.slice(0, 500) : null,
          url: args.cta?.url ?? null,
          orphan: !!owner?.orphan,
        });
      }
      return;
    }
  }

  const ctx = await emailContext();
  const org = ctx.org;
  const { html, text } = renderEmail(ctx, {
    heading: args.heading,
    // An admin reading an orphan's reminder must not mistake it for their own work. The line says
    // whose it is — and when it is nobody's, that IS the message, so it leads.
    lines: owner?.orphan
      ? [args.audience === "assignee"
        ? "<b>Nobody is assigned to this</b>, so it has come to the admins. Give it to somebody and it will go to them instead."
        : "<b>Nobody owns this record</b>, so this has come to the admins. Assign an owner and it will go to them instead.",
        ...args.lines]
      : args.lines,
    cta: args.cta,
    note: owner
      ? (owner.orphan
        ? `You're receiving this because you administer ${esc(org)} and this has nobody on it.`
        : args.audience === "assignee"
          ? `You're receiving this because this work is assigned to you at ${esc(org)}.`
          : `You're receiving this because you own this record at ${esc(org)}.`)
      : `You're receiving this because you have an account with ${esc(org)}.`,
  });
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

/**
 * A figure with the currency somebody actually configured beside it.
 *
 * Async because the firm's currency is a setting now, which is why the two templates below wrap
 * their bodies: they keep their fire-and-forget signatures — no caller awaits them — while still
 * reading a value that lives in the database rather than in a literal.
 */
async function money(amount: number, currency?: string | null): Promise<string> {
  return `${currency || await homeCurrency()} ${Number(amount).toLocaleString()}`;
}

export function notifyInvoiceRaised(a: { companyId?: string | null; number?: string | null; amount?: number | null; currency?: string | null; dueDate?: string | null }) {
  void (async () => {
  const amt = a.amount != null ? await money(a.amount, a.currency) : "";
  notify({
    rule: "Invoice overdue",
    audience: "client",
    companyId: a.companyId,
    subject: `Invoice ${a.number ?? ""} from your PRO team`.trim(),
    heading: `Invoice ${a.number ?? ""} is ready`.trim(),
    lines: [amt ? `Amount due: <b>${esc(amt)}</b>` : "", a.dueDate ? `Due: ${esc(a.dueDate)}` : ""],
    cta: { label: "View the invoice", url: `${portalUrl()}/portal/invoices` },
  });
  })().catch(e => console.error("[notify] invoice raised failed:", e?.message ?? e));
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
  void (async () => {
  const amt = await money(a.outstanding, a.currency);
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
  })().catch(e => console.error("[notify] invoice overdue failed:", e?.message ?? e));
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

/** An add-on taken back off the plan — the client loses access, so they are told rather than finding out. */
export function notifyAddonRemoved(a: { companyId?: string | null; serviceName?: string | null }) {
  const name = a.serviceName || "A service";
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    inApp: { type: "system", title: `${name} was removed from your plan` },
    subject: `${name} has been removed from your plan`,
    heading: "A service was removed from your plan",
    lines: [
      `Service: <b>${esc(name)}</b>`,
      "You will not be charged for it again. If this was not expected, reply to this email and your PRO team will sort it out.",
      "You can ask for it again from your service catalog at any time.",
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

/**
 * The other end of notifyDocumentExpiring.
 *
 * A client was told "your document needs renewing — your PRO team is on it" and then never told it
 * was done. The renewal completed, a new expiry was filed, and the only way to find out was to go
 * looking. Closing that loop is the difference between a service and a black box.
 */
export function notifyDocumentRenewed(a: { companyId?: string | null; docType?: string | null; person?: string | null; expiryDate?: string | null; docNumber?: string | null }) {
  const who = a.person ? ` — ${a.person}` : "";
  notify({
    rule: "Renewal due ≤ 30 days",
    audience: "client",
    companyId: a.companyId,
    subject: `${a.docType ?? "Document"}${who} has been renewed`,
    heading: "Your document has been renewed",
    lines: [
      `<b>${esc(a.docType ?? "Document")}${esc(who)}</b> is renewed and on file.`,
      a.expiryDate ? `New expiry: <b>${esc(a.expiryDate)}</b>.` : "",
      a.docNumber ? `Reference: ${esc(a.docNumber)}.` : "",
      "No action is needed from you.",
    ].filter(Boolean),
    cta: { label: "View your documents", url: `${portalUrl()}/portal/documents` },
  });
}

// ── Request lifecycle ─────────────────────────────────────────────────────────
// A client used to hear exactly once about a request they raised: the acknowledgement. Whether it
// was taken on, what was happening to it, and whether it finished were all invisible unless they
// went looking. These three close that gap at the moments a person actually wants to be told.

/** Accepted: the firm has committed, and work now exists. */
export function notifyRequestAccepted(a: {
  companyId?: string | null; number?: string | null; serviceName?: string | null;
  hasWorkflow?: boolean; steps?: number | null; firstStep?: string | null;
}) {
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    subject: `We've started work on your request${a.number ? ` ${a.number}` : ""}`,
    heading: "Your request has been accepted",
    lines: [
      a.serviceName ? `Service: <b>${esc(a.serviceName)}</b>` : "",
      // Only promise steps when there are steps. Ten of fourteen services have no workflow bound, and
      // telling a client to expect a tracked process that does not exist is a promise nobody kept.
      a.hasWorkflow && a.steps
        ? `We'll take it through ${a.steps} step${a.steps === 1 ? "" : "s"}${a.firstStep ? `, starting with <b>${esc(a.firstStep)}</b>` : ""}. You can follow it in your portal.`
        : "Your PRO team is handling it and will keep you updated here.",
    ],
    cta: { label: "Track it in your portal", url: `${portalUrl()}/portal/my-requests` },
  });
}

/** Finished: said once, when the work is genuinely complete. */
export function notifyRequestCompleted(a: { companyId?: string | null; number?: string | null; serviceName?: string | null }) {
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    subject: `Completed${a.number ? `: request ${a.number}` : ": your request"}`,
    heading: "Your request is complete",
    lines: [
      a.serviceName ? `Service: <b>${esc(a.serviceName)}</b>` : "",
      "Any documents issued are in your portal under Documents.",
    ],
    cta: { label: "See the result", url: `${portalUrl()}/portal/my-requests` },
  });
}

/** Declined: carries the reason, because a refusal with no explanation is just a silence. */
export function notifyRequestRejected(a: { companyId?: string | null; number?: string | null; serviceName?: string | null; reason: string }) {
  notify({
    rule: "Request status change",
    audience: "client",
    companyId: a.companyId,
    subject: `About your request${a.number ? ` ${a.number}` : ""}`,
    heading: "We could not proceed with this request",
    lines: [
      a.serviceName ? `Service: <b>${esc(a.serviceName)}</b>` : "",
      `<span style="white-space:pre-wrap;">${esc(a.reason)}</span>`,
      "Reply in your portal if you'd like us to look again.",
    ],
    cta: { label: "Reply in your portal", url: `${portalUrl()}/portal/my-requests` },
  });
}

// ─────────────────────────────────────────────────────────────
// OWNER-ADDRESSED REMINDERS
//
// Everything below is the sales-chasing layer that used to write an in-app row and stop there. Each
// one is addressed to the person who owns the record — see `ownerRecipients` — falling back to the
// admins with the orphan line when nobody does.
//
// THEY ARE ALL AWAITABLE AND NONE OF THEM DEDUPE. That is deliberate: they are called from the
// hourly tick, immediately after `notifyOnce` has already decided this event is new. Deduping again
// here would mean two independent judgements about the same event, which is how a bell row and an
// email drift apart. The dedupe key is the single decision; these just carry it to a mailbox.
// ─────────────────────────────────────────────────────────────

const dealUrl = () => `${consoleUrl()}/pipeline`;

/** A commitment somebody made to a client has come due, or is already late. */
export function notifyFollowUpDue(a: {
  ownerId?: string | null; companyId?: string | null; companyName: string;
  action: string; dealTitle?: string | null; daysLate: number;
}) {
  const late = a.daysLate > 0;
  notify({
    rule: "Follow-up due",
    audience: "owner",
    ownerId: a.ownerId,
    companyId: a.companyId,
    subject: late ? `${a.daysLate} day${a.daysLate === 1 ? "" : "s"} late: ${a.action}` : `Due today: ${a.action}`,
    heading: late ? "A follow-up is overdue" : "A follow-up is due today",
    lines: [
      `<b>${esc(a.action)}</b>`,
      `${esc(a.companyName)}${a.dealTitle ? ` — ${esc(a.dealTitle)}` : ""}`,
      late
        ? `This was promised ${a.daysLate} day${a.daysLate === 1 ? "" : "s"} ago and has not been marked done.`
        : "Mark it done in the console once you have dealt with it, or set the next step.",
    ],
    cta: { label: "Open follow-ups", url: `${consoleUrl()}/follow-ups` },
  });
}

/** A deal or a lead that nothing has happened to for a while. */
export function notifyGoneQuiet(a: {
  ownerId?: string | null; companyId?: string | null; what: string; name: string; days: number; kind: "deal" | "lead";
}) {
  notify({
    rule: "Deal has gone quiet",
    audience: "owner",
    ownerId: a.ownerId,
    companyId: a.companyId,
    subject: `No movement for ${a.days} days: ${a.name}`,
    heading: a.kind === "deal" ? "A deal has gone quiet" : "A lead has gone quiet",
    lines: [
      `<b>${esc(a.name)}</b>`,
      `Nothing has been recorded against ${esc(a.what)} for <b>${a.days} days</b>.`,
      "Either move it on, or close it — a board full of deals nobody is working stops being a forecast.",
    ],
    cta: { label: a.kind === "deal" ? "Open the pipeline" : "Open leads", url: a.kind === "deal" ? dealUrl() : `${consoleUrl()}/leads` },
  });
}

/** A quotation that has gone unanswered, is about to lapse, or already has. */
export function notifyQuoteChase(a: {
  ownerId?: string | null; companyId?: string | null; number: string; clientName: string;
  state: "silent" | "expiring" | "lapsed"; days: number; validUntil?: string | null;
}) {
  const copy = {
    silent: { h: "A quotation has had no reply", l: `Sent <b>${a.days} days</b> ago with no answer either way.` },
    expiring: { h: "A quotation is about to lapse", l: `It is valid for <b>${a.days} more day${a.days === 1 ? "" : "s"}</b>${a.validUntil ? ` (until ${esc(a.validUntil)})` : ""}.` },
    lapsed: { h: "A quotation has lapsed", l: `It expired ${a.days === 0 ? "today" : `${a.days} day${a.days === 1 ? "" : "s"} ago`}${a.validUntil ? ` (${esc(a.validUntil)})` : ""} without an answer.` },
  }[a.state];
  notify({
    rule: "Quotation needs chasing",
    audience: "owner",
    ownerId: a.ownerId,
    companyId: a.companyId,
    subject: `${a.number} — ${a.state === "lapsed" ? "lapsed" : a.state === "expiring" ? "about to lapse" : "no reply"}`,
    heading: copy.h,
    lines: [`<b>${esc(a.number)}</b> — ${esc(a.clientName)}`, copy.l, "Chase it, re-quote it, or mark the deal lost so the figures stay honest."],
    cta: { label: "Open quotations", url: `${consoleUrl()}/quotations` },
  });
}

/** A subscription coming up for renewal has put a deal on the board. */
export function notifyRenewalDeal(a: {
  ownerId?: string | null; companyId?: string | null; clientName: string; title: string; endDate?: string | null;
}) {
  notify({
    rule: "Renewal became a deal",
    audience: "owner",
    ownerId: a.ownerId,
    companyId: a.companyId,
    subject: `Renewal due: ${a.clientName}`,
    heading: "A renewal is now on the board",
    lines: [
      `<b>${esc(a.title)}</b> — ${esc(a.clientName)}`,
      a.endDate ? `The current term ends <b>${esc(a.endDate)}</b>.` : "",
      "It has been opened as a deal so the renewal is forecast rather than assumed.",
    ],
    cta: { label: "Open the pipeline", url: dealUrl() },
  });
}

/**
 * Somebody filled in the form on the website.
 *
 * Addressed to the OWNER because intake may auto-assign one (see salesrules.autoAssignOwner) — and
 * when it does not, the orphan fallback puts it in front of the admins, which is exactly right for a
 * brand-new enquiry nobody has picked up.
 */
export function notifyWebEnquiry(a: {
  ownerId?: string | null; companyId?: string | null; name: string; source: string;
  message?: string | null; email?: string | null; phone?: string | null; repeat?: boolean;
}) {
  notify({
    rule: "New website enquiry",
    audience: "owner",
    ownerId: a.ownerId,
    companyId: a.companyId,
    subject: a.repeat ? `Repeat enquiry: ${a.name}` : `New enquiry: ${a.name}`,
    heading: a.repeat ? "Somebody already on file has enquired again" : "A new enquiry has come in",
    lines: [
      `<b>${esc(a.name)}</b> — via ${esc(a.source)}`,
      [a.email ? esc(a.email) : "", a.phone ? esc(a.phone) : ""].filter(Boolean).join(" · "),
      a.message ? `<span style="white-space:pre-wrap;">${esc(a.message)}</span>` : "No message was left.",
    ],
    cta: { label: "Open leads", url: `${consoleUrl()}/leads` },
  });
}

// ─────────────────────────────────────────────────────────────
// ASSIGNEE-ADDRESSED — the only mail a pro_officer ever receives.
//
// `staffRecipients` is admins-only and always has been, and every other audience resolves to the
// client or to the record's owner. So the people who actually do the work — officers running the
// government steps — could complete a hundred tasks and never get one email about any of them.
// These two go to whoever the task is assigned to, whatever their role.
// ─────────────────────────────────────────────────────────────

/** Work has landed on somebody's desk. */
export function notifyTaskAssigned(a: { assigneeId?: string | null; title: string; why?: string | null; clientName?: string | null; dueDate?: string | null }) {
  notify({
    rule: "Work assigned to you",
    audience: "assignee",
    assigneeId: a.assigneeId,
    subject: `Assigned to you: ${a.title}`,
    heading: "A step has been assigned to you",
    lines: [
      `<b>${esc(a.title)}</b>`,
      [a.clientName ? esc(a.clientName) : "", a.why ? esc(a.why) : ""].filter(Boolean).join(" · "),
      a.dueDate ? `Due <b>${esc(a.dueDate)}</b>.` : "",
    ],
    cta: { label: "Open your work", url: `${consoleUrl()}/my-work` },
  });
}

/**
 * A step of theirs is at risk or already past its SLA.
 *
 * This does NOT replace `notifySlaBreach`, which tells the admins. Both are right: a breach is a
 * management fact AND somebody's specific job. The admin version reports across the queue; this one
 * names one task to one person, and is the half that was missing.
 */
export function notifyTaskLate(a: { assigneeId?: string | null; title: string; state: "at risk" | "breached"; hoursOver?: number | null; clientName?: string | null }) {
  const breached = a.state === "breached";
  notify({
    rule: "Your task is running late",
    audience: "assignee",
    assigneeId: a.assigneeId,
    subject: breached ? `Past its deadline: ${a.title}` : `Running late: ${a.title}`,
    heading: breached ? "A step of yours has missed its deadline" : "A step of yours is about to miss its deadline",
    lines: [
      `<b>${esc(a.title)}</b>`,
      a.clientName ? esc(a.clientName) : "",
      breached
        ? `It is past the time it was meant to be finished${a.hoursOver ? ` by about ${a.hoursOver} hour${a.hoursOver === 1 ? "" : "s"}` : ""}.`
        : "There is still time, but not much.",
    ],
    cta: { label: "Open your work", url: `${consoleUrl()}/my-work` },
  });
}
