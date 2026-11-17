/**
 * COMPANY ACQUISITION, AS A SERVICE A CLIENT CAN BUY ON ITS OWN.
 *
 *   npx tsx scripts/build-company-acquisition.ts            # says what it would do
 *   npx tsx scripts/build-company-acquisition.ts --apply    # does it
 *
 * Buying a company already happens inside Business Setup: a trading client with nothing in hand
 * opens three acquisition lanes after G2. But the firm also sells an acquisition on its own —
 * QT-014 is one — and that line matched nothing in the catalog, so accepting it created a bare
 * unassigned task with no steps, no SLA and no gate. The work existed; the process did not.
 *
 * THE STEPS ARE NOT WRITTEN HERE. They are lifted from the Business Setup template's parent lane
 * and re-labelled, so the two can never drift into saying different things about the same job. Edit
 * the lane in build-business-setup.ts and re-run this; there is one definition of how a company is
 * bought, and it lives there.
 *
 * ONE GATE, WHICH THE LANE DOES NOT HAVE. Inside Business Setup the money is approved at G2 before
 * any lane opens. Standing alone there is no G2, so without this the firm would commit a client's
 * money on an SPA with nobody but the officer having looked at it. It sits after diligence and
 * before the price is agreed, which is the last moment it is free.
 */
import { prisma } from "../src/db.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("build-company-acquisition");
const APPLY = process.argv.includes("--apply");

const TPL_NAME = "Company Acquisition";
const SVC_NAME = "Company Acquisition";
const SOURCE_TPL = "Business Setup";
const LANE = ["acqp_find", "acqp_dd", "acqp_spa", "acqp_transfer"];

type N = { id: string; type: string; label: string; config?: any };
type E = { from: string; to: string; condition?: string };

const src = await prisma.workflowTemplate.findFirst({ where: { name: SOURCE_TPL } });
if (!src) {
  console.error(`"${SOURCE_TPL}" is not installed, and its parent lane is where these steps come from.`);
  console.error("Run build-business-setup.ts --apply first.");
  process.exit(1);
}
const srcNodes: any[] = Array.isArray((src.graph as any)?.nodes) ? (src.graph as any).nodes : [];
const lane = LANE.map(id => srcNodes.find(n => n.id === id));
if (lane.some(n => !n)) {
  console.error(`the parent lane is not in "${SOURCE_TPL}" as expected (looked for ${LANE.join(", ")}).`);
  process.exit(1);
}

/** Same step, said without the word "parent": standing alone there is nothing for it to be parent to. */
const relabel = (s: string) => String(s)
  .replace(/\ba parent company\b/gi, "a company")
  .replace(/\bparent company\b/gi, "company")
  .replace(/\bthe parent's\b/gi, "the company's")
  // The lane says which of its three companies a step is about; alone there is only one, and
  // "Due diligence — company" reads like a draft nobody finished.
  .replace(/\s*[—-]\s*company\s*$/i, "");
/** Capture variables keep the step's meaning but lose the lane's prefix. */
const revar = (s: string) => String(s).replace(/^acqp/, "acq");

const steps: N[] = lane.map((n: any) => {
  const c = { ...(n.config ?? {}) };
  if (Array.isArray(c.captures)) c.captures = c.captures.map((x: any) => ({ ...x, var: revar(x.var), label: relabel(x.label) }));
  if (typeof c.instructions === "string") c.instructions = relabel(c.instructions);
  return { id: n.id.replace(/^acqp/, "acq"), type: n.type, label: relabel(n.label), config: c };
});

const gate: N = {
  id: "acq_g1", type: "approval", label: "G1 — approve the target and the price",
  config: {
    approverRole: "admin", assigneeRole: "admin", slaHours: 48,
    instructions: "Diligence is in. Approve to let the SPA be signed and the client's money committed; reject to send it back for another target. Nobody approves the diligence they did themselves.",
  },
};

const nodes: N[] = [
  { id: "start", type: "start", label: "Acquisition agreed" },
  steps[0], steps[1], gate, steps[2], steps[3],
  { id: "end", type: "end", label: "Company transferred", config: { result: "completed" } },
];
const edges: E[] = [
  { from: "start", to: "acq_find" },
  { from: "acq_find", to: "acq_dd" },
  { from: "acq_dd", to: "acq_g1" },
  { from: "acq_g1", to: "acq_spa", condition: "approve" },
  { from: "acq_g1", to: "acq_find", condition: "reject" },
  { from: "acq_spa", to: "acq_transfer" },
  { from: "acq_transfer", to: "end" },
];

console.log(`${nodes.length} nodes · ${steps.length} work steps · 1 gate · ${edges.length} edges`);
console.log(`steps lifted from "${SOURCE_TPL}" (${LANE.join(", ")}):\n`);
for (const n of nodes) {
  if (n.type === "start" || n.type === "end") continue;
  console.log(`  ${n.type === "approval" ? "GATE " : "step "}${String(n.label).padEnd(46)} ${n.config?.approverRole ?? n.config?.assigneeRole}`);
}

// ── the checks ───────────────────────────────────────────────────────────────────────────────
let bad = 0;
const ids = new Set(nodes.map(n => n.id));
for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) { console.log(`  FAIL edge ${e.from} → ${e.to} points at a node that does not exist`); bad++; }
// The golden rule, same as the other template: the gate is never the role that did the work in
// front of it. The engine enforces it per person; a template that hands both jobs to one role
// guarantees a stall on a small team.
const before = nodes.find(n => n.id === edges.find(e => e.to === gate.id)!.from)!;
if (before.config?.assigneeRole === gate.config.approverRole) { console.log("  FAIL the gate is approved by the role that did the step before it"); bad++; }
// A reject that goes nowhere is a dead end a case cannot leave.
if (!edges.some(e => e.from === gate.id && e.condition === "reject")) { console.log("  FAIL the gate has no reject path"); bad++; }

