/**
 * Build the three employee renewals — Iqama, Work Permit, Health Insurance — from the specifications
 * in docs/planned-services.js.
 *
 * WHY THESE THREE, AND WHY TOGETHER. Live carries 157 documents and every one of them belongs to an
 * employee: 39 Iqamas, 39 work permits, 40 health insurance policies, 39 passports. It carries no
 * company documents at all, which is why both workflows built before this one — MISA and Commercial
 * Registration — have nothing to fire on. These three watch document types that already exist, at
 * lead times already configured (60 / 30 / 30 days), so one nightly tick starts covering 118 real
 * documents the moment they are activated.
 *
 * Nothing new is needed for any of them. The authorities (Muqeem, Qiwa, CCHI) and the document types
 * are already in the pack, and Iqama's engine-level hold is already configured on the document type:
 * prereqs = Health Insurance (1 month) and Passport (6 months). That hold is the real mechanism —
 * `unmetPrereqs()` stops the renewal starting — and the Prerequisite Check step below is the human
 * layer over it, not a replacement for it.
 *
 * ONE PLACE ALL THREE SPECS MEET THE ENGINE AND HAVE TO BE FILLED IN.
 *
 *   Each spec records a "Client decision (approved / declined)" and then lists the payment step
 *   next, with no decision between them. Taken literally that builds a workflow which asks the
 *   client, writes down that they said no, and charges them anyway. Iqama's spec has the same shape
 *   around its blocking check: it records "Anything blocking renewal" and a "Resolve the Blocking
 *   Item" step, but nothing routes to it.
 *
 *   A recorded answer that nothing reads is the exact class of defect this codebase has been burned
 *   by before, so every recorded decision here is wired to a branch: declined ends the run without
 *   paying or issuing, blocked routes to the resolve step and back. This adds no judgement the specs
 *   do not already ask an officer to make — it only makes the answers count.
 *
 *   Work Permit's spec has no resolve step of its own, so a blocked check returns to the check
 *   itself after the officer clears it, rather than inventing a step the client has not seen.
 *
 * All three are left as DRAFTS. Activating them arms the nightly job against 118 real employee
 * documents belonging to real clients — that is the user's call, not a script's.
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";

const slugOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

async function upsertChecklist(name: string, items: { key: string; label: string; required?: boolean }[]) {
  const packKey = `sa.checklist.${slugOf(name)}`;
  const rows = [{ conditions: [], documents: items.map(i => ({ key: i.key, label: i.label, source: "manual", required: i.required !== false })) }];
  const found = await prisma.checklistRule.findFirst({ where: { OR: [{ packKey }, { name, country: COUNTRY }] } });
  const rule = found
    ? await prisma.checklistRule.update({ where: { id: found.id }, data: { name, country: COUNTRY, packKey, rows: rows as any, retired: false } })
    : await prisma.checklistRule.create({ data: { name, country: COUNTRY, packKey, rows: rows as any } });
  console.log(`  ${found ? "updated" : "created"} checklist "${name}" (${items.length} items)`);
  return rule.id;
}

async function upsertTemplate(name: string, docType: string, days: number, nodes: any[], edges: any[]) {
  const existing = await prisma.workflowTemplate.findFirst({ where: { name } });
  const data: any = {
    name, country: COUNTRY, entityType: "employee",
    trigger: "document_expiry",
    triggerConfig: { docType, days } as any,
    graph: { nodes, edges } as any,
    packKey: `sa.workflow.${slugOf(name)}`,
    active: false,
  };
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data })
    : await prisma.workflowTemplate.create({ data: { ...data, createdAt: new Date().toISOString() } });
  console.log(`  ${existing ? "updated" : "created"} "${name}" — ${nodes.length} nodes, ${edges.length} edges, expiry on "${docType}" at ${days}d, DRAFT [${tpl.id}]`);
  return tpl.id;
}

/** The fee/approval step every one of these shares, with the name of the money it is asking about. */
const feeStep = (id: string, label: string, extra: any[] = []) => ({
  id, type: "task", label, config: {
    assigneeRole: "pro_officer", slaHours: 48,
    instructions: "Put the cost to the client and record their answer here. Nothing is paid until this step says approved.",
    captures: [
      ...extra,
      { var: "clientApproval", type: "select", label: "Client decision", options: "approved,declined" },
      { var: "approvedBy", type: "text", label: "Who approved it, at the client", required: false },
    ],
    rules: [
      { when: { var: "clientApproval", op: "eq", value: "approved" }, then: { var: "approvedBy", op: "present" },
        message: "Record who at the client approved it. This is the firm's evidence for spending their money, and a name is the whole of it." },
    ],
  },
});

