/**
 * ONE house style for every email this system sends.
 *
 * Before this there were three: the notification templates had a branded shell, the password-reset
 * mail was three bare <p> tags, and the "send test email" button sent two sentences with no
 * letterhead at all — so the message an admin uses to judge whether email works looked nothing like
 * the messages their clients actually receive.
 *
 * WHY IT LOOKS LIKE 2005 HTML
 *
 * Mail clients are not browsers. Outlook desktop renders with Word, Gmail strips <style> blocks in
 * forwarded mail, and neither honours flexbox, grid, or most of what the console is built from. So:
 * tables for layout, inline styles only, and every gradient laid over a solid `bgcolor` that carries
 * the design on its own when the gradient is dropped. None of this is nostalgia — it is the only
 * subset that renders the same in Gmail, Outlook, Apple Mail and the phone clients.
 *
 * `lines` and fact values are TRUSTED HTML — callers escape their own values with `esc` because they
 * are the ones who know which fragments are meant to carry <b>. `heading`, `cta.label` and the org
 * name are escaped here, since those are never markup.
 */
import { prisma } from "./db.js";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** House palette — the console's own, restated as literals because email cannot read CSS variables. */
const INK = "#26074D";
const ACCENT = "#7C00FF";
const INK_BODY = "#3B3547";
const MUTED = "#8C8899";
const HAIRLINE = "#EDEBF2";
const GROUND = "#F3F1F7";

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

export interface EmailFact {
  label: string;
  /** Trusted HTML — escape it yourself if it came from a user. */
  value: string;
}

export interface EmailOptions {
  heading: string;
  /** Trusted HTML fragments, one paragraph each. Empty strings are dropped. */
  lines?: string[];
  /** A small labelled table — amounts, dates, reference numbers. */
  facts?: EmailFact[];
  cta?: { label: string; url: string };
  /** Small print directly above the footer rule, e.g. why this address is being written to. */
  note?: string;
  /** The grey line shown after the subject in most inboxes. Falls back to the first body line. */
  preheader?: string;
}

/** The organisation's own name, as configured in Settings → General. */
export async function orgName(): Promise<string> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "org" } });
    const v = (row?.value ?? {}) as Record<string, unknown>;
    return String(v.legalName || v.orgName || "STIMES PRO");
  } catch {
    return "STIMES PRO";
  }
}

const stripTags = (s: string) =>
  s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .trim();

/**
 * Render one email in the house style. Returns BOTH parts: a plain-text alternative is not optional
 * politeness — a message sent as HTML alone scores as spam and is unreadable in text-only clients.
 * Generating it here means no caller can forget it or let it drift from the HTML.
 */
/**
 * Everything the letterhead needs that is not about this particular message.
 *
 * `repliesTo` is in here — rather than being an optional extra on EmailOptions — for one reason: the
 * footer makes a factual claim about whether a reply reaches a human. When a reply-to address is
 * configured and the footer still reads "replies are not monitored", the email is lying to a client
 * who is about to be ignored. Making it part of the required context means a new caller cannot
 * silently reintroduce that; they have to say which it is.
 */
export interface EmailContext {
  org: string;
  /** Where a reply lands, or empty/null when nowhere. */
  repliesTo?: string | null;
}

/** The organisation name and reply-to address, read together for the letterhead. */
export async function emailContext(): Promise<EmailContext> {
  const { getEmailConfig } = await import("./mailer.js");
  const [org, cfg] = await Promise.all([orgName(), getEmailConfig().catch(() => null)]);
  return { org, repliesTo: cfg?.replyTo || null };
}

export function renderEmail(ctx: EmailContext, o: EmailOptions): { html: string; text: string } {
  const org = ctx.org;
  const replyLine = ctx.repliesTo
    ? `Sent by ${esc(org)}. Replies go to ${esc(ctx.repliesTo)}.`
    : `Sent by ${esc(org)}. This is an automated message — replies to it are not monitored.`;
  const lines = (o.lines ?? []).filter(Boolean);
  const facts = (o.facts ?? []).filter(f => f && f.value);

  // Inboxes show this after the subject. Padding it with zero-width spaces stops the client
  // pulling the letterhead in after it, which is what produces "STIMES PRO STIMES PRO STIMES…".
  const preheader = esc(o.preheader || stripTags(lines[0] ?? o.heading)).slice(0, 140);

  const factRows = facts.map((f, i) => `
              <tr>
                <td style="padding:${i === 0 ? "0" : "9px"} 12px 9px 0;border-top:${i === 0 ? "none" : `1px solid ${HAIRLINE}`};font:400 11px/1.4 ${FONT};color:${MUTED};text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;vertical-align:top;">${esc(f.label)}</td>
                <td style="padding:${i === 0 ? "0" : "9px"} 0 9px 0;border-top:${i === 0 ? "none" : `1px solid ${HAIRLINE}`};font:400 13px/1.5 ${FONT};color:${INK};text-align:right;">${f.value}</td>
              </tr>`).join("");

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}${"&#8203;&nbsp;".repeat(60)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
    <tr><td align="center" style="padding:28px 14px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#FFFFFF;border:1px solid ${HAIRLINE};border-radius:14px;overflow:hidden;">

        <tr><td bgcolor="${INK}" style="background:${INK};background-image:linear-gradient(110deg,${INK},${ACCENT});padding:20px 24px;">
          <div style="font:400 10px/1 ${FONT};color:#C9AEEA;text-transform:uppercase;letter-spacing:.14em;">${esc(org)}</div>
          <div style="font:700 17px/1.3 ${FONT};color:#FFFFFF;padding-top:7px;">${esc(o.heading)}</div>
        </td></tr>

        <tr><td style="padding:24px;">
          ${lines.map(l => `<p style="margin:0 0 12px;font:400 14px/1.65 ${FONT};color:${INK_BODY};">${l}</p>`).join("")}
          ${facts.length ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${lines.length ? "18px" : "0"} 0 0;background:#FBFAFE;border:1px solid ${HAIRLINE};border-radius:10px;">
            <tr><td style="padding:14px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${factRows}
              </table>
            </td></tr>
          </table>` : ""}
          ${o.cta ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;">
            <tr><td bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:99px;">
              <a href="${esc(o.cta.url)}" style="display:inline-block;padding:12px 24px;font:600 14px/1 ${FONT};color:#FFFFFF;text-decoration:none;">${esc(o.cta.label)}</a>
            </td></tr>
          </table>` : ""}
          ${o.note ? `<p style="margin:20px 0 0;font:400 12px/1.6 ${FONT};color:${MUTED};">${o.note}</p>` : ""}
        </td></tr>

        <tr><td style="padding:0 24px;"><div style="border-top:1px solid ${HAIRLINE};"></div></td></tr>
        <tr><td style="padding:16px 24px 20px;">
          <div style="font:400 11px/1.6 ${FONT};color:${MUTED};">${replyLine}</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    org.toUpperCase(),
    "",
    o.heading,
    "",
    ...lines.map(stripTags),
    ...(facts.length ? ["", ...facts.map(f => `${f.label}: ${stripTags(f.value)}`)] : []),
    ...(o.cta ? ["", `${o.cta.label}: ${o.cta.url}`] : []),
    ...(o.note ? ["", stripTags(o.note)] : []),
    "",
    "—",
    stripTags(replyLine),
  ].join("\n");

  return { html, text };
}

/** Render with the configured letterhead, for callers that have no context to hand. */
export async function composeEmail(o: EmailOptions) {
  return renderEmail(await emailContext(), o);
}
