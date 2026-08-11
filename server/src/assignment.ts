/**
 * Who gets the next company nobody has claimed.
 *
 * WHY THIS IS NOT ROUND-ROBIN, EXACTLY
 *
 * A true rotation needs to remember whose turn it is, and that pointer is wrong the moment anything
 * changes: somebody joins and waits a full cycle for their first client; somebody leaves and their
 * slot keeps coming up; a manager reassigns a book of business and the pointer knows nothing about
 * it. The stored turn drifts away from reality and nobody can see that it has.
 *
 * Assigning to whoever currently holds the FEWEST open records needs no memory at all. It reads the
 * truth each time, self-corrects after any reassignment, gives a new joiner their fair share
 * immediately, and — when everybody holds the same number — hands them out one each in turn, which
 * is the behaviour people mean when they ask for round-robin.
 *
 * WHAT IT WILL NOT DO
 *
 * It never moves a record away from somebody. It only ever fills an empty owner. And with nobody to
 * assign to it leaves the record unowned rather than dropping clients on an administrator who does
 * not sell — an unowned client is a visible problem, whereas one filed under the wrong person looks
 * handled and is not.
 */
import { prisma } from "./db.js";

/** Only these carry a book of business. A `sales` user is the one the scoping is built around. */
const SELLING_ROLES = ["sales"];

/**
 * Record who a company was handed to, and why. Append-only, like the stage and lifecycle tables.
 *
 * EVERY path that writes `Company.ownerId` calls this — the create route's auto-assign, the details
 * form, the bulk distribute, and the web intake's routing. Ownership decides what a sales user can
 * SEE, so an unexplained change is the one people escalate about; recording only the current holder
 * made an automatic routing decision indistinguishable from a manager's deliberate one.
 *
 * A no-op is skipped rather than written: saving the details form without touching the owner should
 * not produce a history row claiming a reassignment happened.
 */
export async function recordAssignment(db: any, args: {
  companyId: string;
  from?: string | null;
  to?: string | null;
  assignedById?: string | null;
  method: "auto" | "manual" | "distribute" | "intake";
  reason?: string | null;
  at?: string;
}) {
  const from = args.from ?? null;
  const to = args.to ?? null;
  if (from === to) return null;
  return db.ownerAssignment.create({
    data: {
      companyId: args.companyId,
      fromOwnerId: from,
      toOwnerId: to,
      assignedById: args.assignedById ?? null,
      method: args.method,
      reason: args.reason ?? null,
      at: args.at ?? new Date().toISOString(),
    },
  });
}

/** How a company came to its current owner, newest first, with names resolved. */
export async function assignmentHistory(companyId: string) {
  const rows = await prisma.ownerAssignment.findMany({
    where: { companyId },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: 50,
  });
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap(r => [r.fromOwnerId, r.toOwnerId, r.assignedById]).filter(Boolean) as string[])];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
    : [];
  // A person who has since left still has to be nameable — the row is about what happened, and
  // "assigned to (deleted)" tells a reader nothing about why the lead arrived on their desk.
  const nameOf = (id: string | null) => (id ? (users.find(u => u.id === id)?.name ?? "Somebody who has left") : null);
  const METHOD: Record<string, string> = {
    auto: "Automatic assignment", manual: "By hand", distribute: "Bulk distribution", intake: "Web enquiry routing",
  };
  return rows.map(r => ({
    id: r.id,
    at: r.at,
    from: nameOf(r.fromOwnerId),
    to: nameOf(r.toOwnerId),
    by: nameOf(r.assignedById),
    method: r.method,
    methodLabel: METHOD[r.method] ?? r.method,
    reason: r.reason,
  }));
}

