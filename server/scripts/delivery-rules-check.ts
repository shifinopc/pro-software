/**
 * Exercises the two delivery rules against the real engine, then deletes everything it made.
 *
 *   npx tsx scripts/delivery-rules-check.ts
 *
 * 1. A money line (kind prof/gov) is billed and given NO task.
 * 2. `Quotation.serviceItemId` opens exactly one case, even when every line is a fee.
 *
 * Both were regressions waiting to happen rather than hypotheticals: before this, a quotation
 * written as professional + government fees produced two unassigned to-dos and started nothing.
 *
 * LOCAL ONLY. It writes a throwaway client, quotation, task and workflow case, so it refuses to run
 * against anything but a local database, and removes what it created in reverse order even when an
 * assertion fails.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { startDeliveryForQuotation } from "../src/delivery.js";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("Refusing to run: DATABASE_URL is not local.");
  process.exit(1);
}

const prisma = new PrismaClient();
const made: { companyId?: string; quotationId?: string; companyId2?: string; quotationId2?: string } = {};

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error("FAIL: " + what);
  console.log("  ok -", what);
};

(async () => {
  const svc = await prisma.serviceItem.findFirst({ where: { workflowId: { not: null } }, select: { id: true, name: true } });
  if (!svc) { console.log("No service with a workflow in this database - nothing to check."); return; }

  const co = await prisma.company.create({ data: { name: `ZZ Delivery Check ${Date.now()}`, status: "active" } });
  made.companyId = co.id;

  const q = await prisma.quotation.create({
    data: {
      number: `ZZ-CHK-${Date.now()}`,
      companyId: co.id, clientName: co.name,
      service: "New business — a subject a machine cannot read",
      serviceItemId: svc.id,
      status: "sent",
      items: [
        { name: "Professional Fees", units: 1, price: 12000, kind: "prof" },
        { name: "Government Fees", units: 1, price: 8000, kind: "gov" },
      ],
    },
  });
  made.quotationId = q.id;

  const res = await startDeliveryForQuotation(q.id, { actor: "delivery-rules-check" });
  console.log(`  delivery: ${res.tasks.length} task(s), ${res.runs} case(s), billed: [${res.billed.join(", ")}]`);

  ok(res.billed.length === 2, "both money lines reported as billed");
  ok(!res.tasks.some(t => /Fees/i.test(t.title)), "no task was created for a money line");
  ok(res.runs === 1, "exactly one case was started");
  ok(res.tasks.length === 1, "exactly one task, for the service sold");
  ok(res.tasks[0].title.startsWith(svc.name), `the task is the sale: "${res.tasks[0].title}"`);
  ok(!!res.tasks[0].workflowInstanceId, "the task is bound to its case");

  // 3. A line the sold case already contains gets no row of its own.
  const co2 = await prisma.company.create({ data: { name: `ZZ Delivery Check B ${Date.now()}`, status: "active" } });
  made.companyId2 = co2.id;
  const q2 = await prisma.quotation.create({
    data: {
      number: `ZZ-CHK-B-${Date.now()}`,
      companyId: co2.id, clientName: co2.name, service: "New business", serviceItemId: svc.id, status: "sent",
      items: [
        { name: "Professional Fees", units: 1, price: 12000, kind: "prof" },
        { name: "Company Acquisition", units: 1, price: 40000, kind: "foreign", country: "Oman" },
        { name: "Company Acquisition", units: 1, price: 40000, kind: "foreign", country: "UK" },
      ],
    },
  });
  made.quotationId2 = q2.id;
  const res2 = await startDeliveryForQuotation(q2.id, { actor: "delivery-rules-check" });
  console.log(`  delivery B: ${res2.tasks.length} task(s), ${res2.runs} case(s), absorbed: ${res2.absorbed.length}`);
  ok(res2.tasks.length === 1, "three acquisition-and-fee lines still make exactly one row");
  ok(res2.runs === 1, "and exactly one case");
  ok(res2.absorbed.length === 2, "both acquisition lines reported as absorbed into the case");

  console.log("PASS");
})().catch((e) => { console.error(String(e?.message ?? e)); process.exitCode = 1; })
  .finally(async () => {
    // Reverse order, and never leave a case running on a client that is about to be deleted.
    for (const qid of [made.quotationId, made.quotationId2].filter(Boolean) as string[]) {
      const tasks = await prisma.task.findMany({ where: { quotationId: qid }, select: { id: true, workflowInstanceId: true } });
      const runIds = tasks.map(t => t.workflowInstanceId).filter(Boolean) as string[];
      await prisma.task.deleteMany({ where: { quotationId: qid } });
      for (const id of runIds) {
        await prisma.workflowTask.deleteMany({ where: { instanceId: id } });
        await prisma.workflowLog.deleteMany({ where: { instanceId: id } });
        await prisma.workflowInstance.deleteMany({ where: { id } });
      }
      await prisma.quotation.deleteMany({ where: { id: qid } });
    }
    for (const cid of [made.companyId, made.companyId2].filter(Boolean) as string[]) {
      await prisma.opportunity.deleteMany({ where: { companyId: cid } }).catch(() => {});
      await prisma.activity.deleteMany({ where: { message: { contains: "ZZ Delivery Check" } } }).catch(() => {});
      await prisma.company.deleteMany({ where: { id: cid } });
    }
    console.log("cleaned up");
    await prisma.$disconnect();
  });
