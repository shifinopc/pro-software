/**
 * Throwaway check: does one case now appear at THREE authorities at once, one row per job?
 *
 * Builds a cancellation-shaped template — office work, then Qiwa, then Muqeem, then GOSI — runs it,
 * and reports which portal each active step is queued at. Then completes the Qiwa step and confirms
 * only that portal's row clears while the case carries on.
 *
 * Creates everything it needs and deletes all of it. Row counts should return to where they started.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const graph = {
  nodes: [
    { id: "n1", type: "trigger", label: "Start" },
    { id: "n2", type: "task", label: "Collect resignation letter", config: { assigneeRole: "pro_officer" } },
    { id: "n3", type: "task", label: "Cancel work permit", config: { assigneeRole: "pro_officer", govCenter: "Qiwa" } },
    { id: "n4", type: "task", label: "Cancel Iqama", config: { assigneeRole: "pro_officer", govCenter: "Muqeem" } },
    { id: "n5", type: "task", label: "GOSI deregistration", config: { assigneeRole: "pro_officer", govCenter: "GOSI" } },
    // The join earns its place: without it, the first authority job to be finished reaches End and
    // closes the case while the other two are still waiting. The first run of this probe was written
    // without one and did exactly that — which is now a validator warning.
    { id: "n6", type: "parallel_join", label: "All authorities done" },
    { id: "n7", type: "end", label: "Done" },
  ],
  // Parallel on purpose: the three authority steps do not depend on each other, so all three should be
  // waiting at once — which is the whole point of queueing by portal rather than by case.
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" }, { from: "n2", to: "n4" }, { from: "n2", to: "n5" },
    { from: "n3", to: "n6" }, { from: "n4", to: "n6" }, { from: "n5", to: "n6" },
    { from: "n6", to: "n7" },
  ],
};

const show = async (instanceId: string, when: string) => {
  const steps = await prisma.workflowTask.findMany({ where: { instanceId, status: "active" }, orderBy: { id: "asc" } });
  console.log(`\n${when}`);
  if (!steps.length) console.log("  (no active steps)");
  for (const s of steps) console.log(`  ${(s.govCenter ?? "— office work").padEnd(14)} ${s.title}`);
  return steps;
};

async function main() {
  const co = await prisma.company.findFirst();
  const before = { tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count(), wt: await prisma.workflowTask.count() };
  let bad = 0;

  const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ PORTAL PROBE", trigger: "manual", active: true, graph: graph as any } });
  const run = await startInstance(tpl.id, { title: "Exit — A. Probe", companyId: co?.id ?? null, clientName: co?.name ?? null });

  // First step is office work; complete it so the three authority steps open together.
  const first = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" } });
  await completeTask(first!.id, { actor: "probe" });

  const open = await show(run.id, "Active steps after the office work is done:");
  const portals = open.map(s => s.govCenter).filter(Boolean).sort();
  const spansThree = JSON.stringify(portals) === JSON.stringify(["GOSI", "Muqeem", "Qiwa"]);
  console.log(`\n  one case waiting at three authorities at once: ${spansThree ? "YES" : "NO — " + JSON.stringify(portals)}`);
  if (!spansThree) bad++;

  // Complete the Qiwa one only.
  const qiwa = open.find(s => s.govCenter === "Qiwa");
  await completeTask(qiwa!.id, { actor: "probe" });
  const after = await show(run.id, "After finishing the Qiwa job only:");
  const stillOpen = after.map(s => s.govCenter).filter(Boolean).sort();
  const qiwaCleared = !stillOpen.includes("Qiwa") && stillOpen.length === 2;
  console.log(`\n  Qiwa row cleared, the rest of the case continues: ${qiwaCleared ? "YES" : "NO — " + JSON.stringify(stillOpen)}`);
  if (!qiwaCleared) bad++;

  const inst = await prisma.workflowInstance.findUnique({ where: { id: run.id } });
  console.log(`  case status: ${inst?.status} (should still be running)`);
  if (inst?.status !== "running") bad++;

  // ── clean up ──
  await prisma.workflowLog.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: run.id } });
  await prisma.workflowInstance.delete({ where: { id: run.id } });
  await prisma.workflowTemplate.delete({ where: { id: tpl.id } });

  const now = { tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count(), wt: await prisma.workflowTask.count() };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  templates ${before.tpl}->${now.tpl} · runs ${before.run}->${now.run} · steps ${before.wt}->${now.wt}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
