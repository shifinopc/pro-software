/**
 * TWO RENEWAL PASSES AT ONCE MUST STILL PRODUCE ONE RENEWAL.
 *
 *   npx tsx scripts/renewal-claim-check.ts
 *
 * The job used to claim the document AFTER starting its run, so two passes that overlapped both saw
 * it unclaimed and both started one. `tickInFlight` prevents that inside a process and does nothing
 * across two — and a restart overlaps them by design, the old process finishing its tick while the
 * new one runs its boot tick. That is what happened on 13 October 2026: seventy employees ended up
 * with two open Iqama renewals each, 2m25s apart, and the second claim overwrote the first so the
 * run holding the real work was orphaned from its document.
 *
 * So this runs two passes CONCURRENTLY, which is the only way to test a compare-and-swap. Scoped to
 * a throwaway client through `onlyCompanyId`, which exists for exactly this.
 *
 * Everything it creates, it deletes.
 */
import { prisma } from "../src/db.js";
import { triggerRenewals } from "../src/jobs.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const TAG = "ZZ renewal-claim-check";
const DOCTYPE = `${TAG} licence`;

async function sweep() {
  const cos = (await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map(c => c.id);
  const tpls = (await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map(t => t.id);
  const rids = (await prisma.workflowInstance.findMany({ where: { OR: [{ companyId: { in: cos } }, { templateId: { in: tpls } }] }, select: { id: true } })).map(r => r.id);
  await prisma.disbursement.deleteMany({ where: { workflowInstanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
  await prisma.task.deleteMany({ where: { workflowInstanceId: { in: rids } } }).catch(() => {});
  await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: tpls } } });
  await prisma.document.deleteMany({ where: { companyId: { in: cos } } });
  await prisma.company.deleteMany({ where: { id: { in: cos } } });
}

await sweep();
try {
  const co = await prisma.company.create({ data: { name: `${TAG} client`, country: "SA", lifecycle: "client" } as any });
  const tpl = await prisma.workflowTemplate.create({ data: {
    name: `${TAG} tpl`, active: true, retired: false, trigger: "document_expiry",
    triggerConfig: { docType: DOCTYPE, days: 45 },
    graph: { nodes: [{ id: "start", type: "start", label: "Start" }, { id: "t", type: "task", label: "Do it" }, { id: "end", type: "end", label: "Done" }],
             edges: [{ from: "start", to: "t" }, { from: "t", to: "end" }] },
  } as any });
  const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  const doc = await prisma.document.create({ data: { companyId: co.id, docType: DOCTYPE, person: `${TAG} subject`, expiryDate: soon, docNumber: "ZZ-1" } as any });

  console.log("two passes at the same moment, the way a restart overlaps them:");
  const [a, b] = await Promise.all([triggerRenewals(co.id), triggerRenewals(co.id)]);
  const started = await prisma.workflowInstance.count({ where: { templateId: tpl.id, status: "running" } });
  ok(started === 1, `exactly one renewal was started (got ${started}; passes reported ${a.started} and ${b.started})`);
  ok(a.started + b.started === 1, "…and only one of the two passes claims to have started it");
  const after = await prisma.document.findUnique({ where: { id: doc.id }, select: { renewalRunId: true } });
  const run = await prisma.workflowInstance.findFirst({ where: { templateId: tpl.id, status: "running" }, select: { id: true } });
  ok(after?.renewalRunId === run?.id, "the document is claimed by the run that exists, not by a marker or a ghost");
  ok(!String(after?.renewalRunId ?? "").startsWith("pending:"), "…and no pending marker was left behind");

  console.log("\na third pass afterwards adds nothing:");
  const c = await triggerRenewals(co.id);
  ok(c.started === 0, "the claim holds — nothing started");
  ok(await prisma.workflowInstance.count({ where: { templateId: tpl.id, status: "running" } }) === 1, "still one run");

  console.log("\nand a document whose claim was lost adopts the open run instead of starting a second:");
  await prisma.document.update({ where: { id: doc.id }, data: { renewalRunId: null } });
  const d = await triggerRenewals(co.id);
  ok(d.started === 0, "no second renewal");
  ok((await prisma.document.findUnique({ where: { id: doc.id }, select: { renewalRunId: true } }))?.renewalRunId === run?.id,
    "…the claim was re-pointed at the run that is already open");
  ok(d.details.some(x => /ALREADY OPEN/.test(x)), "…and the job says so rather than reporting a failure every hour");
} finally {
  await sweep();
}
await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
