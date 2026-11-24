/**
 * DOES FINISHING THE CR STEP ACTUALLY REGISTER THE CLIENT?
 *
 *   npx tsx scripts/business-setup-cr-check.ts
 *
 * The Business Setup flow's whole point is that a client who signed without a commercial
 * registration ends up holding one. That depended on three things that were each separately true
 * and together did nothing:
 *
 *   · the CR step must name the document it is about (`docType`) and say which answer is the
 *     number, the issue date and the expiry (`purpose`) — otherwise the engine files nothing
 *   · the engine's own document write must adopt the certificate as the client's main CR — that
 *     lived only in the CRUD create route, so a certificate filed BY A RUN was ignored
 *   · adopting it must lift the `crPending` waiver
 *
 * So this drives the real engine over a one-step template and asserts the end state on the client
 * row. A fixture client and template, both deleted afterwards, both tagged so a crash leaves
 * something obviously disposable rather than something that looks real.
 *
 * LOCAL DATABASES ONLY, by host: it creates a client and a workflow run.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";

const host = (process.env.DATABASE_URL || "").match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  process.exit(1);
}

const TAG = "ZZ CR Check";
const CR = "4030999123";

const cleanup = async () => {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: { in: ids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    if (rids.length) {
      await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
      await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    }
    await prisma.document.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.establishment.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
};

(async () => {
  await cleanup();

  // The document type the step files. Reused if the environment already has it — this is the real
  // one a real run would use, and creating a second with the same name would be the bug under test.
  const dt = await prisma.documentType.findFirst({ where: { name: "Commercial Registration" } });
  if (!dt) throw new Error("No 'Commercial Registration' document type on this database — install the Saudi pack first.");
  if ((dt.subjectKind ?? "employee") !== "company") {
    throw new Error(`'Commercial Registration' is a ${dt.subjectKind} document here; the CR step files it against the COMPANY.`);
  }

  const co = await prisma.company.create({
    data: { name: `${TAG} Client`, lifecycle: "client", status: "active", crPending: true, country: "SA" },
  });

  const tpl = await prisma.workflowTemplate.create({
    data: {
      name: `${TAG} Template`, country: "SA", trigger: "manual", entityType: "company",
      graph: {
        nodes: [
          { id: "start", type: "start", label: "Start" },
          { id: "cr", type: "task", label: "CR application and issue",
            config: {
              docTypeSource: "specific", docType: "Commercial Registration", slaHours: 120, assigneeRole: "pro_officer",
              captures: [
                { var: "crNumber", label: "CR number", type: "text", required: true, purpose: "number" },
                { var: "crIssued", label: "Issued on", type: "date", required: true, purpose: "issue" },
                { var: "crExpiry", label: "Expires on", type: "date", required: true, purpose: "expiry" },
              ],
            } },
          { id: "end", type: "end", label: "Done" },
        ],
        edges: [{ from: "start", to: "cr" }, { from: "cr", to: "end" }],
      },
    },
  });

  const inst = await startInstance(tpl.id, { companyId: co.id, clientName: co.name });
  const task = await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId: "cr" } });
  if (!task) throw new Error("FAIL: starting the run did not open the CR step");

  await completeTask(task.id, {
    actor: "check",
    variables: { crNumber: CR, crIssued: "2026-11-24", crExpiry: "2027-11-23" },
  });

  const after = await prisma.company.findUnique({ where: { id: co.id }, select: { cr: true, crPending: true } });
  const doc = await prisma.document.findFirst({ where: { companyId: co.id, docType: "Commercial Registration" } });
  const main = await prisma.establishment.findFirst({ where: { companyId: co.id, kind: "main" } });

  const fail = (m: string) => { throw new Error("FAIL: " + m); };
  if (!doc) fail("the CR step filed no Commercial Registration — the node's docType or the captures' purpose did not take");
  if (doc!.docNumber !== CR) fail(`the certificate carries "${doc!.docNumber}" rather than the captured ${CR}`);
  if (doc!.expiryDate !== "2027-11-23") fail(`the certificate expires "${doc!.expiryDate}" — the expiry capture did not land`);
  if (after?.cr !== CR) fail(`the client record still reads cr="${after?.cr}" — the run's certificate was not adopted`);
  if (after?.crPending) fail("the client holds a CR and is still flagged as waiting for one");
  if (!main || main.crNumber !== CR) fail("no main CR row was created from the certificate");

  await cleanup();
  console.log(`ok: completing the CR step filed the certificate, set cr=${CR}, lifted crPending and created the main CR row`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(String(e?.message ?? e));
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