console.log("\nwho holds each role on this template:");
for (const r of [...new Set(nodes.map(n => n.config?.approverRole ?? n.config?.assigneeRole).filter(Boolean) as string[])].sort()) {
  const holders = await prisma.user.findMany({ where: { roleId: r, status: "active", type: "staff" }, select: { name: true } });
  if (!holders.length) bad++;
  console.log(`  ${r.padEnd(14)} ${holders.length ? holders.map(h => h.name).join(", ") : "!! NOBODY — these steps will wait on an empty desk"}`);
}
if (bad) { console.error(`\n${bad} check(s) failed — refusing to write this template.`); process.exit(1); }

// ── which past quotation lines would reach it ────────────────────────────────────────────────
//
// Matching is by name: exact, then contains either way. Worth printing, because the line is free
// text and the firm has written this service five different ways.
const seen = new Map<string, number>();
for (const q of await prisma.quotation.findMany({ select: { items: true } })) {
  for (const it of (Array.isArray(q.items) ? (q.items as any[]) : [])) {
    const n = String(it?.name ?? "").trim();
    if (n) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
}
const hits = (n: string) => {
  const a = n.toLowerCase(), b = SVC_NAME.toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
};
const acquisitionish = [...seen.keys()].filter(n => /acquisi|acquire|takeover/i.test(n));
console.log("\nacquisition lines already written on quotations:");
for (const n of acquisitionish) console.log(`  ${hits(n) ? "matches  " : "MISSES   "} ${n}`);
console.log("  (a miss becomes a plain task, as all of them do today — there is no alias field to fold them into one name)");

if (!APPLY) { console.log("\ndry run — nothing written. Add --apply."); await prisma.$disconnect(); process.exit(0); }

const prior = await prisma.workflowTemplate.findFirst({ where: { name: TPL_NAME } });
const tpl = prior
  ? await prisma.workflowTemplate.update({ where: { id: prior.id }, data: { graph: { nodes, edges } as any, entityType: "company", trigger: "manual", country: "SA" } })
  : await prisma.workflowTemplate.create({ data: { name: TPL_NAME, description: "Buy an existing company: find it, check it, pay for it, own it.", graph: { nodes, edges } as any, entityType: "company", trigger: "manual", country: "SA", active: false, version: 1 } as any });
console.log(`\ntemplate: ${prior ? "updated" : "created"} ${tpl.id}`);

const svc = await prisma.serviceItem.findFirst({ where: { name: SVC_NAME } });
if (svc) {
  await prisma.serviceItem.update({ where: { id: svc.id }, data: { workflowId: tpl.id } });
  console.log(`service: "${SVC_NAME}" re-bound to this workflow`);
} else {
  await prisma.serviceItem.create({ data: { name: SVC_NAME, workflowId: tpl.id, sla: "30 working days", time: "4–6 weeks", country: "SA" } as any });
  console.log(`service: "${SVC_NAME}" created and bound — an accepted quotation line now opens a case`);
}

console.log(`
The template is saved INACTIVE. Open it in the Workflow Builder, read it, and activate it there.

A quotation carrying BOTH "Business Setup" and an acquisition line would open the lanes inside the
setup case AND a case here for the same company. startDeliveryForQuotation refuses the second one
and says so; see the comment there.`);

await prisma.$disconnect();
