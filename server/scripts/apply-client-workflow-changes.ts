/**
 * The four changes the client marked up on the service handbook (received 2026-09-09).
 *
 * Three of them are configuration that lives in this database; the fourth is a change to a workflow
 * that is still only a written plan, and is made in docs/planned-services.js instead.
 *
 * IDEMPOTENT and DRY-RUN BY DEFAULT — pass --apply to write. Re-running after a write reports
 * "already applied" rather than doing it twice, so this is safe to run against live after local.
 *
 * PACK PROVENANCE: every row touched here came from the Saudi country pack, so each write also sets
 * packModified. That is not bookkeeping for its own sake — an upgrade of the pack reads that flag to
 * decide between silently overwriting a row and showing a human a diff. Editing a pack row without
 * setting it is how a client's deliberate change gets erased by the next install.
 *
 * IN-FLIGHT WORK IS NOT TOUCHED. A task snapshots its checklist and instructions when it is created,
 * on purpose, so that editing a template cannot rewrite work somebody is already holding. These edits
 * therefore reach the next run of each workflow, not the current one.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

async function main() {
  // ── 1. Visa / work-permit quota becomes a required check ────────────────────────────────────
  // Employee Onboarding → step 2, Eligibility & Nitaqat Check. It was the one optional item in a
  // list of four; the client wants no hire cleared without it.
  {
    const rule = await db.checklistRule.findFirst({
      where: { packKey: "sa.checklist.eligibility-nitaqat-check", retired: false },
    });
    if (!rule) throw new Error("Eligibility & Nitaqat check rule not found");
    const rows = JSON.parse(JSON.stringify(rule.rows ?? [])) as any[];
    const item = rows.flatMap((r) => r.documents ?? []).find((d: any) => d.key === "quota_available");
    if (!item) throw new Error("quota_available item not found");

    if (item.required === true) note("1. quota_available — already required, no change");
    else {
      item.required = true;
      note(`1. quota_available: required false -> true  ("${item.label}")`);
      if (APPLY) await db.checklistRule.update({ where: { id: rule.id }, data: { rows, packModified: true } });
    }
  }

  // ── 2. MISA company check keeps only its own licence item ───────────────────────────────────
  // The client struck the CR, Zakat, GOSI and Saudization lines from this step. They are not being
  // abandoned — the same checks sit on the CR Renewal gate (change 4) — but they are no longer asked
  // for a second time here.
  {
    const KEEP = ["misa_details"];
    const rule = await db.checklistRule.findFirst({
      where: { packKey: "sa.checklist.misa-company-compliance-check", retired: false },
    });
    if (!rule) throw new Error("MISA company compliance check rule not found");
    const rows = JSON.parse(JSON.stringify(rule.rows ?? [])) as any[];
    let dropped: string[] = [];
    for (const r of rows) {
      const before = (r.documents ?? []) as any[];
      dropped = dropped.concat(before.filter((d) => !KEEP.includes(d.key)).map((d) => d.key));
      r.documents = before.filter((d) => KEEP.includes(d.key));
    }
    if (!dropped.length) note("2. MISA company check — already trimmed, no change");
    else {
      note(`2. MISA company check: dropped ${dropped.length} items (${dropped.join(", ")}); kept ${KEEP.join(", ")}`);
      if (APPLY) await db.checklistRule.update({ where: { id: rule.id }, data: { rows, packModified: true } });
    }
  }

  // ── 3. MISA: submit on the portal before the fee decision and payment ───────────────────────
  // Was:  fee -> d_fee -(approved)-> pay -> submit -> misa_review
  // Now:  fee -> submit -> d_fee -(approved)-> pay -> misa_review
  //
  // Only three edges move. The decision's own branches (approved / declined / else) are untouched,
  // so a declined renewal still ends at "Not Renewed — Client Declined" exactly as before.
  //
  // The two instruction texts are rewritten because change 2 made them false: both described a
  // checklist that no longer has CR, Zakat or GOSI on it, and an instruction that contradicts the
  // list above it is worse than no instruction.
  {
    const tpl = await db.workflowTemplate.findFirst({
      where: { packKey: "sa.workflow.misa-licence-renewal", retired: false },
    });
    if (!tpl) throw new Error("MISA Licence Renewal template not found");
    const g = JSON.parse(JSON.stringify(tpl.graph)) as any;
    const F = (e: any) => e.from ?? e.source;
    const T = (e: any) => e.to ?? e.target;
    const setTo = (e: any, v: string) => { if ("to" in e) e.to = v; else e.target = v; };
    const find = (from: string, to: string) =>
      g.edges.find((e: any) => F(e) === from && T(e) === to && !e.label && !e.condition);

    const moves: [string, string, string][] = [
      ["fee", "d_fee", "submit"],        // fee now hands off to the portal submission
      ["submit", "misa_review", "d_fee"], // submission hands off to the fee decision
      ["pay", "submit", "misa_review"],   // payment now hands off to MISA's review
    ];
    let moved = 0;
    for (const [from, oldTo, newTo] of moves) {
      const e = find(from, oldTo);
      if (e) { setTo(e, newTo); moved++; note(`3. edge ${from} -> ${oldTo}  becomes  ${from} -> ${newTo}`); }
      else if (find(from, newTo)) note(`3. edge ${from} -> ${newTo} already in place`);
      else throw new Error(`3. cannot find edge ${from} -> ${oldTo} (graph is not in either expected shape — stopping rather than guessing)`);
    }

    const INSTR: Record<string, string> = {
      company_check:
        "Confirm the MISA licence details are correct before anything is submitted. The company's other " +
        "standing certificates — CR, Zakat, GOSI, Saudization — are checked on the CR renewal gate and are " +
        "not repeated here.",
      hold_fix:
        "Correct whatever the company check found on the licence record, then send it back for re-check.",
    };
    let rewritten = 0;
    for (const [id, text] of Object.entries(INSTR)) {
      const n = g.nodes.find((x: any) => x.id === id);
      if (!n) throw new Error(`node ${id} not found`);
      if (n.config.instructions === text) note(`3. ${id} instructions already updated`);
      else { n.config.instructions = text; rewritten++; note(`3. ${id} instructions rewritten for the trimmed checklist`); }
    }

    if (moved || rewritten) {
      if (APPLY)
        await db.workflowTemplate.update({
          where: { id: tpl.id },
          data: { graph: g, packModified: true, version: (tpl.version ?? 1) + 1 },
        });
      note(`3. MISA template -> version ${(tpl.version ?? 1) + 1}`);
    }
  }

  const live = await db.workflowTask.count({
    where: { status: "active", nodeId: { in: ["company_check", "fee", "d_fee", "pay", "submit"] } },
  });
  note(`\nIn-flight tasks on the changed steps: ${live} (each keeps the checklist and instructions it was created with)`);
  note(APPLY ? "\nAPPLIED." : "\nDRY RUN — nothing written. Re-run with --apply.");
}

main().finally(() => db.$disconnect());
