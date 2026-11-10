/**
 * THE BUSINESS SETUP FLOW, AS A RUNNABLE CASE.
 *
 *   npx tsx scripts/try-business-setup.ts            build it and start one case
 *   npx tsx scripts/try-business-setup.ts --delete   remove every trace
 *
 * Built from "Business Setup Workflow — Visual Flowcharts" (9 Nov 2026): all six stages and all
 * five gates, every chart, as drawn. The first cut collapsed each stage into a single step, which
 * proved the ladder and nothing else — chart 4 alone has eight steps, two branches and two rework
 * loops inside the one box it drew.
 *
 * 44 steps, 5 gates, 4 decision forks and 8 rework loops. Every loop the charts draw is wired,
 * because the loops are the difference between a process and a picture of one: an advance that has
 * not arrived, a QA check that finds gaps, a route whose cost is not agreed, a pack the client must
 * correct, a MISA query, an employer withholding consent, a CR that does not match the data sheet.
 * A straight line through the happy path would have silently dropped all eight.
 *
 * What a faithful stage uses, all of it already in the engine:
 *   · checklists per step, each item received / verified / rejected with a file against it
 *   · requireVerification where "received" is not good enough — somebody has to have LOOKED
 *   · captures: the AWB, the carrier, the apostille answer — values the run carries forward
 *   · a decision node for the apostille-or-embassy fork, branching on a captured variable
 *   · govCenter, so a step waiting at MOFA shows up in that authority's queue
 *   · rework loops: the pre-check and G3 both send work BACK, which is what the charts draw and
 *     what a straight line through the happy path would have quietly dropped
 *
 * TWO PEOPLE, because the flow's own golden rule is "the person who does the work never approves
 * their own gate" and the engine enforces it. Work belongs to the setup executive, gates to the
 * reviewer. Neither can finish a case alone, by design.
 *
 * Still deliberately absent, each for a reason worth keeping visible:
 *   · Acquisition and Trading routes — they repeat Phase 1 per extra company and WorkflowInstance
 *     has no parent/child link, so they need a schema decision first
 *   · SLA clocks — whether they pause while waiting on a government body is unanswered, and
 *     guessing here would bake in the wrong answer
 *   · cancel / refund exits — the charts have none; inventing them would hide that gap
 *
 * Refuses any DATABASE_URL that is not on this machine, by host rather than name: the local
 * database here is called `stimespro_live`, so a name check would be no check at all.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { startInstance } from "../src/workflow.js";
import { hashPassword } from "../src/auth.js";

const url = process.env.DATABASE_URL || "";
const host = url.match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  console.error("This creates staff, a workflow template and a live case. Local databases only.");
  process.exit(1);
}

const TAG = "ZZ Business Setup";
const EXEC = `${TAG} Setup Exec`;
const REVIEWER = `${TAG} Reviewer`;

const work = (id: string, label: string, config: any = {}) =>
  ({ id, type: "task", label, config: { assignee: EXEC, ...config } });
const gate = (id: string, label: string) =>
  ({ id, type: "approval", label, config: { assignee: REVIEWER } });

/** What onboarding has to have on file before G1 can pass. */
const KYC = [
  "Passport copies — every shareholder and the GM",
  "Proof of address for each shareholder",
  "Sanctions and PEP screening result",
  "Signed power of attorney",
  "Signed engagement letter",
];

/** The pack chart 4 asks a foreign parent for. Each one is received, then verified, on its own. */
const PACK = [
  "Board resolution to incorporate in KSA",
  "Power of attorney for the appointed GM",
  "GM appointment letter",
  "Parent certificate of incorporation / CR",
  "Parent audited financial statements",
  "Passport copies of the shareholders",
];

