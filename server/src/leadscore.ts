/**
 * HOW PROMISING IS THIS LEAD, AND WHY.
 *
 * A lead score is the easiest number in a CRM to fabricate and the hardest to make honest. Every
 * product ships one; most are a weighted sum of hand-typed guesses, presented to two decimal places.
 * The failure is not that the guesses are wrong — it is that nothing on screen distinguishes a
 * number built from six real measurements from one built from none, so people either trust it when
 * they should not or ignore it when they should not.
 *
 * Three rules make this one worth reading:
 *
 * 1. DERIVED ON READ, NEVER STORED. A stored score is stale the moment somebody logs a call. There
 *    is no `score` column and no nightly job to keep it fresh, because there is nothing to keep.
 *
 * 2. AN UNMEASURABLE COMPONENT IS EXCLUDED, NOT ZEROED. This is the "absent is not zero" rule that
 *    already bit the settings clamps and the invoice guard. If we cannot yet tell whether a source
 *    converts — and with no closed deals we cannot — that component leaves BOTH sides of the
 *    fraction. Scoring it zero would quietly mark every lead down for a fact nobody has.
 *
 * 3. EVERY SCORE CARRIES ITS OWN WORKING. `components` is the arithmetic, in words. A salesperson
 *    who disagrees with a score can see exactly which line they disagree with, which is the only
 *    thing that makes a score arguable rather than authoritative.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: industry, company size, job title, "fit". Those are the fields
 * a generic B2B scoring model uses and this firm does not reliably capture — a model reading mostly
 * empty columns produces confident noise. What is here is what this system actually observes:
 * whether you can reach them, whether anybody has, how recently, and whether it got as far as money.
 */
import { prisma } from "./db.js";
import { looksLikeEmail, looksLikePhone } from "./validate.js";
// `status` is not a column — a deal is won or lost because of the STAGE it sits in, and statusOf is
// the one place that is decided. Re-deriving it here would be a second definition free to drift.
import { statusOf } from "./pipeline.js";

/** Below this many decided deals, per-source conversion is noise and is not used at all. */
const SOURCE_HISTORY_MIN = 8;

export interface ScoreComponent {
  label: string;
  /** Points earned, and the most this component can be worth. Null earned = not measurable. */
  earned: number | null;
  max: number;
  why: string;
}

export interface LeadScore {
  companyId: string;
  /** 0–100, normalised over the components that could actually be measured. */
  score: number;
  band: "hot" | "warm" | "cold";
  /** What fraction of the model was available. 100 = every component measurable. */
  coveragePct: number;
  components: ScoreComponent[];
  /** One line a person can act on: the biggest thing dragging this lead down. */
  weakest: string | null;
}

const daysSince = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
};

/**
 * Per-source conversion, learned from this firm's own closed business.
 *
 * Returns null until there is enough of it. A hand-typed "Website = 30 points" is a guess wearing a
 * number's clothes; this is either measured or absent, and absent is stated rather than defaulted.
 */
export async function sourceConversion(): Promise<Map<string, number> | null> {
  const decided = await prisma.company.findMany({
    where: { lifecycle: { in: ["client", "lost", "churned"] } },
    select: { source: true, lifecycle: true },
  });
  if (decided.length < SOURCE_HISTORY_MIN) return null;

  const tally = new Map<string, { won: number; total: number }>();
  for (const c of decided) {
    const key = String(c.source ?? "").trim() || "(not recorded)";
    const t = tally.get(key) ?? { won: 0, total: 0 };
    t.total++;
    if (c.lifecycle === "client") t.won++;
    tally.set(key, t);
  }
  // A source with almost no history of its own is as unusable as no history at all.
  const out = new Map<string, number>();
  for (const [k, v] of tally) if (v.total >= 3) out.set(k, v.won / v.total);
  return out.size ? out : null;
}

