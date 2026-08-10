/**
 * How long the firm waits before it chases things. Policy, not engineering.
 *
 * WHY THESE ARE NOT CONSTANTS
 *
 * "Chase a quotation after five days" is a decision about how this business treats its clients. A
 * firm that sells to government departments waits three weeks; one selling visa renewals chases on
 * Tuesday. Neither should need a deploy, and a number that lives in code cannot be argued with by
 * the person whose reputation is on the line when it fires too early.
 *
 * READ PER RUN, NOT CACHED
 *
 * The job reads these each time it runs. A cached copy means a change made this morning takes effect
 * whenever the process last restarted, which is exactly the sort of "why didn't that work" that
 * makes people stop trusting settings screens.
 *
 * DEFAULTS ARE STATED, NOT HIDDEN
 *
 * Every default below is the value the product behaved with before it was configurable, so turning
 * the screen on changes nothing until somebody deliberately moves a number.
 */
import { prisma } from "./db.js";

export interface SalesRules {
  /** Days of silence after a quotation is SENT before the owner is told nobody has answered. */
  quoteChaseDays: number;
  /** Days before `validUntil` to warn that an unanswered quotation is about to lapse. */
  quoteExpiryWarnDays: number;
  /** Whether to say anything at all when an unanswered quotation passes its validity date. */
  quoteExpiryNotice: boolean;
  /**
   * Whether a company created with no owner is given one automatically.
   *
   * Defaults ON, and that is a deliberate change of behaviour rather than an accident: the
   * alternative is a record nobody owns, which is invisible to every sales user — so the status quo
   * it replaces is worse than either outcome. It can only ever FILL an empty owner, so switching it
   * on cannot take a client away from anybody.
   */
  autoAssignOwner: boolean;
}

export const SALES_RULE_DEFAULTS: SalesRules = {
  quoteChaseDays: 5,
  quoteExpiryWarnDays: 3,
  quoteExpiryNotice: true,
  autoAssignOwner: true,
};

/** Bounds, so a typo in a settings box cannot switch a job off or make it fire every hour. */
const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
  // ABSENT IS NOT ZERO — see the same note in jobrules.ts. `Number(null)` and `Number("")` are 0,
  // which is finite, so without this line a cleared box clamps to the floor instead of restoring
  // the default: "chase an unanswered quotation after 1 day" from an empty field.
  if (n === null || n === undefined || n === "" || typeof n === "boolean") return dflt;
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
};

export async function salesRules(): Promise<SalesRules> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "salesRules" } });
    const raw = (row?.value ?? {}) as any;
    return {
      quoteChaseDays: clamp(raw.quoteChaseDays, 1, 90, SALES_RULE_DEFAULTS.quoteChaseDays),
      quoteExpiryWarnDays: clamp(raw.quoteExpiryWarnDays, 0, 30, SALES_RULE_DEFAULTS.quoteExpiryWarnDays),
      // Only an explicit false turns it off. An unset value must mean the default, not "off" —
      // a missing key silently disabling a notification is how something stops working unnoticed.
      quoteExpiryNotice: raw.quoteExpiryNotice === false ? false : SALES_RULE_DEFAULTS.quoteExpiryNotice,
      autoAssignOwner: raw.autoAssignOwner === false ? false : SALES_RULE_DEFAULTS.autoAssignOwner,
    };
  } catch {
    return { ...SALES_RULE_DEFAULTS };
  }
}
