/**
 * The IMAP adapter's parsing, checked without a mailbox.
 *
 * The network half cannot be proved here — that is the nature of an adapter, and why it is kept
 * small. What CAN go wrong silently is the header reading: a folded References line, a reply with
 * no References at all, an address whose server we claim to know. Each of those produces a wrong
 * THREAD, and a wrong thread quietly corrupts "did we reply" and every reply-time figure built on
 * it. So they are pinned here.
 *
 *   pnpm -C server exec tsx scripts/imap-check.ts
 */
import { threadOf, hostFor, needsAppPassword, domainOf } from "../src/imap.js";

let failed = 0;
const is = (what: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
};

// ── the thread root ─────────────────────────────────────────────────────────────────────────
const env = { messageId: "<own@x>", inReplyTo: "<parent@x>" };

is("References wins, and it is the FIRST id (the root), not the last",
  threadOf(env, Buffer.from("References: <root@x> <parent@x>\r\n")), "<root@x>");

// Folded across lines is not exotic: every client folds a long References header, and a regex
// that stops at the first newline would read the root as empty on any thread past two messages.
is("a folded References header still yields the root",
  threadOf(env, Buffer.from("References: <root@x>\r\n <mid@x>\r\n\t<parent@x>\r\n")), "<root@x>");

is("header name is matched case-insensitively",
  threadOf(env, Buffer.from("REFERENCES: <root@x>\r\n")), "<root@x>");

// A reply whose client dropped References — common enough — still belongs with its parent.
is("no References falls back to In-Reply-To", threadOf(env, Buffer.from("")), "<parent@x>");

// A message that starts a conversation is its own root, so the first and second message of a
// thread agree: this one's messageId IS what the reply's In-Reply-To will name.
is("a new conversation is its own root",
  threadOf({ messageId: "<own@x>" }, Buffer.from("")), "<own@x>");

is("a References line with no angle brackets is ignored, not returned raw",
  threadOf(env, Buffer.from("References: garbage\r\n")), "<parent@x>");

is("another header starting with 'references' in its VALUE does not match",
  threadOf({ messageId: "<own@x>" }, Buffer.from("Subject: references for you\r\n")), "<own@x>");

// ── which server, and whether a plain password can possibly work ────────────────────────────
is("gmail", hostFor("a.b@gmail.com"), "imap.gmail.com");
is("outlook.com and its aliases share a host", hostFor("x@hotmail.com"), "outlook.office365.com");
is("case and spacing in the address do not matter", hostFor("  X@GMAIL.COM "), "imap.gmail.com");
is("an unknown domain returns empty, so the form asks", hostFor("x@acme-plant.sa"), "");
is("a malformed address does not throw", hostFor("not-an-address"), "");
is("domainOf", domainOf("a@B.com"), "b.com");

is("gmail needs an app password", needsAppPassword("x@gmail.com"), true);
is("a custom domain makes no such claim", needsAppPassword("x@acme-plant.sa"), false);

console.log(failed ? `\n${failed} FAILED` : "\nall ok");
process.exit(failed ? 1 : 0);
