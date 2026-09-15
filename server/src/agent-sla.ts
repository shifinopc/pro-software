/**
 * SLA RESCUE AND WORKLOAD.
 *
 * The SLA job already escalates a step once 75% of its time is gone. By then the only fix left is
 * overtime. This agent looks earlier, and at the people as well as the clock:
 *   · LIKELY TO BREACH — a step still "on track" whose deadline falls before the time this very step
 *     usually takes (its own history: how long the same step of the same workflow took the last times).
 *   · OVERLOADED — someone holding far more live steps than others in the same role, with a proposal
 *     to move the newest, untouched ones to the lightest of those colleagues.
 *   · WITH SOMEONE WHO HAS LEFT — steps still assigned to a deactivated account, which nobody will do.
 *   · LATE TASKS — ordinary tasks past their due date, which no job watches at all.
 *
 * It proposes; an admin moves. A move re-checks that the step is still live and still with the same
 * person, so a proposal that went stale while nobody looked cannot take work off whoever has it now —
 * and, unlike a plain reassignment, the new person is told.
 *
 * NO MODEL. The estimate is a percentile of real durations; with fewer than four finished examples of
 * a step there is no estimate, and no "likely to breach" is raised for it.
 */
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, decide, isAdmin, AgentActionError, parseDay, DAY, type AgentActor } from "./agent-core.js";
import { notifyTaskAssigned } from "./notify.js";
import { logActivity, logAudit } from "./auth.js";

export const KEY = "sla-rescue";
const HOUR = 3_600_000;
const HISTORY_DAYS = 180;

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const hours = (ms: number) => (ms >= 48 * HOUR ? `${Math.round(ms / DAY)} days` : `${Math.max(1, Math.round(ms / HOUR))} h`);

