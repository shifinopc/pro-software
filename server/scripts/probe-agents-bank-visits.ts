/**
 * Bank Reconciliation and the Government Visit Planner, against their own fixtures.
 *
 *   1. Bank: a real-looking statement (title rows, day-first dates, Debit/Credit columns, thousands
 *      separators) is read; each deposit is matched by the rule that fits — invoice number, client name
 *      with the exact amount, a unique amount — or recognised as already recorded, or left unplaced;
 *      money out is not matched; the same file twice imports nothing; confirming records the payment.
 *   2. Visits: a booked appointment, a workflow step and a courier job at the same office become ONE
 *      trip on the appointment's day; a portal step is never a trip; the plan becomes a task; an admin's
 *      own list of in-person centers overrides the guess.
 */
import { prisma } from "../src/db.js";
import { parseStatement, importStatement, act as bankAct, toIsoDate } from "../src/agent-bank.js";
import { planVisits, runVisitPlanner, act as visitAct, inPersonCenters } from "../src/agent-visits.js";
import { updateAgent } from "../src/agents.js";

const A = "ZS Bank Probe Trading Est", B = "Al Zahra Probe Co", TAG = "zs-bv-probe";
let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);
const admin = { id: null, name: "Probe Admin", role: "super_admin" };
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const dmy = (t: number) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`; };

async function sweep() {
  for (const n of [A, B]) {
    const co = await prisma.company.findFirst({ where: { name: n } });
    if (!co) continue;
    const invs = await prisma.invoice.findMany({ where: { companyId: co.id } });
    await prisma.payment.deleteMany({ where: { invoiceId: { in: invs.map(i => i.id) } } });
    await prisma.invoice.deleteMany({ where: { companyId: co.id } });
    await prisma.appointment.deleteMany({ where: { companyId: co.id } });
    await prisma.courierShipment.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.bankLine.deleteMany({ where: { fileName: { startsWith: TAG } } });
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: TAG } });
  const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: tpls.map(t => t.id) } } });
  await prisma.workflowTask.deleteMany({ where: { instanceId: { in: runs.map(r => r.id) } } });
  await prisma.workflowInstance.deleteMany({ where: { id: { in: runs.map(r => r.id) } } });
  await prisma.workflowTemplate.deleteMany({ where: { id: { in: tpls.map(t => t.id) } } });
  await prisma.govCenter.deleteMany({ where: { name: { startsWith: "ZS Probe" } } });
  await prisma.task.deleteMany({ where: { title: { contains: "ZS Probe Jawazat" } } });
}

let tasksBefore = new Set<string>();
let agentsBefore: any = null;
async function restore() {
  await sweep();
  await prisma.agentTask.deleteMany({ where: { id: { notIn: [...tasksBefore] }, agent: { in: ["bank-reconciliation", "visit-planner"] } } });
  if (agentsBefore) await prisma.appSetting.update({ where: { key: "agents" }, data: { value: agentsBefore.value } }).catch(() => {});
  else await prisma.appSetting.deleteMany({ where: { key: "agents" } });
  await prisma.appSetting.deleteMany({ where: { key: "agentRuns" } });
}

async function main() {
  await sweep();
  tasksBefore = new Set((await prisma.agentTask.findMany({ select: { id: true } })).map(t => t.id));
  agentsBefore = await prisma.appSetting.findUnique({ where: { key: "agents" } });
  const now = Date.now();

  // ── 1. bank ──
  console.log("1. bank reconciliation");
  toIsoDate("05/09/2026") === "2026-09-05" && toIsoDate("2026-09-05") === "2026-09-05" && toIsoDate("5-Sep-26") === "2026-09-05" ? ok("dates read day-first, ISO, and 5-Sep-26") : fail(`dates: ${toIsoDate("05/09/2026")} ${toIsoDate("5-Sep-26")}`);
  const a = await prisma.company.create({ data: { name: A, country: "SA", lifecycle: "client" } as any });
  const b = await prisma.company.create({ data: { name: B, country: "SA", lifecycle: "client" } as any });
  const inv1 = await prisma.invoice.create({ data: { number: "ZSB-INV-101", companyId: a.id, clientName: A, amount: 1150, status: "unpaid", dueDate: iso(now - 5 * DAY), date: iso(now - 35 * DAY) } });
  const inv2 = await prisma.invoice.create({ data: { number: "ZSB-INV-102", companyId: a.id, clientName: A, amount: 3450, status: "overdue", dueDate: iso(now - 20 * DAY), date: iso(now - 50 * DAY) } });
  await prisma.invoice.create({ data: { number: "ZSB-INV-201", companyId: b.id, clientName: B, amount: 7813, status: "unpaid", dueDate: iso(now - 2 * DAY), date: iso(now - 32 * DAY) } });
  const inv4 = await prisma.invoice.create({ data: { number: "ZSB-INV-103", companyId: a.id, clientName: A, amount: 900, status: "unpaid", dueDate: iso(now), date: iso(now - 30 * DAY) } });
  await prisma.payment.create({ data: { number: "ZSB-RCP-1", invoiceId: inv4.id, invoiceNumber: inv4.number, companyId: a.id, clientName: A, amount: 500, method: "Bank transfer", reference: "TRX55120", date: iso(now - 2 * DAY) } });

  const csv = [
    "Account Statement,,,,,,",
    "Account No: 1234567890,,,,,,",
    "Transaction Date,Value Date,Description,Reference,Debit,Credit,Balance",
    `${dmy(now - 3 * DAY)},${dmy(now - 3 * DAY)},"TRANSFER FROM ZS BANK PROBE TRADING INV ZSB-INV-101",TRX11001,,"1,150.00","10,000.00"`,
    `${dmy(now - 3 * DAY)},${dmy(now - 3 * DAY)},"ZS BANK PROBE TRADING EST - SADAD PAYMENT",TRX11002,,"3,450.00","13,450.00"`,
    `${dmy(now - 2 * DAY)},${dmy(now - 2 * DAY)},"IBAN TRANSFER 9981",TRX11003,,"7,813.00","21,263.00"`,
    `${dmy(now - 2 * DAY)},${dmy(now - 2 * DAY)},"CASH DEPOSIT BRANCH 12",,,"9,917.00","31,180.00"`,
    `${dmy(now - 2 * DAY)},${dmy(now - 2 * DAY)},"PAYMENT TRX55120 ZS BANK PROBE",TRX55120,,"500.00","31,680.00"`,
    `${dmy(now - 1 * DAY)},${dmy(now - 1 * DAY)},"GOSI CONTRIBUTION",GOSI9,"200.00",,"31,480.00"`,
  ].join("\r\n");
  const parsed = parseStatement(csv);
  parsed.lines.length === 6 && parsed.lines[0].amountMinor === 115000 && parsed.lines[5].amountMinor === -20000 ? ok("title rows skipped; 6 transactions read; 1,150.00 → 1150; the GOSI debit is money out") : fail(`parse: ${JSON.stringify(parsed)}`);
  const arabic = parseStatement("التاريخ,البيان,مدين,دائن\n05/09/2026,حوالة واردة,,250.00\n");
  arabic.lines.length === 1 && arabic.lines[0].amountMinor === 25000 ? ok("an Arabic-headed statement (التاريخ, البيان, مدين, دائن) is read too") : fail(`arabic: ${JSON.stringify(arabic)}`);

  const res = await importStatement({ fileName: `${TAG}-sept.csv`, text: csv, actor: admin });
  res.added === 6 && res.recorded === 1 && res.proposed === 3 && res.unmatched === 1 ? ok(`imported: 1 already recorded, 3 matched to confirm, 1 not placed, debit left alone`) : fail(`import: ${JSON.stringify(res)}`);
  const line = async (desc: string) => prisma.bankLine.findFirst({ where: { fileName: { startsWith: TAG }, description: { contains: desc } } });
  const task = async (l: any) => prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "bank-reconciliation", dedupeKey: `line:${l.id}` } } });
  const t1 = await task(await line("INV ZSB-INV-101"));
  const m1 = (t1?.output as any)?.match;
  m1?.allocations?.[0]?.invoiceId === inv1.id && (t1?.output as any)?.confidence === "high" ? ok("the transfer quoting ZSB-INV-101 is matched to that invoice, high confidence") : fail(`number match: ${JSON.stringify(t1?.output)}`);
  const t2 = await task(await line("SADAD PAYMENT"));
  (t2?.output as any)?.match?.allocations?.[0]?.invoiceId === inv2.id && (t2?.output as any)?.confidence === "high" ? ok("the client's name with the exact 3,450 owed → ZSB-INV-102, high confidence") : fail(`name match: ${JSON.stringify(t2?.output)}`);
  const t3 = await task(await line("IBAN TRANSFER 9981"));
  t3?.companyId === b.id && (t3.output as any)?.confidence === "low" ? ok("7,813 with no name matches the only invoice owing exactly that — flagged low confidence to check") : fail(`amount match: ${JSON.stringify(t3?.output)}`);
  (await line("TRX55120"))?.status === "recorded" ? ok("the 500 already recorded as a payment is recognised, not proposed again") : fail("already-recorded not recognised");
  (await line("CASH DEPOSIT"))?.status === "unmatched" ? ok("a cash deposit nothing identifies is listed as not placed") : fail("unplaced deposit");
  (await line("GOSI"))?.status === "ignored" ? ok("money out is kept but not matched") : fail("debit handled wrongly");
  const again = await importStatement({ fileName: `${TAG}-sept-again.csv`, text: csv, actor: admin });
  again.added === 0 && again.duplicates === 6 ? ok("uploading the same statement again imports nothing") : fail(`re-import: ${JSON.stringify(again)}`);
  (await prisma.payment.count({ where: { invoiceId: inv1.id } })) === 0 ? ok("nothing recorded before the accountant confirms") : fail("recorded early");
  await bankAct(t1!.id, "record", {}, admin);
  const p1 = await prisma.payment.findFirst({ where: { invoiceId: inv1.id } });
  p1?.amount === 1150 && p1.method === "Bank transfer" && (await prisma.invoice.findUnique({ where: { id: inv1.id } }))?.status === "paid" && (await line("INV ZSB-INV-101"))?.status === "matched"
    ? ok("confirming records 1,150 dated from the bank line, settles the invoice, and marks the line matched") : fail(`record: ${JSON.stringify(p1)}`);
  try { await bankAct(t2!.id, "record", {}, { id: null, name: "Sales", role: "sales" }); fail("a sales user recorded a payment"); }
  catch (e: any) { e.status === 403 ? ok("recording needs Finance permission") : fail(e.message); }
  const group = await prisma.agentTask.findFirst({ where: { agent: "bank-reconciliation", kind: "bank-unmatched", status: "review", refId: res.statementId } });
  await bankAct(group!.id, "dismiss", { reason: "Owner's cash" }, admin);
  (await line("CASH DEPOSIT"))?.status === "ignored" ? ok("setting the unplaced list aside marks those lines ignored") : fail("dismiss did not update lines");

  // ── 2. visits ──
  console.log("\n2. government visit planner");
  await prisma.govCenter.createMany({ data: [{ name: "ZS Probe Jawazat Office", sub: "Passports" }, { name: "ZS Probe Qiwa Portal", sub: "Online" }] });
  const guessed = await inPersonCenters();
  guessed.names.includes("ZS Probe Jawazat Office") && !guessed.names.includes("ZS Probe Qiwa Portal") ? ok("guessed: the Jawazat office needs a visit, the Qiwa portal does not") : fail(`guess: ${JSON.stringify(guessed.all.filter(c => c.name.startsWith("ZS")))}`);
  let apptT = now + 2 * DAY;
  while ([5, 6].includes(new Date(apptT).getUTCDay())) apptT += DAY;
  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG, graph: { nodes: [], edges: [] } } as any });
  const run = await prisma.workflowInstance.create({ data: { templateId: tpl.id, title: "Exit re-entry — Probe", companyId: a.id, clientName: A, status: "running", variables: {} } });
  await prisma.appointment.create({ data: { title: "Biometrics", type: "Biometrics", companyId: a.id, clientName: A, employee: "Ravi", location: "ZS Probe Jawazat Office, Riyadh", date: iso(apptT), time: "09:30", status: "Confirmed" } });
  const step = await prisma.workflowTask.create({ data: { instanceId: run.id, nodeId: "stamp", title: "Collect exit stamp", status: "active", govCenter: "ZS Probe Jawazat Office", dueDate: new Date(apptT + 3 * DAY).toISOString() } });
  await prisma.workflowTask.create({ data: { instanceId: run.id, nodeId: "portal", title: "Update on Qiwa", status: "active", govCenter: "ZS Probe Qiwa Portal", dueDate: new Date(apptT + DAY).toISOString() } });
  await prisma.courierShipment.create({ data: { ref: "ZSBV-C1", description: "original passport", companyId: a.id, clientName: A, status: "Requested", toPlace: "ZS Probe Jawazat Office", eta: iso(apptT + 4 * DAY) } });

  const plan = await planVisits(now);
  const trip = plan.trips.find(t => t.place === "ZS Probe Jawazat Office");
  trip && trip.day === iso(apptT) && trip.items.length === 3 && plan.trips.filter(t => t.place === "ZS Probe Jawazat Office").length === 1
    ? ok(`appointment, exit-stamp step and passport drop-off → one trip to Jawazat on ${trip.day}`) : fail(`trip: ${JSON.stringify(plan.trips.filter(t => t.place.startsWith("ZS")))}`);
  !plan.items.some(i => i.place === "ZS Probe Qiwa Portal") ? ok("the Qiwa portal step is not turned into a trip") : fail("portal step planned");
  await runVisitPlanner(now);
  const planTask = await prisma.agentTask.findUnique({ where: { agent_dedupeKey: { agent: "visit-planner", dedupeKey: `plan:${iso(now)}` } } });
  planTask?.status === "review" ? ok(`plan raised: "${planTask.title}"`) : fail("plan finding missing");
  await visitAct(planTask!.id, "tasks", {}, admin);
  const visitTask = await prisma.task.findFirst({ where: { title: "Visit ZS Probe Jawazat Office — 3 items", dueDate: iso(apptT) } });
  visitTask && visitTask.govCenter === "ZS Probe Jawazat Office" && ((visitTask.customData as any)?.items ?? []).length === 3 ? ok(`visit task ${visitTask.ref} created for ${iso(apptT)}, listing all three`) : fail(`visit task: ${JSON.stringify(visitTask)}`);
  await updateAgent("visit-planner", { inPersonCenters: [] }, admin);
  const noneIn = await planVisits(now);
  !noneIn.items.some(i => i.place === "ZS Probe Jawazat Office") ? ok("with an admin's list that leaves Jawazat unticked, it is no longer planned") : fail("override ignored");
  void step;

  await restore();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await restore().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
