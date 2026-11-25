/**
 * THE BUSINESS SETUP WORKFLOW, BUILT FROM THE FLOWCHARTS.
 *
 *   npx tsx scripts/build-business-setup.ts            # says what it would do
 *   npx tsx scripts/build-business-setup.ts --apply    # does it
 *   npx tsx scripts/build-business-setup.ts --apply --start   # …and opens one case to look at
 *
 * Thirty steps and five gates, from "deal won" to "PRO takes over", drawn from the Nov 2026 visual
 * flowcharts. Written as a script rather than clicked into the builder because thirty steps by hand
 * is a morning's work that cannot be reviewed, repeated, or corrected in one place — and this WILL
 * be corrected, repeatedly, the moment somebody walks a real case through it.
 *
 * THE STANDARD ROUTE ONLY. The chart's Acquisition and Trading routes repeat the whole document
 * phase per extra company, which needs a fan-out the engine does not have yet; the managers/Iqama
 * add-on needs the same. Those are deliberately absent rather than half-present — a branch that
 * exists but does nothing is worse than one that is openly missing.
 *
 * WHAT MAKES THE GATES REAL. Every approval here names a role DIFFERENT from the role that did the
 * work, and the engine already refuses an approval from whoever completed the steps it certifies
 * ("Nobody approves their own work"). So the chart's golden rule is enforced by the engine, not by
 * this template remembering to ask — this only has to avoid handing both jobs to one role.
 *
 * Re-runnable: it replaces its own template and leaves everything else alone.
 */
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("build-business-setup");
const APPLY = process.argv.includes("--apply");
const START = process.argv.includes("--start");

const TPL_NAME = "Business Setup";
const SVC_NAME = "Business Setup";

/**
 * The roles the chart names, and what each is based on.
 *
 * The three that APPROVE are based on Admin, because the PRO Officer preset has no Approve
 * permission — a QA Reviewer who cannot approve is a gate nobody can open, and that would be
 * discovered on a real case rather than here.
 */
// Reference only since the collapse below — kept because it is what the chart asks for, and the
// day the firm staffs these it is the list to install.
const ROLES = [
  { id: "account_manager", label: "Account Manager", base: "PRO Officer", color: "#7C00FF", desc: "Owns the client relationship through the setup" },
  { id: "setup_exec", label: "Setup Executive", base: "PRO Officer", color: "#0284C7", desc: "Does the document and government work" },
  { id: "qa_reviewer", label: "QA Reviewer", base: "Admin", color: "#0E9355", desc: "Checks other people's work at the gates" },
  { id: "ops_manager", label: "Operations Manager", base: "Admin", color: "#B8860B", desc: "Approves the route and the final delivery" },
  { id: "pro_lead", label: "PRO Lead", base: "Admin", color: "#C0353A", desc: "Accepts the handover into the PRO module" },
];
// Finance is the built-in `accountant`, which somebody already holds. BD is the built-in `sales`.

/**
 * THE CHART'S FIVE ROLES, MAPPED ONTO THE ONES THIS FIRM ACTUALLY STAFFS.
 *
 * The chart was drawn for a bigger firm than the one running it. Here there is one Admin, one
 * Accountant and three PRO Officers — and `User.roleId` holds exactly ONE role, so no one person
 * can be QA Reviewer, Operations Manager and PRO Lead at once. Three of the five ladders could
 * never be staffed at all, and an APPROVAL on an unstaffed role does not queue politely: nothing
 * can clear it and the run stops there.
 *
 * So the ladder collapses onto who exists. The controls survive the collapse: no gate is approved
 * by the role that did the work in front of it (checked below), and the engine still refuses an
 * approval from the PERSON who did the work it certifies. Give these roles real holders and the
 * map can be unwound a line at a time.
 */
const ROLE_MAP: Record<string, string> = {
  account_manager: "pro_officer",
  setup_exec: "pro_officer",
  qa_reviewer: "admin",
  ops_manager: "admin",
  pro_lead: "admin",
};
const real = (role: string) => ROLE_MAP[role] ?? role;

type N = { id: string; type: string; label: string; config?: any };
type E = { from: string; to: string; condition?: string };

/**
 * A checklist item nobody is blocked by. Still listed, still tickable, still printed on the step —
 * it simply does not hold the step shut.
 *
 * The identity pack is the case for it: five documents that arrive over days from a client who is
 * abroad, in an order nobody controls. Required, they stopped the officer recording ANYTHING about
 * the step until the last one landed — so the work that had been done was invisible, and the step
 * sat red against its SLA for a reason that was not the officer's doing.
 */
