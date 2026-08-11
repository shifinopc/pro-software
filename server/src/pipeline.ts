/**
 * The sales pipeline: the stages a country's deals move through, and what a deal's position means.
 *
 * THE ONE RULE THIS MODULE EXISTS FOR
 *
 * An opportunity has no stored status. Open, won and lost are read off the stage it is sitting in,
 * every time, by `statusOf`. A stored status would be a copy of the stage, and a copy needs a second
 * write to stay true — so the first drag-and-drop that forgets it leaves a card in the Won column
 * reading "open", and every forecast built on either field is wrong in a different way.
 *
 * WHY STAGES ARE VALIDATED AS A SET
 *
 * A pipeline with no winning column can never record a sale. One with two has no single answer to
 * "did we win it". Neither is catchable one row at a time, so the whole set is checked on save —
 * the same shape as the workforce band editor, and for the same reason.
 */
import { prisma } from "./db.js";
import { summariesForMany } from "./dealchecklist.js";
import { countryCurrency } from "./countries.js";
import { healthOf } from "./dealhealth.js";
import { jobRules } from "./jobrules.js";
import { lastContactMap, openFollowUps } from "./interactions.js";
import type { Opportunity, PipelineStage } from "@prisma/client";

export type DealStatus = "open" | "won" | "lost";

/** What a deal's position means. The only place this question is answered. */
export const statusOf = (stage: Pick<PipelineStage, "isWon" | "isLost">): DealStatus =>
  stage.isWon ? "won" : stage.isLost ? "lost" : "open";

/** The live stages for a country, left to right. */
export async function stagesFor(country: string | null) {
  if (!country) return [];
  return prisma.pipelineStage.findMany({
    where: { country, retired: false },
    orderBy: [{ sort: "asc" }, { name: "asc" }],
  });
}

/**
 * Check a whole stage set before it is saved.
 *
 * Returns a plain sentence or null. The wording matters more than it looks: these are read by
 * somebody configuring the product, not debugging it, so each one says what is wrong AND what it
 * would cause.
 */
export function validateStages(rows: Array<{ name: string; sort: number; isWon?: boolean; isLost?: boolean; probabilityBp?: number }>): string | null {
  const named = rows.filter(r => String(r.name ?? "").trim());
  if (!named.length) return "Add at least one stage, or cancel.";

  const dupes = named.filter((r, i) => named.findIndex(o => o.name.trim().toLowerCase() === r.name.trim().toLowerCase()) !== i);
  if (dupes.length) return `Two stages are both called "${dupes[0].name.trim()}" — a card moved to one of them could not say which.`;

  const won = named.filter(r => r.isWon);
  const lost = named.filter(r => r.isLost);
  if (won.length === 0) return "One stage has to be the won one, or a deal can never be recorded as sold.";
  if (won.length > 1) return `"${won[0].name}" and "${won[1].name}" are both marked won — there would be no single answer to whether a deal closed.`;
  if (lost.length === 0) return "One stage has to be the lost one, or a deal can only ever be deleted rather than closed.";
  if (lost.length > 1) return `"${lost[0].name}" and "${lost[1].name}" are both marked lost.`;
  if (won.some(r => r.isLost)) return `"${won[0].name}" is marked both won and lost.`;

  for (const r of named) {
    const bp = r.probabilityBp ?? 0;
    if (bp < 0 || bp > 10000) return `"${r.name}" has a probability outside 0–100%.`;
  }
  return null;
}

/**
 * Everything the board needs about one opportunity, with the money resolved.
 *
 * The QUOTATION is the figure of record once one exists. The opportunity's own `valueMinor` is an
 * estimate somebody typed before anybody quoted, and showing it beside a quotation that says
 * something else is how two numbers for one deal get into a forecast.
 */
