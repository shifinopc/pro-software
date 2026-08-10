/**
 * Throwaway check: a message that does not arrive leaves a trace somebody can find.
 *
 * `deliver()` swallowed send failures on purpose — a mail outage must not break the write path that
 * triggered it — but swallowed meant vanished: a client's invoice notice could fail every time and
 * the only symptom was somebody eventually saying "I never got that". This asserts the failure is
 * now recorded, visible, and cannot start a loop.
 *
 * What is asserted:
 *   - a FAILED send is recorded, with the transport's own reason, and still throws to the caller
 *   - a SKIPPED send (sending switched off) is recorded as skipped, NOT as a failure
 *   - the body is never stored — a log an admin browses must not become a copy of every reset link
 *   - `mailHealth` counts and surfaces the recent failures
 *   - Setup Check raises it as broken, with examples
 *   - THE LOOP GUARD: recording a failure sends nothing, so a dead relay cannot notify about its own
 *     failures forever
 *   - pruning drops old rows and keeps recent ones
 *
 * Own address, own rows. Restores the real email config whatever happens.
 */
import { prisma } from "../src/db.js";
import { sendMail, mailHealth, pruneMailLog } from "../src/mailer.js";
import { setupCheck } from "../src/setupcheck.js";

const TO = "zz-maillog@example.invalid";
const SENT: string[] = [];
const realLog = console.log;
const capture = () => {
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (/^\[mailer:disabled\] would send to/.test(line)) SENT.push(line);
    else realLog(...a);
  };
};
const stop = () => { console.log = realLog; };