/**
 * Who may be given a client BY HAND — a wider set than the rotation picks from, deliberately.
 *
 * The rotation only ever hands work to a `sales` user, because dropping clients on an administrator
 * who does not sell is worse than leaving them unowned. But a person choosing an owner is making a
 * decision, not accepting a default, and in a firm this size the admins genuinely do carry accounts.
 *
 * What is NOT here is the point: an accountant or a PRO officer cannot be an account manager. The
 * console offered every active member of staff, which contradicted this file — a lead parked on the
 * accountant looked owned, sat in no salesperson's book, and sent its chasing to somebody who was
 * never going to make the call. One list, served from here, so the two cannot disagree again.
 */
export const OWNER_ROLES = [...SELLING_ROLES, "admin", "super_admin"];

/**
 * The people a client may be assigned to, with their current load.
 *
 * `alsoInclude` keeps somebody visible who is already on a record but no longer eligible — a
 * salesperson moved to accounts, say. Dropping them from the list would make their name vanish from
 * the picker while still being the stored owner, and the next person to open that record would
 * "fix" it by accident.
 *
 * `includeIneligible` returns every active member of staff instead, each still carrying its honest
 * `eligible` flag. That is for a SEARCHABLE picker, which needs a different shape of answer from a
 * short list: the restricted list is the right default precisely because it is the whole list — but
 * once somebody is typing a name, a picker that silently has no answer for "Omar" is worse than one
 * that finds him and says he is not normally assignable. The rule above is unchanged and still the
 * one auto-assignment follows; this only stops the search pretending those people do not exist.
 *
 * The flag is opt-in so the default answer, and every existing caller, stays exactly as it was.
 */
export async function assignableOwners(
  alsoInclude?: string | null,
  includeIneligible = false,
): Promise<Array<{ id: string; name: string; roleId: string; load: number; eligible: boolean }>> {
  const users = await prisma.user.findMany({
    where: {
      type: "staff",
      status: "active",
      // Widened, not replaced: `eligible` below still answers "may this person carry a book",
      // so the caller can group them rather than being handed one undifferentiated list.
      ...(includeIneligible
        ? {}
        : { OR: [{ roleId: { in: OWNER_ROLES } }, ...(alsoInclude ? [{ id: alsoInclude }] : [])] }),
    },
    select: { id: true, name: true, roleId: true },
    orderBy: { name: "asc" },
  });
  const counts = await prisma.company.groupBy({
    by: ["ownerId"],
    where: { ownerId: { in: users.map(u => u.id) }, lifecycle: { notIn: ["lost", "churned"] } },
    _count: { _all: true },
  });
  const load = new Map(counts.map(c => [c.ownerId as string, c._count._all]));
  return users.map(u => ({ ...u, load: load.get(u.id) ?? 0, eligible: OWNER_ROLES.includes(u.roleId) }));
}

export interface Candidate { id: string; name: string; load: number }

/**
 * The people in the rotation, with what each is already carrying, lightest first.
 *
 * "Load" counts companies that are still live work — a lost company is not a burden, and counting it
 * would permanently penalise whoever handled it.
 */
