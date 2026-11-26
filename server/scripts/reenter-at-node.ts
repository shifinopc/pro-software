/**
 * PUT A RUNNING CASE ONTO A BRANCH THAT WAS DRAWN AFTER IT STARTED.
 *
 * The engine walks forward one node at a time and never looks back, so a step inserted into a
 * template BEHIND a running case's frontier is simply never visited. That is correct behaviour —
 * a case is not re-planned every time somebody edits the template — and it leaves one real
 * problem: the cases already in flight when the branch was added never see it.
 *
 * Measured on the case this was written for. "Company acquisition — partners and documents" was
 * inserted between the onboarding call and KYC, behind a decision reading the quotation. A run
 * had advanced call → kyc twenty minutes earlier, and its own log shows no decision line at all,
 * because there was nothing there to decide. Every run started afterwards routes correctly; that
 * one would have reached the CR with no partner intake.
 *
 * SO IT RE-ENTERS AT THE FORK rather than conjuring the missing task. runFrontier is the engine's
 * own pass — the same code that creates every other step, with its assignment, role gate, SLA,
 * instructions snapshot, checklist snapshot and log entries — so the case ends up indistinguishable
 * from one that had the branch all along. Writing the row by hand would have produced a step that
 * looked right and was missing whichever of those the author forgot.
 *
 * WHAT IT REFUSES, because this edits live work:
 *   • a case that is not running,
 *   • a node that is not in the template,
 *   • a step it would have to withdraw that somebody has already ANSWERED — any checklist receipt,
 *     or any of its capture variables present on the run. Those answers are the officer's work and
 *     this script is not entitled to decide they do not matter.
 *
 * Usage: npx tsx scripts/reenter-at-node.ts <instanceId> <nodeId> [--withdraw a,b] [--apply]
 * Without --apply it says what it would do and changes nothing.
 */
import { prisma } from "../src/db.js";
import { runFrontier } from "../src/workflow.js";

const nowISO = () => new Date().toISOString();

async function main() {
  const [instanceId, nodeId] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  const withdrawArg = process.argv.find(a => a.startsWith("--withdraw="));
  const withdraw = withdrawArg ? withdrawArg.split("=")[1].split(",").map(s => s.trim()).filter(Boolean) : [];
  if (!instanceId || !nodeId) throw new Error("usage: reenter-at-node.ts <instanceId> <nodeId> [--withdraw=a,b] [--apply]");

  const inst: any = await prisma.workflowInstance.findUnique({ where: { id: instanceId } });
  if (!inst) throw new Error("no such case");
  if (inst.status !== "running") throw new Error(`case is ${inst.status}, not running`);

  const tpl: any = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
  const g: any = tpl?.graph ?? {};
  const node = (g.nodes ?? []).find((n: any) => String(n.id) === nodeId);
  if (!node) throw new Error(`"${nodeId}" is not a node in "${tpl?.name}"`);

  const vars: Record<string, any> = (inst.variables && typeof inst.variables === "object") ? inst.variables : {};

  // The steps this re-entry would duplicate, and whether any of them has been worked on.
  const open = await prisma.workflowTask.findMany({
    where: { instanceId, status: "active", nodeId: { in: withdraw } },
  });
  for (const t of open) {
    const state = (t.checklistState && typeof t.checklistState === "object") ? t.checklistState as any : {};
    if (Object.keys(state).length) throw new Error(`"${t.title}" already has checklist answers — refusing to withdraw it`);
    const answered = ((t.captures as any[]) ?? [])
      .map(c => String(c?.var ?? ""))
      .filter(v => v && vars[v] !== undefined && String(vars[v]).trim() !== "");
    if (answered.length) throw new Error(`"${t.title}" already answers ${answered.join(", ")} — refusing to withdraw it`);
  }
  const missing = withdraw.filter(w => !open.some(t => t.nodeId === w));
  if (missing.length) console.warn(`note: no active step for ${missing.join(", ")} — nothing to withdraw there`);

  console.log(`case   : ${inst.title} (${inst.clientName ?? "—"})`);
  console.log(`re-enter at: ${nodeId} — "${node.label ?? node.title ?? nodeId}" (${node.type})`);
  console.log(`withdraw   : ${open.map(t => `${t.nodeId} "${t.title}"`).join(", ") || "nothing"}`);
  if (!apply) { console.log("\n(dry run — pass --apply to make the change)"); return; }

  for (const t of open) {
    // Deleted rather than marked skipped: the branch will create this step again when it gets here,
    // and two rows for one node is exactly the duplicate this is avoiding. The log keeps the record.
    await prisma.workflowTask.delete({ where: { id: t.id } });
    await prisma.workflowLog.create({ data: {
      instanceId, nodeId: t.nodeId, action: "step.withdrawn", actor: "reenter-at-node",
      detail: `${t.title} withdrawn, unanswered — the case is being re-entered at "${nodeId}"`, at: nowISO(),
    } });
  }
  await prisma.workflowLog.create({ data: {
    instanceId, nodeId, action: "engine.reentered", actor: "reenter-at-node",
    detail: `re-entered at "${node.label ?? nodeId}" — this branch was added to the template after the case started`,
    at: nowISO(),
  } });

  await runFrontier(inst, g, [nodeId]);
  // runFrontier mutates inst.variables in place; the caller persists them.
  await prisma.workflowInstance.update({ where: { id: instanceId }, data: { variables: inst.variables as any } });

  const after = await prisma.workflowTask.findMany({
    where: { instanceId, status: "active" }, select: { nodeId: true, title: true, assignee: true },
  });
  console.log("\nactive now:", after.map(t => `${t.nodeId} "${t.title}" → ${t.assignee ?? "unassigned"}`).join(" | ") || "(none)");
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
