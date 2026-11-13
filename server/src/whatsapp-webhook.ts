/**
 * WHAT A CLIENT SENDS US ON WHATSAPP, ARRIVING IN THE APP.
 *
 * Meta posts every event here: messages people send, and delivery receipts for messages we sent.
 * Two routes, because Meta needs both:
 *   GET  — the one-time handshake when you paste the URL into the dashboard
 *   POST — everything after that
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 * 1. PROVE IT CAME FROM META. This URL is public — it has to be, Meta calls it from the open
 *    internet — so without a signature check anybody who finds it could post "message from your
 *    client" and have the app believe it, log it against a real company, and later answer
 *    questions on the strength of it. Every POST is verified against the app secret with the
 *    header Meta signs it with, and an unsigned or wrongly signed one is refused flat.
 *
 * 2. ANSWER 200 QUICKLY, WHATEVER HAPPENS. Meta retries anything that is slow or errors, with
 *    the same payload, for days. A bug in our handling would turn into the same client message
 *    recorded fifty times. So the body is acknowledged first and the work is done after; a failure
 *    is logged for us, never reported to Meta.
 *
 * Deliberately NOT here: answering the client. This records and routes. What gets said back is a
 * decision for people and, later, a bot that a person switched on.
 */
import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import { prisma } from "./db.js";
import { identify, waNumber } from "./whatsapp.js";
import { logInteraction } from "./interactions.js";
import { logActivity } from "./auth.js";

const nowISO = () => new Date().toISOString();

