/**
 * What every agent shares: its switch and model setting, the AgentTask store, and the rule that an
 * agent proposes while a person decides.
 *
 * SETTINGS live in AppSetting "agents" as { [agentKey]: { enabled, model } }. Every agent starts
 * switched off. `model` is null ("no model — templates and database checks only") or a model id.
 * The document intake agent predates this and keeps its own "intakeAgent" setting; agents.ts maps it.
 */
import { prisma } from "./db.js";
import { isAvailableModel, isKnownModelId } from "./ai.js";
import { can, type PermModule, type PermAction } from "./permissions.js";

export type ModelUse = "required" | "optional" | "none";
export type AgentActor = { id: string | null; name: string; role: string | undefined; email?: string | null };

/** A refusal worth showing the person who pressed the button. */
export class AgentActionError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "AgentActionError"; }
}

const nowIso = () => new Date().toISOString();

// ── settings ──────────────────────────────────────────────────────────────────────────────────

type Setting = { enabled: boolean; model: string | null; options?: Record<string, unknown> };

export async function allAgentSettings(): Promise<Record<string, Setting>> {
  const row = await prisma.appSetting.findUnique({ where: { key: "agents" } }).catch(() => null);
  return ((row?.value ?? {}) as any) || {};
}

export async function agentSetting(key: string): Promise<Setting> {
  const s = (await allAgentSettings())[key] ?? {};
  return { enabled: (s as any).enabled === true, model: isKnownModelId((s as any).model) ? (s as any).model : null, options: (s as any).options ?? {} };
}

export async function saveAgentSetting(key: string, next: Partial<Setting>) {
  const all = await allAgentSettings();
  const cur = all[key] ?? { enabled: false, model: null };
  const merged: Setting = {
    ...cur,
    ...(typeof next.enabled === "boolean" ? { enabled: next.enabled } : {}),
    ...(next.model !== undefined ? { model: next.model && isKnownModelId(next.model) ? next.model : null } : {}),
    ...(next.options ? { options: { ...(cur.options ?? {}), ...next.options } } : {}),
  };
  const value = { ...all, [key]: merged };
  await prisma.appSetting.upsert({ where: { key: "agents" }, create: { key: "agents", value: value as any }, update: { value: value as any } });
  return merged;
}

/** The model this agent may call right now, or null — off, no model chosen, or that model is not configured on the server. */
export async function usableModel(key: string): Promise<string | null> {
  const s = await agentSetting(key);
  return s.enabled && s.model && isAvailableModel(s.model) ? s.model : null;
}

// ── when an agent last ran (for the once-a-day agents) ────────────────────────────────────────

export async function lastRun(key: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: "agentRuns" } }).catch(() => null);
  return ((row?.value ?? {}) as any)[key] ?? null;
}
export async function markRun(key: string) {
  const row = await prisma.appSetting.findUnique({ where: { key: "agentRuns" } }).catch(() => null);
  const value = { ...((row?.value ?? {}) as any), [key]: nowIso() };
  await prisma.appSetting.upsert({ where: { key: "agentRuns" }, create: { key: "agentRuns", value }, update: { value } });
}
/** True when a daily agent has not run since `hours` ago. */
export async function dueDaily(key: string, hours = 20) {
  const at = await lastRun(key);
  return !at || Date.now() - Date.parse(at) > hours * 3_600_000;
}

// ── the task store ────────────────────────────────────────────────────────────────────────────

type TaskData = {
  kind: string; title: string; summary?: string | null;
  companyId?: string | null; employeeId?: string | null; refType?: string | null; refId?: string | null;
  output?: unknown; model?: string | null; createdBy?: string | null;
};

