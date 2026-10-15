/**
 * A REP'S MAILBOX, READ NARROWLY AND ON PURPOSE.
 *
 * WHAT THIS IS FOR. A client replies; the reply lands on their record without anybody copying it
 * there. A rep writes from their own address, so the answer comes back to them rather than to a
 * shared no-reply nobody watches. And "time to first reply" becomes measurable, which predicts a
 * won deal better than volume does.
 *
 * THE FILTER IS THE FEATURE. Only messages whose counterparty is already a Contact or Company in
 * this system are stored. A rep's payslip, their doctor, their job hunt: not matched, so not
 * written — not "written and then hidden". That distinction is the whole ethical basis for reading
 * somebody's mailbox at all, and it lives HERE, before the row exists, rather than as a filter on
 * a query somebody can later loosen.
 *
 * NO BODIES. Subject, participants and timing answer "did they reply, and when", which is the
 * question this exists for. Storing bodies would make this a mail archive with a different threat
 * model and a different conversation with staff.
 *
 * WHY THE PROVIDER IS A THIN SEAM. Gmail and Microsoft Graph disagree about almost everything —
 * auth, pagination, the shape of a message, what a "thread" is called — and about nothing that
 * matters here. Both can answer "messages since this cursor, as {id, threadId, from, to, subject,
 * at}". Everything below that line is shared, tested, and provider-blind; everything above it is
 * two small adapters. That is deliberate: it is also the only part that cannot be verified without
 * live credentials, so it is the part kept smallest.
 */
import { prisma } from "./db.js";
import { encrypt, decrypt } from "./auth.js";
import crypto from "node:crypto";

/** The separator in a logged mail summary. */
const EMDASH = "—";

/** One message, as any provider can describe it. The whole contract between adapters and this file. */
export interface RawMessage {
  externalId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string | null;
  /** ISO. */
  sentAt: string;
}

export interface FetchResult {
  messages: RawMessage[];
  /** Opaque, provider-specific. Stored verbatim and handed back next time. */
  cursor: string | null;
}

/** What every adapter must do, and nothing more. */
export interface MailboxProvider {
  readonly name: "google" | "microsoft";
  /** Exchange a refresh token for a live access token. */
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>;
  /** Messages since `cursor` (or a recent window when null). */
  fetchSince(accessToken: string, cursor: string | null): Promise<FetchResult>;
  /**
   * The last `days` of mail, newest first, ignoring any cursor.
   *
   * A SYNC and a SCAN want different things and the difference is not cosmetic. A sync asks
   * "what is new since I last looked" and must never re-read; a scan asks "who has been in
   * touch lately" and must not disturb the cursor, or pressing the button would make the next
   * sync skip everything the scan happened to see.
   */
  fetchRecent(accessToken: string, days: number): Promise<RawMessage[]>;
}

const norm = (a: unknown) => String(a ?? "").trim().toLowerCase();

/**
 * Pull a bare address out of whatever the header actually said.
 * `"Fahad Al-Otaibi" <fahad@alnoor.sa>` and `fahad@alnoor.sa` are the same person, and a matcher
 * that only understands the second form silently files half the mail under nobody.
 */
export function addressOf(raw: unknown): string {
  const s = String(raw ?? "").trim();
  const m = /<([^>]+)>/.exec(s);
  return norm(m ? m[1] : s);
}

export interface MatchIndex {
  byContact: Map<string, { contactId: string; companyId: string }>;
  byCompany: Map<string, string>;
}

/**
 * Everybody this system already knows, by address.
 *
 * Built once per sync rather than queried per message — a hundred messages should not be a hundred
 * round trips, and the index is small enough to hold.
 */
export async function buildMatchIndex(): Promise<MatchIndex> {
  const [contacts, companies] = await Promise.all([
    prisma.contact.findMany({ where: { email: { not: null } }, select: { id: true, email: true, companyId: true } }),
    prisma.company.findMany({ where: { email: { not: null } }, select: { id: true, email: true } }),
  ]);
  const byContact = new Map<string, { contactId: string; companyId: string }>();
  for (const c of contacts) {
    const a = addressOf(c.email);
    if (a && !byContact.has(a)) byContact.set(a, { contactId: c.id, companyId: c.companyId });
  }
  const byCompany = new Map<string, string>();
  for (const c of companies) {
    const a = addressOf(c.email);
    if (a && !byCompany.has(a)) byCompany.set(a, c.id);
  }
  return { byContact, byCompany };
}

