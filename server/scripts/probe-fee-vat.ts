/**
 * Throwaway check: does a workflow fee step now bill correctly both ways, and does its invoice carry
 * a line item that agrees with its own subtotal?
 *
 * Creates its own templates, runs them through the real engine, asserts, and deletes everything it
 * made. Safe to run against a working database; it should leave the row counts exactly as it found
 * them.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";

const f = (m: number) => (m / 100).toFixed(2);
const sumLines = (items: any) =>
  (Array.isArray(items) ? items : []).reduce(
    (a: number, it: any) => a + Math.round((Number(it?.units) || 1) * Math.round((Number(it?.price) || 0) * 100)), 0);

const graph = (cfgExtra: any) => ({
  nodes: [
    { id: "n1", type: "trigger", label: "Start" },
    { id: "n2", type: "charge_fee", label: "Government fee", config: { amount: 2000, ...cfgExtra } },
    { id: "n3", type: "end", label: "Done" },
  ],
  edges: [{ from: "n1", to: "n2" }, { from: "n2", to: "n3" }],
});

async function main() {
  const co = await prisma.company.findFirst();
  const before = { inv: await prisma.invoice.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  let bad = 0;

  const cases: [string, any][] = [
    ["fee INCLUDES VAT (the default)", { feeIncludesVat: true }],
    ["fee is EX-VAT", { feeIncludesVat: false }],
    ["not set at all — a step authored before the toggle", {}],
  ];

  for (const [label, extra] of cases) {
    const tpl = await prisma.workflowTemplate.create({ data: { name: "ZZ FEE PROBE", trigger: "manual", active: true, graph: graph(extra) as any } });
    const run = await startInstance(tpl.id, { title: "Fee probe", companyId: co?.id ?? null, clientName: co?.name ?? null });
    const inv = await prisma.invoice.findFirst({ where: { services: "Government fee" }, orderBy: { id: "desc" } });

    if (!inv) { console.log(`\n${label}\n  NO INVOICE RAISED`); bad++; }
    else {
      const lines = sumLines(inv.items);
      const linesOk = lines === inv.subtotalMinor;
      const addsUp = (inv.subtotalMinor ?? 0) + (inv.vatMinor ?? 0) === inv.totalMinor;
      console.log(`\n${label}`);
      console.log(`  subtotal ${f(inv.subtotalMinor!)} + VAT ${f(inv.vatMinor!)} = ${f(inv.totalMinor!)}  @${inv.vatRateBp}bp   (amount col ${inv.amount})`);
      console.log(`  line: ${JSON.stringify(inv.items)}`);
      console.log(`  line matches subtotal: ${linesOk ? "YES" : "NO"} · parts add up: ${addsUp ? "YES" : "NO"}`);
      if (!linesOk || !addsUp) bad++;
      await prisma.invoice.delete({ where: { id: inv.id } });
    }

    await prisma.workflowLog.deleteMany({ where: { instanceId: run.id } });
    await prisma.workflowTask.deleteMany({ where: { instanceId: run.id } });
    await prisma.workflowInstance.delete({ where: { id: run.id } });
    await prisma.workflowTemplate.delete({ where: { id: tpl.id } });
  }

  const after = { inv: await prisma.invoice.count(), tpl: await prisma.workflowTemplate.count(), run: await prisma.workflowInstance.count() };
  console.log(`\nfailures: ${bad}`);
  console.log(`counts  invoices ${before.inv}->${after.inv} · templates ${before.tpl}->${after.tpl} · runs ${before.run}->${after.run}`);
  console.log(`left behind: ${await prisma.workflowTemplate.count({ where: { name: "ZZ FEE PROBE" } })} probe templates`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
