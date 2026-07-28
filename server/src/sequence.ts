// ─────────────────────────────────────────────────────────────
// RECORD SEQUENCES
//
// One place that decides what a document is called. Numbering used to be hardcoded in several
// different shapes — `INV-${year}-` in two separate functions, a bare `QT-`, and nothing at all for
// tasks and receipts — so the firm could not change its own reference format without a code change.
//
// The format is a PATTERN, not a set of switches. A prefix-plus-optional-year pair cannot express
// "STM/2607/00042" or "INV-JUL-26-001", and every firm has its own house style, so the pattern is
// free text with tokens:
//
//   {YYYY} 2026   {YY} 26   {MM} 07   {MMM} JUL   {DD} 28   {####} zero-padded counter
//
// Anything outside braces is literal. The counter's width is how many #s you write.
//
// The counter is DERIVED, never stored. A stored counter is one more thing that drifts out of step
// with the rows it describes, which is exactly the bug that put duplicate numbers on tax documents
// in the first place. The pattern is resolved for today, turned into a regex, and matched against
// the numbers that exist — so it cannot disagree with reality, and a pattern whose date tokens have
// rolled over naturally starts a new run.
import { prisma } from "./db.js";

export type SeqKind = "task" | "request" | "invoice" | "quotation" | "receipt";
export const SEQ_KINDS: SeqKind[] = ["task", "request", "invoice", "quotation", "receipt"];

export interface SeqConfig { pattern: string }

// The formats already in use, so installing this renumbers nothing.
export const SEQ_DEFAULTS: Record<SeqKind, SeqConfig> = {
  task: { pattern: "TSK-{####}" },
  request: { pattern: "REQ-{####}" },
  invoice: { pattern: "INV-{YYYY}-{###}" },
  quotation: { pattern: "QT-{###}" },
  receipt: { pattern: "RCP-{YYYY}-{###}" },
};

export const SEQ_LABEL: Record<SeqKind, string> = {
  task: "Task", request: "Request", invoice: "Invoice", quotation: "Quotation", receipt: "Receipt",
};

/** Which model and column each sequence numbers. */
const TARGET: Record<SeqKind, { model: "task" | "serviceRequest" | "invoice" | "quotation" | "payment"; field: "ref" | "number" }> = {
  task: { model: "task", field: "ref" },
  request: { model: "serviceRequest", field: "number" },
  invoice: { model: "invoice", field: "number" },
  quotation: { model: "quotation", field: "number" },
  receipt: { model: "payment", field: "number" },
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Date tokens for a given day. The counter token is deliberately left alone. */
function dateTokens(d: Date): Record<string, string> {
  return {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: String(d.getMonth() + 1).padStart(2, "0"),
    MMM: MONTHS[d.getMonth()],
    DD: String(d.getDate()).padStart(2, "0"),
  };
}

export const SEQ_TOKENS = ["{YYYY}", "{YY}", "{MM}", "{MMM}", "{DD}", "{####}"];

/**
 * A pattern goes into a regex and onto printed documents, so it is constrained rather than trusted.
 * An unknown token is stripped — silently keeping `{FOO}` would print braces on an invoice — and a
 * pattern with no counter gets one appended, because without it every document would be named the
 * same thing.
 */
export function cleanConfig(kind: SeqKind, raw: any): SeqConfig {
  const d = SEQ_DEFAULTS[kind];
  let p = String(raw?.pattern ?? "").slice(0, 60);
  // Drop anything braced that is not a token we understand.
  p = p.replace(/\{[^}]*\}/g, (m) => {
    const inner = m.slice(1, -1).toUpperCase();
    if (/^#+$/.test(inner)) return "{" + inner.slice(0, 10) + "}";
    return SEQ_TOKENS.includes("{" + inner + "}") ? "{" + inner + "}" : "";
  });
  // Keep the character set to things that are safe in a document reference and in a filename.
  p = p.replace(/[^A-Za-z0-9{}#\-_/.]/g, "");
  if (!/\{#+\}/.test(p)) p = p ? p + "-{###}" : "";
  return { pattern: p || d.pattern };
}

export async function getSequences(): Promise<Record<SeqKind, SeqConfig>> {
  let stored: any = {};
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "recordSequence" } });
    if (row?.value && typeof row.value === "object") stored = row.value;
  } catch { /* unreadable settings must not stop a document being numbered */ }
  return SEQ_KINDS.reduce((m, k) => {
    const s = stored[k];
    // Migrate the first shape this setting had (prefix / padding / includeYear) rather than
    // silently resetting anyone who already configured it.
    const raw = (s && s.pattern == null && s.prefix)
      ? { pattern: `${String(s.prefix)}-${s.includeYear ? "{YYYY}-" : ""}{${"#".repeat(Math.min(10, Math.max(1, Number(s.padding) || 3)))}}` }
      : s;
    return { ...m, [k]: cleanConfig(k, raw) };
  }, {} as Record<SeqKind, SeqConfig>);
}

export async function saveSequences(raw: any): Promise<Record<SeqKind, SeqConfig>> {
  const clean = SEQ_KINDS.reduce((m, k) => ({ ...m, [k]: cleanConfig(k, raw?.[k]) }), {} as Record<SeqKind, SeqConfig>);
  await prisma.appSetting.upsert({ where: { key: "recordSequence" }, create: { key: "recordSequence", value: clean as any }, update: { value: clean as any } });
  return clean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The pattern with date tokens filled in and the counter left as `{####}`. */
function resolveDates(pattern: string, now: Date): string {
  const t = dateTokens(now);
  return pattern.replace(/\{([A-Z]+)\}/g, (m, k) => (t[k] !== undefined ? t[k] : m));
}

/** Render a full reference for a given counter value. */
export function render(pattern: string, n: number, now = new Date()): string {
  return resolveDates(pattern, now).replace(/\{(#+)\}/, (_m, hashes) => String(n).padStart(hashes.length, "0"));
}

/** What the first number of today's run looks like — used for the settings preview. */
export function sampleFor(cfg: SeqConfig, now = new Date()): string {
  return render(cfg.pattern, 1, now);
}

/**
 * A regex that matches references issued under this pattern TODAY, capturing the counter.
 *
 * Everything except the counter is anchored literally, which is what keeps the runs separate: change
 * the pattern, or let a date token roll over, and yesterday's numbers no longer match — so the new
 * run starts at 1 and existing documents keep the reference they were issued with.
 */
function matcher(pattern: string, now: Date): RegExp {
  const resolved = resolveDates(pattern, now);
  const parts = resolved.split(/\{#+\}/);
  const width = (resolved.match(/\{(#+)\}/) || [, "###"])[1].length;
  return new RegExp("^" + parts.map(escapeRe).join(`(\\d{${width},})`) + "$");
}

export async function nextNumber(kind: SeqKind, now = new Date()): Promise<string> {
  const cfg = (await getSequences())[kind];
  const { model, field } = TARGET[kind];
  const re = matcher(cfg.pattern, now);
  // No `where`: the field is nullable on task/payment but required on invoice/quotation, so a null
  // filter is a type error on half of them. The regex rejects nulls and foreign formats anyway.
  const rows = await (prisma[model] as any).findMany({ select: { [field]: true } });
  const next = rows.reduce((m: number, r: any) => {
    const hit = re.exec(String(r[field] ?? ""));
    return hit ? Math.max(m, parseInt(hit[1], 10) || 0) : m;
  }, 0) + 1;
  return render(cfg.pattern, next, now);
}