const optional = (labels: string[]) => labels.map(label => ({ label, required: false }));

const task = (id: string, label: string, role: string, slaHours: number, instructions: string, captures: any[] = [], checklist: (string | { label: string; required?: boolean })[] = [], docType?: string): N => ({
  id, type: "task", label,
  config: {
    assigneeRole: real(role), slaHours, instructions,
    // WHAT DOCUMENT THIS STEP IS ABOUT. Without it the engine files nothing, and captures named
    // "crNumber" and "crExpiry" stay run variables - true of the run and invisible to Compliance.
    // BOTH KEYS: stepDocType() takes the name only when the source says it was chosen deliberately,
    // because the other source is a run variable and a step must not file against whatever the run
    // happened to be carrying.
    ...(docType ? { docTypeSource: "specific", docType } : {}),
    ...(captures.length ? { captures } : {}),
    // Required items block completion, which is what "the checklist must be 100%" means in the chart.
    // A plain string is required — that is how every one of these was written and how they stay.
    // `optional([...])` is the opt-out, for a pack that genuinely arrives piece by piece.
    ...(checklist.length ? { checklist: checklist.map(c => {
      const label = typeof c === "string" ? c : c.label;
      return { key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label, required: typeof c === "string" ? true : c.required !== false };
    }) } : {}),
  },
});
const gate = (id: string, label: string, role: string, slaHours: number, instructions: string): N =>
  ({ id, type: "approval", label, config: { approverRole: real(role), assigneeRole: real(role), slaHours, instructions } });

/** A branch point. First matching branch wins; anything else falls to the "else" wire. */
const decision = (id: string, label: string, branches: any[]): N => ({ id, type: "decision", label, config: { branches } });
/** A decision with nothing to decide: where a lane's two paths meet so the join sees ONE edge. */
const funnel = (id: string, label: string): N => ({ id, type: "decision", label, config: { branches: [] } });

/**
 * One company bought rather than formed: find it, check it, pay for it, own it.
 *
 * Variables are prefixed per lane. Three lanes writing `targetName` would be three answers in one
 * box, and the last one to finish would be the only one anybody could read afterwards.
 */
const acquireLane = (p: string, what: string): N[] => [
  task(`${p}_find`, `Find a ${what} to acquire`, "setup_exec", 240,
    `Identify a ${what} that fits the structure and is clean enough to buy. Record what it is before any money is discussed.`,
    [text(`${p}Name`, "Target company"), text(`${p}Cr`, "Registration number"), text(`${p}Country`, "Country of registration")]),
  task(`${p}_dd`, `Due diligence — ${what}`, "setup_exec", 120,
    "Check what you are buying. An inherited liability becomes the client's on the day ownership transfers, and it is not recoverable afterwards.",
    [pick(`${p}DdOutcome`, "Diligence outcome", "clear,issues")],
    ["Ownership chain verified", "No outstanding liabilities or disputes", "Licences and filings current", "Audited financials obtained"]),
  task(`${p}_spa`, `Agree the price and sign the SPA — ${what}`, "setup_exec", 168,
    "Price agreed and the share purchase agreement signed by both sides. Nothing is paid before diligence came back clear.",
    [money(`${p}Price`, "Agreed price"), date(`${p}SpaOn`, "SPA signed on")]),
  task(`${p}_transfer`, `Transfer ownership — ${what}`, "setup_exec", 240,
    "Ownership moved and the registry updated. The case cannot use a company the client does not legally own yet.",
    [date(`${p}TransferredOn`, "Ownership transferred on")],
    ["Registry updated", "Transfer documents on file"]),
];
/** The lane's internal wiring, ending on its funnel. */
const laneEdges = (p: string): E[] => [
  { from: `${p}_find`, to: `${p}_dd` },
  { from: `${p}_dd`, to: `${p}_spa` },
  { from: `${p}_spa`, to: `${p}_transfer` },
  { from: `${p}_transfer`, to: `${p}_ready` },
];

const text = (v: string, label: string, required = true) => ({ var: v, label, type: "text", required });
const date = (v: string, label: string, required = true) => ({ var: v, label, type: "date", required });
const money = (v: string, label: string, required = true) => ({ var: v, label, type: "money", required });
const pick = (v: string, label: string, options: string, required = true) => ({ var: v, label, type: "select", options, required });
const area = (v: string, label: string, required = true) => ({ var: v, label, type: "textarea", required });

