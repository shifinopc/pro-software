/**
 * THE THIRD ADAPTER: ANY MAILBOX, OVER IMAP.
 *
 * WHY THIS EXISTS. The other two adapters need the provider's permission. Google classes
 * `gmail.readonly` as a RESTRICTED scope, so an External app may only ever serve accounts listed by
 * hand as testers — and even those have every refresh token killed after seven days — until it
 * passes a paid third-party security assessment. For a firm whose enquiries arrive at personal
 * Gmail addresses that is not a path, it is a wall. IMAP asks nobody: a host, a user, a password.
 *
 * WHAT IT BUYS. Gmail, Outlook.com, Yahoo, Zoho, iCloud, a cPanel box, a client's own domain —
 * the same five methods, no app registration anywhere.
 *
 * WHAT IT COSTS, said plainly. The other two store a REVOCABLE GRANT: the person can withdraw it
 * from their account page and we never see a password. This stores the password itself (encrypted
 * with CRED_KEY, like every other credential here, and never returned by any route). On Gmail and
 * Outlook that must be an APP PASSWORD, which is scoped to mail and revocable on its own — a point
 * worth making to anybody who asks, because "give the CRM your password" is the right thing to be
 * suspicious of. The connect form refuses to proceed without 2-step verification being on, because
 * without it an app password cannot be created in the first place.
 *
 * EVERYTHING BELOW THE SEAM IS UNCHANGED. The filter that decides a message is a client's and not
 * a rep's private business, the refusal to store bodies, the ingest — all of it lives in
 * mailbox.ts and cannot tell which adapter fetched a message.
 */
import { ImapFlow } from "imapflow";
import type { MailboxProvider, FetchResult, RawMessage, MessageBody } from "./mailbox.js";
import { htmlToText } from "./mailbox.js";

/** What we store, encrypted, where the OAuth adapters keep an access token. */
export interface ImapCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * The servers people would otherwise have to be told to look up.
 *
 * Asking a rep for "your IMAP host" is asking them to fail. The address already says it for every
 * mailbox a firm like this one actually uses; anything else falls back to the form's own field.
 */
const HOSTS: Record<string, string> = {
  "gmail.com": "imap.gmail.com",
  "googlemail.com": "imap.gmail.com",
  "outlook.com": "outlook.office365.com",
  "hotmail.com": "outlook.office365.com",
  "live.com": "outlook.office365.com",
  "msn.com": "outlook.office365.com",
  "yahoo.com": "imap.mail.yahoo.com",
  "yahoo.co.uk": "imap.mail.yahoo.com",
  "zoho.com": "imap.zoho.com",
  "icloud.com": "imap.mail.me.com",
  "me.com": "imap.mail.me.com",
  "aol.com": "imap.aol.com",
  "gmx.com": "imap.gmx.com",
  "yandex.com": "imap.yandex.com",
};

export const domainOf = (address: string) => String(address).split("@")[1]?.toLowerCase().trim() ?? "";

/** A known host for this address, or "" when the person must say. */
export const hostFor = (address: string) => HOSTS[domainOf(address)] ?? "";

/** Gmail and Outlook refuse an account password outright; saying so beats a bare AUTHENTICATIONFAILED. */
export const needsAppPassword = (address: string) => {
  const h = hostFor(address);
  return h === "imap.gmail.com" || h === "outlook.office365.com" || h === "imap.mail.yahoo.com";
};

const creds = (blob: string): ImapCreds => JSON.parse(blob);

/**
 * One connection, used and closed.
 *
 * shortcut: no pooling — a sync runs every few minutes, not every few seconds, and a pool of live
 * IMAP sessions is a set of sockets to keep alive, re-authenticate and reap. Revisit if syncs ever
 * run per-request rather than on the tick.
 */
async function withInbox<T>(c: ImapCreds, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: c.host, port: c.port || 993, secure: true,
    auth: { user: c.user, pass: c.pass },
    // The library logs every command at info level, and IMAP commands carry addresses and subjects.
    logger: false,
    // A dead host must fail the sync, not hang it: syncMailbox records the error and moves on.
    socketTimeout: 60_000, greetingTimeout: 20_000, connectionTimeout: 20_000,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { /* the server may have gone already; the result still stands */ });
  }
}

