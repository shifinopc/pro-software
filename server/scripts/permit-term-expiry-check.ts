/**
 * THE WORK PERMIT'S NEW EXPIRY IS THE TERM THAT WAS PAID FOR, COUNTED FROM THE DATE ON FILE.
 *
 *   npx tsx scripts/permit-term-expiry-check.ts
 *
 * Nobody types this date any more: the officer records the renewed Iqama, and the permit is dated
 * from `permitTerm` — the 3/6/9/12-month block bought at the work permit step — added to the expiry
 * the permit already carries. Getting it wrong is silent and expensive: a permit filed a quarter too
 * long stops the SLA Monitor chasing a renewal that has not happened, which is the exact defect the
 * Iqama Renewal rebuild exists to fix.
 *
 * Asserted against the real engine on a real run, not the arithmetic in isolation, because the part
 * that can break is the wiring — `expiryFromTerm` reaching `issue_document`, and the document it
 * picks being the one the employee already holds.
 *
 * LOCAL DATABASES ONLY: it creates a client, an employee, a permit, a template and a run, and
 * deletes all five.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ Permit Term Check";
let failures = 0;
const ok = (cond: any, what: string) => {
  if (cond) console.log("  ok   " + what);
  else { console.log("  FAIL " + what); failures++; }
};

const cleanup = async () => {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const cids = cos.map(c => c.id);
  if (cids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: { in: cids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    if (rids.length) {
      await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    }
    await prisma.document.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.employee.deleteMany({ where: { companyId: { in: cids } } });
    await prisma.company.deleteMany({ where: { id: { in: cids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
};

/** One run of the fixture: pick a term, complete the step, report the permit's new expiry. */
const renewWith = async (term: string, onFile: string) => {
  const co = await prisma.company.create({ data: { name: `${TAG} ${term}`, lifecycle: "client", status: "active", country: "SA" } });
  const emp = await prisma.employee.create({ data: { companyId: co.id, name: `${TAG} Worker`, status: "active" } });
  const doc = await prisma.document.create({
    data: { companyId: co.id, employeeId: emp.id, person: emp.name, docType: "Work Permit",
            docNumber: "WP-ZZ-1", expiryDate: onFile, status: "valid", daysLeft: 0 },
  });
  const tpl = await prisma.workflowTemplate.create({
    data: {
      name: `${TAG} ${term} Template`, country: "SA", trigger: "manual", entityType: "company",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "renew", type: "task", label: "Renew Iqama", config: { assigneeRole: "pro_officer",
            captures: [{ var: "newExpiry", type: "date", label: "New Iqama expiry", required: true }] } },
          { id: "issue_permit", type: "issue_document", label: "Work Permit",
            config: { docType: "Work Permit", expiryFromTerm: "permitTerm", documentIdVar: "workPermitDocId", renewExisting: true } },
          { id: "end", type: "end", label: "Done" },
        ],
        edges: [{ from: "start", to: "renew" }, { from: "renew", to: "issue_permit" }, { from: "issue_permit", to: "end" }],
      },
    },
  });
  // `permitTerm` is answered at the work permit step, three steps earlier in the real template; the
  // only thing that matters here is that it is on the run by the time the document is written.
  const inst = await startInstance(tpl.id, { companyId: co.id, clientName: co.name,
    variables: { employeeId: emp.id, permitTerm: term } });
  const t = await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId: "renew", status: "active" } });
  await completeTask(t!.id, { actor: "term-check", variables: { newExpiry: "2027-01-31" } });
  return (await prisma.document.findUnique({ where: { id: doc.id } }))?.expiryDate;
};

(async () => {
  await cleanup();

  ok(await renewWith("3_month", "2026-06-01") === "2026-08-30", "3 months is 90 days from the expiry on file");
  ok(await renewWith("6_month", "2026-06-01") === "2026-11-28", "6 months is 180 days");
  ok(await renewWith("12_month", "2026-06-01") === "2027-06-01", "12 months is a year, not 360 days");
  // The Iqama's date is NOT what the permit gets — that was the old behaviour, when the officer
  // typed both and the engine fell back to `newExpiry` for anything it was not given.
  ok(await renewWith("3_month", "2026-06-01") !== "2027-01-31", "it is not quietly copying the new Iqama expiry");
  // A permit that lapsed long ago renews to a date that is still past, and says so rather than
  // being rounded forward into a validity nobody was granted.
  ok(await renewWith("3_month", "2020-01-01") === "2020-03-31", "a lapsed permit is dated honestly, from when it lapsed");

  await cleanup();
  console.log(failures ? `\n${failures} FAILED` : "\nok: the permit is dated by the term that was paid for");
  await prisma.$disconnect();
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(String(e?.message ?? e)); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