// EVERY BRANCH CARRIES `op` EXPLICITLY. evalDecision's default arm is ok = false, so a branch written
// { var, value, key } matches nothing and the decision falls to "else" every time — which is what
// looped the MISA workflow between two steps twenty times.
const feeDecision = (id: string) => ({
  id, type: "decision", label: "Approved?", config: {
    branches: [
      { var: "clientApproval", op: "eq", value: "approved", key: "approved" },
      { var: "clientApproval", op: "eq", value: "declined", key: "declined" },
    ],
  },
});

async function iqama() {
  console.log("\nIqama Renewal");
  const check = await upsertChecklist("Iqama renewal prerequisites", [
    { key: "passport_6m", label: "Passport valid at least 6 months" },
    { key: "insurance_current", label: "Health insurance current" },
    { key: "permit_current", label: "Work permit current" },
    { key: "no_restriction", label: "No government restriction on the employee" },
    { key: "no_fines", label: "No outstanding traffic or labour fines" },
  ]);

  const nodes: any[] = [
    { id: "start", type: "start", label: "Renewal Created", config: {} },
    { id: "prereq", type: "task", label: "Prerequisite Check", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Muqeem",
      checklistSource: "dynamic", checklistRuleId: check,
      instructions:
        "The engine already holds this renewal if the passport or the health insurance is short — this is the rest of it. A submission made against a restricted employee or an unpaid fine is refused, and a refusal costs more time than clearing the item first.",
      captures: [
        { var: "prereqOutcome", type: "select", label: "Is the employee clear to renew?", options: "ready,blocked" },
        { var: "blockReason", type: "text", label: "Anything blocking renewal?", required: false },
      ],
      rules: [
        { when: { var: "prereqOutcome", op: "eq", value: "blocked" }, then: { var: "blockReason", op: "present" },
          message: "Say what is blocking it — the hold is worked from this note, and \"blocked\" with no reason tells the next officer nothing." },
      ],
    } },
    { id: "d_prereq", type: "decision", label: "Clear to Renew?", config: {
      branches: [
        { var: "prereqOutcome", op: "eq", value: "ready", key: "ready" },
        { var: "prereqOutcome", op: "eq", value: "blocked", key: "blocked" },
      ],
    } },
    { id: "hold_fix", type: "task", label: "Resolve the Blocking Item", config: {
      assigneeRole: "pro_officer", slaHours: 168,
      instructions: "Clear whatever the check found — renew the passport or the insurance, settle the fines, lift the restriction — then send it back to be re-checked.",
      captures: [{ var: "blockCleared", type: "text", label: "What was done" }],
    } },
    feeStep("fee", "Confirm Fee and Client Approval", [
      { var: "renewalTerm", type: "select", label: "Renewal term", options: "1_year,2_years" },
      { var: "feeAmount", type: "number", label: "Government fee (SAR)" },
    ]),
    feeDecision("d_fee"),
    { id: "pay", type: "task", label: "Pay the Government Fee", config: {
      assigneeRole: "accountant", slaHours: 48,
      instructions: "Pay the approved fee and record the receipt. The receipt is filed with the renewal and sent to the client with the invoice.",
      captures: [
        { var: "paymentRef", type: "text", label: "Payment reference" },
        { var: "paymentDate", type: "date", label: "Date paid" },
      ],
    } },
    { id: "submit", type: "task", label: "Submit the Renewal", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Muqeem",
      captures: [
        { var: "muqeemRef", type: "text", label: "Muqeem reference" },
        { var: "submittedOn", type: "date", label: "Date submitted" },
      ],
    } },
    { id: "record", type: "task", label: "Record the Renewed Iqama", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Muqeem",
      instructions: "The Iqama number does not change on renewal — only the expiry does. Record both so the file and the register agree.",
      captures: [
        { var: "iqamaNumber", type: "text", label: "Iqama number (unchanged)", purpose: "number" },
        { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" },
      ],
    } },
    { id: "issue", type: "issue_document", label: "Iqama", config: { docType: "Iqama", numberVar: "iqamaNumber", expiryVar: "newExpiry" } },
    { id: "handover", type: "task", label: "Give the Employee the Iqama", config: {
      assigneeRole: "pro_officer", slaHours: 48,
      instructions: "The employee must physically hold their own Iqama. Record who took it and when — this is the firm's answer if it is ever asked for.",
      captures: [
        { var: "handedTo", type: "text", label: "Handed over to" },
        { var: "handedOn", type: "date", label: "Date" },
      ],
    } },
    { id: "notify", type: "notify", label: "Tell the Client", config: {
      channel: "Email", to: "{{ clientEmail }}",
      subject: "An Iqama has been renewed",
      template: "The Iqama {{ iqamaNumber }} has been renewed and is valid until {{ newExpiry }}. The permit and the payment receipt are on file in your portal.",
    } },
    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
    { id: "end_declined", type: "end", label: "Not Renewed — Client Declined", config: {} },
  ];

  const edges: any[] = [
    { from: "start", to: "prereq" },
    { from: "prereq", to: "d_prereq" },
    { from: "d_prereq", to: "fee", condition: "ready" },
    { from: "d_prereq", to: "hold_fix", condition: "blocked" },
    { from: "d_prereq", to: "hold_fix", condition: "else" },
    { from: "hold_fix", to: "prereq" },
    { from: "fee", to: "d_fee" },
    { from: "d_fee", to: "pay", condition: "approved" },
    { from: "d_fee", to: "end_declined", condition: "declined" },
    { from: "d_fee", to: "fee", condition: "else" },
    { from: "pay", to: "submit" },
    { from: "submit", to: "record" },
    { from: "record", to: "issue" },
    { from: "issue", to: "handover" },
    { from: "handover", to: "notify" },
    { from: "notify", to: "end_done" },
  ];
  return upsertTemplate("Iqama Renewal", "Iqama", 60, nodes, edges);
}