/** IMAP says "mailbox rebuilt, forget every id you held" by changing this. */
const validityOf = (client: ImapFlow) => String((client.mailbox as any)?.uidValidity ?? "0");

/** externalId is `uidValidity:uid` — self-describing, so a stale id is detectable rather than wrong. */
const idFor = (validity: string, uid: number) => `${validity}:${uid}`;

const addr = (a: any) => String(a?.address ?? "").trim();

/**
 * The thread this message belongs to.
 *
 * IMAP has no threads, so this is the standard reconstruction: the FIRST entry of References is the
 * root of the conversation, and every reply down the chain carries it. In-Reply-To alone is not
 * enough — it names the parent, so a third message would land in a different "thread" from the
 * first. A message that starts a conversation is its own root.
 */
export function threadOf(env: any, headers: unknown): string {
  const raw = headers ? Buffer.from(headers as any).toString("utf8") : "";
  // Header folding: a continuation line starts with space or tab.
  const m = raw.match(/^references:[ \t]*([\s\S]*?)(?:\r?\n(?![ \t])|$)/im);
  const first = m?.[1]?.match(/<[^>]+>/)?.[0];
  return first || env?.inReplyTo || env?.messageId || "";
}

function toRaw(msg: any, validity: string): RawMessage | null {
  const env = msg?.envelope;
  if (!env || !msg.uid) return null;
  const sent = env.date ? new Date(env.date) : null;
  return {
    externalId: idFor(validity, msg.uid),
    threadId: threadOf(env, msg.headers) || idFor(validity, msg.uid),
    from: addr(env.from?.[0]),
    to: (env.to ?? []).map(addr).filter(Boolean),
    subject: env.subject ?? null,
    sentAt: (sent && !isNaN(sent.getTime()) ? sent : new Date()).toISOString(),
  };
}

const FIELDS = { uid: true, envelope: true, headers: ["references"] } as const;

/** Oldest first, so a capped batch can advance the cursor without skipping anything. */
const byUid = (a: RawMessage, z: RawMessage) =>
  Number(a.externalId.split(":")[1]) - Number(z.externalId.split(":")[1]);

