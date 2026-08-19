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
  // ── the statutory deadlines, on the document types they belong to ────────────────────────────
  //
  // The DAYS AND THE SOURCE live in Country Rules, not in the workflow. A workflow step knows when a
  // clock started — entry to the Kingdom is a fact about one run — but how long the law allows is a
  // fact about Saudi Arabia, and it belongs where somebody maintaining Saudi regulations will find
  // it, and where it travels in the country pack rather than being restated in every workflow that
  // touches the same document.
  //
  // Only filled where it was empty. A number somebody has already corrected against the current
  // regulation outranks the one written here months ago.
  for (const st of [
    { name: "Iqama", statutoryDays: 90, statutoryFrom: "entry to the Kingdom",
      statutoryBasis: "Residence (Iqama) Regulations — issue within 90 days of entry" },
    { name: "GOSI Employee Registration", statutoryFrom: "the start of work",
      statutoryBasis: "GOSI — register by the 15th of the following month; non-Saudis cannot be registered retroactively" },
  ]) {
    const row = await prisma.documentType.findFirst({ where: { name: st.name, country: COUNTRY } });
    if (!row) { console.log(`document type "${st.name}" not installed — statutory deadline not set`); continue; }
    const data: any = {};
    if (row.statutoryDays == null && (st as any).statutoryDays != null) data.statutoryDays = (st as any).statutoryDays;
    if (!row.statutoryFrom) data.statutoryFrom = st.statutoryFrom;
    if (!row.statutoryBasis) data.statutoryBasis = st.statutoryBasis;
    if (!Object.keys(data).length) { console.log(`statutory deadline for "${st.name}" already set`); continue; }
    await prisma.documentType.update({ where: { id: row.id }, data });
    console.log(`statutory deadline set on "${st.name}": ${Object.keys(data).join(", ")}`);
  }

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
      // It now does what its name says. Without this the run captured a name and produced no
      // personnel record, so every document it issued had nobody to belong to.
      createsEmployee: true,
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
      // AN APPROVAL IS THE ONE STEP TYPE THAT CAN STALL IN SILENCE.
      //
      // Neither approval carried an SLA, so neither got a due date, and a task with no due date never
      // appears in the SLA Monitor. Every other step type is chased by somebody waiting on the work
      // downstream; an approval is waited on by the run itself, and nothing else can clear it. Now
      // that they auto-assign, an approver on leave silently parks the hire.
      //
      // Two working days here, three at confirmation. Both are decisions someone can make from what
      // is already in front of them, not work that has to be done at a ministry.
      slaHours: 48,
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
    //
    // THREE THINGS HAVE TO HAPPEN BEFORE ANYBODY APPLIES FOR A VISA, and the workflow began at the
    // application. A real expatriate hire stalls on every one of them, and the second cannot be
    // repaired afterwards at any price.
    //
    // An establishment cannot apply for a work visa it has not been authorised to use. The
    // authorisation is granted against the Nitaqat band and the approved manpower quota, per
    // profession and per nationality — so "do we have a visa for this role" is a question with a
    // real answer before the file is opened, not a tick box on an eligibility screen. Quota is
    // where expatriate hiring actually fails, and it fails at the beginning.
    { id: "visa_auth", type: "task", label: "Visa Authorisation & Quota", config: {
      assigneeRole: "pro_officer", govCenter: "Qiwa", slaHours: 120,
      checklist: [
        doc("quota_checked", "Approved manpower quota covers this profession and nationality"),
        doc("nitaqat_band", "Nitaqat band still holds after adding this hire"),
      ],
      captures: [
        { var: "visaAuthNumber", type: "text", label: "Visa authorisation number", required: false },
        { var: "quotaOutcome", type: "select", label: "Authorisation outcome",
          options: "authorised,quota_unavailable,refused", required: true },
      ],
      rules: [
        { when: { var: "quotaOutcome", op: "eq", value: "authorised" },
          then: { var: "visaAuthNumber", op: "present" },
          message: "An authorised visa has an authorisation number — it is what the visa application is filed against" },
      ],
    } },
    { id: "d_quota", type: "decision", label: "Visa Authorisation Granted?", config: { branches: [
      { var: "quotaOutcome", op: "eq", value: "authorised", key: "authorised" },
      { var: "quotaOutcome", op: "eq", value: "quota_unavailable", key: "no_quota" },
      { var: "quotaOutcome", op: "eq", value: "refused", key: "refused" },
    ] } },

    // THE ONE THAT CANNOT BE FIXED LATER.
    //
    // For many profession and nationality combinations the qualification must be verified through the
    // Saudi Professional Verification Programme BEFORE the visa is stamped. It cannot be done after
    // entry: the employee is already in the country, on a permit that should not have been issued,
    // and the only remedies are exit and re-entry or a change of profession. Modelling it after
    // arrival — or not at all, which is what the workflow did — is the expensive kind of wrong.
    //
    // Not every hire needs it, which is exactly why it is a step rather than an assumption. The
    // officer records whether it applies, and a "not required" is a decision somebody made and
    // signed rather than a silence.
    { id: "prof_verify", type: "task", label: "Professional Qualification Verification", config: {
      assigneeRole: "pro_officer", govCenter: "SVP", slaHours: 336,
      checklist: [
        doc("svp_checked", "Checked whether this profession and nationality require verification"),
        doc("svp_docs", "Degree or trade certificate submitted for verification"),
      ],
      captures: [
        { var: "verificationOutcome", type: "select", label: "Verification outcome",
          options: "verified,not_required,rejected", required: true },
        { var: "verificationRef", type: "text", label: "Verification reference", required: false },
      ],
      rules: [
        { when: { var: "verificationOutcome", op: "eq", value: "verified" },
          then: { var: "verificationRef", op: "present" },
          message: "A completed verification has a reference — the visa application is checked against it" },
      ],
    } },
    { id: "d_verify", type: "decision", label: "Qualification Verified?", config: { branches: [
      { var: "verificationOutcome", op: "eq", value: "verified", key: "verified" },
      { var: "verificationOutcome", op: "eq", value: "not_required", key: "not_required" },
      { var: "verificationOutcome", op: "eq", value: "rejected", key: "rejected" },
    ] } },

    // The pre-departure medical, taken at an approved Wafid centre in the employee's own country.
    // A separate fact from the medical taken after arrival, which the workflow did have: this one
    // gates the visa, and an unfit result ends the hire before anybody buys a ticket.
    { id: "medical_wafid", type: "task", label: "Wafid Medical Examination", config: {
      assigneeRole: "pro_officer", govCenter: "Wafid", slaHours: 240,
      checklist: [
        doc("wafid_booked", "Examination booked at an approved Wafid centre in the home country"),
        doc("wafid_report", "Medical report received and readable"),
      ],
      captures: [
        { var: "wafidOutcome", type: "select", label: "Medical outcome",
          options: "fit,repeat,unfit", required: true },
        { var: "wafidCentre", type: "text", label: "Wafid centre" },
        { var: "wafidDate", type: "date", label: "Examination date" },
      ],
    } },
    { id: "d_wafid", type: "decision", label: "Medically Fit to Travel?", config: { branches: [
      { var: "wafidOutcome", op: "eq", value: "fit", key: "fit" },
      { var: "wafidOutcome", op: "eq", value: "repeat", key: "repeat" },
      { var: "wafidOutcome", op: "eq", value: "unfit", key: "unfit" },
    ] } },

    { id: "visa_apply", type: "task", label: "Work Visa Application", config: {
      assigneeRole: "pro_officer", govCenter: "MOFA", slaHours: 240,
      captures: [
        // WHAT HAPPENS WHEN THE GOVERNMENT SAYS NO.
        //
        // Every government step had exactly two ways out: complete it, or leave it open forever. A
        // rejected visa had to be recorded as a SUCCESSFUL application — the only button there was —
        // and the run carried on issuing a Work Visa document for a visa that does not exist.
        { var: "visaOutcome", type: "select", label: "Application outcome",
          options: "issued,more_info,rejected", required: true },
        // OPTIONAL AS A FIELD, MANDATORY AS A RULE — the same shape as extensionAgreed above.
        //
        // A capture counts as required unless it says otherwise, which is right for the fields a step
        // exists to collect and exactly wrong here: these only exist when the answer is yes. Left as
        // plain required fields, a rejection could not be recorded at all — the step demanded a visa
        // number before it would accept "rejected" — so every refusal branch routed correctly and
        // none of them could be reached. The rule below keeps them mandatory on success.
        { var: "visaNumber", type: "text", label: "Visa number", required: false },
        { var: "visaExpiry", type: "date", label: "Visa expiry", required: false },
      ],
      rules: [
        { when: { var: "visaOutcome", op: "eq", value: "issued" },
          then: { var: "visaNumber", op: "present" },
          message: "An issued visa has a number — it is what the Work Visa record is created from" },
        { when: { var: "visaOutcome", op: "eq", value: "issued" },
          then: { var: "visaExpiry", op: "present" },
          message: "An issued visa has an expiry — entry after it lapses is refused at the border" },
      ],
    } },
    { id: "d_visa", type: "decision", label: "Visa Issued?", config: { branches: [
      { var: "visaOutcome", op: "eq", value: "issued", key: "issued" },
      { var: "visaOutcome", op: "eq", value: "more_info", key: "more_info" },
      { var: "visaOutcome", op: "eq", value: "rejected", key: "rejected" },
    ] } },
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
        { var: "arrivalOutcome", type: "select", label: "Arrival outcome",
          options: "cleared,not_arrived,biometrics_failed,medical_failed", required: true },
        // THE DATE THE RESIDENCE CLOCK STARTS. The workflow recorded that somebody had arrived but
        // never when, and the 90 days to issue an Iqama are counted from exactly this date.
        //
        // Required of everybody who actually arrived and of nobody who did not — "has not arrived" is
        // precisely the case with no entry date, and demanding one would make that outcome impossible
        // to record. The rule below asks for it in every case where the employee is in the country.
        { var: "entryDate", type: "date", label: "Date of entry to the Kingdom", required: false },
      ],
      rules: [
        { when: { var: "arrivalOutcome", op: "in", value: "cleared,biometrics_failed,medical_failed" },
          then: { var: "entryDate", op: "present" },
          message: "The employee is in the Kingdom, so there is a date of entry — the 90 days to issue the Iqama are counted from it" },
      ],
    } },
    // The two failures here are not the same failure. Biometrics can be retaken and the employee is
    // in the country either way; failing the medical AFTER arrival ends the residence application
    // altogether, and the run has to stop rather than loop.
    { id: "d_arrival", type: "decision", label: "Arrival Cleared?", config: { branches: [
      { var: "arrivalOutcome", op: "eq", value: "cleared", key: "cleared" },
      { var: "arrivalOutcome", op: "eq", value: "not_arrived", key: "not_arrived" },
      { var: "arrivalOutcome", op: "eq", value: "biometrics_failed", key: "retry_biometrics" },
      { var: "arrivalOutcome", op: "eq", value: "medical_failed", key: "medical_failed" },
    ] } },
    // The Iqama's own step, and it could not have had one before: under the old order the residence
    // permit was issued at arrival, so its number was captured there — weeks before the work permit
    // that has to precede it. Now it is applied for after the permit exists, which is when anybody
    // actually has a number to record.
    // A TRANSFERRED EMPLOYEE HAD NO RESIDENCE DOCUMENT ON FILE AT ALL.
    //
    // Not issuing a new Iqama was right — the transfer keeps the existing one, with its number and
    // its original expiry, and the employer on it is updated. But recording nothing meant the new
    // employer inherited a renewal liability, and any fines already on it, with no visibility of
    // either. This captures what is already there rather than pretending to issue it.
    { id: "iqama_transfer", type: "task", label: "Iqama Sponsorship Transfer", config: {
      assigneeRole: "pro_officer", govCenter: "Muqeem", slaHours: 168,
      checklist: [
        doc("sponsor_updated", "Employer updated on the Iqama record"),
        doc("fines_checked", "Outstanding fines and renewal liability checked before accepting the transfer"),
      ],
      captures: [
        { var: "iqamaTransferOutcome", type: "select", label: "Transfer outcome",
          options: "updated,refused", required: true },
        { var: "iqamaNumber", type: "text", label: "Existing Iqama number", required: false },
        { var: "iqamaExpiry", type: "date", label: "Existing Iqama expiry (unchanged by the transfer)", required: false },
      ],
      rules: [
        { when: { var: "iqamaTransferOutcome", op: "eq", value: "updated" },
          then: { var: "iqamaNumber", op: "present" },
          message: "A completed transfer records the Iqama it moved — the number does not change, but the record has to exist" },
        { when: { var: "iqamaTransferOutcome", op: "eq", value: "updated" },
          then: { var: "iqamaExpiry", op: "present" },
          message: "The existing expiry travels with the transfer — it is the renewal liability the new employer inherits" },
      ],
    } },
    { id: "d_iqama_tr", type: "decision", label: "Sponsorship Updated?", config: { branches: [
      { var: "iqamaTransferOutcome", op: "eq", value: "updated", key: "updated" },
      { var: "iqamaTransferOutcome", op: "eq", value: "refused", key: "refused" },
    ] } },
    { id: "iqama_task", type: "task", label: "Iqama Issuance", config: {
      assigneeRole: "pro_officer", govCenter: "Muqeem", slaHours: 168,
      checklist: [
        doc("iqama_fees", "Iqama fees and levy paid"),
        doc("iqama_insurance", "Health insurance active and covering the residence period"),
      ],
      // Counted from the date of entry captured at arrival — the days and the source come from the
      // Iqama entry in Country Rules, so the regulation is maintained in one place rather than
      // restated in every workflow that touches it.
      statutory: [
        { key: "iqama_90", docType: "Iqama", from: "entryDate",
          label: "Iqama must be issued within 90 days of entry" },
      ],
      captures: [
        { var: "iqamaOutcome", type: "select", label: "Issuance outcome",
          options: "issued,more_info,refused", required: true },
        { var: "iqamaNumber", type: "text", label: "Iqama number", required: false },
        { var: "iqamaExpiry", type: "date", label: "Iqama expiry", required: false },
      ],
    } },
    { id: "d_iqama_out", type: "decision", label: "Iqama Issued?", config: { branches: [
      { var: "iqamaOutcome", op: "eq", value: "issued", key: "issued" },
      { var: "iqamaOutcome", op: "eq", value: "more_info", key: "more_info" },
      { var: "iqamaOutcome", op: "eq", value: "refused", key: "refused" },
    ] } },
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

    // ── where a government refusal goes ──────────────────────────────────────────────────────
    //
    // A REFUSAL CANNOT GO STRAIGHT TO AN END NODE, which is why this is a step and not an arrow.
    //
    // By the time a work permit is refused the run has usually already issued a visa, a health
    // insurance policy and an authenticated contract. Ending quietly leaves all of them live on the
    // record of somebody who will never join — and live records are not inert here: they sit in the
    // compliance screens, they count toward the establishment's obligations, and the renewal engine
    // chases them, year after year, for an employee who does not exist. The mess outlives the hire.
    //
    // So the run stops at a desk. Somebody withdraws what was issued, tells the candidate, and says
    // in writing what was refused and why, before the run is allowed to end.
    { id: "gov_stop", type: "task", label: "Government Refusal — Withdraw and Close", config: {
      assigneeRole: "pro_officer", slaHours: 72, priority: "high",
      checklist: [
        doc("stop_withdraw", "Documents already issued for this hire withdrawn or cancelled"),
        doc("stop_notify", "Candidate and hiring manager told the hire cannot proceed"),
        doc("stop_quota", "Visa authorisation or quota released if it was consumed"),
      ],
      captures: [
        { var: "stopStage", type: "text", label: "Which step was refused", required: false },
        // `text` rather than `textarea`: the console renders every type it does not recognise as a
        // single-line input, so asking for one would promise a box that never appears.
        { var: "stopReason", type: "text", label: "What the authority said", required: true },
      ],
    } },
    { id: "end_gov_stop", type: "end", label: "Stopped — Government Refusal", config: {} },

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
        { var: "permitOutcome", type: "select", label: "Issuance outcome",
          options: "issued,more_info,refused", required: true },
        // OPTIONAL AS A FIELD, MANDATORY AS A RULE — the same shape as extensionAgreed above.
        //
        // A capture counts as required unless it says otherwise, which is right for the fields a step
        // exists to collect and exactly wrong here: these only exist when the answer is yes. Left as
        // plain required fields, a rejection could not be recorded at all — the step demanded a visa
        // number before it would accept "rejected" — so every refusal branch routed correctly and
        // none of them could be reached. The rule below keeps them mandatory on success.
        { var: "permitNumber", type: "text", label: "Work permit number", required: false },
        { var: "permitExpiry", type: "date", label: "Work permit expiry", required: false },
      ],
      rules: [
        { when: { var: "permitOutcome", op: "eq", value: "issued" },
          then: { var: "permitNumber", op: "present" },
          message: "An issued work permit has a number" },
        { when: { var: "permitOutcome", op: "eq", value: "issued" },
          then: { var: "permitExpiry", op: "present" },
          message: "An issued work permit has an expiry — it is what the renewal is driven from" },
      ],
    } },
    { id: "d_permit_out", type: "decision", label: "Work Permit Issued?", config: { branches: [
      { var: "permitOutcome", op: "eq", value: "issued", key: "issued" },
      { var: "permitOutcome", op: "eq", value: "more_info", key: "more_info" },
      { var: "permitOutcome", op: "eq", value: "refused", key: "refused" },
    ] } },
    { id: "d_iqama", type: "decision", label: "Residence Permit Required?", config: { branches: [
      { var: "hiringType", op: "eq", value: "expat_new_hire", key: "new_hire" },
      { var: "hiringType", op: "eq", value: "expat_transfer", key: "transfer" },
    ] } },
    { id: "permit_doc", type: "issue_document", label: "Work Permit",
      config: { docType: "Work Permit", numberVar: "permitNumber", expiryVar: "permitExpiry" } },

    { id: "split", type: "parallel_split", label: "Set Up In Parallel", config: {} },
    { id: "payroll", type: "task", label: "Payroll & WPS Setup", config: { assigneeRole: "accountant", slaHours: 72,
      checklist: [doc("wps_registered", "Registered on WPS"), doc("bank_ok", "Salary account confirmed")],
      captures: [
        { var: "gosiOutcome", type: "select", label: "GOSI registration outcome",
          options: "registered,pending,failed", required: true },
        { var: "gosiNumber", type: "text", label: "GOSI number", required: false },
        // Genuinely optional: the statutory clock falls back to the expected joining date when
        // payroll has not set one yet.
        { var: "firstWageDue", type: "date", label: "First wage due date", required: false },
      ],
      rules: [
        { when: { var: "gosiOutcome", op: "eq", value: "registered" },
          then: { var: "gosiNumber", op: "present" },
          message: "A completed GOSI registration has a number — it is what the registration record is created from" },
      ],
      // TWO DEADLINES ON ONE STEP, which is why a step carries a list of them.
      //
      // GOSI is the one that cannot be recovered: a non-Saudi cannot be registered retroactively, so
      // the 15th of the following month is not a date after which this is late — it is a date after
      // which it can no longer be done properly at all.
      statutory: [
        { key: "gosi_15th", docType: "GOSI Employee Registration", rule: "by_15th_next_month",
          from: "expectedJoining",
          label: "GOSI registration due by the 15th of the month after work starts" },
        // The wage date if payroll has set one, otherwise the expected joining date — the clock
        // starts from the best date the run actually holds rather than not starting at all.
        { key: "wps_30", days: 30, from: "firstWageDue,expectedJoining",
          label: "First salary paid and uploaded to WPS within 30 days",
          basis: "Wage Protection System — MHRSD" },
      ] } },
    // THIS ONE DOES NOT LEAVE THE PARALLEL BLOCK, and that is deliberate.
    //
    // Payroll runs inside the parallel setup, and the join downstream waits for all three branches.
    // A branch that exits to the stop path never arrives at the join, so the other two sit waiting
    // for a run that has already ended — a stranded join is a worse failure than the one being
    // modelled. A GOSI problem therefore goes back to the step that owns it: the run stays alive, the
    // reason is recorded, the SLA clock keeps running, and the statutory deadline below is what makes
    // the delay impossible to ignore.
    { id: "d_gosi", type: "decision", label: "GOSI Registration Complete?", config: { branches: [
      { var: "gosiOutcome", op: "eq", value: "registered", key: "registered" },
      { var: "gosiOutcome", op: "eq", value: "pending", key: "pending" },
      { var: "gosiOutcome", op: "eq", value: "failed", key: "failed" },
    ] } },
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

        // COUNTED, because Article 53 caps the TOTAL. Each wait adds its own days to probationDaysUsed,
    // which is the only way a decision can ask how much probation this employee has actually served.
    { id: "probation", type: "delay", label: "Probation (90 days)", config: { days: 90, accumulateInto: "probationDaysUsed" } },
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
      rules: [
        { when: { var: "probationOutcome", op: "eq", value: "extend" },
          then: { var: "extensionAgreed", op: "eq", value: "yes" },
          message: "Probation can only be extended by prior written agreement with the employee (Labour Law art. 53)" },
      ],
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
        // Article 53 allows the period to be extended only by prior WRITTEN agreement. Optional as a
        // field and mandatory as a rule: it is only asked of somebody who is extending.
        { var: "extensionAgreed", type: "select", label: "Written agreement to extend obtained?", options: "yes,no", required: false },
        // Free text rather than a reason code: at this end of the process the specifics are the
        // point, and a fixed list would be answered with whichever option is least wrong.
        { var: "probationNotes", type: "text", label: "Reason for the decision" },
        { var: "probationEffective", type: "date", label: "Effective from" },
      ] } },
    // 180 DAYS IN ALL CASES. The extend branch used to loop straight back into another 30 days with
    // no counter and no exit — a fourth, tenth or fiftieth extension was possible, and each one past
    // the ceiling is unlawful. An employee who has already served 180 days cannot be extended again,
    // so the only answers left are the two this step exists to choose between.
    { id: "d_cap", type: "decision", label: "Probation Limit Reached?", config: { branches: [
      { var: "probationDaysUsed", op: "gte", value: 180, key: "capped" },
    ] } },
    { id: "prob_final", type: "task", label: "Probation Limit Reached — Confirm or End", config: {
      assigneeRole: "hr_officer", slaHours: 48,
      checklist: [doc("cap_explained", "Employee told the probation period has run to its statutory limit")],
      captures: [{ var: "probationFinal", type: "select", label: "Confirm or end employment?", options: "confirm,terminate" }],
    } },
    { id: "d_final", type: "decision", label: "Final Outcome", config: { branches: [
      { var: "probationFinal", op: "eq", value: "confirm", key: "confirm" },
      { var: "probationFinal", op: "eq", value: "terminate", key: "terminate" },
    ] } },
    { id: "d_prob", type: "decision", label: "Confirmed?", config: { branches: [
      { var: "probationOutcome", op: "eq", value: "yes", key: "yes" },
      { var: "probationOutcome", op: "eq", value: "extend", key: "extend" },
      { var: "probationOutcome", op: "eq", value: "no", key: "no" },
    ] } },
        { id: "extend", type: "delay", label: "Extend Probation (30 days)", config: { days: 30, accumulateInto: "probationDaysUsed" } },
    { id: "end_term", type: "end", label: "Not Confirmed — Termination", config: {} },
    { id: "confirm_appr", type: "approval", label: "Employee Confirmation Approval", config: {
      approverRole: "admin", slaHours: 72,
      title: "Confirm this employee at the end of probation",
    } },
        // The last step before the employee is confirmed, and it was configured with nothing at all: no
    // channel, no recipient, no wording. Unreachable until delays resumed, so it had never run — and
    // the first person to clear probation would have been confirmed in silence.
    { id: "notify", type: "notify", label: "Notify Employee", config: {
      channel: "Email",
      to: "{{ email }}",
      subject: "Your employment is confirmed",
      template: "Your probation period is complete and your employment is confirmed. Your HR team will be in touch with the paperwork.",
    } },
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

    // THE ORDER THE GOVERNMENT ACTUALLY REQUIRES.
    //
    // Every branch now reaches health insurance before anything else it gates. CCHI cover starts from
    // the employment relationship for a Saudi and from entry or transfer for an expatriate, and a
    // residence permit cannot be granted without a policy covering it — so insurance sits on the
    // trunk, ahead of the contract, rather than in the parallel block ten nodes later where the Iqama
    // had already been issued against a policy that did not exist.
    e("d_hiring", "insurance_task", "saudi"),
    e("d_hiring", "visa_auth", "new_hire"),
    e("d_hiring", "qiwa_req", "transfer"),
    e("d_hiring", "hold", "else"),
    e("hold", "d_hiring"),                    // fixed by a person, then asked again

    // The pre-visa sequence, in the order the government requires it. Authorisation before
    // verification before medical before application: each one is a precondition of the next, and
    // the verification in the middle is the one that cannot be done later at all.
    e("visa_auth", "d_quota"),
    e("d_quota", "prof_verify", "authorised"),
    // No quota is not a refusal — it is a wait for a band or a quota request, and the file stays
    // open at the desk that can chase it.
    e("d_quota", "visa_auth", "no_quota"),
    e("d_quota", "gov_stop", "refused"),
    e("d_quota", "visa_auth", "else"),

    e("prof_verify", "d_verify"),
    e("d_verify", "medical_wafid", "verified"),
    e("d_verify", "medical_wafid", "not_required"),
    e("d_verify", "gov_stop", "rejected"),
    e("d_verify", "prof_verify", "else"),

    e("medical_wafid", "d_wafid"),
    e("d_wafid", "visa_apply", "fit"),
    e("d_wafid", "medical_wafid", "repeat"),
    e("d_wafid", "gov_stop", "unfit"),
    e("d_wafid", "medical_wafid", "else"),

    e("visa_apply", "d_visa"),
    e("d_visa", "visa_doc", "issued"),
    e("d_visa", "visa_apply", "more_info"),   // the file goes back to the officer, not forward
    e("d_visa", "gov_stop", "rejected"),
    e("d_visa", "visa_apply", "else"),
    e("visa_doc", "arrival"),

    e("arrival", "d_arrival"),
    e("d_arrival", "insurance_task", "cleared"),
    e("d_arrival", "arrival", "not_arrived"),
    e("d_arrival", "arrival", "retry_biometrics"),
    e("d_arrival", "gov_stop", "medical_failed"),
    e("d_arrival", "arrival", "else"),

    e("qiwa_req", "d_transfer"),
    e("d_transfer", "insurance_task", "approved"),
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

    e("insurance_task", "insurance"),
    e("insurance", "contract"),

    e("contract", "contract_doc"),
    // A WORK PERMIT IS AN EXPATRIATE INSTRUMENT. The three hiring types converged before this node,
    // so a Saudi national was issued one — a document that does not exist for them, on their record,
    // with an expiry the compliance screens would then chase. Saudis go straight to the shared setup.
    e("contract_doc", "d_permit"),
    e("d_permit", "permit_task", "expat_new"),
    e("d_permit", "permit_task", "expat_move"),
    e("d_permit", "split", "saudi"),
    e("d_permit", "permit_task", "else"),     // unknown: issue it and let a person correct the profile
    e("permit_task", "d_permit_out"),
    e("d_permit_out", "permit_doc", "issued"),
    e("d_permit_out", "permit_task", "more_info"),
    e("d_permit_out", "gov_stop", "refused"),
    e("d_permit_out", "permit_task", "else"),
    // MHRSD issues the work licence and then directs the establishment to the Passport Office for the
    // residence permit — the permit is a precondition of the Iqama, and the graph had them the other
    // way round, so every expatriate run recorded an Iqama whose real counterpart could not exist yet.
    e("permit_doc", "d_iqama"),
    e("d_iqama", "iqama_task", "new_hire"),
    e("iqama_task", "d_iqama_out"),
    e("d_iqama_out", "iqama_doc", "issued"),
    e("d_iqama_out", "iqama_task", "more_info"),
    e("d_iqama_out", "gov_stop", "refused"),
    e("d_iqama_out", "iqama_task", "else"),
    // A transfer keeps the Iqama it already has: the number and expiry stay, and the employer on it
    // is updated rather than a new one issued. Recording a fresh Iqama here would invent a document.
    e("d_iqama", "iqama_transfer", "transfer"),
    e("iqama_transfer", "d_iqama_tr"),
    e("d_iqama_tr", "iqama_doc", "updated"),
    e("d_iqama_tr", "gov_stop", "refused"),
    e("d_iqama_tr", "iqama_transfer", "else"),
    e("d_iqama", "split", "else"),
    e("iqama_doc", "split"),
    e("split", "payroll"), e("split", "access"), e("split", "assets"),
    e("payroll", "d_gosi"),
    e("d_gosi", "gosi_doc", "registered"),
    e("d_gosi", "payroll", "pending"),
    e("d_gosi", "payroll", "failed"),        // stays inside the block — see d_gosi
    e("d_gosi", "payroll", "else"),
    e("gosi_doc", "join"),
    e("access", "join"), e("assets", "join"),
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
    e("d_prob", "d_cap", "extend"),
    e("d_cap", "prob_final", "capped"),      // 180 days served — extending again would be unlawful
    e("d_cap", "extend", "else"),
    e("prob_final", "d_final"),
    e("d_final", "confirm_appr", "confirm"),
    e("d_final", "end_term", "terminate"),
    e("d_final", "prob_final", "else"),      // no answer is not a termination
    e("d_prob", "end_term", "no"),
    e("d_prob", "prob_review", "else"),       // no answer is not a termination
    e("extend", "prob_review"),

    e("confirm_appr", "notify", "approve"),
    e("confirm_appr", "end_term", "reject"),
    e("notify", "end_ok"),

    e("gov_stop", "end_gov_stop"),
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
