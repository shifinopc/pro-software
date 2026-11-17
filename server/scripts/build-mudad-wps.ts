/**
 * MUDAD WPS — THE MONTHLY WAGE FILE, ONE CASE PER CLIENT.
 *
 *   npx tsx scripts/build-mudad-wps.ts            # says what it would do
 *   npx tsx scripts/build-mudad-wps.ts --apply    # does it
 *
 * Every month each client's wages have to reach Mudad, and who does the work differs by client:
 * some run their own payroll and send us the WPS file, for others we run it. The month is the
 * same either way, so it is one workflow with a fork, not two workflows.
 *
 * NOTHING NEW SCHEDULES THIS. `startPeriodicRuns()` already opens one run per entitled client for
 * any template marked `trigger: "recurring"`, on the day `opensOnDay` names, keyed to the period
 * so a second tick on the same day cannot open a second case. It also decides WHO gets one: the
 * clients whose package or add-ons hold the service this template is bound to. Adding a client to
 * the monthly run is therefore editing their package, not editing this file.
 *
 * TWO THINGS THE TEMPLATE MUST SAY ITSELF, because the engine will not infer them:
 *
 *   · The fork is driven by an ANSWER, not by a setting. Who runs payroll can change month to
 *     month — a client takes it in-house, or asks us to cover a month — so step one asks and the
 *     decision routes on the answer rather than on anything remembered about the client.
 *
 *   · "Tell the client" is only required when the client is doing the work. Captures are drawn
 *     unconditionally, so the box is always visible; a cross-field RULE makes it required only on
 *     the branch where it means something. Required-always would block every self-run month on a
 *     question that does not apply to it.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("build-mudad-wps");
const APPLY = process.argv.includes("--apply");

const TPL_NAME = "Mudad WPS";
const SVC_NAME = "Mudad WPS";
const ROLE = "pro_officer";

type N = { id: string; type: string; label: string; config?: any };
type E = { from: string; to: string; condition?: string };

/**
 * The deadline, as a date rather than a countdown.
 *
 * An SLA counts hours from the moment a step is created, so a case that sat for three days would
 * report itself on time until the 18th. The wage file is due on a DAY — the 15th — and the engine
 * can express that: a statutory clock counted from the period the run belongs to, which the
 * scheduler seeds as `period` (2026-11) and which reads as the 1st of that month.
 *
 * 14 days rather than the built-in `by_15th_next_month`: that rule is for filings due the month
 * after the one they cover, and this one is due inside its own month.
 */
const dueBy15th = [{ key: "wps", label: "WPS filed in Mudad", from: "period", rule: "days", days: 14, basis: "Wage Protection System" }];

const nodes: N[] = [
  { id: "start", type: "start", label: "Payroll month opens" },

  /**
   * Both answers live on one step on purpose. Asking "who runs it?" and "have you told them?" as
   * two steps would put a second row in somebody's queue to record a thing they have already done.
   */
  {
    id: "who", type: "task", label: "Who runs payroll this month?",
    config: {
      assigneeRole: ROLE, slaHours: 48,
      instructions: "Decide whether the client runs payroll themselves this month or we do. If it is the client, tell them now that their WPS file is needed before the 15th, and tick that you have told them.",
      captures: [
        { var: "payrollBy", label: "Payroll run by", type: "select", options: "client,self", required: true },
        { var: "clientInformed", label: "Client told their WPS file is due", type: "select", options: "yes,no", required: false },
      ],
      // The conditional half of the step. `when` selects the branch the rule applies to; `then` is
      // what must hold on it. On a self-run month neither fires, so the box is ignored.
      rules: [{
        when: { var: "payrollBy", op: "eq", value: "client" },
        then: { var: "clientInformed", op: "eq", value: "yes" },
        message: "Tell the client their WPS file is due before the 15th, then tick the box.",
      }],
    },
  },

  {
    id: "fork", type: "decision", label: "Who is running payroll?",
    config: { branches: [{ var: "payrollBy", op: "eq", value: "client", key: "client" }] },
  },

  // ── the client runs it: we receive the file and file it ────────────────────────────────────
  {
    id: "client_wps", type: "task", label: "Receive the WPS file and apply it in Mudad",
    config: {
      assigneeRole: ROLE, slaHours: 312,
      instructions: "Chase the client for the WPS file if it has not arrived, then apply it on the Mudad site. Due before the 15th — a late wage file is a penalty on the client, not a missed internal target.",
      statutory: dueBy15th,
      checklist: [
        { key: "wps_received", label: "WPS file received from the client", required: true },
        { key: "wps_applied", label: "WPS applied on the Mudad site", required: true },
      ],
    },
  },

  // ── we run it: payroll, then the upload ────────────────────────────────────────────────────
  {
    id: "self_wps", type: "task", label: "Run payroll and upload the WPS",
    config: {
      assigneeRole: ROLE, slaHours: 312,
      instructions: "Process this month's payroll, then upload the WPS file to Mudad. Due before the 15th — a late wage file is a penalty on the client, not a missed internal target.",
      statutory: dueBy15th,
      checklist: [
        { key: "payroll_processed", label: "Payroll processed", required: true },
        { key: "wps_uploaded", label: "WPS uploaded to Mudad", required: true },
      ],
    },
  },

  { id: "end", type: "end", label: "WPS filed for the month", config: { result: "completed" } },
];