const nodes: N[] = [
  { id: "start", type: "start", label: "Deal won" },

  /**
   * Stage 0 · the advance.
   *
   * THERE IS NO "CONFIRM THE ADVANCE" STEP, and that is deliberate. The first draft had Finance
   * record the payment and then Finance approve the gate — which is the one arrangement the whole
   * chart exists to forbid, and it would have stalled every case on day one. The chart is clear:
   * the WORK at this stage is BD closing the deal, which happens in the CRM, and Finance only
   * SIGNS. So the run opens straight onto the gate.
   *
   * The money itself is already recorded where money belongs — the invoice and its payment — and
   * copying it onto a workflow step would create a second set of figures to disagree with the first.
   */
  task("chase", "Chase the advance", "account_manager", 72,
    "Day 3, day 7, day 14. Record what they said — a case stuck here with no notes is one nobody can pick up.",
    [date("chasedOn", "Contacted on"), { var: "chaseNote", label: "What they said", type: "textarea", required: true }]),
  gate("g0", "G0 — Finance confirms the advance", "accountant", 24,
    "Finance only. Approve once the 50% advance is in the bank and matched to this client. Reject to send it back for chasing — onboarding cannot start until this is approved."),

  // ── Stage A · onboarding ───────────────────────────────────────────────────────────────────
  /*
   * THERE IS NO "ASSIGN THE TEAM" STEP, and that is deliberate — the same lesson as Stage 0 above.
   *
   * The chart has a step where a manager names the Account Manager and the Setup Executive, and it
   * was built as two required text boxes. Nothing in the system ever read either one: two names were
   * typed onto the run and the next step still went to nobody, which is worse than not asking,
   * because it looks like the assignment has been made.
   *
   * Assignment is not an event in the case, it is a FACT ABOUT THE CLIENT — `Company.roleOwners`,
   * which is what `pickAssignee` reads to send each step to a person. It is set once on the client
   * record and holds for every case that client ever has. A step that asks for it again each time
   * is a reminder with no output, so the run goes straight from the advance to the onboarding work.
   */
  /*
   * THREE ANSWERS BETWEEN THEM, AND NOT ONE MORE.
   *
   * These two steps asked for five things: the group, the portal invite date, the call date, the
   * date the minutes were shared, and the minutes themselves as an uploaded DOCUMENT. Four of the
   * five were dates nobody reads afterwards — "minutes shared on" in particular records the
   * administration of the work rather than the work — and the minutes arriving as a file meant the
   * step could not be completed until somebody had made one, for a call that had already happened.
   *
   * What is left is what somebody actually wants to know later: was the group made, when was the
   * meeting, and what was said. The minutes are TYPED and OPTIONAL — a call with nothing worth
   * recording must not hold the case open, and a required box is how empty boxes full of "." get
   * written.
   */
  task("access", "WhatsApp group and portal access", "account_manager", 24,
    "Create the group and send the portal invitation.",
    [pick("groupCreated", "WhatsApp group created?", "yes,no")]),
  task("call", "Onboarding call", "account_manager", 72,
    "Hold the call and write up what was agreed. Target for the whole of onboarding is 3 working days from the advance.",
    [date("callOn", "Meeting date"), area("minutes", "Meeting minutes", false)]),
  task("kyc", "KYC and client documents", "account_manager", 72,
    "Collect and check the identity pack. Tick each document as it arrives — none of them holds this step shut, because they come in over days. G1 is where the pack is checked as complete.",
    [pick("kickoffConfirmed", "Client confirms kick-off?", "yes,no")],
    // NOT REQUIRED. The identity pack comes from a client who is usually abroad, a document at a
    // time; demanding all five before the step could be completed meant the step recorded nothing
    // for days and breached an SLA over somebody else's post. They are still listed and still
    // ticked off one by one — G1 is where somebody checks the pack is genuinely complete, and that
    // is a person's judgement, not a count of five boxes.
    optional(["Passport copy — every shareholder", "National ID or residency", "Parent company profile", "Signed power of attorney", "Screening result"])),
  gate("g1", "G1 — onboarding complete", "qa_reviewer", 48,
    "Check the onboarding checklist is genuinely complete and the client has confirmed kick-off. Not the person who collected it."),

  // ── Stage B · the route ────────────────────────────────────────────────────────────────────
  /**
   * THE THREE ANSWERS THE ROUTE IS MADE OF.
   *
   * The rule the firm works to: a SERVICE company needs one parent. A TRADING company needs one
   * parent AND two shell companies. Whatever the client does not already have must be acquired
   * first, and the setup cannot proceed until it is.
   *
   * It used to be one dropdown — `routeChosen`, four options, filled in by whoever was looking —
   * and the branch it implied was a sentence on G2 telling the approver to reject the case and
   * raise the rest by hand. Asked as three facts instead, the arithmetic is the system's: required
   * is 1 parent (+ 2 shells for trading), missing is required minus held, and the decisions below
   * open exactly that much work. Nobody has to remember the rule at eleven at night.
   */
  task("parent", "Check the structure and the parent company", "account_manager", 72,
    "What is the client setting up, and what do they already hold? A service company needs one parent. A trading company needs a parent and two shell companies. Anything missing is acquired before the licence route starts, so answer from documents, not from what the client says they can get.",
    [
      pick("companyType", "Company type", "service,trading"),
      pick("suitableParent", "Suitable foreign parent?", "yes,no"),
      text("parentCountry", "Parent country", false),
      pick("goodStanding", "In good standing?", "yes,no"),
      // Trading only. Left optional so a service case is not made to answer it — the shell lanes
      // below test companyType FIRST, so a blank here can never be read as "none available".
      pick("shellsAvailable", "Shell companies already held (trading only)", "0,1,2", false),
    ],
    ["Parent company CR", "Audited financials"]),
  task("route", "Route summary and cost", "account_manager", 48,
    "Write the route down and get the extra cost agreed IN WRITING before G2 — including one acquisition fee per company that has to be bought. A cost agreed on a call is a dispute later.",
    [pick("routeChosen", "Route", "standard,acquisition,trading,acquisition_and_trading"), money("extraCost", "Extra cost agreed"), date("costAgreedOn", "Client agreed in writing on")],
    ["Signed cost approval"]),
  gate("g2", "G2 — Operations Manager approves the route", "ops_manager", 48,
    "Approve the route and the cost. Approving here releases any acquisitions the structure needs, so the money is signed off BEFORE a target is approached — reject if the acquisition fees are not agreed in writing."),

  /**
   * ── Stage B2 · the companies the structure requires ──────────────────────────────────────
   *
   * Three lanes, run at the same time: the parent, shell 1, shell 2. Each lane asks first whether
   * that company is already held and skips itself if it is, so a service client with a parent walks
   * through all three in one tick and never sees a step.
   *
   * WHY THREE FIXED LANES AND NOT A LOOP. The engine cannot fan a branch out over a list — the
   * reason this whole route was left unbuilt the first time. It does not need to: the rule fixes
   * the count at one parent and two shells, never more, so what looked like fan-out is three
   * ordinary branches drawn once.
   *
   * WHY EACH LANE ENDS IN A FUNNEL. A join waits for one arrival per EDGE pointing at it. Wire both
   * a lane's skip and its acquired path straight into the join and the join wants four arrivals from
   * three lanes and the case stops there forever. The funnel is a decision with no branches: both
   * paths meet on it, and it offers the join a single edge.
   */
  { id: "struct_split", type: "parallel_split", label: "Companies this structure needs" },

  decision("d_parent", "Parent company already held?", [
    { var: "suitableParent", op: "eq", value: "yes", key: "skip" },
  ]),
  ...acquireLane("acqp", "parent company"),
  funnel("acqp_ready", "Parent company in place"),

  // companyType FIRST in both shell lanes: a service case leaves `shellsAvailable` blank, and a
  // blank read as a number is NaN, which is not >= 1 — so without this the engine would send every
  // service client off to buy two shell companies they do not need.
  decision("d_shell1", "First shell company already held?", [
    { var: "companyType", op: "eq", value: "service", key: "skip" },
    { var: "shellsAvailable", op: "gte", value: 1, key: "skip" },
  ]),
  ...acquireLane("acqs1", "first shell company"),
  funnel("acqs1_ready", "First shell company in place"),

  decision("d_shell2", "Second shell company already held?", [
    { var: "companyType", op: "eq", value: "service", key: "skip" },
    { var: "shellsAvailable", op: "gte", value: 2, key: "skip" },
  ]),
  ...acquireLane("acqs2", "second shell company"),
  funnel("acqs2_ready", "Second shell company in place"),

  { id: "struct_join", type: "parallel_join", label: "Structure complete" },

  // ── Phase 1 · documents and attestation ────────────────────────────────────────────────────
  task("checklist_sent", "Send the document checklist", "account_manager", 24,
    "Send the client the list for the route that was approved.",
    [date("checklistSentOn", "Sent on")]),
  task("upload", "Client uploads the drafts", "account_manager", 120,
    "Chase until everything on the list is in the portal. This step is where cases sit longest — the client usually does not know they are the holdup.",
    [], ["Every document on the route's list"]),
  task("precheck", "Pre-check the documents", "setup_exec", 48,
    "Check names, spellings and numbers against each other BEFORE anything is signed or stamped. A mismatch found here costs an email; found after attestation it costs the whole pack.",
    [pick("precheckOk", "Pre-check OK?", "yes,no"), { var: "precheckNotes", label: "What is wrong", type: "textarea", required: false, showIf: { var: "precheckOk", equals: "no" } }]),
  task("sign", "Sign resolution, POA and GM letter", "setup_exec", 72,
    "Get the three signed by the right signatories.",
    [date("signedOn", "Signed on")],
    ["Board resolution", "Power of attorney", "GM appointment letter"]),
  task("notarise", "Notarise in the home country", "setup_exec", 120,
    "Notary in the parent's own country.",
    [text("notary", "Notary"), date("notarisedOn", "Notarised on"), money("notaryFee", "Notary fee")],
    ["Notarised set"]),
  task("attest", "Attestation — apostille or embassy", "setup_exec", 240,
    "Apostille countries: apostille at home. Everyone else: home ministry of foreign affairs, then the Saudi embassy. The parent's country decides which — do not guess.",
    [pick("attestPath", "Which path?", "apostille,mofa_then_embassy"), text("attestRef", "Reference"), date("attestedOn", "Attested on"), money("attestFee", "Attestation fee")],
    ["Attested set"]),
  task("courier", "Courier the originals to Saudi", "setup_exec", 120,
    "Log the airway bill. An original in transit with no AWB is an original nobody can find.",
    [text("courierName", "Courier"), text("awb", "AWB number"), date("sentOn", "Sent on")]),
  task("mofa_sa", "Saudi MOFA authentication", "setup_exec", 120,
    "If the pack needs it.",
    [pick("mofaNeeded", "Needed?", "yes,no"), text("mofaRef", "Reference", false), money("mofaFee", "Fee", false)]),
  task("translate", "Arabic translation and proofread", "setup_exec", 72,
    "Translate and have somebody OTHER than the translator read it. Names in Arabic are where this goes wrong.",
    [text("translator", "Translator"), text("proofreader", "Proofread by")],
    ["Arabic set"]),
  gate("g3", "G3 — QA approves the document pack", "qa_reviewer", 48,
    "Check the whole pack: attested, translated, and consistent with itself. Names and numbers must match across every document."),

  // ── Phase 2 · licence to CR ────────────────────────────────────────────────────────────────
  task("datasheet", "Client approves the data sheet", "account_manager", 72,
    "The client signs off the details that will go on the licence and the CR. Everything after this is checked against it.",
    [date("dataSheetOn", "Approved on")],
    ["Signed data sheet"]),
  task("tradename", "Trade name reservation", "setup_exec", 48,
    "Reserve the name and note when the reservation expires.",
    [text("tradeName", "Name reserved"), text("tradeNameRef", "Reference"), date("tradeNameExpiry", "Reservation expires"), money("tradeNameFee", "Fee")],
    ["Name certificate"]),
  task("misa_apply", "MISA investment licence application", "setup_exec", 72,
    "Submit and record the application number.",
    [text("misaAppNo", "Application number"), date("misaSubmittedOn", "Submitted on")],
    ["Submission receipt"]),
  task("misa_query", "Answer any MISA query", "setup_exec", 48,
    "Two working days. A query left sitting is the single commonest cause of a setup running over.",
    [pick("queryRaised", "Query raised?", "yes,no"), { var: "queryText", label: "What they asked", type: "textarea", required: false }, date("answeredOn", "Answered on", false)]),
  task("misa_fee", "Pay the government fee", "setup_exec", 48,
    "Record the Sadad reference and what was actually paid.",
    [text("sadadNo", "Sadad reference"), money("misaFee", "Government fee")],
    ["Payment receipt"]),
  task("licence", "Investment licence issued", "setup_exec", 48,
    "Record the licence and its expiry — the expiry is what puts it on the renewal calendar.",
    [text("licenceNo", "Licence number"), date("licenceIssued", "Issued on"), date("licenceExpiry", "Expires on")],
    ["Investment licence"]),
  task("aoa", "Articles of Association", "setup_exec", 120,
    "Draft, sign and notarise the Articles.",
    [date("aoaOn", "Notarised on"), money("aoaFee", "Fee")],
    ["Signed Articles of Association"]),
  /**
   * THE STEP THAT FINISHES THE SETUP, and the only one whose answers leave the run.
   *
   * `docType` plus a `purpose` on each capture is what turns three typed answers into the client's
   * Commercial Registration: the engine files the certificate, and filing it is what adopts the
   * number as their MAIN CR and lifts the `crPending` waiver. Without the two, all 44 steps could
   * be completed and the client record would still read `cr: null, crPending: true` — registered
   * in fact, and a company-being-formed everywhere the system looks.
   */
  task("cr", "CR application and issue", "setup_exec", 120,
    "Apply for and collect the Commercial Registration.",
    [{ ...text("crNumber", "CR number"), purpose: "number" },
     { ...date("crIssued", "Issued on"), purpose: "issue" },
     { ...date("crExpiry", "Expires on"), purpose: "expiry" }],
    ["Commercial Registration"],
    "Commercial Registration"),
  task("cr_check", "Check the CR against the data sheet", "setup_exec", 24,
    "Every field, against the sheet the client signed. The client must never be the one who finds the mistake.",
    [pick("crMatches", "Everything matches?", "yes,no"), { var: "crMismatch", label: "What is wrong", type: "textarea", required: false, showIf: { var: "crMatches", equals: "no" } }]),
  task("balance", "Balance invoice paid", "accountant", 72,
    "The remaining 50%, matched to the bank, before the CR is handed over.",
    [money("balanceAmount", "Balance received"), text("balanceRef", "Bank reference")],
    ["Bank credit advice"]),
  gate("g4", "G4 — CR correct, balance paid", "qa_reviewer", 48,
    "The chart wants QA AND the Operations Manager here. The engine takes one approver, so this is QA; the Operations Manager signs at the handover below."),

  // ── Close ──────────────────────────────────────────────────────────────────────────────────
  task("deliver", "Deliver the CR to the client", "account_manager", 48,
    "Hand over and record who received it.",
    [date("deliveredOn", "Delivered on"), text("deliveredTo", "Delivered to")],
    ["Handover acknowledgement"]),
  gate("close", "Close — PRO Lead accepts the handover", "pro_lead", 48,
    "The PRO team takes the client on from here. Approve only when you have what you need to run it."),
  { id: "end", type: "end", label: "Setup complete" },
];

