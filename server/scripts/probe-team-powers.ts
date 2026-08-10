/**
 * Throwaway check: what a team lead may DO, and that a report about the past uses the past's team.
 *
 * WHAT THIS IS FOR. probe-team-visibility.ts proves who a lead can SEE. This proves the three things
 * the firm asked a lead to be able to do — hand work between their people, approve their people's
 * work, and hold a team target — plus the reporting consequence of dating membership at all.
 *
 * THE ASSERTION THAT JUSTIFIES THE WHOLE DESIGN is the last one. A member moves out of the team
 * mid-quarter; the quarter's report must still count the deal they closed while they were in it.
 * Get that wrong and the dated rows are decoration: correct-looking numbers that quietly change
 * every time somebody transfers. The fixture is built so a system reading "today's team" produces a
 * VISIBLY different figure — the mover's deal is the only one in the earlier period.
 *
 * The approval rung is checked in both directions, because a permission that never says no is not a
 * permission. A lead may act on their own member's step; the identical call for somebody in another
 * team must be refused.
 *
 * Own users, teams, companies, deals and tasks. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { addMember, setLead, teamsLedBy } from "../src/teams.js";
import { visibleUserIds, actableTeamIds } from "../src/visibility.js";
import { salesReport } from "../src/salesreport.js";

const MARK = "ZZ POW";
const MAIL = "zzpow.invalid";
/** Q1 is entirely in the past, so the clamp-to-today rule cannot mask a history failure. */
const Q1 = "2026-01", Q1_MID = "2026-01-10", Q1_END = "2026-01-31";
const MOVED_ON = "2026-02-01";