/**
 * Append one row of stage history. EVERY writer that creates a deal or changes its stageId calls
 * this — the move route, quotation acceptance, add-on approval, the renewal job, and each creation
 * site (with fromStageId null, meaning "arrived here at birth"). A history table with one writer
 * that forgets is worse than none: the analytics built on it would be confidently wrong rather
 * than absent.
 *
 * Takes the db handle as a parameter so the move route can pass its transaction — the transition
 * must commit or roll back WITH the move it records, or the history can disagree with the deal.
 *
 * `isBackward` is decided HERE, against the sort order both stages have right now, because that is
 * the one moment the question is answerable — sorts get edited and stages retired later.
 */
export async function recordTransition(db: any, args: {
  opportunityId: string;
  fromStageId?: string | null;
  toStageId: string;
  movedById?: string | null;
  at: string;
  lostReason?: string | null;
  /**
   * Pass this when the caller ALREADY holds both stages, which the move route does.
   *
   * Without it this function issues a `findMany` to compare two sort orders — and when it is called
   * inside `$transaction`, that read is held by the open transaction. It is how the move route came
   * to spend 7.3s inside a 5s interactive-transaction budget, blow the deadline, and take the whole
   * API process down with it. A read that answers a question the caller can already answer has no
   * business inside a transaction at all.
   */
  isBackward?: boolean;
}) {
  let isBackward = args.isBackward ?? false;
  // Only when the caller could not tell us — every path that already has the stages should pass it.
  if (args.isBackward === undefined && args.fromStageId && args.fromStageId !== args.toStageId) {
    const pair = await db.pipelineStage.findMany({
      where: { id: { in: [args.fromStageId, args.toStageId] } },
      select: { id: true, sort: true },
    });
    const from = pair.find((s: any) => s.id === args.fromStageId);
    const to = pair.find((s: any) => s.id === args.toStageId);
    isBackward = !!(from && to && to.sort < from.sort);
  }
  return db.stageTransition.create({
    data: {
      opportunityId: args.opportunityId,
      fromStageId: args.fromStageId ?? null,
      toStageId: args.toStageId,
      movedById: args.movedById ?? null,
      movedAt: args.at,
      lostReason: args.lostReason ?? null,
      isBackward,
    },
  });
}

/**
 * What the stage history can say so far: how long deals dwell in each stage, and where they die.
 *
 * COMPLETED dwells only. A deal still sitting in Quoted contributes nothing to Quoted's average —
 * its stay is not over, and counting it would drag every average toward "recently", hardest on the
 * exact stages where deals rot. The card states its sample sizes for the same reason: an average
 * of two dwells is an anecdote wearing a decimal point.
 *
 * Everything is computed from StageTransition rows, so the answers begin at the day the table
 * began — `since` is returned and the screen says so rather than presenting six days of history
 * as an eternal truth.
 */
