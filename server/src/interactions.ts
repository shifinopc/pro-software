/**
 * The contact log, and the queue of what it has promised.
 *
 * A follow-up is not a separate kind of record here. It is an interaction that named a next action
 * and a date and has not been ticked off — `openFollowUps` is that sentence turned into a query, and
 * it is the ONLY definition. Nothing stores "this company has a follow-up due"; the moment such a
 * flag existed it would need a second write on every close, and the first one missed would leave a
 * client being chased for a call somebody already made.
 *
 * WHY "DUE" IS COMPUTED FROM A DATE STRING
 *
 * Dates in this schema are ISO strings, and follow-ups are set on a DAY ("call them Sunday"), not an
 * instant. Comparing the day part avoids a follow-up set for today reading as overdue because it was
 * stored at 09:00 and it is now 14:00 — which would make "overdue" mean nothing by lunchtime.
 */
import { prisma } from "./db.js";

export const KINDS = ["call", "meeting", "email", "whatsapp", "note", "site_visit"] as const;
export type InteractionKind = (typeof KINDS)[number];

export const KIND_LABEL: Record<string, string> = {
  call: "Call", meeting: "Meeting", email: "Email",
  whatsapp: "WhatsApp", note: "Note", site_visit: "Site visit",
};

/** The day part of an ISO string, which is the granularity a follow-up is actually set at. */
export const dayOf = (iso: string | null | undefined) => String(iso ?? "").slice(0, 10);
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Everything still owed.
 *
 * `on` defaults to today, so the queue answers "what do I owe someone by the end of today" — which
 * includes everything overdue, because a call missed on Thursday is not less owed on Friday.
 */
export async function openFollowUps(opts: { on?: string; ownerId?: string | null; companyIds?: string[] | null } = {}) {
  const on = opts.on ?? today();
  // `nextActionAt` holds either a bare day ("2026-08-05") or a full ISO instant, depending on where
  // it was written. The high sentinel makes the string comparison catch both for the same day —
  // without it, a follow-up saved with a time component would be missed on the day it is due and
  // only appear the morning after, which is precisely when it is too late to be useful.
  // Cancelled is excluded alongside done: an abandoned commitment is not owed, and leaving it in
  // the queue would be the whole reason people were closing them as "done" instead.
  const where: any = { nextActionAt: { not: null, lte: on + "￿" }, nextActionDoneAt: null, cancelledAt: null };
  if (opts.ownerId) where.ownerId = opts.ownerId;
  if (opts.companyIds) where.companyId = { in: opts.companyIds };

  const rows = await prisma.interaction.findMany({
    where,
    include: {
      company: { select: { id: true, name: true, lifecycle: true } },
      opportunity: { include: { stage: true } },
    },
    orderBy: [{ nextActionAt: "asc" }],
    take: 500,
  });

  // A commitment to a company nobody is pursuing any more is not work. Filtered here rather than in
  // the query so the reason is readable: `lost` companies and closed deals are done with.
  return rows
    .filter(r => r.company.lifecycle !== "lost")
    .filter(r => !r.opportunity || !(r.opportunity.stage.isWon || r.opportunity.stage.isLost))
    .map(r => ({
      ...r,
      overdue: dayOf(r.nextActionAt) < on,
      /** Whole days late, so a screen can say "3 days" rather than making the reader subtract. */
      daysLate: Math.max(0, Math.round((Date.parse(on) - Date.parse(dayOf(r.nextActionAt))) / 86400000)),
      /**
       * How long this has been owed IN TOTAL — measured from what it was FIRST due, not from the
       * date it currently wears. A commitment pushed three times reads as "due today" without this,
       * which is exactly the appearance snoozing would otherwise buy.
       */
      owedDays: Math.max(0, Math.round((Date.parse(on) - Date.parse(dayOf(r.snoozedFrom ?? r.nextActionAt))) / 86400000)),
    }));
}

