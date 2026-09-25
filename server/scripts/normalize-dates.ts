/**
 * Find — and optionally fix — date columns that do not hold a date.
 *
 * `src/dates.ts` stops new ones being written. This is for the rows that were already there:
 * `Invoice.date` holding "15 Jul 2026", `ServiceRequest.date` holding "Just now", `Task.dueDate`
 * holding an empty string. They sort and compare as text, so they quietly misorder anything built
 * on them rather than failing.
 *
 *   npx tsx scripts/normalize-dates.ts            # report only — changes nothing
 *   npx tsx scripts/normalize-dates.ts --apply    # rewrite the rows it can, list the rest
 *
 * Reports first by default on purpose: this edits business records, and on a live database that is
 * a decision somebody makes after reading the list, not a side effect of running a script.
 */
import { prisma } from "../src/db.js";
import { DATE_FIELDS, toIsoDate, DateValueError } from "../src/dates.js";

const apply = process.argv.includes("--apply");

type Finding = { model: string; field: string; id: string; from: string; to: string | null | "UNFIXABLE"; why?: string };

async function main() {
  const findings: Finding[] = [];

  for (const [model, fields] of Object.entries(DATE_FIELDS)) {
    const delegate = (prisma as any)[model];
    if (!delegate?.findMany) continue;                       // model not in this schema

    let rows: any[];
    try {
      rows = await delegate.findMany({ select: Object.fromEntries([["id", true], ...fields.map(f => [f, true])]) });
    } catch {
      continue;                                              // a field listed for a model that lacks it
    }

    for (const row of rows) {
      for (const field of fields) {
        const value = row[field];
        if (value === null || value === undefined) continue;
        const raw = String(value);
        let normalised: string | null | undefined;
        try {
          normalised = toIsoDate(raw, field);
        } catch (e) {
          findings.push({ model, field, id: row.id, from: raw, to: "UNFIXABLE", why: e instanceof DateValueError ? e.message : String(e) });
          continue;
        }
        if (normalised === raw) continue;                    // already correct
        findings.push({ model, field, id: row.id, from: raw, to: normalised ?? null });
      }
    }
  }

  if (!findings.length) {
    console.log("Every date column holds an ISO date. Nothing to do.");
    return;
  }

  const fixable = findings.filter(f => f.to !== "UNFIXABLE");
  const stuck = findings.filter(f => f.to === "UNFIXABLE");

  console.log(`${findings.length} value(s) are not ISO dates — ${fixable.length} can be rewritten, ${stuck.length} cannot.\n`);
  for (const f of findings) {
    const to = f.to === "UNFIXABLE" ? `✗ ${f.why}` : `→ ${f.to === null ? "null" : f.to}`;
    console.log(`  ${(f.model + "." + f.field).padEnd(26)} ${f.id.padEnd(28)} ${JSON.stringify(f.from).padEnd(18)} ${to}`);
  }

  if (!apply) {
    console.log(`\nReport only. Re-run with --apply to rewrite the ${fixable.length} fixable value(s).`);
    if (stuck.length) console.log(`The ${stuck.length} unfixable one(s) need a person to decide what they were meant to say.`);
    return;
  }

  console.log("");
  let done = 0;
  for (const f of fixable) {
    await (prisma as any)[f.model].update({ where: { id: f.id }, data: { [f.field]: f.to } });
    done++;
  }
  console.log(`Rewrote ${done} value(s).`);
  if (stuck.length) console.log(`Left ${stuck.length} alone — they are listed above and need a decision, not a guess.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
