import nodemailer from "nodemailer";
import { prisma } from "./db.js";

// Email is optional and now ADMIN-CONFIGURABLE: settings saved in the console (Settings → Email)
// live in AppSetting "email" and win over the SMTP_* env vars, so a deployment can be re-pointed at
// a different mail provider without a redeploy. With neither configured we log the message instead
// of sending (so password-reset links still work in dev / before SMTP is wired).
export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Where a human reply should land. Empty = replies go nowhere, and the footer says so. */
  replyTo: string;
  enabled: boolean;
}

const envConfig = (): Partial<EmailConfig> => ({
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.SMTP_FROM || "STIMES PRO <no-reply@ionob.in>",
  // No default address here on purpose. Falling back to `from` would point replies at the no-reply
  // mailbox — the exact silent dead end this setting exists to end.
  replyTo: process.env.SMTP_REPLY_TO || "",
});

/**
 * Effective mail settings: the saved record layered over the env defaults.
 * Never cached — an admin saving new settings must apply to the very next email.
 */
export async function getEmailConfig(): Promise<EmailConfig> {
  const env = envConfig();
  let saved: Record<string, unknown> = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "email" } });
    if (row?.value && typeof row.value === "object") saved = row.value as Record<string, unknown>;
  } catch { /* table unavailable → fall back to env */ }

  const str = (a: unknown, b: string) => (typeof a === "string" && a.trim() ? a.trim() : b);
  const host = str(saved.host, env.host!);
  const user = str(saved.user, env.user!);
  // A blank saved password means "keep what we already have" — the API never returns the stored
  // secret, so a round-trip of the form must not wipe it.
  const pass = str(saved.pass, env.pass!);
  const port = Number(saved.port) > 0 ? Number(saved.port) : env.port!;
  return {
    host, port,
    secure: typeof saved.secure === "boolean" ? saved.secure : env.secure!,
    user, pass,
    from: str(saved.from, env.from!),
    // Deliberately NOT defaulted to `from`: a no-reply address that accepts replies into a void is
    // exactly the behaviour this setting exists to fix. Empty means empty, and is said out loud.
    replyTo: str(saved.replyTo, env.replyTo!),
    // Sending needs a host at minimum; auth is optional (some relays are IP-allowlisted).
    enabled: saved.enabled === false ? false : !!host,
  };
}

function transportFor(cfg: EmailConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Fail FAST when the mail server is unreachable. Without these, nodemailer waits on the OS TCP
    // timeout (minutes), so an SMTP outage leaves a growing pile of pending sends — notifications are
    // fire-and-forget, so nobody is waiting on them and the failure would surface far too late.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    ...(cfg.user ? { auth: { user: cfg.user, pass: cfg.pass } } : {}),
  });
}

/**
 * Record what happened to one message. NEVER throws, and NEVER sends anything.
 *
 * The second half of that matters: the obvious way to surface a mail failure is to tell somebody —
 * and telling somebody is sending an email, which is the thing that just failed. A broken relay would
 * generate a failure per notification per failure, forever. So this writes a row and stops. The
 * in-app bell and the log screen are how a human finds out; nothing here reaches for the transport.
 *
 * `to` and `subject` are stored, the body never is: a log an admin can browse should not become a
 * copy of every password-reset link and client document the system has ever mentioned.
 */
async function record(entry: { to: string; subject: string; status: "sent" | "failed" | "skipped"; kind?: string; error?: string }) {
  try {
    await prisma.mailLog.create({
      data: {
        to: entry.to.slice(0, 191),
        subject: entry.subject.slice(0, 2000),
        status: entry.status,
        kind: entry.kind?.slice(0, 191) ?? null,
        error: entry.error?.slice(0, 2000) ?? null,
        at: new Date().toISOString(),
      },
    });
  } catch (e: any) {
    // A logging failure must not become a sending failure.
    console.error(`[mailer] could not record ${entry.status} to ${entry.to}: ${e?.message ?? e}`);
  }
}

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string; kind?: string }) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    console.log(`[mailer:disabled] would send to ${opts.to} — "${opts.subject}"\n${opts.text ?? opts.html}`);
    // Recorded as `skipped`, not `failed`: sending being switched off is a decision somebody made,
    // and burying it among real faults would train an admin to ignore the log.
    await record({ to: opts.to, subject: opts.subject, status: "skipped", kind: opts.kind, error: "Sending is switched off in Settings → Email" });
    return { sent: false };
  }
  try {
    await transportFor(cfg).sendMail({
      from: cfg.from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
      ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}),
    });
  } catch (e: any) {
    // Recorded, then re-thrown unchanged. Callers already decide what a failure means to them —
    // `deliver()` swallows it, an invitation reports it back to the admin — and changing that here
    // would quietly alter behaviour everywhere. This adds a witness, it does not take over.
    await record({ to: opts.to, subject: opts.subject, status: "failed", kind: opts.kind, error: String(e?.message ?? e) });
    throw e;
  }
  await record({ to: opts.to, subject: opts.subject, status: "sent", kind: opts.kind });
  return { sent: true };
}

export interface MailFailureSummary {
  failed: number;
  skipped: number;
  sent: number;
  since: string;
  /** Most recent failures first — what an admin actually needs to read. */
  recent: { to: string; subject: string; error: string | null; kind: string | null; at: string }[];
}

/** How mail has been going lately. Powers the log panel and the Setup Check finding. */
export async function mailHealth(days = 7): Promise<MailFailureSummary> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [failed, skipped, sent, recent] = await Promise.all([
    prisma.mailLog.count({ where: { status: "failed", at: { gte: since } } }),
    prisma.mailLog.count({ where: { status: "skipped", at: { gte: since } } }),
    prisma.mailLog.count({ where: { status: "sent", at: { gte: since } } }),
    prisma.mailLog.findMany({ where: { status: "failed", at: { gte: since } }, orderBy: { at: "desc" }, take: 20 }),
  ]);
  return {
    failed, skipped, sent, since,
    recent: recent.map(r => ({ to: r.to, subject: r.subject, error: r.error, kind: r.kind, at: r.at })),
  };
}

/** Keep a month. Long enough to answer "did they ever get told?", short enough not to grow forever. */
export async function pruneMailLog(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const r = await prisma.mailLog.deleteMany({ where: { at: { lt: cutoff } } });
  return r.count;
}

/** Connect + authenticate without sending — powers the "Test connection" button. */
export async function verifyEmail(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getEmailConfig();
  if (!cfg.host) return { ok: false, error: "No SMTP host configured" };
  try {
    await transportFor(cfg).verify();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export const emailEnabled = async () => (await getEmailConfig()).enabled;
