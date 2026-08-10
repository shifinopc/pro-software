/**
 * Throwaway check: an invited account can be reached, and only by its link.
 *
 * The old flow handed a generated password to a staff member to relay by hand. This asserts the new
 * one is actually a replacement and not just a different-looking dialog:
 *
 *   - an invited account has NO password, so there is nothing to guess or leak
 *   - it cannot be logged into, with any password, until the link is used
 *   - the link sets the first password and then dies — it is single use
 *   - reissuing kills the previous link, so two live invitations can never exist
 *   - an expired link is refused
 *   - the raw token is NEVER stored: only its sha256 is in the database
 *   - portal users get the portal URL, staff get the console URL
 *   - mail being off or broken does NOT lose the account — it reports emailed:false and the link
 *
 * Own users, own company. Deletes all of it afterwards.
 */
import crypto from "node:crypto";
import { prisma } from "../src/db.js";
import { sendInvitation, issueInviteToken, INVITE_TTL_HOURS, homeFor } from "../src/invitations.js";

const API = "http://localhost:4100";
const MAIL = "zz-invitee@example.invalid";

async function sweep() {
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
}

/**
 * The probe must never send real mail.
 *
 * The first version of this file didn't guard that, and its very first `sendInvitation` went out
 * through the live Brevo relay to zz-invitee@example.invalid — a real send, to a domain that cannot
 * exist, producing a real bounce on the account's sending reputation. A probe that spends the thing
 * it is testing is not a probe. So sending is switched OFF for the whole run and restored after:
 * `sendMail` then logs instead of transmitting, which exercises every line except the socket.
 */
