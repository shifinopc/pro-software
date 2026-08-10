/**
 * TEAMS, AS THEY STOOD ON A GIVEN DAY.
 *
 * Every question here takes a date, because that is the whole reason teams are stored as dated rows
 * rather than as a pointer on each person: "who is in the sales team" and "who was in the sales team
 * in September" are different questions, and a system that can only answer the first will answer the
 * second wrongly and confidently.
 *
 * The date defaults to today everywhere, so a caller that does not care about history — which is
 * most of them — reads exactly as if this were a plain membership table.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT. This module answers questions and applies the rules for
 * changing a team. It deliberately holds no opinion about what a lead may DO with the answer —
 * that belongs to visibility.ts (what may they see) and to the individual guards (what may they
 * move, approve, or set a target on). One place per question.
 */
import { prisma } from "./db.js";

export type TeamKind = "sales" | "pro";
export const TEAM_KINDS: TeamKind[] = ["sales", "pro"];

export const todayDay = () => new Date().toISOString().slice(0, 10);
/** A stored value may be a bare day or a full instant; both compare correctly once cut to 10. */
export const dayOf = (v: unknown) => String(v ?? "").slice(0, 10);

/**
 * The row filter for "live on this day".
 *
 * `fromDay <= on` and (`toDay` is null or `toDay > on`). The end is EXCLUSIVE: somebody who left on
 * the 5th was a member for the whole of the 4th and none of the 5th. Making it inclusive would put
 * a leaver and their replacement in the team on the same day, and every headcount that crossed a
 * handover would read one too many.
 */
const liveOn = (on: string) => ({
  fromDay: { lte: on },
  OR: [{ toDay: null }, { toDay: { gt: on } }],
});

/** The teams this person led on that day. Usually none or one; more than one is allowed. */
export async function teamsLedBy(userId: string, on = todayDay()): Promise<string[]> {
  if (!userId) return [];
  const rows = await prisma.teamLead.findMany({
    where: { userId, ...liveOn(on) },
    select: { teamId: true },
  });
  return [...new Set(rows.map(r => r.teamId))];
}

/** The user ids in these teams on that day. */
export async function membersOf(teamIds: string[], on = todayDay()): Promise<string[]> {
  if (!teamIds.length) return [];
  const rows = await prisma.teamMember.findMany({
    where: { teamId: { in: teamIds }, ...liveOn(on) },
    select: { userId: true },
  });
  return [...new Set(rows.map(r => r.userId))];
}

/** The team this person belonged to on that day, or null. One team per person — see `addMember`. */
export async function teamOf(userId: string, on = todayDay()): Promise<string | null> {
  if (!userId) return null;
  const row = await prisma.teamMember.findFirst({
    where: { userId, ...liveOn(on) },
    select: { teamId: true },
  });
  return row?.teamId ?? null;
}

/** Who led this team on that day, or null — a team with no lead is a real and visible state. */
export async function leadOf(teamId: string, on = todayDay()): Promise<string | null> {
  const row = await prisma.teamLead.findFirst({ where: { teamId, ...liveOn(on) }, select: { userId: true } });
  return row?.userId ?? null;
}

export interface TeamView {
  id: string; name: string; kind: string; country: string | null; active: boolean;
  leadId: string | null; leadName: string | null;
  /** Loud on purpose — see `leadProblem`. */
  leadProblem: string | null;
  memberIds: string[];
  members: { id: string; name: string; roleId: string; status: string }[];
}

/**
 * Teams with their lead and members resolved for a day, ready for a screen.
 *
 * A LEADERLESS OR INACTIVE-LED TEAM IS REPORTED, NOT HIDDEN. When a lead leaves, everyone in their
 * team silently drops back to seeing only their own work — the system keeps running and nobody is
 * told that a team stopped being overseen. That is the failure this field exists to make visible.
 */
