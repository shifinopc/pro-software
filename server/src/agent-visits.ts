/**
 * GOVERNMENT VISIT PLANNER.
 *
 * Officers lose whole mornings driving to the same office on different days: a medical test on
 * Sunday, a Jawazat step on Tuesday, a passport to collect there on Wednesday. Once a day this agent
 * gathers everything in the coming week that needs someone physically at a government center —
 * booked appointments, workflow steps at an in-person center, courier pickups and drop-offs — and
 * plans it as trips:
 *   · an appointment fixes a day at its center;
 *   · a flexible item joins a trip already going to its center before it is due;
 *   · otherwise it gets a trip on the last working day that still meets its deadline, which gives
 *     later items the best chance to share it.
 * The plan says how many trips it saves, and one click turns each trip into a task for the officer.
 *
 * WHICH CENTERS ARE IN PERSON. The center list does not say, so the agent assumes offices (Jawazat,
 * labour office, medical centers, embassies, courts, chambers …) are, and portals (Absher, Qiwa,
 * Muqeem, Mudad, GOSI …) are not. An admin can set the exact list, which then wins.
 *
 * It plans; it books nothing and moves nothing. Working days are Sunday to Thursday. No model.
 */
import { prisma } from "./db.js";
import { agentSetting, upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, parseDay, DAY, type AgentActor } from "./agent-core.js";
import { nextNumber } from "./sequence.js";
import { logActivity, logAudit } from "./auth.js";
import { notifyTaskAssigned } from "./notify.js";

export const KEY = "visit-planner";
const HORIZON_DAYS = 7;
const ONLINE = /absher|qiwa|muqeem|mudad|gosi|balady|nafath|tawakkalna|mol online|e-?services|portal|online|website|musaned|ejar|najiz|zakat.*portal/i;
const IN_PERSON = /jawazat|passport|labou?r office|maktab|chamber|embassy|consulate|medical|hospital|clinic|lab\b|court|mofa|attestation|police|traffic|civil affairs|ahwal|municipality|customs|office|branch|center|centre/i;