const edges: E[] = [
  { from: "start", to: "who" },
  { from: "who", to: "fork" },
  { from: "fork", to: "client_wps", condition: "client" },
  { from: "fork", to: "self_wps", condition: "else" },
  { from: "client_wps", to: "end" },
  { from: "self_wps", to: "end" },
];

// ── what it is ───────────────────────────────────────────────────────────────────────────────
console.log(`${nodes.length} nodes · ${edges.length} edges\n`);
for (const n of nodes) {
  if (n.type === "start" || n.type === "end") continue;
  const who = n.config?.assigneeRole ?? "—";
  console.log(`  ${n.type === "decision" ? "fork " : "step "}${String(n.label).padEnd(44)} ${who}`);
  for (const c of (n.config?.checklist ?? [])) console.log(`        [ ] ${c.label}`);
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────
let bad = 0;
const ids = new Set(nodes.map(n => n.id));
for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) { console.log(`  FAIL edge ${e.from} → ${e.to} points at a node that does not exist`); bad++; }

// Both answers must lead somewhere. A fork with one wire sends half the months into nothing.
for (const key of ["client", "else"]) {
  if (!edges.some(e => e.from === "fork" && e.condition === key)) { console.log(`  FAIL the fork has no "${key}" branch`); bad++; }
}

// The rule has to fire on the branch it is written for, and stay silent on the other.
const { brokenRules } = await import("../src/workflow.js");
const cfg = nodes.find(n => n.id === "who")!.config;
const cases: [string, Record<string, string>, boolean][] = [
  ["client, not told", { payrollBy: "client" }, true],
  ["client, told", { payrollBy: "client", clientInformed: "yes" }, false],
  ["client, ticked no", { payrollBy: "client", clientInformed: "no" }, true],
  ["self, box empty", { payrollBy: "self" }, false],
  ["self, ticked no", { payrollBy: "self", clientInformed: "no" }, false],
];
console.log("\ntelling the client is required only when the client is doing it:");
for (const [name, vars, shouldBlock] of cases) {
  const blocked = brokenRules(cfg, vars).length > 0;
  if (blocked !== shouldBlock) bad++;
  console.log(`  ${blocked === shouldBlock ? "ok  " : "FAIL"} ${name.padEnd(18)} ${blocked ? "blocked" : "allowed"}`);
}

const holders = await prisma.user.findMany({ where: { roleId: ROLE, status: "active", type: "staff" }, select: { name: true } });
console.log(`\n${ROLE}: ${holders.length ? holders.map(h => h.name).join(", ") : "!! NOBODY — every step would wait on an empty desk"}`);
if (!holders.length) bad++;
if (bad) { console.error(`\n${bad} check(s) failed — refusing to write this template.`); process.exit(1); }

if (!APPLY) { console.log("\ndry run — nothing written. Add --apply."); await prisma.$disconnect(); process.exit(0); }

const prior = await prisma.workflowTemplate.findFirst({ where: { name: TPL_NAME } });
const data = {
  graph: { nodes, edges } as any, entityType: "company", country: "SA",
  trigger: "recurring", triggerConfig: { every: "monthly", opensOnDay: 1 } as any,
};
const tpl = prior
  ? await prisma.workflowTemplate.update({ where: { id: prior.id }, data })
  : await prisma.workflowTemplate.create({ data: { name: TPL_NAME, description: "The monthly wage file: who runs payroll, then WPS into Mudad before the 15th.", ...data, active: false, version: 1 } as any });
console.log(`\ntemplate: ${prior ? "updated" : "created"} ${tpl.id}`);

const svc = await prisma.serviceItem.findFirst({ where: { name: SVC_NAME } });
if (svc) { await prisma.serviceItem.update({ where: { id: svc.id }, data: { workflowId: tpl.id } }); console.log(`service: "${SVC_NAME}" re-bound`); }
else { await prisma.serviceItem.create({ data: { name: SVC_NAME, workflowId: tpl.id, sla: "by the 15th", time: "monthly", country: "SA" } as any }); console.log(`service: "${SVC_NAME}" created and bound`); }

console.log(`
TWO THINGS BEFORE A CASE EVER OPENS:

  1. ACTIVATE IT. Unlike a workflow a quotation starts, the monthly job reads \`active\` — it only
     looks at templates where active = true. Draft means no case is ever opened, silently.
  2. ENTITLE THE CLIENTS. The job opens a case for clients whose package or add-ons include
     "${SVC_NAME}". Nobody holds it yet, so today it would open nothing and say so.`);

await prisma.$disconnect();