/**
 * EVERYTHING THAT HAPPENED, across every client — the Activities screen.
 *
 * `historyFor` answers "what has been said to THIS company". This answers "what has the team been
 * doing", which is the question a sales manager actually opens a CRM with, and which previously
 * could only be answered by opening every client in turn.
 *
 * WHAT IT IS NOT. This is the log of things people DID — calls made, meetings held, notes written.
 * It deliberately excludes what is still OWED: that is the Follow-ups queue, which is a different
 * question with a different urgency, and folding the two together would make a screen where a call
 * you have already made sits beside one you have not, distinguishable only by a date.
 *
 * It also excludes the system `Activity` table ("deal moved", "team created"). That is the audit of
 * what the SOFTWARE did; this is the record of what PEOPLE did with clients, and mixing them buries
 * the second in the first.
 */
export async function activityFeed(opts: {
  companyIds?: string[] | null;
  ownerId?: string | null;
  /** Restrict to these kinds; empty or absent means all of them. */
  kinds?: string[] | null;
  /** Only interactions on or after this ISO day. */
  since?: string | null;
  /**
   * Include the entries a STAGE RULE wrote ("Moved to Quoted") as well as the ones people wrote.
   *
   * Off by default, and that default is the whole point of the screen. On real data the rule-written
   * notes outnumbered the human ones two to one, so "what has the team been doing" opened on a wall
   * of machine output. They are not hidden — the chip turns them on and each is badged — but they do
   * not get to be the answer to a question about people.
   */
  includeAuto?: boolean;
  limit?: number;
} = {}) {
  const where: any = {};
  if (opts.companyIds) where.companyId = { in: opts.companyIds };
  if (opts.ownerId) where.ownerId = opts.ownerId;
  if (!opts.includeAuto) where.auto = false;
  const kinds = (opts.kinds ?? []).filter(k => (KINDS as readonly string[]).includes(k));
  if (kinds.length) where.kind = { in: kinds };
  // The high sentinel is not needed here — `since` is a floor, and a bare day sorts below any
  // instant on that day, which is exactly the inclusive behaviour wanted.
  if (opts.since) where.at = { gte: opts.since };

  const rows = await prisma.interaction.findMany({
    where,
    include: {
      company: { select: { id: true, name: true, lifecycle: true } },
      opportunity: { select: { id: true, title: true } },
    },
    // By `at` — when it HAPPENED — not by when it was typed. Somebody logging Thursday's call on
    // Monday belongs in Thursday, or the screen reports typing rather than selling.
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(500, opts.limit ?? 200)),
  });

  // Contact names in one lookup. `Interaction.contactId` has no relation defined, so this cannot be
  // an include — and doing it per row would be a query per activity.
  const contactIds = [...new Set(rows.map(r => r.contactId).filter(Boolean) as string[])];
  const contacts = contactIds.length
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, name: true, jobTitle: true } })
    : [];
  const contactById = new Map(contacts.map(c => [c.id, c]));

  const ownerIds = [...new Set(rows.map(r => r.ownerId).filter(Boolean) as string[])];
  const owners = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } })
    : [];
  const ownerById = new Map(owners.map(u => [u.id, u.name]));

  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    kindLabel: KIND_LABEL[r.kind] ?? r.kind,
    at: r.at,
    day: dayOf(r.at),
    /**
     * Whether `at` carries a clock time somebody actually chose.
     *
     * Three shapes are in this column: a bare day, a full instant, and — most of them — a day the
     * user picked that was normalised to MIDNIGHT UTC on write. That third shape is the trap: it
     * contains "00:00", so a naive check for a time finds one, and the screen renders it in local
     * time as "05:30". A precise-looking figure for something nobody entered is worse than no
     * figure, so exact midnight UTC is treated as "no time recorded".
     *
     * The cost of the heuristic is a genuine midnight call losing its timestamp. Against that: the
     * odds of logging one at 00:00:00.000 UTC exactly are negligible, and every date-picked entry
     * in this database currently lands there.
     */
    hasTime: /\d{2}:\d{2}/.test(String(r.at ?? "")) && !/T00:00:00(\.000)?Z?$/.test(String(r.at ?? "")),
    summary: r.summary,
    outcome: r.outcome,
    company: { id: r.company.id, name: r.company.name, lifecycle: r.company.lifecycle },
    deal: r.opportunity ? { id: r.opportunity.id, title: r.opportunity.title } : null,
    contact: r.contactId ? (contactById.get(r.contactId) ?? null) : null,
    /** Who logged it. Named rather than an id, because nobody recognises a cuid. */
    owner: r.ownerId ? (ownerById.get(r.ownerId) ?? "Somebody who has left") : null,
    /** True when a stage rule wrote this rather than a person. Shown, so the log is not misread as effort. */
    auto: r.auto,
  }));
}