async function workPermit() {
  console.log("\nWork Permit Renewal");
  const check = await upsertChecklist("Work permit renewal checks", [
    { key: "establishment_active", label: "Establishment active on Qiwa" },
    { key: "nitaqat_ok", label: "Nitaqat band permits the renewal" },
    { key: "iqama_valid", label: "Iqama valid" },
    { key: "contract_authenticated", label: "Contract authenticated" },
  ]);

  const nodes: any[] = [
    { id: "start", type: "start", label: "Renewal Created", config: {} },
    { id: "check", type: "task", label: "Check Establishment and Employee", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Qiwa",
      checklistSource: "dynamic", checklistRuleId: check,
      instructions: "Qiwa refuses a renewal against a blocked establishment or an unauthenticated contract. Confirm all four before the fee is put to the client.",
      captures: [
        { var: "checkOutcome", type: "select", label: "Is it clear to renew?", options: "ready,blocked" },
        { var: "blockReason", type: "text", label: "Anything blocking it?", required: false },
      ],
      rules: [
        { when: { var: "checkOutcome", op: "eq", value: "blocked" }, then: { var: "blockReason", op: "present" },
          message: "Say what is blocking it — \"blocked\" with no reason tells the next officer nothing." },
      ],
    } },
    // The spec gives this one no resolve step of its own, so a block returns to the check rather
    // than to a step the client has never seen.
    { id: "d_check", type: "decision", label: "Clear to Renew?", config: {
      branches: [
        { var: "checkOutcome", op: "eq", value: "ready", key: "ready" },
        { var: "checkOutcome", op: "eq", value: "blocked", key: "blocked" },
      ],
    } },
    feeStep("fee", "Confirm Fee and Client Approval", [
      { var: "feeAmount", type: "number", label: "Government fee (SAR)" },
    ]),
    feeDecision("d_fee"),
    { id: "pay", type: "task", label: "Pay the Fee", config: {
      assigneeRole: "accountant", slaHours: 48,
      captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }],
    } },
    { id: "submit", type: "task", label: "Submit on Qiwa", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Qiwa",
      captures: [
        { var: "qiwaRef", type: "text", label: "Qiwa reference" },
        { var: "submittedOn", type: "date", label: "Date submitted" },
      ],
    } },
    { id: "record", type: "task", label: "Record the Renewed Permit", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "Qiwa",
      captures: [
        { var: "permitNumber", type: "text", label: "Permit number", purpose: "number" },
        { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" },
      ],
    } },
    { id: "issue", type: "issue_document", label: "Work Permit", config: { docType: "Work Permit", numberVar: "permitNumber", expiryVar: "newExpiry" } },
    { id: "notify", type: "notify", label: "Tell the Client", config: {
      channel: "Email", to: "{{ clientEmail }}",
      subject: "A work permit has been renewed",
      template: "The work permit {{ permitNumber }} has been renewed and is valid until {{ newExpiry }}. The permit and the payment receipt are on file in your portal.",
    } },
    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
    { id: "end_declined", type: "end", label: "Not Renewed — Client Declined", config: {} },
  ];

  const edges: any[] = [
    { from: "start", to: "check" },
    { from: "check", to: "d_check" },
    { from: "d_check", to: "fee", condition: "ready" },
    { from: "d_check", to: "check", condition: "blocked" },
    { from: "d_check", to: "check", condition: "else" },
    { from: "fee", to: "d_fee" },
    { from: "d_fee", to: "pay", condition: "approved" },
    { from: "d_fee", to: "end_declined", condition: "declined" },
    { from: "d_fee", to: "fee", condition: "else" },
    { from: "pay", to: "submit" },
    { from: "submit", to: "record" },
    { from: "record", to: "issue" },
    { from: "issue", to: "notify" },
    { from: "notify", to: "end_done" },
  ];
  return upsertTemplate("Work Permit Renewal", "Work Permit", 30, nodes, edges);
}

