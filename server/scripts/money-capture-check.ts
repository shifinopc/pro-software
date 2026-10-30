/**
 * THE `money` CAPTURE, END TO END.
 *
 *   npx tsx scripts/money-capture-check.ts
 *
 * Builds a throwaway one-step workflow whose step asks for a payment, completes it the way the task
 * sheet does, and checks three things that are easy to get silently wrong:
 *
 *   · the Disbursement row exists, in MINOR units — the whole reason this type exists is that a
 *     free number field let 650 and 65000 mean the same thing
 *   · the run variable still holds the plain amount, so changing a step from `number` to `money`
 *     cannot break a decision that reads it
 *   · completing twice corrects the payment instead of recording it a second time
 *
 * Everything it creates, it deletes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";
import { parseMoney, minorFromTyped } from "../src/disbursements.js";

let failures = 0;
const ok = (cond: boolean, what: string) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`);
  if (!cond) failures++;
};

async function pure() {
  console.log("what an amount means:");
  ok(minorFromTyped("650") === 65000, '"650" is 65000 halalas');
  ok(minorFromTyped("2,425") === 242500, '"2,425" survives its comma');
  ok(minorFromTyped("162.50") === 16250, '"162.50" keeps its halalas');
  ok(minorFromTyped("12.345") === 1235, '"12.345" rounds up rather than losing the half');
  ok(minorFromTyped("0") === 0, '"0" is a waiver, not a refusal');
  ok(minorFromTyped("") === null, "blank is refused");
  ok(minorFromTyped("two thousand") === null, "words are refused");
  ok(minorFromTyped("-5") === null, "a negative fee is refused");
  ok(minorFromTyped("SAR 650") === 65000, "a typed currency prefix is tolerated");

  console.log("what an answer means:");
  ok(parseMoney("")  === null, "nothing answered is null, not a zero payment");
  ok(parseMoney("650")?.amount === "650", "a bare number still reads, for older clients");
  ok(parseMoney({ amount: "1" })?.paid === true, "a payment with no paid flag counts as paid");
  ok(parseMoney({ amount: "1", paid: false })?.paid === false, "and says so when it does not");
  ok(parseMoney('{"amount":"7","reference":"R1"}')?.reference === "R1", "a JSON string is understood");
}

async function engine() {
  console.log("through the engine:");
  const made: { tpl?: string; run?: string } = {};
  try {
    const tpl = await prisma.workflowTemplate.create({
      data: {
        name: "ZZ money capture check", country: "SA", active: true, entityType: "generic",
        graph: {
          nodes: [
            { id: "n1", type: "start", config: {} },
            { id: "n2", type: "task", config: { title: "Pay the fee", captures: [
              { var: "permitAmount", label: "Work permit fee", type: "money" },
            ] } },
            { id: "n3", type: "end", config: {} },
          ],
          edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
        } as any,
      },
    });
    made.tpl = tpl.id;

    const run = await startInstance(tpl.id, { title: "ZZ money check", clientName: "ZZ Test" });
    made.run = run!.id;
    const task = await prisma.workflowTask.findFirst({ where: { instanceId: run!.id, status: "active" } });
    ok(!!task, "the step is waiting");
    if (!task) return;

    await completeTask(task.id, {
      actor: "money-capture-check",
      variables: { permitAmount: { amount: "2425", reference: "MOL-9931", paidOn: "2026-10-13", paid: true } },
    });

    const d = await prisma.disbursement.findFirst({ where: { workflowInstanceId: run!.id } });
    ok(!!d, "a disbursement was filed");
    ok(d?.amountMinor === 242500, `2425 was stored as 242500 halalas (got ${d?.amountMinor})`);
    ok(d?.reference === "MOL-9931", "the ministry reference travelled with it");
    ok(d?.paidAt === "2026-10-13", "so did the date it was paid");
    ok(d?.recharge === true, "it is billable to the client by default");
    ok(d?.label === "Work permit fee", "the label is snapshotted, not looked up later");
    ok(d?.varName === "permitAmount", "and it knows which question produced it");

    const inst = await prisma.workflowInstance.findUnique({ where: { id: run!.id } });
    const v = (inst?.variables ?? {}) as any;
    ok(String(v.permitAmount) === "2425",
      `the run variable still holds the plain amount, so decisions reading it keep working (got ${JSON.stringify(v.permitAmount)})`);

    // Re-completing must correct the payment, not add a second one. The unique key is what enforces
    // this; the test is here because losing it would be invisible until a client was billed twice.
    await prisma.workflowTask.update({ where: { id: task.id }, data: { status: "active", completedAt: null } });
    await completeTask(task.id, {
      actor: "money-capture-check",
      variables: { permitAmount: { amount: "2500", reference: "MOL-9931", paidOn: "2026-10-13", paid: true } },
    });
    const all = await prisma.disbursement.findMany({ where: { workflowInstanceId: run!.id } });
    ok(all.length === 1, `completing twice leaves one payment, not two (got ${all.length})`);
    ok(all[0]?.amountMinor === 250000, `and it carries the corrected amount (got ${all[0]?.amountMinor})`);

    // A step that asks for a payment must refuse an answer that is not one.
    await prisma.workflowTask.update({ where: { id: task.id }, data: { status: "active", completedAt: null } });
    let refused = "";
    try {
      await completeTask(task.id, { actor: "money-capture-check", variables: { permitAmount: { amount: "two thousand" } } });
    } catch (e: any) { refused = String(e?.message ?? ""); }
    ok(/is not an amount/.test(refused), `"two thousand" is refused out loud (got ${refused || "no error"})`);
  } finally {
    if (made.run) {
      await prisma.disbursement.deleteMany({ where: { workflowInstanceId: made.run } });
      await prisma.workflowLog.deleteMany({ where: { instanceId: made.run } });
      await prisma.workflowTask.deleteMany({ where: { instanceId: made.run } });
      await prisma.workflowInstance.delete({ where: { id: made.run } }).catch(() => {});
    }
    if (made.tpl) await prisma.workflowTemplate.delete({ where: { id: made.tpl } }).catch(() => {});
  }
}

await pure();
await engine();
await prisma.$disconnect();
console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
