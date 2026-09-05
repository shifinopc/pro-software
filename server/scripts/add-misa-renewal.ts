/**
 * Build the MISA Licence Renewal workflow for the Saudi pack, from the client's own process guide
 * (STIMES_PRO_MISA.docx — "Simple Process Guide", eleven numbered sections plus a ten-row summary).
 *
 * This is the pack's FIRST company-level workflow. Everything in it until now has been about a
 * person — seven document types, all subjectKind "employee". A MISA investment licence belongs to
 * the company, which the engine already understands: for a company-subject type it files against the
 * client name with no employeeId, and supersedes at company level rather than per person.
 *
 * It is also the first workflow nobody starts by hand. `trigger: "document_expiry"` hands it to the
 * nightly job, which finds every MISA licence inside its lead time and opens one run per client,
 * passing `documentId` so the issue step RENEWS the licence — archiving the old number and expiry
 * into its history — instead of leaving the company holding two live licences.
 *
 * TWO PLACES THE CLIENT'S GUIDE MEETS THE SYSTEM AND HAS TO BEND:
 *
 *   Step 5 says "the client reviews and approves the fee". The portal has no route that approves
 *   anything — quotations are read-only there, and no portal action completes a workflow step. So
 *   this is a PRO task that RECORDS the client's decision, with who approved it and when. Modelling
 *   it as an approval node would put a button in front of a person who cannot reach it.
 *
 *   Step 2 lists CR, ZATCA/Zakat, GOSI and Nitaqat as things the officer checks. Three of those are
 *   documents the pack does not carry and one is a fact about the establishment, so they are a
 *   CHECKLIST on a step rather than engine prerequisites. When those document types exist, the
 *   check can move onto the document type's `prereqs` and the renewal will hold itself before it
 *   ever starts — which is the better home for it, but not one that can be faked today.
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const TEMPLATE = "MISA Licence Renewal";
const DOC_TYPE = "MISA Investment Licence";

const slugOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** A checklist rule that travels in the country pack, the same shape the onboarding lists use. */
async function upsertChecklist(name: string, items: { key: string; label: string; required?: boolean }[]) {
  const packKey = `sa.checklist.${slugOf(name)}`;
  const rows = [{ conditions: [], documents: items.map(i => ({ key: i.key, label: i.label, source: "manual", required: i.required !== false })) }];
  const found = await prisma.checklistRule.findFirst({ where: { OR: [{ packKey }, { name, country: COUNTRY }] } });
  const rule = found
    ? await prisma.checklistRule.update({ where: { id: found.id }, data: { name, country: COUNTRY, packKey, rows: rows as any, retired: false } })
    : await prisma.checklistRule.create({ data: { name, country: COUNTRY, packKey, rows: rows as any } });
  console.log(`  ${found ? "updated" : "created"} checklist rule "${name}" (${items.length} items)`);
  return rule.id;
}

