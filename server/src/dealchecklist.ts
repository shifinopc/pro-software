/**
 * WHAT A DEAL STILL OWES BEFORE IT CAN MOVE.
 *
 * The operations half of this system has had a good checklist engine for a long time: conditional
 * rows, country-scoped, packable, snapshotted onto the task so later edits do not rewrite work in
 * flight. The sales half had nothing. This is that engine pointed at a deal.
 *
 * TWO KINDS OF ITEM, ON ONE LIST. That is the whole design:
 *
 *   manual    somebody says it happened — "budget confirmed", "decision-maker met". There is no
 *             record behind it, so a person ticking it IS the record.
 *   document  satisfied when a live Document of that type exists for the deal's company. NEVER
 *             ticked by hand, and deliberately not stored as state: a checklist that has to be
 *             maintained alongside reality is a second to-do list, and the two disagree within a
 *             week. Derived on read, it is a status.
 *
 * That distinction is why the state column holds manual ticks only. A stored tick for a document
 * item could contradict the documents themselves, and the stored one would win — which is exactly
 * the failure that makes people stop trusting a checklist.
 *
 * WHAT A DEAL CAN BE ASKED ABOUT. A workflow run has captures; a deal has only what it already
 * holds. Those facts are assembled in `factsFor` below and are the entire vocabulary a rule may
 * condition on — no new data entry, because a checklist that first demands its own inputs is worse
 * than no checklist.
 */
import { prisma } from "./db.js";

export interface DealChecklistItem {
  key: string;
  label: string;
  required: boolean;
  /** "manual" | "document" */
  source: string;
  /** For a document item: the DocumentType name it is satisfied by. */
  docType?: string | null;
}

export interface ItemStatus extends DealChecklistItem {
  done: boolean;
  /** How it came to be done, so the screen never implies somebody ticked a document. */
  how: "manual" | "document" | "waived" | null;
  /** For a document item that IS satisfied: which document satisfied it. */
  evidence?: string | null;
}

const str = (v: unknown) => String(v ?? "").trim();

/** Same operators the workflow's checklist rules use, so one rule syntax covers both halves. */
/**
 * THE one condition test, and THE one rule evaluator.
 *
 * There were two. workflow.ts carried its own copy that knew eq/ne/contains/in but NOT gte/lte, so
 * a rule reading "employees gte 50" filtered correctly on a pipeline stage and, on a workflow step,
 * fell through to the default and matched EVERY time — quietly adding documents to cases that
 * should not have asked for them. The same rule cannot mean two things depending on where it is
 * attached, so both callers and the rule tester now come here.
 */
export function matchCond(left: any, op: string, right: any): boolean {
  const L = String(left ?? "").toLowerCase(), R = String(right ?? "").toLowerCase();
  switch (op) {
    case "eq": return L === R;
    case "ne": return L !== R;
    case "contains": return L.includes(R);
    case "in": return R.split(",").map(s => s.trim()).includes(L);
    case "gte": return Number(left) >= Number(right);
    case "lte": return Number(left) <= Number(right);
    default: return true;   // blank op → always applies, the base set
  }
}

/**
 * Which rows match these facts, and the documents that results in.
 *
 * Every matching row CONTRIBUTES; the result is the union keyed by document, so a document named by
 * two rows appears once and the later row wins its required flag. A row with no conditions always
 * applies — that is the base set.
 */
export function evaluateRule(rows: any[], facts: Record<string, any>): { items: DealChecklistItem[]; matched: number[] } {
  const merged: Record<string, DealChecklistItem> = {};
  const matched: number[] = [];
  (Array.isArray(rows) ? rows : []).forEach((row, ix) => {
    const conds: any[] = Array.isArray(row?.conditions) ? row.conditions : [];
    if (!conds.every(c => matchCond(facts[String(c?.var ?? "")], String(c?.op ?? ""), c?.value))) return;
    matched.push(ix);
    for (const it of normalizeItems(row?.documents || row?.items || [])) merged[it.key] = it;
  });
  return { items: Object.values(merged), matched };
}