async function withMailSilenced<T>(fn: () => Promise<T>): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key: "email" } });
  const snapshot = row?.value ?? null;
  const off = { ...((snapshot as any) ?? {}), enabled: false };
  await prisma.appSetting.upsert({ where: { key: "email" }, update: { value: off as any }, create: { key: "email", value: off as any } });
  try {
    return await fn();
  } finally {
    if (snapshot) await prisma.appSetting.update({ where: { key: "email" }, data: { value: snapshot as any } });
    else await prisma.appSetting.deleteMany({ where: { key: "email" } });
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const co = await prisma.company.create({ data: { name: "ZZ Invite Co", cr: "9996660001", lifecycle: "client", email: MAIL } });
  const user = await prisma.user.create({
    data: { name: "ZZ Invitee", email: MAIL, roleId: "client_admin", status: "active", type: "portal", companyId: co.id, passwordHash: null, mustChangePassword: true },
  });

  // ── an invited account has nothing to steal ────────────────────────────────────────────────
  const inv = await withMailSilenced(() => sendInvitation(user, { companyName: co.name }));
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  console.log(`invitation issued:                       ${inv.link ? "YES" : "NO"} (sending off → emailed: ${inv.emailed})`);
  if (inv.emailed) fail("it reported a send while sending was switched off");
  if (!inv.error) fail("sending was off and nothing said so — an admin would think the client was emailed");
  console.log(`  the account has NO password:           ${fresh?.passwordHash === null ? "YES" : "NO"}`);
  if (fresh?.passwordHash !== null) fail("an invited account still carries a password somebody could relay or leak");

  const rawToken = inv.link.split("token=")[1];
  const stored = fresh?.resetTokenHash ?? "";
  console.log(`  only the hash is stored:               ${stored === crypto.createHash("sha256").update(rawToken).digest("hex") && stored !== rawToken ? "YES" : "NO"}`);
  if (stored === rawToken) fail("the raw token is in the database — a dump or backup would hand over every live invitation");

  console.log(`  points at the portal, not the console: ${inv.link.startsWith(homeFor("portal")) ? "YES" : "NO (" + inv.link + ")"}`);
  if (!inv.link.startsWith(homeFor("portal"))) fail("a client was sent to the staff console");
  const staffLink = homeFor("staff");
  console.log(`  staff would get the console:           ${staffLink !== homeFor("portal") ? "YES" : "NO"}`);
  if (staffLink === homeFor("portal")) fail("staff and clients are being sent to the same place");

  // ── it cannot be logged into ───────────────────────────────────────────────────────────────
  const tryLogin = async (password: string) => {
    const r = await fetch(API + "/api/auth/portal-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: MAIL, password }) });
    return r.status;
  };
  const blank = await tryLogin("");
  console.log(`\nlogin refused before the link is used:   ${blank === 401 ? "YES" : "NO (" + blank + ")"}`);
  if (blank !== 401) fail("an account with no password let somebody in");

  // ── the link sets the password, once ───────────────────────────────────────────────────────
  const setPw = async (token: string, pw: string) => {
    const r = await fetch(API + "/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, newPassword: pw }) });
    return r.status;
  };
  const first = await setPw(rawToken, "zz-Chosen-Password-1");
  console.log(`\nthe link sets the first password:        ${first === 200 ? "YES" : "NO (" + first + ")"}`);
  if (first !== 200) fail("the invitation link did not work, so an invited person cannot get in at all");

  const reuse = await setPw(rawToken, "zz-Second-Attempt-2");
  console.log(`  the same link cannot be used twice:    ${reuse === 400 ? "YES" : "NO (" + reuse + ")"}`);
  if (reuse !== 400) fail("the link is reusable — anyone who sees it later can take the account over");

  const after = await prisma.user.findUnique({ where: { id: user.id } });
  console.log(`  mustChangePassword cleared:            ${after?.mustChangePassword === false ? "YES" : "NO"}`);
  if (after?.mustChangePassword !== false) fail("they are still nagged to change the password they just chose");

  const good = await tryLogin("zz-Chosen-Password-1");
  console.log(`  they can now sign in:                  ${good === 200 ? "YES" : "NO (" + good + ")"}`);
  if (good !== 200) fail("the password they chose does not work");

  // ── reissuing invalidates the old link ─────────────────────────────────────────────────────
  const a = await issueInviteToken(user.id);
  const b = await issueInviteToken(user.id);
  const oldOne = await setPw(a.raw, "zz-Should-Not-Work-3");
  console.log(`\nreissuing kills the previous link:       ${oldOne === 400 ? "YES" : "NO (" + oldOne + ")"}`);
  if (oldOne !== 400) fail("two live invitations existed at once");
  // Checked against the stored hash rather than by calling the endpoint again: `resetLimiter` allows
  // 5 reset attempts an hour, and this run needs its remaining budget for the assertions that can
  // ONLY be made over HTTP (expiry enforcement, and the link from a failed send). That a fresh token
  // is accepted is already proven above.
  const held = await prisma.user.findUnique({ where: { id: user.id } });
  const bHash = crypto.createHash("sha256").update(b.raw).digest("hex");
  console.log(`  …and the newest one is the live one:   ${held?.resetTokenHash === bHash ? "YES" : "NO"}`);
  if (held?.resetTokenHash !== bHash) fail("reissuing did not leave the newest link as the live one");

  // ── expiry is enforced ─────────────────────────────────────────────────────────────────────
  const c = await issueInviteToken(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { resetExpires: new Date(Date.now() - 1000).toISOString() } });
  const expired = await setPw(c.raw, "zz-Too-Late-5");
  console.log(`\nan expired link is refused:              ${expired === 400 ? "YES" : "NO (" + expired + ")"}`);
  if (expired !== 400) fail("an expired invitation still worked");
  console.log(`  the window is ${INVITE_TTL_HOURS / 24} days, not the 1 hour a reset gets`);
  if (INVITE_TTL_HOURS <= 1) fail("an invitation expires as fast as a reset, so most will die unread");

  // ── mail being unavailable must not cost the account ───────────────────────────────────────
  const hostBefore = await prisma.appSetting.findUnique({ where: { key: "email" } });
  const snapshot = hostBefore?.value ?? null;
  try {
    await prisma.appSetting.upsert({
      where: { key: "email" },
      update: { value: { host: "zz-nowhere.invalid", port: 587, secure: false, user: "", from: "zz@example.invalid", pass: "", enabled: true } as any },
      create: { key: "email", value: { host: "zz-nowhere.invalid", port: 587, secure: false, user: "", from: "zz@example.invalid", pass: "", enabled: true } as any },
    });
    const broken = await sendInvitation(user, { companyName: co.name, resend: true });
    console.log(`\nunreachable mail server:                 emailed=${broken.emailed}, link still returned=${!!broken.link}`);
    if (broken.emailed) fail("it claimed to have emailed through a server that does not exist");
    if (!broken.link) fail("mail failed AND no link came back — that account is unreachable");
    if (!broken.error) fail("no reason was reported, so an admin cannot tell what went wrong");
    const stillWorks = await setPw(broken.link.split("token=")[1], "zz-After-Mail-Failed-6");
    console.log(`  the link from the failed send works:   ${stillWorks === 200 ? "YES" : "NO (" + stillWorks + ")"}`);
    if (stillWorks !== 200) fail("the fallback link does not actually work");
  } finally {
    if (snapshot) await prisma.appSetting.update({ where: { key: "email" }, data: { value: snapshot as any } });
    else await prisma.appSetting.deleteMany({ where: { key: "email" } });
  }

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await sweep();
  const left =
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  const restored = await prisma.appSetting.findUnique({ where: { key: "email" } });
  const rv: any = restored?.value ?? {};
  console.log(`real email config intact: host=${rv.host} passLen=${rv.pass?.length ?? "n/a"}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
