/**
 * The rest of the handbook: seventeen services, built from docs/planned-services.js.
 *
 * WHY A BUILDER RATHER THAN SEVENTEEN GRAPHS. add-misa-renewal.ts was hand-written and shipped with
 * branches missing their `op`, which reads perfectly well and matches nothing — every decision fell
 * to "else" and the run bounced between two steps twenty times. Written out seventeen more times by
 * hand, one such slip lands in all of them at once. So the graphs are generated from a description
 * that cannot express a branch without an operator, and the probe walks what comes out.
 *
 * WHAT IS NOT HERE, AND WHY. Three of the twenty remaining cannot be built by writing a graph:
 *
 *   VAT Return Filing        needs a recurring trigger, and client approval from the portal
 *   Payroll / WPS (Mudad)    needs a recurring trigger
 *   Vehicle Services (Tamm)  needs a vehicle record — nothing in the system models a vehicle
 *
 * The engine has four triggers — manual, document_expiry, request_intake, quotation_accepted — and
 * none of them is a calendar. Adding one clears the first two. They are left out rather than faked.
 *
 * THE ONE PLACE EVERY SPEC HAD TO BE FILLED IN. The specs record outcomes — "Client decision",
 * "Anything blocking it", "Outcome (approved / refused)" — and then list the next step, with nothing
 * routing on the answer. Built literally that is a set of workflows which ask a question, write down
 * the answer, and carry on regardless: a client who declines is still charged, a blocked check still
 * proceeds. A recorded answer that nothing reads is the defect class this codebase has been burned
 * by before, so every recorded outcome here is wired to a branch. That adds no judgement the specs
 * do not already ask an officer to make — it only makes the answers count.
 *
 * All seventeen are DRAFTS. Activating a workflow arms the nightly job or opens it to intake, and
 * that is the user's call rather than a script's.
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── the small declarative layer ───────────────────────────────────────────────────────────────

type Cap = { var: string; type: "text" | "number" | "date" | "select"; label: string; options?: string; required?: boolean; purpose?: string };
type Branch = { var: string; arms: [string, string][]; else: string }; // [value, targetNodeId][]
type Step = {
  id: string; label: string; role: "pro_officer" | "accountant" | "hr_officer"; sla: number;
  gov?: string; instructions?: string;
  checklist?: { name: string; items: [string, string, boolean?][] };
  captures?: Cap[];
  issue?: { docType: string; numberVar: string; expiryVar?: string };
  branch?: Branch;   // a decision node is generated after this step
  next?: string;     // override the linear successor
};

async function upsertAuthority(name: string, sub: string, color = "#5B21B6", bg = "#F5EEFF") {
  const found = await prisma.govCenter.findFirst({ where: { name, country: COUNTRY } });
  if (found) return;
  await prisma.govCenter.create({ data: { name, sub, country: COUNTRY, color, bg, packKey: `sa.authority.${slug(name)}` } as any });
  console.log(`  + authority ${name} (${sub})`);
}

async function upsertDocType(name: string, subjectKind: "company" | "employee", authority: string, leadDays: number) {
  const found = await prisma.documentType.findFirst({ where: { name } });
  const data = { name, country: COUNTRY, subjectKind, authority, leadDays, neverExpires: false, requiresApproval: false, packKey: `sa.doctype.${slug(name)}` };
  if (found) await prisma.documentType.update({ where: { id: found.id }, data: data as any });
  else { await prisma.documentType.create({ data: data as any }); console.log(`  + document type ${name} (${subjectKind}, ${authority}, lead ${leadDays}d)`); }
}

async function upsertChecklist(name: string, items: [string, string, boolean?][]) {
  const packKey = `sa.checklist.${slug(name)}`;
  const rows = [{ conditions: [], documents: items.map(([key, label, optional]) => ({ key, label, source: "manual", required: optional !== true })) }];
  const found = await prisma.checklistRule.findFirst({ where: { OR: [{ packKey }, { name, country: COUNTRY }] } });
  const rule = found
    ? await prisma.checklistRule.update({ where: { id: found.id }, data: { name, country: COUNTRY, packKey, rows: rows as any, retired: false } })
    : await prisma.checklistRule.create({ data: { name, country: COUNTRY, packKey, rows: rows as any } });
  return rule.id;
}

/**
 * Turn a list of steps into a graph.
 *
 * Steps run in the order given unless a step names a `next` or carries a `branch`. A branch becomes
 * its own decision node, and EVERY arm carries `op: "eq"` explicitly — evalDecision's default arm is
 * ok = false, so a branch without an operator matches nothing and falls to "else" every time. That
 * is not something a caller here can forget, which is the entire point of generating these.
 */
