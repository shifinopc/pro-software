/**
 * WHO GETS THIS PIECE OF WORK.
 *
 * The system already had an answer, and it was the same answer everywhere: whoever is carrying the
 * least. That is the right default — it needs no maintenance, it self-corrects after any manual
 * reassignment, and it gives a new joiner their fair share immediately. It is the wrong ONLY answer
 * when the work is not interchangeable, which in this business it very often is not: an officer who
 * files on Qiwa every day is faster on Qiwa, and a rep who knows company formation closes more of it.
 *
 * These rules refine that decision without replacing it:
 *
 *   1. A rule that matches names a person, or names a role to balance within.
 *   2. Nothing matches → the existing load balancer, unchanged.
 *
 * Point 2 is what makes this safe to add to a system already in use. An empty rule list behaves
 * EXACTLY as before. A rule can only redirect work that was going to be handed out anyway; it cannot
 * create an assignment where there would have been none, and it cannot take work off somebody.
 *
 * Every resolution returns WHY. An assignment engine nobody can interrogate is one people stop
 * trusting the first time it surprises them, and "why did this land on me" has to have an answer
 * that is not "read the source".
 */
import { prisma } from "./db.js";

export interface RoutingFacts {
  source?: string | null;
  city?: string | null;
  country?: string | null;
  govCenter?: string | null;
  service?: string | null;
}

export interface Routed {
  userId: string | null;
  /** The role to balance within when the rule named a role rather than a person. */
  role: string | null;
  /** Plain words: which rule fired, or that none did. Shown on the record and in the audit line. */
  why: string;
  ruleId: string | null;
}

/** Case- and space-insensitive, because "Riyadh " and "riyadh" are the same city to everyone but a computer. */
const same = (a: unknown, b: unknown) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * The first active rule for this scope whose every SET condition matches.
 *
 * An unset condition matches anything, so a rule with no conditions is a catch-all. That is a
 * legitimate last row and a trap as a first one — hence `position` being explicit and the reason
 * travelling back with the result.
 */
export async function routeFor(scope: "lead" | "task", facts: RoutingFacts): Promise<Routed> {
  const rules = await prisma.assignmentRule.findMany({
    where: { scope, active: true },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });

  for (const r of rules) {
    const checks: Array<[unknown, unknown]> = [];
    if (r.whenSource) checks.push([r.whenSource, facts.source]);
    if (r.whenCity) checks.push([r.whenCity, facts.city]);
    if (r.whenCountry) checks.push([r.whenCountry, facts.country]);
    if (r.whenGovCenter) checks.push([r.whenGovCenter, facts.govCenter]);
    if (r.whenService) checks.push([r.whenService, facts.service]);
    if (!checks.every(([a, b]) => same(a, b))) continue;

    // Naming a person is the more specific instruction, so it wins when a rule carries both.
    if (r.toUserId) {
      // A rule pointing at somebody who has left would silently assign into a void. Fall through to
      // the next rule instead — the list is ordered by intent, so the next one is the better answer.
      const u = await prisma.user.findFirst({
        where: { id: r.toUserId, status: "active", type: "staff" },
        select: { id: true, name: true },
      });
      if (!u) continue;
      return { userId: u.id, role: null, ruleId: r.id, why: `"${r.label}" → ${u.name}` };
    }
    if (r.toRole) return { userId: null, role: r.toRole, ruleId: r.id, why: `"${r.label}" → the ${r.toRole.replace(/_/g, " ")} team` };
  }

  return { userId: null, role: null, ruleId: null, why: "No routing rule matched — balanced by workload" };
}

/** Convenience for callers that only want a person and do not care to explain it. */
export async function routedUserId(scope: "lead" | "task", facts: RoutingFacts): Promise<string | null> {
  return (await routeFor(scope, facts)).userId;
}
