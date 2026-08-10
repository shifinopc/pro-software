/**
 * Throwaway check: the operations half of Performance counts the right things, and refuses to
 * pretend about the rest.
 *
 * Performance measured selling only. The officers running the government steps — the people clients
 * are actually paying for — had no throughput, no SLA record, and no view of who was carrying what.
 *
 * What is asserted:
 *   - a step is counted in the month it was FINISHED, not the month it was started
 *   - the on-time rate is measured against steps that HAD an SLA, and is null when none did
 *   - the typical duration is a MEDIAN, so one step parked for months cannot skew it
 *   - open work is a fact about today, not about the period
 *   - somebody with open work and no completions still appears — they are busy, not idle
 *   - the officer list is alphabetical, never ranked by output
 *   - unassigned work is reported separately: it is the queue's problem, not a person's
 *   - work that predates `assigneeId` is reported as unattributable rather than silently dropped
 *
 * Own instance, own steps, own users. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { opsReport } from "../src/opsreport.js";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();
const thisPeriod = new Date().toISOString().slice(0, 7);

async function sweep() {
  const wf = await prisma.workflowTask.findMany({ where: { title: { startsWith: "ZZ " } }, select: { id: true } });
  if (wf.length) await prisma.workflowTask.deleteMany({ where: { id: { in: wf.map(w => w.id) } } });
  const inst = await prisma.workflowInstance.findMany({ where: { title: { startsWith: "ZZ " } }, select: { id: true } });
  if (inst.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: inst.map(i => i.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: inst.map(i => i.id) } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    // BASELINE FIRST. This database has real unassigned work in it, and an earlier version of this
    // probe asserted an absolute count and reported the code broken when it was the probe assuming
    // an empty world. Every figure that the real data can also contribute to is asserted as a DELTA.
    const before = await opsReport({ period: thisPeriod });
    const busy = await prisma.user.create({ data: { name: "ZZ Busy Officer", email: "zz-busy@example.invalid", roleId: "pro_officer", status: "active", type: "staff" } });
    const alice = await prisma.user.create({ data: { name: "ZZ Alice", email: "zz-alice@example.invalid", roleId: "pro_officer", status: "active", type: "staff" } });

    const tpl = await prisma.workflowTemplate.findFirst({ select: { id: true } });
    if (!tpl) { console.log("no workflow template to hang an instance on — cannot run"); return; }
    const inst = await prisma.workflowInstance.create({
      data: { templateId: tpl.id, title: "ZZ Ops Probe Run", status: "running", clientName: "ZZ Client", startedAt: iso(120) },
    });

    const step = (o: Partial<Parameters<typeof prisma.workflowTask.create>[0]["data"]>) =>
      prisma.workflowTask.create({ data: { instanceId: inst.id, nodeId: "zz", nodeType: "task", title: "ZZ Step", status: "active", ...(o as any) } });

    // Alice: three finished this month, one of them late; one finished LAST month (must not count).
    await step({ title: "ZZ Fast", assigneeId: alice.id, assignee: alice.name, status: "done", createdAt: iso(4), completedAt: iso(2), slaHours: 48, slaState: "on_track" });
    await step({ title: "ZZ Slow", assigneeId: alice.id, assignee: alice.name, status: "done", createdAt: iso(20), completedAt: iso(1), slaHours: 48, slaState: "breached" });
    await step({ title: "ZZ NoSla", assigneeId: alice.id, assignee: alice.name, status: "done", createdAt: iso(3), completedAt: iso(1) });
    await step({ title: "ZZ Ancient", assigneeId: alice.id, assignee: alice.name, status: "done", createdAt: iso(400), completedAt: iso(370), slaHours: 48, slaState: "on_track" });
    // Busy: nothing finished, two open — one already breached.
    await step({ title: "ZZ Open A", assigneeId: busy.id, assignee: busy.name, status: "active", createdAt: iso(9), slaHours: 24, slaState: "breached" });
    await step({ title: "ZZ Open B", assigneeId: busy.id, assignee: busy.name, status: "active", createdAt: iso(1), slaHours: 72, slaState: "on_track" });
    // Nobody's: open with a role and no person, plus a finished one with no id at all.
    await step({ title: "ZZ Orphan", assigneeId: null, assignee: null, assigneeRole: "pro_officer", status: "active", createdAt: iso(5) });
    await step({ title: "ZZ Legacy", assigneeId: null, assignee: "Somebody Who Left", status: "done", createdAt: iso(6), completedAt: iso(2) });

    const r = await opsReport({ period: thisPeriod });

    // ── the period boundary ───────────────────────────────────────────────────────────────────
    const aliceRow = r.officers.find(o => o.userId === alice.id);
    console.log(`counted in the month FINISHED:           alice=${aliceRow?.completed} (expected 3, not 4)`);
    if (aliceRow?.completed !== 3) fail(`a step finished a year ago was counted in this month (got ${aliceRow?.completed})`);

    // ── the on-time rate has an honest denominator ────────────────────────────────────────────
    console.log(`\non-time rate over SLA'd steps only:      ${r.onTimeRateBp == null ? "null" : Math.round(r.onTimeRateBp / 100) + "%"} of ${r.withSla} with an SLA`);
    if (r.withSla !== 2) fail(`the SLA denominator counted steps that had none (got ${r.withSla})`);
    if (r.breached !== 1) fail(`breaches miscounted (got ${r.breached})`);
    console.log(`  the no-SLA step is excluded, not zero:  ${aliceRow?.noSla === 1 ? "YES" : "NO (" + aliceRow?.noSla + ")"}`);
    if (aliceRow?.noSla !== 1) fail("a step with no SLA was folded into the on-time figures");

    const none = await opsReport({ period: "2001-01" });
    console.log(`  nothing measured → null, not 100%:     ${none.onTimeRateBp === null ? "YES" : "NO (" + none.onTimeRateBp + ")"}`);
    if (none.onTimeRateBp !== null) fail("an empty period reported a perfect on-time rate");

    // ── median, not mean ──────────────────────────────────────────────────────────────────────
    // Alice's three: 2 days, 19 days, 2 days → median 2, mean would be ~7.7.
    console.log(`\ntypical time is a median:                alice=${aliceRow?.medianDays} days (mean would be ~8)`);
    if (aliceRow?.medianDays !== 2) fail(`one slow step skewed the typical duration (got ${aliceRow?.medianDays})`);

    // ── open work is about today ──────────────────────────────────────────────────────────────
    const busyRow = r.officers.find(o => o.userId === busy.id);
    console.log(`\nsomebody busy with no completions shows: ${busyRow ? "YES" : "NO"}`);
    if (!busyRow) fail("an officer carrying open work was left off entirely — read as having done nothing");
    console.log(`  their open load and breach are counted: open=${busyRow?.openNow} breached=${busyRow?.openBreached}`);
    if (busyRow?.openNow !== 2 || busyRow?.openBreached !== 1) fail("open load or breaches miscounted");
    const ancient = await opsReport({ period: "2001-01" });
    console.log(`  open work ignores the period:          ${ancient.openNow === r.openNow ? "YES (" + r.openNow + " either way)" : "NO"}`);
    if ((await opsReport({ period: "2001-01" })).openNow !== r.openNow) fail("open work changed with the period — it is a fact about today, not about the period");

    // ── never ranked ──────────────────────────────────────────────────────────────────────────
    const names = r.officers.map(o => o.name);
    const alphabetical = [...names].sort((a, b) => a.localeCompare(b));
    console.log(`\nlisted alphabetically, never ranked:     ${JSON.stringify(names) === JSON.stringify(alphabetical) ? "YES" : "NO (" + names.join(", ") + ")"}`);
    if (JSON.stringify(names) !== JSON.stringify(alphabetical)) fail("the officer list is ordered by output — that is a league table, not a workload view");

    // ── the queue's problems are not a person's ───────────────────────────────────────────────
    console.log(`\nunassigned reported separately:          ${r.unassigned} total, ${r.unassigned - before.unassigned} added here · ${JSON.stringify(r.unassignedByRole)}`);
    if (r.unassigned - before.unassigned !== 1) fail(`unassigned open work miscounted (delta ${r.unassigned - before.unassigned}, expected 1)`);
    if (!r.unassignedByRole.some(u => u.role === "pro_officer")) fail("the unassigned breakdown lost the role the step was waiting for");
    if (r.officers.some(o => !o.userId)) fail("unassigned work was given a row in the people table");

    // ── legacy work says so ───────────────────────────────────────────────────────────────────
    console.log(`  pre-assigneeId work is admitted:       ${r.unattributed - before.unattributed === 1 ? "YES" : "NO (delta " + (r.unattributed - before.unattributed) + ")"}`);
    if (r.unattributed - before.unattributed !== 1) fail("work that cannot be attributed was silently dropped rather than reported");

    // ── scoping to one person ─────────────────────────────────────────────────────────────────
    const mine = await opsReport({ period: thisPeriod, assigneeId: alice.id });
    console.log(`\nscoped to one person:                    ${mine.officers.length === 1 && mine.officers[0].userId === alice.id ? "YES" : "NO (" + mine.officers.length + " rows)"}`);
    if (!(mine.officers.length === 1 && mine.officers[0].userId === alice.id)) fail("an officer's own view showed other people");
    if (mine.unattributed !== 0) fail("a scoped view counted somebody else's unattributed work");

  } finally {
    await sweep();
  }

  const left =
    (await prisma.workflowTask.count({ where: { title: { startsWith: "ZZ " } } })) +
    (await prisma.workflowInstance.count({ where: { title: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
