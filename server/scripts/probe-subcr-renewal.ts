/**
 * A sub CR renewed through the Commercial Registration Renewal workflow.
 *
 * One client, a main CR and a Jeddah sub CR, both certificates about to expire.
 *   1. The expiry trigger starts TWO runs — one per CR — each naming its CR and carrying its CR.
 *   2. Renewal preparation's "establishment active" check reads the certificate of the run's own CR.
 *   3. Walking the Jeddah run to the end renews the Jeddah certificate; the main CR's certificate is
 *      untouched and still live.
 *   4. A manual "Start renewal" of the Jeddah certificate (issue path, not renew-in-place) issues the
 *      new certificate on the Jeddah CR and replaces only Jeddah's old one.
 *
 * Scoped to its own client throughout; deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startInstance, completeTask } from "../src/workflow.js";
import { triggerRenewals } from "../src/jobs.js";
import { createEstablishment } from "../src/establishments.js";
import { runRenewalPrep } from "../src/agent-renewal-prep.js";

const TEMPLATE = "Commercial Registration Renewal";
const CLIENT = "ZS SubCR Renewal Probe";
let bad = 0;
const ok = (m: string) => console.log(`   ok    ${m}`);
const expect = (c: unknown, m: string) => { if (c) ok(m); else { bad++; console.log(`   FAIL  ${m}`); } };
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (!co) return;
  const runs = (await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } })).map(r => r.id);
  await prisma.agentTask.deleteMany({ where: { companyId: co.id } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs } } });
  await prisma.workflowLog.deleteMany({ where: { instanceId: { in: runs } } });
  await prisma.workflowInstance.deleteMany({ where: { id: { in: runs } } });
  await prisma.notification.deleteMany({ where: { OR: runs.map(id => ({ dedupeKey: { contains: id } })) } }).catch(() => {});
  await prisma.task.deleteMany({ where: { companyId: co.id } });
  await prisma.document.deleteMany({ where: { companyId: co.id } });
  await prisma.establishment.deleteMany({ where: { companyId: co.id } });
  await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
}

async function walk(instanceId: string, crNumber: string, newExpiry: string) {
  const plan: [string, Record<string, any>][] = [
    ["gate", { gateOutcome: "ready" }],
    ["fee", { renewalTerm: "1_year", mcFee: 1200, chamberTier: "Second", clientApproval: "approved", approvedBy: "Probe", approvedOn: iso(0) }],
    ["chamber", { chamberReceipt: "CH-P", chamberPaidOn: iso(0) }],
    ["pay", { paymentRef: "SADAD-P", paymentDate: iso(0) }],
    ["portal", { portalRef: "MC-P", submittedOn: iso(0), portalOutcome: "renewed" }],
    ["record", { crNumber, newExpiry }],
    ["followup", {}],
  ];
  for (const [node, vars] of plan) {
    const t = await prisma.workflowTask.findFirst({ where: { instanceId, status: "active" }, orderBy: { createdAt: "asc" } });
    if (!t || t.nodeId !== node) { expect(false, `expected step "${node}", the run is at "${t?.nodeId ?? "nothing"}"`); return false; }
    const checklist: any = {};
    for (const i of (Array.isArray(t.checklist) ? t.checklist : []) as any[]) checklist[i.key] = { received: true, verified: true };
    await completeTask(t.id, { actor: "Sub CR probe", checklist, variables: vars });
  }
  return (await prisma.workflowInstance.findUnique({ where: { id: instanceId } }))?.status === "completed";
}

async function main() {
  await sweep();
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE, active: true } });
  if (!tpl) { console.log(`no active "${TEMPLATE}" template`); process.exit(1); }

  const co = await prisma.company.create({ data: { name: CLIENT, cr: "1010888001", lifecycle: "client", country: "SA" } });
  const main = await createEstablishment(co.id, { crNumber: "1010888001" });
  const jed = await createEstablishment(co.id, { crNumber: "4030888002", city: "Jeddah" });
  const mainCert = await prisma.document.create({ data: { companyId: co.id, person: CLIENT, docType: "Commercial Registration", docNumber: "1010888001", expiryDate: iso(20), status: "expiring", daysLeft: 20 } });
  const jedCert = await prisma.document.create({ data: { companyId: co.id, person: CLIENT, docType: "Commercial Registration", docNumber: "4030888002", expiryDate: iso(25), status: "expiring", daysLeft: 25, establishmentId: jed.id } });

  console.log("\n1. The expiry trigger — one run per CR");
  const res = await triggerRenewals(co.id);
  const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true, title: true, variables: true } });
  const jedRun = runs.find(r => (r.variables as any)?.establishmentId === jed.id);
  const mainRun = runs.find(r => r.id !== jedRun?.id);
  expect(res.started === 2 && runs.length === 2, `two renewal runs started (started ${res.started})`);
  expect(jedRun && /Jeddah \(4030888002\)/.test(jedRun.title), `the Jeddah run names its CR — “${jedRun?.title}”`);
  expect(mainRun && /Main CR \(1010888001\)/.test(mainRun.title) && (mainRun.variables as any).establishmentId === null, `the main CR run names the main CR — “${mainRun?.title}”`);
  expect((jedRun?.variables as any)?.establishmentCr === "4030888002" && (jedRun?.variables as any)?.documentId === jedCert.id, "the Jeddah run carries its own certificate and CR number");
  expect(!("crNumber" in ((jedRun?.variables as any) ?? {})), "the run does not pre-fill the template's own crNumber field");

  console.log("\n2. Renewal preparation checks the run's own CR");
  await prisma.document.update({ where: { id: mainCert.id }, data: { expiryDate: iso(-3) } }); // the MAIN CR has lapsed
  await runRenewalPrep(jedRun!.id);
  await runRenewalPrep(mainRun!.id);
  const prep = await prisma.agentTask.findMany({ where: { companyId: co.id, agent: "renewal-prep" }, select: { refId: true, output: true } });
  const estCheck = (runId: string) => (((prep.find(p => p.refId === runId)?.output as any)?.checks ?? []) as any[]).find(c => c.key === "establishment_active");
  const jc = estCheck(jedRun!.id), mc = estCheck(mainRun!.id);
  if (!jc && !mc) console.log("   note  the gate step on this template has no “establishment active” item — nothing to check");
  else {
    expect(jc?.state === "ok" && /4030888002/.test(jc.note), `Jeddah's run reads Jeddah's certificate — “${jc?.note}”`);
    expect(mc?.state === "flag", `the main CR's run sees the main CR's lapse — “${mc?.note}”`);
  }
  await prisma.document.update({ where: { id: mainCert.id }, data: { expiryDate: iso(20) } });

  console.log("\n3. Walking the Jeddah run to the end");
  expect(await walk(jedRun!.id, "4030888002", iso(390)), "the Jeddah renewal ran through every step and completed");
  const live = await prisma.document.findMany({ where: { companyId: co.id, docType: "Commercial Registration", supersededAt: null }, select: { id: true, docNumber: true, expiryDate: true, establishmentId: true } });
  const liveJed = live.filter(d => d.establishmentId === jed.id);
  const liveMain = live.filter(d => d.establishmentId === null);
  expect(liveJed.length === 1 && liveJed[0].expiryDate?.slice(0, 10) === iso(390), `Jeddah's certificate now expires ${liveJed[0]?.expiryDate?.slice(0, 10)}`);
  expect(liveMain.length === 1 && liveMain[0].id === mainCert.id && liveMain[0].expiryDate?.slice(0, 10) === iso(20), "the main CR's certificate is untouched and still live");

  console.log("\n4. A manual Start renewal of the Jeddah certificate");
  const manual = await startInstance(tpl.id, {
    title: "Commercial Registration renewal — manual", companyId: co.id, clientName: CLIENT,
    // what the console's Start renewal sends
    variables: { docType: "Commercial Registration", complianceDocId: liveJed[0].id, establishmentId: jed.id },
  });
  expect(await walk(manual.id, "4030888002", iso(760)), "the manual renewal ran through every step and completed");
  const live2 = await prisma.document.findMany({ where: { companyId: co.id, docType: "Commercial Registration", supersededAt: null }, select: { id: true, expiryDate: true, establishmentId: true } });
  const j2 = live2.filter(d => d.establishmentId === jed.id), m2 = live2.filter(d => d.establishmentId === null);
  expect(j2.length === 1 && j2[0].expiryDate?.slice(0, 10) === iso(760), `the new Jeddah certificate is on the Jeddah CR, expiring ${j2[0]?.expiryDate?.slice(0, 10)}`);
  expect(m2.length === 1 && m2[0].id === mainCert.id, "the main CR's certificate is still the live one for the main CR");
  void main;
}

main()
  .catch(e => { bad++; console.error(e); })
  .finally(async () => {
    await sweep().catch(e => console.error("sweep:", e?.message));
    console.log(bad ? `\n${bad} FAILED` : "\nAll checks passed.");
    await prisma.$disconnect();
    process.exit(bad ? 1 : 0);
  });
