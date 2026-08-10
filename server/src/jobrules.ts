/**
 * WHEN THE SYSTEM ACTS ON ITS OWN — the numbers behind every automatic decision.
 *
 * Each of these was a constant in jobs.ts: `const STALE_DEAL_DAYS = 14`, `const SUSPEND_RECOMMEND_DAYS
 * = 45`, and so on. They are not engineering values. "A deal is stale after fourteen days" is a claim
 * about how fast this firm's market moves; "recommend suspending a client after 45 days unpaid" is a
 * commercial policy with a client relationship on the other end of it. A number like that living in a
 * source file means the person accountable for the consequence cannot change it, and the only way to
 * argue with it is a deploy.
 *
 * The same reasoning, and the same shape, as salesrules.ts — read per run, clamped, defaults equal to
 * the values the product already behaved with, so exposing them changes nothing until somebody moves
 * one deliberately.
 *
 * WHAT IS NOT HERE
 *
 * The 90-day workforce trend window looked like a sibling of these and is not: it is already a
 * parameter with a caller-supplied value (`GET /api/workforce-history?days=`), clamped in the route,
 * and the console chooses it. It is a view setting the user picks per chart, not a policy the system
 * acts on — moving it here would take a choice away rather than give one.
 */
import { prisma } from "./db.js";

export interface JobRules {
  /** Days before a document's expiry at which it is called "at risk" rather than merely dated. */
  docSlaAtRiskDays: number;
  /**
   * How many billing periods a long-dormant subscription may catch up on in one pass.
   *
   * A safety rail rather than a policy: without it, a subscription untouched for three years bills
   * thirty-six times in one tick. Configurable because "how far back do we bill in arrears" is a
   * commercial answer, but bounded hard because the wrong value here creates real invoices.
   */
  maxCatchUpPeriods: number;
  /** Days an invoice stays unpaid before suspending the client is RECOMMENDED (never automatic). */
  suspendRecommendDays: number;
  /** Percentage points above a band's floor that count as "about to fall out of it". */
  bandEdgePoints: number;
  /** Days with no contact before an open deal is called quiet. */
  staleDealDays: number;
  /** Days before a subscription ends that its renewal is put on the board as a deal. */
  renewalLeadDays: number;
  /**
   * Days AFTER the end date that a renewal deal is still worth raising.
   *
   * Was a bare `-30` inside the comparison, which is the least visible kind of magic number: it did
   * not even have a name to grep for.
   */
  renewalGraceDays: number;
  /** Days a lead can sit with no deal and no contact before somebody is nudged about it. */
  idleLeadDays: number;
}

export const JOB_RULE_DEFAULTS: JobRules = {
  docSlaAtRiskDays: 7,
  maxCatchUpPeriods: 12,
  suspendRecommendDays: 45,
  bandEdgePoints: 2,
  staleDealDays: 14,
  renewalLeadDays: 45,
  renewalGraceDays: 30,
  idleLeadDays: 10,
};

/**
 * Bounds, so a typo in a settings box cannot switch a job off or make it fire on everything.
 *
 * The floors matter more than the ceilings. `staleDealDays: 0` would call every deal created today
 * stale and mail the whole sales team about their entire pipeline; `maxCatchUpPeriods` at 500 would
 * raise five hundred invoices. A settings screen has to survive somebody holding a key down.
 */
const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  // ABSENT IS NOT ZERO. `Number(null)`, `Number("")` and `Number(false)` are all 0 — finite, and so
  // they sail past the check below and get clamped to the FLOOR instead of falling back to the
  // default. A cleared settings box would have meant "nudge about idle leads after 1 day" rather
  // than "after 10", which is a real change in behaviour arriving from an empty field.
  if (n === null || n === undefined || n === "" || typeof n === "boolean") return dflt;
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};

/** Read per run, never cached — see the note in salesrules.ts about settings that appear not to work. */
export async function jobRules(): Promise<JobRules> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "jobRules" } });
    const raw = (row?.value ?? {}) as any;
    const d = JOB_RULE_DEFAULTS;
    return {
      docSlaAtRiskDays: clamp(raw.docSlaAtRiskDays, 1, 180, d.docSlaAtRiskDays),
      maxCatchUpPeriods: clamp(raw.maxCatchUpPeriods, 1, 60, d.maxCatchUpPeriods),
      suspendRecommendDays: clamp(raw.suspendRecommendDays, 7, 365, d.suspendRecommendDays),
      bandEdgePoints: clamp(raw.bandEdgePoints, 1, 25, d.bandEdgePoints),
      staleDealDays: clamp(raw.staleDealDays, 2, 180, d.staleDealDays),
      renewalLeadDays: clamp(raw.renewalLeadDays, 1, 365, d.renewalLeadDays),
      renewalGraceDays: clamp(raw.renewalGraceDays, 0, 180, d.renewalGraceDays),
      idleLeadDays: clamp(raw.idleLeadDays, 1, 180, d.idleLeadDays),
    };
  } catch {
    return { ...JOB_RULE_DEFAULTS };
  }
}