/** Score one lead. `conv` is passed in so scoring a list does not re-query per row. */
export async function scoreLead(
  company: { id: string; source?: string | null; city?: string | null; cr?: string | null; contact?: string | null; email?: string | null; phone?: string | null; createdAt?: string | null },
  ctx: { interactions: { at: string }[]; hasOpenDeal: boolean; dealHasValue: boolean; conv: Map<string, number> | null },
): Promise<LeadScore> {
  const c: ScoreComponent[] = [];

  // ── Can we reach them at all? ──────────────────────────────────────────────────────────────
  // First because it gates everything else: a lead nobody can contact is not a lead, it is a note.
  const email = String(company.email ?? "").trim();
  const phone = String(company.phone ?? "").trim();
  const goodEmail = !!email && looksLikeEmail(email);
  const goodPhone = !!phone && looksLikePhone(phone);
  c.push({
    label: "Reachable",
    earned: (goodEmail ? 15 : 0) + (goodPhone ? 10 : 0),
    max: 25,
    why: goodEmail && goodPhone ? "Email and phone both on file"
      : goodEmail ? "Email only — no phone number"
      : goodPhone ? "Phone only — no email address"
      : "No way to contact this lead",
  });

  // ── Has anybody actually spoken to them? ───────────────────────────────────────────────────
  const n = ctx.interactions.length;
  c.push({
    label: "Contact made",
    earned: n === 0 ? 0 : n === 1 ? 8 : n === 2 ? 14 : 20,
    max: 20,
    why: n === 0 ? "Nobody has logged a conversation yet" : `${n} conversation${n === 1 ? "" : "s"} logged`,
  });

  // ── How recently? ──────────────────────────────────────────────────────────────────────────
  // Interest decays. A lead spoken to yesterday and one spoken to in March are not the same lead,
  // and a score that ignores time makes an old list look permanently healthy.
  const last = ctx.interactions.map(i => daysSince(i.at)).filter((d): d is number => d !== null).sort((a, b) => a - b)[0];
  c.push({
    label: "Still warm",
    earned: last === undefined ? 0 : last <= 3 ? 20 : last <= 7 ? 15 : last <= 14 ? 10 : last <= 30 ? 5 : 0,
    max: 20,
    why: last === undefined ? "No dated conversation to measure from"
      : last === 0 ? "Spoken to today"
      : `Last spoken to ${last} day${last === 1 ? "" : "s"} ago`,
  });

  // ── Did it get as far as money? ────────────────────────────────────────────────────────────
  c.push({
    label: "On the board",
    earned: !ctx.hasOpenDeal ? 0 : ctx.dealHasValue ? 20 : 12,
    max: 20,
    why: !ctx.hasOpenDeal ? "No deal opened for them yet"
      : ctx.dealHasValue ? "Deal on the pipeline with a figure against it"
      : "Deal on the pipeline, but unpriced",
  });

  // ── Do we know who and where they are? ─────────────────────────────────────────────────────
  const known = [company.contact, company.city, company.source, company.cr].filter(x => String(x ?? "").trim()).length;
  c.push({
    label: "Record filled in",
    earned: Math.round((known / 4) * 15),
    max: 15,
    why: known === 4 ? "Contact, city, source and CR all recorded" : `${known} of 4 details recorded (contact, city, source, CR)`,
  });

  // ── Does this source convert? MEASURED, or left out entirely. ──────────────────────────────
  const srcKey = String(company.source ?? "").trim() || "(not recorded)";
  const rate = ctx.conv?.get(srcKey);
  c.push({
    label: "Source track record",
    earned: ctx.conv == null || rate === undefined ? null : Math.round(rate * 20),
    max: 20,
    why: ctx.conv == null
      ? `Not enough closed business yet to tell — needs ${SOURCE_HISTORY_MIN} decided leads`
      : rate === undefined ? `Too few decided leads from "${srcKey}" to judge it`
      : `${Math.round(rate * 100)}% of leads from "${srcKey}" became clients`,
  });

  // Normalise over what was measurable. A component we could not measure leaves both sides of the
  // fraction — scoring it zero would mark every lead down for a fact nobody has.
  const usable = c.filter(x => x.earned !== null);
  const earned = usable.reduce((s, x) => s + (x.earned ?? 0), 0);
  const possible = usable.reduce((s, x) => s + x.max, 0);
  const total = c.reduce((s, x) => s + x.max, 0);
  const score = possible ? Math.round((earned / possible) * 100) : 0;

  // The single biggest gap, so the score comes with something to do about it.
  const gaps = usable.filter(x => (x.earned ?? 0) < x.max).sort((a, b) => (b.max - (b.earned ?? 0)) - (a.max - (a.earned ?? 0)));

  return {
    companyId: company.id,
    score,
    band: score >= 70 ? "hot" : score >= 40 ? "warm" : "cold",
    coveragePct: Math.round((possible / total) * 100),
    components: c,
    weakest: gaps.length ? gaps[0].why : null,
  };
}

/** Score every open lead in one pass — one query per table, not per lead. */
export async function scoreOpenLeads(): Promise<LeadScore[]> {
  const leads = await prisma.company.findMany({
    where: { lifecycle: { in: ["lead", "prospect"] } },
    select: { id: true, source: true, city: true, cr: true, contact: true, email: true, phone: true, createdAt: true },
  });
  if (!leads.length) return [];
  const ids = leads.map(l => l.id);

  const [ints, opps, conv] = await Promise.all([
    prisma.interaction.findMany({ where: { companyId: { in: ids } }, select: { companyId: true, at: true } }),
    prisma.opportunity.findMany({ where: { companyId: { in: ids } }, select: { companyId: true, valueMinor: true, stage: { select: { isWon: true, isLost: true } } } }),
    sourceConversion(),
  ]);

  const byCo = new Map<string, { at: string }[]>();
  for (const i of ints) (byCo.get(i.companyId) ?? byCo.set(i.companyId, []).get(i.companyId)!).push({ at: i.at });
  const dealBy = new Map<string, { open: boolean; priced: boolean }>();
  for (const o of opps) {
    const live = statusOf(o.stage) === "open";
    const cur = dealBy.get(o.companyId) ?? { open: false, priced: false };
    if (live) { cur.open = true; if (o.valueMinor != null) cur.priced = true; }
    dealBy.set(o.companyId, cur);
  }

  return Promise.all(leads.map(l => scoreLead(l, {
    interactions: byCo.get(l.id) ?? [],
    hasOpenDeal: dealBy.get(l.id)?.open ?? false,
    dealHasValue: dealBy.get(l.id)?.priced ?? false,
    conv,
  })));
}
