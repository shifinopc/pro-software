/**
 * THE SECOND STEP OF A BUSINESS SETUP, when the deal includes an acquisition.
 *
 * A setup that buys a parent and two shell companies needs the partners' own papers before anything
 * else can move: who they are, how to reach them, what share each holds, and the pile of documents
 * a deal like that brings that no checklist could have named in advance. None of it was collected
 * anywhere — the existing acquisition branch (d_parent / acqp_* / acqs1_* / acqs2_*) starts much
 * later, after the route approval, and asks about the COMPANIES being bought rather than the people
 * buying them.
 *
 * CONDITIONAL, on the quotation rather than on a question. delivery.ts already writes `structure`
 * onto the run from the quotation's own lines — "Acquisition in India" — so a decision node reading
 * `structure contains acquisition` routes the run without asking anybody to retype what the
 * quotation already says. A setup with no acquisition goes straight on to KYC exactly as before.
 *
 * Inserted between the onboarding call and KYC, so it is the second thing the officer sees, and it
 * runs BEFORE the identity pack rather than instead of it: both are collected either way.
 */
import { prisma } from "../src/db.js";

const NODE = {
  id: "acq_partners",
  type: "task",
  label: "Company acquisition — partners and documents",
  config: {
    /**
     * WHOSE QUEUE THIS SITS IN. Without it the step belongs to nobody: `role` is read as
     * `assigneeRole || approverRole`, and with neither there is no role gate, no shared-queue log
     * line, and nothing puts the step in anybody's My Tasks — it exists, the case waits on it, and
     * the only place it is visible is the Task List. Every other step of this workflow names
     * pro_officer; a step that collects the partners' papers is the same desk's work.
     */
    assigneeRole: "pro_officer",
    // The same clock the steps either side of it run on. Without slaHours the engine derives no due
    // date, so the step is never due, never breaches and never appears in the SLA Monitor — the
    // number is not decoration, it is the only thing that puts a step on that screen.
    slaHours: 72,
    whatToDo: "Collect the partners' details and every document the acquisition needs. Shareholding must add up to 100%.",
    captures: [
      {
        var: "acqPartners",
        label: "Partners",
        type: "rows",
        columns: [
          { var: "name", label: "Full name", flex: 2 },
          { var: "mobile", label: "Mobile", flex: 1.4 },
          { var: "email", label: "Email", flex: 1.8 },
          { var: "share", label: "Share %", flex: 0.9, type: "number", total: true, totalShouldBe: 100 },
        ],
      },
      { var: "acqPassports", label: "Partner passports", type: "files" },
      { var: "acqCompanyName", label: "Company name wanted for the business", type: "text" },
      { var: "acqOtherDocs", label: "Other documents", type: "files", required: false },
    ],
  },
};

const DECISION = {
  id: "d_acq",
  type: "decision",
  label: "Does this setup include an acquisition?",
  config: {
    branches: [{ key: "yes", var: "structure", op: "contains", value: "acquisition" }],
  },
};

async function main() {
  const t = await prisma.workflowTemplate.findFirst({ where: { name: { contains: "Business Setup" } } });
  if (!t) throw new Error("no Business Setup template");
  const g: any = t.graph;
  const nodes: any[] = g.nodes ?? [];
  const edges: any[] = g.edges ?? [];

  if (nodes.some(n => n.id === "acq_partners")) {
    console.log("already applied — nothing to do");
    return;
  }
  // The wire this replaces. Refused rather than guessed at: if the call no longer leads to KYC the
  // template has been re-drawn and this script's idea of "second step" is out of date.
  const callToKyc = edges.filter(e => e.from === "call" && e.to === "kyc" && !e.condition);
  if (callToKyc.length !== 1) throw new Error(`expected exactly one unconditional call → kyc edge, found ${callToKyc.length}`);

  const next = {
    ...g,
    nodes: [...nodes, DECISION, NODE],
    edges: [
      ...edges.filter(e => !(e.from === "call" && e.to === "kyc" && !e.condition)),
      { from: "call", to: "d_acq" },
      { from: "d_acq", to: "acq_partners", condition: "yes" },
      { from: "d_acq", to: "kyc", condition: "else" },
      { from: "acq_partners", to: "kyc" },
    ],
  };
  await prisma.workflowTemplate.update({ where: { id: t.id }, data: { graph: next as any } });
  console.log(`applied to "${t.name}": ${nodes.length} → ${next.nodes.length} nodes, ${edges.length} → ${next.edges.length} edges`);
}

main().then(() => prisma.$disconnect()).catch(async e => { console.error(e.message ?? e); await prisma.$disconnect(); process.exit(1); });
