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
    } catch {
      // Unique (userId, externalId) — already have it. Counted as skipped, not as a failure.
      skipped++;
      continue;
    }
  }
  return { stored, skipped };
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