export async function teamViews(opts: { kind?: string; on?: string; includeInactive?: boolean } = {}): Promise<TeamView[]> {
  const on = opts.on ?? todayDay();
  const teams = await prisma.team.findMany({
    where: { ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.includeInactive ? {} : { active: true }) },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
  if (!teams.length) return [];
  const ids = teams.map(t => t.id);
  const [leadRows, memberRows] = await Promise.all([
    prisma.teamLead.findMany({ where: { teamId: { in: ids }, ...liveOn(on) } }),
    prisma.teamMember.findMany({ where: { teamId: { in: ids }, ...liveOn(on) } }),
  ]);
  const userIds = [...new Set([...leadRows.map(r => r.userId), ...memberRows.map(r => r.userId)])];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, roleId: true, status: true, type: true } })
    : [];
  const byId = new Map(users.map(u => [u.id, u]));

  return teams.map(t => {
    const leadId = leadRows.find(r => r.teamId === t.id)?.userId ?? null;
    const lead = leadId ? byId.get(leadId) : null;
    const mem = memberRows.filter(r => r.teamId === t.id).map(r => byId.get(r.userId)).filter(Boolean) as typeof users;
    return {
      id: t.id, name: t.name, kind: t.kind, country: t.country, active: t.active,
      leadId, leadName: lead?.name ?? null,
      leadProblem: !leadId
        ? "This team has no lead — nobody can see its work as a team."
        : lead && lead.status !== "active"
          ? `${lead.name} is ${lead.status}, so this team is effectively unled.`
          : null,
      memberIds: mem.map(u => u.id),
      members: mem.map(u => ({ id: u.id, name: u.name, roleId: u.roleId, status: u.status })),
    };
  });
}

/**
 * The rules that used to live in the /api/users managerId middleware, carried over intact.
 *
 * They were never about that column: a client portal account cannot be in a team or lead one
 * ("this client reports to a PRO officer" is a sentence that means nothing), and an inactive person
 * cannot lead one. Returns a plain sentence, or null when the person is allowed.
 */
export async function personProblem(userId: string, as: "member" | "lead"): Promise<string | null> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, type: true, status: true } });
  if (!u) return "That person no longer exists.";
  if (u.type !== "staff") return "A client portal account is not part of a team.";
  if (as === "lead" && u.status !== "active") return `${u.name} is not active, so they cannot lead a team.`;
  return null;
}

/**
 * Put somebody in a team from `on`.
 *
 * ONE TEAM PER PERSON: joining closes any membership they already had. Two live memberships would
 * make "whose numbers are these" unanswerable — the same closed deal would count toward two teams.
 * The old row is CLOSED, never deleted, so last month still knows where they were.
 */
export async function addMember(teamId: string, userId: string, on = todayDay()) {
  const already = await prisma.teamMember.findFirst({ where: { userId, ...liveOn(on) } });
  if (already?.teamId === teamId) return already;
  if (already) await prisma.teamMember.update({ where: { id: already.id }, data: { toDay: on } });
  return prisma.teamMember.create({ data: { teamId, userId, fromDay: on, toDay: null } });
}

/** Take somebody out of a team from `on`. Closes the row; never deletes it. */
export async function removeMember(teamId: string, userId: string, on = todayDay()) {
  const row = await prisma.teamMember.findFirst({ where: { teamId, userId, ...liveOn(on) } });
  if (!row) return null;
  return prisma.teamMember.update({ where: { id: row.id }, data: { toDay: on } });
}

/**
 * Change who leads a team, from `on`.
 *
 * THE OPERATION THIS WHOLE MODEL EXISTS FOR — one edit, whoever the members are. It moves no work:
 * a lead oversees rather than carries, so no client, deal or task changes hands. Passing null
 * leaves the team deliberately unled, which `teamViews` then says out loud.
 */
export async function setLead(teamId: string, userId: string | null, on = todayDay()) {
  const current = await prisma.teamLead.findFirst({ where: { teamId, ...liveOn(on) } });
  if (current?.userId === userId) return current;
  if (current) await prisma.teamLead.update({ where: { id: current.id }, data: { toDay: on } });
  if (!userId) return null;
  return prisma.teamLead.create({ data: { teamId, userId, fromDay: on, toDay: null } });
}

/** Every membership and lead change on a team, newest first — the answer to "when did this change?" */
export async function teamHistory(teamId: string) {
  const [members, leads] = await Promise.all([
    prisma.teamMember.findMany({ where: { teamId } }),
    prisma.teamLead.findMany({ where: { teamId } }),
  ]);
  const ids = [...new Set([...members, ...leads].map(r => r.userId))];
  const users = ids.length ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const name = (id: string) => users.find(u => u.id === id)?.name ?? "someone who no longer exists";

  const events = [
    ...members.flatMap(r => [
      { at: r.fromDay, what: `${name(r.userId)} joined` },
      ...(r.toDay ? [{ at: r.toDay, what: `${name(r.userId)} left` }] : []),
    ]),
    ...leads.flatMap(r => [
      { at: r.fromDay, what: `${name(r.userId)} became lead` },
      ...(r.toDay ? [{ at: r.toDay, what: `${name(r.userId)} stopped leading` }] : []),
    ]),
  ];
  return events.sort((a, b) => b.at.localeCompare(a.at));
}