async function collect(client: ImapFlow, range: any, opts: any, validity: string, cap: number) {
  const out: RawMessage[] = [];
  for await (const msg of client.fetch(range, FIELDS as any, opts)) {
    const r = toRaw(msg, validity);
    if (r) out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

/** The readable part of a message, found the way the Gmail adapter finds it: text first. */
function pickParts(node: any, out: any[] = []): any[] {
  if (!node) return out;
  out.push(node);
  for (const c of node.childNodes ?? []) pickParts(c, out);
  return out;
}

async function readPart(client: ImapFlow, uid: number, part: string | undefined, maxBytes: number) {
  const d: any = await client.download(String(uid), part, { uid: true, maxBytes });
  if (!d?.content) return null;
  const chunks: Buffer[] = [];
  for await (const c of d.content) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export const imapProvider: MailboxProvider = {
  name: "imap",

  /**
   * Nothing to renew: a password is not a grant with an expiry. `saveConnection` stores an
   * expiry far enough out that `accessTokenFor` never asks — and if something ever does, this
   * says why rather than returning a credential that was never refreshed.
   */
  async refresh(): Promise<{ accessToken: string; expiresAt: string }> {
    throw new Error("An IMAP mailbox has no token to renew — reconnect it to change the password.");
  },

  async fetchRecent(blob, days): Promise<RawMessage[]> {
    return withInbox(creds(blob), async (client) => {
      const validity = validityOf(client);
      const since = new Date(Date.now() - Math.max(1, days) * 864e5);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (!uids.length) return [];
      // Newest first for a scan, which is only ever looking at the recent end.
      const take = uids.slice(-200);
      const msgs = await collect(client, take, { uid: true }, validity, 200);
      return msgs.sort(byUid).reverse();
    });
  },

  async fetchSince(blob, cursor): Promise<FetchResult> {
    return withInbox(creds(blob), async (client) => {
      const validity = validityOf(client);
      const [cv, cu] = String(cursor ?? "").split(":");
      // A UIDVALIDITY change means every uid we stored now refers to something else, or to
      // nothing. Starting from a date is the recovery, exactly as the Gmail adapter recovers
      // from an expired historyId.
      const usable = cv === validity && Number(cu) > 0;

      let msgs: RawMessage[];
      if (usable) {
        const from = Number(cu) + 1;
        // `N:*` always yields at least the last message even when its uid is below N, so the
        // filter is load-bearing rather than defensive.
        const all = await collect(client, `${from}:*`, { uid: true }, validity, 500);
        msgs = all.filter((m) => Number(m.externalId.split(":")[1]) >= from).sort(byUid).slice(0, 100);
      } else {
        const uids = (await client.search({ since: new Date(Date.now() - 14 * 864e5) }, { uid: true })) || [];
        msgs = uids.length
          ? (await collect(client, uids.slice(-100), { uid: true }, validity, 100)).sort(byUid)
          : [];
      }

      // The cursor only ever advances to what was actually read. With more than 100 waiting the
      // next tick collects the rest; advancing past unread mail would lose it silently.
      const last = msgs.length ? Number(msgs[msgs.length - 1].externalId.split(":")[1]) : Number(cu) || 0;
      return { messages: msgs, cursor: last ? `${validity}:${last}` : cursor ?? null };
    });
  },

  async fetchBody(blob, externalId): Promise<MessageBody | null> {
    const [validity, uidRaw] = String(externalId).split(":");
    const uid = Number(uidRaw);
    if (!uid) return null;

    return withInbox(creds(blob), async (client) => {
      // The id names the mailbox generation it came from. A mismatch means it points at nothing.
      if (validityOf(client) !== validity) return null;

      const msg: any = await client.fetchOne(String(uid), { bodyStructure: true }, { uid: true });
      if (!msg?.bodyStructure) return null;

      const parts = pickParts(msg.bodyStructure);
      // text/plain over text/html for the same reason as Gmail: the HTML alternative says the
      // same thing wrapped in a table layout, and converting it back is strictly worse than the
      // text the sender's own client already wrote.
      const plain = parts.find((p) => p.type === "text/plain" && !p.disposition);
      const rich = parts.find((p) => p.type === "text/html" && !p.disposition);
      const chosen = plain ?? rich;

      // A single-part message has no part number; the whole body IS the part.
      const partId = parts.length > 1 ? chosen?.part : undefined;
      const buf = chosen ? await readPart(client, uid, partId, 256 * 1024) : null;
      const text = buf ? buf.toString("utf8") : "";

      return {
        // htmlToText is NOT applied here: download() already ran the charset and format=flowed
        // decoders, but it does not strip markup — so html still needs it.
        text: chosen === rich && text ? htmlToText(text) : text,
        attachments: parts
          .filter((p) => p.part && (p.disposition === "attachment" || p.parameters?.name || p.dispositionParameters?.filename))
          .map((p) => ({
            id: String(p.part),
            name: String(p.dispositionParameters?.filename ?? p.parameters?.name ?? "attachment"),
            size: Number(p.size ?? 0),
          })),
      };
    });
  },

  async fetchAttachment(blob, externalId, attachmentId): Promise<Buffer | null> {
    const [validity, uidRaw] = String(externalId).split(":");
    const uid = Number(uidRaw);
    if (!uid || !attachmentId) return null;

    return withInbox(creds(blob), async (client) => {
      if (validityOf(client) !== validity) return null;
      // 25 MB: past what anybody attaches to an enquiry, and a bound rather than none at all.
      return readPart(client, uid, String(attachmentId), 25 * 1024 * 1024);
    });
  },
};

/**
 * Prove the credentials work BEFORE a row is written.
 *
 * A mailbox saved unverified looks connected and fails silently on the next tick, which is how a
 * person ends up believing their mail is being read when it is not. Returns the address as the
 * server knows it.
 */
export async function verifyImap(c: ImapCreds): Promise<{ address: string; messages: number }> {
  return withInbox(c, async (client) => ({
    address: c.user,
    messages: Number((client.mailbox as any)?.exists ?? 0),
  }));
}

/** The credential blob, as it is handed to every method above. */
export const credBlob = (c: ImapCreds) => JSON.stringify(c);
