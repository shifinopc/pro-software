/**
 * The public front door: a website enquiry form becomes a lead.
 *
 * THE THREAT MODEL, STATED
 *
 * This endpoint is unauthenticated in the sense that matters: the key that identifies the site has
 * to live wherever the form lives, and any key pasted into browser JavaScript is public whatever the
 * documentation says. So it is designed on the assumption that the key WILL leak, and a leaked key
 * must be a spam problem rather than a breach.
 *
 * That is what shapes every decision below:
 *   - it can create exactly two kinds of row: a company with lifecycle `lead`, and a contact
 *   - it never touches an existing company, never makes a client, never provisions a login
 *   - every field it reads is named here, so a payload carrying `lifecycle`, `ownerId` or `cr`
 *     cannot set them — there is no spread of the request body anywhere in this file
 *   - lengths are capped, so a key-holder cannot fill the database with one request
 *   - a honeypot field catches the bots that fill everything they find
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No CORS is enabled for it. Posting from a browser means shipping the key to the browser, and the
 * absence of CORS is what pushes an integrator towards the server-to-server call that keeps the key
 * private. It is a nudge rather than a wall — but the nudge points the right way.
 */
import crypto from "node:crypto";
import { recordLifecycle } from "./lifecycle.js";
import { prisma } from "./db.js";
import { findDuplicates } from "./duplicates.js";
import { addContact } from "./contacts.js";
import { nextOwner, nextOwnerFor, recordAssignment } from "./assignment.js";
import { salesRules } from "./salesrules.js";
import { notifyWebEnquiry } from "./notify.js";

/**
 * Caps, in characters. Generous for a real enquiry, useless for filling a database.
 *
 * `VARCHAR` is the real ceiling here, not taste: a plain `String` column in this schema is
 * VARCHAR(191) under MySQL, so anything longer does not get truncated — it throws, and the enquiry
 * is lost with a 500. The first version of this file capped the company name at 200 and the source
 * detail at 500, which meant a legitimately long company name broke the endpoint rather than being
 * shortened. Every cap below is at or under what its column can actually hold.
 */
const COLUMN = 191;
const LIMITS = {
  company: COLUMN, name: 120, email: COLUMN, phone: 40,
  // Goes into Interaction.summary, which is @db.Text — this one is about sanity, not the schema.
  message: 4000,
  source: 60,
  // `page` is only ever concatenated INTO sourceDetail, which is a VARCHAR — so it and the message
  // fragment beside it have to fit inside one column between them.
  page: 120,
  sourceDetail: COLUMN,
};

const clip = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/**
 * Tell somebody, and never let that be the reason an enquiry is lost.
 *
 * The lead is the valuable thing. A notification that fails — because a title overran its column, or
 * for any other reason — must not take the enquiry down with it, and the first version of this file
 * did exactly that: the company was written, the notification threw, the caller got a 500, and the
 * website showed the visitor an error for a lead that had in fact been captured.
 *
 * The title is clipped because it is a VARCHAR; the message is @db.Text and only clipped for sanity.
 */
async function tell(title: string, message: string) {
  try {
    await prisma.notification.create({
      data: {
        type: "system", time: "Just now", createdAt: new Date().toISOString(), read: false,
        title: clip(title, COLUMN), message: clip(message, 2000),
      },
    });
  } catch (e) {
    console.error("[intake] could not notify:", (e as any)?.message ?? e);
  }
}

export type IntakeOutcome =
  | { ok: true; result: "created"; companyId: string; name: string }
  | { ok: true; result: "joined"; companyId: string; name: string }
  | { ok: true; result: "ignored" }              // honeypot: looks successful, writes nothing
  | { ok: false; status: number; error: string };

/** The site behind a key, or null. Never says which of "unknown" or "revoked" it was. */
export async function siteForKey(rawKey: string | undefined) {
  const raw = String(rawKey ?? "").trim();
  if (!raw) return null;
  const keyHash = crypto.createHash("sha256").update(raw).digest("hex");
  const key = await prisma.apiKey.findFirst({ where: { keyHash, revoked: false } });
  if (!key) return null;
  // Best effort — a failed timestamp write must not lose somebody's enquiry.
  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date().toISOString() } }).catch(() => {});
  return key;
}

