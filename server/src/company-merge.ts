/**
 * Two records are the same company. Make them one.
 *
 * Duplicates are already FOUND in three places — live as somebody types into the Add lead form, in
 * the lead import's preview, and daily by the `crm-duplicates` agent — and until now every one of
 * them ended at the same sentence: "Keep one and move the others' contacts, deals and history onto
 * it." That is an instruction to do it by hand, record by record, and nobody does.
 *
 * TWENTY-SIX TABLES POINT AT A COMPANY. The work is not deciding, it is moving every one of them
 * without leaving a row pointing at a record that is no longer there. So:
 *
 *   IT IS PLANNED BEFORE IT IS DONE. `planMerge` writes nothing and answers what would move, what
 *   would be filled in, what would collide and what stops it outright. Nobody should merge two
 *   client records to find out afterwards which phone number won.
 *
 *   IT IS ONE TRANSACTION. A merge that stops halfway is worse than no merge: half the invoices
 *   under one record and half under a record marked retired is a state nothing in this system knows
 *   how to read, and no screen would show it.
 *
 *   THE LOSER IS KEPT, NOT DELETED. `mergedIntoId` retires it and says where it went, so every old
 *   link, bookmark and audit line still resolves.
 *
 * WHAT IT REFUSES, AND WHY THAT IS THE IMPORTANT PART. A merge is not reversible by any button here.
 * Each refusal below is a case where "duplicate" is probably the wrong word for what somebody is
 * looking at, and where guessing would destroy data rather than tidy it.
 */
import { prisma } from "./db.js";
import { syncPrimaryContact } from "./contacts.js";
import { logActivity, logAudit } from "./auth.js";

/** Everything that points at a company, and what has to happen to it. */
type Mover = {
  /** The Prisma delegate name. One list, so a table added next year is added once. */
  model: string;
  label: string;
  /** Tables carrying a denormalised `clientName`: moved rows must stop showing the dead name. */
  renames?: boolean;
};

/**
 * All 26, taken from the schema rather than from memory.
 *
 * `Subscription` is the one that is pointed at TWICE — `companyId` and `refId` + `scope` — and is
 * handled separately below. Moving only `companyId` would leave `refId` aimed at the retired
 * record: a subscription billing against a company that is not there any more.
 */
const MOVERS: Mover[] = [
  { model: "contact", label: "contacts" },
  { model: "document", label: "documents" },
  { model: "employee", label: "employees" },
  { model: "establishment", label: "CRs" },
  { model: "interaction", label: "interactions" },
  { model: "opportunity", label: "deals" },
  { model: "lifecycleTransition", label: "lifecycle history" },
  { model: "ownerAssignment", label: "owner history" },
  { model: "siteCredential", label: "government logins" },
  { model: "documentSuggestion", label: "document suggestions" },
  { model: "user", label: "portal logins" },
  { model: "fileAsset", label: "files" },
  { model: "errorReport", label: "problem reports" },
  { model: "emailMessage", label: "emails" },
  { model: "agentTask", label: "agent findings" },
  { model: "task", label: "tasks", renames: true },
  { model: "invoice", label: "invoices", renames: true },
  { model: "payment", label: "payments", renames: true },
  { model: "quotation", label: "quotations", renames: true },
  { model: "serviceRequest", label: "client requests", renames: true },
  { model: "upgradeRequest", label: "upgrade requests", renames: true },
  { model: "workflowInstance", label: "workflow runs", renames: true },
  { model: "appointment", label: "appointments", renames: true },
  { model: "courierShipment", label: "courier jobs", renames: true },
];

/**
 * Scalars worth carrying over when the survivor has nothing in them. Never an overwrite.
 *
 * `contact`, `email` and `phone` are DELIBERATELY ABSENT. contacts.ts owns those three — they are a
 * mirror of whichever contact is primary, and `syncPrimaryContact` rewrites them at the end of
 * every merge. Filling them here produced a plan that promised "email = sales@…" and a survivor
 * whose email was still empty a second later: the preview lied, which is worse than the gap it was
 * trying to close. The address is not lost — it travels across on the contact that carries it.
 */
const FILLABLE = [
  "cr", "nameAr", "website", "city", "country", "address", "industry",
  "mainActivity", "source", "sourceDetail", "campaign", "service", "notes", "vatNumber",
] as const;

