/**
 * THE MARGIN ARITHMETIC, AND THE THINGS IT MUST REFUSE TO GUESS.
 *
 *   npx tsx scripts/profitability-check.ts
 *
 * src/profitability.ts answers "which clients make money", and the dangerous failure is not a crash:
 * it is a number that looks right. A client whose work is half uncosted shows a flattering margin,
 * and nobody querying a report thinks to ask how much of it the report could not see.
 *
 * So this builds clients whose answers are known by construction, and checks the figure AND the
 * honesty counters beside it:
 *
 *   · revenue counts issued invoices, not drafts and not voided ones
 *   · a fee the CLIENT paid directly cost the firm nothing
 *   · a fee the firm absorbed (recharge off) is a cost it keeps
 *   · effort x the rate of whoever completed the step, not of whoever it was assigned to
 *   · a step with no declared effort is UNCOSTED, not free
 *   · a person with no rate is UNCOSTED, not free
 *   · null margin percentage where there is no revenue, rather than a division by zero
 *
 * Everything it makes is named "ZZ " and removed at the end, so it runs against a scratch database
 * in any order — which is also why it refuses to run anywhere else.
 */
import { prisma } from "../src/db.js";
import { clientMargins } from "../src/profitability.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This creates throwaway clients, staff, invoices and workflow runs."));
  process.exit(1);
}

let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const eq = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what}: ${got}`) : fail(`${what}: got ${got}, expected ${want}`);

const TAG = "ZZ Margin";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.invoice.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.disbursement.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "zz-margin" } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
}

async function main() {
  await sweep();

  // ── the cast ────────────────────────────────────────────────────────────────────────────────
  // SAR 60.00/hour, so an hour of work costs 6000 minor units and forty minutes costs 4000.
  const costed = await prisma.user.create({ data: { name: "ZZ Margin Officer", email: "zz-margin-costed@example.invalid", roleId: "pro_officer", status: "active", type: "staff", costPerHourMinor: 6000 } });
  const uncosted = await prisma.user.create({ data: { name: "ZZ Margin Nobody", email: "zz-margin-uncosted@example.invalid", roleId: "pro_officer", status: "active", type: "staff" } });

  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG + " Template", graph: { nodes: [], edges: [] } } as any });
  // govFee 300 whole riyals = 30000 minor, charged once per completed step of this service.
  await prisma.serviceItem.create({ data: { name: TAG + " Service", workflowId: tpl.id, govFee: 300, serviceFee: 500, effortMinutes: 45 } });

  const co = async (n: string) => prisma.company.create({ data: { name: `${TAG} ${n}`, country: "SA" } });
  const A = await co("A"), B = await co("B"), C = await co("C");

  const run = async (companyId: string) =>
    prisma.workflowInstance.create({ data: { templateId: tpl.id, title: TAG + " run", companyId, status: "completed" } });
  const step = async (instanceId: string, effortMinutes: number | null, completedBy: string | null) =>
    prisma.workflowTask.create({ data: {
      instanceId, nodeId: "n1", nodeType: "task", title: TAG + " step", status: "done",
      effortMinutes, completedBy, completedAt: new Date().toISOString(),
    } as any });

  // A: one issued invoice, one draft (ignored), one 60-minute step by a costed officer.
  await prisma.invoice.create({ data: { number: "ZZM-1", companyId: A.id, status: "sent", amount: 1000, totalMinor: 100000, currency: "SAR", date: "2026-11-01" } });
  await prisma.invoice.create({ data: { number: "ZZM-2", companyId: A.id, status: "draft", amount: 9999, totalMinor: 999900, currency: "SAR", date: "2026-11-01" } });
  await step((await run(A.id)).id, 60, costed.email);

  // B: a fee the CLIENT paid (costs the firm nothing) and one the firm absorbed (a cost it keeps).
  await prisma.disbursement.create({ data: { companyId: B.id, label: TAG + " client-paid fee", amountMinor: 50000, payer: "client", recharge: true, paidAt: "2026-11-01", at: "2026-11-01" } as any });
  await prisma.disbursement.create({ data: { companyId: B.id, label: TAG + " absorbed fee", amountMinor: 25000, payer: "firm", recharge: false, paidAt: "2026-11-01", at: "2026-11-01" } as any });

  // C: two steps that must be counted as UNKNOWN, not as free.
  const runC = await run(C.id);
  await step(runC.id, null, costed.email);        // no effort declared
  await step(runC.id, 30, uncosted.email);        // no rate for the person

  const rows = await clientMargins();
  const of = (id: string) => rows.find(r => r.companyId === id);

  console.log("\nA — revenue, a draft that must not count, and costed effort");
  const a = of(A.id);
  if (!a) fail("client A is missing from the report"); else {
    eq(a.revenueMinor, 100000, "revenue excludes the draft");
    eq(a.passThroughMinor, 30000, "the service's government fee is a pass-through cost");
    eq(a.labourMinor, 6000, "60 minutes at SAR 60.00/hour");
    eq(a.marginMinor, 100000 - 30000 - 6000, "margin = revenue - pass-through - labour");
    eq(a.marginPct, 64, "margin percentage");
    eq(a.uncostedSteps, 0, "nothing uncosted");
  }

  console.log("\nB — who actually paid decides whether it is a cost");
  const b = of(B.id);
  if (!b) fail("client B is missing from the report"); else {
    eq(b.passThroughMinor, 25000, "only the fee the FIRM paid is a cost");
    eq(b.revenueMinor, 0, "no revenue");
    eq(b.marginPct, null, "no revenue means no percentage, not a division by zero");
  }

  console.log("\nC — unknown is not zero");
  const c = of(C.id);
  if (!c) fail("client C is missing from the report"); else {
    eq(c.labourMinor, 0, "nothing could be costed");
    eq(c.uncostedSteps, 1, "the step with no declared effort is counted");
    eq(c.uncostedPeople, 1, "the step done by someone with no rate is counted");
    eq(c.effortMinutes, 30, "effort is still known even where the rate is not");
  }

  console.log("\nordering");
  const worst = rows.findIndex(r => r.companyId === C.id);
  const best = rows.findIndex(r => r.companyId === A.id);
  if (worst < best) ok("worst margin first — that is the list worth reading");
  else fail(`rows are not sorted worst-first (C at ${worst}, A at ${best})`);

  await sweep();
  console.log("\ncleaned up: YES");
  console.log(bad ? `\n${bad} problem(s)` : "\nall good");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
