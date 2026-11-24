/**
 * THE SECOND COPY OF EVERY SLA BREACH, REMOVED.
 *
 *   npx tsx scripts/dedupe-sla-notifications.ts            count them, change nothing
 *   npx tsx scripts/dedupe-sla-notifications.ts --apply    delete them
 *
 * Every breach was announced twice: once by the SLA job through `notifyOnce`, keyed
 * `sla:<taskId>:breached` so the hourly tick cannot repeat it — and once by `notifySlaBreach`,
 * which carried an `inApp` payload with NO dedupe key. A MySQL unique index ignores NULLs, so the
 * pair could never collapse. notify.ts no longer writes the second one; this clears the ones
 * already filed.
 *
 * NARROW ON PURPOSE. A row is deleted only when ALL of these hold:
 *   · its `dedupeKey` is NULL — the keyed row is the one the job owns, and it is kept
 *   · an identical (title, message) row EXISTS with a dedupe key — proof it is the twin and not
 *     the only record of something
 *   · the title begins "SLA BREACHED:" — the only notification this fault produced
 *
 * So a breach that was somehow only ever written unkeyed survives, and nothing outside SLA is
 * touched. Idempotent: a second run finds nothing.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

(async () => {
  const sla = await prisma.notification.findMany({
    where: { title: { startsWith: "SLA BREACHED:" } },
    select: { id: true, title: true, message: true, dedupeKey: true },
  });

  // The (title, message) pairs that DO have a keyed row — those are the ones with a twin.
  const keyed = new Set(sla.filter(n => n.dedupeKey).map(n => `${n.title}\u0000${n.message ?? ""}`));
  const doomed = sla.filter(n => !n.dedupeKey && keyed.has(`${n.title}\u0000${n.message ?? ""}`));
  const orphans = sla.filter(n => !n.dedupeKey && !keyed.has(`${n.title}\u0000${n.message ?? ""}`));

  console.log(`SLA BREACHED notifications: ${sla.length}`);
  console.log(`  keyed (kept)            : ${sla.length - doomed.length - orphans.length}`);
  console.log(`  unkeyed twins           : ${doomed.length}  ← ${APPLY ? "deleting" : "would delete"}`);
  console.log(`  unkeyed with no twin    : ${orphans.length}  ← kept, they are the only record`);

  if (doomed.length && APPLY) {
    // In batches: a single `in` of several thousand ids is a query MySQL may refuse to plan.
    for (let i = 0; i < doomed.length; i += 500) {
      await prisma.notification.deleteMany({ where: { id: { in: doomed.slice(i, i + 500).map(n => n.id) } } });
    }
  }

  const after = await prisma.notification.count();
  console.log(`\n${APPLY ? `Done — ${doomed.length} removed, ${after} notifications left.` : "Nothing was changed. Re-run with --apply."}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(String(e?.message ?? e)); await prisma.$disconnect(); process.exit(1); });