function graph() {
  const nodes: any[] = [
    { id: "start", type: "start", label: "Start" },

    // ── Stage 0 — the advance (chart 2, upper half) ─────────────────────────────────────────
    work("s0_case", "Case created — raise the 50% advance invoice", {
      captures: [{ var: "advanceInvoice", label: "Advance invoice number", type: "text" }],
    }),
    gate("g0", "G0 — Finance confirms the 50% advance"),
    work("s0_chase", "Chase the advance — day 3, 7 and 14", {
      instructions: "Invoice {advanceInvoice}. Nothing in Stage A starts until Finance has matched the money to the bank.",
    }),

    // ── Stage A — onboarding (chart 2, lower half) ──────────────────────────────────────────
    work("sa_team", "Assign the Account Manager and the Setup Executive"),
    work("sa_access", "Create the WhatsApp group and the client portal access"),
    work("sa_call", "Onboarding call — share the minutes within 24 hours"),
    work("sa_kyc", "KYC, passports, screening and the signed POA", { checklist: KYC, requireVerification: true }),
    gate("g1", "G1 — QA checks onboarding, client confirms kick-off"),
    work("sa_gaps", "Fix the gaps with the client"),

    // ── Stage B — structuring (chart 3) ─────────────────────────────────────────────────────
    work("sb_assess", "Assess the parent and the package", {
      instructions: "Suitable means the parent exists, is in good standing, AND has the audited financials MISA needs — all three.",
      captures: [
        { var: "suitableParent", label: "Suitable foreign parent?", type: "select", options: ["yes", "no"] },
        { var: "packageType", label: "Package", type: "select", options: ["standard", "trading"] },
      ],
    }),
    { id: "sb_parent", type: "decision", label: "Suitable foreign parent?",
      config: { branches: [{ var: "suitableParent", op: "eq", value: "yes", key: "suitable" }] } },
    work("sb_acquisition", "Acquisition route — choose the country, acquire or incorporate, adopt its documents", {
      instructions: "Its documents become the parent documents, so Phase 1 runs again for that company. Not yet modelled as its own case.",
    }),
    { id: "sb_package", type: "decision", label: "Package = Trading?",
      config: { branches: [{ var: "packageType", op: "eq", value: "trading", key: "trading" }] } },
    work("sb_trading", "Trading route — confirm current MISA conditions, open the two companies, prove presence"),
    work("sb_summary", "Route summary and any extra cost agreed in writing"),
    gate("g2", "G2 — Operations Manager approves the route"),

    // ── Phase 1, as chart 4 actually draws it ────────────────────────────────────────────────
    work("p1_ask", "Send the route-based document checklist", { checklist: PACK }),
    work("p1_upload", "Client uploads the drafts to the portal", {
      checklist: PACK,
      instructions: "Waiting on the client. Chase on day 3, 7 and 14 — the same rhythm Stage 0 uses for the advance.",
    }),
    // The pre-check is a human judgement with two ways out, so it is a task that BRANCHES on its
    // outcome rather than a decision node reading a variable.
    work("p1_precheck", "Pre-check the drafts", {
      checklist: PACK,
      // Received is not enough here: somebody has to have read each one. This is the step that
      // stops a wrong name or an expired passport reaching an embassy.
      requireVerification: true,
      instructions: "Names, spellings and passport numbers must match across every document. Outcome 'fix' sends it back to the client.",
    }),
    work("p1_fix", "Client corrects and re-uploads"),
    work("p1_sign", "Sign the resolution, POA and GM letter"),
    work("p1_notarise", "Notarise in the home country", {
      // The fork below reads this. Captured from the parent's country, by the person who can see it.
      captures: [{ var: "apostille", label: "Is the parent in an Apostille (Hague) country?", type: "select", options: ["yes", "no"] }],
    }),
    {
      id: "p1_route", type: "decision", label: "Apostille country?",
      config: { branches: [{ var: "apostille", op: "eq", value: "yes", key: "apostille" }] },
    },
    work("p1_apostille", "Apostille in the home country"),
    work("p1_legalise", "Home MOFA, then the Saudi Embassy", { govCenter: "Saudi Embassy" }),
    work("p1_courier", "Courier the originals to KSA, log the AWB", {
      captures: [
        { var: "awb", label: "Airway bill number", type: "text" },
        { var: "carrier", label: "Carrier", type: "select", options: ["DHL", "Aramex", "FedEx", "Other"] },
      ],
      instructions: "These are irreplaceable attested originals. The AWB is the only way to find them again.",
    }),
    work("p1_saudi_mofa", "Saudi MOFA authentication, if needed", { govCenter: "Saudi MOFA" }),
    work("p1_translate", "Arabic translation and proofread", { checklist: PACK, requireVerification: true }),
    gate("g3", "G3 — QA approves the full document pack"),
    work("p1_redo", "Fix the mismatch and redo the step"),

    // ── Phase 2 — licence to CR (chart 5) ───────────────────────────────────────────────────
    work("p2_datasheet", "Client approves the data sheet in the portal", {
      instructions: "This is the sheet G4 checks the CR against, so it is the moment to get every spelling right.",
    }),
    work("p2_tradename", "Trade name reservation", { govCenter: "Saudi Business Center" }),
    work("p2_misa", "MISA investment licence application", {
      govCenter: "MISA",
      instructions: "Outcome 'query' if MISA come back with one — it must be answered within 2 working days.",
    }),
    work("p2_query", "Answer the MISA query — within 2 working days", { govCenter: "MISA" }),
    work("p2_fee", "Pay the government fee", {
      captures: [{ var: "govFee", label: "Government fee paid (SAR)", type: "text" }],
    }),
    work("p2_licence", "Investment licence issued", { govCenter: "MISA" }),
    work("p2_aoa", "Articles of Association drafted, signed and approved"),
    work("p2_cr", "CR application — CR issued", { govCenter: "Saudi Business Center" }),

    // ── Managers and Iqama transfer (chart 6) — after the CR, before G4 ─────────────────────
    work("m_confirm", "Confirm the managers named on the CR", {
      captures: [{ var: "managerInKsa", label: "Is the manager already in KSA?", type: "select", options: ["yes", "no"] }],
    }),
    { id: "m_route", type: "decision", label: "Manager already in KSA?",
      config: { branches: [{ var: "managerInKsa", op: "eq", value: "yes", key: "inksa" }] } },
    work("m_visa", "New work visa via the PRO team"),
    work("m_files", "Open the Qiwa, GOSI and Muqeem files", {
      govCenter: "Qiwa",
      instructions: "The company files must be open before any transfer request — Qiwa refuses it otherwise.",
    }),
    work("m_nitaqat", "Check the Nitaqat band and medical insurance"),
    work("m_transfer", "Employment contract and the Qiwa transfer request", {
      govCenter: "Qiwa",
      instructions: "Outcome 'blocked' if the previous employer withholds consent.",
    }),
    work("m_resolve", "Operations Manager resolves the employer consent"),
    work("m_fees", "Pay the fees, manager accepts the contract"),
    work("m_iqama", "Iqama updated and GOSI registration", { govCenter: "Muqeem" }),
    work("m_qa", "QA verifies the Iqama"),

    gate("g4", "G4 — CR matches the data sheet, managers transferred"),
    work("p2_correct", "Raise a correction with the authority", { govCenter: "Saudi Business Center" }),
    work("p2_balance", "Balance paid and Operations Manager sign-off"),
    work("p2_deliver", "Deliver the CR to the client"),

    work("p3", "PRO Lead accepts the handoff — setup case closed"),
    { id: "end", type: "end", label: "Setup complete — handed to PRO" },
  ];

  const edges: any[] = [
    { from: "start", to: "s0_case" },
    { from: "s0_case", to: "g0" },
    { from: "g0", to: "sa_team", condition: "approve" },
    { from: "g0", to: "s0_chase", condition: "reject" },      // not in the bank yet — chase, re-check
    { from: "s0_chase", to: "g0" },

    { from: "sa_team", to: "sa_access" },
    { from: "sa_access", to: "sa_call" },
    { from: "sa_call", to: "sa_kyc" },
    { from: "sa_kyc", to: "g1" },
    { from: "g1", to: "sb_assess", condition: "approve" },
    { from: "g1", to: "sa_gaps", condition: "reject" },
    { from: "sa_gaps", to: "sa_kyc" },                        // re-submit

    { from: "sb_assess", to: "sb_parent" },
    { from: "sb_parent", to: "sb_package", condition: "suitable" },
    { from: "sb_parent", to: "sb_acquisition", condition: "else" },
    { from: "sb_acquisition", to: "sb_package" },             // the chart rejoins here
    { from: "sb_package", to: "sb_trading", condition: "trading" },
    { from: "sb_package", to: "sb_summary", condition: "else" },
    { from: "sb_trading", to: "sb_summary" },
    { from: "sb_summary", to: "g2" },
    { from: "g2", to: "p1_ask", condition: "approve" },
    { from: "g2", to: "sb_summary", condition: "reject" },    // re-agree the route and its cost

    { from: "p1_ask", to: "p1_upload" },
    { from: "p1_upload", to: "p1_precheck" },
    { from: "p1_precheck", to: "p1_sign", condition: "ok" },
    { from: "p1_precheck", to: "p1_fix", condition: "fix" },
    { from: "p1_fix", to: "p1_upload" },                       // back to the client — the chart's loop
    { from: "p1_sign", to: "p1_notarise" },
    { from: "p1_notarise", to: "p1_route" },
    { from: "p1_route", to: "p1_apostille", condition: "apostille" },
    { from: "p1_route", to: "p1_legalise", condition: "else" },
    { from: "p1_apostille", to: "p1_courier" },
    { from: "p1_legalise", to: "p1_courier" },
    { from: "p1_courier", to: "p1_saudi_mofa" },
    { from: "p1_saudi_mofa", to: "p1_translate" },
    { from: "p1_translate", to: "g3" },
    { from: "g3", to: "p2_datasheet", condition: "approve" },
    { from: "g3", to: "p1_redo", condition: "reject" },        // rejection has somewhere to go
    { from: "p1_redo", to: "p1_translate" },

    { from: "p2_datasheet", to: "p2_tradename" },
    { from: "p2_tradename", to: "p2_misa" },
    { from: "p2_misa", to: "p2_fee", condition: "clear" },
    { from: "p2_misa", to: "p2_query", condition: "query" },
    { from: "p2_query", to: "p2_misa" },                       // answered — back to the application
    { from: "p2_fee", to: "p2_licence" },
    { from: "p2_licence", to: "p2_aoa" },
    { from: "p2_aoa", to: "p2_cr" },

    { from: "p2_cr", to: "m_confirm" },
    { from: "m_confirm", to: "m_route" },
    { from: "m_route", to: "m_files", condition: "inksa" },
    { from: "m_route", to: "m_visa", condition: "else" },
    { from: "m_visa", to: "m_files" },
    { from: "m_files", to: "m_nitaqat" },
    { from: "m_nitaqat", to: "m_transfer" },
    { from: "m_transfer", to: "m_fees", condition: "consent" },
    { from: "m_transfer", to: "m_resolve", condition: "blocked" },
    { from: "m_resolve", to: "m_transfer" },                   // retry the transfer request
    { from: "m_fees", to: "m_iqama" },
    { from: "m_iqama", to: "m_qa" },
    { from: "m_qa", to: "g4" },

    { from: "g4", to: "p2_balance", condition: "approve" },
    { from: "g4", to: "p2_correct", condition: "reject" },
    { from: "p2_correct", to: "p2_cr" },                       // reissue the CR
    { from: "p2_balance", to: "p2_deliver" },
    { from: "p2_deliver", to: "p3" },
    { from: "p3", to: "end" },
  ];

  return { nodes, edges };
}