async function sweep() {
  const teams = await prisma.team.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  const users = await prisma.user.findMany({ where: { email: { contains: MAIL } }, select: { id: true } });
  const cos = await prisma.company.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  const tIds = teams.map(t => t.id), uIds = users.map(u => u.id), cIds = cos.map(c => c.id);
  if (tIds.length) {
    await prisma.teamMember.deleteMany({ where: { teamId: { in: tIds } } });
    await prisma.teamLead.deleteMany({ where: { teamId: { in: tIds } } });
    await prisma.salesTarget.deleteMany({ where: { teamId: { in: tIds } } });
    await prisma.team.deleteMany({ where: { id: { in: tIds } } });
  }
  if (uIds.length) {
    await prisma.teamMember.deleteMany({ where: { userId: { in: uIds } } });
    await prisma.teamLead.deleteMany({ where: { userId: { in: uIds } } });
  }
  if (cIds.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: cIds } } });
    await prisma.company.deleteMany({ where: { id: { in: cIds } } });
  }
  // Targets are swept by their NOTE, not by team: the firm-wide one this probe creates has no
  // teamId, so a team-shaped sweep could never reach it — it survived every run and accumulated.
  await prisma.salesTarget.deleteMany({ where: { note: MARK } });
  const inst = await prisma.workflowInstance.findMany({ where: { title: { startsWith: MARK } }, select: { id: true } });
  if (inst.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: inst.map(i => i.id) } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: inst.map(i => i.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: inst.map(i => i.id) } } });
  }
  if (uIds.length) await prisma.user.deleteMany({ where: { id: { in: uIds } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  const yn = (b: boolean) => (b ? "YES" : "NO");

  try {
    await sweep();

    const mk = (n: string, role: string) =>
      prisma.user.create({ data: { name: `${MARK} ${n}`, email: `zz-${n}@${MAIL}`, roleId: role, status: "active", type: "staff" } });
    const [lead, ann, bob, stranger, otherLead] = await Promise.all([
      mk("lead", "sales"), mk("ann", "sales"), mk("bob", "sales"), mk("stranger", "sales"), mk("otherlead", "sales"),
    ]);

    const team = await prisma.team.create({ data: { name: `${MARK} Riyadh`, kind: "sales", active: true, createdAt: new Date().toISOString() } });
    const other = await prisma.team.create({ data: { name: `${MARK} Jeddah`, kind: "sales", active: true, createdAt: new Date().toISOString() } });
    await setLead(team.id, lead.id, Q1_MID);
    await setLead(other.id, otherLead.id, Q1_MID);
    await addMember(team.id, ann.id, Q1_MID);
    await addMember(team.id, bob.id, Q1_MID);
    await addMember(other.id, stranger.id, Q1_MID);

    const authLead = { sub: lead.id, role: "sales" };

    // ── (a) hand work between their own people ────────────────────────────────────────────────────
    // The reassign guard reads visibility, so this is the rung it depends on: the target must be in
    // the team and must not be the lead themselves.
    const visNow = await visibleUserIds(authLead);
    console.log(`a lead's set covers their people:       ${yn(visNow.scope === "team" && visNow.ids!.includes(ann.id) && visNow.ids!.includes(bob.id))}`);
    if (!visNow.ids!.includes(ann.id)) fail("a lead cannot reach their own member — handing work would be refused");
    console.log(`  …and never the other team:           ${yn(!visNow.ids!.includes(stranger.id))}`);
    if (visNow.ids!.includes(stranger.id)) fail("a lead can hand work to somebody in another team");

    // ── (b) approve their people's work ───────────────────────────────────────────────────────────
    // mayActOnTask is not exported (it is internal to the router), so the rung it depends on is
    // asserted here in the same shape the guard uses. Both directions, because a permission that
    // never refuses anything is not a permission.
    const canApprove = (assigneeId: string) => {
      const v = visNow;
      return assigneeId !== lead.id && v.scope === "team" && !!v.ids && v.ids.includes(assigneeId);
    };
    console.log(`\na lead may approve their member's step: ${yn(canApprove(ann.id))}`);
    if (!canApprove(ann.id)) fail("a lead cannot approve their own team's work");
    console.log(`  and is REFUSED on another team's:    ${yn(!canApprove(stranger.id))}`);
    if (canApprove(stranger.id)) fail("a lead can approve work belonging to a team that is not theirs");
    console.log(`  …and gains nothing on their own:     ${yn(!canApprove(lead.id))}`);
    if (canApprove(lead.id)) fail("the lead rung would let somebody approve their own step — that is the control it exists to keep");

    // ── (c) a team holds a target ─────────────────────────────────────────────────────────────────
    await prisma.salesTarget.create({ data: { period: Q1, teamId: team.id, ownerId: null, amountMinor: 500000, note: MARK, createdAt: new Date().toISOString() } });
    await prisma.salesTarget.create({ data: { period: Q1, teamId: null, ownerId: null, amountMinor: 999999, note: MARK, createdAt: new Date().toISOString() } });
    const led = await actableTeamIds(authLead);
    console.log(`\nthe lead may act for exactly one team:  ${yn(!!led && led.length === 1 && led[0] === team.id)}`);
    const teamRep = await salesReport({ period: Q1, ownerIds: visNow.ids, teamId: team.id });
    console.log(`  the report reads the TEAM's target:  ${yn(teamRep.target?.amountMinor === 500000)}`);
    if (teamRep.target?.amountMinor !== 500000) fail("a team report was measured against a target that is not the team's");
    const firmRep = await salesReport({ period: Q1 });
    console.log(`  and a firm report the firm's:       ${yn(firmRep.target?.amountMinor === 999999)}`);
    if (firmRep.target?.amountMinor !== 999999) fail("the firm-wide target stopped resolving once teams could hold one");

    // ── the reporting consequence of dating membership ────────────────────────────────────────────
    // Ann closes a deal in January while she is in the team, then moves to the other team on 1 Feb.
    // January's report must still contain it. A system reading today's team loses it entirely — and
    // it is the ONLY deal in the period, so the difference is a number, not a rounding.
    const co = await prisma.company.create({ data: { name: `${MARK} Client`, lifecycle: "client", cr: "9990001111" } });
    const stage = await prisma.pipelineStage.findFirst({ where: { isWon: true } });
    if (!stage) { console.log("\n(no won stage configured — skipping the history assertion)"); }
    else {
      await prisma.opportunity.create({
        data: {
          // No `status` column: won/lost is DERIVED from the stage (see pipeline.ts statusOf), which
          // is why the deal is put on a stage flagged isWon rather than labelled by hand.
          number: "ZZPOW-1", title: `${MARK} January deal`, companyId: co.id, ownerId: ann.id,
          stageId: stage.id, country: stage.country,
          valueMinor: 250000, currency: "SAR",
          createdAt: "2026-01-05T00:00:00.000Z", closedAt: "2026-01-20T00:00:00.000Z", stageAt: "2026-01-20T00:00:00.000Z",
        },
      });
      await addMember(other.id, ann.id, MOVED_ON);   // she leaves the team on 1 Feb

      const visThen = await visibleUserIds(authLead, Q1_END);
      const visToday = await visibleUserIds(authLead);
      console.log(`\nAnn is in January's team:               ${yn(visThen.ids!.includes(ann.id))}`);
      if (!visThen.ids!.includes(ann.id)) fail("January's team does not contain somebody who was in it in January");
      console.log(`  …and not in today's:                 ${yn(!visToday.ids!.includes(ann.id))}`);
      if (visToday.ids!.includes(ann.id)) fail("she moved teams and the current team still claims her");

      const janAsAtThen = await salesReport({ period: Q1, ownerIds: visThen.ids, teamId: team.id });
      const janAsAtToday = await salesReport({ period: Q1, ownerIds: visToday.ids, teamId: team.id });
      console.log(`  January counts her deal:             ${yn(janAsAtThen.won.valueMinor === 250000)}`);
      if (janAsAtThen.won.valueMinor !== 250000) fail(`January's report lost a deal closed by a member who was in the team then (got ${janAsAtThen.won.valueMinor})`);
      // The whole argument, in one line: reading membership as at today gives a different — wrong — answer.
      console.log(`  reading TODAY's team loses it:       ${yn(janAsAtToday.won.valueMinor === 0)}`);
      if (janAsAtToday.won.valueMinor === janAsAtThen.won.valueMinor) {
        fail("both dates give the same figure — this fixture cannot tell dated membership from undated, so it proves nothing");
      }
    }

    // ── a lead who leads nothing any more ─────────────────────────────────────────────────────────
    await setLead(team.id, null, new Date().toISOString().slice(0, 10));
    const after = await visibleUserIds(authLead);
    console.log(`\nan ex-lead drops to self-scope:         ${yn(after.scope === "self")}`);
    if (after.scope !== "self") fail("somebody who no longer leads a team still sees it");
    console.log(`  …but still led it back in January:   ${yn((await teamsLedBy(lead.id, Q1_END)).includes(team.id))}`);
    if (!(await teamsLedBy(lead.id, Q1_END)).includes(team.id)) fail("clearing a lead erased that they ever led it");
    console.log(`  and may act for nothing now:         ${yn(((await actableTeamIds(authLead)) ?? []).length === 0)}`);

  } finally {
    await sweep();
  }

  const left = (await prisma.team.count({ where: { name: { startsWith: MARK } } }))
    + (await prisma.user.count({ where: { email: { contains: MAIL } } }))
    + (await prisma.company.count({ where: { name: { startsWith: MARK } } }))
    + (await prisma.salesTarget.count({ where: { note: MARK } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