export async function runSlaRescue(now = Date.now()) {
  const out = { atRisk: 0, overloaded: 0, orphaned: 0, late: 0, closed: 0 };
  const seen: Record<string, Set<string>> = { "likely-breach": new Set(), overload: new Set(), orphaned: new Set(), "late-tasks": new Set() };

  const staff = await prisma.user.findMany({ where: { type: "staff" }, select: { id: true, name: true, roleId: true, status: true } });
  const byId = new Map(staff.map(u => [u.id, u]));
  const active = await prisma.workflowTask.findMany({
    where: { status: "active" },
    select: { id: true, title: true, nodeId: true, instanceId: true, assigneeId: true, assignee: true, assigneeRole: true, createdAt: true, dueDate: true, slaHours: true, slaState: true, checklistState: true, instance: { select: { templateId: true, title: true, clientName: true, companyId: true } } },
  });

  // How long each step usually takes, from its own finished history.
  const done = await prisma.workflowTask.findMany({
    where: { status: { in: ["done", "approved", "rejected"] }, completedAt: { gte: new Date(now - HISTORY_DAYS * DAY).toISOString() } },
    select: { nodeId: true, createdAt: true, completedAt: true, instance: { select: { templateId: true } } },
  });
  const durations = new Map<string, number[]>();
  for (const t of done) {
    const a = Date.parse(t.createdAt ?? ""), b = Date.parse(t.completedAt ?? "");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
    const k = `${t.instance.templateId}:${t.nodeId}`;
    durations.set(k, [...(durations.get(k) ?? []), b - a]);
  }

  const load = new Map<string, number>();
  for (const t of active) if (t.assigneeId) load.set(t.assigneeId, (load.get(t.assigneeId) ?? 0) + 1);
  // A step with no role and nobody on it is operations work: offer it to PRO officers, never to admins.
  const roleOf = (t: { assigneeRole: string | null; assigneeId: string | null }) => t.assigneeRole || (t.assigneeId ? byId.get(t.assigneeId)?.roleId ?? null : null) || "pro_officer";
  /** The lightest active colleague in a role, other than `exclude`. */
  const lightest = (role: string | null, exclude: string | null) => staff
    .filter(u => u.status === "active" && u.id !== exclude && u.roleId !== "super_admin" && u.roleId !== "admin" && (!role || u.roleId === role))
    .map(u => ({ u, n: load.get(u.id) ?? 0 }))
    .sort((a, b) => a.n - b.n)[0] ?? null;

  // 1. Likely to breach.
  for (const t of active) {
    if (t.slaState && t.slaState !== "on_track") continue; // the SLA job has it already
    const started = Date.parse(t.createdAt ?? "");
    const due = t.dueDate ? Date.parse(t.dueDate) : t.slaHours && Number.isFinite(started) ? started + t.slaHours * HOUR : NaN;
    if (!Number.isFinite(started) || !Number.isFinite(due) || due < now) continue;
    const hist = durations.get(`${t.instance.templateId}:${t.nodeId}`) ?? [];
    if (hist.length < 4) continue;
    const typical = pct(hist, 0.5), slow = pct(hist, 0.8);
    const expected = started + slow;
    if (expected <= due) continue;
    const mine = t.assigneeId ? load.get(t.assigneeId) ?? 0 : 0;
    const alt = lightest(roleOf(t), t.assigneeId);
    const betterAlt = alt && (!t.assigneeId || alt.n + 2 <= mine) ? alt : null;
    const key = `risk:${t.id}`;
    seen["likely-breach"].add(key);
    const r = await upsertFinding(KEY, key, {
      kind: "likely-breach", companyId: t.instance.companyId, refType: "workflowTask", refId: t.id,
      title: `Likely to miss its deadline: ${t.title} — ${t.instance.clientName ?? t.instance.title}`,
      summary: `Due ${new Date(due).toISOString().slice(0, 16).replace("T", " ")}, but this step usually takes ${hours(typical)} and often ${hours(slow)} (${hist.length} past runs) — it would finish about ${hours(expected - due)} late.${t.assigneeId ? ` ${byId.get(t.assigneeId)?.name ?? "The assignee"} has ${mine} live step${mine === 1 ? "" : "s"}.` : " Nobody is assigned."}${betterAlt ? ` ${betterAlt.u.name} has ${betterAlt.n}.` : ""}`,
      output: {
        stepId: t.id, fromUserId: t.assigneeId, toUserId: betterAlt?.u.id ?? null,
        facts: [
          { label: "Step", value: `${t.title} · ${t.instance.title}` },
          { label: "Deadline", value: new Date(due).toISOString().slice(0, 16).replace("T", " ") },
          { label: "Usually takes", value: `${hours(typical)} (slow runs ${hours(slow)}) · ${hist.length} past runs` },
          { label: "With", value: t.assigneeId ? `${byId.get(t.assigneeId)?.name ?? "?"} · ${mine} live steps` : "Nobody" },
        ],
        proposal: betterAlt ? { kind: "move", text: `Move it to ${betterAlt.u.name}, who has ${betterAlt.n} live step${betterAlt.n === 1 ? "" : "s"}.` } : null,
      },
    });
    if (r.opened) out.atRisk++;
  }

  // 2. Overloaded, within each role.
  const roles = new Map<string, typeof staff>();
  for (const u of staff) if (u.status === "active" && u.roleId) roles.set(u.roleId, [...(roles.get(u.roleId) ?? []), u]);
  for (const [role, people] of roles) {
    if (people.length < 2) continue;
    const counts = people.map(u => load.get(u.id) ?? 0);
    const median = pct(counts, 0.5);
    for (const u of people) {
      const n = load.get(u.id) ?? 0;
      if (n < Math.max(median * 1.5, median + 4)) continue;
      const toMove = Math.floor((n - median) / 2);
      // The newest steps nobody has started on are the cheapest to hand over.
      const movable = active
        .filter(t => t.assigneeId === u.id && !Object.keys((t.checklistState ?? {}) as object).length && t.slaState !== "breached")
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, toMove);
      if (!movable.length) continue;
      const key = `overload:${u.id}`;
      seen.overload.add(key);
      const others = people.filter(p => p.id !== u.id).map(p => ({ p, n: load.get(p.id) ?? 0 })).sort((a, b) => a.n - b.n);
      const r = await upsertFinding(KEY, key, {
        kind: "overload", refType: "user", refId: u.id,
        title: `${u.name} has ${n} live steps — the ${role.replace(/_/g, " ")} median is ${median}`,
        summary: `Moving ${movable.length} untouched step${movable.length === 1 ? "" : "s"} to ${others.slice(0, 2).map(o => `${o.p.name} (${o.n})`).join(" and ")} would even the load.`,
        output: {
          fromUserId: u.id, stepIds: movable.map(t => t.id), toUserIds: others.map(o => o.p.id),
          lists: [{ title: "Steps to move — newest, not yet started", items: movable.map(t => ({ text: `${t.title} · ${t.instance.clientName ?? t.instance.title}` })) }],
          facts: [{ label: "Live steps", value: people.map(p => `${p.name} ${load.get(p.id) ?? 0}`).join(" · ") }],
          proposal: { kind: "move", text: `Move ${movable.length} step${movable.length === 1 ? "" : "s"}, spread across the lightest colleagues.` },
        },
      });
      if (r.opened) out.overloaded++;
    }
  }

  // 3. Steps with people who have left.
  const gone = new Map<string, typeof active>();
  for (const t of active) {
    const u = t.assigneeId ? byId.get(t.assigneeId) : null;
    if (u && u.status !== "active") gone.set(u.id, [...(gone.get(u.id) ?? []), t]);
  }
  for (const [uid, steps] of gone) {
    const u = byId.get(uid)!;
    const key = `orphaned:${uid}`;
    seen.orphaned.add(key);
    const r = await upsertFinding(KEY, key, {
      kind: "orphaned", refType: "user", refId: uid,
      title: `${steps.length} step${steps.length === 1 ? "" : "s"} still with ${u.name}, whose account is ${u.status}`,
      summary: "Nobody will do these while they sit with an inactive account. Move them to active colleagues in the same role.",
      output: { fromUserId: uid, stepIds: steps.map(s => s.id), toUserIds: null, lists: [{ title: "Steps", items: steps.map(t => ({ text: `${t.title} · ${t.instance.clientName ?? t.instance.title}` })) }], proposal: { kind: "move", text: "Move each to the lightest active colleague in its role." } },
    });
    if (r.opened) out.orphaned++;
  }

  // 4. Ordinary tasks past due, grouped by who holds them.
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  const tasks = await prisma.task.findMany({ where: { archived: false, workflowInstanceId: null, NOT: { status: { in: ["done", "cancelled"] } } }, select: { id: true, ref: true, title: true, dueDate: true, assignee: true, assigneeId: true, clientName: true } });
  const lateBy = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const d = parseDay(t.dueDate);
    if (d === null || d >= today) continue;
    const k = t.assigneeId ?? "unassigned";
    lateBy.set(k, [...(lateBy.get(k) ?? []), t]);
  }
  for (const [k, list] of lateBy) {
    const key = `late:${k}`;
    seen["late-tasks"].add(key);
    const who = k === "unassigned" ? "nobody" : byId.get(k)?.name ?? list[0].assignee ?? "someone";
    const r = await upsertFinding(KEY, key, {
      kind: "late-tasks", refType: "user", refId: k === "unassigned" ? null : k,
      title: `${list.length} task${list.length === 1 ? "" : "s"} past due with ${who}`,
      summary: "Ordinary tasks are not watched by the SLA job, so these have raised no alarm anywhere else.",
      output: { userId: k === "unassigned" ? null : k, lists: [{ title: "Late tasks", items: list.slice(0, 50).map(t => ({ text: `${t.ref ?? ""} ${t.title} · due ${t.dueDate}${t.clientName ? ` · ${t.clientName}` : ""}`.trim() })) }] },
    });
    if (r.opened) out.late++;
  }

  for (const [kind, keys] of Object.entries(seen)) out.closed += await closeMissing(KEY, kind, keys, "Resolved");
  return out;
}