async function build(opts: {
  name: string; entity: "company" | "employee"; trigger: "manual" | "document_expiry";
  docType?: string; leadDays?: number; steps: Step[]; notify?: { subject: string; template: string };
}) {
  const nodes: any[] = [{ id: "start", type: "start", label: "Started", config: {} }];
  const edges: any[] = [];
  const ids = opts.steps.map(s => s.id);

  for (let i = 0; i < opts.steps.length; i++) {
    const s = opts.steps[i];
    const cfg: any = { assigneeRole: s.role, slaHours: s.sla };
    if (s.gov) cfg.govCenter = s.gov;
    if (s.instructions) cfg.instructions = s.instructions;
    if (s.captures?.length) cfg.captures = s.captures;
    if (s.checklist) { cfg.checklistSource = "dynamic"; cfg.checklistRuleId = await upsertChecklist(s.checklist.name, s.checklist.items); }
    nodes.push({ id: s.id, type: "task", label: s.label, config: cfg });

    // an issue_document node hangs off the step that recorded the number
    let tail = s.id;
    if (s.issue) {
      const iid = `${s.id}_issue`;
      nodes.push({ id: iid, type: "issue_document", label: s.issue.docType, config: { docType: s.issue.docType, numberVar: s.issue.numberVar, expiryVar: s.issue.expiryVar } });
      edges.push({ from: s.id, to: iid });
      tail = iid;
    }

    const fallthrough = s.next ?? ids[i + 1] ?? "_finish";
    if (s.branch) {
      const did = `d_${s.id}`;
      nodes.push({ id: did, type: "decision", label: `${s.label}?`, config: {
        branches: s.branch.arms.map(([value]) => ({ var: s.branch!.var, op: "eq", value, key: value })),
      } });
      edges.push({ from: tail, to: did });
      for (const [value, target] of s.branch.arms) edges.push({ from: did, to: target === "_next" ? fallthrough : target, condition: value });
      edges.push({ from: did, to: s.branch.else === "_next" ? fallthrough : s.branch.else, condition: "else" });
    } else {
      edges.push({ from: tail, to: fallthrough });
    }
  }

  if (opts.notify) {
    nodes.push({ id: "notify", type: "notify", label: "Tell the Client", config: { channel: "Email", to: "{{ clientEmail }}", subject: opts.notify.subject, template: opts.notify.template } });
    edges.push({ from: "notify", to: "end_done" });
  }
  nodes.push({ id: "end_done", type: "end", label: "Complete", config: {} });
  // Only if something actually routes to it. Emitting it unconditionally left nine workflows
  // carrying an ending nobody could reach — harmless at runtime, but an unreachable node is exactly
  // what the structural check exists to catch, and a graph should not ship its own false positive.
  if (edges.some(e => e.to === "end_stopped")) nodes.push({ id: "end_stopped", type: "end", label: "Not Proceeding", config: {} });
  edges.push({ from: "start", to: ids[0] });
  // "_finish" is the linear tail: through the notification if there is one, else straight to the end.
  for (const e of edges) if (e.to === "_finish") e.to = opts.notify ? "notify" : "end_done";

  const existing = await prisma.workflowTemplate.findFirst({ where: { name: opts.name } });
  const data: any = {
    name: opts.name, country: COUNTRY, entityType: opts.entity, trigger: opts.trigger,
    triggerConfig: opts.trigger === "document_expiry" ? ({ docType: opts.docType, days: opts.leadDays } as any) : null,
    graph: { nodes, edges } as any, packKey: `sa.workflow.${slug(opts.name)}`, active: false,
  };
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data })
    : await prisma.workflowTemplate.create({ data: { ...data, createdAt: new Date().toISOString() } });
  console.log(`  ${existing ? "updated" : "created"} ${opts.name.padEnd(42)} ${String(nodes.length).padStart(2)} nodes, ${String(edges.length).padStart(2)} edges  [draft]`);
  return tpl.id;
}

// ── shared shapes ─────────────────────────────────────────────────────────────────────────────

/** Confirm a cost with the client and record their answer. Declining must end the run. */
const feeCaptures = (extra: Cap[] = []): Cap[] => ([
  ...extra,
  { var: "clientApproval", type: "select", label: "Client decision", options: "approved,declined" },
  { var: "approvedBy", type: "text", label: "Who approved it, at the client", required: false },
]);
const FEE_INSTR = "Put the cost to the client and record their answer here. Nothing is paid until this step says approved.";

// ── the seventeen ─────────────────────────────────────────────────────────────────────────────

