/**
 * MARK THE ADVANCE GATE AS SETTLED BY MONEY.
 *
 * `requiresAdvance: true` on an approval node is what advance-gate.ts looks for: with it, the gate
 * approves itself the moment the stage invoice behind it is settled in full, naming the receipt in
 * the decision note. Without it the gate is an ordinary approval and waits for a person — which is
 * the right default, and why this is a flag on one node rather than a behaviour of every approval.
 * Turning all of them into arithmetic because one of them could be is how a review board becomes a
 * rubber stamp.
 *
 * Only ever a short payment leaves it open: "close enough" is a decision with a name on it, and the
 * approver has the shortfall on screen to make it with.
 *
 * Idempotent, and it refuses rather than guesses: the node must exist and must be an approval.
 *
 * Usage: npx tsx scripts/set-advance-gate.ts [template-name-fragment] [nodeId]
 * Defaults to the Business Setup template's g0.
 */
import { prisma } from "../src/db.js";

async function main() {
  const [nameFragment = "Business Setup", nodeId = "g0"] = process.argv.slice(2);

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: { contains: nameFragment } } });
  if (!tpl) throw new Error(`no template matching "${nameFragment}"`);
  const g: any = tpl.graph ?? {};
  const nodes: any[] = g.nodes ?? [];
  const node = nodes.find(n => String(n.id) === nodeId);
  if (!node) throw new Error(`"${nodeId}" is not a node in "${tpl.name}"`);
  if (String(node.type) !== "approval") throw new Error(`"${nodeId}" is a ${node.type}, not an approval — only an approval can be released by payment`);
  if (node.requiresAdvance === true) {
    console.log(`already set: "${tpl.name}" / ${nodeId} ("${node.label ?? nodeId}")`);
    return;
  }

  await prisma.workflowTemplate.update({
    where: { id: tpl.id },
    data: { graph: { ...g, nodes: nodes.map(n => String(n.id) === nodeId ? { ...n, requiresAdvance: true } : n) } as any },
  });
  console.log(`set requiresAdvance on "${tpl.name}" / ${nodeId} ("${node.label ?? nodeId}")`);

  /**
   * THE GATES ALREADY WAITING.
   *
   * advance-gate.ts reads the flag off the TEMPLATE, not off a snapshot on the task, so a gate that
   * is open right now starts obeying this the moment the next payment lands — no backfill needed.
   * Said out loud because the opposite is true of captures and checklists, which ARE snapshotted,
   * and assuming the wrong one of the two is how a change looks applied and is not.
   */
  const waiting = await prisma.workflowTask.count({
    where: { nodeId, nodeType: "approval", status: "active", instance: { templateId: tpl.id } },
  });
  console.log(waiting
    ? `${waiting} gate(s) open right now will release on their next full settlement — the flag is read from the template, not snapshotted`
    : "no gates open right now");
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