async function main() {
  // ── the authority, and the licence itself ───────────────────────────────────────────────────
  const misa = await prisma.govCenter.findFirst({ where: { name: "MISA", country: COUNTRY } });
  if (!misa) {
    await prisma.govCenter.create({ data: { name: "MISA", sub: "Ministry of Investment", country: COUNTRY, color: "#5B21B6", bg: "#F5EEFF", packKey: "sa.authority.misa" } });
    console.log("created authority MISA");
  } else console.log("authority MISA already present");

  const existingType = await prisma.documentType.findFirst({ where: { name: DOC_TYPE } });
  const typeData = {
    name: DOC_TYPE, country: COUNTRY, subjectKind: "company", authority: "MISA",
    // 60 days is when the renewal opens itself. MISA renewals depend on an audited year-end and a
    // clean Zakat position, and a month is not enough time to fix either.
    leadDays: 60, neverExpires: false, requiresApproval: false,
    packKey: "sa.doctype.misa-investment-licence",
  };
  const docType = existingType
    ? await prisma.documentType.update({ where: { id: existingType.id }, data: typeData as any })
    : await prisma.documentType.create({ data: typeData as any });
  console.log(`${existingType ? "updated" : "created"} document type "${DOC_TYPE}" (company-subject, lead ${typeData.leadDays}d)`);

  // ── the three lists, kept in the pack rather than in the graph ───────────────────────────────
  const checkRule = await upsertChecklist("MISA company compliance check", [
    { key: "cr_valid", label: "Commercial Registration is valid and matches the licence" },
    { key: "zakat_valid", label: "Zakat / ZATCA certificate is current" },
    { key: "gosi_valid", label: "GOSI certificate is current, contributions up to date" },
    { key: "nitaqat_band", label: "Saudization band permits government services" },
    { key: "misa_details", label: "MISA licence information is correct" },
  ]);
  const docsRule = await upsertChecklist("MISA renewal documents from client", [
    { key: "current_licence", label: "Current MISA licence" },
    { key: "ownership_changes", label: "Ownership / shareholder changes, if applicable", required: false },
    { key: "signatory_changes", label: "Authorised signatory information, if changed", required: false },
  ]);
  const followUpRule = await upsertChecklist("MISA follow-up registrations", [
    { key: "cr_updated", label: "Commercial Registration updated to match the new licence" },
    { key: "chamber_updated", label: "Chamber of commerce membership updated" },
    { key: "establishment_updated", label: "Establishment records updated" },
  ]);

  // ── the graph ───────────────────────────────────────────────────────────────────────────────
  const nodes: any[] = [
    { id: "start", type: "start", label: "Renewal Created", config: {} },

    { id: "company_check", type: "task", label: "Company Check", config: {
      assigneeRole: "pro_officer", slaHours: 48, govCenter: "MISA",
      checklistSource: "dynamic", checklistRuleId: checkRule,
      instructions: "Confirm the company is ready to renew before anything is submitted. A submission made while any of these is lapsed is refused, and a refused submission costs more time than clearing the item first.",
      captures: [
        { var: "checkOutcome", type: "select", label: "Is the company ready to renew?", options: "ready,on_hold" },
        { var: "holdReason", type: "text", label: "What is blocking it?", required: false },
      ],
      rules: [
        { when: { var: "checkOutcome", op: "eq", value: "on_hold" }, then: { var: "holdReason", op: "present" },
          message: "Say what is blocking the renewal — the hold is worked from this note, and \"on hold\" with no reason tells the next officer nothing." },
      ],
    } },

    { id: "d_check", type: "decision", label: "Ready to Renew?", config: {
      branches: [
        { var: "checkOutcome", op: "eq", value: "ready", key: "ready" },
        { var: "checkOutcome", op: "eq", value: "on_hold", key: "hold" },
      ],
    } },

    { id: "hold_fix", type: "task", label: "On Hold — Clear the Blocking Item", config: {
      assigneeRole: "pro_officer", slaHours: 168,
      instructions: "Clear whatever the company check found — renew the CR, settle Zakat or GOSI, or correct the licence details — then send it back for re-check.",
      captures: [{ var: "holdCleared", type: "text", label: "What was done to clear it" }],
    } },

    { id: "collect_docs", type: "task", label: "Collect Documents from Client", config: {
      assigneeRole: "pro_officer", slaHours: 120,
      checklistSource: "dynamic", checklistRuleId: docsRule,
      instructions: "Ask the client for the renewal pack. The exact list varies by licence type — confirm it against this licence before asking, so the client is not chasing a document they do not need.",
    } },

    { id: "doc_review", type: "task", label: "Document Review", config: {
      assigneeRole: "pro_officer", slaHours: 48,
      captures: [
        { var: "docReview", type: "select", label: "Are the documents complete and correct?", options: "complete,returned" },
        { var: "returnReason", type: "text", label: "What is missing or wrong?", required: false },
      ],
      rules: [
        { when: { var: "docReview", op: "eq", value: "returned" }, then: { var: "returnReason", op: "present" },
          message: "Say what is missing or wrong — this is what the client is asked to correct, and \"returned\" on its own sends them back to guess." },
      ],
    } },

    { id: "d_review", type: "decision", label: "Documents Complete?", config: {
      branches: [
        { var: "docReview", op: "eq", value: "complete", key: "complete" },
        { var: "docReview", op: "eq", value: "returned", key: "returned" },
      ],
    } },

    { id: "fee", type: "task", label: "Confirm Fee and Obtain Client Approval", config: {
      assigneeRole: "pro_officer", slaHours: 48,
      instructions: "Confirm the renewal term and the government fee for it, put it to the client, and record their answer here. Nothing is paid until this step says approved.",
      captures: [
        { var: "renewalTerm", type: "select", label: "Renewal term", options: "1_year,2_years,3_years,5_years" },
        { var: "feeAmount", type: "number", label: "Government fee (SAR)" },
        { var: "clientApproval", type: "select", label: "Client decision", options: "approved,declined" },
        { var: "approvedBy", type: "text", label: "Who approved it, at the client", required: false },
        { var: "approvedOn", type: "date", label: "Date approved", required: false },
      ],
      rules: [
        { when: { var: "clientApproval", op: "eq", value: "approved" }, then: { var: "approvedBy", op: "present" },
          message: "Record who at the client approved the fee. This is the firm's evidence for spending their money, and a name is the whole of it." },
      ],
    } },

    { id: "d_fee", type: "decision", label: "Fee Approved?", config: {
      branches: [
        { var: "clientApproval", op: "eq", value: "approved", key: "approved" },
        { var: "clientApproval", op: "eq", value: "declined", key: "declined" },
      ],
    } },

    { id: "pay", type: "task", label: "Pay Government Fee", config: {
      assigneeRole: "accountant", slaHours: 48,
      instructions: "Pay the approved fee and record the receipt. The receipt is filed with the renewal and sent to the client with the invoice.",
      captures: [
        { var: "paymentRef", type: "text", label: "Payment reference" },
        { var: "paymentDate", type: "date", label: "Date paid" },
      ],
    } },

    { id: "submit", type: "task", label: "Submit Renewal on MISA Portal", config: {
      assigneeRole: "pro_officer", slaHours: 48, govCenter: "MISA",
      captures: [
        { var: "applicationRef", type: "text", label: "MISA application / reference number" },
        { var: "submittedOn", type: "date", label: "Date submitted" },
      ],
    } },

    { id: "misa_review", type: "task", label: "MISA Review", config: {
      assigneeRole: "pro_officer", slaHours: 240, govCenter: "MISA",
      instructions: "Monitor the application. Government response times vary — this step stays open while it is with MISA.",
      captures: [{ var: "misaOutcome", type: "select", label: "What did MISA say?", options: "approved,more_info,rejected" }],
    } },

    { id: "d_misa", type: "decision", label: "MISA Outcome?", config: {
      branches: [
        { var: "misaOutcome", op: "eq", value: "approved", key: "approved" },
        { var: "misaOutcome", op: "eq", value: "more_info", key: "more_info" },
        { var: "misaOutcome", op: "eq", value: "rejected", key: "rejected" },
      ],
    } },

    { id: "query", type: "task", label: "Respond to MISA Query", config: {
      assigneeRole: "pro_officer", slaHours: 72, govCenter: "MISA",
      instructions: "Obtain whatever MISA asked for and resubmit. The client only hears from us if something is needed from them.",
      captures: [{ var: "queryResponse", type: "text", label: "What was provided" }],
    } },

    { id: "record", type: "task", label: "Record the New Licence", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "MISA",
      captures: [
        { var: "newLicenceNumber", type: "text", label: "New licence number", purpose: "number" },
        { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" },
      ],
    } },

    // Renewal, not re-issue: the run carries `documentId`, so this archives the old number and
    // expiry into the licence's own history instead of leaving two live licences on the company.
    { id: "issue", type: "issue_document", label: "MISA Investment Licence", config: {
      docType: DOC_TYPE, numberVar: "newLicenceNumber", expiryVar: "newExpiry",
    } },

    { id: "followup", type: "task", label: "Update Related Records", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      checklistSource: "dynamic", checklistRuleId: followUpRule,
      instructions: "The registrations that carry the licence details have to agree with the new licence. Left alone they contradict it, and the next renewal inherits the mismatch.",
    } },

    { id: "notify", type: "notify", label: "Tell the Client", config: {
      channel: "Email", to: "{{ clientEmail }}",
      subject: "Your MISA licence has been renewed",
      template: "Your MISA investment licence has been renewed. The new licence number is {{ newLicenceNumber }} and it is valid until {{ newExpiry }}. The licence and the payment receipt are on file in your portal.",
    } },

    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
    { id: "end_declined", type: "end", label: "Not Renewed — Client Declined", config: {} },

    { id: "refusal", type: "task", label: "MISA Refusal — Advise the Client", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      instructions: "Explain the refusal to the client and agree what happens next. The existing licence is untouched — it stands until its own expiry date.",
      captures: [{ var: "refusalReason", type: "text", label: "Reason MISA gave" }],
    } },
    // Deliberately does NOT void issued documents. Onboarding's refusal ending does, because a
    // refused hire should leave no live visa behind. A refused RENEWAL is the opposite: the licence
    // the company already holds is valid until it expires, and voiding it would strip a client of a
    // licence they legitimately hold.
    { id: "end_refused", type: "end", label: "Not Renewed — Refused by MISA", config: {} },
  ];

  // EVERY BRANCH CARRIES `op` EXPLICITLY. evalDecision switches on the operator and its default
  // arm is `ok = false`, so a branch written as { var, value, key } — which reads perfectly well —
  // matches NOTHING and the decision falls to "else" every time. The first walk of this workflow
  // looped between the company check and the on-hold step twenty times because of it.
  const edges: any[] = [
    { from: "start", to: "company_check" },
    { from: "company_check", to: "d_check" },
    { from: "d_check", to: "collect_docs", condition: "ready" },
    { from: "d_check", to: "hold_fix", condition: "hold" },
    { from: "d_check", to: "hold_fix", condition: "else" },
    { from: "hold_fix", to: "company_check" },
    { from: "collect_docs", to: "doc_review" },
    { from: "doc_review", to: "d_review" },
    { from: "d_review", to: "fee", condition: "complete" },
    { from: "d_review", to: "collect_docs", condition: "returned" },
    { from: "d_review", to: "collect_docs", condition: "else" },
    { from: "fee", to: "d_fee" },
    { from: "d_fee", to: "pay", condition: "approved" },
    { from: "d_fee", to: "end_declined", condition: "declined" },
    { from: "d_fee", to: "fee", condition: "else" },
    { from: "pay", to: "submit" },
    { from: "submit", to: "misa_review" },
    { from: "misa_review", to: "d_misa" },
    { from: "d_misa", to: "record", condition: "approved" },
    { from: "d_misa", to: "query", condition: "more_info" },
    { from: "d_misa", to: "refusal", condition: "rejected" },
    { from: "d_misa", to: "misa_review", condition: "else" },
    { from: "query", to: "misa_review" },
    { from: "record", to: "issue" },
    { from: "issue", to: "followup" },
    { from: "followup", to: "notify" },
    { from: "notify", to: "end_done" },
    { from: "refusal", to: "end_refused" },
  ];

  const graph = { nodes, edges };
  const existing = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  const data: any = {
    name: TEMPLATE, country: COUNTRY, entityType: "company",
    trigger: "document_expiry",
    triggerConfig: { docType: DOC_TYPE, days: 60 } as any,
    graph: graph as any,
    packKey: "sa.workflow.misa-licence-renewal",
    // Left as a draft on purpose. Activating it arms the nightly job, which will start real renewals
    // against real client licences — that is the user's call to make, not this script's.
    active: false,
  };
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data })
    : await prisma.workflowTemplate.create({ data: { ...data, createdAt: new Date().toISOString() } });

  console.log(`\n${existing ? "updated" : "created"} "${TEMPLATE}"`);
  console.log(`  ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`  trigger: document_expiry on "${DOC_TYPE}" at ${typeData.leadDays} days`);
  console.log(`  entity: company · country: ${COUNTRY} · active: ${data.active} (draft — activate when you are ready)`);
  console.log(`  template id: ${tpl.id}`);
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
