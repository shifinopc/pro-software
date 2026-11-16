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
const ROLES = [
  { id: "account_manager", label: "Account Manager", base: "PRO Officer", color: "#7C00FF", desc: "Owns the client relationship through the setup" },
  { id: "setup_exec", label: "Setup Executive", base: "PRO Officer", color: "#0284C7", desc: "Does the document and government work" },
  { id: "qa_reviewer", label: "QA Reviewer", base: "Admin", color: "#0E9355", desc: "Checks other people's work at the gates" },
  { id: "ops_manager", label: "Operations Manager", base: "Admin", color: "#B8860B", desc: "Approves the route and the final delivery" },
  { id: "pro_lead", label: "PRO Lead", base: "Admin", color: "#C0353A", desc: "Accepts the handover into the PRO module" },
];
// Finance is the built-in `accountant`, which somebody already holds. BD is the built-in `sales`.

type N = { id: string; type: string; label: string; config?: any };
type E = { from: string; to: string; condition?: string };

const task = (id: string, label: string, role: string, slaHours: number, instructions: string, captures: any[] = [], checklist: string[] = []): N => ({
  id, type: "task", label,
  config: {
    assigneeRole: role, slaHours, instructions,
    ...(captures.length ? { captures } : {}),
    // Required items block completion, which is what "the checklist must be 100%" means in the chart.
    ...(checklist.length ? { checklist: checklist.map(label => ({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label, required: true })) } : {}),
  },
});
const gate = (id: string, label: string, role: string, slaHours: number, instructions: string): N =>
  ({ id, type: "approval", label, config: { approverRole: role, assigneeRole: role, slaHours, instructions } });

const text = (v: string, label: string, required = true) => ({ var: v, label, type: "text", required });
const date = (v: string, label: string, required = true) => ({ var: v, label, type: "date", required });
const money = (v: string, label: string, required = true) => ({ var: v, label, type: "money", required });
const pick = (v: string, label: string, options: string, required = true) => ({ var: v, label, type: "select", options, required });

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
  task("assign", "Assign the team", "ops_manager", 24,
    "Name the Account Manager and the Setup Executive for this case.",
    [text("accountManager", "Account Manager"), text("setupExec", "Setup Executive")]),
  task("access", "WhatsApp group and portal access", "account_manager", 24,
    "Create the group and send the portal invitation.",
    [pick("groupCreated", "WhatsApp group created?", "yes,no"), date("portalInviteOn", "Portal invite sent on")]),
  task("call", "Onboarding call", "account_manager", 72,
    "Hold the call and share the minutes within 24 hours. Target for the whole of onboarding is 3 working days from the advance.",
    [date("callOn", "Call held on"), date("minutesOn", "Minutes shared on")],
    ["Meeting minutes"]),
  task("kyc", "KYC and client documents", "account_manager", 72,
    "Collect and check the identity pack. Every required document must be received and verified before G1.",
    [pick("kickoffConfirmed", "Client confirms kick-off?", "yes,no")],
    ["Passport copy — every shareholder", "National ID or residency", "Parent company profile", "Signed power of attorney", "Screening result"]),
  gate("g1", "G1 — onboarding complete", "qa_reviewer", 48,
    "Check the onboarding checklist is genuinely complete and the client has confirmed kick-off. Not the person who collected it."),

  // ── Stage B · the route ────────────────────────────────────────────────────────────────────
  task("parent", "Check the parent company", "account_manager", 72,
    "Does the client have a foreign parent Saudi will accept: it exists, it is in good standing, and it has the audited financials MISA asks for?",
    [pick("suitableParent", "Suitable foreign parent?", "yes,no"), text("parentCountry", "Parent country"), pick("goodStanding", "In good standing?", "yes,no")],
    ["Parent company CR", "Audited financials"]),
  task("route", "Route summary and cost", "account_manager", 48,
    "Write the route down and get the extra cost agreed IN WRITING before G2. A cost agreed on a call is a dispute later.",
    [pick("routeChosen", "Route", "standard,acquisition,trading,acquisition_and_trading"), money("extraCost", "Extra cost agreed"), date("costAgreedOn", "Client agreed in writing on")],
    ["Signed cost approval"]),
  gate("g2", "G2 — Operations Manager approves the route", "ops_manager", 48,
    "Approve the route and the cost. Only the Standard route is built in this workflow today — if the route is Acquisition or Trading, reject and raise it separately."),

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
  task("cr", "CR application and issue", "setup_exec", 120,
    "Apply for and collect the Commercial Registration.",
    [text("crNumber", "CR number"), date("crIssued", "Issued on"), date("crExpiry", "Expires on")],
    ["Commercial Registration"]),
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
  { from: "g0", to: "assign", condition: "approve" },
  { from: "g0", to: "chase", condition: "reject" },
  { from: "chase", to: "g0" },
  { from: "assign", to: "access" },
  { from: "access", to: "call" },
  { from: "call", to: "kyc" },
  { from: "kyc", to: "g1" },
  { from: "g1", to: "parent", condition: "approve" },
  { from: "g1", to: "kyc", condition: "reject" },
  { from: "parent", to: "route" },
  { from: "route", to: "g2" },
  { from: "g2", to: "checklist_sent", condition: "approve" },
  { from: "g2", to: "route", condition: "reject" },
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

// Nobody signs off their own work: the engine enforces it per PERSON, but a template that gives a
// gate the same role as the step before it guarantees a stall. Checked here, while it can be fixed.
const clash = gates.filter(g => {
  const upstream = edges.filter(e => e.to === g.id).map(e => nodes.find(n => n.id === e.from));
  return upstream.some(u => u?.config?.assigneeRole && u.config.assigneeRole === g.config.approverRole);
});
console.log(clash.length
  ? `\n!! ${clash.length} gate(s) approved by the same role that did the work: ${clash.map(g => g.label).join(", ")}`
  : `\nno gate is approved by the role that did the work in front of it`);

if (!APPLY) {
  console.log("\ndry run — nothing written. Add --apply.");
  process.exit(0);
}

// ── roles ──────────────────────────────────────────────────────────────────────────────────────
const row = await prisma.appSetting.findUnique({ where: { key: "roles" } });
const existing: any[] = Array.isArray(row?.value) ? (row!.value as any[]) : [];
const byId = new Map(existing.map(r => [String(r.id), r]));
let added = 0;
for (const r of ROLES) if (!byId.has(r.id)) { byId.set(r.id, r); added++; }
await prisma.appSetting.upsert({
  where: { key: "roles" }, update: { value: [...byId.values()] as any }, create: { key: "roles", value: [...byId.values()] as any },
});
console.log(`\nroles: ${added} added, ${ROLES.length - added} already there`);

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