export async function rotation(): Promise<Candidate[]> {
  const users = await prisma.user.findMany({
    where: { type: "staff", status: "active", roleId: { in: SELLING_ROLES } },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  if (!users.length) return [];

  const counts = await prisma.company.groupBy({
    by: ["ownerId"],
    where: { ownerId: { in: users.map(u => u.id) }, lifecycle: { notIn: ["lost", "churned"] } },
    _count: { _all: true },
  });
  const load = new Map(counts.map(c => [c.ownerId as string, c._count._all]));

  // Lightest first; ties broken by user id so the order is deterministic and a test can assert it.
  return users
    .map(u => ({ id: u.id, name: u.name, load: load.get(u.id) ?? 0 }))
    .sort((a, b) => a.load - b.load || a.id.localeCompare(b.id));
}

/** Whoever should take the next one, or null when there is nobody to give it to. */
export async function nextOwner(): Promise<Candidate | null> {
  const r = await rotation();
  return r[0] ?? null;
}

/**
 * The same question, asked with the lead's own facts in hand.
 *
 * Load balancing is right when the work is interchangeable, and leads are not: where a lead came
 * from and where it is say a lot about who should call it. A routing rule gets first refusal; with
 * no rule, or no rule that matches, this is `nextOwner()` exactly — so an empty rule list leaves the
 * behaviour it had before rules existed.
 *
 * `why` travels back so the record can say how it was decided. "Assigned by workload" and "assigned
 * because it came from the website" are different facts about a lead, and only one of them is worth
 * arguing with.
 */
export async function nextOwnerFor(facts: { source?: string | null; city?: string | null; country?: string | null; service?: string | null }):
  Promise<{ owner: Candidate | null; why: string }> {
  const { routeFor } = await import("./routing.js");
  const routed = await routeFor("lead", facts);

  if (routed.userId) {
    const u = await prisma.user.findUnique({ where: { id: routed.userId }, select: { id: true, name: true } });
    if (u) return { owner: { id: u.id, name: u.name, load: 0 }, why: routed.why };
  }
  if (routed.role) {
    // A rule naming a role narrows the pool; the lightest inside it still wins, so the two ideas
    // compose rather than one cancelling the other.
    const pool = await prisma.user.findMany({
      where: { type: "staff", status: "active", roleId: routed.role },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    if (pool.length) {
      const counts = await prisma.company.groupBy({
        by: ["ownerId"],
        where: { ownerId: { in: pool.map(p => p.id) }, lifecycle: { notIn: ["lost", "churned"] } },
        _count: { _all: true },
      });
      const load = new Map(counts.map(c => [c.ownerId as string, c._count._all]));
      const best = pool
        .map(p => ({ id: p.id, name: p.name, load: load.get(p.id) ?? 0 }))
        .sort((a, b) => a.load - b.load || a.id.localeCompare(b.id))[0];
      return { owner: best, why: routed.why };
    }
  }
  return { owner: await nextOwner(), why: routed.why };
}

/**
 * Hand out the companies that are already sitting unowned.
 *
 * `apply: false` previews. Handing somebody a book of business is a decision, so the caller presses
 * a button for it — nothing here runs on a timer.
 */
export async function distributeUnowned(opts: { apply?: boolean; actor?: string | null } = {}) {
  const people = await rotation();
  const unowned = await prisma.company.findMany({
    where: { ownerId: null, lifecycle: { notIn: ["lost", "churned"] } },
    select: { id: true, name: true, lifecycle: true },
    orderBy: { name: "asc" },
  });

  if (!people.length) {
    return {
      applied: false, assigned: [] as Array<{ company: string; to: string }>,
      unowned: unowned.length,
      reason: "Nobody has the sales role, so there is no one to assign these to. Give somebody that role first — filing them under an administrator who does not sell would look handled without being handled.",
    };
  }

  // Simulate the load as we go, so one run spreads them rather than giving every single record to
  // whoever happened to be lightest when the run started.
  const live = people.map(p => ({ ...p }));
  const assigned: Array<{ company: string; to: string }> = [];
  for (const co of unowned) {
    live.sort((a, b) => a.load - b.load || a.id.localeCompare(b.id));
    const who = live[0];
    assigned.push({ company: co.name, to: who.name });
    who.load++;
    if (opts.apply) {
      await prisma.company.update({ where: { id: co.id }, data: { ownerId: who.id } });
      // Says WHY this person: the load that won it, at the moment it was decided. Without that a
      // bulk run looks arbitrary to everybody who receives one.
      await recordAssignment(prisma, {
        companyId: co.id, from: null, to: who.id, assignedById: opts.actor ?? null,
        method: "distribute", reason: `Lightest book at the time (${who.load - 1} before this)`,
      });
    }
  }
  return { applied: !!opts.apply, assigned, unowned: unowned.length, reason: null as string | null };
}