async function healthInsurance() {
  console.log("\nHealth Insurance Renewal");
  const nodes: any[] = [
    { id: "start", type: "start", label: "Renewal Created", config: {} },
    { id: "cover", type: "task", label: "Confirm Cover Required", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "CCHI",
      instructions: "Cover is mandatory and the class is not ours to choose — confirm with the client what they are renewing onto, and whether dependants are included.",
      captures: [
        { var: "coverClass", type: "text", label: "Class of cover" },
        { var: "dependants", type: "select", label: "Dependants included", options: "yes,no" },
      ],
    } },
    { id: "quote", type: "task", label: "Obtain Quotation", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      instructions: "Get the premium for the confirmed class before it goes to the client. A quotation that arrives after the policy lapses is worth nothing.",
      captures: [
        { var: "insurer", type: "text", label: "Insurer" },
        { var: "premium", type: "number", label: "Premium (SAR)" },
      ],
    } },
    feeStep("approval", "Client Approval"),
    feeDecision("d_approval"),
    { id: "pay", type: "task", label: "Pay the Premium", config: {
      assigneeRole: "accountant", slaHours: 48,
      captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }],
    } },
    { id: "record", type: "task", label: "Record the Policy", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "CCHI",
      captures: [
        { var: "policyNumber", type: "text", label: "Policy number", purpose: "number" },
        { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" },
      ],
    } },
    { id: "issue", type: "issue_document", label: "Health Insurance", config: { docType: "Health Insurance", numberVar: "policyNumber", expiryVar: "newExpiry" } },
    { id: "notify", type: "notify", label: "Tell the Client", config: {
      channel: "Email", to: "{{ clientEmail }}",
      subject: "A health insurance policy has been renewed",
      template: "The health insurance policy {{ policyNumber }} has been renewed with {{ insurer }} and is valid until {{ newExpiry }}. The policy and the payment receipt are on file in your portal.",
    } },
    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
    { id: "end_declined", type: "end", label: "Not Renewed — Client Declined", config: {} },
  ];

  const edges: any[] = [
    { from: "start", to: "cover" },
    { from: "cover", to: "quote" },
    { from: "quote", to: "approval" },
    { from: "approval", to: "d_approval" },
    { from: "d_approval", to: "pay", condition: "approved" },
    { from: "d_approval", to: "end_declined", condition: "declined" },
    { from: "d_approval", to: "approval", condition: "else" },
    { from: "pay", to: "record" },
    { from: "record", to: "issue" },
    { from: "issue", to: "notify" },
    { from: "notify", to: "end_done" },
  ];
  return upsertTemplate("Health Insurance Renewal", "Health Insurance", 30, nodes, edges);
}

async function main() {
  await iqama();
  await workPermit();
  await healthInsurance();
  console.log("\nAll three are DRAFTS. Activating them arms the nightly job against real employee documents.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
