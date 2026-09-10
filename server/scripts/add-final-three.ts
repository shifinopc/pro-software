/**
 * The last three services in the handbook — the ones that needed engine work rather than
 * configuration, and now have it.
 *
 *   VAT Return Filing        was blocked on a recurring trigger AND client approval from the portal
 *   Payroll / WPS (Mudad)    was blocked on a recurring trigger
 *   Vehicle Services (Tamm)  was blocked on there being no such thing as a vehicle
 *
 * THE RECURRING TRIGGER now exists: jobs.ts startPeriodicRuns, wired into the hourly tick. It opens
 * one run per period per ENTITLED client — through their plan or an add-on — because a calendar
 * knows nothing about who a job is for, and opening a VAT return every month for every client on the
 * books would invent work for clients who are not VAT registered. A template no service points at is
 * inert rather than universal.
 *
 * TWO COMPROMISES, both stated rather than hidden.
 *
 *   CLIENT APPROVAL IS STILL A PRO TASK. The VAT spec wants the client to approve the return in the
 *   portal. The portal has no route that completes a workflow step — quotations there are read-only
 *   — so this records the client's answer instead, exactly as the MISA fee approval does and for the
 *   same reason. Modelling it as an approval node would put a button in front of somebody who
 *   cannot reach it. When the portal can complete a step, this is the step to change.
 *
 *   A VEHICLE IS ITS DOCUMENTS. The spec asks for a vehicle record and the engine has two subject
 *   kinds, company and employee. Rather than half-build a third, the vehicle is identified by its
 *   plate number, which is the number on its Vehicle Registration — a company-subject document. That
 *   buys the thing that actually matters: registration and insurance expire per plate and are picked
 *   up by the existing expiry trigger like any other document. What it does not buy is listing a
 *   company's vehicles as vehicles. If that is wanted, it is a Vehicle model and a third subjectKind,
 *   which is a bigger change than this file should make quietly.
 *
 * As with every other service: each recorded outcome is wired to a branch, because a workflow that
 * asks a question, writes down the answer and carries on regardless is the defect this codebase has
 * been burned by before.
 *
 * All three are DRAFTS. A recurring template additionally does nothing until a service is bound to
 * it and a client is entitled — bind-services-to-workflows.ts is the script for the first half.
 *
 * Idempotent.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function authority(name: string, sub: string, color: string, bg: string) {
  const found = await prisma.govCenter.findFirst({ where: { name, country: COUNTRY } });
  if (found) return;
  await prisma.govCenter.create({ data: { name, sub, country: COUNTRY, color, bg, packKey: `sa.authority.${slug(name)}` } as any });
  console.log(`  + authority ${name} (${sub})`);
}
async function docType(name: string, subjectKind: "company" | "employee", auth: string, leadDays: number) {
  const found = await prisma.documentType.findFirst({ where: { name } });
  const data = { name, country: COUNTRY, subjectKind, authority: auth, leadDays, neverExpires: false, requiresApproval: false, packKey: `sa.doctype.${slug(name)}` };
  if (found) await prisma.documentType.update({ where: { id: found.id }, data: data as any });
  else { await prisma.documentType.create({ data: data as any }); console.log(`  + document type ${name} (${subjectKind}, ${auth}, lead ${leadDays}d)`); }
}
async function checklist(name: string, items: [string, string, boolean?][]) {
  const packKey = `sa.checklist.${slug(name)}`;
  const rows = [{ conditions: [], documents: items.map(([key, label, opt]) => ({ key, label, source: "manual", required: opt !== true })) }];
  const found = await prisma.checklistRule.findFirst({ where: { OR: [{ packKey }, { name, country: COUNTRY }] } });
  const r = found
    ? await prisma.checklistRule.update({ where: { id: found.id }, data: { name, country: COUNTRY, packKey, rows: rows as any, retired: false } })
    : await prisma.checklistRule.create({ data: { name, country: COUNTRY, packKey, rows: rows as any } });
  return r.id;
}
async function save(name: string, entity: string, trigger: string, triggerConfig: any, nodes: any[], edges: any[]) {
  const existing = await prisma.workflowTemplate.findFirst({ where: { name } });
  const data: any = { name, country: COUNTRY, entityType: entity, trigger, triggerConfig, graph: { nodes, edges } as any, packKey: `sa.workflow.${slug(name)}`, active: false };
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data })
    : await prisma.workflowTemplate.create({ data: { ...data, createdAt: new Date().toISOString() } });
  console.log(`  ${existing ? "updated" : "created"} ${name.padEnd(34)} ${String(nodes.length).padStart(2)} nodes, ${String(edges.length).padStart(2)} edges  [draft, ${trigger}]`);
  return tpl.id;
}

async function vat() {
  await docType("VAT Return", "company", "ZATCA", 30);
  const docs = await checklist("VAT period documents", [
    ["sales", "Sales invoices"], ["purchases", "Purchase invoices"],
    ["notes", "Credit and debit notes"], ["import_vat", "Import VAT statements"],
  ]);
  const nodes: any[] = [
    { id: "start", type: "start", label: "Period Opened", config: {} },
    { id: "open", type: "task", label: "Open the Period", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "ZATCA",
      instructions: "The period and its filing deadline come from ZATCA's calendar, not ours. Record both — every SLA below is measured against the deadline, not against today.",
      captures: [{ var: "period", type: "text", label: "Period" }, { var: "deadline", type: "date", label: "Filing deadline" }] } },
    { id: "collect", type: "task", label: "Collect Sales and Purchases", config: {
      assigneeRole: "accountant", slaHours: 120, checklistSource: "dynamic", checklistRuleId: docs } },
    { id: "reconcile", type: "task", label: "Reconcile and Calculate", config: {
      assigneeRole: "accountant", slaHours: 72,
      captures: [{ var: "outputVat", type: "number", label: "Output VAT" }, { var: "inputVat", type: "number", label: "Input VAT" }, { var: "netVat", type: "number", label: "Net payable or refundable" }] } },
    { id: "review", type: "task", label: "Client Review and Approval", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      instructions: "The return is filed in the client's name and they carry the liability, so it is not submitted until they have seen the figures. Record their answer here — the portal cannot complete a step, so this is where their decision lives.",
      captures: [
        { var: "clientApproval", type: "select", label: "Client decision", options: "approved,query" },
        { var: "approvedBy", type: "text", label: "Who approved it", required: false },
        { var: "approvedOn", type: "date", label: "Date approved", required: false },
        { var: "queryRaised", type: "text", label: "What they queried", required: false },
      ],
      rules: [{ when: { var: "clientApproval", op: "eq", value: "approved" }, then: { var: "approvedBy", op: "present" },
        message: "Record who at the client approved the return. They carry the liability for it, and a name is the whole of the evidence." }] } },
    { id: "d_review", type: "decision", label: "Approved?", config: { branches: [
      { var: "clientApproval", op: "eq", value: "approved", key: "approved" },
      { var: "clientApproval", op: "eq", value: "query", key: "query" }] } },
    { id: "submit", type: "task", label: "Submit to ZATCA", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "ZATCA",
      captures: [{ var: "zatcaRef", type: "text", label: "ZATCA reference" }, { var: "filedOn", type: "date", label: "Date filed" }] } },
    { id: "pay", type: "task", label: "Pay via SADAD", config: {
      assigneeRole: "accountant", slaHours: 48,
      instructions: "A return filed but unpaid still accrues penalties. If the period is refundable rather than payable, record a zero and the refund reference.",
      captures: [{ var: "sadadBill", type: "text", label: "SADAD bill number" }, { var: "amountPaid", type: "number", label: "Amount paid" }, { var: "paidOn", type: "date", label: "Date paid" }] } },
    { id: "receipt", type: "task", label: "File the Return Receipt", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "ZATCA",
      captures: [{ var: "receiptRef", type: "text", label: "Receipt reference", purpose: "number" }] } },
    { id: "issue", type: "issue_document", label: "VAT Return", config: { docType: "VAT Return", numberVar: "receiptRef" } },
    { id: "end_done", type: "end", label: "Filed", config: {} },
  ];
  const edges: any[] = [
    { from: "start", to: "open" }, { from: "open", to: "collect" }, { from: "collect", to: "reconcile" },
    { from: "reconcile", to: "review" }, { from: "review", to: "d_review" },
    { from: "d_review", to: "submit", condition: "approved" },
    { from: "d_review", to: "reconcile", condition: "query" },
    { from: "d_review", to: "review", condition: "else" },
    { from: "submit", to: "pay" }, { from: "pay", to: "receipt" }, { from: "receipt", to: "issue" }, { from: "issue", to: "end_done" },
  ];
  return save("VAT Return Filing", "company", "recurring", { every: "quarterly", opensOnDay: 1 }, nodes, edges);
}

async function mudad() {
  await authority("Mudad", "Wage protection — payroll", "#B45309", "#FEF4E2");
  const valid = await checklist("WPS employee validation", [
    ["iban", "Every employee has an IBAN"], ["iqama", "Iqama numbers valid"], ["wages", "Wages match the Qiwa contract"],
  ]);
  const nodes: any[] = [
    { id: "start", type: "start", label: "Month Opened", config: {} },
    { id: "open", type: "task", label: "Open the Payroll Month", config: {
      assigneeRole: "hr_officer", slaHours: 24, govCenter: "Mudad",
      captures: [{ var: "payrollMonth", type: "text", label: "Payroll month" }, { var: "employeesInScope", type: "number", label: "Employees in scope" }, { var: "totalSalary", type: "number", label: "Total salary (SAR)" }] } },
    { id: "validate", type: "task", label: "Validate Employee Data", config: {
      assigneeRole: "hr_officer", slaHours: 48, checklistSource: "dynamic", checklistRuleId: valid,
      instructions: "A single bad IBAN fails the whole file at the bank, not just that employee. Check before uploading, not after.",
      captures: [
        // THE CONCLUSION IS STATED, NOT INFERRED FROM THE COUNT.
        //
        // This first branched on `failing == 0`, which reads perfectly well and loops for ever: the
        // count is a number the officer types, the comparison is exact, and any run where it is not
        // literally zero goes correct -> validate -> correct -> validate with no way out. The probe
        // hit forty steps and stopped. Every other blocking check in this pack is an explicit
        // select for exactly this reason — the officer says whether it is clean, and the count is
        // the detail beside it rather than the thing the engine steers on.
        { var: "allValid", type: "select", label: "Is the file clean?", options: "yes,no" },
        { var: "failing", type: "number", label: "Records failing validation" },
        { var: "failingWho", type: "text", label: "Which records", required: false },
      ] } },
    { id: "d_valid", type: "decision", label: "All Valid?", config: { branches: [
      { var: "allValid", op: "eq", value: "yes", key: "clean" },
      { var: "allValid", op: "eq", value: "no", key: "failing" }] } },
    { id: "correct", type: "task", label: "Correct Failing Records", config: {
      assigneeRole: "hr_officer", slaHours: 48,
      captures: [{ var: "corrected", type: "text", label: "What was corrected" }] } },
    { id: "upload", type: "task", label: "Upload the WPS File", config: {
      assigneeRole: "accountant", slaHours: 24, govCenter: "Mudad",
      captures: [{ var: "fileRef", type: "text", label: "File reference" }, { var: "uploadedOn", type: "date", label: "Date uploaded" }] } },
    { id: "result", type: "task", label: "Record the Compliance Result", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Mudad",
      instructions: "The compliance percentage is what MHRSD acts on. Anything below full needs the exception employees named, because that is the list somebody has to work.",
      captures: [{ var: "mudadStatus", type: "text", label: "Mudad status" }, { var: "compliancePct", type: "number", label: "WPS compliance percentage" }, { var: "exceptions", type: "text", label: "Exception employees", required: false }] } },
    { id: "end_done", type: "end", label: "Submitted", config: {} },
  ];
  const edges: any[] = [
    { from: "start", to: "open" }, { from: "open", to: "validate" }, { from: "validate", to: "d_valid" },
    { from: "d_valid", to: "upload", condition: "clean" },
    { from: "d_valid", to: "correct", condition: "failing" },
    { from: "d_valid", to: "correct", condition: "else" },
    { from: "correct", to: "validate" },
    { from: "upload", to: "result" }, { from: "result", to: "end_done" },
  ];
  return save("Payroll / WPS Submission (Mudad)", "company", "recurring", { every: "monthly", opensOnDay: 1 }, nodes, edges);
}

async function tamm() {
  await authority("Tamm", "Vehicle and government services", "#1D4ED8", "#EEF2FF");
  await docType("Vehicle Registration", "company", "Tamm", 30);
  await docType("Vehicle Insurance", "company", "Tamm", 30);
  const checks = await checklist("Vehicle service checks", [
    ["registration", "Registration card current"], ["insurance", "Insurance policy current"],
    ["inspection", "Periodic inspection valid"], ["fines", "No outstanding traffic fines"],
  ]);
  const nodes: any[] = [
    { id: "start", type: "start", label: "Started", config: {} },
    { id: "select", type: "task", label: "Select Vehicle and Service", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Tamm",
      instructions: "The plate number identifies the vehicle throughout — it is the number on its registration, and every document this run touches is filed against it.",
      captures: [{ var: "plateNumber", type: "text", label: "Plate number" }, { var: "serviceRequired", type: "select", label: "Service required", options: "renew_registration,renew_insurance,transfer_ownership,settle_fines,periodic_inspection" }] } },
    { id: "verify", type: "task", label: "Verify Registration and Insurance", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Tamm",
      checklistSource: "dynamic", checklistRuleId: checks,
      captures: [{ var: "outstanding", type: "select", label: "Anything outstanding?", options: "no,yes" }, { var: "outstandingWhat", type: "text", label: "What is outstanding", required: false }],
      rules: [{ when: { var: "outstanding", op: "eq", value: "yes" }, then: { var: "outstandingWhat", op: "present" },
        message: "Say what is outstanding — the settlement step is worked from this note." }] } },
    { id: "d_verify", type: "decision", label: "Clear?", config: { branches: [
      { var: "outstanding", op: "eq", value: "no", key: "clear" },
      { var: "outstanding", op: "eq", value: "yes", key: "blocked" }] } },
    { id: "settle", type: "task", label: "Settle Fines or Renew Insurance", config: {
      assigneeRole: "accountant", slaHours: 72,
      instructions: "Tamm refuses a transaction on a vehicle carrying unpaid fines or lapsed cover. Clear it, then send it back to be re-checked.",
      captures: [{ var: "amountPaid", type: "number", label: "Amount paid" }, { var: "paymentRef", type: "text", label: "Payment reference" }] } },
    { id: "perform", type: "task", label: "Perform the Transaction", config: {
      assigneeRole: "pro_officer", slaHours: 48, govCenter: "Tamm",
      captures: [{ var: "tammRef", type: "text", label: "Tamm reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }] } },
    { id: "record", type: "task", label: "Record the Updated Document", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Tamm",
      instructions: "Filed against the plate number, so the registration expires per vehicle and the expiry trigger picks it up like any other document.",
      captures: [{ var: "regNumber", type: "text", label: "Plate / registration number", purpose: "number" }, { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" }] } },
    { id: "issue", type: "issue_document", label: "Vehicle Registration", config: { docType: "Vehicle Registration", numberVar: "regNumber", expiryVar: "newExpiry" } },
    { id: "end_done", type: "end", label: "Complete", config: {} },
  ];
  const edges: any[] = [
    { from: "start", to: "select" }, { from: "select", to: "verify" }, { from: "verify", to: "d_verify" },
    { from: "d_verify", to: "perform", condition: "clear" },
    { from: "d_verify", to: "settle", condition: "blocked" },
    { from: "d_verify", to: "settle", condition: "else" },
    { from: "settle", to: "verify" },
    { from: "perform", to: "record" }, { from: "record", to: "issue" }, { from: "issue", to: "end_done" },
  ];
  return save("Vehicle Services (Tamm)", "company", "manual", null, nodes, edges);
}

async function main() {
  console.log("THE LAST THREE");
  await vat();
  await mudad();
  await tamm();
  console.log("\nAll three are DRAFTS.");
  console.log("The two recurring ones also need a service bound to them before they open anything —");
  console.log("entitlement is what selects the clients. See bind-services-to-workflows.ts.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