export type MergePlan = {
  survivor: { id: string; name: string; lifecycle: string; cr: string | null };
  loser: { id: string; name: string; lifecycle: string; cr: string | null };
  /** Reasons this must not happen. Non-empty means the merge is refused. */
  blocks: string[];
  moves: Array<{ label: string; count: number }>;
  fills: Array<{ field: string; value: string }>;
  /** Employee codes that clash and would be re-coded on the way across. */
  recodes: Array<{ name: string; from: string; to: string }>;
  /** Workforce snapshots for a day the survivor already has: the survivor's is kept. */
  dropped: Array<{ label: string; count: number }>;
  total: number;
};

const str = (v: unknown) => String(v ?? "").trim();
const digits = (v: unknown) => str(v).replace(/\D/g, "");

export async function planMerge(survivorId: string, loserId: string): Promise<MergePlan> {
  const [to, from] = await Promise.all([
    prisma.company.findUnique({ where: { id: survivorId } }),
    prisma.company.findUnique({ where: { id: loserId } }),
  ]);
  if (!to) throw new Error("The record to keep no longer exists.");
  if (!from) throw new Error("The record to merge no longer exists.");

  const blocks: string[] = [];
  if (survivorId === loserId) blocks.push("Those are the same record.");
  if ((to as any).mergedIntoId) blocks.push(`"${to.name}" has itself already been merged into another record.`);
  if ((from as any).mergedIntoId) blocks.push(`"${from.name}" has already been merged into another record.`);

  /**
   * A COMMERCIAL REGISTRATION IS ISSUED ONCE — duplicates.ts rests on it, and the converse is what
   * matters here: two records carrying DIFFERENT real CR numbers are two legal entities, and
   * merging them is not tidying up, it is destroying one of them. A blank CR merges freely.
   */
  const crA = digits(to.cr), crB = digits(from.cr);
  if (crA && crB && crA !== crB) {
    blocks.push(`These carry different CR numbers (${to.cr} and ${from.cr}). A CR is issued once, so these are two companies, not one record entered twice.`);
  }

  // Two live subscriptions on one company bills the client twice, quietly. That is a decision for a
  // person — cancel one first — not something a merge should settle on its own.
  const [subTo, subFrom] = await Promise.all([
    prisma.subscription.count({ where: { companyId: survivorId } }),
    prisma.subscription.count({ where: { companyId: loserId } }),
  ]);
  if (subTo > 0 && subFrom > 0) {
    blocks.push("Both records have a subscription. Cancel the one you are not keeping first, or they will both bill.");
  }

  const moves: MergePlan["moves"] = [];
  for (const m of MOVERS) {
    const n = await (prisma as any)[m.model].count({ where: { companyId: loserId } }).catch(() => 0);
    if (n) moves.push({ label: m.label, count: n });
  }
  if (subFrom) moves.push({ label: "subscriptions", count: subFrom });

  const fills: MergePlan["fills"] = [];
  for (const f of FILLABLE) {
    const have = str((to as any)[f]), take = str((from as any)[f]);
    if (!have && take) fills.push({ field: f, value: take.slice(0, 120) });
  }

  // Employee codes are unique PER COMPANY, so two companies can each hold an "E001" and moving one
  // across breaks the constraint — which would fail the whole transaction, not just that row.
  const [codesTo, empFrom] = await Promise.all([
    prisma.employee.findMany({ where: { companyId: survivorId }, select: { code: true } }),
    prisma.employee.findMany({ where: { companyId: loserId }, select: { id: true, name: true, code: true } }),
  ]);
  const used = new Set(codesTo.map(e => str(e.code)).filter(Boolean));
  const recodes: MergePlan["recodes"] = [];
  for (const e of empFrom) {
    const code = str(e.code);
    if (!code || !used.has(code)) { if (code) used.add(code); continue; }
    let n = 2, next = `${code}-${n}`;
    while (used.has(next)) next = `${code}-${++n}`;
    used.add(next);
    recodes.push({ name: e.name, from: code, to: next });
  }

  // Same shape, different answer: a snapshot is one row per company per day, and the survivor's own
  // reading for a day it already measured is the one to keep.
  const [daysTo, snapFrom] = await Promise.all([
    prisma.workforceSnapshot.findMany({ where: { companyId: survivorId }, select: { day: true } }),
    prisma.workforceSnapshot.findMany({ where: { companyId: loserId }, select: { id: true, day: true } }),
  ]);
  const have = new Set(daysTo.map(d => d.day));
  const clashSnaps = snapFrom.filter(s => have.has(s.day));
  const dropped: MergePlan["dropped"] = [];
  if (clashSnaps.length) dropped.push({ label: "workforce readings for a day already measured", count: clashSnaps.length });
  const keptSnaps = snapFrom.length - clashSnaps.length;
  if (keptSnaps) moves.push({ label: "workforce readings", count: keptSnaps });

  return {
    survivor: { id: to.id, name: to.name, lifecycle: to.lifecycle, cr: to.cr },
    loser: { id: from.id, name: from.name, lifecycle: from.lifecycle, cr: from.cr },
    blocks, moves, fills, recodes, dropped,
    total: moves.reduce((s, m) => s + m.count, 0),
  };
}