export function normalizeItems(raw: unknown): DealChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DealChecklistItem[] = [];
  for (const r of raw as any[]) {
    const key = str(r?.key), label = str(r?.label) || key;
    if (!key) continue;
    const source = str(r?.source) === "document" ? "document" : "manual";
    out.push({
      key, label,
      required: r?.required !== false,
      source,
      // A document item with no type names nothing and could never be satisfied, so it degrades to
      // manual rather than sitting on the list permanently unsatisfiable.
      docType: source === "document" ? (str(r?.docType) || null) : null,
    });
  }
  return out.map(i => (i.source === "document" && !i.docType ? { ...i, source: "manual", docType: null } : i));
}

/**
 * The facts a rule may test. Everything here is already on the deal or its client — nothing asks a
 * salesperson to fill in a form so that a checklist can decide what to ask them for.
 */
export function factsFor(deal: any, company: any): Record<string, any> {
  return {
    source: deal?.source ?? "",
    country: deal?.country ?? company?.country ?? "",
    /** Major units, so a rule reads "value gte 50000" rather than in halalas. */
    value: deal?.valueMinor != null ? Math.round(deal.valueMinor / 100) : 0,
    hasQuotation: deal?.quotationId ? "yes" : "no",
    lifecycle: company?.lifecycle ?? "",
    // Real columns on Company, checked rather than assumed — an earlier draft of this listed a
    // `clientType` that does not exist, which would have made every rule testing it match nothing
    // and look like the rule engine was broken.
    industry: company?.industry ?? "",
    city: company?.city ?? "",
    /** Headcount, so a rule can read "employees gte 50 → needs a GOSI certificate". */
    employees: company?.employees ?? 0,
    stage: deal?.stage?.name ?? "",
  };
}

/**
 * THE list for this deal — snapshot if it has one, otherwise the stage's list resolved now.
 *
 * Exported because the read path and the WRITE path must agree about what is on the checklist. They
 * did not: the reader fell back to the live list while the tick route validated against the snapshot
 * alone, so every item on a deal that had never been moved under a checklist was displayed and then
 * refused with "that is not on this deal's checklist". One definition, used by both.
 */
export async function effectiveItems(deal: any, company: any, stage?: any): Promise<DealChecklistItem[]> {
  const snap = normalizeItems(deal?.checklist);
  if (snap.length) return snap;
  return stage ? itemsForStage(stage, deal, company) : [];
}

/** The items this stage asks of this deal, resolved now. */
export async function itemsForStage(stage: any, deal: any, company: any): Promise<DealChecklistItem[]> {
  if (!stage) return [];
  if (stage.checklistSource === "dynamic" && stage.checklistRuleId) {
    const rule = await prisma.checklistRule.findUnique({ where: { id: String(stage.checklistRuleId) } });
    const rows: any[] = Array.isArray((rule as any)?.rows) ? (rule as any).rows : [];
    const { items } = evaluateRule(rows, factsFor(deal, company));
    // Falls through to the static list rather than returning nothing: a rule whose conditions all
    // missed should not silently mean "this stage asks for nothing".
    if (items.length) return items;
  }
  return normalizeItems(stage.checklistItems);
}

/**
 * Every item with whether it is done, and HOW.
 *
 * Document items are resolved against the company's live documents in one query rather than one per
 * item. `status: "valid"` is the test — an expired passport is not a satisfied requirement, and
 * treating it as one is how a deal reaches contract with a document nobody can use.
 */
export async function statusFor(deal: any, company: any, stage?: any): Promise<ItemStatus[]> {
  // The snapshot, or — when there is none — the stage's list resolved LIVE.
  //
  // Every deal already in the pipeline predates its stage having a checklist, so it carries no
  // snapshot. Without this fallback, configuring a stage's list would have no effect on a single
  // deal currently sitting in it: the rule would appear to do nothing until each deal happened to
  // move stage, which reads as the feature being broken. No snapshot means "never entered under a
  // checklist", and the honest answer for those is what the stage asks for today.
  const items = await effectiveItems(deal, company, stage);
  if (!items.length) return [];

  const manual: Record<string, any> = (deal?.checklistState && typeof deal.checklistState === "object") ? deal.checklistState : {};
  const waived: Record<string, any> = (deal?.checklistWaived && typeof deal.checklistWaived === "object") ? deal.checklistWaived : {};

  const docTypes = [...new Set(items.filter(i => i.source === "document" && i.docType).map(i => i.docType as string))];
  const docs = docTypes.length && company?.id
    ? await prisma.document.findMany({
        where: { companyId: company.id, docType: { in: docTypes }, status: "valid" },
        select: { docType: true, docNumber: true, expiryDate: true },
      })
    : [];

  return items.map(i => {
    if (waived[i.key]) {
      return { ...i, done: true, how: "waived" as const, evidence: str(waived[i.key]?.reason) || null };
    }
    if (i.source === "document") {
      const hit = docs.find(d => d.docType === i.docType);
      return {
        ...i,
        done: !!hit,
        how: hit ? ("document" as const) : null,
        evidence: hit ? [i.docType, hit.docNumber, hit.expiryDate ? "expires " + hit.expiryDate : null].filter(Boolean).join(" · ") : null,
      };
    }
    const t = manual[i.key];
    return { ...i, done: !!t?.done, how: t?.done ? ("manual" as const) : null, evidence: str(t?.by) || null };
  });
}

