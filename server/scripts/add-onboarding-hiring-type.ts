/**
 * Build "Employee Onboarding — by Hiring Type (KSA)" as a NEW template.
 *
 * The existing Employee Onboarding asks `visaRequired: yes|no` and branches on it. That is not the
 * business: an expatriate already inside Saudi is not a "no visa" hire. They need a Qiwa employee
 * transfer, which carries its own contract, its own approvals from the current employer and the
 * employee, and can be REJECTED or lapse. "No visa required → Payroll Setup" walks straight past all
 * of it.
 *
 * So the question becomes `hiringType`, with three answers, and the paths that genuinely differ get
 * their own branch.
 *
 * WHAT BRANCHES AND WHAT DOES NOT
 *   Branch only where the PATH diverges: hiring type (three different bodies of work) and the
 *   transfer outcome (a rejection ends the run). Nationality, profession and Nitaqat impact are
 *   FACTS, not paths — they are captured on the profile and read by the eligibility step and the
 *   document rule. Making each of them a decision node would add halt points without adding a route.
 *
 * ONE DOCUMENT STEP, NOT THREE
 *   The collect step uses checklistSource "dynamic", and a workflow rule is evaluated against the
 *   RUN's variables — see resolveDynamic in workflow.ts. So one task with one rule produces three
 *   different document lists from `hiringType`. Three near-identical collect tasks would be three
 *   places to forget to update.
 *
 * EVERY DECISION HAS AN ELSE
 *   evalDecision returns "else" when nothing matches, and nextTargets looks for an edge conditioned
 *   else/default/blank. Without one the run reaches a node with no outgoing target and simply stops,
 *   with no task open and nobody told. Every decision below wires one, and where the safe answer is
 *   "a person should look at this", the else routes to a task rather than guessing.
 *
 * Idempotent: re-running replaces the template and the rule rather than adding a second copy.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const TEMPLATE = "Employee Onboarding — by Hiring Type (KSA)";
const RULE = "Onboarding documents by hiring type";

const doc = (key: string, label: string, required = true) => ({ key, label, required, source: "manual" });

async function main() {
  // ── the two document types these steps produce ─────────────────────────────────────────────
  //
  // Both were checklist TEXT before: somebody ticked "contract authenticated" and nothing was left
  // behind. As document types they become records with an authority, a lead time and an expiry, so
  // Compliance can chase them and a renewal workflow can pick them up. That is the whole difference
  // between a workflow that records work and one that only remembers it happened.
  //
  // GOSI Employee Registration is deliberately separate from the existing "GOSI Registration",
  // which is a COMPANY document — the establishment's own registration. An employee being added to
  // GOSI is a different fact about a different subject, and folding them into one type would put
  // every employee's registration on the company record.
  for (const dt of [
    { name: "Qiwa Employment Contract", authority: "Qiwa", leadDays: 30,
      defaultAssigneeRole: "pro_officer",
      fields: [{ key: "contractNo", label: "Contract number", type: "text" },
               { key: "wage", label: "Basic wage", type: "text" }] },
    { name: "GOSI Employee Registration", authority: "GOSI", leadDays: 14,
      defaultAssigneeRole: "accountant",
      fields: [{ key: "gosiNo", label: "GOSI number", type: "text" }] },
  ]) {
    const found = await prisma.documentType.findFirst({ where: { name: dt.name, country: COUNTRY } });
    if (found) {
      await prisma.documentType.update({ where: { id: found.id }, data: { retired: false } });
      console.log(`document type "${dt.name}" already exists`);
    } else {
      await prisma.documentType.create({ data: {
        name: dt.name, country: COUNTRY, subjectKind: "employee",
        authority: dt.authority, leadDays: dt.leadDays,
        defaultAssigneeRole: dt.defaultAssigneeRole, fields: dt.fields as any,
      } });
      console.log(`created document type "${dt.name}" (employee · ${dt.authority})`);
    }
  }

  // ── the document rule the collect step reads ───────────────────────────────────────────────
  //
  // Row 0 has no conditions, so it applies to everyone; the other three add to it. evaluateRule
  // merges the matching rows by key, so a base item named twice stays one item.
  const rows = [
    {
      conditions: [],
      documents: [
        doc("passport_copy", "Passport copy"),
        doc("photo", "Photograph — white background"),
        doc("offer_signed", "Signed offer letter"),
      ],
    },
    {
      conditions: [{ var: "hiringType", op: "eq", value: "saudi_national" }],
      documents: [
        doc("national_id", "National ID (Hawiyya) copy"),
        doc("gosi_number", "GOSI number"),
        doc("bank_iban", "Bank IBAN for WPS"),
        doc("qualification", "Qualification certificate", false),
      ],
    },
    {
      conditions: [{ var: "hiringType", op: "eq", value: "expat_new_hire" }],
      documents: [
        doc("passport_validity", "Passport valid 6+ months"),
        doc("degree_attested", "Attested degree certificate"),
        doc("medical_fitness", "Medical fitness certificate — home country"),
        doc("visa_application", "Work visa application form"),
        doc("police_clearance", "Police clearance certificate", false),
      ],
    },
    {
      conditions: [{ var: "hiringType", op: "eq", value: "expat_transfer" }],
      documents: [
        doc("iqama_copy", "Current Iqama copy"),
        doc("qiwa_consent", "Qiwa transfer consent — employee"),
        doc("current_employer_release", "Release / no-objection from current employer"),
        doc("current_contract", "Current employment contract copy"),
        doc("iqama_validity", "Iqama valid for the transfer window"),
      ],
    },
  ];

  const existingRule = await prisma.checklistRule.findFirst({ where: { name: RULE, country: COUNTRY } });
  const rule = existingRule
    ? await prisma.checklistRule.update({ where: { id: existingRule.id }, data: { rows: rows as any } })
    : await prisma.checklistRule.create({ data: { name: RULE, country: COUNTRY, rows: rows as any } });
  console.log(`${existingRule ? "updated" : "created"} rule "${RULE}" — ${rows.length} rows`);

  // ── the graph ──────────────────────────────────────────────────────────────────────────────
  const nodes: any[] = [
    { id: "start", type: "start", label: "Employee Request Created", config: {} },

    { id: "profile", type: "task", label: "Create Employee Profile", config: {
      assigneeRole: "pro_officer", slaHours: 24,
      captures: [
        { var: "hiringType", type: "select", label: "Hiring Type",
          options: "saudi_national,expat_new_hire,expat_transfer" },
        { var: "employmentType", type: "select", label: "Employment Type", options: "permanent,contract,temporary" },
        { var: "nationality", type: "text", label: "Nationality" },
        { var: "profession", type: "text", label: "Profession / job title on Qiwa" },
        { var: "currentLocationStatus", type: "select", label: "Currently", options: "inside_ksa,outside_ksa" },
      ],
    } },

    // Nitaqat and profession are checks, not routes. They belong on a list somebody works through.
    { id: "elig", type: "task", label: "Eligibility & Nitaqat Check", config: {
      assigneeRole: "pro_officer", slaHours: 48,
      checklist: [
        doc("nitaqat_band", "Nitaqat band impact checked — hire does not drop the band"),
        doc("profession_allowed", "Profession permitted for this nationality"),
        doc("establishment_ok", "Establishment eligible on Qiwa (no blocks)"),
        doc("quota_available", "Visa / work-permit quota available", false),
      ],
    } },

    // ONE collect step. The list is produced by the rule above from `hiringType`.
    { id: "collect", type: "task", label: "Collect Documents", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      checklistSource: "dynamic", checklistRuleId: rule.id,
      captures: [{ var: "documentsVerified", type: "select", label: "All Documents Verified?", options: "pass,fail" }],
    } },
    { id: "d_docs", type: "decision", label: "Documents Verified?", config: { branches: [
      { var: "documentsVerified", op: "eq", value: "pass", key: "pass" },
      { var: "documentsVerified", op: "eq", value: "fail", key: "fail" },
    ] } },

    { id: "d_hiring", type: "decision", label: "Hiring Type?", config: { branches: [
      { var: "hiringType", op: "eq", value: "saudi_national", key: "saudi" },
      { var: "hiringType", op: "eq", value: "expat_new_hire", key: "new_hire" },
      { var: "hiringType", op: "eq", value: "expat_transfer", key: "transfer" },
    ] } },
    // Where an unrecognised hiring type goes. A person fixes the profile and it is asked again —
    // better than picking a path on the run's behalf and doing the wrong body of work silently.
    { id: "hold", type: "task", label: "Hiring type not recognised — check the profile", config: {
      assigneeRole: "pro_officer",
      captures: [{ var: "hiringType", type: "select", label: "Hiring Type",
        options: "saudi_national,expat_new_hire,expat_transfer" }],
    } },

    // ── expatriate, hired from outside KSA ───────────────────────────────────────────────────
    { id: "visa_apply", type: "task", label: "Work Visa Application", config: {
      assigneeRole: "pro_officer", govCenter: "MOFA", slaHours: 240,
      captures: [
        { var: "docNumber", type: "text", label: "Visa number" },
        { var: "newExpiry", type: "date", label: "Visa expiry" },
      ],
    } },
    { id: "visa_doc", type: "issue_document", label: "Work Visa", config: { docType: "Work Visa" } },
    { id: "arrival", type: "task", label: "Arrival, Medical & Biometrics", config: {
      assigneeRole: "pro_officer", slaHours: 168,
      checklist: [
        doc("arrived", "Employee arrived in KSA"),
        doc("medical_ksa", "Medical test completed in KSA"),
        doc("biometrics", "Biometrics captured"),
      ],
      captures: [{ var: "newExpiry", type: "date", label: "Iqama expiry" }],
    } },
    { id: "iqama_doc", type: "issue_document", label: "Iqama", config: { docType: "Iqama" } },

    // ── expatriate already inside KSA: the case the old template had no answer for ───────────
    { id: "qiwa_req", type: "task", label: "Qiwa Employee Transfer Request", config: {
      assigneeRole: "pro_officer", slaHours: 240,
      checklist: [
        doc("qiwa_raised", "Transfer request raised on Qiwa"),
        doc("contract_attached", "Employment contract attached to the request"),
        doc("employee_accepted", "Employee accepted on Qiwa"),
        doc("employer_response", "Current employer responded"),
      ],
      captures: [{ var: "transferOutcome", type: "select", label: "Transfer Outcome",
        options: "approved,rejected,expired" }],
    } },
    { id: "d_transfer", type: "decision", label: "Transfer Approved?", config: { branches: [
      { var: "transferOutcome", op: "eq", value: "approved", key: "approved" },
      { var: "transferOutcome", op: "eq", value: "rejected", key: "rejected" },
      { var: "transferOutcome", op: "eq", value: "expired", key: "expired" },
    ] } },
    { id: "end_transfer", type: "end", label: "Transfer Not Completed", config: {} },

    // ── everyone converges here. A plain task, NOT a parallel join: a join waits for every
    //    in-edge to arrive, and only one of the three branches ever will. ────────────────────
    // The checks stay a task, because somebody has to do them; what the task PRODUCES is then
    // recorded as a document rather than as a tick that evaporates.
    { id: "contract", type: "task", label: "Qiwa Contract Authentication", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      checklist: [
        doc("contract_authenticated", "Contract authenticated on Qiwa"),
        doc("wage_matches", "Wage matches the contract and WPS record"),
        doc("job_title_matches", "Job title matches the work permit profession"),
      ],
      captures: [
        { var: "docNumber", type: "text", label: "Contract number on Qiwa" },
        { var: "newExpiry", type: "date", label: "Contract end date" },
      ],
    } },
    { id: "contract_doc", type: "issue_document", label: "Qiwa Employment Contract",
      config: { docType: "Qiwa Employment Contract" } },
    { id: "permit_doc", type: "issue_document", label: "Work Permit", config: { docType: "Work Permit" } },

    { id: "split", type: "parallel_split", label: "Set Up In Parallel", config: {} },
    { id: "payroll", type: "task", label: "Payroll & WPS Setup", config: { assigneeRole: "accountant", slaHours: 72,
      checklist: [doc("wps_registered", "Registered on WPS"), doc("bank_ok", "Salary account confirmed")],
      captures: [{ var: "docNumber", type: "text", label: "GOSI number" }] } },
    // "Added to GOSI" was one tick on the payroll list. As a document it is a record with a number,
    // an authority and a date, which is what anyone asking "is this employee registered?" needs.
    { id: "gosi_doc", type: "issue_document", label: "GOSI Employee Registration",
      config: { docType: "GOSI Employee Registration" } },
    { id: "access", type: "task", label: "System Access", config: { assigneeRole: "pro_officer", slaHours: 48 } },
    { id: "assets", type: "task", label: "Assets & Accommodation", config: { assigneeRole: "pro_officer", slaHours: 72 } },
    { id: "insurance", type: "issue_document", label: "Health Insurance", config: { docType: "Health Insurance" } },
    { id: "join", type: "parallel_join", label: "All Departments Complete", config: {} },

    { id: "joined", type: "task", label: "Joining Confirmation", config: { assigneeRole: "pro_officer",
      captures: [{ var: "employeeJoined", type: "select", label: "Employee Joined?", options: "yes,no" }] } },
    { id: "d_joined", type: "decision", label: "Joined?", config: { branches: [
      { var: "employeeJoined", op: "eq", value: "yes", key: "yes" },
      { var: "employeeJoined", op: "eq", value: "no", key: "no" },
    ] } },
    { id: "end_cancel", type: "end", label: "Joining Cancelled", config: {} },

    { id: "probation", type: "delay", label: "Probation (90 days)", config: { days: 90 } },
    { id: "prob_review", type: "task", label: "Probation Review", config: { assigneeRole: "pro_officer",
      captures: [{ var: "probationOutcome", type: "select", label: "Confirmed?", options: "yes,no,extend" }] } },
    { id: "d_prob", type: "decision", label: "Confirmed?", config: { branches: [
      { var: "probationOutcome", op: "eq", value: "yes", key: "yes" },
      { var: "probationOutcome", op: "eq", value: "extend", key: "extend" },
      { var: "probationOutcome", op: "eq", value: "no", key: "no" },
    ] } },
    { id: "extend", type: "delay", label: "Extend Probation (30 days)", config: { days: 30 } },
    { id: "end_term", type: "end", label: "Not Confirmed — Termination", config: {} },
    { id: "confirm_appr", type: "approval", label: "Employee Confirmation Approval", config: { approverRole: "admin" } },
    { id: "notify", type: "notify", label: "Notify Employee", config: {} },
    { id: "end_ok", type: "end", label: "Employee Confirmed", config: {} },
  ];

  const e = (from: string, to: string, condition = "") => ({ from, to, condition });
  const edges = [
    e("start", "profile"),
    e("profile", "elig"),
    e("elig", "collect"),
    e("collect", "d_docs"),
    e("d_docs", "d_hiring", "pass"),
    e("d_docs", "collect", "fail"),
    e("d_docs", "collect", "else"),          // an unanswered verification asks again

    e("d_hiring", "contract", "saudi"),
    e("d_hiring", "visa_apply", "new_hire"),
    e("d_hiring", "qiwa_req", "transfer"),
    e("d_hiring", "hold", "else"),
    e("hold", "d_hiring"),                    // fixed by a person, then asked again

    e("visa_apply", "visa_doc"),
    e("visa_doc", "arrival"),
    e("arrival", "iqama_doc"),
    e("iqama_doc", "contract"),

    e("qiwa_req", "d_transfer"),
    e("d_transfer", "contract", "approved"),
    e("d_transfer", "end_transfer", "rejected"),
    e("d_transfer", "end_transfer", "expired"),
    e("d_transfer", "end_transfer", "else"),

    e("contract", "contract_doc"),
    e("contract_doc", "permit_doc"),
    e("permit_doc", "split"),
    e("split", "payroll"), e("split", "access"), e("split", "assets"), e("split", "insurance"),
    e("payroll", "gosi_doc"), e("gosi_doc", "join"),
    e("access", "join"), e("assets", "join"), e("insurance", "join"),
    e("join", "joined"),

    e("joined", "d_joined"),
    e("d_joined", "probation", "yes"),
    e("d_joined", "end_cancel", "no"),
    e("d_joined", "end_cancel", "else"),

    e("probation", "prob_review"),
    e("prob_review", "d_prob"),
    e("d_prob", "confirm_appr", "yes"),
    e("d_prob", "extend", "extend"),
    e("d_prob", "end_term", "no"),
    e("d_prob", "prob_review", "else"),       // no answer is not a termination
    e("extend", "prob_review"),

    e("confirm_appr", "notify", "approve"),
    e("confirm_appr", "end_term", "reject"),
    e("notify", "end_ok"),
  ];

  const graph = { nodes, edges };
  const existing = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data: { graph: graph as any, country: COUNTRY, active: false } })
    : await prisma.workflowTemplate.create({ data: {
        name: TEMPLATE, country: COUNTRY, trigger: "manual", entityType: "employee",
        // Left INACTIVE. It sits beside the one in use until somebody has read it and chosen to
        // switch; a new template that quietly starts taking runs is not a draft.
        active: false, graph: graph as any,
        description: "Branches on hiring type — Saudi national, expatriate hired from outside KSA, or expatriate transferred from inside KSA via Qiwa. Documents come from a rule rather than three separate steps.",
        createdAt: new Date().toISOString(),
      } });

  console.log(`${existing ? "updated" : "created"} "${TEMPLATE}"`);
  console.log(`  ${nodes.length} nodes, ${edges.length} edges, active=false`);
  console.log(`  template id: ${tpl.id}`);
  process.exit(0);
}

main().catch(async e => { console.error(e); process.exit(1); });