async function companyCompliance() {
  console.log("\nCOMPANY COMPLIANCE");
  await upsertAuthority("Chamber", "Chamber of Commerce", "#0369A1", "#E4F4FD");
  await upsertAuthority("SPL", "Saudi Post — National Address", "#7C2D12", "#FEF3E2");
  await upsertAuthority("Bank", "Corporate banking", "#166534", "#E7F8EF");
  await upsertAuthority("Fasah", "Customs single window", "#4338CA", "#EEF0FF");
  await upsertDocType("Chamber Membership", "company", "Chamber", 30);
  await upsertDocType("GOSI Establishment Certificate", "company", "GOSI", 30);
  await upsertDocType("National Address Certificate", "company", "SPL", 30);
  await upsertDocType("Bank Account Confirmation", "company", "Bank", 30);
  await upsertDocType("Customs Declaration", "company", "Fasah", 30);

  await build({
    name: "Chamber of Commerce Membership Renewal", entity: "company", trigger: "document_expiry",
    docType: "Chamber Membership", leadDays: 30,
    notify: { subject: "Your chamber membership has been renewed", template: "The chamber membership {{ newMembershipNo }} has been renewed and is valid until {{ newExpiry }}. The certificate and the receipt are on file in your portal." },
    steps: [
      { id: "verify", label: "Verify CR and Membership", role: "pro_officer", sla: 24, gov: "Chamber",
        checklist: { name: "Chamber renewal checks", items: [["cr_valid", "CR valid and matching"], ["cert_current", "Current membership certificate"], ["category_correct", "Membership category correct"]] },
        captures: [{ var: "membershipNo", type: "text", label: "Membership number" }, { var: "currentExpiry", type: "date", label: "Current expiry" }] },
      { id: "fee", label: "Confirm Category and Fee", role: "pro_officer", sla: 24, instructions: FEE_INSTR,
        captures: feeCaptures([{ var: "category", type: "text", label: "Membership category" }, { var: "subscriptionFee", type: "number", label: "Subscription fee (SAR)" }]),
        branch: { var: "clientApproval", arms: [["approved", "_next"], ["declined", "end_stopped"]], else: "fee" } },
      { id: "submit", label: "Submit Renewal and Confirm by OTP", role: "pro_officer", sla: 24, gov: "Chamber",
        instructions: "The chamber confirms by one-time code to the authorised signatory. If the code does not arrive, the number on file is wrong — fix it before retrying.",
        captures: [{ var: "chamberRef", type: "text", label: "Chamber reference" }, { var: "otpConfirmed", type: "select", label: "OTP confirmed", options: "yes,no" }],
        branch: { var: "otpConfirmed", arms: [["yes", "_next"], ["no", "submit"]], else: "submit" } },
      { id: "pay", label: "Pay the SADAD Invoice", role: "accountant", sla: 48,
        captures: [{ var: "sadadBill", type: "text", label: "SADAD bill number" }, { var: "amountPaid", type: "number", label: "Amount paid" }, { var: "paidOn", type: "date", label: "Date paid" }] },
      { id: "download", label: "Download the Certificate", role: "pro_officer", sla: 24, gov: "Chamber",
        captures: [{ var: "newMembershipNo", type: "text", label: "New membership number", purpose: "number" }, { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" }],
        issue: { docType: "Chamber Membership", numberVar: "newMembershipNo", expiryVar: "newExpiry" } },
    ],
  });

  await build({
    name: "GOSI Establishment Registration / Update", entity: "company", trigger: "manual",
    steps: [
      { id: "verify", label: "Verify Establishment Details", role: "pro_officer", sla: 24, gov: "GOSI",
        checklist: { name: "GOSI establishment documents", items: [["cr_copy", "CR copy"], ["national_address", "National address"], ["signatory_id", "Authorised signatory ID"], ["bank_iban", "Bank IBAN letter"]] },
        captures: [{ var: "gosiEstNo", type: "text", label: "GOSI establishment number" }, { var: "branchCount", type: "number", label: "Branch count" }] },
      { id: "contrib", label: "Check Outstanding Contributions", role: "pro_officer", sla: 24, gov: "GOSI",
        instructions: "GOSI will not process a change while contributions are outstanding. Establish the position before submitting anything.",
        captures: [{ var: "outstanding", type: "number", label: "Any amount outstanding (SAR)" }, { var: "cleared", type: "select", label: "Cleared?", options: "yes,no" }],
        branch: { var: "cleared", arms: [["yes", "submit"], ["no", "settle"]], else: "settle" } },
      { id: "settle", label: "Settle Outstanding Amount", role: "accountant", sla: 72,
        captures: [{ var: "settlementRef", type: "text", label: "Payment reference" }], next: "contrib" },
      { id: "submit", label: "Submit Registration / Update", role: "pro_officer", sla: 48, gov: "GOSI",
        captures: [{ var: "gosiRef", type: "text", label: "GOSI reference number" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "download", label: "Download GOSI Certificate", role: "pro_officer", sla: 24, gov: "GOSI",
        captures: [{ var: "certNumber", type: "text", label: "Certificate number", purpose: "number" }, { var: "issueDate", type: "date", label: "Issue date" }],
        issue: { docType: "GOSI Establishment Certificate", numberVar: "certNumber" } },
    ],
  });

  await build({
    name: "National Address (SPL)", entity: "company", trigger: "manual",
    steps: [
      { id: "collect", label: "Collect Address Details", role: "pro_officer", sla: 48,
        checklist: { name: "National address documents", items: [["lease", "Lease or title deed"], ["photo", "Building photo if required", true]] },
        captures: [{ var: "buildingNo", type: "text", label: "Building number" }, { var: "street", type: "text", label: "Street" }, { var: "district", type: "text", label: "District" }, { var: "city", type: "text", label: "City" }, { var: "postalCode", type: "text", label: "Postal code" }, { var: "additionalNo", type: "text", label: "Additional number" }] },
      { id: "verify", label: "Verify Against the Portal", role: "pro_officer", sla: 24, gov: "SPL",
        captures: [{ var: "matches", type: "select", label: "Matches the portal?", options: "yes,no" }, { var: "differs", type: "text", label: "What differs", required: false }],
        branch: { var: "matches", arms: [["yes", "download"], ["no", "register"]], else: "register" } },
      { id: "register", label: "Register or Update the Address", role: "pro_officer", sla: 48, gov: "SPL",
        captures: [{ var: "splRef", type: "text", label: "SPL reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "download", label: "Download the Address Certificate", role: "pro_officer", sla: 24, gov: "SPL",
        captures: [{ var: "certRef", type: "text", label: "Certificate reference", purpose: "number" }, { var: "issueDate", type: "date", label: "Issue date" }],
        issue: { docType: "National Address Certificate", numberVar: "certRef" } },
    ],
  });

  await build({
    name: "CR Amendment", entity: "company", trigger: "manual",
    notify: { subject: "Your commercial registration has been amended", template: "The amendment to commercial registration {{ crNumber }} is complete. The updated register and the receipt are on file in your portal." },
    steps: [
      { id: "confirm", label: "Confirm What Is Changing", role: "pro_officer", sla: 24, gov: "MC",
        captures: [{ var: "amendField", type: "select", label: "What is being amended", options: "name,activity,capital,address,manager,partners" }, { var: "newValue", type: "text", label: "New value" }, { var: "reason", type: "text", label: "Reason" }] },
      { id: "docs", label: "Collect Supporting Documents", role: "pro_officer", sla: 120,
        checklist: { name: "CR amendment documents", items: [["resolution", "Board or partner resolution"], ["articles", "Amended articles if applicable", true], ["signatory_id", "Authorised signatory ID"], ["reg_licence", "Supporting licence if the activity is regulated", true]] } },
      { id: "consequences", label: "Check Consequences", role: "pro_officer", sla: 48,
        instructions: "An amendment the CR accepts can still break something downstream. Establish what else has to change, or approve first, before the fee is put to the client.",
        checklist: { name: "CR amendment consequences", items: [["misa_permits", "MISA licence permits the change"], ["municipal_permits", "Municipal licence permits the change"], ["nitaqat_effect", "Nitaqat effect understood"]] },
        captures: [{ var: "priorApproval", type: "text", label: "Any approval needed first", required: false }] },
      { id: "fee", label: "Confirm Fee and Client Approval", role: "pro_officer", sla: 48, instructions: FEE_INSTR,
        captures: feeCaptures([{ var: "mcFee", type: "number", label: "MC fee (SAR)" }]),
        branch: { var: "clientApproval", arms: [["approved", "_next"], ["declined", "end_stopped"]], else: "fee" } },
      { id: "pay", label: "Pay and Submit", role: "accountant", sla: 48, gov: "MC",
        captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }, { var: "mcRef", type: "text", label: "MC reference" }] },
      { id: "record", label: "Record the Amended CR", role: "pro_officer", sla: 24, gov: "MC",
        captures: [{ var: "crNumber", type: "text", label: "CR number", purpose: "number" }, { var: "amendConfirmed", type: "text", label: "Amended field confirmed" }, { var: "newExpiry", type: "date", label: "New expiry if changed", required: false, purpose: "expiry" }],
        issue: { docType: "Commercial Registration", numberVar: "crNumber", expiryVar: "newExpiry" } },
      { id: "cascade", label: "Cascade the Change", role: "pro_officer", sla: 120,
        instructions: "Every register carrying the old value now disagrees with the CR. Left alone they contradict it, and the next filing inherits the mismatch.",
        checklist: { name: "CR amendment cascade", items: [["chamber", "Chamber record"], ["gosi", "GOSI establishment"], ["qiwa", "Qiwa establishment"], ["vat", "VAT registration"], ["bank", "Bank mandate"], ["misa", "MISA licence"]] } },
    ],
  });

  await build({
    name: "CR Cancellation", entity: "company", trigger: "manual",
    steps: [
      { id: "instruction", label: "Confirm the Instruction", role: "pro_officer", sla: 48,
        instructions: "Closing a register is not reversible. Record who asked for it and when before anything else happens.",
        captures: [{ var: "instructedBy", type: "text", label: "Who instructed it" }, { var: "instructedOn", type: "date", label: "Date instructed" }, { var: "reason", type: "text", label: "Reason" }] },
      { id: "clearance", label: "Clearance Check", role: "pro_officer", sla: 120, gov: "MC",
        checklist: { name: "CR cancellation clearance", items: [["employees", "All employees exited or transferred"], ["gosi", "GOSI cleared and closed"], ["zatca", "ZATCA / Zakat cleared"], ["violations", "No open government violations"], ["chamber", "Chamber settled"], ["bank", "Bank accounts settled"]] },
        captures: [{ var: "outstanding", type: "select", label: "Anything outstanding?", options: "no,yes" }, { var: "outstandingWhat", type: "text", label: "What is outstanding", required: false }],
        branch: { var: "outstanding", arms: [["no", "owner"], ["yes", "resolve"]], else: "resolve" } },
      { id: "resolve", label: "Resolve Outstanding Items", role: "pro_officer", sla: 360,
        captures: [{ var: "resolved", type: "text", label: "What was cleared" }], next: "clearance" },
      { id: "owner", label: "Owner Confirmation", role: "hr_officer", sla: 72,
        instructions: "The last chance to stop. Confirm with the owner in person that the register is to be closed.",
        captures: [{ var: "confirmedBy", type: "text", label: "Confirmed by" }, { var: "confirmedOn", type: "date", label: "Date" }] },
      { id: "submit", label: "Submit Cancellation", role: "pro_officer", sla: 48, gov: "MC",
        captures: [{ var: "mcRef", type: "text", label: "MC reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "record", label: "Record the Cancellation", role: "pro_officer", sla: 24, gov: "MC",
        captures: [{ var: "cancellationCert", type: "text", label: "Cancellation certificate number" }, { var: "effectiveDate", type: "date", label: "Effective date" }] },
    ],
  });

  await build({
    name: "Corporate Bank Account Opening", entity: "company", trigger: "manual",
    notify: { subject: "Your corporate bank account is open", template: "The account {{ accountNumber }} ({{ iban }}) is open at {{ branch }}. The confirmation is on file in your portal." },
    steps: [
      { id: "pack", label: "Collect the Application Pack", role: "pro_officer", sla: 120,
        checklist: { name: "Bank account application pack", items: [["cr", "CR copy"], ["articles", "Articles of association"], ["chamber", "Chamber certificate"], ["address", "National address certificate"], ["vat", "VAT certificate"], ["signatory_ids", "Authorised signatory IDs"], ["resolution", "Board resolution to open the account"], ["shareholders", "Shareholder register"]] } },
      { id: "signatories", label: "Verify Signatories and Shareholders", role: "pro_officer", sla: 48,
        captures: [{ var: "signatory", type: "text", label: "Authorised signatory" }, { var: "signingLimits", type: "text", label: "Signing limits" }, { var: "shareholdingConfirmed", type: "select", label: "Shareholding confirmed", options: "yes,no" }],
        branch: { var: "shareholdingConfirmed", arms: [["yes", "_next"], ["no", "pack"]], else: "pack" } },
      { id: "review", label: "Prepare and Review the Application", role: "pro_officer", sla: 48,
        captures: [{ var: "clientReviewed", type: "select", label: "Client review complete", options: "yes,no" }, { var: "reviewedBy", type: "text", label: "Who reviewed it" }],
        branch: { var: "clientReviewed", arms: [["yes", "_next"], ["no", "review"]], else: "review" } },
      { id: "submit", label: "Submit to the Bank", role: "pro_officer", sla: 24, gov: "Bank",
        captures: [{ var: "bankRef", type: "text", label: "Bank reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }, { var: "relationshipManager", type: "text", label: "Relationship manager" }] },
      { id: "queries", label: "Respond to Bank Queries", role: "pro_officer", sla: 72, gov: "Bank",
        instructions: "Banks query almost every corporate application at least once. This step stays open while it is with them.",
        captures: [{ var: "queryAsked", type: "text", label: "What was asked", required: false }, { var: "queryProvided", type: "text", label: "What was provided", required: false }] },
      { id: "opened", label: "Account Opened", role: "pro_officer", sla: 24, gov: "Bank",
        captures: [{ var: "accountNumber", type: "text", label: "Account number", purpose: "number" }, { var: "iban", type: "text", label: "IBAN" }, { var: "branch", type: "text", label: "Branch" }],
        issue: { docType: "Bank Account Confirmation", numberVar: "accountNumber" } },
    ],
  });

  await build({
    name: "Customs Declaration (Fasah)", entity: "company", trigger: "manual",
    steps: [
      { id: "importer", label: "Confirm Importer / Exporter Details", role: "pro_officer", sla: 24, gov: "Fasah",
        checklist: { name: "Customs party checks", items: [["cr_activity", "CR with import/export activity"], ["client_number", "Customs client number"]] },
        captures: [{ var: "direction", type: "select", label: "Direction", options: "import,export" }] },
      { id: "shipment", label: "Collect Shipment Documents", role: "pro_officer", sla: 48,
        checklist: { name: "Customs shipment documents", items: [["invoice", "Commercial invoice"], ["packing", "Packing list"], ["bol", "Bill of lading or airway bill"], ["origin", "Certificate of origin"], ["insurance", "Insurance certificate", true]] },
        captures: [{ var: "shipmentRef", type: "text", label: "Shipment reference" }, { var: "portOfEntry", type: "text", label: "Port of entry" }, { var: "expectedArrival", type: "date", label: "Expected arrival" }] },
      { id: "declare", label: "Prepare and Submit the Declaration", role: "pro_officer", sla: 24, gov: "Fasah",
        captures: [{ var: "declarationNo", type: "text", label: "Declaration number" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "processing", label: "Customs Processing", role: "pro_officer", sla: 120, gov: "Fasah",
        instructions: "Demurrage runs while a shipment sits. This step stays open while it is with customs — record the outcome the moment it lands.",
        captures: [{ var: "customsOutcome", type: "select", label: "Customs outcome", options: "cleared,inspection,query" }, { var: "customsAsked", type: "text", label: "What was asked", required: false }],
        branch: { var: "customsOutcome", arms: [["cleared", "duties"], ["inspection", "processing"], ["query", "shipment"]], else: "processing" } },
      { id: "duties", label: "Pay Duties and Charges", role: "accountant", sla: 24,
        captures: [{ var: "dutyAmount", type: "number", label: "Duty amount (SAR)" }, { var: "paymentRef", type: "text", label: "Payment reference" }] },
      { id: "clearance", label: "Record Clearance", role: "pro_officer", sla: 24, gov: "Fasah",
        captures: [{ var: "clearanceRef", type: "text", label: "Clearance reference", purpose: "number" }, { var: "releaseDate", type: "date", label: "Release date" }],
        issue: { docType: "Customs Declaration", numberVar: "clearanceRef" } },
    ],
  });
}

async function employeeServices() {
  console.log("\nEMPLOYEE SERVICES");
  await upsertAuthority("Insurer", "Insurance provider", "#0F766E", "#ECFDF7");
  await upsertAuthority("Provider", "Healthcare provider", "#BE185D", "#FDF2F8");
  await upsertDocType("Exit / Re-entry Visa", "employee", "Muqeem", 30);
  await upsertDocType("Final Exit Visa", "employee", "Muqeem", 30);
  await upsertDocType("Insurance Policy", "employee", "Insurer", 30);

  await build({
    name: "Qiwa Contract Authentication", entity: "employee", trigger: "manual",
    steps: [
      { id: "prepare", label: "Prepare the Contract", role: "hr_officer", sla: 48,
        checklist: { name: "Contract authentication documents", items: [["offer", "Signed offer letter"], ["jd", "Job description"], ["salary", "Salary breakdown"]] },
        captures: [{ var: "jobTitle", type: "text", label: "Job title" }, { var: "basicSalary", type: "number", label: "Basic salary" }, { var: "allowances", type: "text", label: "Allowances" }, { var: "contractTerm", type: "text", label: "Contract term" }] },
      { id: "upload", label: "Upload to Qiwa", role: "pro_officer", sla: 24, gov: "Qiwa",
        captures: [{ var: "qiwaContractRef", type: "text", label: "Qiwa contract reference" }] },
      { id: "acceptance", label: "Employee Acceptance", role: "pro_officer", sla: 120, gov: "Qiwa",
        instructions: "The employee accepts on Qiwa themselves. Nothing here can accept on their behalf — this step waits.",
        captures: [{ var: "accepted", type: "select", label: "Accepted by employee", options: "yes,no" }, { var: "acceptedOn", type: "date", label: "Date accepted", required: false }],
        branch: { var: "accepted", arms: [["yes", "_next"], ["no", "prepare"]], else: "acceptance" } },
      { id: "record", label: "Record the Authenticated Contract", role: "pro_officer", sla: 24, gov: "Qiwa",
        captures: [{ var: "contractNumber", type: "text", label: "Contract number", purpose: "number" }, { var: "effectiveDate", type: "date", label: "Effective date" }],
        issue: { docType: "Qiwa Employment Contract", numberVar: "contractNumber" } },
    ],
  });

  await build({
    name: "New Employee Work Visa", entity: "employee", trigger: "manual",
    notify: { subject: "A work visa has been issued", template: "The work visa {{ visaNumber }} has been issued and is valid until {{ visaExpiry }}. The authorisation is on file in your portal." },
    steps: [
      { id: "quota", label: "Check Quota and Eligibility", role: "pro_officer", sla: 48, gov: "Qiwa",
        checklist: { name: "Work visa quota checks", items: [["quota", "Visa quota available"], ["nitaqat", "Nitaqat band permits the hire"], ["profession", "Profession open to the nationality"], ["establishment", "Establishment active"]] },
        captures: [{ var: "quotaRemaining", type: "number", label: "Quota remaining" }] },
      { id: "candidate", label: "Candidate Details", role: "pro_officer", sla: 72,
        checklist: { name: "Work visa candidate documents", items: [["passport", "Passport copy valid 6+ months"], ["photo", "Photograph"], ["quals", "Qualification certificates"], ["medical", "Medical fitness certificate"]] },
        captures: [{ var: "fullName", type: "text", label: "Full name as printed in the passport" }, { var: "nationality", type: "text", label: "Nationality" }, { var: "profession", type: "text", label: "Profession" }, { var: "visaType", type: "text", label: "Visa type" }] },
      { id: "submit", label: "Submit the Visa Application", role: "pro_officer", sla: 48, gov: "Qiwa",
        captures: [{ var: "qiwaRef", type: "text", label: "Qiwa reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "pay", label: "Pay the Visa Fee", role: "accountant", sla: 48,
        captures: [{ var: "visaFee", type: "number", label: "Fee (SAR)" }, { var: "paymentRef", type: "text", label: "Payment reference" }] },
      { id: "approval", label: "Government Approval", role: "pro_officer", sla: 240, gov: "MHRSD",
        instructions: "Government response times vary. This step stays open while the application is with them.",
        captures: [{ var: "visaOutcome", type: "select", label: "Outcome", options: "approved,more_information,refused" }, { var: "authorisationNo", type: "text", label: "Visa authorisation number", required: false }],
        branch: { var: "visaOutcome", arms: [["approved", "embassy"], ["more_information", "candidate"], ["refused", "end_stopped"]], else: "approval" } },
      { id: "embassy", label: "Embassy and Stamping", role: "pro_officer", sla: 360, gov: "MOFA",
        checklist: { name: "Embassy stamping documents", items: [["attested", "Attested certificates"], ["medical", "Medical report"], ["police", "Police clearance", true]] },
        captures: [{ var: "embassyRef", type: "text", label: "Embassy reference" }, { var: "visaNumber", type: "text", label: "Visa number" }, { var: "visaExpiry", type: "date", label: "Visa expiry" }] },
      { id: "record", label: "Record the Visa", role: "pro_officer", sla: 24, gov: "MOFA",
        captures: [{ var: "recordVisaNo", type: "text", label: "Visa number", purpose: "number" }, { var: "recordVisaExpiry", type: "date", label: "Expiry date", purpose: "expiry" }],
        issue: { docType: "Work Visa", numberVar: "recordVisaNo", expiryVar: "recordVisaExpiry" } },
      { id: "arrival", label: "Confirm Arrival", role: "pro_officer", sla: 720,
        instructions: "A visa unused by its expiry is wasted, and the quota with it. This step stays open until the employee lands.",
        captures: [{ var: "arrivalDate", type: "date", label: "Date of arrival" }, { var: "portOfEntry", type: "text", label: "Port of entry" }] },
    ],
  });

  await build({
    name: "Exit / Re-entry Visa", entity: "employee", trigger: "manual",
    steps: [
      { id: "eligibility", label: "Check Eligibility", role: "pro_officer", sla: 24, gov: "Muqeem",
        checklist: { name: "Exit re-entry eligibility", items: [["iqama", "Iqama valid for the whole period"], ["passport", "Passport valid"], ["no_ban", "No travel ban or restriction"], ["no_fines", "No outstanding fines"]] },
        captures: [{ var: "blocked", type: "select", label: "Anything blocking it?", options: "no,yes" }, { var: "blockReason", type: "text", label: "What is blocking it", required: false }],
        branch: { var: "blocked", arms: [["no", "_next"], ["yes", "end_stopped"]], else: "end_stopped" } },
      { id: "dates", label: "Confirm Dates and Fee", role: "pro_officer", sla: 24, instructions: FEE_INSTR,
        captures: feeCaptures([{ var: "departureDate", type: "date", label: "Departure date" }, { var: "returnDate", type: "date", label: "Return date" }, { var: "singleMultiple", type: "select", label: "Single or multiple", options: "single,multiple" }, { var: "fee", type: "number", label: "Fee (SAR)" }]),
        branch: { var: "clientApproval", arms: [["approved", "_next"], ["declined", "end_stopped"]], else: "dates" } },
      { id: "issue", label: "Pay and Issue", role: "accountant", sla: 24, gov: "Muqeem",
        captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }, { var: "visaNumber", type: "text", label: "Visa number", purpose: "number" }, { var: "validUntil", type: "date", label: "Valid until", purpose: "expiry" }],
        issue: { docType: "Exit / Re-entry Visa", numberVar: "visaNumber", expiryVar: "validUntil" } },
      { id: "handover", label: "Give the Employee the Visa", role: "pro_officer", sla: 24,
        captures: [{ var: "handedTo", type: "text", label: "Handed over to" }, { var: "handedOn", type: "date", label: "Date" }] },
    ],
  });

  await build({
    name: "Final Exit", entity: "employee", trigger: "manual",
    steps: [
      { id: "clearance", label: "Clearance Check", role: "hr_officer", sla: 120,
        checklist: { name: "Final exit clearance", items: [["letter", "Resignation or termination letter"], ["property", "Company property returned"], ["loans", "Loans and advances settled"], ["gosi", "GOSI contributions up to date"], ["fines", "No outstanding fines"]] },
        captures: [{ var: "outstanding", type: "select", label: "Anything outstanding?", options: "no,yes" }, { var: "outstandingWhat", type: "text", label: "What is outstanding", required: false }],
        branch: { var: "outstanding", arms: [["no", "_next"], ["yes", "clearance"]], else: "clearance" } },
      { id: "settlement", label: "Final Settlement", role: "accountant", sla: 120,
        instructions: "End of service is a statutory entitlement, not a discretionary payment. Calculate it before the employee is asked to acknowledge anything.",
        captures: [{ var: "eosb", type: "number", label: "End of service benefit (SAR)" }, { var: "outstandingSalary", type: "number", label: "Outstanding salary" }, { var: "deductions", type: "number", label: "Deductions" }, { var: "netPayable", type: "number", label: "Net payable" }] },
      { id: "acknowledge", label: "Employee Acknowledgement", role: "hr_officer", sla: 72,
        captures: [{ var: "acknowledged", type: "select", label: "Acknowledged by employee", options: "yes,no" }, { var: "acknowledgedOn", type: "date", label: "Date", required: false }],
        branch: { var: "acknowledged", arms: [["yes", "_next"], ["no", "settlement"]], else: "acknowledge" } },
      { id: "cancel", label: "Cancel Work Permit and Contract", role: "pro_officer", sla: 48, gov: "Qiwa",
        captures: [{ var: "qiwaRef", type: "text", label: "Qiwa reference" }] },
      { id: "issue", label: "Issue the Final Exit Visa", role: "pro_officer", sla: 48, gov: "Muqeem",
        captures: [{ var: "visaNumber", type: "text", label: "Visa number", purpose: "number" }, { var: "validUntil", type: "date", label: "Valid until", purpose: "expiry" }],
        issue: { docType: "Final Exit Visa", numberVar: "visaNumber", expiryVar: "validUntil" } },
      { id: "departure", label: "Confirm Departure", role: "pro_officer", sla: 720, gov: "Muqeem",
        instructions: "An unconfirmed departure leaves the employee on the establishment file and the sponsor liable. This closes only when Muqeem shows them gone.",
        captures: [{ var: "departureDate", type: "date", label: "Date of departure" }, { var: "confirmedOnMuqeem", type: "select", label: "Confirmed on Muqeem", options: "yes,no" }],
        branch: { var: "confirmedOnMuqeem", arms: [["yes", "_next"], ["no", "departure"]], else: "departure" } },
    ],
  });

  await build({
    name: "Profession Change", entity: "employee", trigger: "manual",
    steps: [
      { id: "confirm", label: "Confirm the Change", role: "pro_officer", sla: 24, gov: "Qiwa",
        captures: [{ var: "currentProfession", type: "text", label: "Current profession" }, { var: "requestedProfession", type: "text", label: "Requested profession" }, { var: "reason", type: "text", label: "Reason" }] },
      { id: "eligibility", label: "Eligibility Check", role: "pro_officer", sla: 48, gov: "Qiwa",
        checklist: { name: "Profession change eligibility", items: [["establishment", "Establishment active and licensed"], ["nitaqat", "Nitaqat band permits the change"], ["profession_open", "Profession open to the nationality"], ["certificate", "Professional certificate held where required"], ["iqama_contract", "Iqama and contract current"]] },
        captures: [{ var: "blocked", type: "select", label: "Anything blocking it?", options: "no,yes" }, { var: "blockReason", type: "text", label: "What is blocking it", required: false }],
        branch: { var: "blocked", arms: [["no", "_next"], ["yes", "end_stopped"]], else: "end_stopped" } },
      { id: "certificates", label: "Collect Supporting Certificates", role: "pro_officer", sla: 120,
        checklist: { name: "Profession change certificates", items: [["attested", "Attested qualification certificate"], ["accreditation", "Professional accreditation", true], ["experience", "Experience letters", true]] } },
      { id: "submit", label: "Submit on Qiwa", role: "pro_officer", sla: 48, gov: "Qiwa",
        captures: [{ var: "qiwaRef", type: "text", label: "Qiwa reference" }, { var: "fee", type: "number", label: "Fee (SAR)" }] },
      { id: "employee", label: "Employee Approval", role: "pro_officer", sla: 72, gov: "Qiwa",
        captures: [{ var: "employeeAccepted", type: "select", label: "Accepted by employee", options: "yes,no" }],
        branch: { var: "employeeAccepted", arms: [["yes", "_next"], ["no", "end_stopped"]], else: "employee" } },
      { id: "processing", label: "Government Processing", role: "pro_officer", sla: 168, gov: "MHRSD",
        captures: [{ var: "outcome", type: "select", label: "Outcome", options: "approved,refused" }, { var: "refusalReason", type: "text", label: "Reason if refused", required: false }],
        branch: { var: "outcome", arms: [["approved", "_next"], ["refused", "end_stopped"]], else: "processing" } },
      { id: "update", label: "Update the Employee Record", role: "pro_officer", sla: 24,
        checklist: { name: "Profession change follow-up", items: [["iqama", "Iqama shows the new profession"], ["qiwa", "Qiwa contract updated"], ["gosi", "GOSI record updated"]] },
        captures: [{ var: "newProfession", type: "text", label: "New profession confirmed" }] },
    ],
  });

  await build({
    name: "Employee Transfer (Sponsorship)", entity: "employee", trigger: "manual",
    steps: [
      { id: "eligibility", label: "Check Transfer Eligibility", role: "pro_officer", sla: 48, gov: "Qiwa",
        checklist: { name: "Sponsorship transfer eligibility", items: [["contract", "Current employer contract details"], ["nitaqat", "Nitaqat band permits the transfer"], ["fines", "No outstanding fines on either party"], ["consent", "Employee consent recorded"]] },
        captures: [{ var: "blocked", type: "select", label: "Anything blocking it?", options: "no,yes" }, { var: "blockReason", type: "text", label: "What is blocking it", required: false }],
        branch: { var: "blocked", arms: [["no", "_next"], ["yes", "end_stopped"]], else: "end_stopped" } },
      { id: "request", label: "Raise the Transfer Request", role: "pro_officer", sla: 48, gov: "Qiwa",
        captures: [{ var: "qiwaRequestNo", type: "text", label: "Qiwa request number" }, { var: "raisedOn", type: "date", label: "Date raised" }] },
      { id: "response", label: "Previous Employer Response", role: "pro_officer", sla: 240, gov: "Qiwa",
        instructions: "The previous employer has a statutory window to object. A lapsed window counts as consent — record which of the three actually happened.",
        captures: [{ var: "transferOutcome", type: "select", label: "Outcome", options: "approved,rejected,lapsed" }, { var: "rejectReason", type: "text", label: "Reason if rejected", required: false }],
        branch: { var: "transferOutcome", arms: [["approved", "pay"], ["lapsed", "pay"], ["rejected", "end_stopped"]], else: "response" } },
      { id: "pay", label: "Pay the Transfer Fee", role: "accountant", sla: 48,
        captures: [{ var: "fee", type: "number", label: "Fee (SAR)" }, { var: "paymentRef", type: "text", label: "Payment reference" }] },
      { id: "complete", label: "Complete the Sponsorship Transfer", role: "pro_officer", sla: 120, gov: "Qiwa",
        checklist: { name: "Sponsorship transfer completion", items: [["iqama_sponsor", "Iqama sponsor updated"], ["contract", "New contract authenticated"], ["gosi", "GOSI record moved"]] },
        captures: [{ var: "iqamaNumber", type: "text", label: "Iqama number", purpose: "number" }, { var: "effectiveDate", type: "date", label: "Transfer effective date" }, { var: "iqamaExpiry", type: "date", label: "Iqama expiry", purpose: "expiry" }],
        issue: { docType: "Iqama", numberVar: "iqamaNumber", expiryVar: "iqamaExpiry" } },
    ],
  });

  await build({
    name: "GOSI Employee Registration / Update", entity: "employee", trigger: "manual",
    steps: [
      { id: "details", label: "Confirm Employee Details", role: "pro_officer", sla: 24, gov: "GOSI",
        checklist: { name: "GOSI employee documents", items: [["id", "Iqama or national ID copy"], ["contract", "Signed contract"]] },
        captures: [{ var: "joiningDate", type: "date", label: "Date of joining" }, { var: "basicWage", type: "number", label: "Basic wage" }, { var: "housing", type: "number", label: "Housing allowance" }, { var: "occupation", type: "text", label: "Occupation" }] },
      { id: "existing", label: "Check Eligibility and Existing Record", role: "pro_officer", sla: 24, gov: "GOSI",
        instructions: "An employee already registered elsewhere is an update, not a registration. Getting this wrong creates a duplicate contribution record that is slow to unpick.",
        captures: [{ var: "alreadyRegistered", type: "select", label: "Already registered elsewhere?", options: "no,yes" }, { var: "existingGosiNo", type: "text", label: "GOSI number if held", required: false }] },
      { id: "submit", label: "Submit Registration or Update", role: "pro_officer", sla: 48, gov: "GOSI",
        captures: [{ var: "gosiRef", type: "text", label: "GOSI reference" }, { var: "submittedOn", type: "date", label: "Date submitted" }] },
      { id: "record", label: "Record the Registration", role: "pro_officer", sla: 24, gov: "GOSI",
        captures: [{ var: "gosiNumber", type: "text", label: "GOSI number", purpose: "number" }, { var: "effectiveDate", type: "date", label: "Effective date" }],
        issue: { docType: "GOSI Employee Registration", numberVar: "gosiNumber" } },
    ],
  });

  await build({
    name: "Termination and Final Settlement", entity: "employee", trigger: "manual",
    steps: [
      { id: "instruction", label: "Record the Instruction", role: "hr_officer", sla: 24,
        checklist: { name: "Termination documents", items: [["letter", "Resignation or termination letter"], ["notice", "Notice period confirmation"]] },
        captures: [{ var: "type", type: "select", label: "Type", options: "resignation,termination,end_of_contract" }, { var: "lastWorkingDay", type: "date", label: "Last working day" }, { var: "reason", type: "text", label: "Reason" }] },
      { id: "calculate", label: "Calculate the Settlement", role: "accountant", sla: 120,
        instructions: "End of service is a statutory entitlement calculated from years of service, not a discretionary figure.",
        captures: [{ var: "yearsOfService", type: "number", label: "Years of service" }, { var: "eosb", type: "number", label: "End of service benefit (SAR)" }, { var: "unusedLeave", type: "number", label: "Unused leave" }, { var: "deductions", type: "number", label: "Deductions" }, { var: "netPayable", type: "number", label: "Net payable" }] },
      { id: "approval", label: "Manager Approval", role: "hr_officer", sla: 72,
        captures: [{ var: "approvedBy", type: "text", label: "Approved by" }, { var: "approvedOn", type: "date", label: "Date" }] },
      { id: "acknowledge", label: "Employee Acknowledgement", role: "hr_officer", sla: 72,
        captures: [{ var: "acknowledged", type: "select", label: "Acknowledged", options: "yes,no" }, { var: "acknowledgedOn", type: "date", label: "Date", required: false }],
        branch: { var: "acknowledged", arms: [["yes", "_next"], ["no", "calculate"]], else: "acknowledge" } },
      { id: "pay", label: "Pay the Settlement", role: "accountant", sla: 120,
        captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }, { var: "paidOn", type: "date", label: "Date paid" }] },
      { id: "close", label: "Close the Employee Record", role: "hr_officer", sla: 48,
        checklist: { name: "Employee record closure", items: [["property", "Company property returned"], ["access", "Access and accounts revoked"], ["payroll", "Payroll stopped"]] },
        captures: [{ var: "closedOn", type: "date", label: "Record closed on" }] },
    ],
  });

  await build({
    name: "Employee Insurance Assistance", entity: "employee", trigger: "document_expiry",
    docType: "Insurance Policy", leadDays: 30,
    steps: [
      { id: "needed", label: "Confirm What Is Needed", role: "pro_officer", sla: 24,
        captures: [{ var: "coverType", type: "text", label: "Type of cover" }, { var: "existingPolicy", type: "text", label: "Existing policy number" }, { var: "currentExpiry", type: "date", label: "Current expiry" }] },
      { id: "quotes", label: "Obtain Quotations", role: "pro_officer", sla: 120, gov: "Insurer",
        captures: [{ var: "insurer", type: "text", label: "Insurer" }, { var: "premium", type: "number", label: "Premium (SAR)" }, { var: "coverLevel", type: "text", label: "Cover level" }] },
      { id: "approval", label: "Client Approval", role: "pro_officer", sla: 72, instructions: FEE_INSTR,
        captures: feeCaptures(),
        branch: { var: "clientApproval", arms: [["approved", "_next"], ["declined", "end_stopped"]], else: "approval" } },
      { id: "issue", label: "Pay and Issue", role: "accountant", sla: 48,
        captures: [{ var: "paymentRef", type: "text", label: "Payment reference" }, { var: "policyNumber", type: "text", label: "Policy number", purpose: "number" }, { var: "newExpiry", type: "date", label: "New expiry", purpose: "expiry" }],
        issue: { docType: "Insurance Policy", numberVar: "policyNumber", expiryVar: "newExpiry" } },
    ],
  });

  await build({
    name: "Employee Medical Assistance", entity: "employee", trigger: "manual",
    steps: [
      { id: "request", label: "Record the Request", role: "pro_officer", sla: 24,
        captures: [{ var: "needed", type: "select", label: "What is needed", options: "appointment,medical_report,fitness_certificate,insurance_coordination" }, { var: "urgency", type: "select", label: "Urgency", options: "routine,urgent" }] },
      { id: "cover", label: "Confirm Insurance Cover", role: "pro_officer", sla: 24, gov: "Insurer",
        checklist: { name: "Medical assistance cover", items: [["card", "Insurance card"], ["in_force", "Policy in force"]] },
        captures: [{ var: "insurer", type: "text", label: "Insurer" }, { var: "coverApplies", type: "select", label: "Cover applies", options: "yes,no" }] },
      { id: "coordinate", label: "Coordinate with the Provider", role: "pro_officer", sla: 72, gov: "Provider",
        captures: [{ var: "provider", type: "text", label: "Provider" }, { var: "appointmentDate", type: "date", label: "Appointment date" }, { var: "reference", type: "text", label: "Reference" }] },
      { id: "collect", label: "Collect the Document", role: "pro_officer", sla: 120,
        checklist: { name: "Medical assistance output", items: [["report", "Medical report or certificate received"]] },
        captures: [{ var: "receivedOn", type: "date", label: "Date received" }] },
      { id: "close", label: "Close the Case", role: "pro_officer", sla: 24,
        captures: [{ var: "outcome", type: "text", label: "Outcome" }, { var: "handedTo", type: "text", label: "Handed to" }] },
    ],
  });
}

async function main() {
  await companyCompliance();
  await employeeServices();
  console.log("\nAll seventeen are DRAFTS.");
  console.log("NOT built — these need engine work, not configuration:");
  console.log("  VAT Return Filing        recurring trigger + client approval from the portal");
  console.log("  Payroll / WPS (Mudad)    recurring trigger");
  console.log("  Vehicle Services (Tamm)  a vehicle record — nothing models a vehicle today");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