/** The required items still outstanding — the sentence a refused move is built from. */
export async function blockersFor(deal: any, company: any, stage?: any): Promise<ItemStatus[]> {
  return (await statusFor(deal, company, stage)).filter(i => i.required && !i.done);
}

/** For the card: "3 of 7", and whether anything required is missing. */
export async function summaryFor(deal: any, company: any, stage?: any) {
  const all = await statusFor(deal, company, stage);
  return countsOf(all);
}

const countsOf = (all: ItemStatus[]) => {
  const required = all.filter(i => i.required);
  return {
    total: all.length,
    done: all.filter(i => i.done).length,
    requiredTotal: required.length,
    requiredDone: required.filter(i => i.done).length,
    blocked: required.some(i => !i.done),
    items: all,
  };
};

/**
 * The same answer for a whole board, in a fixed number of queries.
 *
 * The per-deal version asks the database for documents once per deal. On a board that is one query
 * per card on every load of the Pipeline screen — fine with four deals, and a page nobody can open
 * with four hundred. This resolves every list first, then fetches every document those lists could
 * possibly need in ONE query, and answers the rest from memory.
 *
 * Returns a Map keyed by deal id; a deal with no checklist is simply absent from it.
 */
export async function summariesForMany(
  deals: any[],
  companiesById: Map<string, any>,
): Promise<Map<string, ReturnType<typeof countsOf>>> {
  const out = new Map<string, ReturnType<typeof countsOf>>();
  if (!deals.length) return out;

  // 1. resolve each deal's list (snapshot, or the stage's rule for one never snapshotted)
  const lists = new Map<string, DealChecklistItem[]>();
  for (const d of deals) {
    const company = companiesById.get(d.companyId);
    const items = await effectiveItems(d, company, d.stage);
    if (items.length) lists.set(d.id, items);
  }
  if (!lists.size) return out;

  // 2. every document those lists could be satisfied by, in one go
  const companyIds = [...new Set(deals.filter(d => lists.has(d.id)).map(d => d.companyId))];
  const docTypes = [...new Set([...lists.values()].flat().filter(i => i.source === "document" && i.docType).map(i => i.docType as string))];
  const docs = docTypes.length
    ? await prisma.document.findMany({
        where: { companyId: { in: companyIds }, docType: { in: docTypes }, status: "valid" },
        select: { companyId: true, docType: true, docNumber: true, expiryDate: true },
      })
    : [];

  // 3. the same rules as statusFor, applied in memory
  for (const d of deals) {
    const items = lists.get(d.id);
    if (!items) continue;
    const manual: Record<string, any> = (d?.checklistState && typeof d.checklistState === "object") ? d.checklistState : {};
    const waived: Record<string, any> = (d?.checklistWaived && typeof d.checklistWaived === "object") ? d.checklistWaived : {};
    const statuses: ItemStatus[] = items.map(i => {
      if (waived[i.key]) return { ...i, done: true, how: "waived", evidence: str(waived[i.key]?.reason) || null };
      if (i.source === "document") {
        const hit = docs.find(x => x.companyId === d.companyId && x.docType === i.docType);
        return {
          ...i, done: !!hit, how: hit ? "document" : null,
          evidence: hit ? [i.docType, hit.docNumber, hit.expiryDate ? "expires " + hit.expiryDate : null].filter(Boolean).join(" · ") : null,
        };
      }
      const t = manual[i.key];
      return { ...i, done: !!t?.done, how: t?.done ? "manual" : null, evidence: str(t?.by) || null };
    });
    out.set(d.id, countsOf(statuses));
  }
  return out;
}
