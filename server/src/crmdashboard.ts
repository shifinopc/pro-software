/**
 * THE CRM DASHBOARD, IN ONE ANSWER.
 *
 * Everything here is DERIVED at read time. Nothing is stored, nothing is cached, and no figure is
 * carried over from another screen — the Pipeline board, the Performance report and this all read
 * the same tables, so they cannot drift into three different truths about the same month.
 *
 * WHAT "REVENUE" MEANS, SAID ONCE. Three different numbers get called revenue and a dashboard that
 * blurs them is worse than one that omits it:
 *   collected  money actually received this month (Payment rows) — cash in
 *   invoiced   money billed this month, paid or not
 *   won        the value of deals that closed as won this month — what the CRM produced
 * All three are returned separately and labelled on screen. None of them is called just "revenue".
 *
 * SCOPING. A sales user sees their own book, or their team's when they lead one — the same
 * visibleUserIds / salesCompanyIds pair every other sales surface uses, passed in by the route
 * rather than re-derived here, so this cannot be the one screen that forgets to scope.
 */
import { prisma } from "./db.js";
import { statusOf, withMoney } from "./pipeline.js";
import { openFollowUps, lastContactMap } from "./interactions.js";
import { healthOf, byWorstFirst, HEALTH_ORDER, toneFor } from "./dealhealth.js";
import { jobRules } from "./jobrules.js";
import { lifecycleAnalytics } from "./lifecycle.js";

const day = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (iso: string) => String(iso ?? "").slice(0, 7);

export interface CrmScope {
  /** Companies this caller may see, or null for everything. */
  companyIds?: string[] | null;
  /** Deal owners this caller may see, or null for everyone. */
  ownerIds?: string[] | null;
  /**
   * Which month the MONEY is read for, as YYYY-MM. Defaults to the current one.
   *
   * Only the period figures move with it — won, invoiced, collected, the six-month strip and the
   * target it is measured against. The "today" cards do NOT: new leads today, follow-ups due and
   * upcoming appointments are a live queue, and rewriting them to a month in the past would turn a
   * list of things to do into a list of things somebody once did. Picking July should re-read July's
   * money, not pretend it is July.
   */
  month?: string | null;
  /**
   * The target this screen is measured against, already RESOLVED by the route.
   *
   * Passed in rather than looked up here so the dashboard and the Performance report cannot answer
   * "whose target is this" two different ways — the route applies the one rule (firm / the team you
   * lead / your own) and hands over the answer plus the words for it.
   */
  target?: { amountMinor: number; label: string } | null;
}

// `STALL_DAYS = 30` used to live here. It is gone: how long a deal may sit is now the STAGE's own
// `maxDays`, falling back to the global `staleDealDays` setting, and dealhealth.ts is the only place
// that decides. A constant in this file was half of the reason two screens disagreed.