async function sweep() {
  const tpls = await prisma.workflowTemplate.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = tpls.map(t => t.id);
  if (ids.length) {
    const runs = await prisma.workflowInstance.findMany({ where: { templateId: { in: ids } }, select: { id: true } });
    const rids = runs.map(r => r.id);
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: rids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: rids } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { id: { in: rids } } });
    await prisma.workflowTemplate.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "zz-bsetup-" } } });
  return ids.length;
}

async function main() {
  if (process.argv.includes("--delete")) {
    const n = await sweep();
    console.log(n ? `Removed the business-setup fixture (${n} template and its cases).` : "Nothing to remove.");
    return;
  }

  await sweep();
  // Both get a throwaway password so the case can be walked in the console, where it takes two
  // people. Random, written to the gitignored LOCAL-LOGIN.txt and never printed — a terminal's
  // scrollback outlives these accounts, and `--delete` is what they are for.
  const creds: string[] = [];
  const mk = async (name: string, tag: string, role: string) => {
    const pw = randomBytes(12).toString("base64url");
    const email = `zz-bsetup-${tag}@example.invalid`;
    await prisma.user.create({ data: { name, email, roleId: role, status: "active", type: "staff", passwordHash: await hashPassword(pw) } });
    creds.push(`  ${name.padEnd(32)} ${email.padEnd(40)} ${pw}`);
  };
  await mk(EXEC, "exec", "pro_officer");
  await mk(REVIEWER, "reviewer", "admin");
  writeFileSync(resolve(import.meta.dirname, "../../LOCAL-LOGIN.txt"), [
    "BUSINESS SETUP FIXTURE — throwaway logins, local only, not real accounts.",
    "Gitignored. Remove with:  npx tsx scripts/try-business-setup.ts --delete",
    "", "  console  http://localhost:5188", "", ...creds, "",
    `created  ${new Date().toISOString()}`, "",
  ].join("\n"));

  const g = graph();
  const tpl = await prisma.workflowTemplate.create({ data: { name: TAG + " (Standard route)", graph: g } as any });
  const run = await startInstance(tpl.id, { title: TAG + " — Acme Holdings KSA" });
  const open = await prisma.workflowTask.findFirst({ where: { instanceId: run.id, status: "active" }, select: { title: true, assignee: true } });

  const steps = g.nodes.filter((n: any) => n.type === "task").length;
  const gates = g.nodes.filter((n: any) => n.type === "approval").length;
  const forks = g.nodes.filter((n: any) => n.type === "decision").length;
  // A rework edge is one that goes BACKWARDS — to a node declared earlier than its source. That is
  // what a loop is, and counting them by name would miss the next one somebody adds.
  const order = new Map(g.nodes.map((n: any, i: number) => [n.id, i]));
  const loops = g.edges.filter((e: any) => (order.get(e.to) ?? 0) <= (order.get(e.from) ?? 0));
  const withList = (k: string) => g.nodes.filter((n: any) => n.config?.[k]).length;

  console.log(`
Built: ${steps} steps, ${gates} gates, ${forks} decision forks, ${loops.length} rework loops.
  checklists on ${withList("checklist")} steps, captures on ${withList("captures")}, ${withList("govCenter")} named to an authority
  loops back: ${loops.map((e: any) => `${e.from}→${e.to}`).join(", ")}

Case started: "${TAG} — Acme Holdings KSA"
Waiting at:   ${open?.title ?? "(nothing open?)"}
Assigned to:  ${open?.assignee ?? "(unassigned)"}

  work   ${EXEC}
  gates  ${REVIEWER}        logins in LOCAL-LOGIN.txt

Clean up:
  npx tsx scripts/try-business-setup.ts --delete
`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
