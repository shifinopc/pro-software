/**
 * THE PAYMENTS ALREADY RECORDED, GIVEN ROWS.
 *
 *   npx tsx scripts/money-capture-backfill.ts          show what would be filed
 *   npx tsx scripts/money-capture-backfill.ts apply    file it
 *
 * Officers have been recording ministry fees for months, as variables on the run. Those are the only
 * cost figures this system holds, so they are worth keeping: this reads each completed run, finds the
 * variables that a money capture now owns, and files them as Disbursements.
 *
 * WHAT IT WILL NOT TOUCH:
 *
 *   · `fee` on a renewal started by document expiry. That is not an officer's observation — jobs.ts
 *     seeds it from DocumentType.defaultFee, which is how 162 Iqama runs all carry the identical
 *     value. Filing it as a payment would invent 162 payments that nobody made.
 *   · anything already filed, keyed on (run, variable), so running twice is safe.
 *   · anything that is not a positive number.
 *
 * Reference and date come from the sibling variables the migration folded in, where the officer
 * filled them. `paid` follows the old `xPaid` flag, defaulting to paid when the step never asked.
 */
import { prisma } from "../src/db.js";
import { minorFromTyped } from "../src/disbursements.js";

const apply = process.argv[2] === "apply";
const stem = (v: string) => v.replace(/(Amount|Fee|fee)$/, "");

/** Runs seeded with a document type's default fee, which is a price list and not a payment. */
const SEEDED = new Set(["fee"]);

const runs = await prisma.workflowInstance.findMany({
  select: { id: true, title: true, companyId: true, clientName: true, startedAt: true, variables: true,
            template: { select: { name: true, graph: true } },
            tasks: { select: { id: true, captures: true, completedBy: true, completedAt: true } } },
});

let filed = 0, skippedSeeded = 0, already = 0, notNumeric = 0;
const preview: string[] = [];

for (const run of runs) {
  const vars = (run.variables ?? {}) as Record<string, any>;
  // Which variables a money capture owns, as the templates define them TODAY.
  const owned = new Map<string, { label: string; chargeTypeId: string | null }>();
  for (const n of ((run.template?.graph as any)?.nodes ?? [])) {
    for (const c of (n?.config?.captures ?? [])) {
      if (c?.var && String(c.type) === "money") owned.set(String(c.var), { label: c.label || c.var, chargeTypeId: c.chargeTypeId ?? null });
    }
  }
  if (!owned.size) continue;

  for (const [v, def] of owned) {
    const rawAmount = vars[v];
    if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === "") continue;

    // A seeded default is not an observation. Only skip where it really was seeded: an expiry-started
    // run. The same name typed by an officer on a manual run is a real payment.
    if (SEEDED.has(v) && String(vars._trigger ?? "") === "document_expiry") { skippedSeeded++; continue; }

    const amountMinor = minorFromTyped(rawAmount);
    if (amountMinor === null || amountMinor <= 0) { notNumeric++; continue; }

    const exists = await prisma.disbursement.findFirst({ where: { workflowInstanceId: run.id, varName: v }, select: { id: true } });
    if (exists) { already++; continue; }

    const p = stem(v);
    const paidFlag = p && p !== v ? vars[`${p}Paid`] : undefined;
    // The step that actually asked for it, so the row keeps the same key a live completion would use.
    const task = run.tasks.find(t => Array.isArray(t.captures) && (t.captures as any[]).some(c => c?.var === v));

    preview.push(`  ${(run.clientName ?? "—").slice(0, 22).padEnd(22)} ${def.label.slice(0, 26).padEnd(26)} ${(amountMinor / 100).toFixed(2).padStart(10)}  ${run.title.slice(0, 40)}`);
    filed++;
    if (apply) {
      await prisma.disbursement.create({
        data: {
          companyId: run.companyId, clientName: run.clientName,
          workflowInstanceId: run.id, workflowTaskId: task?.id ?? null,
          chargeTypeId: def.chargeTypeId, label: def.label, varName: v,
          amountMinor, currency: "SAR",
          reference: p && p !== v && vars[`${p}Ref`] ? String(vars[`${p}Ref`]) : null,
          paid: paidFlag === undefined ? true : !/^(no|unpaid|not paid)/i.test(String(paidFlag)),
          paidAt: p && p !== v && vars[`${p}PaidOn`] ? String(vars[`${p}PaidOn`]) : (task?.completedAt?.slice(0, 10) ?? null),
          recharge: true,
          recordedBy: task?.completedBy ?? null,
          at: task?.completedAt ?? run.startedAt ?? new Date().toISOString(),
        },
      });
    }
  }
}

preview.slice(0, 30).forEach(l => console.log(l));
if (preview.length > 30) console.log(`  … and ${preview.length - 30} more`);
console.log(`\n${apply ? "filed" : "would file"} ${filed} payment(s)`);
console.log(`  ${skippedSeeded} skipped as a seeded default fee rather than something an officer recorded`);
console.log(`  ${already} already had a row`);
console.log(`  ${notNumeric} were not a positive number`);
if (!apply) console.log("\nnothing was written. re-run with `apply`.");
await prisma.$disconnect();