export async function crmDashboard(scope: CrmScope = {}) {
  const today = day(new Date());
  // The selected month, or this one. Validated rather than trusted: an unparseable value would
  // otherwise make every period figure zero and look like a month with no business in it.
  const thisMonth = /^\d{4}-\d{2}$/.test(String(scope.month ?? "")) ? String(scope.month) : today.slice(0, 7);
  const coWhere = scope.companyIds ? { id: { in: scope.companyIds } } : {};

  const [companies, stages, allDeals, payments, invoices, appointments, activities, users] = await Promise.all([
    prisma.company.findMany({ where: coWhere, select: { id: true, name: true, lifecycle: true, createdAt: true, source: true } }),
    prisma.pipelineStage.findMany({ where: { retired: false }, orderBy: { sort: "asc" } }),
    prisma.opportunity.findMany({
      where: {
        ...(scope.companyIds ? { companyId: { in: scope.companyIds } } : {}),
        ...(scope.ownerIds ? { ownerId: { in: scope.ownerIds } } : {}),
      },
      include: { stage: true, company: { select: { name: true } } },
    }),
    prisma.payment.findMany({ where: scope.companyIds ? { companyId: { in: scope.companyIds } } : {} }),
    prisma.invoice.findMany({ where: scope.companyIds ? { companyId: { in: scope.companyIds } } : {} }),
    prisma.appointment.findMany({ where: scope.companyIds ? { companyId: { in: scope.companyIds } } : {} }),
    // Activity has no timestamp column — only `date` and `time` as separate strings. Ordered by
    // both rather than by id: the id is a cuid, which sorts by creation time for rows this app
    // wrote and by nothing at all for rows that arrived in an import.
    // Five, not twelve. A dozen rows made this card twice the height of everything beside it and
    // pushed the card next to it into a column of whitespace — and nobody reads the twelfth most
    // recent thing on a front page anyway. The full list is one click away on the Timeline.
    prisma.activity.findMany({ orderBy: [{ date: "desc" }, { time: "desc" }, { id: "desc" }], take: 5 }),
    prisma.user.findMany({ where: { type: "staff" }, select: { id: true, name: true } }),
  ]);

  const nameOf = new Map(users.map(u => [u.id, u.name]));
  const priced = await Promise.all(allDeals.map(d => withMoney(d as any)));
  const statusFor = (d: any) => statusOf(d.stage);

  // ── leads ─────────────────────────────────────────────────────────────────────────────────────
  const leads = companies.filter(c => c.lifecycle === "lead");
  // "New today" is read from the lifecycle HISTORY, not from `createdAt`. That column had grown
  // three behaviours — "client since" per its own comment, stamped at arrival by the web intake,
  // never stamped by the staff form — so a lead typed in this morning did not count as new today.
  // An arrival row (fromLifecycle null) is written by every creation path and means exactly one
  // thing. Distinct company ids, so a same-day arrive-and-promote cannot count twice.
  const arrivedToday = await prisma.lifecycleTransition.findMany({
    where: {
      fromLifecycle: null,
      toLifecycle: "lead",
      changedAt: { gte: today },
      ...(scope.companyIds ? { companyId: { in: scope.companyIds } } : {}),
    },
    select: { companyId: true },
  });
  const newLeadsToday = new Set(arrivedToday.map(r => r.companyId)).size;

  // ── deals ─────────────────────────────────────────────────────────────────────────────────────
  const open = priced.filter(d => statusFor(d) === "open");
  const won = priced.filter(d => statusFor(d) === "won");
  const lost = priced.filter(d => statusFor(d) === "lost");
  const closedThisMonth = (rows: any[]) => rows.filter(d => monthKey(d.closedAt ?? "") === thisMonth);
  const wonThisMonth = closedThisMonth(won);
  const lostThisMonth = closedThisMonth(lost);
  const sum = (rows: any[]) => rows.reduce((n, d) => n + (d.valueMinor ?? 0), 0);

  // ── the pipeline, by stage ────────────────────────────────────────────────────────────────────
  const pipeline = stages
    .filter(s => !s.isWon && !s.isLost)
    .map(s => {
      const rows = open.filter(d => d.stageId === s.id);
      return {
        id: s.id, name: s.name, color: s.color ?? "#7C00FF", bg: s.bg ?? "#F5EEFF",
        count: rows.length,
        valueMinor: sum(rows),
        weightedMinor: rows.reduce((n, d) => n + (d.weightedMinor ?? 0), 0),
      };
    });

  // ── six months of won value, for the trend ────────────────────────────────────────────────────
  // Built from a fixed list of months rather than from whatever the data happens to contain, so a
  // month with no wins is a ZERO on the line instead of vanishing and making the gap look like growth.
  const months: { key: string; label: string; wonMinor: number; wonCount: number }[] = [];
  // Anchored to the SELECTED month rather than to now, so the strip always ends on the month the
  // headline figure is quoting. Ending it on the calendar month while the headline read July would
  // put the number being discussed somewhere in the middle of its own chart.
  const anchor = new Date(thisMonth + "-01T00:00:00Z");
  for (let i = 5; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    const key = d.toISOString().slice(0, 7);
    const rows = won.filter(w => monthKey(w.closedAt ?? "") === key);
    months.push({
      key,
      label: d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }),
      wonMinor: sum(rows),
      wonCount: rows.length,
    });
  }

  // ── how every open deal is doing ──────────────────────────────────────────────────────────────
  //
  // Judged by dealhealth.ts, the same module the hourly job uses. This card used to apply its own
  // hardcoded 30-day rule against `stageAt` while the job applied a 14-day rule against last
  // contact, and both reported "stalled" — so the two disagreed by design and neither said why.
  const rules = await jobRules();
  const contacted = await lastContactMap(open.map(d => d.companyId));
  // The earliest still-open commitment per deal, so health can tell a missed promise from silence.
  const dueByDeal = new Map<string, string>();
  for (const f of await openFollowUps({ companyIds: scope.companyIds ?? null })) {
    const oid = (f as any).opportunityId as string | null;
    const at = String((f as any).nextActionAt ?? "").slice(0, 10);
    if (!oid || !at) continue;
    const cur = dueByDeal.get(oid);
    if (!cur || at < cur) dueByDeal.set(oid, at);
  }

  const judged = open.map(d => ({
    deal: d,
    health: healthOf({
      deal: d as any, stage: (d as any).stage,
      lastContactAt: contacted[d.companyId] ?? null,
      nextActionDueAt: dueByDeal.get(d.id) ?? null,
      staleDealDays: rules.staleDealDays,
      on: today,
    }),
  }));

  const healthCounts = HEALTH_ORDER.map(state => {
    const rows = judged.filter(j => j.health.state === state);
    const tone = toneFor(state);
    return { state, label: tone.label, color: tone.color, bg: tone.bg, count: rows.length, valueMinor: sum(rows.map(r => r.deal)) };
  });

  const stalledRows = judged.filter(j => j.health.state === "stalled").sort(byWorstFirst);
  const stalled = {
    count: stalledRows.length,
    valueMinor: sum(stalledRows.map(r => r.deal)),
    /** Open deals whose stage date was never recorded — reported, not silently treated as fresh. */
    unknownAge: judged.filter(j => j.health.daysInStage == null).length,
    rows: stalledRows.slice(0, 6).map(r => ({
      id: r.deal.id,
      title: r.deal.title,
      company: (r.deal as any).company?.name ?? null,
      stage: (r.deal as any).stage?.name ?? null,
      owner: r.deal.ownerId ? (nameOf.get(r.deal.ownerId) ?? "Somebody who has left") : null,
      days: r.health.daysInStage as number,
      limit: r.health.stageLimit,
      // The words the badge is a summary of. Shown on the row so nobody has to trust a colour.
      reasons: r.health.reasons,
      valueMinor: r.deal.valueMinor ?? null,
    })),
  };

  /**
   * Every open deal, worst first — INCLUDING the healthy ones.
   *
   * It used to stop at severity > 0, which was right while this fed a "needs attention" list and
   * wrong the moment the screen grew a Healthy filter: the chip counted deals the list could not
   * show, so pressing it emptied a card that had just told you there was one. A filter and its
   * list have to be drawn from the same set.
   *
   * Twelve rather than six, because the list is now filterable and six worst-first rows can be
   * entirely stalled — leaving Healthy to filter an empty set on a book that has healthy deals.
   */
  const needsAttention = judged
    .sort(byWorstFirst)
    .slice(0, 12)
    .map(j => ({
      id: j.deal.id, title: j.deal.title,
      company: (j.deal as any).company?.name ?? null,
      stage: (j.deal as any).stage?.name ?? null,
      owner: j.deal.ownerId ? (nameOf.get(j.deal.ownerId) ?? "Somebody who has left") : null,
      state: j.health.state, label: j.health.label, color: j.health.color, bg: j.health.bg,
      reasons: j.health.reasons,
      valueMinor: j.deal.valueMinor ?? null,
      // The meter the design draws under each row: how long it has sat against what this stage
      // allows. Both are already worked out by dealhealth — sending them means the screen never has
      // to re-derive a limit and reach a different answer from the badge beside it.
      daysInStage: j.health.daysInStage,
      stageLimit: j.health.stageLimit,
      daysQuiet: j.health.daysQuiet,
    }));

  // ── the funnel ────────────────────────────────────────────────────────────────────────────────
  //
  // WHAT THIS CAN AND CANNOT SAY, because a funnel that overstates itself is worse than none.
  //
  // Only the CURRENT stage is stored — there is no stage history — so "how many deals ever reached
  // Quoted" is not answerable exactly. What IS exact is how far each live or won deal has got:
  // a deal sitting in stage 3 has necessarily been through 1 and 2.
  //
  // Lost deals are therefore the hole. They dropped out somewhere, and the stage they dropped at is
  // not recorded anywhere queryable, so they are counted ONCE at the entry row and reported as a
  // separate unattributed figure rather than being spread across steps by guesswork.
  const openStages = stages.filter(s => !s.isWon && !s.isLost);
  const sortOf = new Map(stages.map(s => [s.id, s.sort]));
  const liveOrWon = [...open, ...won];
  const funnel = openStages.map((s, i) => {
    const reached = liveOrWon.filter(d => (sortOf.get(d.stageId) ?? -1) >= s.sort).length;
    return {
      id: s.id,
      name: s.name,
      color: s.color ?? "#7C00FF",
      reached,
      /** Share of the previous step that got this far. Null on the first step — nothing precedes it. */
      fromPrevBp: null as number | null,
      step: i,
    };
  });
  for (let i = 1; i < funnel.length; i++) {
    const prev = funnel[i - 1].reached;
    funnel[i].fromPrevBp = prev ? Math.round((funnel[i].reached * 10000) / prev) : null;
  }
  const funnelWon = {
    name: stages.find(s => s.isWon)?.name ?? "Won",
    reached: won.length,
    fromPrevBp: funnel.length && funnel[funnel.length - 1].reached
      ? Math.round((won.length * 10000) / funnel[funnel.length - 1].reached)
      : null,
  };

  // ── why deals were lost ───────────────────────────────────────────────────────────────────────
  //
  // Over the same six months as the trend, not this month: a reason breakdown needs volume to mean
  // anything, and one lost deal in August is an anecdote rather than a pattern.
  const sixMonthsAgo = months.length ? months[0].key : thisMonth;
  const lostRecently = lost.filter(d => monthKey(d.closedAt ?? "") >= sixMonthsAgo);
  const lostByReason = new Map<string, { count: number; valueMinor: number }>();
  for (const d of lostRecently) {
    // Deliberately NOT bucketed as "Other". A loss recorded with no reason is a gap in the process,
    // and naming it is the only thing that gets it filled in next time.
    const k = String(d.lostReason ?? "").trim() || "No reason recorded";
    const cur = lostByReason.get(k) ?? { count: 0, valueMinor: 0 };
    lostByReason.set(k, { count: cur.count + 1, valueMinor: cur.valueMinor + (d.valueMinor ?? 0) });
  }
  const lostReasons = [...lostByReason.entries()]
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.count - a.count || b.valueMinor - a.valueMinor);

  // ── where the leads came from ─────────────────────────────────────────────────────────────────
  //
  // Companies, not deals. Performance already reports deals-decided BY SOURCE, which answers "which
  // channel closes"; this answers the different question "which channel supplies". Two figures that
  // sound alike and are not, so they live on different screens and each says which it is.
  //
  // No cost per lead: nothing in this system records what was spent to acquire anybody, and dividing
  // by a number that does not exist is how a dashboard starts lying.
  const bySource = new Map<string, { total: number; leads: number; clients: number }>();
  for (const c of companies) {
    const k = String(c.source ?? "").trim() || "Not recorded";
    const cur = bySource.get(k) ?? { total: 0, leads: 0, clients: 0 };
    bySource.set(k, {
      total: cur.total + 1,
      leads: cur.leads + (c.lifecycle === "lead" ? 1 : 0),
      clients: cur.clients + (c.lifecycle === "client" ? 1 : 0),
    });
  }
  const leadSources = [...bySource.entries()]
    .map(([source, v]) => ({ source, ...v }))
    .sort((a, b) => b.total - a.total);

  // ── who is closing ────────────────────────────────────────────────────────────────────────────
  // This month only. A lifetime leaderboard rewards tenure rather than performance, and it never
  // changes, so nobody looks at it twice.
  const byOwner = new Map<string, { wonCount: number; wonMinor: number }>();
  for (const d of wonThisMonth) {
    const k = d.ownerId ?? "";
    const cur = byOwner.get(k) ?? { wonCount: 0, wonMinor: 0 };
    byOwner.set(k, { wonCount: cur.wonCount + 1, wonMinor: cur.wonMinor + (d.valueMinor ?? 0) });
  }
  const leaderboard = [...byOwner.entries()]
    .map(([id, v]) => ({ id, name: id ? (nameOf.get(id) ?? "Somebody who has left") : "Not recorded", ...v }))
    .sort((a, b) => b.wonMinor - a.wonMinor || b.wonCount - a.wonCount);

  // ── money ─────────────────────────────────────────────────────────────────────────────────────
  // Everything on this dashboard is in MINOR units so the console has one formatter, but the two
  // sources do not agree on precision and pretending they do would be the lie:
  //   Invoice has `totalMinor`, the frozen figure the document actually says — used when present.
  //   Payment has only `amount`, whole riyals, settled directly against `Invoice.amount`. Scaled by
  //   100 here. That is exact for what is stored; the halalas were lost when the row was written,
  //   not now, and there is no column left to recover them from.
  const paidThisMonth = payments.filter(p => monthKey(p.date ?? "") === thisMonth);
  const invoicedThisMonth = invoices.filter(i => monthKey(i.date ?? "") === thisMonth && !i.voidedAt);

  // ── what is next ──────────────────────────────────────────────────────────────────────────────
  //
  // `Appointment.date` HOLDS MIXED FORMATS. Booking links write an ISO day ("2026-08-14"); rows
  // that came in elsewhere hold a display string with no year at all ("30 Jul"). A plain string
  // comparison against today silently accepts the second kind — "30 Jul" > "2026-08-07" because "3"
  // sorts after "2" — which is how a meeting from last month ends up under "Upcoming".
  //
  // So only an unambiguous ISO day is placed in time. A row that cannot be parsed is NOT assumed to
  // be upcoming, and is not quietly dropped either: it is counted and reported, because "one meeting
  // has a date nobody can read" is a data problem somebody should fix, not a row to hide.
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const live = appointments.filter(a => !/cancel/i.test(a.status ?? ""));
  const undatedUpcoming = live.filter(a => !isoDay.test(a.date ?? "")).length;
  const upcoming = live
    .filter(a => isoDay.test(a.date ?? "") && (a.date ?? "") >= today)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.time ?? "").localeCompare(b.time ?? ""))
    .slice(0, 6)
    .map(a => ({ id: a.id, title: a.title, client: a.clientName ?? null, date: a.date, time: a.time ?? null, status: a.status, type: a.type ?? null }));

  /**
   * THE RELATIONSHIP FUNNEL — lead to prospect to client.
   *
   * A different question from the pipeline funnel already on this payload, and the one the screen
   * leads with: that one asks how far DEALS get through the stages, this asks how far COMPANIES get
   * through the relationship. Read from the lifecycle history, so each hop carries its own sample
   * size — an average over two companies is an anecdote wearing a decimal point, and the card says
   * so rather than printing it as a fact.
   *
   * Reused from lifecycle.ts rather than recomputed. The Sales Analytics screen already reports
   * these hops; two derivations of "how long does a lead take to become a client" would disagree
   * within a week and neither reader would know which they were looking at.
   */
  const lifecycle = await lifecycleAnalytics({ companyIds: scope.companyIds ?? null });

  /**
   * The four figures beside the funnel. Each is derived here rather than in the browser so the
   * dashboard and any other reader cannot reach different answers from the same rows.
   *
   * `avgDealSize` is across OPEN deals with a figure on them — deals with no value would otherwise
   * drag the average toward zero and report the book as cheaper than it is.
   *
   * `biggestLeak` is the stage that loses the largest share of what reached the one before it. Null
   * until at least one hop has a previous step to be measured against, because "the biggest drop"
   * across a single step is just that step.
   */
  const pricedOpen = open.filter(d => (d.valueMinor ?? 0) > 0);
  const avgDealSizeMinor = pricedOpen.length
    ? Math.round(pricedOpen.reduce((n, d) => n + (d.valueMinor ?? 0), 0) / pricedOpen.length)
    : null;
  const leak = funnel
    .filter(f => f.fromPrevBp != null)
    .sort((a, b) => (a.fromPrevBp ?? 0) - (b.fromPrevBp ?? 0))[0] ?? null;

  const followUps = await openFollowUps({ companyIds: scope.companyIds ?? null });

  /**
   * THE QUEUE, not just its size.
   *
   * The counts were all this returned, which was enough for four tiles and is not enough for a list.
   * Rows are capped at five each — this is the "what do I do next" card, and a queue long enough to
   * scroll has stopped being one.
   *
   * Each row carries what it needs to be acted on and nothing more: who it is about, what was
   * promised, and how late. `daysLate` comes from openFollowUps, which measures from the ORIGINAL
   * due date, so a commitment pushed back three times still reports how long it has really been
   * owed rather than looking fresh.
   */
  const chase = {
    followUps: followUps.slice(0, 5).map(f => ({
      id: f.id,
      title: f.nextAction ?? "Follow up",
      company: (f as any).company?.name ?? null,
      kind: f.kind ?? "call",
      overdue: !!f.overdue,
      daysLate: (f as any).daysLate ?? 0,
    })),
    // Arrived today, with the score the Leads screen shows — same figure, so a lead that reads 82
    // there cannot read something else here.
    newLeads: await (async () => {
      const ids = [...new Set(arrivedToday.map(r => r.companyId))].slice(0, 5);
      if (!ids.length) return [];
      const rows = await prisma.company.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, source: true },
      });
      return rows.map(c => ({ id: c.id, name: c.name, source: c.source ?? "Not recorded" }));
    })(),
    appointments: upcoming.slice(0, 5),
    undated: undatedUpcoming,
  };

  return {
    on: today,
    month: thisMonth,
    leads: { total: leads.length, newToday: newLeadsToday },
    followUpsToday: { total: followUps.length, overdue: followUps.filter(f => f.overdue).length },
    chase,
    deals: {
      open: { count: open.length, valueMinor: sum(open), weightedMinor: open.reduce((n, d) => n + (d.weightedMinor ?? 0), 0) },
      won: { count: won.length, thisMonth: wonThisMonth.length, thisMonthMinor: sum(wonThisMonth) },
      lost: { count: lost.length, thisMonth: lostThisMonth.length, thisMonthMinor: sum(lostThisMonth) },
      // Null rather than 0 when nothing closed this month: no deals decided is not a 0% win rate.
      winRateBp: (wonThisMonth.length + lostThisMonth.length)
        ? Math.round((wonThisMonth.length * 10000) / (wonThisMonth.length + lostThisMonth.length))
        : null,
    },
    money: {
      collectedMinor: paidThisMonth.reduce((n, p) => n + (p.amount ?? 0) * 100, 0),
      collectedCount: paidThisMonth.length,
      invoicedMinor: invoicedThisMonth.reduce((n, i) => n + (i.totalMinor ?? (i.amount ?? 0) * 100), 0),
      invoicedCount: invoicedThisMonth.length,
    },
    pipeline,
    months,
    stalled,
    /** Every open deal by health, in fixed order — healthy first, stalled last. */
    health: healthCounts,
    needsAttention,
    /** The global fallback limit, for screens that need to say what "quiet" means here. */
    staleDealDays: rules.staleDealDays,
    funnel: {
      steps: funnel,
      won: funnelWon,
      /** Dropped out somewhere, stage unknown — see the note above `funnel`. */
      lostUnattributed: lost.length,
    },
    lostReasons,
    lostReasonsFrom: sixMonthsAgo,
    /** lead -> prospect -> client, with each hop's average time and its sample size. */
    lifecycle,
    /** Across open deals that carry a figure; null when none do. */
    avgDealSizeMinor,
    /** The stage losing the largest share of what reached the one before it, or null. */
    biggestLeak: leak ? { name: leak.name, keptBp: leak.fromPrevBp } : null,
    leadSources,
    /** The resolved target for this month, or null when none is set. Never invented from an average. */
    target: scope.target ?? null,
    leaderboard: leaderboard.slice(0, 5),
    // `time` is deliberately NOT returned. It holds the string "Just now" on every row — a relative
    // label frozen at write time, which was true for one minute and has been wrong ever since. The
    // ISO instant in `date` is the only thing here that can be rendered honestly.
    recentActivity: activities.map(a => ({ id: a.id, type: a.type, message: a.message, user: a.user, at: a.date })),
    upcoming,
    /** Live appointments whose date cannot be placed in time. Surfaced so it can be fixed. */
    undatedUpcoming,
  };
}
