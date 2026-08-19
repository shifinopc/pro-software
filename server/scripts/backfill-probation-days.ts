/**
 * Give in-flight probations the days they have already served.
 *
 * The 180-day cap counts `probationDaysUsed`, and a delay node only started writing it when the
 * accumulator was added. Runs that entered probation before that carry nothing — and `undefined >= 180`
 * is false, so the cap never fires for them. An instance that had already served 90 days read 30
 * after its first extension, and could go on to roughly 240 days before anything stopped it: the
 * exact outcome the cap exists to prevent, on the only runs old enough to be near it.
 *
 * WHAT IT COUNTS, and why the first version of this was wrong.
 *
 * The engine adds a delay's FULL configured length the moment the run enters it — probation is
 * ninety days committed on entry, not ninety days accrued. This script originally counted an
 * in-progress wait as the days elapsed so far, which reads more carefully but disagrees with the
 * only number the cap ever compares against. Two ways of counting the same thing is how a ceiling
 * ends up firing at the wrong moment.
 *
 * So: every entry into a counting delay contributes its full configured days, read from the
 * `delay.waiting` lines in the run's own log. An extension loop that ran three times logged three
 * entries and contributes three times.
 *
 * IT RECONCILES RATHER THAN SKIPS. The first version left any run that already had a value alone,
 * which missed the case that matters most: a run whose probation started before the accumulator
 * existed and which has since been extended. Its extension counted from zero, so it read 30 where it
 * had served 120 — and could reach roughly 270 days before the cap noticed. A stored value lower
 * than the log supports is corrected upward; a higher one is left, because over-counting only brings
 * the ceiling forward and may be somebody's deliberate entry.
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

    // Every entry into a counting delay, from the run's own log, at its full configured length —
    // the same arithmetic the engine performs when it enters one.
    const logs = await prisma.workflowLog.findMany({
      where: { instanceId: inst.id, action: "delay.waiting" },
      select: { nodeId: true },
    });
    const delays: Record<string, string> = vars._delays ?? {};

    let served = 0;
    const seen: string[] = [];
    for (const c of counters) {
      const configured = Number(c.config?.days) || 0;
      if (!configured) continue;
      let entries = logs.filter(l => l.nodeId === c.id).length;
      // A run sitting in the delay right now whose entry predates logging still counts once.
      if (!entries && delays[c.id]) entries = 1;
      if (!entries) continue;
      served += entries * configured;
      seen.push(`${c.id} ×${entries} (+${entries * configured})`);
    }

    const current = Number(vars[key]);
    const has = vars[key] !== undefined && vars[key] !== null && !isNaN(current);
    if (has && current >= served) { already++; continue; }

    if (!seen.length) { notInProbation++; continue; }
    console.log(`  ${inst.title.slice(0, 30).padEnd(32)} ${key} ${has ? current + " → " : "= "}${served}   ${seen.join(", ")}`);
    if (APPLY) {
      await prisma.workflowInstance.update({ where: { id: inst.id }, data: { variables: { ...vars, [key]: served } } });
      await prisma.workflowLog.create({ data: {
        instanceId: inst.id, action: "probation.backfilled", nodeId: counters[0].id,
        detail: `${key} ${has ? `corrected from ${current} to ${served}` : `set to ${served}`} from the waits this run has entered`,
        actor: "engine", at: new Date().toISOString(),
      } });
    }
    touched++;
  }

  console.log(`\n${touched} ${APPLY ? "backfilled" : "would be backfilled"} · ${already} already counted · ${notInProbation} not in a counted wait`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
