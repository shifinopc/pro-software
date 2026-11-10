/**
 * THE BUSINESS SETUP FLOW, AS A RUNNABLE CASE.
 *
 *   npx tsx scripts/try-business-setup.ts            build it and start one case
 *   npx tsx scripts/try-business-setup.ts --delete   remove every trace
 *
 * Built from "Business Setup Workflow — Visual Flowcharts" (9 Nov 2026): six stages, five gates,
 * Standard route. The first cut collapsed each stage into a single step, which proved the ladder
 * and nothing else — chart 4 alone has eight steps, two branches and two rework loops inside the
 * one box it drew. PHASE 1 IS NOW BUILT PROPERLY, as the shape every other stage should take.
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

    work("s0", "Stage 0 — Closed-Won: raise the 50% advance invoice"),
    gate("g0", "G0 — Finance confirms the 50% advance"),

    work("sa", "Stage A — Onboarding: team, WhatsApp group, portal, kick-off call, KYC"),
    gate("g1", "G1 — QA checks onboarding, client confirms kick-off"),

    work("sb", "Stage B — Structuring: choose the route and agree any extra cost"),
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

    work("p2", "Phase 2 — Licence to CR: trade name, MISA licence, AoA, CR issued"),
    gate("g4", "G4 — CR matches the data sheet, balance paid, delivered"),

    work("p3", "Phase 3 — PRO Lead accepts the handoff, setup case closed"),
    { id: "end", type: "end", label: "Setup complete — handed to PRO" },
  ];

  const edges: any[] = [
    { from: "start", to: "s0" },
    { from: "s0", to: "g0" }, { from: "g0", to: "sa", condition: "approve" },
    { from: "sa", to: "g1" }, { from: "g1", to: "sb", condition: "approve" },
    { from: "sb", to: "g2" }, { from: "g2", to: "p1_ask", condition: "approve" },

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
    { from: "g3", to: "p2", condition: "approve" },
    { from: "g3", to: "p1_redo", condition: "reject" },        // rejection has somewhere to go
    { from: "p1_redo", to: "p1_translate" },

    { from: "p2", to: "g4" }, { from: "g4", to: "p3", condition: "approve" },
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
  const loops = g.edges.filter((e: any) => ["p1_fix", "p1_redo"].includes(e.from)).length;

  console.log(`
Built: ${steps} steps, ${gates} gates, ${forks} decision fork, ${loops} rework loops.
Phase 1 is the fully-built stage: ${g.nodes.filter((n: any) => n.id.startsWith("p1_")).length} nodes, checklists on 4 of them,
captures for the apostille answer, the AWB and the carrier, and two paths to KSA.

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
