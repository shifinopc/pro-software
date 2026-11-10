/**
 * A FEE MARKED PAID MUST SATISFY THE RULE THAT ASKS WHETHER IT WAS PAID.
 *
 *   npx tsx scripts/money-paid-rule-check.ts
 *
 * Found on a live step. "Payment for Jawazat" refused to complete with "The Jawazat fee is still
 * unpaid" while the fee on screen was marked paid, and no answer anybody could change cleared it.
 *
 * The cause was a rename that only went half way. The fee used to be two fields — `jawazatAmount`
 * and a `jawazatPaid` dropdown — and became ONE money capture carrying the paid flag inside itself.
 * The rules kept pointing at `jawazatPaid`, and a money answer collapses to just its amount on the
 * run (the flag becomes a Disbursement row), so that variable was never written again. The rule
 * could not hold from the screen. Four rules across three steps were stranded: the work permit fee,
 * the Jawazat fee, the late-payment charge and the violation charge.
 *
 * Both shapes have to work, because both are open right now: steps created before the change still
 * carry the dropdown and answer it themselves.
 *
 * Everything it creates, it deletes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ money-paid-rule-check";
const UNPAID = "The fee is still unpaid.";

/** A one-step workflow guarded exactly as the Iqama renewal's fee steps are. */
const graphFor = (captures: any[]) => ({
  nodes: [
    { id: "start", type: "start", label: "Start" },
    { id: "fee", type: "task", label: "Pay the fee", config: { captures, rules: [{ then: { op: "eq", var: "feePaid", value: "paid" }, message: UNPAID }] } },
    { id: "end", type: "end", label: "Done" },
  ],
  edges: [{ from: "start", to: "fee" }, { from: "fee", to: "end" }],
});
const MONEY_SHAPE = [{ var: "feeAmount", type: "money", label: "Fee", required: true }];
const OLD_SHAPE = [
  { var: "feeAmount", type: "number", label: "Fee", required: true },
  { var: "feePaid", type: "select", label: "Paid?", options: "paid,unpaid", required: true },
];

async function sweep() {
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = tpls.map(t => t.id);
  if (!ids.length) return;
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
  const rids = runs.map(r => r.id);
  await prisma.disbursement.deleteMany({ where: { workflowInstanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
}

/** Start a run of `captures` and answer its one step with `answer`; returns the refusal, or "". */
async function tryComplete(captures: any[], answer: Record<string, any>) {
  const tpl = await prisma.workflowTemplate.create({ data: { name: `${TAG} ${Date.now()}`, graph: graphFor(captures) } as any });
  try {
    const run = await startInstance(tpl.id, { title: TAG });
    const t = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" }, select: { id: true } });
    try { await completeTask(t!.id, { actor: TAG, variables: answer }); return ""; }
    catch (e: any) { return String(e?.message ?? e); }
  } finally {
    await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { name: TAG } }).catch(() => {});
  }
}

console.log("the refusal points at a box that is actually on the screen:");
{
  const ui = (await import("node:fs")).readFileSync(
    (await import("node:path")).join(import.meta.dirname, "../../index.html"), "utf8");
  // A rule about jawazatPaid is answered by the money field jawazatAmount, so marking the rule's own
  // name marked nothing: the message sat above a form with nothing indicated on it.
  ok(ui.includes(".map(f => String(f).replace(/Paid$/, 'Amount'))"),
    "the drawer marks the money field a <thing>Paid rule is about");
}

await sweep();
try {
  console.log("a money fee marked paid gets past the rule:");
  ok(await tryComplete(MONEY_SHAPE, { feeAmount: { amount: "163", paid: true } }) === "", "paid: true completes");
  ok(await tryComplete(MONEY_SHAPE, { feeAmount: { amount: "163" } }) === "",
    "and so does an answer with no flag at all — recording a fee means paying it");

  console.log("\n…and one marked unpaid is still held, which is the point of the rule:");
  ok((await tryComplete(MONEY_SHAPE, { feeAmount: { amount: "163", paid: false } })).includes(UNPAID),
    "paid: false is refused, in the rule author's own words");

  console.log("\nthe older shape, which is what most open steps carry, is untouched:");
  ok(await tryComplete(OLD_SHAPE, { feeAmount: "163", feePaid: "paid" }) === "", "its own dropdown still answers the rule");
  ok((await tryComplete(OLD_SHAPE, { feeAmount: "163", feePaid: "unpaid" })).includes(UNPAID), "and still holds it when unpaid");

  console.log("\nand the real templates have no rule left that nothing can answer:");
  for (const tpl of await prisma.workflowTemplate.findMany({ where: { retired: false }, select: { name: true, graph: true } })) {
    const g: any = tpl.graph;
    for (const n of (g?.nodes ?? [])) {
      const caps: any[] = n?.config?.captures ?? [];
      const names = new Set(caps.map(c => String(c?.var ?? "")));
      // A money field named <thing>Amount now answers <thing>Paid, so count that as declared.
      for (const c of caps) {
        const pair = String(c?.type) === "money" && /^(.*)Amount$/.exec(String(c?.var ?? ""));
        if (pair) names.add(`${pair[1]}Paid`);
      }
      for (const r of (n?.config?.rules ?? [])) {
        if (!r?.then?.var) continue;
        ok(names.has(String(r.then.var)),
          `${tpl.name} · ${n.label || n.id}: "${r.then.var}" is answerable on the step`);
      }
    }
  }
} finally {
  await sweep();
}
await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
