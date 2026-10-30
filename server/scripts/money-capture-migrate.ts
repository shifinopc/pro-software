/**
 * TURN THE FEE QUARTETS INTO money CAPTURES.
 *
 *   npx tsx scripts/money-capture-migrate.ts          show what would change
 *   npx tsx scripts/money-capture-migrate.ts apply    change it
 *
 * Each payment was spelled four times — `permitAmount`, `permitPaid`, `permitRef`, `permitPaidOn` —
 * with nothing but a shared prefix tying them together. This makes the amount a `money` capture,
 * which collects all four, and removes the other three.
 *
 * THE LIST IS EXPLICIT, NOT A PATTERN. Guessing from the label would have swept in three fields that
 * are not money the firm paid out:
 *
 *   · `totalSalary` (Payroll / WPS) — the client's payroll, which we file, not fund
 *   · `eosb` (Final Exit, Termination) — the client's end-of-service liability
 *   · `outstanding` (GOSI) — a balance owed, not a payment made
 *
 * Billing a client for their own payroll because a label ended in "(SAR)" is exactly the class of
 * mistake this whole change exists to stop, so the decision is written down rather than inferred.
 *
 * AMBIGUOUS, LEFT ALONE, LISTED AT THE END: the three `amountPaid` fields. On Chamber of Commerce
 * there is already a `subscriptionFee` beside it, so it may be the same payment twice; on VAT Return
 * it is probably the client's tax. A person should decide, and until they do nothing is lost.
 */
import { prisma } from "../src/db.js";

/** template name -> the capture vars that are payments the firm makes. */
const MONEY: Record<string, string[]> = {
  "Iqama Renewal": ["permitAmount", "jawazatAmount", "lateAmount", "violationAmount"],
  "MISA Licence Renewal": ["feeAmount"],
  "Work Permit Renewal": ["feeAmount"],
  "Commercial Registration Renewal": ["mcFee"],
  "CR Amendment": ["mcFee"],
  "Health Insurance Renewal": ["premium"],
  "Employee Insurance Assistance": ["premium"],
  "Chamber of Commerce Membership Renewal": ["subscriptionFee"],
  "Customs Declaration (Fasah)": ["dutyAmount"],
  "New Employee Work Visa": ["visaFee"],
  "Exit / Re-entry Visa": ["fee"],
  "Profession Change": ["fee"],
  "Employee Transfer (Sponsorship)": ["fee"],
  "Qiwa Portal Licence Renewal": ["renewalFee"],
};

/** `permitAmount` -> permit. The prefix its siblings share. */
const stem = (v: string) => v.replace(/(Amount|Fee|fee)$/, "");
/** The siblings a money capture absorbs. Exact prefix + suffix only — a standalone `paymentDate`
 *  belongs to the step rather than to one payment, so it is left where it is. */
const siblingsOf = (v: string) => {
  const p = stem(v);
  return p && p !== v ? [`${p}Paid`, `${p}Ref`, `${p}PaidOn`] : [];
};

const apply = process.argv[2] === "apply";
let changed = 0, removed = 0, touched = 0;
const doubled: string[] = [];
const leftovers: string[] = [];

for (const [name, vars] of Object.entries(MONEY)) {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name }, select: { id: true, name: true, graph: true } });
  if (!tpl) { console.log(`  ?  ${name} — no such template`); continue; }
  const g: any = tpl.graph ?? {};
  let dirty = false;
  const lines: string[] = [];

  for (const node of (g.nodes ?? [])) {
    const caps: any[] = node?.config?.captures;
    if (!Array.isArray(caps) || !caps.length) continue;
    for (const v of vars) {
      const cap = caps.find(c => c?.var === v);
      if (!cap || String(cap.type) === "money") continue;
      const sibs = siblingsOf(v).filter(s => caps.some(c => c?.var === s));
      cap.type = "money";
      // The engine refuses to complete a step whose required answer is missing, and these were all
      // required — so the money capture inherits that rather than quietly relaxing it.
      for (const s of sibs) {
        const at = caps.findIndex(c => c?.var === s);
        if (at >= 0) { caps.splice(at, 1); removed++; }
      }
      lines.push(`     ${v} -> money${sibs.length ? `, absorbing ${sibs.join(", ")}` : " (no siblings found)"}`);
      changed++; dirty = true;
    }
    // A step that keeps a standalone date or paid flag beside a money capture now asks the same
    // thing twice, because the block carries its own. NOT removed: `paymentDate` on a licence
    // renewal may be the date the LICENCE was paid for rather than the date of this fee, and only
    // the person who wrote the template knows which. Reported, so it is a decision and not a
    // surprise somebody meets at a ministry counter.
    if (caps.some(c => String(c?.type) === "money")) {
      for (const c of caps) {
        if (!c?.var || String(c.type) === "money") continue;
        if (/^(paymentDate|paidOn|.*PaidOn|.*Paid)$/.test(c.var)) {
          doubled.push(`  ${name}: "${c.label || c.var}" (${c.var}) sits beside a money capture that asks the same thing`);
        }
      }
    }

    // Anything still referring to a removed sibling through showIf would now gate on a variable
    // nothing captures, so the reference goes with it.
    for (const c of caps) {
      if (c?.showIf?.var && !caps.some(x => x?.var === c.showIf.var) && /Paid$/.test(c.showIf.var)) {
        lines.push(`     dropped a showIf on ${c.showIf.var}, which no longer exists`);
        delete c.showIf; dirty = true;
      }
    }
  }

  if (dirty) {
    touched++;
    console.log(`  ${apply ? "*" : "-"}  ${name}`);
    lines.forEach(l => console.log(l));
    if (apply) await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph: g, packModified: true } });
  }
}

// Say out loud what was deliberately not touched, so the next person does not assume it was missed.
for (const [name, vars] of Object.entries({
  "Payroll / WPS Submission (Mudad)": ["totalSalary — the client's payroll, not our outlay"],
  "Final Exit": ["eosb — the client's end-of-service liability"],
  "Termination and Final Settlement": ["eosb — the client's end-of-service liability"],
  "GOSI Establishment Registration / Update": ["outstanding — a balance, not a payment"],
  "Chamber of Commerce Membership Renewal ": ["amountPaid — may be the subscriptionFee recorded twice"],
  "VAT Return Filing": ["amountPaid — probably the client's own tax"],
  "Vehicle Services (Tamm)": ["amountPaid — unclear who pays it"],
})) leftovers.push(`  ${name.trim()}: ${vars[0]}`);

console.log(`\n${apply ? "changed" : "would change"} ${changed} capture(s) across ${touched} template(s), removing ${removed} sibling field(s)`);
console.log("\nleft alone on purpose — a person should decide:");
leftovers.forEach(l => console.log(l));
if (doubled.length) {
  console.log("\nasked twice now, since the money block carries its own date and paid flag:");
  [...new Set(doubled)].forEach(l => console.log(l));
}
if (!apply) console.log("\nnothing was written. re-run with `apply`.");
await prisma.$disconnect();