const edges: E[] = [
  { from: "start", to: "g0" },
  { from: "g0", to: "access", condition: "approve" },
  { from: "g0", to: "chase", condition: "reject" },
  { from: "chase", to: "g0" },
  { from: "access", to: "call" },
  { from: "call", to: "kyc" },
  { from: "kyc", to: "g1" },
  { from: "g1", to: "parent", condition: "approve" },
  { from: "g1", to: "kyc", condition: "reject" },
  { from: "parent", to: "route" },
  { from: "route", to: "g2" },
  { from: "g2", to: "struct_split", condition: "approve" },
  { from: "g2", to: "route", condition: "reject" },

  // The three lanes. Each decision has exactly two ways out — skip to the lane's funnel, or walk
  // the lane — and each lane reaches the join through ONE edge, which is what the join counts.
  { from: "struct_split", to: "d_parent" },
  { from: "struct_split", to: "d_shell1" },
  { from: "struct_split", to: "d_shell2" },
  { from: "d_parent", to: "acqp_ready", condition: "skip" },
  { from: "d_parent", to: "acqp_find", condition: "else" },
  { from: "d_shell1", to: "acqs1_ready", condition: "skip" },
  { from: "d_shell1", to: "acqs1_find", condition: "else" },
  { from: "d_shell2", to: "acqs2_ready", condition: "skip" },
  { from: "d_shell2", to: "acqs2_find", condition: "else" },
  ...laneEdges("acqp"),
  ...laneEdges("acqs1"),
  ...laneEdges("acqs2"),
  { from: "acqp_ready", to: "struct_join" },
  { from: "acqs1_ready", to: "struct_join" },
  { from: "acqs2_ready", to: "struct_join" },
  { from: "struct_join", to: "checklist_sent" },
  { from: "checklist_sent", to: "upload" },
  { from: "upload", to: "precheck" },
  { from: "precheck", to: "sign" },
  { from: "sign", to: "notarise" },
  { from: "notarise", to: "attest" },
  { from: "attest", to: "courier" },
  { from: "courier", to: "mofa_sa" },
  { from: "mofa_sa", to: "translate" },
  { from: "translate", to: "g3" },
  { from: "g3", to: "datasheet", condition: "approve" },
  { from: "g3", to: "precheck", condition: "reject" },
  { from: "datasheet", to: "tradename" },
  { from: "tradename", to: "misa_apply" },
  { from: "misa_apply", to: "misa_query" },
  { from: "misa_query", to: "misa_fee" },
  { from: "misa_fee", to: "licence" },
  { from: "licence", to: "aoa" },
  { from: "aoa", to: "cr" },
  { from: "cr", to: "cr_check" },
  { from: "cr_check", to: "balance" },
  { from: "balance", to: "g4" },
  { from: "g4", to: "deliver", condition: "approve" },
  { from: "g4", to: "cr_check", condition: "reject" },
  { from: "deliver", to: "close" },
  { from: "close", to: "end", condition: "approve" },
  { from: "close", to: "deliver", condition: "reject" },
];

