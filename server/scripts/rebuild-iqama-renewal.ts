/**
 * The Iqama Renewal workflow as the firm actually works it.
 *
 * THE DEFECT IT FIXES: a Saudi work permit is renewed WITH the Iqama and carries the same expiry,
 * and this workflow renewed the Iqama alone. Nothing in it ever touched the permit — which is why 51
 * of the 108 employees holding both are sitting on dates that disagree, and why the SLA Monitor goes
 * on chasing permits that were in fact renewed.
 *
 * Ten steps become five:
 *
 *   1  Insurance & Prerequisite Check  evaluated by the engine; seen only when it fails
 *   2  Issue Work Permit               term, amount, paid/unpaid, reference and date when paid
 *   3  Payment for Jawazat             the same, plus a late payment when one applies
 *   4  Traffic / Other Violations      blocks the renewal until an outstanding fine is settled
 *   5  Renew Iqama                     both new dates, the Iqama attached, both documents written
 *
 * The client-approval gate is deliberately gone: the firm renews under a standing engagement and
 * asked for five steps. It means government fees are now paid without a recorded client sign-off,
 * which is a decision rather than an oversight.
 *
 * `prereq` KEEPS ITS NODE ID. 71 runs are parked on it, and a run points at its step by id — rename
 * the id and all 71 become unadvanceable. Their task rows still hold the old questions, which the
 * repoint route brings up to date.
 *
 *   npx tsx scripts/rebuild-iqama-renewal.ts            # report only
 *   npx tsx scripts/rebuild-iqama-renewal.ts --apply
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const TERMS = "3_month,6_month,9_month,12_month";

/** A fee: what it cost, whether it has been paid, and — only then — how it was paid. */
const money = (p: string, label: string) => [
  { var: p + "Amount", type: "number", label: label + " amount (SAR)", required: true },
  { var: p + "Paid", type: "select", label: label + " — paid?", options: "paid,unpaid", required: true },
  { var: p + "Ref", type: "text", label: "Payment reference", required: true, showIf: { var: p + "Paid", equals: "paid" } },
  { var: p + "PaidOn", type: "date", label: "Payment date", required: true, showIf: { var: p + "Paid", equals: "paid" } },
];

const nodes = [
  { id: "start", type: "start", label: "Renewal Created", config: {} },

  // NOT A QUESTION. The Iqama type already carries its prerequisites — health insurance valid for at
  // least a month, a passport for at least six — and the engine can read them. Asking an officer
  // "insurance valid?" queued 76 people to re-type an answer the database held, and nothing stopped
  // a wrong one. Met, and nobody ever sees this step. Not met, and the reason is written onto the
  // work that is raised.
  { id: "prereq", type: "prereq_gate", label: "Insurance & Prerequisite Check",
    config: { docType: "Iqama" } },
  { id: "fix_ins", type: "task", label: "Update the Insurance Before Renewing",
    config: { assigneeRole: "pro_officer", slaHours: 168,
      instructions: "For this Iqama renewal the insurance does not meet the minimum validity period. {prereqUnmet} File the valid document against this employee, then complete this step — the check runs again by itself.",
      captures: [{ var: "insuranceFixed", type: "text", label: "What was done", required: true }] } },

  { id: "permit", type: "task", label: "Issue Work Permit",
    config: { assigneeRole: "pro_officer", slaHours: 48,
      instructions: "Choose the term, record the fee, and say whether it has been paid.",
      captures: [
        { var: "permitTerm", type: "select", label: "Work permit term", options: TERMS, required: true },
        ...money("permit", "Work permit fee"),
      ] } },

  { id: "jawazat", type: "task", label: "Payment for Jawazat",
    config: { assigneeRole: "pro_officer", slaHours: 48,
      instructions: "The Jawazat payment, and a late-payment charge if one applies. Leaving the late amount empty says there was none.",
      captures: [
        { var: "jawazatTerm", type: "select", label: "Jawazat term", options: TERMS, required: true },
        ...money("jawazat", "Jawazat fee"),
        // Not required: an empty amount IS the answer "there was no late payment". The paid/unpaid
        // question appears only once an amount is entered, which is what "if applicable" means.
        { var: "lateAmount", type: "number", label: "Late payment amount (SAR), if any", required: false },
        { var: "latePaid", type: "select", label: "Late payment — paid?", options: "paid,unpaid", required: true, showIf: { var: "lateAmount" } },
        { var: "lateRef", type: "text", label: "Late payment reference", required: true, showIf: { var: "latePaid", equals: "paid" } },
        { var: "latePaidOn", type: "date", label: "Late payment date", required: true, showIf: { var: "latePaid", equals: "paid" } },
      ] } },

  { id: "violations", type: "task", label: "Check Traffic / Other Violations",
    config: { assigneeRole: "pro_officer", slaHours: 48,
      instructions: "Check the employee for traffic and other violations. An unpaid violation stops the renewal — Jawazat will refuse it anyway.",
      captures: [
        { var: "hasViolation", type: "select", label: "Any violation?", options: "none,yes", required: true },
        { var: "violationDetail", type: "text", label: "What the violation is", required: true, showIf: { var: "hasViolation", equals: "yes" } },
        { var: "violationAmount", type: "number", label: "Violation amount (SAR)", required: true, showIf: { var: "hasViolation", equals: "yes" } },
        { var: "violationPaid", type: "select", label: "Violation — paid?", options: "paid,unpaid", required: true, showIf: { var: "hasViolation", equals: "yes" } },
        { var: "violationRef", type: "text", label: "Payment reference", required: true, showIf: { var: "violationPaid", equals: "paid" } },
        { var: "violationPaidOn", type: "date", label: "Payment date", required: true, showIf: { var: "violationPaid", equals: "paid" } },
      ] } },
  { id: "d_viol", type: "decision", label: "Clear of violations?",
    config: { branches: [
      { var: "hasViolation", op: "eq", value: "none", key: "clear" },
      { var: "violationPaid", op: "eq", value: "paid", key: "clear" },
    ] } },

  { id: "renew", type: "task", label: "Renew Iqama",
    config: { assigneeRole: "pro_officer", slaHours: 24,
      instructions: "Record the renewed Iqama and the work permit renewed with it. Both dates are entered as the government issued them.",
      checklist: [{ key: "renewed_iqama", label: "Renewed Iqama attached", source: "manual", required: true }],
      captures: [
        { var: "iqamaNumber", type: "text", label: "Iqama number", required: true },
        { var: "newExpiry", type: "date", label: "New Iqama expiry", required: true },
        { var: "permitExpiry", type: "date", label: "New work permit expiry", required: true },
      ] } },

  // Two documents, one renewal. The permit names its own variable rather than sharing `documentId`
  // — which belongs to the Iqama — and finds the permit this employee already holds.
  { id: "issue_iqama", type: "issue_document", label: "Iqama",
    config: { docType: "Iqama", numberVar: "iqamaNumber", expiryVar: "newExpiry" } },
  { id: "issue_permit", type: "issue_document", label: "Work Permit",
    config: { docType: "Work Permit", expiryVar: "permitExpiry", documentIdVar: "workPermitDocId", renewExisting: true } },

  { id: "notify", type: "notify", label: "Tell the Client", config: {} },
  { id: "end_done", type: "end", label: "Renewal Complete", config: {} },
];

