/**
 * WHOSE WORK MAY THIS PERSON SEE — AND AS AT WHEN.
 *
 * Until teams existed the answer had two values: "your own" (a sales user or a PRO officer) and
 * "everyone" (admin, super_admin). A team lead fitted neither — they were either treated as a
 * junior, blind to the team they run, or promoted to admin and shown the whole firm including what
 * is none of their business. This module is the missing middle rung, and it is the ONE place the
 * question is answered so the sales report, the ops report and the reassignment guard cannot drift
 * into three different opinions of who a team is.
 *
 * THE DATE IS THE POINT. Teams change: people move, leads are swapped. A report about last quarter
 * asked against today's team is quietly wrong, and wrong in the direction nobody checks — it looks
 * like a number. So every answer here is "as at a day", defaulting to today so that a caller which
 * genuinely means "now" reads exactly as it did before teams were dated.
 *
 * ONE LEVEL, DELIBERATELY. A lead may belong to another team, which is how a second tier gets
 * expressed — but visibility resolves the teams you LEAD and their members, and stops. Walking the
 * chain would make somebody's scope depend on how deep their branch happens to be, which nobody can
 * predict from looking at a screen.
 */
import { prisma } from "./db.js";
import { teamsLedBy, membersOf, todayDay } from "./teams.js";

export interface Visibility {
  /** null = the whole firm. Otherwise the exact set of user ids whose work is visible. */
  ids: string[] | null;
  /** For screens: what kind of view this is, in one word. */
  scope: "firm" | "team" | "self";
  /** The day the team was read as at, so a screen can say so rather than implying "now". */
  on: string;
}

export async function visibleUserIds(
  auth: { sub?: string; role?: string } | null | undefined,
  on: string = todayDay(),
): Promise<Visibility> {
  const role = auth?.role;
  const sub = auth?.sub;
  if (role === "super_admin" || role === "admin") return { ids: null, scope: "firm", on };
  if (!sub) return { ids: [], scope: "self", on };

  const led = await teamsLedBy(sub, on);
  if (!led.length) return { ids: [sub], scope: "self", on };

  const members = await membersOf(led, on);
  // `sub` is added and de-duplicated rather than assumed present: a lead need not be a member of the
  // team they lead, and their own work must still be visible to them either way. The set is also
  // filtered to nobody-but-themselves when a team happens to be empty, which degrades to plain
  // self-scope rather than reporting a "team" of one that is really an empty one.
  const ids = [...new Set([sub, ...members])];
  if (ids.length === 1) return { ids, scope: "self", on };
  return { ids, scope: "team", on };
}

/**
 * True when `userId` is inside the caller's visible set. The reassignment guard's whole question.
 * A firm-wide caller may touch anyone; a self-scoped caller only themselves.
 */
export async function canSee(
  auth: { sub?: string; role?: string } | null | undefined,
  userId: string,
  on?: string,
): Promise<boolean> {
  const v = await visibleUserIds(auth, on);
  return v.ids === null || v.ids.includes(userId);
}

/**
 * The teams this person may act for — led teams for a lead, every team for an admin.
 *
 * Kept beside `visibleUserIds` because the two must agree: a screen that offers a team target or an
 * approval for a team the caller cannot see would be offering an action whose result they could not
 * then read.
 */
export async function actableTeamIds(
  auth: { sub?: string; role?: string } | null | undefined,
  on: string = todayDay(),
): Promise<string[] | null> {
  const role = auth?.role;
  if (role === "super_admin" || role === "admin") return null;   // all of them
  if (!auth?.sub) return [];
  return teamsLedBy(auth.sub, on);
}

/** Convenience for the screens: does this person lead anything at all today? */
export async function isTeamLead(userId: string, on?: string): Promise<boolean> {
  return (await teamsLedBy(userId, on)).length > 0;
}

/** Kept so callers that only need the count do not each write their own query. */
export async function teamMemberCount(teamId: string, on: string = todayDay()): Promise<number> {
  return prisma.teamMember.count({
    where: { teamId, fromDay: { lte: on }, OR: [{ toDay: null }, { toDay: { gt: on } }] },
  });
}
