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

/**
 * AND THE QUESTION IS GONE FROM THE FORM.
 *
 * The money field carried a "Paid" chip: a state badge that looked like a button, beside a second
 * chip answering a different question (whose money it was), with nothing but a tooltip to tell them
 * apart — and it read "Paid" on an empty form, because recording a fee you have just handed over is
 * the ordinary case. Recording the fee IS paying it, so the chip is gone and the amount takes the
 * whole row. The ENGINE still understands an unpaid answer, which is what the cases above cover;
 * nothing in the console sends one any more.
 */
console.log("\nand the console no longer asks a question it always answered the same way:");
{
  const ui = (await import("node:fs")).readFileSync(
    (await import("node:path")).join(import.meta.dirname, "../../index.html"), "utf8");
  // Anchored on the property names, not the bare words: `disbUnpaidLabel` (the disbursement list's
// own banner, nothing to do with this field) contains "paidLabel" and flagged correct code.
ok(!/togglePaid|\bpaidLabel/.test(ui), "the Paid toggle and its label are gone from the money field");
  ok(!/showRef/.test(ui), "…and the receipt box is no longer gated behind it");
  ok(ui.includes('onBlur="{{ c.m.setReference }}" placeholder="Receipt or reference number"'),
    "the receipt and date row is always on screen");
  ok(ui.includes("{ amount: '', paid: true, ...cur9, [k]: x }"),
    "every money answer still carries paid:true, so the rules that ask stay satisfiable");
}

/**
 * AND THE QUESTION THAT REMAINS IS ASKED AS ONE.
 *
 * Whether the client paid the ministry themselves is a real distinction — the firm is either out of
 * pocket and billing it on, or it is not — but it was a single chip reading "We paid", which is the
 * same trap the paid/unpaid toggle was: a badge that is really a button, with its second option
 * nowhere on screen. Both answers are on screen now, in the pills every other choice on this form
 * uses, and the billing consequence is printed under whichever is picked.
 */
console.log("\nand whose money paid is asked as a question, with both answers on screen:");
{
  const ui = (await import("node:fs")).readFileSync(
    (await import("node:path")).join(import.meta.dirname, "../../index.html"), "utf8");
  ok(!/togglePayer/.test(ui), "the one-chip toggle is gone");
  ok(ui.includes("WHOSE MONEY PAID THE MINISTRY?"), "…replaced by a labelled question");
  ok(ui.includes('>We paid it</span>') && ui.includes('>The client paid it direct</span>'),
    "…with both answers visible, so neither reads as a status badge");
  ok(ui.includes("pickFirm: () => patch('payer', 'firm')") && ui.includes("pickClient: () => patch('payer', 'client')"),
    "…each setting the payer outright rather than flipping whatever it was");
  ok(/billable to the client/.test(ui) && /never billed on to them/.test(ui),
    "…and the consequence is spelled out, which is the part the officer actually needs");
}

/**
 * AND NO OPEN STEP IS STILL ASKING THE OLD FOUR.
 *
 * A task snapshots its questions when it is created, so the template changing months ago left 78
 * open steps — 70 of them work permits — still showing the paid/unpaid dropdown this file is about.
 * scripts/repoint-old-fee-steps.ts brings them onto the money field; this is what says it stayed
 * done, and would catch a run started from a template that had been edited back.
 */
console.log("\nand no step anybody is holding still asks the retired paid/unpaid question:");
{
  const stillOld = await prisma.workflowTask.findMany({
    where: { status: "active", instance: { status: "running" } },
    select: { title: true, captures: true },
  });
  const bad9 = stillOld.filter(t => Array.isArray(t.captures) && (t.captures as any[]).some((c: any) =>
    (String(c?.type) === "select" && /paid$/i.test(String(c?.var ?? "")))
    || (String(c?.type) === "number" && /amount$/i.test(String(c?.var ?? "")))));
  ok(bad9.length === 0, bad9.length
    ? `${bad9.length} open task(s) still on the old shape, e.g. "${bad9[0].title}" — run scripts/repoint-old-fee-steps.ts --apply`
    : "every open fee step is on the one money field");
  await prisma.$disconnect();
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
