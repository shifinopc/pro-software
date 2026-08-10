/**
 * HOW A DEAL IS DOING — the one place that decides.
 *
 * WHY THIS MODULE EXISTS. "Stalled" had come to mean two different things in two different places:
 * the hourly job measured days since anybody last SPOKE to the client, the Sales Dashboard measured
 * days the card had sat in one COLUMN, and neither surface said which it meant. A deal could be
 * stalled on the dashboard and fine to the job, or the reverse, and both were telling the truth.
 *
 * Both measures are worth having. The bug was having two of them unlabelled. So:
 *
 *   STILL   — days in the current stage, against that stage's own `maxDays`. "Nothing has moved."
 *   QUIET   — days since the last logged interaction, against the global `staleDealDays`.
 *             "Nobody has spoken to them."
 *
 * They are named separately, computed once, and every screen and job reads them from here.
 *
 * HEALTH IS EXPLAINABLE OR IT IS NOTHING. Every verdict carries the reasons that produced it, in
 * words. A coloured dot nobody can decompose gets trusted blindly for a week and ignored forever
 * after — which is worse than showing no dot at all.
 *
 * Nothing here is stored. Health is a reading of the current facts, and a stored one would be wrong
 * the moment somebody logged a call.
 */
import type { Opportunity, PipelineStage } from "@prisma/client";

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);

/** Whole days between two ISO days/instants, or null when the input is not a date. */
export function daysBetween(fromIso: string | null | undefined, on: string): number | null {
  const t = Date.parse(String(fromIso ?? ""));
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.parse(on) - t) / DAY);
}

export type HealthState = "healthy" | "quiet" | "at-risk" | "overdue" | "stalled" | "closed";

export interface HealthInput {
  deal: Pick<Opportunity, "id" | "stageAt" | "createdAt" | "expectedCloseDate">;
  stage: Pick<PipelineStage, "name" | "isWon" | "isLost" | "maxDays">;
  /** When this company was last spoken to — an ISO day, or null if never. */
  lastContactAt?: string | null;
  /** Open follow-ups on this deal: the earliest due date still outstanding, or null. */
  nextActionDueAt?: string | null;
  /** Global fallback when a stage sets no limit of its own, and the limit for going quiet. */
  staleDealDays: number;
  /** As-at day. Defaults to today; passed in by callers that batch. */
  on?: string;
}

export interface Health {
  state: HealthState;
  /** 0 healthy … 4 stalled. Sorting by this puts the worst deals first without a lookup table. */
  severity: number;
  label: string;
  color: string;
  bg: string;
  /** Every signal that fired, in words, worst first. The badge is a summary of these, never a substitute. */
  reasons: string[];
  /** Days sitting in the current stage, or null when the stage date was never recorded. */
  daysInStage: number | null;
  /** Days since anybody logged an interaction, or null when nobody ever has. */
  daysQuiet: number | null;
  /** The limit this stage was judged against. */
  stageLimit: number;
  /** True when a dated commitment on this deal is past due. */
  followUpOverdue: boolean;
  /** True when the expected close date has passed and the deal is still open. */
  pastExpectedClose: boolean;
}

const TONE: Record<HealthState, { label: string; color: string; bg: string; severity: number }> = {
  // Ordered by how much a sales manager needs to look at it, not by how bad it sounds.
  stalled: { label: "Stalled", color: "#C0353A", bg: "#FEECEC", severity: 4 },
  overdue: { label: "Overdue", color: "#E5484D", bg: "#FEECEC", severity: 3 },
  "at-risk": { label: "At risk", color: "#B25A00", bg: "#FFF4E5", severity: 2 },
  quiet: { label: "Gone quiet", color: "#B8860B", bg: "#FEF4E2", severity: 1 },
  healthy: { label: "Healthy", color: "#0E9355", bg: "#E7F8EF", severity: 0 },
  closed: { label: "Closed", color: "#6F6C7A", bg: "#F3F1F7", severity: 0 },
};

/** The limit this stage is judged against — its own, or the global fallback. */
export const stageLimitFor = (stage: Pick<PipelineStage, "maxDays">, staleDealDays: number) =>
  stage.maxDays != null && stage.maxDays > 0 ? stage.maxDays : staleDealDays;

export function healthOf(input: HealthInput): Health {
  const on = input.on ?? today();
  const { deal, stage } = input;
  const stageLimit = stageLimitFor(stage, input.staleDealDays);

  // A won or lost deal has no health. Reporting a closed deal as "stalled" because nobody has
  // touched it since is noise about work that is finished.
  if (stage.isWon || stage.isLost) {
    return {
      state: "closed", ...TONE.closed, reasons: [],
      daysInStage: daysBetween(deal.stageAt, on), daysQuiet: null,
      stageLimit, followUpOverdue: false, pastExpectedClose: false,
    };
  }

  // STILL. Falls back to when the deal was opened: a deal created and then never moved has no
  // stage date beyond its first, and that is exactly the case worth catching, not excusing.
  const daysInStage = daysBetween(deal.stageAt ?? deal.createdAt, on);
  // QUIET. Same fallback and the same reason — never contacted since opening IS the silence.
  const daysQuiet = daysBetween(input.lastContactAt ?? deal.createdAt, on);

  const followUpOverdue = !!input.nextActionDueAt && String(input.nextActionDueAt).slice(0, 10) < on;
  const pastExpectedClose = !!deal.expectedCloseDate && String(deal.expectedCloseDate).slice(0, 10) < on;

  const reasons: string[] = [];
  const isStalled = daysInStage != null && daysInStage >= stageLimit;
  const isQuiet = daysQuiet != null && daysQuiet >= input.staleDealDays;

  if (isStalled) reasons.push(`${daysInStage} days in ${stage.name} — this stage allows ${stageLimit}`);
  if (followUpOverdue) {
    const late = daysBetween(input.nextActionDueAt, on);
    reasons.push(`follow-up ${late === 0 ? "due today" : `${late} day${late === 1 ? "" : "s"} late`}`);
  }
  if (pastExpectedClose) {
    const late = daysBetween(deal.expectedCloseDate, on);
    reasons.push(`expected to close ${late} day${late === 1 ? "" : "s"} ago`);
  }
  if (isQuiet) reasons.push(`no contact for ${daysQuiet} days`);

  // PRECEDENCE, stated rather than left to the order of the ifs above.
  //
  // Stalled outranks the rest because it is the compound signal: nothing has moved in longer than
  // this column tolerates, whatever else is or is not scheduled. A missed commitment comes next —
  // somebody said they would do a thing on a day and did not. A slipped close date is a forecast
  // problem rather than a neglect problem, so it sits below both. Silence alone is the mildest: a
  // deal can be quiet for good reasons and still be moving.
  const state: HealthState = isStalled ? "stalled"
    : followUpOverdue ? "overdue"
      : pastExpectedClose ? "at-risk"
        : isQuiet ? "quiet"
          : "healthy";

  return {
    state, ...TONE[state], reasons,
    daysInStage, daysQuiet, stageLimit, followUpOverdue, pastExpectedClose,
  };
}

/** Worst first, for any list that wants the deals needing attention at the top. */
export const byWorstFirst = (a: { health: Health }, b: { health: Health }) =>
  b.health.severity - a.health.severity
  || (b.health.daysInStage ?? 0) - (a.health.daysInStage ?? 0);

/** The states a screen shows as a breakdown, in the order they should appear. */
export const HEALTH_ORDER: HealthState[] = ["healthy", "quiet", "at-risk", "overdue", "stalled"];
export const toneFor = (s: HealthState) => TONE[s];