export interface Matched {
  direction: "in" | "out";
  counterparty: string;
  companyId: string;
  contactId: string | null;
}

/**
 * Who is this message about — or nobody, in which case it is dropped.
 *
 * The counterparty is whoever is NOT the mailbox owner. Working that out from direction rather than
 * from position matters: on an outbound message the client is in `to`, on an inbound one they are
 * in `from`, and a matcher that always reads `from` attributes every sent message to the rep.
 *
 * A message with several known recipients matches the FIRST known one. Attributing one email to
 * three companies would triple every count derived from it.
 */
export function matchMessage(msg: RawMessage, mine: string, index: MatchIndex): Matched | null {
  const me = norm(mine);
  const from = addressOf(msg.from);
  const tos = msg.to.map(addressOf).filter(Boolean);
  const direction: "in" | "out" = from === me ? "out" : "in";

  const candidates = direction === "out" ? tos : [from];
  for (const addr of candidates) {
    if (!addr || addr === me) continue;
    const c = index.byContact.get(addr);
    if (c) return { direction, counterparty: addr, companyId: c.companyId, contactId: c.contactId };
    const companyId = index.byCompany.get(addr);
    if (companyId) return { direction, counterparty: addr, companyId, contactId: null };
  }
  // Nobody we know. Not stored — see the note at the top of this file.
  return null;
}

/**
 * Store what matched, and put it on the client's timeline.
 *
 * Idempotent on (userId, externalId): a sync that overlaps the previous one, or a cursor that
 * rewinds after an error, must not double-count a conversation. `skipDuplicates` makes a retry
 * cheap rather than dangerous.
 */
export async function ingest(userId: string, mine: string, messages: RawMessage[], index: MatchIndex): Promise<{ stored: number; skipped: number }> {
  let stored = 0, skipped = 0;
  const now = new Date().toISOString();

  for (const m of messages) {
    const hit = matchMessage(m, mine, index);
    if (!hit) { skipped++; continue; }
    try {
      await prisma.emailMessage.create({
        data: {
          userId, externalId: m.externalId, threadId: m.threadId,
          companyId: hit.companyId, contactId: hit.contactId,
          direction: hit.direction, subject: m.subject ?? null,
          counterparty: hit.counterparty, sentAt: m.sentAt, createdAt: now,
        },
      });
      stored++;

      /**
       * AND ON THE CLIENT'S OWN RECORD.
       *
       * The header above this file has always said a reply lands on the client's record without
       * anybody copying it there. It did not: the row above was the only thing written, and the
       * only reader of that table is the Inbox. So the feature answered "what is waiting on a
       * reply across my book" and not "what has this client said to us", which is the question
       * somebody opening a client record is asking.
       *
       * It also made "this lead has gone quiet" a lie: `lastContactAt` is the newest Interaction,
       * so a client could email every week and still be chased as silent.
       *
       * AFTER the message row, inside the same try, so the unique (userId, externalId) collision
       * above skips this too — a re-sync over the same window cannot log the mail twice.
       *
       * `auto: true` because a person did not write it: the timeline marks those, and a log full
       * of automatic notes read as effort would flatter everybody.
       *
       * The summary carries the subject and the address, both already stored on the row above.
       * No body is read here and none could be — the fetch asks for metadata only.
       *
       * Its own catch: a timeline write that fails must not un-store a message that is already
       * in, nor count it as skipped, or the next sync would try the whole window again.
       */
      try {
        await prisma.interaction.create({
          data: {
            companyId: hit.companyId,
            contactId: hit.contactId,
            kind: "email",
            at: m.sentAt,
            summary: `${hit.direction === "in" ? "Received from" : "Sent to"} ${hit.counterparty}`
                     + (m.subject ? ` ${EMDASH} ${m.subject}` : ""),
            outcome: hit.direction === "in" ? "received" : "sent",
            auto: true,
            createdAt: now,
          },
        });
      } catch (e: any) {
        console.error(`[mailbox] stored ${m.externalId} but could not log it on the timeline: ${e?.message ?? e}`);
      }
    } catch {
      // Unique (userId, externalId) — already have it. Counted as skipped, not as a failure.
      skipped++;
      continue;
    }
  }
  return { stored, skipped };
}