/** Hand one step to one person — only if it is still live and still with whoever it was with. */
async function moveStep(stepId: string, fromUserId: string | null, toUserId: string, actor: AgentActor, why: string) {
  const step = await prisma.workflowTask.findUnique({ where: { id: stepId }, include: { instance: { select: { clientName: true, title: true } } } });
  if (!step || step.status !== "active" || (step.assigneeId ?? null) !== (fromUserId ?? null)) return false;
  const to = await prisma.user.findUnique({ where: { id: toUserId }, select: { id: true, name: true, status: true } });
  if (!to || to.status !== "active") return false;
  await prisma.workflowTask.update({ where: { id: step.id }, data: { assigneeId: to.id, assignee: to.name } });
  await prisma.workflowLog.create({ data: { instanceId: step.instanceId, nodeId: step.nodeId, action: "step.reassigned", detail: `→ ${to.name} (${why})`, actor: actor.name, at: new Date().toISOString() } });
  notifyTaskAssigned({ assigneeId: to.id, title: step.title, clientName: step.instance.clientName, dueDate: step.dueDate, why });
  return true;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That finding no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This finding is already ${t.status}.`, 409);
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  if (action === "done") return decide(t.id, "done", actor, { note: String(input?.note ?? "") || "Handled" });
  if (action !== "move") throw new AgentActionError("Unknown action.");
  if (!isAdmin(actor)) throw new AgentActionError("Only an admin can move work between people.", 403);

  const o = (t.output ?? {}) as any;
  const moved: string[] = [];
  const staff = await prisma.user.findMany({ where: { type: "staff", status: "active" }, select: { id: true, name: true, roleId: true } });
  const live = await prisma.workflowTask.findMany({ where: { status: "active" }, select: { assigneeId: true } });
  const load = new Map<string, number>();
  for (const s of live) if (s.assigneeId) load.set(s.assigneeId, (load.get(s.assigneeId) ?? 0) + 1);

  if (t.kind === "likely-breach") {
    if (!o.toUserId) throw new AgentActionError("There is nobody lighter to move it to.");
    if (await moveStep(o.stepId, o.fromUserId, o.toUserId, actor, "moved to meet its deadline")) moved.push(o.toUserId);
  } else {
    const from = await prisma.user.findUnique({ where: { id: o.fromUserId }, select: { roleId: true } });
    for (const stepId of (o.stepIds ?? []) as string[]) {
      const step = await prisma.workflowTask.findUnique({ where: { id: stepId }, select: { assigneeRole: true } });
      const role = step?.assigneeRole || from?.roleId || null;
      const pool = staff.filter(u => u.id !== o.fromUserId && (!role || u.roleId === role) && (!o.toUserIds || o.toUserIds.includes(u.id)));
      const target = pool.sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0))[0];
      if (!target) continue;
      if (await moveStep(stepId, o.fromUserId, target.id, actor, t.kind === "orphaned" ? "the previous assignee is no longer active" : "moved to even out the workload")) {
        moved.push(target.id);
        load.set(target.id, (load.get(target.id) ?? 0) + 1);
      }
    }
  }
  if (!moved.length) throw new AgentActionError("Nothing was moved — the steps have changed hands or finished since this was found.", 409);
  const names = [...new Set(moved)].map(id => staff.find(s => s.id === id)?.name ?? id);
  await logAudit({ action: "workflow.task_reassign", actorId: actor.id, target: t.dedupeKey, detail: `${moved.length} step(s) → ${names.join(", ")} via SLA Rescue agent` });
  logActivity({ type: "task", message: `${moved.length} step${moved.length === 1 ? "" : "s"} moved to ${names.join(", ")}`, user: actor.name });
  await decide(t.id, "done", actor, { moved: moved.length, to: names });
  return { ok: true, message: `Moved ${moved.length} step${moved.length === 1 ? "" : "s"} to ${names.join(", ")}. They have been told.` };
}
