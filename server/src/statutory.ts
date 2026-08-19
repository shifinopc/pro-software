/**
 * Deadlines the Kingdom sets, as opposed to the ones this office sets itself.
 *
 * The workflow tracked SLAs and nothing else. An SLA is a promise made internally and missing one is
 * explained internally; the clocks here are law, and missing them costs money or forecloses the
 * option entirely. Three of them run through a single onboarding and none was modelled:
 *
 *   · the residence permit must be issued within 90 days of entry to the Kingdom;
 *   · a non-Saudi must be registered with GOSI by the 15th of the month following the start of work
 *     — and cannot be registered retroactively, so this one does not go late, it goes impossible;
 *   · wages must reach the employee and appear on WPS within 30 days of falling due.
 *
 * WHY THE CLOCK IS ON THE STEP AND THE NUMBER IS IN COUNTRY RULES.
 *
 * A document type knows how long the law allows and what the law is: that belongs in Country Rules,
 * where somebody maintaining Saudi regulations can see all of it in one place, and where it travels
 * in a country pack. What a document type cannot know is WHEN the clock started — entry to the
 * Kingdom is a fact about one run, on one date, for one person. So the step names the run variable
 * that holds the starting date and the type supplies the rest.
 *
 * NOTHING IS INVENTED. A deadline the platform made up is worse than no deadline: it would be
 * enforced with the same confidence and be wrong. Every clock carries the source it came from, and a
 * step whose starting date has not been captured yet produces no deadline at all rather than one
 * counted from today.
 */

export type StatutoryClock = {
  /** Stable id for the clock, so a re-evaluation updates rather than duplicates. */
  key: string;
  /** What it is, in the words of whoever has to meet it. */
  label: string;
  /** ISO date the obligation falls due. */
  due: string;
  /** The regulation, service page or article this comes from. */
  basis?: string | null;
  /** Which run variable the clock was counted from, and the date it held. */
  from?: string | null;
  fromDate?: string | null;
};

/** How a due date is derived from the starting date. */
export type StatutoryRule = "days" | "by_15th_next_month";

export type StatutorySpec = {
  key?: string;
  label?: string;
  /** Run variable holding the starting date. A comma-separated list takes the first one that is set. */
  from?: string;
  rule?: StatutoryRule;
  days?: number;
  basis?: string | null;
  /** Look the days and the source up from this document type instead of stating them here. */
  docType?: string;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A date somebody typed, or nothing. Rejects the unparseable rather than guessing. */
function parseDate(v: any): Date | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const t = new Date(s.length <= 10 ? s + "T00:00:00Z" : s);
  return isNaN(t.getTime()) ? null : t;
}

/**
 * The 15th of the month AFTER the one the start date falls in.
 *
 * Written out rather than done with day arithmetic because "a month later" is not 30 days and is not
 * the same length twice: a 31 January start is due 15 February, and adding days would land it in
 * March in a leap year and February otherwise. Month-and-year are incremented directly, so the
 * December rollover is the only edge case and it is handled by the modulo.
 */
function fifteenthOfNextMonth(start: Date): Date {
  const y = start.getUTCFullYear(), m = start.getUTCMonth();
  return new Date(Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 15));
}

/**
 * Every clock running on one step, given what the run currently knows.
 *
 * Silent about what it cannot answer. A spec whose starting date has not been captured yet is not an
 * error and not a deadline of today — it is a clock that has not started, and it will be computed
 * when the step that captures the date has been done.
 */
export function clocksFor(
  specs: StatutorySpec | StatutorySpec[] | null | undefined,
  vars: Record<string, any>,
  types: Map<string, { statutoryDays?: number | null; statutoryFrom?: string | null; statutoryBasis?: string | null }> = new Map(),
): StatutoryClock[] {
  const list = Array.isArray(specs) ? specs : specs ? [specs] : [];
  const out: StatutoryClock[] = [];

  for (const [i, spec] of list.entries()) {
    if (!spec) continue;
    const type = spec.docType ? types.get(spec.docType) : undefined;

    // The starting date: the first named variable the run actually holds.
    let fromVar: string | null = null, start: Date | null = null;
    for (const name of String(spec.from ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
      const d = parseDate(vars[name]);
      if (d) { fromVar = name; start = d; break; }
    }
    if (!start) continue;

    const rule: StatutoryRule = spec.rule ?? "days";
    let due: Date;
    if (rule === "by_15th_next_month") {
      due = fifteenthOfNextMonth(start);
    } else {
      const days = Number(spec.days ?? type?.statutoryDays ?? NaN);
      if (!isFinite(days) || days <= 0) continue;   // no number, no invented deadline
      due = new Date(start.getTime() + days * 86400000);
    }

    out.push({
      key: String(spec.key ?? spec.docType ?? `clock${i + 1}`),
      label: String(spec.label ?? (spec.docType ? `${spec.docType} — statutory deadline` : "Statutory deadline")),
      due: iso(due),
      basis: spec.basis ?? type?.statutoryBasis ?? null,
      from: fromVar,
      fromDate: iso(start),
    });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** The binding one — the earliest, since meeting a later deadline does not excuse an earlier. */
export const earliest = (clocks: StatutoryClock[]): string | null =>
  clocks.length ? clocks.map(c => c.due).sort()[0] : null;

/** How a breach reads to the person who has to answer for it. */
export function breachMessage(c: StatutoryClock, title: string): string {
  return `⚠ Statutory deadline passed — ${c.label} was due ${c.due}` +
    (c.from ? ` (counted from ${c.fromDate})` : "") +
    `, and "${title}" is still open.` + (c.basis ? ` ${c.basis}` : "");
}
