/**
 * Build the Commercial Registration Renewal workflow for the Saudi pack.
 *
 * Written from the specification in docs/planned-services.js — the one the client reviewed and
 * marked up on 2026-09-09, including the "MISA licence is valid" item they added to the gate check.
 * That spec is deliberately written in the engine's own vocabulary, so this is a configuration job
 * rather than a fresh design. Where it is not, this comment says so.
 *
 * THE SECOND COMPANY-LEVEL DOCUMENT TYPE. Commercial Registration belongs to the company, like the
 * MISA licence and unlike the seven employee documents — so it files against the client with no
 * employeeId and supersedes at company level. It also becomes the pack's first Ministry of Commerce
 * document; the authority is created here.
 *
 * THREE PLACES THE SPEC MEETS THE ENGINE AND HAS TO BE FILLED IN:
 *
 *   The spec lists nine steps and no decisions, but two of those steps — "Clear the Blocking Item"
 *   and "Portal Blocked — Resolve" — are only ever reached when something goes wrong. A step with no
 *   decision in front of it is either always run or never run, so three decision nodes are added.
 *   They branch on fields the spec already records; they invent no new judgement.
 *
 *   Except one. "Renew on the MC Portal" records a reference and a date, neither of which says
 *   whether the portal accepted it — so there is nothing to branch on, and step 7 is unreachable.
 *   A `portalOutcome` field is added for that and only that.
 *
 *   The CR NUMBER DOES NOT CHANGE on renewal, only the expiry date. The issue step still carries
 *   numberVar: the run is a renewal, carrying documentId, so it archives the old expiry into the
 *   CR's history and writes the new one — recording the number keeps the two in step rather than
 *   leaving the engine to assume it.
 *
 * ORDER OF PAYMENT AND PORTAL follows the spec: chamber, then MC fees, then the portal. That is the
 * OPPOSITE of the change the client made to MISA on 2026-09-09, where submission moved ahead of
 * payment. Left as the spec has it, because they reviewed this one and changed the other; worth
 * confirming with them rather than inferring.
 *
 * Left as a DRAFT. Activating it arms the nightly job against real client registrations.
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const TEMPLATE = "Commercial Registration Renewal";
const DOC_TYPE = "Commercial Registration";
const LEAD_DAYS = 45; // the spec: "Starts by itself 45 days before the CR falls due."

const slugOf = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

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
  // ── the authority ───────────────────────────────────────────────────────────────────────────
  const mc = await prisma.govCenter.findFirst({ where: { name: "MC", country: COUNTRY } });
  if (!mc) {
    await prisma.govCenter.create({ data: { name: "MC", sub: "Ministry of Commerce", country: COUNTRY, color: "#0F766E", bg: "#ECFDF7", packKey: "sa.authority.mc" } as any });
    console.log("created authority MC (Ministry of Commerce)");
  } else console.log("authority MC already present");

  // ── the registration itself ─────────────────────────────────────────────────────────────────
  const existingType = await prisma.documentType.findFirst({ where: { name: DOC_TYPE } });
  const typeData = {
    name: DOC_TYPE, country: COUNTRY, subjectKind: "company", authority: "MC",
    leadDays: LEAD_DAYS, neverExpires: false, requiresApproval: false,
    packKey: "sa.doctype.commercial-registration",
  };
  const docType = existingType
    ? await prisma.documentType.update({ where: { id: existingType.id }, data: typeData as any })
    : await prisma.documentType.create({ data: typeData as any });
  console.log(`${existingType ? "updated" : "created"} document type "${DOC_TYPE}" (company-subject, lead ${LEAD_DAYS}d) [${docType.id}]`);

  // ── the two lists, kept in the pack rather than in the graph ─────────────────────────────────
  const gateRule = await upsertChecklist("CR pre-renewal gate check", [
    { key: "zakat_current", label: "ZATCA / Zakat certificate current" },
    { key: "gosi_current", label: "GOSI certificate current" },
    { key: "chamber_status", label: "Chamber membership status" },
    { key: "nitaqat_band", label: "Nitaqat band permits government services" },
    { key: "national_address", label: "National address valid" },
    { key: "mc_violations", label: "No outstanding MC violations" },
    { key: "cr_data", label: "CR data still correct" },
    { key: "misa_licence", label: "MISA licence is valid" }, // added by the client, 2026-09-09
  ]);
  const followUpRule = await upsertChecklist("CR follow-up registrations", [
    { key: "misa_details", label: "MISA licence details" },
    { key: "qiwa_establishment", label: "Qiwa / MHRSD establishment file" },
    { key: "gosi_establishment", label: "GOSI establishment record" },
    { key: "vat_registration", label: "VAT registration" },
    { key: "bank_mandate", label: "Bank mandate" },
    { key: "municipal_licence", label: "Municipal licence" },
  ]);

  // ── the graph ───────────────────────────────────────────────────────────────────────────────
  const nodes: any[] = [
    { id: "start", type: "start", label: "Renewal Created", config: {} },

    { id: "gate", type: "task", label: "Pre-Renewal Gate Check", config: {
      assigneeRole: "pro_officer", slaHours: 48, govCenter: "MC",
      checklistSource: "dynamic", checklistRuleId: gateRule,
      instructions:
        "Confirm the company is clear before anything is filed. The Commercial Register Law of April 2026 replaced annual renewal with an annual confirmation of the register's data — confirm with the client which their portal is asking for. The steps are the same either way.",
      captures: [
        { var: "gateOutcome", type: "select", label: "Is the company clear to renew?", options: "ready,blocked" },
        { var: "blockReason", type: "text", label: "What is blocking it?", required: false },
      ],
      rules: [
        { when: { var: "gateOutcome", op: "eq", value: "blocked" }, then: { var: "blockReason", op: "present" },
          message: "Say what is blocking the renewal — the hold is worked from this note, and \"blocked\" with no reason tells the next officer nothing." },
      ],
    } },

    { id: "d_gate", type: "decision", label: "Clear to Renew?", config: {
      branches: [
        { var: "gateOutcome", op: "eq", value: "ready", key: "ready" },
        { var: "gateOutcome", op: "eq", value: "blocked", key: "blocked" },
      ],
    } },

    { id: "hold_fix", type: "task", label: "Clear the Blocking Item", config: {
      assigneeRole: "pro_officer", slaHours: 168,
      instructions: "Clear whatever the gate check found — settle Zakat or GOSI, renew the chamber membership, correct the national address or the register's data — then send it back for re-check.",
      captures: [{ var: "blockCleared", type: "text", label: "What was done to clear it" }],
    } },

    { id: "fee", type: "task", label: "Confirm Fee and Client Approval", config: {
      assigneeRole: "pro_officer", slaHours: 48,
      instructions: "Confirm the term, the ministry fee and the chamber subscription tier, put the total to the client, and record their answer here. Nothing is paid until this step says approved.",
      captures: [
        { var: "renewalTerm", type: "select", label: "Renewal term", options: "1_year,2_years,3_years,5_years" },
        { var: "mcFee", type: "number", label: "MC fee (SAR)" },
        { var: "chamberTier", type: "text", label: "Chamber subscription tier" },
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

    { id: "chamber", type: "task", label: "Renew Chamber Membership", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      instructions: "The chamber membership has to be current before the ministry will renew the register. Renew it first and keep the receipt.",
      captures: [
        { var: "chamberReceipt", type: "text", label: "Chamber receipt number" },
        { var: "chamberPaidOn", type: "date", label: "Date paid" },
      ],
    } },

    { id: "pay", type: "task", label: "Pay MC Fees", config: {
      assigneeRole: "accountant", slaHours: 48,
      instructions: "Pay the approved ministry fee and record the receipt. The receipt is filed with the renewal and sent to the client with the invoice.",
      captures: [
        { var: "paymentRef", type: "text", label: "Payment reference" },
        { var: "paymentDate", type: "date", label: "Date paid" },
      ],
    } },

    { id: "portal", type: "task", label: "Renew on the MC Portal", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "MC",
      instructions: "File the renewal — or the annual confirmation — on the ministry portal. If it refuses, say so here rather than retrying blind; the refusal is worked as its own step.",
      captures: [
        { var: "portalRef", type: "text", label: "Portal reference" },
        { var: "submittedOn", type: "date", label: "Date submitted" },
        // NOT IN THE SPEC. Added because "Portal Blocked — Resolve" is otherwise unreachable —
        // there is no recorded fact that says whether the portal accepted the filing.
        { var: "portalOutcome", type: "select", label: "Did the portal accept it?", options: "renewed,blocked" },
      ],
    } },

    { id: "d_portal", type: "decision", label: "Portal Accepted?", config: {
      branches: [
        { var: "portalOutcome", op: "eq", value: "renewed", key: "renewed" },
        { var: "portalOutcome", op: "eq", value: "blocked", key: "blocked" },
      ],
    } },

    { id: "portal_blocked", type: "task", label: "Portal Blocked — Resolve", config: {
      assigneeRole: "pro_officer", slaHours: 72, govCenter: "MC",
      instructions: "Clear whatever the portal refused on, then file again. The fees are already paid — this is not a fresh renewal, it is the same one going back in.",
      captures: [{ var: "portalRefusal", type: "text", label: "What the portal refused on" }],
    } },

    { id: "record", type: "task", label: "Record the Renewed CR", config: {
      assigneeRole: "pro_officer", slaHours: 24, govCenter: "MC",
      instructions: "The CR number does not change on renewal — only the expiry does. Record both so the register and the file agree.",
      captures: [
        { var: "crNumber", type: "text", label: "CR number (unchanged)", purpose: "number" },
        { var: "newExpiry", type: "date", label: "New expiry date", purpose: "expiry" },
      ],
    } },

    { id: "issue", type: "issue_document", label: "Commercial Registration", config: {
      docType: DOC_TYPE, numberVar: "crNumber", expiryVar: "newExpiry",
    } },

    { id: "followup", type: "task", label: "Update Related Records", config: {
      assigneeRole: "pro_officer", slaHours: 72,
      checklistSource: "dynamic", checklistRuleId: followUpRule,
      instructions: "Every registration that carries the CR's details has to agree with the renewed register. Left alone they contradict it, and the next renewal inherits the mismatch.",
    } },

    { id: "notify", type: "notify", label: "Tell the Client", config: {
      channel: "Email", to: "{{ clientEmail }}",
      subject: "Your commercial registration has been renewed",
      template: "Your commercial registration {{ crNumber }} has been renewed and is valid until {{ newExpiry }}. The certificate and the payment receipts are on file in your portal.",
    } },

    { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
    { id: "end_declined", type: "end", label: "Not Renewed — Client Declined", config: {} },
  ];

  // EVERY BRANCH CARRIES `op` EXPLICITLY — evalDecision's default arm is `ok = false`, so a branch
  // written as { var, value, key } matches nothing and the decision falls to "else" every time.
  // That is what looped the MISA workflow between its check and its hold step twenty times.
  const edges: any[] = [
    { from: "start", to: "gate" },
    { from: "gate", to: "d_gate" },
    { from: "d_gate", to: "fee", condition: "ready" },
    { from: "d_gate", to: "hold_fix", condition: "blocked" },
    { from: "d_gate", to: "hold_fix", condition: "else" },
    { from: "hold_fix", to: "gate" },
    { from: "fee", to: "d_fee" },
    { from: "d_fee", to: "chamber", condition: "approved" },
    { from: "d_fee", to: "end_declined", condition: "declined" },
    { from: "d_fee", to: "fee", condition: "else" },
    { from: "chamber", to: "pay" },
    { from: "pay", to: "portal" },
    { from: "portal", to: "d_portal" },
    { from: "d_portal", to: "record", condition: "renewed" },
    { from: "d_portal", to: "portal_blocked", condition: "blocked" },
    { from: "d_portal", to: "portal_blocked", condition: "else" },
    { from: "portal_blocked", to: "portal" },
    { from: "record", to: "issue" },
    { from: "issue", to: "followup" },
    { from: "followup", to: "notify" },
    { from: "notify", to: "end_done" },
  ];

  const graph = { nodes, edges };
  const existing = await prisma.workflowTemplate.findFirst({ where: { name: TEMPLATE } });
  const data: any = {
    name: TEMPLATE, country: COUNTRY, entityType: "company",
    trigger: "document_expiry",
    triggerConfig: { docType: DOC_TYPE, days: LEAD_DAYS } as any,
    graph: graph as any,
    packKey: "sa.workflow.commercial-registration-renewal",
    // Draft on purpose. Activating arms the nightly job, which starts real renewals against real
    // client registrations — the user's call, not this script's.
    active: false,
  };
  const tpl = existing
    ? await prisma.workflowTemplate.update({ where: { id: existing.id }, data })
    : await prisma.workflowTemplate.create({ data: { ...data, createdAt: new Date().toISOString() } });

  console.log(`\n${existing ? "updated" : "created"} "${TEMPLATE}"`);
  console.log(`  ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`  trigger: document_expiry on "${DOC_TYPE}" at ${LEAD_DAYS} days`);
  console.log(`  entity: company · country: ${COUNTRY} · active: ${data.active} (draft — activate when you are ready)`);
  console.log(`  template id: ${tpl.id}`);
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