const graph = { nodes, edges };
const gates = nodes.filter(n => n.type === "approval");
const steps = nodes.filter(n => n.type === "task");

console.log(`${nodes.length} nodes · ${steps.length} work steps · ${gates.length} gates · ${edges.length} edges\n`);
for (const n of nodes) {
  if (n.type === "start" || n.type === "end") continue;
  const r = n.config?.approverRole ?? n.config?.assigneeRole ?? "—";
  console.log(`  ${n.type === "approval" ? "GATE " : "step "}${String(n.label).padEnd(44)} ${r}`);
}

/**
 * ── DOES THE STRUCTURE BRANCH DO WHAT THE RULE SAYS? ────────────────────────────────────────────
 *
 * The rule in one line: a service company needs a parent; a trading company needs a parent and two
 * shells; whatever is not held is acquired. Six cases cover it, and they are asserted here rather
 * than discovered on a client, because a wrong branch does not look like a bug — it looks like an
 * officer being asked to buy two companies nobody needs, and they will do it.
 *
 * This repeats the engine's own comparison deliberately: a copy that drifts fails loudly here,
 * whereas importing the engine would make this agree with itself by construction and prove nothing.
 */
const branchKey = (branches: any[], vars: Record<string, any>): string => {
  for (const b of branches) {
    const l = vars[b.var], r = b.value;
    const ok = b.op === "eq" ? String(l) === String(r) : b.op === "gte" ? Number(l) >= Number(r) : false;
    if (ok) return b.key;
  }
  return "else";
};
const lanesOpened = (vars: Record<string, any>) =>
  ["d_parent", "d_shell1", "d_shell2"]
    .filter(id => branchKey(nodes.find(n => n.id === id)!.config.branches, vars) !== "skip").length;