/** Meta signs the raw bytes, so the raw bytes are what we have to hash — not the re-serialised object. */
export function signatureOk(raw: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!secret) return false;              // no secret configured = nothing can be trusted, so nothing is
  if (!raw || !header) return false;
  const sent = String(header).startsWith("sha256=") ? String(header).slice(7) : String(header);
  const mine = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  // Same-length compare, constant time: a plain === leaks how much of the signature was right.
  const a = Buffer.from(sent, "utf8"), b = Buffer.from(mine, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** A readable one-line summary of a message, whatever kind it is. */
function describe(m: any): string {
  switch (m?.type) {
    case "text": return String(m.text?.body ?? "");
    case "image": return `[photo]${m.image?.caption ? " " + m.image.caption : ""}`;
    case "document": return `[document${m.document?.filename ? " " + m.document.filename : ""}]`;
    case "audio": return "[voice note]";
    case "video": return `[video]${m.video?.caption ? " " + m.video.caption : ""}`;
    case "location": return "[location]";
    case "button": return String(m.button?.text ?? "[button]");
    case "interactive":
      return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[reply]");
    default: return `[${m?.type ?? "unknown"}]`;
  }
}

/** One inbound message: recorded, attributed if we can, and put in front of somebody. */
async function handleMessage(m: any) {
  const from = waNumber(m?.from);
  if (!from) return;
  const body = describe(m);
  const who = await identify(from);
  const companyId = who.kind === "client" ? who.companyId : null;
  const contactId = who.kind === "client" ? who.contactId : null;

  /**
   * SEEN THIS ONE ALREADY?
   *
   * Meta retries anything it did not get a prompt 200 for — the same payload, for up to several
   * days. A deploy during a quiet second, a database hiccup, a slow query: any of them and the
   * client's one message becomes five on their record, five notifications to the team, and five
   * answers if a bot is ever reading this table. Meta's own message id is stable across every
   * retry, so it is the thing to check.
   *
   * Not a unique index, deliberately: a constraint would make the SECOND delivery an error, and an
   * error here is what starts the retrying again.
   */
  if (m?.id) {
    const seen = await prisma.whatsAppMessage.findFirst({ where: { messageId: String(m.id), direction: "in" }, select: { id: true } });
    if (seen) return;
  }

  // Recorded FIRST, and unconditionally. Even a message from a number we cannot place is evidence
  // — somebody wrote to the firm — and the window it opens is real whether we know the sender or
  // not. Losing it because the lookup failed would be the worst of both.
  await prisma.whatsAppMessage.create({
    data: {
      direction: "in", waId: from, body: body.slice(0, 4000), kind: m?.type ?? "text",
      status: "received", messageId: m?.id ?? null, companyId, contactId, at: nowISO(),
    },
  });

  if (who.kind === "client") {
    // On the client's own record, beside their calls and emails, because that is where somebody
    // looks when they ask "what have we heard from them".
    await logInteraction({
      companyId: who.companyId, contactId: who.contactId, kind: "whatsapp", at: nowISO(),
      summary: body.slice(0, 500),
    }).catch(e => console.error("[whatsapp] could not log interaction:", e?.message ?? e));
    logActivity({ type: "task", message: `WhatsApp from ${who.contactName} (${who.companyName}): ${body.slice(0, 120)}` });
    return;
  }

  // Unknown or ambiguous: it reaches the team, and NOTHING is said back automatically. Confirming
  // "yes, that company is our client" to whoever holds a phone is itself a disclosure.
  logActivity({
    type: "task",
    message: who.kind === "ambiguous"
      ? `WhatsApp from ${from} — that number is on ${who.companies.map(c => c.name).join(" and ")}, so nobody can tell which: ${body.slice(0, 120)}`
      : `WhatsApp from an unrecognised number ${from}: ${body.slice(0, 120)}`,
  });
}

/** A delivery receipt for something we sent: matched back by Meta's message id. */
async function handleStatus(s: any) {
  const id = s?.id;
  if (!id) return;
  const status = String(s?.status ?? "").toLowerCase();   // sent | delivered | read | failed
  if (!status) return;
  const err = s?.errors?.[0];
  await prisma.whatsAppMessage.updateMany({
    where: { messageId: id, direction: "out" },
    data: {
      status,
      ...(err ? { error: `${err.title ?? ""}${err.code ? ` (code ${err.code})` : ""}`.trim() } : {}),
    },
  });
}

/** Everything in one payload. Meta batches, so never assume one event per call. */
export async function processPayload(payload: any) {
  for (const entry of (payload?.entry ?? [])) {
    for (const change of (entry?.changes ?? [])) {
      const v = change?.value ?? {};
      for (const m of (v.messages ?? [])) await handleMessage(m).catch(e => console.error("[whatsapp] message:", e?.message ?? e));
      for (const s of (v.statuses ?? [])) await handleStatus(s).catch(e => console.error("[whatsapp] status:", e?.message ?? e));
    }
  }
}

export function mountWhatsAppWebhook(app: Express) {
  /**
   * The handshake. Meta calls this once, when you save the URL in the dashboard, and will not
   * accept the endpoint until it echoes the challenge back.
   */
  app.get("/api/whatsapp/webhook", (req: Request, res: Response) => {
    const verify = process.env.WHATSAPP_VERIFY_TOKEN || "";
    const mode = String(req.query["hub.mode"] ?? "");
    const token = String(req.query["hub.verify_token"] ?? "");
    const challenge = String(req.query["hub.challenge"] ?? "");
    if (!verify) {
      console.error("[whatsapp] handshake refused: WHATSAPP_VERIFY_TOKEN is not set");
      return res.sendStatus(500);
    }
    if (mode === "subscribe" && token === verify) return res.type("text/plain").send(challenge);
    console.error("[whatsapp] handshake refused: the verify token did not match");
    return res.sendStatus(403);
  });

  app.post("/api/whatsapp/webhook", async (req: Request, res: Response) => {
    const secret = process.env.WHATSAPP_APP_SECRET || "";
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!signatureOk(raw, req.header("x-hub-signature-256"), secret)) {
      // 403 and nothing else. Saying WHY it was refused tells whoever is probing which half to fix.
      console.error("[whatsapp] refused a POST with a bad or missing signature");
      return res.sendStatus(403);
    }
    // Acknowledged before any work: see the note at the top about retries.
    res.sendStatus(200);
    processPayload(req.body).catch(e => console.error("[whatsapp] payload:", e?.message ?? e));
  });
}
