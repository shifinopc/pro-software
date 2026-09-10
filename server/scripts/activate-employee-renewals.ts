/**
 * Arm the three employee renewals.
 *
 * THIS IS THE SWITCH, and it is separate from the build on purpose. add-employee-renewals.ts leaves
 * all three as drafts because activating them hands the nightly job a licence to open real runs
 * against real people's documents and put real tasks on a real team's board. That is a decision, not
 * a build step.
 *
 * BEFORE IT WRITES ANYTHING it counts what the next tick would actually do — how many documents sit
 * inside each lead window, and how many have already expired. An already-expired document still
 * opens a run, and it opens it overdue, so the first tick after activation is the largest one the
 * system will ever produce for these workflows. Knowing that number in advance is the difference
 * between a planned start and a surprise.
 *
 * Dry-run by default; --apply to arm. Idempotent.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

const PLAN: [string, string, number][] = [
  ["Iqama Renewal", "Iqama", 60],
  ["Work Permit Renewal", "Work Permit", 30],
  ["Health Insurance Renewal", "Health Insurance", 30],
];

async function main() {
  const today = new Date();
  let firstTick = 0;

  console.log("What the next tick would open:\n");
  for (const [, docType, lead] of PLAN) {
    const docs = await prisma.document.findMany({ where: { docType }, select: { expiryDate: true } });
    let win = 0, expired = 0, bad = 0;
    for (const d of docs) {
      const e = d.expiryDate ? new Date(d.expiryDate) : null;
      if (!e || isNaN(+e)) { bad++; continue; }
      const days = Math.floor((+e - +today) / 86400000);
      if (days < 0) expired++;
      else if (days <= lead) win++;
    }
    console.log(`  ${docType.padEnd(18)} ${String(docs.length).padStart(3)} on file · ${win} inside the ${lead}-day window · ${expired} already expired${bad ? ` · ${bad} with no usable expiry` : ""}`);
    firstTick += win + expired;
  }
  console.log(`\n  → roughly ${firstTick} runs on the first tick\n`);

  for (const [name] of PLAN) {
    const tpl = await prisma.workflowTemplate.findFirst({ where: { name, retired: false } });
    if (!tpl) { console.log(`  MISSING  ${name} — run add-employee-renewals.ts first`); continue; }
    if (tpl.active) { console.log(`  already active  ${name}`); continue; }
    if (APPLY) {
      await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { active: true } });
      console.log(`  ACTIVATED       ${name}`);
    } else {
      console.log(`  would activate  ${name}`);
    }
  }

  console.log(APPLY ? "\nARMED. The next cron tick will start opening renewals." : "\nDRY RUN — nothing written. Re-run with --apply.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