const CASES: [string, Record<string, any>, number][] = [
  ["service, has a parent", { companyType: "service", suitableParent: "yes" }, 0],
  ["service, no parent", { companyType: "service", suitableParent: "no" }, 1],
  ["trading, parent + 2 shells", { companyType: "trading", suitableParent: "yes", shellsAvailable: "2" }, 0],
  ["trading, parent + 1 shell", { companyType: "trading", suitableParent: "yes", shellsAvailable: "1" }, 1],
  ["trading, parent only", { companyType: "trading", suitableParent: "yes", shellsAvailable: "0" }, 2],
  ["trading, nothing held", { companyType: "trading", suitableParent: "no", shellsAvailable: "0" }, 3],
  // Unanswered on a trading case must mean "none", never "all there": asking for work that turns
  // out to be unnecessary is recoverable, skipping a company the licence needs is not.
  ["trading, shells left blank", { companyType: "trading", suitableParent: "yes" }, 2],
];
let bad = 0;
console.log("\nacquisitions the branch opens:");
for (const [name, vars, want] of CASES) {
  const got = lanesOpened(vars);
  if (got !== want) bad++;
  console.log(`  ${got === want ? "ok  " : "FAIL"} ${name.padEnd(28)} ${got} (expected ${want})`);
}

// A join waits for one arrival per edge pointing at it, so a miscounted lane hangs the case with no
// error anywhere. Asserted because it is invisible until a real client is stuck in it.
const joinIn = edges.filter(e => e.to === "struct_join").length;
if (joinIn !== 3) { console.log(`  FAIL struct_join has ${joinIn} incoming edges, not 3 — the case would hang there`); bad++; }
const ids = new Set(nodes.map(n => n.id));
for (const e of edges) if (!ids.has(e.from) || !ids.has(e.to)) { console.log(`  FAIL edge ${e.from} → ${e.to} points at a node that does not exist`); bad++; }
if (bad) { console.error(`\n${bad} check(s) failed — refusing to write this template.`); process.exit(1); }