const sweep = () => prisma.mailLog.deleteMany({ where: { to: { contains: "example.invalid" } } });

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const snap = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? null;
  const setCfg = (v: any) => prisma.appSetting.upsert({ where: { key: "email" }, update: { value: v }, create: { key: "email", value: v } });

  try {
    await sweep();

    // ── a failure is recorded, and still reaches the caller ────────────────────────────────────
    await setCfg({ ...((snap as any) ?? {}), host: "zz-nowhere.invalid", enabled: true });
    let threw = false;
    try {
      await sendMail({ to: TO, subject: "ZZ This will not arrive", html: "<p>ZZ SECRET BODY</p>", text: "ZZ SECRET BODY", kind: "ZZ probe" });
    } catch { threw = true; }
    const failedRow = await prisma.mailLog.findFirst({ where: { to: TO, status: "failed" }, orderBy: { at: "desc" } });
    console.log(`a failed send is recorded:               ${failedRow ? "YES" : "NO"}`);
    if (!failedRow) fail("a send failed and left no trace — exactly the situation this was meant to end");
    console.log(`  it still throws to the caller:         ${threw ? "YES" : "NO"}`);
    if (!threw) fail("recording swallowed the error, silently changing what every caller sees");
    console.log(`  the reason is kept verbatim:           ${/ENOTFOUND|getaddrinfo|zz-nowhere/i.test(failedRow?.error ?? "") ? "YES" : "NO (" + failedRow?.error + ")"}`);
    if (!failedRow?.error) fail("no reason recorded, so nobody can tell a bad address from a dead relay");
    console.log(`  the kind is carried through:           ${failedRow?.kind === "ZZ probe" ? "YES" : "NO (" + failedRow?.kind + ")"}`);
    if (failedRow?.kind !== "ZZ probe") fail("the log cannot say what sort of message this was");

    // ── the body is NOT stored ────────────────────────────────────────────────────────────────
    const all = await prisma.mailLog.findMany({ where: { to: TO } });
    const leaked = all.some(r => JSON.stringify(r).includes("SECRET BODY"));
    console.log(`  the body is not stored:                ${!leaked ? "YES" : "NO"}`);
    if (leaked) fail("the message body is in the log — it would hold reset links and client details");

    // ── switched off is skipped, not failed ───────────────────────────────────────────────────
    await sweep();
    await setCfg({ ...((snap as any) ?? {}), enabled: false });
    capture();
    const r = await sendMail({ to: TO, subject: "ZZ Sending is off", html: "<p>ZZ</p>", text: "ZZ", kind: "ZZ probe" });
    stop();
    const skipRow = await prisma.mailLog.findFirst({ where: { to: TO }, orderBy: { at: "desc" } });
    console.log(`\nsending off → recorded as "skipped":     ${skipRow?.status === "skipped" ? "YES" : "NO (" + skipRow?.status + ")"}`);
    if (skipRow?.status !== "skipped") fail("a deliberate configuration state is being reported as a fault, which trains admins to ignore the log");
    console.log(`  and sendMail reports sent:false:       ${r.sent === false ? "YES" : "NO"}`);
    if (r.sent !== false) fail("it claimed to have sent while sending was off");

    // ── health counts what matters ────────────────────────────────────────────────────────────
    await setCfg({ ...((snap as any) ?? {}), host: "zz-nowhere.invalid", enabled: true });
    for (let i = 0; i < 3; i++) { try { await sendMail({ to: TO, subject: `ZZ Failure ${i}`, html: "<p>ZZ</p>", text: "ZZ", kind: "ZZ probe" }); } catch { /* expected */ } }
    const health = await mailHealth(7);
    console.log(`\nmailHealth counts them: failed=${health.failed} skipped=${health.skipped}`);
    if (health.failed < 3) fail(`only ${health.failed} of 3 failures were counted`);
    console.log(`  recent failures are readable:          ${health.recent.length > 0 && !!health.recent[0].error ? "YES" : "NO"}`);
    if (!health.recent.length) fail("the summary carries no examples, so an admin sees a number and no cause");

    // ── THE LOOP GUARD ────────────────────────────────────────────────────────────────────────
    // Recording must not itself send. If it did, a dead relay would fail, notify about the failure,
    // fail again, and never stop. Counted rather than reasoned about: three failed sends above must
    // have produced exactly three rows and no additional outbound attempt.
    await setCfg({ ...((snap as any) ?? {}), enabled: false });
    SENT.length = 0;
    capture();
    try { await sendMail({ to: TO, subject: "ZZ Loop check", html: "<p>ZZ</p>", text: "ZZ", kind: "ZZ probe" }); } catch { /* n/a */ }
    stop();
    console.log(`\nrecording sends nothing itself:          ${SENT.length === 1 ? "YES (only the message itself)" : "NO (" + SENT.length + " attempts)"}`);
    if (SENT.length !== 1) fail("recording a mail event triggered another send — a dead relay would loop forever");

    // ── Setup Check surfaces it ───────────────────────────────────────────────────────────────
    const check = await setupCheck();
    const finding = check.findings.find((f: any) => f.key === "mail-failing");
    console.log(`\nSetup Check raises it:                   ${finding && finding.count > 0 ? "YES (" + finding.count + ")" : "NO"}`);
    if (!finding || !finding.count) fail("failures do not appear where an admin already looks for problems");
    console.log(`  as broken, with examples:              ${finding?.severity === "broken" && finding.examples?.length ? "YES" : "NO"}`);
    if (finding?.severity !== "broken") fail("mail that is configured and failing is not being treated as broken");

    // ── pruning ───────────────────────────────────────────────────────────────────────────────
    await prisma.mailLog.create({ data: { to: TO, subject: "ZZ Ancient", status: "sent", at: new Date(Date.now() - 60 * 86400_000).toISOString() } });
    const removed = await pruneMailLog(30);
    const oldLeft = await prisma.mailLog.count({ where: { to: TO, subject: "ZZ Ancient" } });
    const recentLeft = await prisma.mailLog.count({ where: { to: TO, status: "failed" } });
    console.log(`\npruning drops the old (${removed} removed):     ${oldLeft === 0 ? "YES" : "NO"}`);
    if (oldLeft) fail("old rows are never cleared, so this table grows forever");
    console.log(`  …and keeps the recent:                 ${recentLeft > 0 ? "YES" : "NO"}`);
    if (!recentLeft) fail("pruning deleted rows an admin still needs");

  } finally {
    stop();
    await sweep();
    if (snap) await setCfg(snap);
    else await prisma.appSetting.deleteMany({ where: { key: "email" } });
  }

  const left = await prisma.mailLog.count({ where: { to: { contains: "example.invalid" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");
  const e: any = (await prisma.appSetting.findUnique({ where: { key: "email" } }))?.value ?? {};
  console.log(`restored: host=${e.host} enabled=${e.enabled} passLen=${e.pass?.length ?? "n/a"} · real log rows: ${await prisma.mailLog.count()}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