/** Start a piece of one-off work. Null when this exact work was already done (or is being done). */
export async function claimTask(agent: string, dedupeKey: string, d: TaskData) {
  try {
    return await prisma.agentTask.create({
      data: { agent, dedupeKey, status: "working", createdAt: nowIso(), ...d, output: (d.output ?? undefined) as any },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return null;
    throw e;
  }
}

export async function finishTask(id: string, status: "review" | "done" | "failed", d: Partial<TaskData> & { error?: string | null } = {}) {
  return prisma.agentTask.update({
    where: { id },
    data: { status, finishedAt: nowIso(), ...d, output: (d.output ?? undefined) as any },
  });
}

/**
 * A finding the agent can see right now. New → opened for review. Already open → refreshed.
 * Closed by the agent earlier because it went away, and now back → reopened. Dismissed by a person →
 * left alone: they said it is not a problem.
 */
export async function upsertFinding(agent: string, dedupeKey: string, d: TaskData) {
  const existing = await prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent, dedupeKey } } });
  const data = { ...d, output: (d.output ?? undefined) as any };
  if (!existing) {
    return { row: await prisma.agentTask.create({ data: { agent, dedupeKey, status: "review", createdAt: nowIso(), finishedAt: nowIso(), ...data } }), opened: true };
  }
  if (existing.status === "dismissed") return { row: existing, opened: false };
  const reopen = existing.status === "done" && (existing.decision as any)?.auto;
  if (existing.status === "done" && !reopen) return { row: existing, opened: false };
  const row = await prisma.agentTask.update({
    where: { id: existing.id },
    data: { ...data, status: "review", finishedAt: nowIso(), ...(reopen ? { decision: undefined as any, decidedAt: null, decidedBy: null, createdAt: nowIso() } : {}) },
  });
  return { row, opened: !!reopen };
}

/** Close this agent's open findings of `kind` that were not seen on this pass — somebody fixed them. */
export async function closeMissing(agent: string, kind: string, seen: Set<string>, note = "No longer found") {
  const open = await prisma.agentTask.findMany({ where: { agent, kind, status: "review" }, select: { id: true, dedupeKey: true } });
  let closed = 0;
  for (const t of open) {
    if (seen.has(t.dedupeKey)) continue;
    await prisma.agentTask.update({ where: { id: t.id }, data: { status: "done", decidedAt: nowIso(), decision: { auto: note } } });
    closed++;
  }
  return closed;
}

/** A person's decision on a task. */
export async function decide(id: string, status: "done" | "dismissed", actor: AgentActor, decision: Record<string, unknown>) {
  return prisma.agentTask.update({ where: { id }, data: { status, decidedBy: actor.id, decidedAt: nowIso(), decision: decision as any } });
}

export async function requirePerm(actor: AgentActor, mod: PermModule, act: PermAction, what: string) {
  if (!(await can(actor.role, mod, act))) throw new AgentActionError(`Your role cannot ${what}.`, 403);
}

export const isAdmin = (actor: AgentActor) => actor.role === "admin" || actor.role === "super_admin";

// ── small shared helpers ──────────────────────────────────────────────────────────────────────

export const DAY = 86_400_000;
export function parseDay(v: unknown): number | null {
  if (!v) return null;
  const s = String(v).trim();
  const t = /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s.slice(0, 10) + "T00:00:00Z") : Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
export const daysFromToday = (v: unknown) => {
  const t = parseDay(v);
  if (t === null) return null;
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.round((t - today) / DAY);
};
export const normName = (s: string) => String(s ?? "").toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(t => t.length > 1);

/** The client's current document of a type — the one not superseded, latest expiry first. */
export async function currentDoc(docType: string, companyId: string | null, employeeId: string | null) {
  return prisma.document.findFirst({
    where: { docType, supersededAt: null, ...(companyId ? { companyId } : {}), ...(employeeId ? { employeeId } : { employeeId: null }) },
    orderBy: [{ expiryDate: "desc" }],
  });
}

/** Services this client holds through a live subscription (its own, or its group's). */
export async function entitledServiceIds(companyId: string): Promise<Set<string>> {
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { groupId: true } });
  const subs = await prisma.subscription.findMany({
    where: { OR: [{ companyId }, ...(co?.groupId ? [{ scope: "group", refId: co.groupId }] : [])] } as any,
    include: { package: { select: { serviceIds: true } } },
  }).catch(() => [] as any[]);
  const out = new Set<string>();
  for (const s of subs as any[]) {
    if ((s.daysLeft ?? 0) <= 0) continue;
    for (const id of (Array.isArray(s.package?.serviceIds) ? s.package.serviceIds : [])) out.add(String(id));
    for (const x of (Array.isArray(s.addons) ? s.addons : [])) if (x?.serviceId) out.add(String(x.serviceId));
  }
  return out;
}