export async function stageAnalytics(country: string | null) {
  const stages = await stagesFor(country);
  if (!stages.length) return { stages: [], since: null, backwardMoves: 0, sampleDeals: 0, lostTo: [] };
  const stageIds = new Set(stages.map(s => s.id));
  const byId = new Map(stages.map(s => [s.id, s]));

  const rows = await prisma.stageTransition.findMany({
    orderBy: [{ opportunityId: "asc" }, { movedAt: "asc" }],
    take: 20000,
  });
  const mine = rows.filter(r => stageIds.has(r.toStageId) || (r.fromStageId && stageIds.has(r.fromStageId)));

  const dwell = new Map<string, number[]>();   // stageId -> completed dwell days
  const died = new Map<string, number>();      // stageId the deal was IN when it was lost
  let backwardMoves = 0;
  const deals = new Set<string>();

  const byDeal = new Map<string, typeof mine>();
  for (const r of mine) {
    deals.add(r.opportunityId);
    if (r.isBackward) backwardMoves++;
    const list = byDeal.get(r.opportunityId) ?? [];
    list.push(r);
    byDeal.set(r.opportunityId, list);
  }
  for (const list of byDeal.values()) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      // The stage dwelt in is where the PREVIOUS row landed; the dwell ends when the next begins.
      const days = (Date.parse(cur.movedAt) - Date.parse(prev.movedAt)) / 86_400_000;
      if (Number.isFinite(days) && days >= 0) {
        const arr = dwell.get(prev.toStageId) ?? [];
        arr.push(days);
        dwell.set(prev.toStageId, arr);
      }
      const toStage = byId.get(cur.toStageId);
      if (toStage?.isLost) died.set(prev.toStageId, (died.get(prev.toStageId) ?? 0) + 1);
    }
  }

  // Who lost deals were lost to. Deals carrying a competitor AND sitting in a lost column — a
  // competitor on a deal still open is a fight in progress, not a defeat, and counting it here
  // would report battles as losses.
  const lostIds = stages.filter(s => s.isLost).map(s => s.id);
  const lostToRows = lostIds.length
    ? await prisma.opportunity.groupBy({
        by: ["competitor"],
        where: { stageId: { in: lostIds }, competitor: { not: null } },
        _count: { _all: true },
      })
    : [];
  const lostTo = lostToRows
    .map(r => ({ competitor: String(r.competitor), count: r._count._all }))
    .sort((a, b) => b.count - a.count);

  return {
    lostTo,
    stages: stages.filter(s => !s.isWon && !s.isLost).map(s => {
      const ds = dwell.get(s.id) ?? [];
      return {
        id: s.id, name: s.name, color: s.color ?? "#7C00FF",
        /** Null, never 0, when no completed dwell exists — an empty sample is not a fast stage. */
        avgDays: ds.length ? Math.round((ds.reduce((a, b) => a + b, 0) / ds.length) * 10) / 10 : null,
        samples: ds.length,
        diedHere: died.get(s.id) ?? 0,
      };
    }),
    since: mine.length ? mine.reduce((m, r) => (r.movedAt < m ? r.movedAt : m), mine[0].movedAt).slice(0, 10) : null,
    backwardMoves,
    sampleDeals: deals.size,
  };
}

