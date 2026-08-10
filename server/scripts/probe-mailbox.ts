/**
 * Throwaway check: the mailbox pipeline reads narrowly, matches correctly, and refuses the rest.
 *
 * WHAT THIS CAN AND CANNOT PROVE. The two provider adapters make live HTTP calls to Gmail and
 * Microsoft Graph, and there are no credentials here, so those two functions are NOT exercised.
 * Everything else is — and everything else is where the consequences are. The adapter's whole job
 * is to return `{externalId, threadId, from, to, subject, sentAt}`; a fake provider returning
 * exactly that shape drives the real matcher, the real privacy filter, the real de-duplication,
 * the real cursor handling and the real reply-time maths.
 *
 * The assertion that matters most is the privacy one: a message to somebody this system does not
 * know must not be stored. Not stored-and-hidden — never written. The fixture therefore always
 * includes a personal email (a payslip) and asserts the row count, not a flag.
 *
 * Own users, contacts, messages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { buildMatchIndex, matchMessage, ingest, replyTimes, saveConnection, syncMailbox, addressOf, type MailboxProvider, type RawMessage } from "../src/mailbox.js";

const REP = "zz-rep@example.invalid";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ MAIL" } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.emailMessage.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({ where: { email: { contains: "example.invalid" } }, select: { id: true } });
  if (users.length) {
    await prisma.emailMessage.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.mailboxConnection.deleteMany({ where: { userId: { in: users.map(u => u.id) } } });
    await prisma.user.deleteMany({ where: { id: { in: users.map(u => u.id) } } });
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  try {
    await sweep();
    const rep = await prisma.user.create({ data: { name: "ZZ Rep", email: REP, roleId: "sales", status: "active", type: "staff" } });
    const co = await prisma.company.create({ data: { name: "ZZ MAIL Client Co", lifecycle: "client", cr: "7770001111", email: "billing@zzmail.invalid" } });
    await prisma.contact.create({ data: { companyId: co.id, name: "ZZ Contact", email: "Fahad ZZ <fahad@zzmail.invalid>", isPrimary: true } });

    // ── address parsing ───────────────────────────────────────────────────────────────────────
    console.log(`a display-name header is parsed:         ${addressOf('"Fahad" <fahad@zzmail.invalid>') === "fahad@zzmail.invalid" ? "YES" : "NO"}`);
    if (addressOf('"Fahad" <fahad@zzmail.invalid>') !== "fahad@zzmail.invalid") fail("a normal From: header did not yield an address — half the mail would file under nobody");

    const index = await buildMatchIndex();
    console.log(`  the contact is in the match index:     ${index.byContact.has("fahad@zzmail.invalid") ? "YES" : "NO"}`);
    if (!index.byContact.has("fahad@zzmail.invalid")) fail("a stored contact with a display-name email is not matchable");

    // ── direction and counterparty ────────────────────────────────────────────────────────────
    const outbound: RawMessage = { externalId: "m1", threadId: "t1", from: REP, to: ["fahad@zzmail.invalid"], subject: "ZZ quote", sentAt: hoursAgo(30) };
    const inbound: RawMessage = { externalId: "m2", threadId: "t1", from: "Fahad <fahad@zzmail.invalid>", to: [REP], subject: "Re: ZZ quote", sentAt: hoursAgo(24) };
    const mOut = matchMessage(outbound, REP, index);
    const mIn = matchMessage(inbound, REP, index);
    console.log(`\noutbound is 'out', client is the other:  ${mOut?.direction === "out" && mOut.counterparty === "fahad@zzmail.invalid" ? "YES" : "NO (" + JSON.stringify(mOut) + ")"}`);
    if (mOut?.direction !== "out" || mOut.counterparty !== "fahad@zzmail.invalid") fail("a sent message was attributed to the rep instead of the client");
    console.log(`  inbound is 'in', same counterparty:    ${mIn?.direction === "in" && mIn.counterparty === "fahad@zzmail.invalid" ? "YES" : "NO"}`);
    if (mIn?.direction !== "in") fail("a received message was not recognised as inbound");
    console.log(`  both land on the same company:         ${mOut?.companyId === co.id && mIn?.companyId === co.id ? "YES" : "NO"}`);

    // ── THE PRIVACY FILTER ────────────────────────────────────────────────────────────────────
    const payslip: RawMessage = { externalId: "m3", threadId: "t9", from: "payroll@zz-rep-bank.invalid", to: [REP], subject: "Your payslip", sentAt: hoursAgo(5) };
    console.log(`\na personal email matches NOBODY:         ${matchMessage(payslip, REP, index) === null ? "YES" : "NO"}`);
    if (matchMessage(payslip, REP, index) !== null) fail("a rep's personal mail was matched to a client");

    const res = await ingest(rep.id, REP, [outbound, inbound, payslip], index);
    console.log(`  ingest stores 2 and skips 1:           ${res.stored === 2 && res.skipped === 1 ? "YES" : "NO (" + JSON.stringify(res) + ")"}`);
    if (res.stored !== 2 || res.skipped !== 1) fail("the wrong number of messages was stored");
    // The row count is the real assertion — "not stored", not "stored and filtered out of a view".
    const anyPersonal = await prisma.emailMessage.count({ where: { counterparty: { contains: "zz-rep-bank" } } });
    console.log(`  and the personal one has NO ROW:       ${anyPersonal === 0 ? "YES" : "NO (" + anyPersonal + " rows)"}`);
    if (anyPersonal !== 0) fail("the personal email exists in the database — the privacy filter is cosmetic");
    const bodies = await prisma.emailMessage.findFirst({ where: { userId: rep.id } });
    console.log(`  no body column exists to leak:         ${bodies && !("body" in bodies) ? "YES" : "NO"}`);

    // ── idempotency ───────────────────────────────────────────────────────────────────────────
    const again = await ingest(rep.id, REP, [outbound, inbound, payslip], index);
    const total = await prisma.emailMessage.count({ where: { userId: rep.id } });
    console.log(`\nre-syncing the same window is safe:      ${again.stored === 0 && total === 2 ? "YES (still 2)" : "NO (" + total + " rows)"}`);
    if (total !== 2) fail("a repeated sync double-counted the conversation");

    // ── reply time ────────────────────────────────────────────────────────────────────────────
    const rt = await replyTimes(co.id);
    console.log(`\ntime to first reply is measured:         ${rt.medianHours === 6 ? "YES (6h)" : "NO (" + rt.medianHours + ")"}`);
    if (rt.medianHours !== 6) fail("the reply gap was not measured from our first outbound to their first inbound");
    // An unanswered thread must NOT count as a slow reply — it must not count at all.
    await ingest(rep.id, REP, [{ externalId: "m4", threadId: "t2", from: REP, to: ["fahad@zzmail.invalid"], subject: "ZZ chase", sentAt: hoursAgo(2) }], index);
    const rt2 = await replyTimes(co.id);
    console.log(`  an unanswered thread is counted, not scored: ${rt2.threads === 2 && rt2.answered === 1 && rt2.medianHours === 6 ? "YES" : "NO (" + JSON.stringify(rt2) + ")"}`);
    if (rt2.threads !== 2 || rt2.answered !== 1 || rt2.medianHours !== 6) fail("an unanswered thread moved the median — being ignored would improve the number");

    // ── the sync loop, with a fake provider ───────────────────────────────────────────────────
    // Everything the real adapters do EXCEPT the HTTP call. Token refresh, cursor advance, failure
    // handling and status are all real code paths here.
    let refreshed = 0, seenCursor: string | null | undefined;
    const fake: MailboxProvider = {
      name: "google",
      async refresh() { refreshed++; return { accessToken: "zz-fresh", expiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
      async fetchSince(_t, cursor) {
        seenCursor = cursor;
        return { messages: [{ externalId: "m5", threadId: "t3", from: "fahad@zzmail.invalid", to: [REP], subject: "ZZ new", sentAt: hoursAgo(1) }], cursor: "cursor-2" };
      },
    };
    // An expired token forces the refresh path rather than assuming it works.
    await saveConnection(rep.id, "google", REP, { accessToken: "zz-old", refreshToken: "zz-refresh", expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const s1 = await syncMailbox(rep.id, fake);
    const conn = await prisma.mailboxConnection.findUniqueOrThrow({ where: { userId: rep.id } });
    console.log(`\nan expired token is refreshed first:     ${refreshed === 1 ? "YES" : "NO (" + refreshed + " refreshes)"}`);
    if (refreshed !== 1) fail("the sync did not renew an expired token ahead of use");
    console.log(`  the message was stored:                ${s1.stored === 1 ? "YES" : "NO (" + JSON.stringify(s1) + ")"}`);
    console.log(`  the cursor advanced:                   ${conn.cursor === "cursor-2" ? "YES" : "NO (" + conn.cursor + ")"}`);
    if (conn.cursor !== "cursor-2") fail("the cursor did not advance — every sync would re-read the same window");
    console.log(`  tokens are stored ENCRYPTED:           ${!conn.accessTokenEnc.includes("zz-fresh") && conn.accessTokenEnc.includes(":") ? "YES" : "NO"}`);
    if (conn.accessTokenEnc.includes("zz-fresh")) fail("an access token is sitting in the database in clear text");

    // ── a failing provider must not advance the cursor ────────────────────────────────────────
    const broken: MailboxProvider = {
      name: "google",
      async refresh() { return { accessToken: "x", expiresAt: new Date(Date.now() + 3600_000).toISOString() }; },
      async fetchSince() { throw new Error("ZZ provider is down"); },
    };
    const s2 = await syncMailbox(rep.id, broken);
    const after = await prisma.mailboxConnection.findUniqueOrThrow({ where: { userId: rep.id } });
    console.log(`\na failed sync keeps the cursor:          ${after.cursor === "cursor-2" ? "YES" : "NO (" + after.cursor + ")"}`);
    if (after.cursor !== "cursor-2") fail("a failure moved the cursor past messages nobody read — those are lost silently");
    console.log(`  …and records why, visibly:             ${after.status === "needs_reconnect" && /ZZ provider is down/.test(after.lastError ?? "") ? "YES" : "NO"}`);
    if (after.status !== "needs_reconnect") fail("a broken mailbox still reads as healthy — indistinguishable from a quiet client");
    console.log(`  the error is returned, not thrown:     ${s2.error ? "YES" : "NO"}`);

  } finally {
    await sweep();
  }

  const left = await prisma.user.count({ where: { email: { contains: "example.invalid" } } })
    + await prisma.company.count({ where: { name: { startsWith: "ZZ MAIL" } } })
    + await prisma.mailboxConnection.count();
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