/** How many of each kind in the same window, for filter chips that can show their own counts. */
export async function activityCounts(opts: { companyIds?: string[] | null; ownerId?: string | null; since?: string | null; includeAuto?: boolean } = {}) {
  const where: any = {};
  if (opts.companyIds) where.companyId = { in: opts.companyIds };
  if (opts.ownerId) where.ownerId = opts.ownerId;
  // Must match the feed's own filter, or the chips promise rows the list will not show.
  if (!opts.includeAuto) where.auto = false;
  if (opts.since) where.at = { gte: opts.since };
  const rows = await prisma.interaction.groupBy({ by: ["kind"], where, _count: { _all: true } });
  const got = new Map(rows.map(r => [r.kind, r._count._all]));
  // Every kind is returned, including the zeroes: a chip that vanishes when nothing matched makes
  // the filter bar change shape as you use it, and hides that the kind exists at all.
  return KINDS.map(k => ({ kind: k, label: KIND_LABEL[k], count: got.get(k) ?? 0 }));
}

/**
 * WHAT HAPPENED TO THE COMMITMENTS THAT CAME DUE — the follow-up completion report.
 *
 * MEASURED FROM THE ORIGINAL DUE DATE, not the one a row currently wears. This is the whole design:
 * measured from the current date, anybody could push a commitment out of the period and remove it
 * from their own denominator, and the number would rise as the work got worse. `snoozedFrom` keeps
 * the promise where it was made.
 *
 * CANCELLED IS REPORTED SEPARATELY AND NEVER AS SUCCESS. It stays in the denominator: dropping a
 * commitment is a legitimate act, but it is not doing it, and a rate that improved when somebody
 * abandoned their queue would be worse than no rate at all.
 *
 * ON TIME is the figure worth reading. A commitment completed three weeks late was still completed,
 * so it counts in `completed` — and the gap between the two rates is where the real story is.
 */
