/**
 * How much one person counts for.
 *
 * Nationalisation ratios are not always a headcount. Saudi Nitaqat counts an employee with a
 * disability as FOUR Saudi employees; several regimes count a part-timer as a half. Until now every
 * person here counted as exactly one, and the schema said so out loud in two places — `employmentType`
 * and `jobCategory` both carry comments about regimes that count fractionally — without anything
 * implementing it.
 *
 * WHY THE RULES ARE NOT IN THIS FILE
 *
 * They are published by the same authority that publishes the band thresholds, they change on the
 * same schedule, and a multiplier means nothing apart from the ladder it feeds. So they live on the
 * ladder, travel in a country pack, and are set up on the client's own screen. This module only
 * knows how to APPLY a rule, never what any rule says — the same discipline that stops the app
 * inventing a band.
 *
 * WEIGHTS ARE INTEGERS IN HUNDREDTHS. 400 is "counts as four", 50 is "counts as a half". A weight
 * held as a float would put a client on the wrong side of a threshold it was meant to help them
 * clear, which is the one failure this whole area is built to avoid.
 */
import { sameCountry } from "./countries.js";

export type CountingRule = {
  /** Stored on the employee. The multiplier, wording and condition stay with the rule. */
  key: string;
  label: string;
  /** What must be true of the person. `nationality: "national" | "expat"` is the one that matters. */
  when?: Record<string, string>;
  /** Read an existing column instead of asking — "employmentType=part_time". */
  from?: string;
  /** Hundredths. 400 = x4, 50 = x0.5. */
  countsAs: number;
  /** "both" (default) weights the ratio AND the total; "nationals" weights only the ratio. */
  appliesTo?: "both" | "nationals";
  help?: string;
};

export type Weighted = {
  /** Hundredths. What this person contributes to the nationals figure. 0 for a non-national. */
  num: number;
  /** Hundredths. What they contribute to the workforce total. */
  den: number;
  /** The rules that fired, for the working shown on screen. */
  applied: { key: string; label: string; countsAs: number }[];
};

const ONE = 100;

export function normalizeRules(raw: unknown): CountingRule[] {
  if (!Array.isArray(raw)) return [];
  const out: CountingRule[] = [];
  for (const r of raw as any[]) {
    const key = String(r?.key ?? "").trim();
    if (!key) continue;
    const countsAs = Math.round(Number(r?.countsAs));
    // A rule with no usable multiplier is dropped rather than defaulted to 1. Defaulted, it would
    // sit on the form as a tick box that changes nothing — which reads as the feature being broken.
    if (!Number.isFinite(countsAs) || countsAs < 0) continue;
    out.push({
      key,
      label: String(r?.label ?? key).trim() || key,
      countsAs,
      ...(r?.when && typeof r.when === "object" ? { when: r.when as Record<string, string> } : {}),
      ...(String(r?.from ?? "").trim() ? { from: String(r.from).trim() } : {}),
      appliesTo: r?.appliesTo === "nationals" ? "nationals" : "both",
      ...(String(r?.help ?? "").trim() ? { help: String(r.help).trim() } : {}),
    });
  }
  return out;
}

/** Whether a rule's `when` holds for a person being counted as a national or not. */
export function ruleApplies(rule: CountingRule, emp: any, isNational: boolean): boolean {
  const when = rule.when ?? {};
  for (const [k, v] of Object.entries(when)) {
    const want = String(v ?? "").trim().toLowerCase();
    if (!want) continue;
    if (k === "nationality") {
      if (want === "national" && !isNational) return false;
      if (want === "expat" && isNational) return false;
      // A named country, rather than the national/expat shorthand.
      if (want !== "national" && want !== "expat" && !sameCountry(want, String(emp?.nationality ?? ""))) return false;
      continue;
    }
    if (String((emp ?? {})[k] ?? "").trim().toLowerCase() !== want) return false;
  }
  return true;
}

/** Whether the person is actually claimed under the rule — a tick box, or a column that says so. */
function claimed(rule: CountingRule, emp: any, traits: Set<string>): boolean {
  if (rule.from) {
    const [col, want] = rule.from.split("=");
    return String((emp ?? {})[String(col).trim()] ?? "").trim().toLowerCase() === String(want ?? "").trim().toLowerCase();
  }
  return traits.has(rule.key);
}

export function traitsOf(emp: any): Set<string> {
  const raw = (emp ?? {}).countingTraits;
  return new Set((Array.isArray(raw) ? raw : []).map((x: any) => String(x ?? "").trim()).filter(Boolean));
}

/**
 * What one person contributes, as hundredths, to the ratio and to the total.
 *
 * MATCHING RULES COMPOUND. A part-time Saudi with a disability comes out at 4 x 0.5 = 2, not at 4 and
 * not at 0.5. It is composable and every rule that fired is returned so the arithmetic can be read
 * back and checked against the portal — which is the point. If a regulator turns out to mean "the
 * single most favourable rule", that is one line here and the working already shows which fired.
 */
export function weighFor(rules: CountingRule[], emp: any, isNational: boolean): Weighted {
  const traits = traitsOf(emp);
  const applied: Weighted["applied"] = [];
  let num = isNational ? ONE : 0;
  let den = ONE;
  for (const r of rules) {
    if (!ruleApplies(r, emp, isNational) || !claimed(r, emp, traits)) continue;
    applied.push({ key: r.key, label: r.label, countsAs: r.countsAs });
    // A rule conditioned on being a national has nothing to say about a person's place in the total
    // when they are not one, so it never touches `den` for them.
    if (num > 0) num = Math.round((num * r.countsAs) / ONE);
    if (r.appliesTo !== "nationals" && (isNational || !r.when?.nationality)) {
      den = Math.round((den * r.countsAs) / ONE);
    }
  }
  return { num, den, applied };
}

/** "counts as 4" / "counts as a half" — hundredths said the way a person would say them. */
export function weightWord(countsAs: number): string {
  if (countsAs === 50) return "counts as a half";
  const n = countsAs / ONE;
  const pretty = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
  return `counts as ${pretty}`;
}