export async function receiveEnquiry(body: any, ctx: { keyName: string; homeCountry: string }): Promise<IntakeOutcome> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Send a form submission as a JSON object" };
  }

  // The honeypot. A field no human sees and no human fills; bots fill everything. Answering with a
  // success is deliberate — telling a bot it was detected only teaches it to try something else.
  if (clip(body.website_url ?? body.honeypot, 200)) return { ok: true, result: "ignored" };

  const company = clip(body.company, LIMITS.company);
  const person = clip(body.name, LIMITS.name);
  const email = clip(body.email, LIMITS.email).toLowerCase();
  const phone = clip(body.phone, LIMITS.phone);
  const message = clip(body.message, LIMITS.message);
  const source = clip(body.source, LIMITS.source) || "website";
  const page = clip(body.page, LIMITS.page);

  // Enough to be worth a record and to be worth calling back. A name with no way to reach them is
  // not a lead, it is a row.
  if (!company && !person) return { ok: false, status: 400, error: "A company or a contact name is required" };
  if (!email && !phone) return { ok: false, status: 400, error: "An email address or a phone number is required" };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, status: 400, error: "That email address is not valid" };

  const label = company || person;

  // ── already known? ─────────────────────────────────────────────────────────────────────────
  // Only an exact email or phone match counts here. The looser name rules are right for warning a
  // person who is typing; acting on them unattended would attach a stranger's enquiry to somebody
  // else's file.
  const matches = await findDuplicates({ name: company, email, phone });
  const exact = matches.find(m => m.confidence === "certain" || (m.confidence === "likely" && m.why.startsWith("Same phone")));

  if (exact) {
    const existing = await prisma.company.findUnique({ where: { id: exact.id } });
    // A CLIENT is never touched by a public endpoint. Their enquiry is real and somebody should see
    // it, so staff are told — but nothing about their record changes on the strength of a web form.
    if (!existing || existing.lifecycle !== "lead" && existing.lifecycle !== "prospect") {
      await tell(
        `Enquiry from an existing record: ${exact.name}`,
        `${ctx.keyName} · ${exact.why}. ${message ? "They said: " + message.slice(0, 300) : "No message."} Nothing was changed on their record.`,
      );
      return { ok: true, result: "joined", companyId: exact.id, name: exact.name };
    }

    // A lead enquiring again: the message joins the file it belongs to rather than starting a second.
    await prisma.interaction.create({
      data: {
        companyId: existing.id, kind: "note", at: new Date().toISOString(),
        summary: `Enquiry from ${source}${page ? ` (${page})` : ""}${message ? ` — ${message}` : ""}`.slice(0, 2000),
        ownerId: existing.ownerId ?? null,
        createdAt: new Date().toISOString(),
      },
    });
    await tell(
      `Repeat enquiry: ${existing.name}`,
      `${ctx.keyName} · ${exact.why}. Added to their file rather than creating a second lead.`,
    );
    notifyWebEnquiry({
      ownerId: existing.ownerId, companyId: existing.id, name: existing.name, source,
      message, email: email || null, phone: phone || null, repeat: true,
    });
    return { ok: true, result: "joined", companyId: existing.id, name: existing.name };
  }

  // ── a new lead ─────────────────────────────────────────────────────────────────────────────
  // Every column is written explicitly. There is no spread of `body` here, and that is the point:
  // a payload carrying lifecycle, ownerId, cr or status cannot reach the database through this.
  const rules = await salesRules();
  // A web enquiry carries the strongest routing signal there is — the form it came from — so this
  // is the call site where a "leads from the website go to Fahad" rule earns its keep.
  const routed = rules.autoAssignOwner
    ? await nextOwnerFor({ source, city: null, country: ctx.homeCountry, service: null })
    : null;
  const owner = routed?.owner ?? null;

  const created = await prisma.company.create({
    data: {
      name: label,
      lifecycle: "lead",
      country: ctx.homeCountry,
      source,
      // Clipped to the column, not to a number that felt about right. The message survives in full
      // on the interaction below; this is only the summary line on the record itself.
      sourceDetail: clip([page, message].filter(Boolean).join(" — "), LIMITS.sourceDetail) || null,
      ownerId: owner?.id ?? null,
      createdAt: new Date().toISOString(),
    },
  });
  // System arrival — no person changed anything; the website did.
  await recordLifecycle(prisma, { companyId: created.id, to: "lead", at: new Date().toISOString() });
  // And why it landed where it did. A rep who finds a website lead on their desk can now see the
  // rule that put it there rather than assuming a colleague passed it on.
  if (owner) {
    await recordAssignment(prisma, {
      companyId: created.id, from: null, to: owner.id,
      method: "intake", reason: routed?.why ?? null,
    });
  }

  if (person || email || phone) {
    await addContact(created.id, { name: person || label, email: email || null, phone: phone || null });
  }
  if (message) {
    await prisma.interaction.create({
      data: {
        companyId: created.id, kind: "note", at: new Date().toISOString(),
        summary: `Enquiry from ${source}${page ? ` (${page})` : ""} — ${message}`.slice(0, 2000),
        ownerId: owner?.id ?? null,
        createdAt: new Date().toISOString(),
      },
    });
  }
  await tell(
    `New enquiry: ${label}`,
    `${ctx.keyName} · ${source}${owner ? ` · assigned to ${owner.name}` : " · nobody owns it yet"}. ${message ? message.slice(0, 300) : "No message."}`,
  );
  // An enquiry that lands at 11pm used to sit in the bell until somebody happened to open the
  // console. It now reaches the auto-assigned owner — or, when intake assigned nobody, the admins.
  // Fire-and-forget: a mail problem must not fail a lead that has already been captured.
  notifyWebEnquiry({
    ownerId: owner?.id ?? null, companyId: created.id, name: label, source,
    message, email: email || null, phone: phone || null,
  });

  return { ok: true, result: "created", companyId: created.id, name: created.name };
}