// Nobody signs off their own work: the engine enforces it per PERSON, but a template that gives a
// gate the same role as the step before it guarantees a stall. Checked here, while it can be fixed.
const clash = gates.filter(g => {
  const upstream = edges.filter(e => e.to === g.id).map(e => nodes.find(n => n.id === e.from));
  return upstream.some(u => u?.config?.assigneeRole && u.config.assigneeRole === g.config.approverRole);
});
console.log(clash.length
  ? `\n!! ${clash.length} gate(s) approved by the same role that did the work: ${clash.map(g => g.label).join(", ")}`
  : `\nno gate is approved by the role that did the work in front of it`);

// ── is every role on this template actually held by somebody? ──────────────────────────────────
//
// The check the first version did not do. It INSTALLED five new roles and nobody noticed that no
// user held any of them, so a real case opened and every step waited on an empty desk. A role with
// no holder is not a staffing detail, it is a stall — so it is reported here, before the template
// is written, and a dry run reports it too.
const used = [...new Set(nodes.map(n => n.config?.approverRole ?? n.config?.assigneeRole).filter(Boolean) as string[])];
console.log("\nwho holds each role on this template:");
let unheld = 0;
for (const r of used.sort()) {
  const holders = await prisma.user.findMany({ where: { roleId: r, status: "active", type: "staff" }, select: { name: true } });
  const steps = nodes.filter(n => (n.config?.approverRole ?? n.config?.assigneeRole) === r);
  const gatesOn = steps.filter(n => n.type === "approval").length;
  if (!holders.length) unheld++;
  console.log(`  ${r.padEnd(14)} ${String(steps.length).padStart(2)} step${steps.length === 1 ? " " : "s"}${gatesOn ? ` (${gatesOn} gate${gatesOn === 1 ? "" : "s"})` : ""}  ${holders.length ? holders.map(h => h.name).join(", ") : "!! NOBODY — these steps will wait on an empty desk"}`);
}
if (unheld) console.log(`!! ${unheld} role(s) have no holder. Assign someone, or map the role onto one that is staffed in ROLE_MAP above.`);

