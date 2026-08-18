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
// The country is NOT in the title. It is a property of the row and the builder shows it as its own
// chip — spelling "(KSA)" into the name reads fine on one workflow and becomes noise on twenty, and
// it cannot be filtered or counted because it is only characters in a string.
const TEMPLATE = "Employee Onboarding";
/** What it used to be called, so an installation that already has it is renamed rather than doubled. */
const OLD_NAMES = ["Employee Onboarding — by Hiring Type (KSA)"];
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
    // Registering somebody with GOSI is a fact about their employment, not a permit with a validity
    // period — it has no expiry to track, and saying so is what keeps it out of the deadline reports.
    { name: "GOSI Employee Registration", authority: "GOSI", leadDays: 14, neverExpires: true,
      defaultAssigneeRole: "accountant",
      fields: [{ key: "gosiNo", label: "GOSI number", type: "text" }] },
  ]) {
    const found = await prisma.documentType.findFirst({ where: { name: dt.name, country: COUNTRY } });
    if (found) {
      // neverExpires is corrected on an existing row too: this is the difference between "no expiry"
      // and "nobody has entered one yet", and the records already issued are the ones sitting in the
      // monitor at 0 days left.
      await prisma.documentType.update({ where: { id: found.id }, data: { retired: false, neverExpires: !!(dt as any).neverExpires } });
      console.log(`document type "${dt.name}" already exists`);
    } else {
      await prisma.documentType.create({ data: {
        name: dt.name, country: COUNTRY, subjectKind: "employee",
        authority: dt.authority, leadDays: dt.leadDays, neverExpires: !!(dt as any).neverExpires,
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

    // WHO is being onboarded, before anything about how.
    //
    // `applicant` is not a label choice. issue_document reads
    //   person = vars.applicant || vars.employee || ""
    // and then `if (inst.companyId && person)` — so with no applicant the person is "" and the
    // document is NOT CREATED. Silently: no error, no log line, no failed step. This step captured
    // only classification, so all six issue_document nodes in this workflow produced nothing at all
    // while every step went green and the run completed. A workflow whose entire output is discarded
    // and still reports success is the worst shape a bug can take here.
    //
    // completeTask also resolves the Employee row by this name (companyId + name) to write the
    // onboarding onto their history, so the same field joins the run to the employee record.
    { id: "profile", type: "task", label: "Create Employee Profile", config: {
      assigneeRole: "pro_officer", slaHours: 24,
      // WHAT THE THREE PATHS MEAN, ENFORCED WHERE THEY ARE CHOSEN.
      //
      // Nothing checked nationality against hiring type, so a profile reading nationality "Saudi" and
      // hiring type "expat new hire" was accepted and the run issued that Saudi citizen a Work Visa,
      // an Iqama and a Work Permit. All three are instruments for foreign nationals; the records are
      // not merely wrong, they describe something that cannot exist. The location contradictions went
      // through the same gap — a transfer from inside the Kingdom, filed as being outside it.
      //
      // Matched on a prefix rather than the exact word "Saudi", because this is a free-text field and
      // people write Saudi, saudi, Saudi Arabian.
      rules: [
        { when: { var: "nationality", op: "matches", value: "^\s*saudi" },
          then: { var: "hiringType", op: "in", value: "saudi_national" },
          message: "A Saudi national cannot be onboarded on an expatriate path — a work visa, Iqama and work permit are for foreign nationals" },
        { when: { var: "hiringType", op: "eq", value: "saudi_national" },
          then: { var: "nationality", op: "matches", value: "^\s*saudi" },
          message: "The Saudi national path needs a Saudi nationality — an expatriate needs a visa or a Qiwa transfer" },
        { when: { var: "hiringType", op: "eq", value: "expat_new_hire" },
          then: { var: "currentLocationStatus", op: "in", value: "outside_ksa" },
          message: "A new expatriate hire is recruited from outside the Kingdom — somebody already inside it is a Qiwa transfer" },
        { when: { var: "hiringType", op: "eq", value: "expat_transfer" },
          then: { var: "currentLocationStatus", op: "in", value: "inside_ksa" },
          message: "A Qiwa employee transfer moves somebody already working inside the Kingdom" },
      ],
      captures: [
        { var: "applicant", type: "text", label: "Full name (exactly as printed in the passport)" },
        { var: "nationality", type: "text", label: "Nationality" },
        { var: "mobile", type: "text", label: "Mobile" },
        { var: "email", type: "text", label: "Email" },
        { var: "hiringType", type: "select", label: "Hiring Type",
          options: "saudi_national,expat_new_hire,expat_transfer" },
        { var: "employmentType", type: "select", label: "Employment Type", options: "permanent,contract,temporary" },
        // Job title and department are different questions: Qiwa cares about the profession on the
        // contract, the client cares which team the person joins, and they routinely disagree.
        { var: "profession", type: "text", label: "Profession / job title on Qiwa" },
        { var: "department", type: "text", label: "Department" },
        { var: "reportingManager", type: "text", label: "Reporting manager" },
        { var: "expectedJoining", type: "date", label: "Expected joining date" },
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

    // ── THE HIRING GATE ────────────────────────────────────────────────────────────────────
    // The template this replaced had an Internal Approval here and dropping it was a real loss: it
    // is the only point between "the documents are in" and "we start spending government fees on
    // this person" where somebody with authority says yes. Government work is expensive and some of
    // it is irreversible, so it should never begin on the strength of a document check alone.
    { id: "hiring_appr", type: "approval", label: "Hiring Approval", config: {
      approverRole: "hr_officer",
      title: "Approve this hire before government processing begins",
    } },
    { id: "end_nohire", type: "end", label: "Hire Not Approved", config: {} },

    { id: "d_hiring", type: "decision", label: "Hiring Type?", config: { branches: [
      { var: "hiringType", op: "eq", value: "saudi_national", key: "saudi" },
      { var: "hiringType", op: "eq", value: "expat_new_hire", key: "new_hire" },
      { var: "hiringType", op: "eq", value: "expat_transfer", key: "transfer" },
    ] } },
    // Where an unrecognised hiring type goes. A person fixes the profile and it is asked again —
    // better than picking a path on the run's behalf and doing the wrong body of work silently.
    { id: "hold", type: "task", label: "Hiring type not recognised — check the profile", config: {
      assigneeRole: "pro_officer", slaHours: 24,
      captures: [{ var: "hiringType", type: "select", label: "Hiring Type",
        options: "saudi_national,expat_new_hire,expat_transfer" }],
    } },

    // ── expatriate, hired from outside KSA ───────────────────────────────────────────────────
    { id: "visa_apply", type: "task", label: "Work Visa Application", config: {
      assigneeRole: "pro_officer", govCenter: "MOFA", slaHours: 240,
      captures: [
        { var: "visaNumber", type: "text", label: "Visa number" },
        { var: "visaExpiry", type: "date", label: "Visa expiry" },
      ],
    } },
    // EVERY ISSUED DOCUMENT NAMES ITS OWN VARIABLES.
    //
    // issue_document reads `vars.docNumber` and `vars.newExpiry` unless the node says otherwise, and
    // run variables are flat — so four steps writing `docNumber` meant four documents reading
    // whichever was written last. Simulated on the expat path with real-looking entries, four of the
    // six documents came out wrong: the Iqama took the VISA's number, the Work Permit took the
    // contract's number AND end date, and the Health Insurance policy took the GOSI number and the
    // contract's end date. Those expiries drive the renewal engine, so the platform would have chased
    // insurance renewals on the date the employment contract ends.
    { id: "visa_doc", type: "issue_document", label: "Work Visa",
      config: { docType: "Work Visa", numberVar: "visaNumber", expiryVar: "visaExpiry" } },
    { id: "arrival", type: "task", label: "Arrival, Medical & Biometrics", config: {
      assigneeRole: "pro_officer", slaHours: 168,
      checklist: [
        doc("arrived", "Employee arrived in KSA"),
        doc("medical_ksa", "Medical test completed in KSA"),
        doc("biometrics", "Biometrics captured"),
      ],
      captures: [
        { var: "iqamaNumber", type: "text", label: "Iqama number" },
        { var: "iqamaExpiry", type: "date", label: "Iqama expiry" },
      ],
    } },
    { id: "iqama_doc", type: "issue_document", label: "Iqama",
      config: { docType: "Iqama", numberVar: "iqamaNumber", expiryVar: "iqamaExpiry" } },

    // ── expatriate already inside KSA: the case the old template had no answer for ───────────
    { id: "qiwa_req", type: "task", label: "Qiwa Employee Transfer Request", config: {
      assigneeRole: "pro_officer", slaHours: 240,
      checklist: [
        doc("qiwa_raised", "Transfer request raised on Qiwa"),
        doc("contract_attached", "Employment contract attached to the request"),
        doc("employee_accepted", "Employee accepted on Qiwa"),
        doc("employer_response", "Current employer responded"),
      ],
      // THE WAITING STATES ARE THE POINT.
      //
      // approved / rejected / expired describes how a transfer ENDED and says nothing about a
      // transfer in progress — which is most of them, for most of their life. An officer asked "where
      // is this?" could only answer "not approved yet", and the three outcomes gave them nowhere to
      // record whether that means the employee has not opened it, the current employer has not
      // replied, a notice period is running, or the ministry has it.
      //
      // Waiting states route back to this step rather than onward or to an end: the transfer is still
      // live, and the run has to stay on the one task that owns it.
      captures: [{ var: "transferOutcome", type: "select", label: "Where is the transfer now?",
        options: "awaiting_employee,awaiting_current_employer,notice_period,ministry_processing,approved,rejected,expired,cancelled" }],
    } },
    { id: "d_transfer", type: "decision", label: "Transfer Approved?", config: { branches: [
      { var: "transferOutcome", op: "eq", value: "approved", key: "approved" },
      { var: "transferOutcome", op: "eq", value: "rejected", key: "rejected" },
      { var: "transferOutcome", op: "eq", value: "expired", key: "expired" },
      { var: "transferOutcome", op: "eq", value: "cancelled", key: "cancelled" },
      { var: "transferOutcome", op: "eq", value: "awaiting_employee", key: "waiting_employee" },
      { var: "transferOutcome", op: "eq", value: "awaiting_current_employer", key: "waiting_employer" },
      { var: "transferOutcome", op: "eq", value: "notice_period", key: "waiting_notice" },
      { var: "transferOutcome", op: "eq", value: "ministry_processing", key: "waiting_ministry" },
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
        { var: "contractNumber", type: "text", label: "Contract number on Qiwa" },
        { var: "contractEnd", type: "date", label: "Contract end date" },
      ],
    } },
    { id: "contract_doc", type: "issue_document", label: "Qiwa Employment Contract",
      config: { docType: "Qiwa Employment Contract", numberVar: "contractNumber", expiryVar: "contractEnd" } },
    // Reads hiringType rather than nationality: that is the field the profile actually captures, and
    // the two expatriate branches are exactly the ones that need a permit.
    // One key per branch. Two entries sharing the key "expat" routed correctly — both expatriate
    // values reached the same edge — but a branch list with a repeated key is a list the editor cannot
    // show honestly, and the next person adding an edge for one of them changes both.
    { id: "d_permit", type: "decision", label: "Work Permit Required?", config: { branches: [
      { var: "hiringType", op: "eq", value: "expat_new_hire", key: "expat_new" },
      { var: "hiringType", op: "eq", value: "expat_transfer", key: "expat_move" },
      { var: "hiringType", op: "eq", value: "saudi_national", key: "saudi" },
    ] } },
    // A permit has a number and an expiry of its own, and nothing was capturing them — so the document
    // inherited the contract's. One step, and the record means what it says.
    { id: "permit_task", type: "task", label: "Work Permit Issuance", config: {
      assigneeRole: "pro_officer", govCenter: "Qiwa", slaHours: 72,
      checklist: [doc("permit_fees", "Work permit fees paid"), doc("permit_profession", "Profession on the permit matches the contract")],
      captures: [
        { var: "permitNumber", type: "text", label: "Work permit number" },
        { var: "permitExpiry", type: "date", label: "Work permit expiry" },
      ],
    } },
    { id: "permit_doc", type: "issue_document", label: "Work Permit",
      config: { docType: "Work Permit", numberVar: "permitNumber", expiryVar: "permitExpiry" } },

    { id: "split", type: "parallel_split", label: "Set Up In Parallel", config: {} },
    { id: "payroll", type: "task", label: "Payroll & WPS Setup", config: { assigneeRole: "accountant", slaHours: 72,
      checklist: [doc("wps_registered", "Registered on WPS"), doc("bank_ok", "Salary account confirmed")],
      captures: [{ var: "gosiNumber", type: "text", label: "GOSI number" }] } },
    // "Added to GOSI" was one tick on the payroll list. As a document it is a record with a number,
    // an authority and a date, which is what anyone asking "is this employee registered?" needs.
    { id: "gosi_doc", type: "issue_document", label: "GOSI Employee Registration",
      // No expiryVar: a GOSI registration does not expire. Naming a variable nobody captures made the
      // log read "GOSI Employee Registration … → ?" and stored a null expiry that looked like an
      // omission rather than a fact about the record.
      config: { docType: "GOSI Employee Registration", numberVar: "gosiNumber" } },
    // Accounts and devices are not PRO work. A PRO officer deals with government.
    { id: "access", type: "task", label: "System Access", config: { assigneeRole: "it_officer", slaHours: 48,
      checklist: [doc("email", "Corporate email"), doc("erp", "ERP account"), doc("attendance", "Attendance / biometric enrolment"),
                  doc("permissions", "Application permissions and role assigned")] } },
    { id: "assets", type: "task", label: "Assets & Accommodation", config: { assigneeRole: "hr_officer", slaHours: 72,
      checklist: [doc("laptop", "Laptop / equipment issued"), doc("sim", "SIM card"), doc("id_card", "Company ID card"),
                  doc("accommodation", "Accommodation arranged", false)] } },
    // The policy is issued by an insurer and carries its own number and period. As a bare
    // issue_document it was picking up the GOSI number and the contract's end date.
    { id: "insurance_task", type: "task", label: "Health Insurance Enrolment", config: {
      assigneeRole: "pro_officer", govCenter: "CCHI", slaHours: 72,
      checklist: [doc("policy_active", "Policy active with the insurer"), doc("class_matches", "Class matches the employee's grade")],
      captures: [
        { var: "policyNumber", type: "text", label: "Policy number" },
        { var: "policyExpiry", type: "date", label: "Policy expiry" },
      ],
    } },
    { id: "insurance", type: "issue_document", label: "Health Insurance",
      config: { docType: "Health Insurance", numberVar: "policyNumber", expiryVar: "policyExpiry" } },
    { id: "join", type: "parallel_join", label: "All Departments Complete", config: {} },

    // Joined means the employee has entered the operational lifecycle, not that they walked in.
    { id: "joined", type: "task", label: "Joining Confirmation", config: { assigneeRole: "hr_officer", slaHours: 48,
      checklist: [doc("attendance_on", "Attendance enabled"), doc("contract_active", "Qiwa contract active"),
                  doc("payroll_active", "Payroll active"), doc("insurance_active", "Insurance active")],
      captures: [{ var: "employeeJoined", type: "select", label: "Employee Joined?", options: "yes,no" }] } },
    { id: "d_joined", type: "decision", label: "Joined?", config: { branches: [
      { var: "employeeJoined", op: "eq", value: "yes", key: "yes" },
      { var: "employeeJoined", op: "eq", value: "no", key: "no" },
    ] } },
    { id: "end_cancel", type: "end", label: "Joining Cancelled", config: {} },

    { id: "probation", type: "delay", label: "Probation (90 days)", config: { days: 90 } },
    // A VERDICT NEEDS SOMETHING BEHIND IT.
    //
    // This step used to be one dropdown: Confirmed? yes / no / extend. Chosen from that alone, a
    // termination at the end of probation is a decision with no record of what it was based on — and
    // this is the one step in the workflow whose output can end somebody's employment. The checklist
    // is what the reviewer is supposed to have gathered anyway; requiring it here means the file
    // shows it was gathered.
    //
    // Required items gate completion, so the step cannot be closed by opening it and picking "no".
    { id: "prob_review", type: "task", label: "Probation Review", config: { assigneeRole: "hr_officer",
      slaHours: 72,
      checklist: [
        { key: "manager_appraisal", label: "Line manager's appraisal completed and signed", required: true },
        { key: "objectives_reviewed", label: "Probation objectives reviewed against the job description", required: true },
        { key: "attendance_reviewed", label: "Attendance and punctuality record reviewed", required: true },
        { key: "conduct_checked", label: "Warnings and disciplinary record checked", required: true },
        { key: "training_complete", label: "Mandatory induction and training completed", required: false },
        { key: "meeting_held", label: "Outcome discussed with the employee", required: true },
      ],
      captures: [
        { var: "probationOutcome", type: "select", label: "Confirmed?", options: "yes,no,extend" },
        // Free text rather than a reason code: at this end of the process the specifics are the
        // point, and a fixed list would be answered with whichever option is least wrong.
        { var: "probationNotes", type: "text", label: "Reason for the decision" },
        { var: "probationEffective", type: "date", label: "Effective from" },
      ] } },
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
    e("d_docs", "hiring_appr", "pass"),
    e("d_docs", "collect", "fail"),
    e("d_docs", "collect", "else"),          // an unanswered verification asks again

    e("hiring_appr", "d_hiring", "approve"),
    e("hiring_appr", "end_nohire", "reject"),

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
    e("d_transfer", "end_transfer", "cancelled"),
    // Still running: back to the step that owns it, so the run stays alive and the reason is on record.
    e("d_transfer", "qiwa_req", "waiting_employee"),
    e("d_transfer", "qiwa_req", "waiting_employer"),
    e("d_transfer", "qiwa_req", "waiting_notice"),
    e("d_transfer", "qiwa_req", "waiting_ministry"),
    // An unrecognised value is not a failed transfer — it goes back to a person, like the hiring type.
    e("d_transfer", "qiwa_req", "else"),

    e("contract", "contract_doc"),
    // A WORK PERMIT IS AN EXPATRIATE INSTRUMENT. The three hiring types converged before this node,
    // so a Saudi national was issued one — a document that does not exist for them, on their record,
    // with an expiry the compliance screens would then chase. Saudis go straight to the shared setup.
    e("contract_doc", "d_permit"),
    e("d_permit", "permit_task", "expat_new"),
    e("d_permit", "permit_task", "expat_move"),
    e("d_permit", "split", "saudi"),
    e("d_permit", "permit_task", "else"),     // unknown: issue it and let a person correct the profile
    e("permit_task", "permit_doc"),
    e("permit_doc", "split"),
    e("split", "payroll"), e("split", "access"), e("split", "assets"), e("split", "insurance_task"),
    e("insurance_task", "insurance"),
    e("payroll", "gosi_doc"), e("gosi_doc", "join"),
    e("access", "join"), e("assets", "join"), e("insurance", "join"),
    e("join", "joined"),

    e("joined", "d_joined"),
    e("d_joined", "probation", "yes"),
    e("d_joined", "end_cancel", "no"),
    // NOT end_cancel. `else` here meant an unanswered question cancelled somebody's hire — a
    // terminal, destructive outcome reached by missing data rather than by a decision. "No" is a
    // decision and still ends the run; silence goes back to the person who has to make one.
    e("d_joined", "joined", "else"),

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
  // Rename first. Matching on the new name alone would miss the row created under the old one and
  // create a second copy beside it — the same duplicate-on-rename trap the pack keys avoid.
  const renamed = await prisma.workflowTemplate.updateMany({ where: { name: { in: OLD_NAMES } }, data: { name: TEMPLATE } });
  if (renamed.count) console.log(`renamed ${renamed.count} existing template to "${TEMPLATE}"`);

  const existing = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data: { graph: graph as any, country: COUNTRY } })
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