/**
 * LEAD SUGGESTIONS, COMPUTED AND THROWN AWAY.
 *
 * `ingest` keeps only what matches a client and discards the rest, which is what makes reading a
 * rep's mailbox defensible at all. But a lead who has never written before is BY DEFINITION in the
 * part that gets discarded — so finding one means looking at mail from people the CRM does not know.
 *
 * The compromise that keeps the promise: this is a SCAN, not a sync. Nothing it reads is written.
 * The scores below are computed in memory and returned in the response; close the screen and they
 * are gone. The only thing that outlives the call is a DISMISSAL, and only as a keyed digest.
 *
 * It is on demand rather than hourly for the same reason. A background pass over everyone a rep has
 * ever mailed, running quietly whether or not anybody wants it, is a different product from a
 * button somebody presses when they are looking for new business.
 */

/**
 * Addresses that send to everybody and converse with nobody.
 *
 * Two patterns, because they are two different things. A ROLE account is the whole local part
 * (`info@`, `billing@`); a no-reply marker can be buried anywhere in it, and the first version of
 * this anchored it to the front — which let `google-noreply@google.com` through as a medium-
 * confidence lead on the very first real scan.
 */
const ROLE_ACCOUNT = /^(noreply|bounce|mailer|postmaster|notifications?|alerts?|news|newsletter|updates?|team|hello|contact|careers|jobs|hr|accounts?|billing|invoices?|receipts?|statements?|security|verify|unsubscribe|marketing|promo(tions)?|offers?|deals?|insider|member(ship)?s?|digest|feedback|survey|webmaster|abuse|help(desk)?)@/i;
const NO_REPLY_ANYWHERE = /^[^@]*(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|mailer[-_.]?daemon|bounce[sd]?|auto[-_.]?(reply|mail)|notification|no[-_.]?answer)[^@]*@/i;
/** A mail provider, not a company domain: still a lead, just a weaker signal. */
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|yandex|mail|zoho|rediffmail)\./i;
/**
 * A subject that announces a machine wrote it.
 *
 * Grown from what the first scans actually turned up rather than imagined in advance: the terms-of-
 * service notice and the long-weekend sale are both here because both were offered as leads once.
 */