/**
 * Do it, all of it or none of it.
 *
 * The timeout is raised deliberately: twenty-six updates across a client with years of history is
 * more than the default five seconds allows, and a merge timing out half way is the one outcome
 * this whole file exists to prevent.
 */
export async function applyMerge(survivorId: string, loserId: string, actor: { id?: string | null; name?: string | null }) {
  const plan = await planMerge(survivorId, loserId);
  if (plan.blocks.length) throw new Error(plan.blocks[0]);

  const name = plan.survivor.name;
  await prisma.$transaction(async tx => {
    // Collisions cleared BEFORE anything moves, or the move itself is what fails.
    for (const r of plan.recodes) {
      await (tx as any).employee.updateMany({ where: { companyId: loserId, code: r.from }, data: { code: r.to } });
    }
    const daysTo = await tx.workforceSnapshot.findMany({ where: { companyId: survivorId }, select: { day: true } });
    const have = daysTo.map(d => d.day);
    if (have.length) await tx.workforceSnapshot.deleteMany({ where: { companyId: loserId, day: { in: have } } });

    for (const m of MOVERS) {
      await (tx as any)[m.model].updateMany({
        where: { companyId: loserId },
        data: { companyId: survivorId, ...(m.renames ? { clientName: name } : {}) },
      });
    }
    await tx.workforceSnapshot.updateMany({ where: { companyId: loserId }, data: { companyId: survivorId } });
    // BOTH pointers, together. See the note on MOVERS.
    await tx.subscription.updateMany({ where: { companyId: loserId }, data: { companyId: survivorId } });
    await tx.subscription.updateMany({ where: { scope: "company", refId: loserId }, data: { refId: survivorId } });

    const fill: Record<string, unknown> = {};
    for (const f of plan.fills) fill[f.field] = f.value;
    if (Object.keys(fill).length) await tx.company.update({ where: { id: survivorId }, data: fill });

    await tx.company.update({ where: { id: loserId }, data: { mergedIntoId: survivorId, status: "merged" } });
  }, { timeout: 60_000 });

  // The mirrored contact/email/phone are re-derived rather than guessed: the survivor may have just
  // inherited the primary contact. contacts.ts owns that rule; this must not keep a second copy.
  await syncPrimaryContact(survivorId).catch(() => {});

  const detail = `${plan.loser.name} (${loserId}) → ${plan.survivor.name} (${survivorId}): `
    + (plan.moves.map(m => `${m.count} ${m.label}`).join(", ") || "nothing to move")
    + (plan.fills.length ? ` · filled ${plan.fills.map(f => f.field).join(", ")}` : "")
    + (plan.recodes.length ? ` · re-coded ${plan.recodes.length} employee(s)` : "");
  await logAudit({ action: "company.merge", actorId: actor.id ?? undefined, target: plan.survivor.name, detail: detail.slice(0, 900) });
  logActivity({ type: "client", message: `“${plan.loser.name}” merged into “${plan.survivor.name}” — ${plan.total} records moved`, user: actor.name ?? undefined });

  return { ok: true, plan, message: `“${plan.loser.name}” is now part of “${plan.survivor.name}”. ${plan.total} records moved.` };
}