const edges = [
  { from: "start", to: "prereq", condition: "" },
  { from: "prereq", to: "permit", condition: "pass" },
  { from: "prereq", to: "fix_ins", condition: "fail" },
  { from: "fix_ins", to: "prereq", condition: "" },
  { from: "permit", to: "jawazat", condition: "" },
  { from: "jawazat", to: "violations", condition: "" },
  { from: "violations", to: "d_viol", condition: "" },
  { from: "d_viol", to: "renew", condition: "clear" },
  // Not a dead end: the step comes back until the violation is recorded settled.
  { from: "d_viol", to: "violations", condition: "else" },
  { from: "renew", to: "issue_iqama", condition: "" },
  { from: "issue_iqama", to: "issue_permit", condition: "" },
  { from: "issue_permit", to: "notify", condition: "" },
  { from: "notify", to: "end_done", condition: "" },
];

const main = async () => {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Iqama Renewal" } });
  if (!tpl) throw new Error("Iqama Renewal template not found");
  const old: any[] = (tpl.graph as any)?.nodes ?? [];
  const keep = new Set(nodes.map(n => n.id));
  const dropped = old.filter(n => !keep.has(n.id)).map(n => n.id);

  const live = await prisma.workflowTask.findMany({
    where: { status: "active", instance: { templateId: tpl.id, status: "running" } },
    select: { id: true, nodeId: true, instance: { select: { id: true, title: true, clientName: true } } },
  });
  const byNode: Record<string, number> = {};
  for (const t of live) byNode[t.nodeId] = (byNode[t.nodeId] ?? 0) + 1;

  console.log(`template:   ${tpl.name} (${tpl.id})  active=${tpl.active}`);
  console.log(`steps:      ${old.length} -> ${nodes.length}`);
  console.log(`ids dropped: ${dropped.join(", ") || "none"}`);
  console.log(`\nruns parked on each step right now:`);
  for (const [n, c] of Object.entries(byNode).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.padEnd(12)} ${String(c).padStart(3)}   ${keep.has(n) ? "survives" : "** would be stranded **"}`);
  }
  const stranded = live.filter(t => !keep.has(t.nodeId));
  if (stranded.length) {
    console.log(`\n${stranded.length} run(s) to restart (their step will not exist):`);
    for (const t of stranded) console.log(`  ${t.nodeId.padEnd(10)} ${t.instance.clientName} — ${t.instance.title}   [${t.instance.id}]`);
  }

  if (!APPLY) return console.log("\nreport only. Re-run with --apply to write.");
  await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph: { nodes, edges }, packModified: true } });
  console.log(`\nwritten.\nNext: repoint the ${byNode["prereq"] ?? 0} run(s) on "prereq", and restart the ${stranded.length} listed above.`);
};

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