const ROBOT_SUBJECT = /(security alert|verification|verify your|one[- ]time|\botp\b|password|was recovered|sign[- ]?in|signed in|unsubscribe|newsletter|receipt for|invoice #|statement|do not reply|automated|no[- ]reply|delivery status|undeliverable|out of office|auto[- ]?reply|your order|has shipped|subscription|terms of service|terms of use|privacy polic|policy update|\bterms\b.*(updat|chang)|(updat|chang).*\bterms\b)/i;
/**
 * A subject that is selling to us, which is the exact opposite of a lead.
 *
 * Kept apart from ROBOT_SUBJECT because a human really does send these, so "a person wrote it" is
 * no defence — and because a sales blast is the single most common thing in any real inbox.
 */
const BULK_SUBJECT = /(\bsale\b|\boffers?\b|\bdeals?\b|% off|\d+% |discount|coupon|promo|festive|flash sale|limited time|last chance|book now|save up to|free trial|webinar|register now|don't miss|dont miss|exclusive|black friday|cyber monday|cashback|lowest price|best price|hurry)/i;
/** A subject that sounds like somebody asking for work. */
const ENQUIRY_SUBJECT = /(enquir|inquir|quot(e|ation)|proposal|pricing|price list|your price|interested in|requirement|\brfp\b|\brfq\b|tender|visa|iqama|licen[cs]e|renewal|registration|company formation|establishment|pro service|saudization|nitaqat|need help|looking for|looking to|partnership|can you help|request for (quot|propos|inform|price))/i;

export interface LeadSuggestion {
  address: string;
  name: string | null;
  domain: string;
  subject: string | null;
  lastAt: string;
  messages: number;
  /** True when this rep wrote back in the thread — the strongest signal there is. */
  replied: boolean;
  score: number;
  band: "high" | "medium" | "low";
  /** Why it scored what it did, in the words a person would use. Shown on the card. */
  reasons: string[];
}

/**
 * Score one unknown correspondent.
 *
 * Deliberately a handful of readable rules rather than a model: a suggestion a salesperson cannot
 * argue with is one they stop trusting, so every point this awards is explainable on the card.
 *
 * `null` means DISQUALIFIED, not "scored low". A newsletter offered at 12% still costs somebody a
 * glance, and a list that needs skimming is a list that gets ignored.
 */
export function scoreLead(a: {
  address: string; name: string | null; subjects: string[]; messages: number; replied: boolean;
}): { score: number; reasons: string[] } | null {
  const addr = a.address.toLowerCase();
  if (!addr.includes("@")) return null;
  if (ROLE_ACCOUNT.test(addr) || NO_REPLY_ANYWHERE.test(addr)) return null;

  const subjectText = a.subjects.join(" ");
  // A machine-looking subject only disqualifies if the rep never answered it. If they did, their
  // judgement beats this regex — people really do reply to "Your invoice" from a genuine new client.
  if ((ROBOT_SUBJECT.test(subjectText) || BULK_SUBJECT.test(subjectText)) && !a.replied) return null;

  // ONE MESSAGE, NEVER ANSWERED, NOTHING IN THE SUBJECT: that is not a lead, that is post.
  //
  // This single rule removed more false positives than every regex above put together. A stranger
  // who wrote once, got no reply, and said nothing that reads like an enquiry is overwhelmingly a
  // mailing list that slipped the other tests — and a list with two plausible rows is read, where
  // a list with twenty is dismissed. Deliberately conservative: the cost of missing a lead is that
  // the rep finds it in their inbox the way they do today, and the cost of crying wolf is the
  // whole feature.
  if (!a.replied && a.messages < 2 && !ENQUIRY_SUBJECT.test(subjectText)) return null;

  let score = 35;
  const reasons: string[] = [];

  // THE STRONGEST SIGNAL BY FAR: a rep who wrote back has already decided this person is worth
  // their time. The system is only noticing what they did.
  if (a.replied) { score += 30; reasons.push("you replied to them"); }
  if (a.messages > 1) { score += 10; reasons.push(a.messages + " emails from them"); }
  if (a.messages > 3) { score += 5; }

  if (!FREE_MAIL.test(addr)) { score += 15; reasons.push("writes from a company domain"); }
  else { reasons.push("personal email address"); }

  if (a.name && /\s/.test(a.name.trim()) && a.name.trim().length < 48) {
    score += 10; reasons.push("a person's name, not a brand");
  }
  if (ENQUIRY_SUBJECT.test(subjectText)) { score += 15; reasons.push("the subject reads like an enquiry"); }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * Everyone in the window who is NOT already a client, scored.
 *
 * Takes messages the caller already fetched so a scan and a sync can share one pull, and the same
 * match index a sync uses — somebody the CRM already knows is not a suggestion, just mail.
 */
export function suggestLeads(
  messages: RawMessage[], mine: string, index: MatchIndex, dismissed: Set<string>,
  digestOf: (addr: string) => string,
): LeadSuggestion[] {
  const me = norm(mine);

  // Domains we already do business with, so a new face at an existing client is not offered as a
  // new lead. Free-mail domains are excluded from this test on purpose: one contact on gmail would
  // otherwise silence every gmail sender for the whole firm.
  const knownDomains = new Set<string>();
  for (const a of [...index.byContact.keys(), ...index.byCompany.keys()]) {
    const d = a.split("@")[1];
    if (d && !FREE_MAIL.test("@" + d + ".")) knownDomains.add(d);
  }

  // Threads this rep has written in — read once, so `replied` costs nothing per message.
  const repliedThreads = new Set(
    messages.filter((m) => addressOf(m.from) === me).map((m) => m.threadId),
  );

  const byAddr = new Map<string, {
    name: string | null; subjects: string[]; lastAt: string; messages: number; replied: boolean;
  }>();

  for (const m of messages) {
    const from = addressOf(m.from);
    if (!from || from === me) continue;                 // our own mail is not a lead
    if (index.byContact.has(from)) continue;            // already a contact
    if (index.byCompany.has(from)) continue;            // already a company
    const domain = from.split("@")[1] ?? "";
    if (knownDomains.has(domain)) continue;             // a colleague at a client, not a lead
    if (dismissed.has(digestOf(from))) continue;        // somebody already said no

    // `"Fahad Al-Otaibi" <fahad@alnoor.sa>` — the display name, when the header carried one.
    const nameMatch = /^\s*"?([^"<]+?)"?\s*</.exec(String(m.from ?? ""));
    const name = nameMatch ? nameMatch[1].trim() || null : null;

    const prev = byAddr.get(from);
    if (!prev) {
      byAddr.set(from, {
        name, subjects: m.subject ? [m.subject] : [], lastAt: m.sentAt, messages: 1,
        replied: repliedThreads.has(m.threadId),
      });
    } else {
      // One person who wrote four times is one suggestion, not four.
      prev.messages += 1;
      if (m.subject) prev.subjects.push(m.subject);
      if (m.sentAt > prev.lastAt) prev.lastAt = m.sentAt;
      if (!prev.name && name) prev.name = name;
      if (repliedThreads.has(m.threadId)) prev.replied = true;
    }
  }

  const out: LeadSuggestion[] = [];
  for (const [addr, v] of byAddr) {
    const scored = scoreLead({
      address: addr, name: v.name, subjects: v.subjects, messages: v.messages, replied: v.replied,
    });
    if (!scored) continue;
    out.push({
      address: addr, name: v.name, domain: addr.split("@")[1] ?? "",
      subject: v.subjects[0] ?? null, lastAt: v.lastAt, messages: v.messages, replied: v.replied,
      score: scored.score, reasons: scored.reasons,
      // Recalibrated after the first real scans. The disqualifiers above are strict enough that
      // everything surviving them scored 75+, so three bands existed and only one was ever used —
      // which makes the pill decoration rather than information.
      band: scored.score >= 85 ? "high" : scored.score >= 65 ? "medium" : "low",
    });
  }
  // Worth answering first at the top.
  return out.sort((x, y) => y.score - x.score || y.lastAt.localeCompare(x.lastAt));
}

/**
 * A DISMISSAL, WITHOUT KEEPING THE ADDRESS.
 *
 * "Not a lead" has to be remembered or the same stranger is offered every week. But remembering it
 * as plain text would quietly build the very list this file exists to avoid: a table of people a
 * rep corresponds with who are not clients.
 *
 * So the digest is keyed. An email address is far too low-entropy for a plain hash — a dictionary
 * of likely addresses would undo it in seconds — so the server secret is what makes this one-way.
 * Rotating that secret forgets every dismissal, which is the harmless failure (suggestions come
 * back) rather than the harmful one.
 */
export function dismissalDigest(address: string): string {
  const key = process.env.CRED_KEY || process.env.JWT_SECRET || "dev-lead-dismissal-key";
  return crypto.createHmac("sha256", key).update(norm(address)).digest("hex");
}

/**
 * ONE MAILBOX, SCANNED FOR PEOPLE THE CRM DOES NOT KNOW.
 *
 * Reads nothing into the database and — deliberately — does not touch the sync cursor. Pressing
 * Scan must never make the next sync skip a client's reply it happened to walk past.
 *
 * A failure is returned, not recorded against the connection. A sync that fails means mail is
 * being missed and the person has to be told to reconnect; a scan that fails means a button did
 * not work. Marking the mailbox broken because somebody pressed Scan would raise a false alarm.
 */
export async function scanLeads(userId: string, provider: MailboxProvider, days = 30): Promise<{
  suggestions: LeadSuggestion[]; scanned: number; address?: string; error?: string;
}> {
  const conn = await prisma.mailboxConnection.findUnique({ where: { userId } });
  if (!conn || conn.status === "disconnected") {
    return { suggestions: [], scanned: 0, error: "No mailbox is connected." };
  }
  try {
    const token = await accessTokenFor(conn, provider);
    const messages = await provider.fetchRecent(token, days);
    const index = await buildMatchIndex();
    const dismissed = new Set(
      (await prisma.leadDismissal.findMany({ select: { digest: true } })).map((d) => d.digest),
    );
    const suggestions = suggestLeads(messages, conn.address, index, dismissed, dismissalDigest);
    // `scanned` is the honest denominator: "nothing found" and "nothing to look at" are different
    // answers and the screen says which one it is.
    return { suggestions, scanned: messages.length, address: conn.address };
  } catch (e: any) {
    return { suggestions: [], scanned: 0, error: String(e?.message ?? e).slice(0, 400) };
  }
}

/**
 * TIME TO FIRST REPLY, per thread, in hours.
 *
 * The single most useful number this feature produces: it predicts a won deal better than how many
 * emails somebody sent. Measured from OUR first outbound in a thread to THEIR first inbound after
 * it — a reply that arrived before we wrote is a different conversation, not a fast response.
 *
 * Returns null for a thread nobody has answered, and the caller keeps that as null. Treating an
 * unanswered thread as a slow reply would flatter nothing and mislead everybody: the median would
 * quietly improve every time somebody was ignored.
 */
export async function replyTimes(companyId?: string | null): Promise<{ threads: number; answered: number; medianHours: number | null }> {
  const msgs = await prisma.emailMessage.findMany({
    where: companyId ? { companyId } : {},
    select: { threadId: true, direction: true, sentAt: true },
    orderBy: { sentAt: "asc" },
  });
  const byThread = new Map<string, { out: string | null; replyH: number | null }>();
  for (const m of msgs) {
    const t = byThread.get(m.threadId) ?? { out: null, replyH: null };
    if (m.direction === "out" && !t.out) t.out = m.sentAt;
    else if (m.direction === "in" && t.out && t.replyH === null) {
      const h = (Date.parse(m.sentAt) - Date.parse(t.out)) / 3_600_000;
      if (Number.isFinite(h) && h >= 0) t.replyH = h;
    }
    byThread.set(m.threadId, t);
  }
  const ours = [...byThread.values()].filter(t => t.out);
  const answered = ours.map(t => t.replyH).filter((h): h is number => h !== null).sort((a, b) => a - b);
  const median = answered.length
    ? (answered.length % 2 ? answered[(answered.length - 1) / 2]
      : (answered[answered.length / 2 - 1] + answered[answered.length / 2]) / 2)
    : null;
  return {
    threads: ours.length,
    answered: answered.length,
    medianHours: median === null ? null : Math.round(median * 10) / 10,
  };
}

/** Store a freshly granted grant. Tokens are encrypted here so no caller has to remember to. */
export async function saveConnection(userId: string, provider: "google" | "microsoft", address: string, tokens: { accessToken: string; refreshToken?: string | null; expiresAt?: string | null }) {
  const now = new Date().toISOString();
  const data = {
    provider, address: norm(address),
    accessTokenEnc: encrypt(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt ?? null,
    status: "active", lastError: null, updatedAt: now,
  };
  return prisma.mailboxConnection.upsert({
    where: { userId },
    create: { userId, cursor: null, createdAt: now, ...data },
    update: data,
  });
}

/** The live access token, refreshed if it is about to expire. Never returned to any route. */
export async function accessTokenFor(conn: { id: string; accessTokenEnc: string; refreshTokenEnc: string | null; expiresAt: string | null }, provider: MailboxProvider): Promise<string> {
  // Refreshed AHEAD of expiry, not after a 401. A sync that only recovers from failure spends
  // every cycle failing first, and the failure is indistinguishable from a revoked grant.
  const soon = Date.now() + 120_000;
  const stillGood = conn.expiresAt && Date.parse(conn.expiresAt) > soon;
  if (stillGood) return decrypt(conn.accessTokenEnc);
  if (!conn.refreshTokenEnc) throw new Error("This mailbox needs reconnecting — there is no refresh token to renew it with.");

  const fresh = await provider.refresh(decrypt(conn.refreshTokenEnc));
  await prisma.mailboxConnection.update({
    where: { id: conn.id },
    data: { accessTokenEnc: encrypt(fresh.accessToken), expiresAt: fresh.expiresAt, updatedAt: new Date().toISOString() },
  });
  return fresh.accessToken;
}

/**
 * One mailbox, synced.
 *
 * Failure is RECORDED and the cursor is left alone. Advancing a cursor past messages that were
 * never read would lose them permanently and silently, which is worse than syncing them twice —
 * the ingest is idempotent precisely so that re-reading is the safe direction.
 */
export async function syncMailbox(userId: string, provider: MailboxProvider, index?: MatchIndex): Promise<{ stored: number; skipped: number; error?: string }> {
  const conn = await prisma.mailboxConnection.findUnique({ where: { userId } });
  if (!conn || conn.status === "disconnected") return { stored: 0, skipped: 0 };

  try {
    const token = await accessTokenFor(conn, provider);
    const { messages, cursor } = await provider.fetchSince(token, conn.cursor);
    const idx = index ?? await buildMatchIndex();
    const out = await ingest(userId, conn.address, messages, idx);
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      data: { cursor, lastSyncAt: new Date().toISOString(), lastError: null, status: "active" },
    });
    return out;
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 400);
    await prisma.mailboxConnection.update({
      where: { id: conn.id },
      // needs_reconnect, not disconnected: the person still granted this, and the difference decides
      // whether the screen asks them to sign in again or tells them it is off.
      data: { lastError: msg, status: "needs_reconnect", lastSyncAt: new Date().toISOString() },
    });
    return { stored: 0, skipped: 0, error: msg };
  }
}
