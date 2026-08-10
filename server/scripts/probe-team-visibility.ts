/**
 * Throwaway check: teams answer "as at a day", and a lead change is one edit that moves no work.
 *
 * THIS REPLACED A PROBE OF THE SAME NAME that exercised `User.managerId` — a pointer per person,
 * with the team left to be inferred from everyone sharing a value. That column is gone, so the old
 * probe's subject no longer exists. It is worth saying why it went rather than just deleting it:
 * the pointer could not do the one thing this firm does to a team, which is CHANGE ITS LEAD, and it
 * kept no record that the old lead had ever led — so every historical number was quietly computed
 * against today's team.
 *
 * THE ASSERTIONS THAT MATTER MOST ARE THE HISTORICAL ONES. Anyone can make "who is in this team"
 * work. The fixtures below are arranged so that a system which only knows about NOW gets a visibly
 * different answer from one that knows about dates: a member is moved between teams mid-window, and
 * the same question is then asked on both sides of that date. If those two answers ever agree, the
 * dating is decorative.
 *
 * No HTTP. teams.ts and visibility.ts are exercised directly, because they are what every route,
 * report and guard delegates to — proving them here proves the callers by construction, and a probe
 * that needs a running server is one that gets skipped.
 *
 * Own users and teams. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import {
  teamsLedBy, membersOf, teamOf, leadOf, teamViews, addMember, removeMember, setLead,
  personProblem, teamHistory,
} from "../src/teams.js";
import { visibleUserIds, actableTeamIds } from "../src/visibility.js";

const MARK = "ZZ TEAM";
/** Three fixed days, so "as at" has something to actually vary over. */
const D1 = "2026-03-01", D2 = "2026-03-15", D3 = "2026-03-31";

