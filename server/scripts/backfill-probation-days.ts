/**
 * Give in-flight probations the days they have already served.
 *
 * The 180-day cap counts `probationDaysUsed`, and a delay node only started writing it when the
 * accumulator was added. Runs that entered probation before that carry nothing — and `undefined >= 180`
 * is false, so the cap never fires for them. An instance that had already served 90 days read 30
 * after its first extension, and could go on to roughly 240 days before anything stopped it: the
 * exact outcome the cap exists to prevent, on the only runs old enough to be near it.
 *
 * WHAT IT COUNTS, and why it is not simply "90".
 *
 * The days actually served, from when the probation delay was recorded to now, capped at the
 * configured length of that delay. A run three weeks into a 90-day probation has served 21 days, not
 * 90 — writing 90 would push it toward the ceiling faster than the employee's own calendar does, and
 * this is a number that decides whether somebody can be extended again.
 *
 * The delay's start is taken from the `delay.waiting` log line, which records when the wait began.
 * A run whose log has been trimmed falls back to the wait's own end date minus the configured
 * duration, which is the same arithmetic from the other end.
 *
 * A wait that has ALREADY FINISHED counts its full configured length, even if a supervisor resumed it
 * early. That is deliberately the conservative direction: over-counting can only bring the ceiling
 * forward and force a confirm-or-terminate sooner, while under-counting is what lets a probation run
 * past 180 days — which is the thing that must not happen.
 *
 * Idempotent: a run that already has a count is left alone. Dry run by default; --apply writes.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const running = await prisma.workflowInstance.findMany({ where: { status: "running" } });
  const templates = new Map<string, any>();
  let touched = 0, already = 0, notInProbation = 0;

  for (const inst of running) {
    const vars: any = (inst.variables && typeof inst.variables === "object") ? inst.variables : {};

    if (!templates.has(inst.templateId)) {
      templates.set(inst.templateId, await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } }));
    }
    const g: any = templates.get(inst.templateId)?.graph ?? {};
    const nodes: any[] = g.nodes ?? [];

    // Which variable this template counts into, and which nodes count into it. Read from the graph
    // rather than hardcoded, so this stays correct for any workflow that adopts the same mechanism.
    const counters = nodes.filter(n => n?.type === "delay" && n?.config?.accumulateInto);
    if (!counters.length) continue;
    const key = String(counters[0].config.accumulateInto);

    if (vars[key] !== undefined && vars[key] !== null) { already++; continue; }

    // Has this run passed through, or is it sitting in, any of the counting delays?
    const logs = await prisma.workflowLog.findMany({
      where: { instanceId: inst.id, action: { in: ["delay.waiting", "delay.resumed"] } },
      orderBy: { at: "asc" },
      select: { nodeId: true, action: true, at: true, detail: true },
    });
    const delays: Record<string, string> = vars._delays ?? {};

    let served = 0;
    const seen: string[] = [];
    for (const c of counters) {
      const configured = Number(c.config?.days) || 0;
      if (!configured) continue;
      const started = logs.find(l => l.nodeId === c.id && l.action === "delay.waiting");
      const finished = logs.find(l => l.nodeId === c.id && l.action === "delay.resumed");
      const waitingNow = !!delays[c.id];

      if (finished) { served += configured; seen.push(`${c.id} completed (+${configured})`); continue; }

      if (waitingNow || started) {
        // Still inside it: count only the days elapsed so far.
        const from = started?.at ? new Date(started.at).getTime()
          : (delays[c.id] ? new Date(delays[c.id]).getTime() - configured * 86400000 : NaN);
        if (isNaN(from)) continue;
        const elapsed = Math.max(0, Math.min(configured, Math.floor((Date.now() - from) / 86400000)));
        served += elapsed;
        seen.push(`${c.id} in progress (+${elapsed} of ${configured})`);
      }
    }

    if (!seen.length) { notInProbation++; continue; }
    console.log(`  ${inst.title.slice(0, 34).padEnd(36)} ${key} = ${served}   ${seen.join(", ")}`);
    if (APPLY) {
      await prisma.workflowInstance.update({ where: { id: inst.id }, data: { variables: { ...vars, [key]: served } } });
      await prisma.workflowLog.create({ data: {
        instanceId: inst.id, action: "probation.backfilled", nodeId: counters[0].id,
        detail: `${key} set to ${served} from time already served — this run began before the counter existed`,
        actor: "engine", at: new Date().toISOString(),
      } });
    }
    touched++;
  }

  console.log(`\n${touched} ${APPLY ? "backfilled" : "would be backfilled"} · ${already} already counted · ${notInProbation} not in a counted wait`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
