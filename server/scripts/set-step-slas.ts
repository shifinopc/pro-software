/**
 * Give workflow steps an SLA, derived from what the firm has already said about the service.
 *
 * WHY A TOOL AND NOT TYPING
 *
 * Operations Performance can measure an on-time rate, and it reported nothing at all, because almost
 * no step carries an `slaHours`. The Builder can set one — but only through a per-node prompt, which
 * is exactly why 30 templates between them have a handful: nobody is going to click through 200
 * prompts. The work is bulk, so the tool is bulk.
 *
 * WHERE THE NUMBERS COME FROM — AND WHERE THEY DO NOT
 *
 * They are NOT invented here. A service already carries the firm's own statement of how long it
 * takes: `sla` ("5 working days") and `time` ("3–5 days"). That is the only trustworthy figure in the
 * system, so a template only gets a proposal when a service is bound to it and says something. Every
 * other template is listed as "nothing to derive from" and left completely alone. Inventing "Qiwa
 * takes 48 hours" would be me guessing at a government process I have never run.
 *
 * TWO CONVERSIONS, BOTH STATED OUT LOUD
 *
 *  · WORKING DAYS → WALL CLOCK. The SLA clock in escalateSla is wall-clock: it compares `createdAt`
 *    to now, and does not know about weekends. So "5 working days" is 7 calendar days, not 5 — the
 *    ×7/5 is applied here rather than silently making every SLA breach a day and a half early.
 *  · WHOLE SERVICE → PER STEP. The service states a duration for the whole job. It is split evenly
 *    across the steps a HUMAN works (task and approval), because nothing in the data says which step
 *    is the slow one. Even is a starting point, not a claim — the whole point of writing it into the
 *    template is that somebody who knows can then change the two that are wrong.
 *
 * DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/set-step-slas.ts                 # propose, write nothing
 *   npx tsx scripts/set-step-slas.ts --apply         # write
 *   npx tsx scripts/set-step-slas.ts --apply --force # also overwrite steps that already have one
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

/** Steps a person actually works. A notify or a delay finishing "late" is meaningless. */
const HUMAN_STEPS = new Set(["task", "approval"]);

/**
 * "5 working days" / "3–5 days" / "2 weeks" → wall-clock hours.
 *
 * Takes the LAST number in a range, the same rule `dueDateFrom` uses: quoting the optimistic end of
 * somebody else's estimate as a deadline is how work is late the day it is created.
 */
export function hoursFrom(...texts: (string | null | undefined)[]): number | null {
  for (const t of texts) {
    const s = String(t ?? "");
    if (!s) continue;
    const nums = s.match(/\d+/g);
    if (!nums?.length) continue;
    const n = Number(nums[nums.length - 1]);
    if (!(n > 0)) continue;
    if (/hour/i.test(s)) return n;
    const days = /week/i.test(s) ? n * 7 : /month/i.test(s) ? n * 30 : n;
    // Working days are 5 in 7. Without this every SLA would fire a day and a half early on a job
    // that is running exactly to the schedule the firm quoted the client.
    const calendar = /working|business/i.test(s) ? Math.ceil(days * 7 / 5) : days;
    return calendar * 24;
  }
  return null;
}

async function main() {
  const templates = await prisma.workflowTemplate.findMany({ where: { retired: false }, select: { id: true, name: true, active: true, graph: true } });
  const services = await prisma.serviceItem.findMany({ where: { retired: false }, select: { name: true, workflowId: true, sla: true, time: true } });

  // A template can back several services (four of them share "Employee Exit / Visa Cancellation").
  // The SHORTEST stated duration wins: a template that must satisfy a 3-day promise and a 5-day one
  // is late at 3, and taking the longer figure would quietly excuse missing the tighter promise.
  const bound = new Map<string, { hours: number; from: string }>();
  for (const s of services) {
    if (!s.workflowId) continue;
    const h = hoursFrom(s.sla, s.time);
    if (h == null) continue;
    const cur = bound.get(s.workflowId);
    if (!cur || h < cur.hours) bound.set(s.workflowId, { hours: h, from: `${s.name}: ${s.sla ?? s.time}` });
  }

  const planned: string[] = [];
  const skipped: string[] = [];
  let wrote = 0, stepsSet = 0;

  for (const t of templates) {
    const graph = (t.graph as any) ?? {};
    const nodes = (graph.nodes ?? []) as any[];
    const human = nodes.filter(n => HUMAN_STEPS.has(n?.type));
    if (!human.length) { skipped.push(`${t.name} — no task or approval steps`); continue; }

    const src = bound.get(t.id);
    if (!src) { skipped.push(`${t.name} — no service bound, so nothing to derive from`); continue; }

    const target = human.filter(n => FORCE || !(typeof n?.config?.slaHours === "number" && n.config.slaHours > 0));
    if (!target.length) { skipped.push(`${t.name} — every step already has one`); continue; }

    // Split across ALL human steps, not just the empty ones: the service's duration covers the whole
    // job, so sizing the untouched ones against a smaller denominator would inflate them.
    const per = Math.max(1, Math.round(src.hours / human.length));
    planned.push(`${t.active ? "●" : "○"} ${t.name}\n    ${src.hours}h total (${src.from}) ÷ ${human.length} step(s) = ${per}h each\n    setting ${target.length} of ${human.length}${FORCE ? " (--force: overwriting existing)" : " (leaving ones already set)"}`);

    if (APPLY) {
      for (const n of target) { n.config = { ...(n.config ?? {}), slaHours: per }; stepsSet++; }
      await prisma.workflowTemplate.update({ where: { id: t.id }, data: { graph: { ...graph, nodes } as any } });
      wrote++;
    }
  }

  console.log(planned.length ? `PROPOSED${APPLY ? " — WRITTEN" : " (dry run)"}\n\n${planned.join("\n\n")}` : "Nothing to propose.");
  console.log(`\n\nLEFT ALONE (${skipped.length})`);
  for (const s of skipped) console.log(`  · ${s}`);
  console.log(APPLY
    ? `\n${wrote} template(s) updated, ${stepsSet} step(s) given an SLA.`
    : `\nNothing was written. Re-run with --apply to write.`);

  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