export async function followUpCompletion(opts: {
  from: string; to: string;
  companyIds?: string[] | null;
  ownerIds?: string[] | null;
  ownerId?: string | null;
} ) {
  const where: any = { nextActionAt: { not: null } };
  if (opts.companyIds) where.companyId = { in: opts.companyIds };
  if (opts.ownerId) where.ownerId = opts.ownerId;
  else if (opts.ownerIds) where.ownerId = { in: opts.ownerIds };

  // Everything with a follow-up at all; the period filter is applied below against the ORIGINAL
  // date, which is a computed value and cannot be expressed in the query.
  const rows = await prisma.interaction.findMany({
    where,
    select: {
      id: true, ownerId: true, nextActionAt: true, nextActionDoneAt: true,
      cancelledAt: true, snoozedFrom: true, snoozeCount: true,
    },
    take: 20000,
  });

  const fromDay = dayOf(opts.from), toDay = dayOf(opts.to);
  const due = rows.filter(r => {
    const origin = dayOf(r.snoozedFrom ?? r.nextActionAt);
    return origin >= fromDay && origin <= toDay;
  });

  const tally = (set: typeof due) => {
    const completed = set.filter(r => r.nextActionDoneAt);
    const onTime = completed.filter(r => dayOf(r.nextActionDoneAt) <= dayOf(r.snoozedFrom ?? r.nextActionAt));
    const cancelled = set.filter(r => !r.nextActionDoneAt && r.cancelledAt);
    const open = set.filter(r => !r.nextActionDoneAt && !r.cancelledAt);
    const n = set.length;
    return {
      due: n,
      completed: completed.length,
      completedOnTime: onTime.length,
      cancelled: cancelled.length,
      open: open.length,
      /** How many were pushed at least once — the effort the two rates above cannot show. */
      rescheduled: set.filter(r => (r.snoozeCount ?? 0) > 0).length,
      // Null, not zero, when nothing came due: a person with no commitments has no completion rate,
      // and rendering that as 0% would put them bottom of a table they do not belong in.
      rateBp: n ? Math.round((completed.length * 10000) / n) : null,
      onTimeBp: n ? Math.round((onTime.length * 10000) / n) : null,
    };
  };

  const byOwner = new Map<string, typeof due>();
  for (const r of due) {
    const k = r.ownerId ?? "";
    byOwner.set(k, [...(byOwner.get(k) ?? []), r]);
  }
  const ownerIds = [...byOwner.keys()].filter(Boolean);
  const users = ownerIds.length
    ? await prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map(u => [u.id, u.name]));

  return {
    total: tally(due),
    people: [...byOwner.entries()]
      .map(([id, set]) => ({ id, name: id ? (nameOf.get(id) ?? "Somebody who has left") : "Unassigned", ...tally(set) }))
      // Worst on-time first — the point of a per-person table is finding who needs help, not
      // crowning who is ahead.
      .sort((a, b) => (a.onTimeBp ?? 10001) - (b.onTimeBp ?? 10001) || b.due - a.due),
  };
}

/** Everything said, most recent first — the client's own timeline. */
export async function historyFor(companyId: string, limit = 100) {
  return prisma.interaction.findMany({
    where: { companyId },
    include: { opportunity: { select: { id: true, title: true } } },
    orderBy: [{ at: "desc" }],
    take: limit,
  });
}

/**
 * When each company was last spoken to.
 *
 * Returned as a map rather than a column on Company: the answer changes every time anybody logs
 * anything, and a stored "lastContactedAt" is the same copy-that-needs-a-second-write as the
 * follow-up flag this module refuses to keep.
 */
export async function lastContactMap(companyIds: string[]) {
  if (!companyIds.length) return {} as Record<string, string>;
  const rows = await prisma.interaction.groupBy({
    by: ["companyId"],
    where: { companyId: { in: companyIds } },
    _max: { at: true },
  });
  return Object.fromEntries(rows.map(r => [r.companyId, r._max.at ?? ""])) as Record<string, string>;
}

/** Log something that happened. */
export async function logInteraction(data: {
  companyId: string; contactId?: string | null; opportunityId?: string | null;
  kind?: string; at?: string | null; summary?: string | null; outcome?: string | null;
  nextAction?: string | null; nextActionAt?: string | null; ownerId?: string | null;
}) {
  const kind = KINDS.includes(String(data.kind) as InteractionKind) ? String(data.kind) : "call";
  // A next action with no date would sit in no queue and be read by nobody; a date with no action
  // says "do something on Tuesday" and does not say what. Either both or neither.
  const hasAction = !!String(data.nextAction ?? "").trim();
  const hasDate = !!String(data.nextActionAt ?? "").trim();
  if (hasAction !== hasDate) {
    throw new Error(hasAction
      ? "Give the next step a date, or it sits in no queue and nobody sees it."
      : "Say what the next step is — a date on its own does not tell anyone what to do.");
  }

  return prisma.interaction.create({
    data: {
      companyId: data.companyId,
      contactId: data.contactId || null,
      opportunityId: data.opportunityId || null,
      kind,
      at: data.at || new Date().toISOString(),
      summary: data.summary || null,
      outcome: data.outcome || null,
      nextAction: hasAction ? String(data.nextAction).trim() : null,
      nextActionAt: hasDate ? String(data.nextActionAt).trim() : null,
      ownerId: data.ownerId || null,
      createdAt: new Date().toISOString(),
    },
  });
}