export async function inPersonCenters(): Promise<{ names: string[]; configured: boolean; all: { name: string; inPerson: boolean }[] }> {
  const centers = await prisma.govCenter.findMany({ where: { retired: false }, select: { name: true, sub: true }, orderBy: { name: "asc" } });
  const set = ((await agentSetting(KEY)).options as any)?.inPersonCenters;
  const configured = Array.isArray(set);
  const guess = (c: { name: string; sub: string | null }) => !ONLINE.test(`${c.name} ${c.sub ?? ""}`) && IN_PERSON.test(`${c.name} ${c.sub ?? ""}`);
  const all = centers.map(c => ({ name: c.name, inPerson: configured ? (set as string[]).includes(c.name) : guess(c) }));
  return { names: all.filter(c => c.inPerson).map(c => c.name), configured, all };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const isWorkday = (t: number) => { const d = new Date(t).getUTCDay(); return d !== 5 && d !== 6; };
const dayLabel = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/** The last working day on or before `t`, but never before `floor`. */
function lastWorkday(t: number, floor: number) {
  let x = t;
  while (x > floor && !isWorkday(x)) x -= DAY;
  while (!isWorkday(x)) x += DAY;
  return Math.max(x, floor);
}

type Item = { kind: "appointment" | "step" | "courier"; id: string; place: string; label: string; client: string | null; fixedDay: string | null; latest: string; assigneeId: string | null; assignee: string | null };

export async function planVisits(now = Date.now()) {
  const today = Date.parse(iso(now) + "T00:00:00Z");
  const firstDay = lastWorkday(today, today);
  const end = today + HORIZON_DAYS * DAY;
  const { names: centers } = await inPersonCenters();
  const centerFor = (text: string | null | undefined) => {
    const t = String(text ?? "").toLowerCase();
    return centers.find(c => t.includes(c.toLowerCase())) ?? null;
  };
  const items: Item[] = [];

  // Appointments: a fixed day and place.
  const appts = await prisma.appointment.findMany({ where: { date: { gte: iso(today), lte: iso(end) } } });
  for (const a of appts) {
    if (/attend|cancel|no.?show|done|complete/i.test(a.status)) continue;
    const place = centerFor(a.location) ?? centerFor(a.type) ?? (a.location?.trim() || null);
    if (!place) continue;
    items.push({ kind: "appointment", id: a.id, place, label: `${a.type ?? "Appointment"}${a.employee ? ` — ${a.employee}` : ""}${a.time ? ` at ${a.time}` : ""}`, client: a.clientName, fixedDay: a.date!.slice(0, 10), latest: a.date!.slice(0, 10), assigneeId: null, assignee: null });
  }

  // Workflow steps at an in-person center, due within the planning window (or overdue).
  const steps = await prisma.workflowTask.findMany({ where: { status: "active", govCenter: { in: centers } }, include: { instance: { select: { clientName: true, title: true } } } });
  for (const s of steps) {
    const due = parseDay(s.statutoryDue) ?? parseDay(s.dueDate);
    if (due !== null && due > end + 7 * DAY) continue; // not this week's business
    const latestT = due === null ? lastWorkday(end, firstDay) : lastWorkday(Math.min(due - DAY, end), firstDay);
    items.push({ kind: "step", id: s.id, place: s.govCenter!, label: `${s.title} · ${s.instance.title}`, client: s.instance.clientName, fixedDay: null, latest: iso(latestT), assigneeId: s.assigneeId, assignee: s.assignee });
  }

  // Courier jobs that start or end at an in-person center.
  const shipments = await prisma.courierShipment.findMany({ where: { NOT: { status: { in: ["Delivered", "Returned", "delivered", "returned", "Cancelled"] } } } });
  for (const c of shipments) {
    const place = centerFor(c.fromPlace) ?? centerFor(c.toPlace);
    if (!place) continue;
    const eta = parseDay(c.eta);
    const latestT = eta === null ? lastWorkday(end, firstDay) : lastWorkday(Math.min(eta, end), firstDay);
    items.push({ kind: "courier", id: c.id, place, label: `${centerFor(c.fromPlace) === place ? "Collect" : "Deliver"} ${c.description ?? c.ref}`, client: c.clientName, fixedDay: null, latest: iso(latestT), assigneeId: null, assignee: null });
  }

  // Trips: fixed days first, then flexible items by deadline.
  type Trip = { place: string; day: string; items: Item[] };
  const trips: Trip[] = [];
  for (const it of items.filter(i => i.fixedDay)) {
    const trip = trips.find(t => t.place === it.place && t.day === it.fixedDay);
    if (trip) trip.items.push(it); else trips.push({ place: it.place, day: it.fixedDay!, items: [it] });
  }
  for (const it of items.filter(i => !i.fixedDay).sort((a, b) => a.latest.localeCompare(b.latest))) {
    const existing = trips.filter(t => t.place === it.place && t.day <= it.latest && t.day >= iso(firstDay)).sort((a, b) => a.day.localeCompare(b.day))[0];
    if (existing) existing.items.push(it);
    else trips.push({ place: it.place, day: it.latest, items: [it] });
  }
  trips.sort((a, b) => a.day.localeCompare(b.day) || a.place.localeCompare(b.place));
  // Items that would each have been their own trip without a plan: one per item on a different day or place.
  const separate = items.length;
  return { items, trips, separate, saved: Math.max(0, separate - trips.length), centers };
}

export async function runVisitPlanner(now = Date.now()) {
  const plan = await planVisits(now);
  const key = `plan:${iso(now)}`;
  const seen = new Set<string>();
  if (plan.trips.length) {
    seen.add(key);
    const staff = await prisma.user.findMany({ where: { type: "staff", status: "active" }, select: { id: true, name: true } });
    const officerOf = (t: { items: Item[]; place: string }) => {
      const counts = new Map<string, number>();
      for (const i of t.items) if (i.assigneeId) counts.set(i.assigneeId, (counts.get(i.assigneeId) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? staff.find(s => s.id === top[0]) ?? null : null;
    };
    const center = await prisma.govCenter.findMany({ where: { name: { in: plan.trips.map(t => t.place) } }, select: { name: true, officer: true } });
    const trips = plan.trips.map(t => {
      const by = officerOf(t);
      const fallback = center.find(c => c.name === t.place)?.officer ?? null;
      return { place: t.place, day: t.day, officerId: by?.id ?? null, officer: by?.name ?? fallback, items: t.items.map(i => ({ kind: i.kind, id: i.id, label: i.label, client: i.client, fixed: !!i.fixedDay })) };
    });
    await upsertFinding(KEY, key, {
      kind: "visit-plan", refType: "plan", refId: iso(now),
      title: `Visit plan: ${plan.trips.length} trip${plan.trips.length === 1 ? "" : "s"} for ${plan.items.length} item${plan.items.length === 1 ? "" : "s"}${plan.saved ? ` — ${plan.saved} fewer trip${plan.saved === 1 ? "" : "s"}` : ""}`,
      summary: trips.map(t => `${dayLabel(t.day)} · ${t.place} (${t.items.length})`).join(" · "),
      output: {
        trips, saved: plan.saved,
        facts: [
          { label: "This week", value: `${plan.items.length} things to do in person at ${new Set(plan.trips.map(t => t.place)).size} center${new Set(plan.trips.map(t => t.place)).size === 1 ? "" : "s"}` },
          { label: "Trips", value: `${plan.trips.length} planned instead of ${plan.separate} separate` },
        ],
        lists: trips.map(t => ({ title: `${dayLabel(t.day)} · ${t.place}${t.officer ? ` · ${t.officer}` : ""}`, items: t.items.map(i => ({ text: `${i.kind === "appointment" ? "📅" : i.kind === "courier" ? "📦" : "📝"} ${i.label}${i.client ? ` · ${i.client}` : ""}${i.fixed ? " (booked)" : ""}` })) })),
        proposal: { kind: "tasks", text: `Create ${trips.length} visit task${trips.length === 1 ? "" : "s"}, one per trip, for the officer who has most of its work.` },
      },
    });
  }
  await closeMissing(KEY, "visit-plan", seen, "Replaced by a newer plan");
  await markRun(KEY);
  return { trips: plan.trips.length, items: plan.items.length, saved: plan.saved };
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That plan no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This plan is already ${t.status}.`, 409);
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  if (action !== "tasks") throw new AgentActionError("Unknown action.");
  await requirePerm(actor, "Tasks", "Create", "create tasks");
  const trips = ((t.output as any)?.trips ?? []) as { place: string; day: string; officerId: string | null; officer: string | null; items: { label: string; client: string | null }[] }[];
  const made: string[] = [];
  for (const trip of trips) {
    const title = `Visit ${trip.place} — ${trip.items.length} item${trip.items.length === 1 ? "" : "s"}`;
    // A second click, or a plan re-created the same day, must not book the same trip twice.
    if (await prisma.task.findFirst({ where: { title, dueDate: trip.day, govCenter: trip.place, archived: false } })) continue;
    const task = await prisma.task.create({ data: {
      ref: await nextNumber("task"), title, dueDate: trip.day, govCenter: trip.place, priority: "medium", status: "todo",
      assignee: trip.officer || "Unassigned", assigneeId: trip.officerId,
      customData: { visitPlan: true, items: trip.items.map(i => `${i.label}${i.client ? ` · ${i.client}` : ""}`) } as any,
    } });
    made.push(`${task.ref ?? ""} ${trip.place} ${trip.day}`.trim());
    if (task.assigneeId) notifyTaskAssigned({ assigneeId: task.assigneeId, title, dueDate: trip.day, why: `visit plan: ${trip.items.map(i => i.label).join("; ").slice(0, 200)}` });
  }
  await logAudit({ action: "visit.plan.tasks", actorId: actor.id, target: t.dedupeKey, detail: made.join(", ").slice(0, 900) });
  logActivity({ type: "task", message: `${made.length} visit task${made.length === 1 ? "" : "s"} created from the visit plan`, user: actor.name });
  await decide(t.id, "done", actor, { tasksCreated: made.length });
  return { ok: true, message: made.length ? `Created ${made.length} visit task${made.length === 1 ? "" : "s"}.` : "Those visit tasks already exist." };
}
