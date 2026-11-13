/**
 * WHATSAPP — SENDING, AND KNOWING WHO YOU ARE SENDING TO.
 *
 * Clients read WhatsApp and ignore email. This is the channel beside `mailer.ts`, in the same
 * shape: configuration resolves, nothing is cached, and with nothing configured it LOGS what it
 * would have sent rather than failing — so a dev machine behaves like the mail path already does.
 *
 * TWO WAYS TO SEND, and the difference is Meta's, not ours:
 *   · `sendText`     — free-form, allowed ONLY inside 24 hours of the client's last message.
 *   · `sendTemplate` — a sentence Meta approved in advance, allowed any time, and billed.
 * So `notifyClient` below picks: a window is open → say it properly in our own words; no window →
 * the approved template. Getting this backwards is not a style error, it is a 400 from Meta or a
 * bill for a message that did not need to cost anything.
 *
 * THE TOKEN LIVES IN THE ENVIRONMENT, not in AppSetting where the SMTP password sits. It can send
 * messages as the firm to anybody, the test one rotates every 24 hours, and a copy in the database
 * is one more place it leaks from — a backup, a dump handed to somebody debugging, the admin
 * screen that reads settings. The phone number id is not a secret and is read the same way only
 * because it travels with the token.
 */
import { prisma } from "./db.js";

const GRAPH = "https://graph.facebook.com/v25.0";
const nowISO = () => new Date().toISOString();

export interface WaConfig {
  phoneNumberId: string;
  token: string;
  /** Sending is OFF unless this is explicitly true, even with credentials present. */
  enabled: boolean;
}

export function getWaConfig(): WaConfig {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || "",
    token: process.env.WHATSAPP_TOKEN || "",
    // Credentials alone are not consent to message real people. Someone has to say so.
    enabled: process.env.WHATSAPP_ENABLED === "true"
      && !!process.env.WHATSAPP_PHONE_NUMBER_ID && !!process.env.WHATSAPP_TOKEN,
  };
}

/**
 * A number in the form Meta wants: digits only, country code included, no plus.
 *
 * REFUSES rather than guesses. A nine-digit number with no country code could be Saudi, Indian or
 * Emirati, and picking one would send a client's renewal dates to a stranger who happens to hold
 * that number somewhere else. Null means "I will not send this", and every caller treats it so.
 */
