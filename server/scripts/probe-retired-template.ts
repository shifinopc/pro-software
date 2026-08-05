/**
 * Throwaway check: does retiring a workflow template actually stop it?
 *
 * Templates are the one config model NOT served by the generic CRUD helper, so the retired filter
 * that covers everything else never reached them. This asserts both halves of "retired":
 *   - it disappears from the list the builder and the pickers read
 *   - it refuses to start new work, however it is reached (service binding, expiry job, accept)
 *
 * Runs against a scratch database. Cleans up after itself.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";

async function main() {
  let bad = 0;
  const graph = { nodes: [{ id: "n1", type: "task", data: { label: "Step one" } }], edges: [] };

  const live = await prisma.workflowTemplate.create({
    data: { name: "ZZ Probe Live", graph: graph as any, active: true },
  });
  const dead = await prisma.workflowTemplate.create({
    data: { name: "ZZ Probe Retired", graph: graph as any, active: true, retired: true },
  });

  // ── half one: hidden from the list ──
  const listed = await prisma.workflowTemplate.findMany({ where: { retired: false }, select: { name: true } });
  const names = listed.map(t => t.name);
  console.log(`listed templates include the live one:   ${names.includes("ZZ Probe Live") ? "YES" : "NO"}`);
  console.log(`…and exclude the retired one:            ${!names.includes("ZZ Probe Retired") ? "YES" : "NO"}`);
  if (!names.includes("ZZ Probe Live")) bad++;
  if (names.includes("ZZ Probe Retired")) bad++;

  const withFlag = await prisma.workflowTemplate.count();
  console.log(`…but still readable when asked for:      ${withFlag} total, ${listed.length} visible`);

  // ── half two: refuses to start ──
  let liveRan = false, deadErr = "";
  try { await startInstance(live.id, {} as any); liveRan = true; } catch (e: any) { deadErr = "live failed: " + e.message; }
  console.log(`\nthe live template starts:                ${liveRan ? "YES" : "NO — " + deadErr}`);
  if (!liveRan) bad++;

  let deadRan = false;
  try { await startInstance(dead.id, {} as any); deadRan = true; } catch (e: any) { deadErr = e.message; }
  console.log(`the retired template refuses:            ${!deadRan ? "YES" : "NO — IT STARTED"}`);
  console.log(`  and says why:                          "${deadErr}"`);
  if (deadRan) bad++;

  // ── clean up ──
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: [live.id, dead.id] } }, select: { id: true } });
  const ids = runs.map(r => r.id);
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
  await prisma.workflowInstance.deleteMany({ where: { templateId: { in: [live.id, dead.id] } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: [live.id, dead.id] } } });
  const left = await prisma.workflowTemplate.count({ where: { name: { startsWith: "ZZ Probe" } } });
  console.log(`\ncleaned up:                              ${left === 0 ? "YES" : "NO — " + left + " left"}`);

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
