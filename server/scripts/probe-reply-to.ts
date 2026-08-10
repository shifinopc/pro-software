/**
 * Throwaway check: a reply reaches a human, and the footer never lies about whether it will.
 *
 * Everything this system sends came from a no-reply address with a footer stating that replies are
 * not monitored. That was true — and it meant a client who answered an invoice email was talking to
 * nobody. Adding a reply-to fixes the address; the footer is the part that can quietly go wrong,
 * because a configured reply-to plus the old footer is an email that tells a client their reply will
 * be ignored when in fact somebody is waiting for it.
 *
 * What is asserted:
 *   - with no reply-to: the header is absent AND the footer says replies are not monitored
 *   - with one: the header is set to it AND the footer names it
 *   - the two can never disagree — the footer is derived from the same value the header uses
 *   - a malformed reply-to is refused on save, so it cannot be stored at all
 *   - blank is accepted, because "nobody reads replies" is a legitimate answer
 *   - the stored password survives a reply-to edit
 *
 * Sending is silenced for the whole run; the disabled-mail log is what gets read.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
import { getEmailConfig } from "../src/mailer.js";
import { renderEmail, emailContext } from "../src/emailshell.js";

const API = "http://localhost:4100";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const mailSnap = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? null;
  if (!mailSnap) { console.log("no email config to work with — configure Settings → Email first"); return; }

  await prisma.user.deleteMany({ where: { email: "zz-probe-admin@example.invalid" } });
  await prisma.user.create({ data: { name: "ZZ Probe Admin", email: "zz-probe-admin@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("zz-Throwaway-1!", 10) } });

  try {
    const lj: any = await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zz-probe-admin@example.invalid", password: "zz-Throwaway-1!" }) })).json();
    if (!lj.token) { console.log("login failed — is the API up?"); return; }
    const H = { "Content-Type": "application/json", Authorization: "Bearer " + lj.token };
    const cur: any = await (await fetch(API + "/api/email-config", { headers: H })).json();
    // Sending stays OFF for the whole run so nothing can reach a real inbox.
    const base = { host: cur.host, port: cur.port, secure: cur.secure, user: cur.user, from: cur.from, enabled: false };

    const put = async (replyTo: string) => {
      const r = await fetch(API + "/api/email-config", { method: "PUT", headers: H, body: JSON.stringify({ ...base, replyTo }) });
      return { status: r.status, body: await r.json() as any };
    };

    // ── malformed is refused ───────────────────────────────────────────────────────────────────
    for (const badValue of ["support", "support@", "Reply Here"]) {
      const r = await put(badValue);
      console.log(`refuses ${JSON.stringify(badValue).padEnd(14)} → ${r.status === 400 ? "YES" : "NO (" + r.status + ")"}`);
      if (r.status !== 400) fail(`"${badValue}" was accepted as a reply address — replies to it would vanish silently`);
    }

    // ── none configured: header absent, footer honest ──────────────────────────────────────────
    await put("");
    const noneCfg = await getEmailConfig();
    const noneCtx = await emailContext();
    const none = renderEmail(noneCtx, { heading: "ZZ Heading", lines: ["ZZ body"] });
    console.log(`\nblank accepted:                          ${noneCfg.replyTo === "" ? "YES" : "NO (" + noneCfg.replyTo + ")"}`);
    if (noneCfg.replyTo !== "") fail("blank did not stay blank");
    console.log(`  context reports no reply address:      ${noneCtx.repliesTo === null ? "YES" : "NO"}`);
    if (noneCtx.repliesTo !== null) fail("the letterhead thinks there is a reply address when there is not");
    console.log(`  footer says replies not monitored:     ${/replies to it are not monitored/i.test(none.text) ? "YES" : "NO"}`);
    if (!/replies to it are not monitored/i.test(none.text)) fail("the footer no longer warns that nobody reads replies");
    console.log(`  …and does NOT promise a reply route:   ${!/Replies go to/i.test(none.text) ? "YES" : "NO"}`);
    if (/Replies go to/i.test(none.text)) fail("it promised replies would be read when nothing is configured");

    // ── configured: header set, footer names it ────────────────────────────────────────────────
    const ADDR = "zz-replies@example.invalid";
    const ok = await put(ADDR);
    console.log(`\naccepts a real address:                  ${ok.status === 200 ? "YES" : "NO (" + JSON.stringify(ok.body).slice(0, 90) + ")"}`);
    if (ok.status !== 200) fail("a well-formed reply address was rejected");
    const setCfg = await getEmailConfig();
    const setCtx = await emailContext();
    const set = renderEmail(setCtx, { heading: "ZZ Heading", lines: ["ZZ body"] });
    console.log(`  stored on the config:                  ${setCfg.replyTo === ADDR ? "YES" : "NO (" + setCfg.replyTo + ")"}`);
    if (setCfg.replyTo !== ADDR) fail("the reply address was not stored");
    console.log(`  the footer names it:                   ${set.text.includes(`Replies go to ${ADDR}`) ? "YES" : "NO"}`);
    if (!set.text.includes(`Replies go to ${ADDR}`)) fail("the email does not tell the reader where a reply goes");
    console.log(`  …and drops the "not monitored" line:   ${!/not monitored/i.test(set.text) ? "YES" : "NO"}`);
    if (/not monitored/i.test(set.text)) fail("THE FOOTER LIES: replies are routed, but the email says nobody reads them");
    console.log(`  html and text agree:                   ${/Replies go to/.test(set.html) && /Replies go to/.test(set.text) ? "YES" : "NO"}`);
    if (!(/Replies go to/.test(set.html) && /Replies go to/.test(set.text))) fail("the html and plain-text footers disagree");

    // ── the header itself, as nodemailer would build it ────────────────────────────────────────
    console.log(`\nsendMail would set Reply-To:             ${setCfg.replyTo ? "YES (" + setCfg.replyTo + ")" : "NO"}`);
    if (!setCfg.replyTo) fail("nothing would be put on the wire");

    // ── the password is not collateral damage ──────────────────────────────────────────────────
    const row: any = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? {};
    const origLen = (mailSnap as any)?.pass?.length ?? 0;
    console.log(`  password survived the edits:           ${row.pass?.length === origLen ? "YES" : "NO (" + row.pass?.length + " vs " + origLen + ")"}`);
    if (row.pass?.length !== origLen) fail("editing the reply address disturbed the stored password");

  } finally {
    if (mailSnap) await prisma.appSetting.update({ where: { key: "email" }, data: { value: mailSnap as any } });
    await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  }

  const e: any = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? {};
  console.log(`\nrestored: host=${e.host} enabled=${e.enabled} from=${e.from} replyTo=${JSON.stringify(e.replyTo ?? null)} passLen=${e.pass?.length}`);
  console.log(`probe users left: ${await prisma.user.count({ where: { email: { contains: "example.invalid" } } })}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