export function waNumber(raw: string | null | undefined): string | null {
  let d = String(raw ?? "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  d = d.replace(/\D/g, "");
  // Shortest real E.164 is 8 digits (country code included); longest is 15.
  if (d.length < 10 || d.length > 15) return null;
  return d;
}

/** Record of every message either way, so "who told them that" has an answer. */
async function record(a: {
  direction: "out" | "in"; waId: string; body: string; kind?: string | null;
  status: string; error?: string | null; messageId?: string | null;
  companyId?: string | null; contactId?: string | null;
}) {
  try {
    await prisma.whatsAppMessage.create({
      data: {
        direction: a.direction, waId: a.waId, body: a.body.slice(0, 4000),
        kind: a.kind ?? null, status: a.status, error: a.error ?? null,
        messageId: a.messageId ?? null, companyId: a.companyId ?? null,
        contactId: a.contactId ?? null, at: nowISO(),
      },
    });
  } catch (e: any) {
    // A log that cannot be written must not take the message down with it.
    console.error("[whatsapp] could not record message:", e?.message ?? e);
  }
}

async function post(path: string, body: unknown, cfg: WaConfig) {
  const r = await fetch(`${GRAPH}/${cfg.phoneNumberId}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Meta's error object says far more than the status does — an unapproved template and an
    // expired token are both 400, and only the message tells them apart.
    const m = j?.error?.message || `HTTP ${r.status}`;
    const code = j?.error?.code ? ` (code ${j.error.code})` : "";
    throw new Error(m + code);
  }
  return j;
}

export type WaSendResult = { sent: boolean; messageId?: string; reason?: string };

/** Free text. Only legal inside 24 hours of the client's last message — see `hasOpenWindow`. */
export async function sendText(a: {
  to: string; body: string; kind?: string; companyId?: string | null; contactId?: string | null;
}): Promise<WaSendResult> {
  const cfg = getWaConfig();
  const to = waNumber(a.to);
  if (!to) {
    await record({ direction: "out", waId: String(a.to ?? ""), body: a.body, kind: a.kind, status: "failed",
      error: "not a usable international number", companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: "That number has no country code, so it cannot be dialled." };
  }
  if (!cfg.enabled) {
    console.log(`[whatsapp:disabled] would send to ${to} — ${a.body}`);
    await record({ direction: "out", waId: to, body: a.body, kind: a.kind, status: "skipped",
      error: "WhatsApp sending is switched off", companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: "WhatsApp sending is switched off." };
  }
  try {
    const j = await post("messages", {
      messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: a.body },
    }, cfg);
    const id = j?.messages?.[0]?.id ?? null;
    await record({ direction: "out", waId: to, body: a.body, kind: a.kind, status: "sent",
      messageId: id, companyId: a.companyId, contactId: a.contactId });
    return { sent: true, messageId: id ?? undefined };
  } catch (e: any) {
    await record({ direction: "out", waId: to, body: a.body, kind: a.kind, status: "failed",
      error: String(e?.message ?? e), companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: String(e?.message ?? e) };
  }
}

/**
 * An approved template, with its blanks filled in order.
 *
 * `preview` is what the client will actually read — stored on the log, because the template name
 * and three loose parameters tell whoever reads that log nothing at all about what was said.
 */
export async function sendTemplate(a: {
  to: string; name: string; language?: string; params?: string[]; preview?: string;
  kind?: string; companyId?: string | null; contactId?: string | null;
}): Promise<WaSendResult> {
  const cfg = getWaConfig();
  const to = waNumber(a.to);
  const shown = a.preview || `[template ${a.name}] ${(a.params ?? []).join(" · ")}`;
  if (!to) {
    await record({ direction: "out", waId: String(a.to ?? ""), body: shown, kind: a.kind, status: "failed",
      error: "not a usable international number", companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: "That number has no country code, so it cannot be dialled." };
  }
  if (!cfg.enabled) {
    console.log(`[whatsapp:disabled] would send template "${a.name}" to ${to} — ${shown}`);
    await record({ direction: "out", waId: to, body: shown, kind: a.kind, status: "skipped",
      error: "WhatsApp sending is switched off", companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: "WhatsApp sending is switched off." };
  }
  try {
    const j = await post("messages", {
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: a.name,
        language: { code: a.language || "en_US" },
        ...((a.params ?? []).length
          ? { components: [{ type: "body", parameters: (a.params ?? []).map(t => ({ type: "text", text: t })) }] }
          : {}),
      },
    }, cfg);
    const id = j?.messages?.[0]?.id ?? null;
    await record({ direction: "out", waId: to, body: shown, kind: a.kind, status: "sent",
      messageId: id, companyId: a.companyId, contactId: a.contactId });
    return { sent: true, messageId: id ?? undefined };
  } catch (e: any) {
    await record({ direction: "out", waId: to, body: shown, kind: a.kind, status: "failed",
      error: String(e?.message ?? e), companyId: a.companyId, contactId: a.contactId });
    return { sent: false, reason: String(e?.message ?? e) };
  }
}

/** Has this number written to us in the last 24 hours? Free text is only legal if so. */
export async function hasOpenWindow(to: string): Promise<boolean> {
  const n = waNumber(to);
  if (!n) return false;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const last = await prisma.whatsAppMessage.findFirst({
    where: { waId: n, direction: "in", at: { gte: since } },
    select: { id: true },
  });
  return !!last;
}

/**
 * WHO IS THIS NUMBER? — the question the whole feature's safety rests on.
 *
 * Three answers, and the middle one is the dangerous one:
 *   · exactly one live contact  → that client, and only that client's data
 *   · more than one             → AMBIGUOUS. Answer nothing; ask which company they mean.
 *   · none                      → unknown. Reveal nothing, not even whether they are a client.
 *
 * Archived contacts are excluded deliberately: a coordinator who has left keeps their handset, and
 * their access must end when their record does rather than when somebody remembers.
 */
export type WaIdentity =
  | { kind: "client"; companyId: string; companyName: string; contactId: string; contactName: string }
  | { kind: "ambiguous"; companies: { id: string; name: string }[] }
  | { kind: "unknown" };

export async function identify(from: string): Promise<WaIdentity> {
  const n = waNumber(from);
  if (!n) return { kind: "unknown" };
  // Compared on DIGITS, not on the stored string: the same phone is written "+91 98478 66202",
  // "0091-9847866202" and "9847866202" across three screens, and an exact match finds none of them.
  const rows = await prisma.contact.findMany({
    where: { archived: false, whatsapp: { not: null } },
    select: { id: true, name: true, whatsapp: true, companyId: true, company: { select: { name: true } } },
  });
  const hits = rows.filter(r => waNumber(r.whatsapp) === n);
  if (!hits.length) return { kind: "unknown" };
  const byCompany = new Map(hits.map(h => [h.companyId, h.company?.name ?? "—"]));
  if (byCompany.size > 1) {
    return { kind: "ambiguous", companies: [...byCompany].map(([id, name]) => ({ id, name })) };
  }
  const h = hits[0];
  return {
    kind: "client", companyId: h.companyId, companyName: h.company?.name ?? "—",
    contactId: h.id, contactName: h.name,
  };
}

/**
 * Message a client: their own words when a window is open, the approved template when it is not.
 *
 * Callers say what they MEAN once. Which of the two Meta will accept is this module's problem, and
 * keeping that decision in one place is what stops half the app learning the rule and the other
 * half getting it wrong.
 */
export async function notifyClient(a: {
  to: string; text: string; template: { name: string; language?: string; params?: string[] };
  kind?: string; companyId?: string | null; contactId?: string | null;
}): Promise<WaSendResult & { via: "text" | "template" }> {
  if (await hasOpenWindow(a.to)) {
    return { ...(await sendText({ to: a.to, body: a.text, kind: a.kind, companyId: a.companyId, contactId: a.contactId })), via: "text" };
  }
  return {
    ...(await sendTemplate({
      to: a.to, name: a.template.name, language: a.template.language, params: a.template.params,
      preview: a.text, kind: a.kind, companyId: a.companyId, contactId: a.contactId,
    })),
    via: "template",
  };
}