async function sweep() {
  const teams = await prisma.team.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  if (teams.length) {
    const ids = teams.map(t => t.id);
    await prisma.teamMember.deleteMany({ where: { teamId: { in: ids } } });
    await prisma.teamLead.deleteMany({ where: { teamId: { in: ids } } });
    await prisma.team.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({ where: { email: { contains: "zzteam.invalid" } }, select: { id: true } });
  if (users.length) {
    const ids = users.map(u => u.id);
    await prisma.teamMember.deleteMany({ where: { userId: { in: ids } } });
    await prisma.teamLead.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  const yn = (b: boolean) => (b ? "YES" : "NO");
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

  try {
    await sweep();

    const mk = (n: string, role: string, type = "staff", status = "active") =>
      prisma.user.create({ data: { name: `${MARK} ${n}`, email: `zz-${n}@zzteam.invalid`, roleId: role, status, type } });

    const [lead1, lead2, ann, bob, cara, outsider, portal, dormant] = await Promise.all([
      mk("lead1", "pro_officer"), mk("lead2", "pro_officer"),
      mk("ann", "pro_officer"), mk("bob", "pro_officer"), mk("cara", "sales"),
      mk("outsider", "pro_officer"), mk("portal", "client_admin", "portal"), mk("dormant", "pro_officer", "staff", "inactive"),
    ]);

    const teamA = await prisma.team.create({ data: { name: `${MARK} Visas`, kind: "pro", active: true, createdAt: new Date().toISOString() } });
    const teamB = await prisma.team.create({ data: { name: `${MARK} Licences`, kind: "pro", active: true, createdAt: new Date().toISOString() } });
    const teamS = await prisma.team.create({ data: { name: `${MARK} Riyadh Sales`, kind: "sales", active: true, createdAt: new Date().toISOString() } });

    // ── the fixture, with dates that make history observable ──────────────────────────────────────
    // A is deliberately BIGGER than B, so "the caller got team A" cannot be mistaken for "the caller
    // got some team". Ann then MOVES from A to B on D2 — the single fact every historical assertion
    // below turns on.
    await setLead(teamA.id, lead1.id, D1);
    await setLead(teamB.id, lead2.id, D1);
    await addMember(teamA.id, ann.id, D1);
    await addMember(teamA.id, bob.id, D1);
    await addMember(teamB.id, outsider.id, D1);
    await addMember(teamS.id, cara.id, D1);
    await addMember(teamB.id, ann.id, D2);   // Ann moves; joining B must close her A membership

    // ── membership is a fact about a DAY ──────────────────────────────────────────────────────────
    const aOnD1 = await membersOf([teamA.id], D1);
    const aOnD3 = await membersOf([teamA.id], D3);
    console.log(`team A on ${D1} has Ann and Bob:       ${yn(same(aOnD1, [ann.id, bob.id]))}`);
    if (!same(aOnD1, [ann.id, bob.id])) fail("membership on an earlier day is wrong — history is not being read");
    console.log(`  …and on ${D3} only Bob:            ${yn(same(aOnD3, [bob.id]))}`);
    if (!same(aOnD3, [bob.id])) fail("a member who left is still in the team today");
    // If these two ever agree, the dates are decorative and every historical report is today's.
    console.log(`  the two days DIFFER:                 ${yn(!same(aOnD1, aOnD3))}`);
    if (same(aOnD1, aOnD3)) fail("the same answer on both days — dating is not doing anything");

    console.log(`\nAnn's team on ${D1} is A:              ${yn((await teamOf(ann.id, D1)) === teamA.id)}`);
    console.log(`  …and on ${D3} is B:                ${yn((await teamOf(ann.id, D3)) === teamB.id)}`);
    if ((await teamOf(ann.id, D1)) !== teamA.id || (await teamOf(ann.id, D3)) !== teamB.id) fail("a move between teams was not recorded as one");
    // One team per person: joining B must have CLOSED the A row, not left two open.
    const openForAnn = await prisma.teamMember.count({ where: { userId: ann.id, toDay: null } });
    console.log(`  she is in exactly one team now:      ${yn(openForAnn === 1)}`);
    if (openForAnn !== 1) fail(`${openForAnn} open memberships — the same work would count toward two teams`);
    // …and the old row was closed, not deleted: last month still has to be answerable.
    const annRows = await prisma.teamMember.count({ where: { userId: ann.id } });
    console.log(`  the old row was kept, not deleted:   ${yn(annRows === 2)}`);
    if (annRows !== 2) fail("the previous membership was destroyed — the history cannot be reconstructed");

    // ── what a lead may see, on a day ─────────────────────────────────────────────────────────────
    const authLead1 = { sub: lead1.id, role: "pro_officer" };
    const v1 = await visibleUserIds(authLead1, D1);
    const v3 = await visibleUserIds(authLead1, D3);
    console.log(`\nlead1 on ${D1} sees self+Ann+Bob:      ${yn(v1.scope === "team" && same(v1.ids!, [lead1.id, ann.id, bob.id]))}`);
    if (!same(v1.ids ?? [], [lead1.id, ann.id, bob.id])) fail("a lead's view of an earlier day is wrong");
    console.log(`  …and on ${D3} self+Bob only:       ${yn(same(v3.ids ?? [], [lead1.id, bob.id]))}`);
    if (!same(v3.ids ?? [], [lead1.id, bob.id])) fail("a lead still sees somebody who left their team");
    console.log(`  never the other team's outsider:     ${yn(!v1.ids!.includes(outsider.id) && !v3.ids!.includes(outsider.id))}`);
    if (v1.ids!.includes(outsider.id)) fail("a lead can see another team's work");
    console.log(`  the answer says which day it is for: ${yn(v3.on === D3)}`);

    const vPlain = await visibleUserIds({ sub: bob.id, role: "pro_officer" }, D3);
    console.log(`  a non-lead is self-scoped:           ${yn(vPlain.scope === "self" && same(vPlain.ids ?? [], [bob.id]))}`);
    if (vPlain.scope !== "self") fail("somebody who leads nothing was given a team view");
    const vAdmin = await visibleUserIds({ sub: lead1.id, role: "admin" }, D3);
    console.log(`  an admin still sees the firm:        ${yn(vAdmin.ids === null && vAdmin.scope === "firm")}`);
    if (vAdmin.ids !== null) fail("an admin was narrowed to a team");

    // ── THE OPERATION THIS MODEL EXISTS FOR ───────────────────────────────────────────────────────
    // One edit. Lead1 hands team A to lead2 on D3. Nothing about the MEMBERS may change.
    const beforeMembers = await membersOf([teamA.id], D3);
    await setLead(teamA.id, lead2.id, D3);
    const afterMembers = await membersOf([teamA.id], D3);
    console.log(`\nchanging the lead moved no members:     ${yn(same(beforeMembers, afterMembers))}`);
    if (!same(beforeMembers, afterMembers)) fail("swapping a lead disturbed the team's membership");
    console.log(`  the new lead sees the team:          ${yn((await visibleUserIds({ sub: lead2.id, role: "pro_officer" }, D3)).ids!.includes(bob.id))}`);
    if (!(await visibleUserIds({ sub: lead2.id, role: "pro_officer" }, D3)).ids!.includes(bob.id)) fail("the incoming lead cannot see the team they now lead");
    const oldLeadNow = await visibleUserIds(authLead1, D3);
    console.log(`  the old lead no longer does:         ${yn(!oldLeadNow.ids!.includes(bob.id))}`);
    if (oldLeadNow.ids!.includes(bob.id)) fail("the outgoing lead can still see a team that is not theirs");
    // …but yesterday, they still did. This is the entire argument for dated rows.
    const oldLeadThen = await visibleUserIds(authLead1, D2);
    console.log(`  …yet on ${D2} they still did:      ${yn(oldLeadThen.ids!.includes(bob.id))}`);
    if (!oldLeadThen.ids!.includes(bob.id)) fail("history was rewritten — last month's report would credit the wrong lead");
    console.log(`  lead1 led A then, lead2 leads it now:${yn((await leadOf(teamA.id, D2)) === lead1.id && (await leadOf(teamA.id, D3)) === lead2.id)}`);

    // ── a team with nobody leading it must SAY SO ─────────────────────────────────────────────────
    await setLead(teamS.id, dormant.id, D1);
    const views = await teamViews({ on: D3 });
    const sView = views.find(v => v.id === teamS.id)!;
    console.log(`\nan inactive lead is reported, loudly:   ${yn(!!sView.leadProblem)}`);
    if (!sView.leadProblem) fail("a team led by an inactive person looks healthy — indistinguishable from a working team");
    await setLead(teamS.id, null, D3);
    const sNone = (await teamViews({ on: D3 })).find(v => v.id === teamS.id)!;
    console.log(`  so is a team with no lead at all:    ${yn(!!sNone.leadProblem && sNone.leadId === null)}`);
    if (!sNone.leadProblem) fail("a leaderless team is silent — its members lose oversight and nobody is told");
    const caraNow = await visibleUserIds({ sub: cara.id, role: "sales" }, D3);
    console.log(`  its members fall back to self only:  ${yn(caraNow.scope === "self")}`);

    // ── who may be in a team at all ───────────────────────────────────────────────────────────────
    console.log(`\na portal account cannot be a member:     ${yn(!!(await personProblem(portal.id, "member")))}`);
    if (!(await personProblem(portal.id, "member"))) fail("a client portal account can be put in a staff team");
    console.log(`  an inactive person cannot lead:      ${yn(!!(await personProblem(dormant.id, "lead")))}`);
    if (!(await personProblem(dormant.id, "lead"))) fail("an inactive person can be made a team lead");
    console.log(`  an ordinary staff member is fine:    ${yn((await personProblem(bob.id, "member")) === null)}`);
    if ((await personProblem(bob.id, "member")) !== null) fail("a perfectly normal member was refused");

    // ── the teams a caller may act for ────────────────────────────────────────────────────────────
    const actLead2 = await actableTeamIds({ sub: lead2.id, role: "pro_officer" }, D3);
    console.log(`\na lead may act for their teams only:     ${yn(same(actLead2 ?? [], [teamA.id, teamB.id]))}`);
    if (!same(actLead2 ?? [], [teamA.id, teamB.id])) fail("actable teams disagree with what the lead can see");
    console.log(`  an admin may act for all:            ${yn((await actableTeamIds({ sub: lead2.id, role: "admin" })) === null)}`);
    console.log(`  a plain member for none:             ${yn(same((await actableTeamIds({ sub: bob.id, role: "pro_officer" }, D3)) ?? [], []))}`);

    // ── the change trail ──────────────────────────────────────────────────────────────────────────
    const hist = await teamHistory(teamA.id);
    const leadEvents = hist.filter(h => /lead/i.test(h.what)).length;
    console.log(`\nthe lead change is on the record:       ${yn(leadEvents >= 3)}`);
    if (leadEvents < 3) fail("a lead change left no trail — nobody can answer 'when did this change?'");
    console.log(`  newest first:                        ${yn(hist.length > 1 && hist[0].at >= hist[hist.length - 1].at)}`);

    // ── removing somebody ─────────────────────────────────────────────────────────────────────────
    await removeMember(teamA.id, bob.id, D3);
    console.log(`\nremoving closes rather than deletes:    ${yn((await prisma.teamMember.count({ where: { teamId: teamA.id, userId: bob.id } })) === 1)}`);
    console.log(`  he was still there the day before:   ${yn((await membersOf([teamA.id], D2)).includes(bob.id))}`);
    if (!(await membersOf([teamA.id], D2)).includes(bob.id)) fail("removing somebody erased them from the past too");

  } finally {
    await sweep();
  }

  const left = (await prisma.team.count({ where: { name: { startsWith: MARK } } }))
    + (await prisma.user.count({ where: { email: { contains: "zzteam.invalid" } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
