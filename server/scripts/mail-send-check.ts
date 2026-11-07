/**
 * SENDING, THROUGH THE REAL CODE, AGAINST A REAL SMTP CONVERSATION.
 *
 *   npx tsx scripts/mail-send-check.ts        (local databases only; nothing leaves the machine)
 *
 * The mail path had no check of any kind, which is uncomfortable for the one part of this system
 * that talks to the outside world — and it was a major version bump of nodemailer that made the
 * gap obvious: the whole surface this app uses is `createTransport`, `sendMail` and `verify`, and
 * nothing would have told us if any of the three had changed shape underneath us.
 *
 * So this stands up a throwaway SMTP server on a free port, points the stored config at it, and
 * sends through `sendMail()` itself — the same function every notification, invitation and
 * reminder goes through. It asserts on what the server actually RECEIVED, not on what nodemailer
 * returned, because a transport that resolves without putting a message on the wire is exactly the
 * failure this is for.
 *
 * The server speaks only enough SMTP to accept one message. It is forty lines and it is the point:
 * a fake that returns a canned success proves the test, not the code.
 */
import net from "node:net";
import { prisma } from "../src/db.js";
import { sendMail, verifyEmail, getEmailConfig } from "../src/mailer.js";

const host = String(process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`refusing: DATABASE_URL points at "${host || "an unknown host"}", not a local database.`);
  process.exit(2);
}

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) failures++; };

type Received = { mailFrom: string; rcptTo: string[]; data: string };

/** Enough SMTP to accept one message and remember it. No auth: the transport only offers it when asked. */
function sink(): Promise<{ port: number; got: Promise<Received>; close: () => void }> {
  let resolveGot: (r: Received) => void;
  const got = new Promise<Received>(r => { resolveGot = r; });

  const server = net.createServer(socket => {
    const seen: Received = { mailFrom: "", rcptTo: [], data: "" };
    let inData = false;
    let buf = "";
    socket.write("220 zz-sink ESMTP\r\n");
    socket.on("data", chunk => {
      buf += chunk.toString("utf8");
      for (;;) {
        const i = buf.indexOf("\r\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);

        if (inData) {
          // A lone "." ends the body; anything else is the message, dot-unstuffed.
          if (line === ".") { inData = false; socket.write("250 queued\r\n"); resolveGot(seen); continue; }
          seen.data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) socket.write("250-zz-sink\r\n250 8BITMIME\r\n");
        else if (up.startsWith("MAIL FROM")) { seen.mailFrom = line.slice(line.indexOf(":") + 1).trim(); socket.write("250 ok\r\n"); }
        else if (up.startsWith("RCPT TO")) { seen.rcptTo.push(line.slice(line.indexOf(":") + 1).trim()); socket.write("250 ok\r\n"); }
        else if (up.startsWith("DATA")) { inData = true; socket.write("354 go ahead\r\n"); }
        else if (up.startsWith("QUIT")) { socket.write("221 bye\r\n"); socket.end(); }
        else socket.write("250 ok\r\n");
      }
    });
    socket.on("error", () => { /* the client hanging up is not a failure here */ });
  });

  return new Promise(resolve => {
    // Port 0: the OS picks a free one, so this never collides with a dev server or another run.
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, got, close: () => server.close() });
    });
  });
}

const SETTING = "email";
let previous: unknown;
let had = false;

async function main() {
  const s = await sink();
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING } });
    had = !!row; previous = row?.value;

    const cfg = {
      enabled: true, host: "127.0.0.1", port: s.port, secure: false,
      user: "", pass: "", from: "ZZ Check <zz-check@example.invalid>", replyTo: "",
    };
    await prisma.appSetting.upsert({
      where: { key: SETTING },
      create: { key: SETTING, value: cfg as any },
      update: { value: cfg as any },
    });

    const read = await getEmailConfig();
    ok(read.host === "127.0.0.1" && read.port === s.port && read.enabled, "the stored configuration is what sendMail will use");

    const v = await verifyEmail();
    ok(v.ok, `verify() completes a connection (${v.ok ? "ok" : v.error})`);

    const out = await sendMail({
      to: "someone@example.invalid",
      cc: ["copied@example.invalid"],
      subject: "ZZ send check",
      html: "<p>body</p>",
      text: "body",
      kind: "zz-check",
    });
    ok(out.sent === true, "sendMail reports it sent");

    const got = await Promise.race([
      s.got,
      new Promise<Received>((_, rej) => setTimeout(() => rej(new Error("nothing reached the server within 10s")), 10_000)),
    ]);

    // WHAT THE SERVER RECEIVED. The envelope is the part a transport change would break silently:
    // nodemailer builds it from `from`, `to` and `cc`, and a message that resolves without a
    // recipient on the wire is a notification nobody gets and no error anywhere.
    ok(/zz-check@example\.invalid/.test(got.mailFrom), `the envelope sender is the configured from (${got.mailFrom})`);
    ok(got.rcptTo.some(r => r.includes("someone@example.invalid")), "the recipient is on the envelope");
    ok(got.rcptTo.some(r => r.includes("copied@example.invalid")), "and so is the cc, which only the envelope carries");
    ok(/^Subject: ZZ send check$/m.test(got.data), "the subject arrived");
    ok(/<p>body<\/p>/.test(got.data), "so did the HTML part");

    // And the log row, which is how an admin ever finds out what happened.
    const logged = await prisma.mailLog.findFirst({ where: { kind: "zz-check" }, orderBy: { at: "desc" } });
    ok(logged?.status === "sent", `the send is recorded as sent (${logged?.status ?? "no row"})`);
    ok(!/body/.test(JSON.stringify(logged ?? {})), "and the body is not in the log");
  } finally {
    s.close();
    await prisma.mailLog.deleteMany({ where: { kind: "zz-check" } });
    if (had) await prisma.appSetting.update({ where: { key: SETTING }, data: { value: previous as any } });
    else await prisma.appSetting.delete({ where: { key: SETTING } }).catch(() => {});
    await prisma.$disconnect();
  }
}

await main();
console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