if (!APPLY) {
  console.log("\ndry run — nothing written. Add --apply.");
  process.exit(0);
}

// ── template ───────────────────────────────────────────────────────────────────────────────────
const prior = await prisma.workflowTemplate.findFirst({ where: { name: TPL_NAME } });
const tpl = prior
  ? await prisma.workflowTemplate.update({ where: { id: prior.id }, data: { graph: graph as any, entityType: "company", trigger: "manual", country: "SA" } })
  : await prisma.workflowTemplate.create({
      data: { name: TPL_NAME, description: "Deal won to CR delivered, five gates. Standard route.", graph: graph as any, entityType: "company", trigger: "manual", country: "SA", active: false, version: 1 } as any,
    });
console.log(`template: ${prior ? "updated" : "created"} ${tpl.id}`);

// ── the service that starts it ─────────────────────────────────────────────────────────────────
const svc = await prisma.serviceItem.findFirst({ where: { name: SVC_NAME } });
const service = svc
  ? await prisma.serviceItem.update({ where: { id: svc.id }, data: { workflowId: tpl.id } })
  : await prisma.serviceItem.create({ data: { name: SVC_NAME, workflowId: tpl.id, serviceFee: 0, sla: "45 working days" } as any });
console.log(`service: "${service.name}" → this workflow (so an accepted quotation starts a case on its own)`);

if (START) {
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  const run = await startInstance(tpl.id, { title: `Business setup — ${co?.name ?? "a client"}`, companyId: co?.id ?? null, clientName: co?.name ?? null });
  console.log(`\nopened one case: ${run?.id} for ${co?.name} — its first step is waiting in My Tasks`);
}

await prisma.$disconnect();
console.log("\nThe template is saved INACTIVE. Open it in the Workflow Builder, read it, and activate it there —");
console.log("activating is where the engine checks every role and reference, and it should be a person's decision.");
process.exit(0);
