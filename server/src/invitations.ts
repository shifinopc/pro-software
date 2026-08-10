/**
 * INVITATIONS — how somebody gets their first way in.
 *
 * WHAT THIS REPLACES
 *
 * Every account this system created was born with a generated password that was returned in the API
 * response, rendered in a "shown only once" dialog, and then relayed to the person by hand — read
 * over the phone, or pasted into WhatsApp. That had three problems, in rising order of seriousness:
 *
 *   1. It did not scale. Onboarding a client meant a staff member had a manual errand afterwards,
 *      and if they forgot, the client simply never got in.
 *   2. The secret ended up in a chat log, on somebody's screen, in a clipboard — places that do not
 *      forget, and that nobody ever cleans out.
 *   3. It never expired. A password pasted into a thread in March still worked in December.
 *
 * A LINK IS NOT A PASSWORD
 *
 * So an invited account now has NO password: `passwordHash` is null, and `doLogin` refuses an account
 * with no hash, so there is nothing to guess and nothing to leak. The only way in is a one-time link
 * that expires, and using it is what sets the first password. That reuses the reset-token columns and
 * the /reset page that already exist — this is not a second credential system, it is the same one
 * pointed at a new moment.
 *
 * FAILURE IS NOT AN OPTION HERE, SO IT IS AN OUTCOME INSTEAD
 *
 * An email that will not send must never roll back an account that was created, and must never leave
 * an admin with no way to help. So sending NEVER throws: it reports `emailed: false` and hands back
 * the link, and the console shows the link for a human to relay — which is the old manual path, minus
 * the permanent secret. Resending is a first-class action for the same reason.
 */
import crypto from "node:crypto";
import { prisma } from "./db.js";
import { sendMail } from "./mailer.js";
import { renderEmail, emailContext, esc } from "./emailshell.js";

/**
 * How long an invitation is good for.
 *
 * Deliberately far longer than the one-hour password RESET: a reset is answered by somebody sitting
 * at the screen who just asked for it, while an invitation is sent to a client who may be on leave,
 * in another timezone, or not expecting it at all. An hour would expire before most people opened it,
 * and an invitation that has already died by the time it is read produces exactly the support call it
 * was meant to prevent. A week is long enough to survive a holiday and short enough that a forwarded
 * mailbox from a departed employee is not a standing back door.
 */
export const INVITE_TTL_HOURS = 24 * 7;

const portalUrl = () => process.env.PORTAL_URL || "https://cp.ionob.in";
const consoleUrl = () => process.env.CONSOLE_URL || "https://pro.ionob.in";

/** Where this person signs in. Portal users land on cp., staff on pro. */
export const homeFor = (type: string | null | undefined) => (type === "portal" ? portalUrl() : consoleUrl());

export interface InviteResult {
  email: string;
  /** The one-time link. Always returned so a human can relay it when mail is down. */
  link: string;
  /** Whether it actually left the building. False when email is off, unconfigured, or it failed. */
  emailed: boolean;
  /** Why it did not send, when it did not. Safe to show an admin. */
  error?: string;
  expiresAt: string;
}

/**
 * Mint a fresh invitation token for a user, replacing any previous one.
 *
 * Only the SHA-256 lands in the database, so the link cannot be reconstructed from a database dump
 * or a backup — the same handling the password-reset flow already uses.
 */
export async function issueInviteToken(userId: string): Promise<{ raw: string; expiresAt: string }> {
  const raw = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000).toISOString();
  await prisma.user.update({ where: { id: userId }, data: { resetTokenHash: hash, resetExpires: expiresAt } });
  return { raw, expiresAt };
}

/** "in 7 days" / "in 24 hours" — said the way a person would say it. */
const humanTtl = () => (INVITE_TTL_HOURS % 24 === 0 ? `${INVITE_TTL_HOURS / 24} days` : `${INVITE_TTL_HOURS} hours`);

/**
 * Invite somebody, or invite them again. Never throws.
 *
 * `resend` only changes the words: the token is reissued either way, so an older link stops working
 * the moment a newer one is sent. Two live invitations to one account is the kind of thing that is
 * fine until the day somebody uses the wrong one and cannot explain why it failed.
 */
export async function sendInvitation(
  user: { id: string; name: string; email: string; type: string | null; roleId?: string | null },
  opts: { companyName?: string | null; invitedBy?: string | null; resend?: boolean } = {},
): Promise<InviteResult> {
  const { raw, expiresAt } = await issueInviteToken(user.id);
  const home = homeFor(user.type);
  const link = `${home}/reset?token=${raw}`;
  const isPortal = user.type === "portal";

  try {
    const ctx = await emailContext();
    const org = ctx.org;
    const who = opts.companyName ? ` for <b>${esc(opts.companyName)}</b>` : "";
    const { html, text } = renderEmail(ctx, {
      heading: opts.resend ? "Here is your sign-in link again" : `Set up your ${isPortal ? "client portal" : "STIMES PRO"} account`,
      preheader: `Choose a password to activate your account. The link is valid for ${humanTtl()}.`,
      lines: [
        `Hello ${esc(user.name)},`,
        opts.resend
          ? `A new sign-in link has been issued for your account${who}. Any earlier link has now stopped working.`
          : isPortal
            ? `An account has been created for you${who} on the ${esc(org)} client portal, where you can track your requests, documents and invoices.`
            : `An account has been created for you at ${esc(org)}.`,
        `Choose your password using the button below. <b>Nobody — including us — can see it</b>, and until you set one this account has no password at all.`,
      ],
      cta: { label: "Set your password", url: link },
      facts: [
        { label: "Sign in at", value: esc(home.replace(/^https?:\/\//, "")) },
        { label: "Your email", value: esc(user.email) },
        { label: "Link expires", value: `${esc(humanTtl())} from now` },
      ],
      note: `If the button doesn't work, copy this address into your browser:<br><span style="word-break:break-all;">${esc(link)}</span>`,
    });
    const r = await sendMail({
      to: user.email,
      subject: opts.resend ? `Your ${org} sign-in link` : `Set up your ${org} account`,
      html, text,
    });
    // sendMail reports `sent: false` when the admin has switched sending off — that is a
    // configuration state, not a failure, but from the caller's side the effect is identical: the
    // person did not receive anything, so somebody still has to hand them the link.
    return { email: user.email, link, emailed: r.sent, expiresAt, ...(r.sent ? {} : { error: "Email sending is turned off in Settings → Email" }) };
  } catch (e: any) {
    const error = String(e?.message ?? e);
    console.error(`[invite] could not email ${user.email}: ${error}`);
    return { email: user.email, link, emailed: false, error, expiresAt };
  }
}