/** Tick a follow-up off. Idempotent: closing an already-closed one keeps the original timestamp. */
/**
 * Move a commitment to a new date, and leave the move visible.
 *
 * REFUSES TO MOVE A DATE BACKWARDS OR NOWHERE. A snooze is a postponement; setting a date at or
 * before the current one is either a typo or an attempt to make something look less late than it is,
 * and both are better answered than stored. Editing the log entry is the way to correct a genuine
 * mistake — that is a different act and reads as one.
 *
 * The FIRST snooze records what the commitment was originally due, so a follow-up pushed four times
 * still says when it was actually promised rather than reporting whichever date it currently wears.
 */
export async function rescheduleFollowUp(id: string, opts: { to: string; reason?: string | null; on?: string }) {
  const row = await prisma.interaction.findUnique({ where: { id } });
  if (!row) throw new Error("No such entry");
  if (!row.nextActionAt) throw new Error("That entry has no follow-up to move");
  if (row.nextActionDoneAt) throw new Error("That follow-up is already done — log a new one instead");

  const to = dayOf(opts.to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error("Give the new date as a day");
  const from = dayOf(row.nextActionAt);
  if (to <= from) throw new Error(`It is already due ${from} — a snooze has to move it forward`);
  // Not in the past either, even if that is still forward of an old due date: a follow-up snoozed
  // into last week is due the moment it is saved, which is not what anybody pressing snooze means.
  const on = opts.on ?? today();
  if (to < on) throw new Error("That date has already passed");

  return prisma.interaction.update({
    where: { id },
    data: {
      nextActionAt: to,
      snoozeCount: { increment: 1 },
      // Only on the first push — after that the origin is already recorded and must not drift.
      ...(row.snoozedFrom ? {} : { snoozedFrom: from }),
      snoozeReason: String(opts.reason ?? "").trim() || null,
    },
  });
}

/**
 * Abandon a commitment — NOT the same act as completing it.
 *
 * "The client says they no longer need this" is a different fact from "I made the call", and until
 * this existed the only way to clear such a row was to mark it done, or to log a call that never
 * happened. Both lied: the first inflates every completion figure, the second corrupts the contact
 * log itself.
 *
 * A reason is REQUIRED here, unlike on a reschedule. Rescheduling is ordinary and asking for a
 * justification each time would make people avoid the button; cancelling is the end of a commitment
 * somebody made to a client, and "forty of these were dropped last month, here is why" is the only
 * thing that makes the record worth keeping.
 */
export async function cancelFollowUp(id: string, reason: string) {
  const row = await prisma.interaction.findUnique({ where: { id } });
  if (!row) throw new Error("No such entry");
  if (!row.nextActionAt) throw new Error("That entry has no follow-up to cancel");
  if (row.nextActionDoneAt) throw new Error("That follow-up is already done — cancelling it would rewrite what happened");
  if (row.cancelledAt) return row;
  const why = String(reason ?? "").trim();
  if (!why) throw new Error("Say why it is being dropped — a cancellation with no reason teaches nothing");
  return prisma.interaction.update({
    where: { id },
    data: { cancelledAt: new Date().toISOString(), cancelReason: why },
  });
}

export async function closeFollowUp(id: string) {
  const row = await prisma.interaction.findUnique({ where: { id } });
  if (!row) throw new Error("No such entry");
  if (!row.nextActionAt) throw new Error("That entry has no follow-up to close");
  // The mirror of the guard in cancelFollowUp. Without it a row could carry BOTH dates, and the
  // derived state — the whole reason there is no `status` column — would have no single answer.
  if (row.cancelledAt) throw new Error("That follow-up was cancelled — it cannot also be completed");
  if (row.nextActionDoneAt) return row;
  return prisma.interaction.update({ where: { id }, data: { nextActionDoneAt: new Date().toISOString() } });
}