/** The three promises a deal's money can carry, weakest first. */
export const FORECAST_CATEGORIES = ["pipeline", "best_case", "commit"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

/**
 * Which promise this deal's money carries.
 *
 * Stored category wins when somebody set one; otherwise DERIVED from the same odds the weighted
 * total already uses — commit at 75%+, best case at 50%+, pipeline below. One scale, two readings:
 * a deal cannot be weighted at 80% on the board yet sit outside "commit" on the forecast unless a
 * person deliberately put it there, and when they did, the answer says so (`source: "set"`), so a
 * manager reading the forecast can tell judgement from arithmetic.
 *
 * Won and lost deals carry no category at all — their money is not a forecast, it is history.
 */
export function forecastOf(opp: Pick<Opportunity, "forecastCategory" | "probabilityBp">, stage: PipelineStage): { category: ForecastCategory; source: "set" | "derived" } | null {
  if (stage.isWon || stage.isLost) return null;
  const set = String(opp.forecastCategory ?? "");
  if ((FORECAST_CATEGORIES as readonly string[]).includes(set)) return { category: set as ForecastCategory, source: "set" };
  const bp = opp.probabilityBp ?? stage.probabilityBp ?? 0;
  return { category: bp >= 7500 ? "commit" : bp >= 5000 ? "best_case" : "pipeline", source: "derived" };
}

export async function withMoney(opp: Opportunity & { stage: PipelineStage }) {
  const status = statusOf(opp.stage);
  let valueMinor = opp.valueMinor ?? null;
  let currency = opp.currency ?? null;
  let quotation: { id: string; number: string; status: string } | null = null;

  if (opp.quotationId) {
    const q = await prisma.quotation.findUnique({
      where: { id: opp.quotationId },
      select: { id: true, number: true, status: true, totalMinor: true, amount: true },
    });
    if (q) {
      quotation = { id: q.id, number: q.number, status: q.status };
      // totalMinor is the frozen figure; `amount` is the older whole-unit column kept for rows
      // written before minor units existed.
      valueMinor = q.totalMinor ?? (q.amount ? q.amount * 100 : valueMinor);
    }
  }

  // Per-deal odds beat the stage default — somebody who has met the client knows more than a column.
  const probabilityBp = opp.probabilityBp ?? opp.stage.probabilityBp ?? 0;
  return {
    ...opp,
    status,
    valueMinor,
    currency,
    quotation,
    probabilityBp,
    /** What this deal is worth once weighted by its odds. Won deals count in full, lost at nothing. */
    weightedMinor: valueMinor == null ? null
      : status === "won" ? valueMinor
      : status === "lost" ? 0
      : Math.round((valueMinor * probabilityBp) / 10000),
    /** Where the figure came from, so a reader never has to guess whether it is a quote or a guess. */
    valueSource: quotation ? "quotation" : (opp.valueMinor != null ? "estimate" : "none"),
    /** Null on closed deals — their money is history, not a promise. */
    forecast: forecastOf(opp, opp.stage),
  };
}

/** The board: every live stage for a country, each with its deals and its totals. */
export async function boardFor(country: string | null, opts: { ownerId?: string | null; companyIds?: string[] | null } = {}) {
  const stages = await stagesFor(country);
  if (!stages.length) return { stages: [], columns: [] };

  const where: any = { stageId: { in: stages.map(s => s.id) } };
  if (opts.ownerId) where.ownerId = opts.ownerId;
  if (opts.companyIds) where.companyId = { in: opts.companyIds };

  const opps = await prisma.opportunity.findMany({
    where,
    include: { stage: true, company: { select: { id: true, name: true, lifecycle: true } } },
    orderBy: [{ expectedCloseDate: "asc" }, { createdAt: "desc" }],
    take: 1000,
  });
  const resolved = await Promise.all(opps.map(o => withMoney(o as any)));

  // What each card still owes. Batched deliberately: the per-deal version costs one document query
  // per card, which is invisible with four deals and unusable with four hundred.
  const companyIds = [...new Set(opps.map(o => o.companyId))];
  const companies = companyIds.length
    ? await prisma.company.findMany({ where: { id: { in: companyIds } } })
    : [];
  const byCompany = new Map(companies.map(c => [c.id, c]));
  const checklists = await summariesForMany(opps as any[], byCompany);
  for (const d of resolved) {
    const c = checklists.get((d as any).id);
    // Only the counts go on the card; the items themselves are fetched when a drawer opens. A board
    // carrying every item of every deal is a payload nobody on the screen is reading.
    (d as any).checklist = c ? { done: c.done, total: c.total, requiredDone: c.requiredDone, requiredTotal: c.requiredTotal, blocked: c.blocked } : null;
  }

  // HOW EACH DEAL IS DOING, on the card itself.
  //
  // From dealhealth.ts, the same module the dashboard and the hourly job read, so a deal cannot be
  // stalled on one screen and healthy on another. Attached here rather than per view: the Kanban,
  // the list and the table are three drawings of this one payload, and computing it in any of them
  // would be the start of three answers to one question.
  const rules = await jobRules();
  const contacted = await lastContactMap(companyIds);
  const dueByDeal = new Map<string, string>();
  for (const f of await openFollowUps({ companyIds: opts.companyIds ?? null })) {
    const oid = (f as any).opportunityId as string | null;
    const at = String((f as any).nextActionAt ?? "").slice(0, 10);
    if (!oid || !at) continue;
    const cur = dueByDeal.get(oid);
    if (!cur || at < cur) dueByDeal.set(oid, at);
  }
  for (const d of resolved) {
    (d as any).health = healthOf({
      deal: d as any,
      stage: (d as any).stage,
      lastContactAt: contacted[(d as any).companyId] ?? null,
      nextActionDueAt: dueByDeal.get((d as any).id) ?? null,
      staleDealDays: rules.staleDealDays,
    });
    (d as any).nextActionAt = dueByDeal.get((d as any).id) ?? null;
    (d as any).lastContactAt = contacted[(d as any).companyId] ?? null;
  }

  const columns = stages.map(s => {
    const deals = resolved.filter(o => o.stageId === s.id);
    return {
      stage: s,
      deals,
      count: deals.length,
      // Totals per column, because "12 deals" says nothing about whether the month is safe.
      totalMinor: deals.reduce((n, d) => n + (d.valueMinor ?? 0), 0),
      weightedMinor: deals.reduce((n, d) => n + (d.weightedMinor ?? 0), 0),
      /** Deals with no figure at all — counted so a column total is never read as complete. */
      unpriced: deals.filter(d => d.valueMinor == null).length,
    };
  });
  return { stages, columns };
}

/**
 * Open a deal for a company, pre-filled from what is already known about it.
 *
 * Shared by the "open a deal" button and by promoting a lead to prospect, so the two cannot drift
 * into producing different cards for the same act. Returns null rather than throwing when there is
 * already an open deal or no stage to put one in — both are ordinary situations for the caller to
 * report, not failures.
 */
export async function openDealFor(
  company: { id: string; name: string; country: string | null; ownerId: string | null; source: string | null; lifecycle: string },
  opts: {
    title?: string | null; actor?: string | null; homeCountry: string; numberFor?: () => Promise<string | null>;
    /**
     * Prefills from qualification, when promotion captured one. The budget is not the "made-up
     * figure" the null default below guards against — it is what the client SAID they could spend,
     * and it lands as an ESTIMATE (valueSource says so) to be replaced by the quotation like any
     * other estimate. Same for the decision date → expected close.
     */
    valueMinor?: number | null; expectedCloseDate?: string | null; notes?: string | null;
  } = { homeCountry: "SA" },
): Promise<{ deal: Opportunity & { stage: PipelineStage } } | { skipped: "already-open" | "no-stages" | "lost"; detail: string }> {
  if (company.lifecycle === "lost") return { skipped: "lost", detail: `${company.name} is marked lost` };

  const existing = await prisma.opportunity.findMany({ where: { companyId: company.id }, include: { stage: true } });
  const live = existing.filter(o => statusOf(o.stage) === "open");
  if (live.length) return { skipped: "already-open", detail: `already has an open deal: "${live[0].title}"` };

  const country = company.country ?? opts.homeCountry;
  const stages = await stagesFor(country);
  if (!stages.length) return { skipped: "no-stages", detail: `no pipeline stages are set up for ${country}` };
  const stage = stages.find(s => !s.isWon && !s.isLost) ?? stages[0];

  const now = new Date().toISOString();
  const deal = await prisma.opportunity.create({
    data: {
      number: opts.numberFor ? await opts.numberFor().catch(() => null) : null,
      companyId: company.id,
      title: String(opts.title ?? "").trim() || `New business — ${company.name}`,
      // Unpriced BY DEFAULT — a made-up figure would go straight into the weighted forecast, and an
      // unpriced deal is already counted and reported as such (see the board's `unpriced`). The one
      // exception is a qualified budget passed in by the promotion flow: that figure is the client's
      // own words, lands as an ESTIMATE, and is replaced by the quotation like any other estimate.
      valueMinor: opts.valueMinor ?? null,
      expectedCloseDate: opts.expectedCloseDate ?? null,
      notes: opts.notes ?? null,
      currency: countryCurrency(country),
      stageId: stage.id,
      // The COMPANY's owner owes it. Whoever pressed the button may be a manager tidying up.
      ownerId: company.ownerId ?? opts.actor ?? null,
      source: company.source ?? null,
      country,
      createdAt: now, stageAt: now,
    },
    include: { stage: true },
  });
  await recordTransition(prisma, { opportunityId: deal.id, toStageId: stage.id, movedById: opts.actor ?? null, at: now });
  // The stage's own chase window applies to a deal that lands here, exactly as it would to one
  // dragged in — otherwise a deal opened this way is the one nobody is ever reminded about.
  await applyStageFollowUp(deal, stage, opts.actor ?? null).catch(() => {});
  return { deal };
}

/**
 * A client asking for a service outside their plan, put on the board.
 *
 * WHY THIS ONE IS AUTOMATIC WHEN OPENING A DEAL FOR A LEAD IS NOT
 *
 * A lead is a company somebody typed in; whether there is business there is still a guess. An add-on
 * request is an existing client saying, unprompted, "I want to buy this". That is the strongest
 * buying signal the product ever receives, and it was landing entirely outside the pipeline: the
 * approval added the service and raised an invoice, so the money appeared in the accounts having
 * never been in a forecast, and the win rate counted none of it.
 *
 * `originKey` is unique, so a client pressing the button twice cannot produce two cards.
 *
 * Returns null when there is nothing to put it on. A missing pipeline configuration must never stop
 * a client asking to spend money.
 */
export async function dealForAddonRequest(
  request: { id: string; companyId: string; serviceName: string | null },
  opts: { homeCountry: string; numberFor?: () => Promise<string | null> },
) {
  const co = await prisma.company.findUnique({ where: { id: request.companyId } });
  if (!co) return null;

  const country = co.country ?? opts.homeCountry;
  const stages = await stagesFor(country);
  const stage = stages.find(s => !s.isWon && !s.isLost) ?? null;
  if (!stage) return null;

  const now = new Date().toISOString();
  try {
    const deal = await prisma.opportunity.create({
      data: {
        originKey: `addon:${request.id}`,
        number: opts.numberFor ? await opts.numberFor().catch(() => null) : null,
        companyId: co.id,
        title: request.serviceName ? `${request.serviceName} — requested by the client` : "Client request",
        // Priced at approval, not now: the fee is what somebody decides to charge, and inventing it
        // here would put a number in the forecast that nobody has agreed to.
        valueMinor: null,
        currency: countryCurrency(country),
        stageId: stage.id,
        ownerId: co.ownerId ?? null,
        source: "client request",
        country,
        notes: "Raised automatically: the client asked for this through the portal.",
        createdAt: now, stageAt: now,
      },
      include: { stage: true },
    });
    await recordTransition(prisma, { opportunityId: deal.id, toStageId: stage.id, at: now });
    await applyStageFollowUp(deal, stage, null).catch(() => {});
    return deal;
  } catch {
    // Unique violation on originKey = this request already has a card. Expected on a re-submission.
    return null;
  }
}

/**
 * Close the deal an add-on request raised.
 *
 * Approval carries the price somebody agreed, so that becomes the deal's value — the same shape as a
 * quotation being accepted. Refusal loses it with the reason, so client-initiated business that did
 * not happen shows up in the loss report like everything else.
 */
export async function closeAddonDeal(
  requestId: string,
  outcome: { won: true; priceMinor: number | null } | { won: false; reason: string },
) {
  const deal = await prisma.opportunity.findFirst({ where: { originKey: `addon:${requestId}` }, include: { stage: true } });
  if (!deal || statusOf(deal.stage) !== "open") return null;

  const stage = await prisma.pipelineStage.findFirst({
    where: { country: deal.country, retired: false, ...(outcome.won ? { isWon: true } : { isLost: true }) },
  });
  // No terminal column configured: leave the card where it is rather than inventing a destination.
  // The add-on itself still went through; the board simply cannot say so yet.
  if (!stage) return null;

  const now = new Date().toISOString();
  const closed = await prisma.opportunity.update({
    where: { id: deal.id },
    data: {
      stageId: stage.id, stageAt: now, closedAt: now,
      ...(outcome.won
        ? { valueMinor: outcome.priceMinor ?? deal.valueMinor, lostReason: null }
        : { lostReason: outcome.reason }),
    },
    include: { stage: true },
  });
  await recordTransition(prisma, {
    opportunityId: deal.id, fromStageId: deal.stageId, toStageId: stage.id,
    at: now, lostReason: outcome.won ? null : outcome.reason ?? null,
  });
  return closed;
}

/**
 * Book the chase a stage asks for, and clear the one the last stage booked.
 *
 * WHY THE PREVIOUS ONE IS CLEARED FIRST
 *
 * A deal that goes Enquiry → Quoted → back to Enquiry → Quoted would otherwise leave four chases
 * standing, all for the same deal, most of them for a stage it is no longer in. The queue fills with
 * work nobody has to do, and a queue like that stops being read.
 *
 * WHY ONLY THE RULE'S OWN
 *
 * `auto` marks the ones a rule booked. A commitment somebody typed — "I promised to call Fahad on
 * Sunday" — survives every stage move, because nothing in a pipeline knows better than the person
 * who made the promise.
 *
 * A TERMINAL STAGE BOOKS NOTHING
 *
 * Won or lost, the deal is finished; leaving a chase against it would put homework on somebody's
 * queue for a conversation that is over.
 */
export async function applyStageFollowUp(opp: Opportunity, stage: PipelineStage, actor?: string | null, db: any = prisma) {
  const now = new Date().toISOString();

  // Clear first, unconditionally: entering ANY stage retires the previous stage's chase, including
  // when the new stage has no rule of its own.
  await db.interaction.updateMany({
    where: { opportunityId: opp.id, auto: true, nextActionAt: { not: null }, nextActionDoneAt: null },
    data: { nextActionDoneAt: now },
  });

  if (stage.isWon || stage.isLost) return null;
  if (stage.followUpDays == null || stage.followUpDays < 0) return null;

  const due = new Date(Date.now() + stage.followUpDays * 86400000).toISOString().slice(0, 10);
  return db.interaction.create({
    data: {
      companyId: opp.companyId,
      opportunityId: opp.id,
      // Not a call or a meeting: nothing was said to anybody. It is a note that the deal moved,
      // carrying the commitment that move creates.
      kind: "note",
      at: now,
      summary: `Moved to ${stage.name}`,
      nextAction: stage.followUpAction?.trim() || `Follow up on ${stage.name}`,
      nextActionAt: due,
      // The deal's owner owes it. Falling back to whoever moved the card would put the chase on a
      // manager who was tidying the board.
      ownerId: opp.ownerId ?? actor ?? null,
      auto: true,
      createdAt: now,
    },
  });
}

/**
 * Win the opportunity a quotation was raised from.
 *
 * Called from `startDeliveryForQuotation`, which is the single path BOTH acceptance routes run
 * through — the portal's and the console's. Hooking the two routes separately is how one of them
 * ends up not doing it.
 */
export async function winOpportunityForQuotation(quotationId: string) {
  const opp = await prisma.opportunity.findFirst({
    where: { quotationId },
    include: { stage: true },
  });
  if (!opp || statusOf(opp.stage) !== "open") return null;

  const wonStage = await prisma.pipelineStage.findFirst({ where: { country: opp.country, isWon: true, retired: false } });
  // No won column configured for this country: leave the deal where it is rather than inventing a
  // destination. The quotation is still accepted and delivery still starts — the pipeline is simply
  // not able to say so yet, which is a configuration gap, not a reason to fail the sale.
  if (!wonStage) return null;

  const now = new Date().toISOString();
  const won = await prisma.opportunity.update({
    where: { id: opp.id },
    data: { stageId: wonStage.id, stageAt: now, closedAt: now, lostReason: null },
  });
  // movedById null: the client accepting a quotation is the system winning the deal, not a person
  // dragging a card.
  await recordTransition(prisma, { opportunityId: opp.id, fromStageId: opp.stageId, toStageId: wonStage.id, at: now });
  return won;
}
