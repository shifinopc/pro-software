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
  enabled: boolean;
}

const envConfig = (): Partial<EmailConfig> => ({
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true",
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.SMTP_FROM || "STIMES PRO <no-reply@ionob.in>",
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

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string }) {
  const cfg = await getEmailConfig();
  if (!cfg.enabled) {
    console.log(`[mailer:disabled] would send to ${opts.to} — "${opts.subject}"\n${opts.text ?? opts.html}`);
    return { sent: false };
  }
  await transportFor(cfg).sendMail({ from: cfg.from, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
  return { sent: true };
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
