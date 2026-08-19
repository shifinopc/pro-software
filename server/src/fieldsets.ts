/**
 * Field sets — the fields a step records, kept where they can be managed.
 *
 * A step's captures were written into the graph, which put them out of reach of everybody except
 * whoever edits the workflow. Adding one question to the intake form meant a code change. The same
 * argument that moved the government document lists into checklist rules applies here one layer in,
 * so this is deliberately the same shape: rows of `{ conditions, fields }`, evaluated with the one
 * `matchCond` both halves already share, so there is a single rule syntax in this system rather than
 * a second one that looks similar and behaves differently.
 *
 * A row with no conditions is the base set. Every matching row contributes and the result is merged
 * BY VARIABLE NAME, later rows winning — which is what lets one set ask a transfer for their current
 * employer and a new hire for their passport, instead of two sets or two steps.
 */
import { matchCond } from "./dealchecklist.js";

export type CaptureField = {
  /** The run variable this writes to. Decisions, rules, clocks and notify templates match on it. */
  var: string;
  label: string;
  type: string;
  required: boolean;
  /**
   * A comma-separated list of values, matching what a step's own captures already store and what
   * the engine's select validation compares against. Deliberately NOT an array of objects: the
   * console renders both halves with one control, and two shapes for one idea is how a dropdown
   * comes to offer choices the validator then refuses.
   */
  options?: string;
  help?: string;
};

const str = (v: unknown) => String(v ?? "").trim();

/** A variable name that cannot collide with the engine's own state or break a `{{ }}` binding. */
export function varName(raw: unknown): string {
  const s = str(raw)
    .replace(/[^A-Za-z0-9 _-]/g, " ")
    .trim()
    .replace(/[\s_-]+(.)/g, (_m, c) => String(c).toUpperCase())
    .replace(/[\s_-]+/g, "");
  const head = s.charAt(0).toLowerCase() + s.slice(1);
  // A leading underscore is how the engine marks its own keys (_delays, _clocks). A field may not
  // claim one, or a set could overwrite the run's internal state from a settings screen.
  return head.replace(/^_+/, "");
}

/**
 * The one place a field's shape is settled, so a set written on the screen and a set installed from
 * a pack cannot disagree about what a field is.
 *
 * A field with no variable is dropped rather than defaulted: it would collect a value into nowhere,
 * and every downstream reader matches on that name. A select with no options is downgraded to text
 * for the same reason a document item with no type degrades to manual — offering a dropdown that
 * can never be answered is worse than asking plainly.
 */
export function normalizeFields(raw: unknown): CaptureField[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptureField[] = [];
  for (const r of raw as any[]) {
    const v = varName((r as any)?.var ?? (r as any)?.name ?? (r as any)?.label);
    if (!v) continue;
    const label = str((r as any)?.label) || v;
    // Accepts every shape somebody might send — a string, a list of strings, a list of objects —
    // and stores one.
    const rawOpts = (r as any)?.options;
    const options = (Array.isArray(rawOpts)
      ? rawOpts.map((o: any) => (o && typeof o === "object" ? str(o.value ?? o.label) : str(o)))
      : str(rawOpts).split(",")
    ).map(str).filter(Boolean).join(",");
    let type = str((r as any)?.type) || "text";
    if (type === "dropdown") type = "select";
    if (type === "select" && !options.length) type = "text";
    out.push({
      var: v,
      label,
      type,
      // Absent means required, matching the checklist side. The audit's S1 lesson was about a
      // capture nobody could skip on a REFUSAL path; that is fixed per-field with required:false
      // plus a rule, not by flipping this default, which would let a run reach the end blank.
      required: (r as any)?.required !== false,
      ...(options.length ? { options } : {}),
      ...(str((r as any)?.help) ? { help: str((r as any)?.help) } : {}),
    });
  }
  return out;
}

/** Which rows match these facts, and the fields that results in. Merged by variable name. */
export function evaluateFieldSet(rows: unknown, facts: Record<string, any>): { fields: CaptureField[]; matched: number[] } {
  const merged: Record<string, CaptureField> = {};
  const matched: number[] = [];
  (Array.isArray(rows) ? rows : []).forEach((row: any, ix: number) => {
    const conds: any[] = Array.isArray(row?.conditions) ? row.conditions : [];
    if (!conds.every(c => matchCond(facts[str(c?.var)], str(c?.op), c?.value))) return;
    matched.push(ix);
    for (const f of normalizeFields(row?.fields ?? row?.captures ?? row?.items)) merged[f.var] = f;
  });
  return { fields: Object.values(merged), matched };
}
