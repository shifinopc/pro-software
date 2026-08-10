/**
 * Say, for each step, which authority it is done at — or that it is office work.
 *
 * Not one of the 105 task/approval steps named a portal, and not one of the 80 live tasks carried
 * one. The Government Centers queue groups work by authority, so it has had nothing to group since
 * it was built: the producer existed, nothing ever fed it.
 *
 * TWO ANSWERS, NOT ONE. A step is either done at a portal or it is office work, and "office work"
 * is a complete answer. The Builder used to store that choice by DELETING the key, so a decided
 * step and an unasked one were byte-identical — which is why Setup Check could only ever say
 * "190 of 190" and could never be worked down to zero. `noPortal: true` records it properly.
 *
 * WHAT THIS WILL AND WILL NOT DECIDE. Only 8 of 90 distinct step labels name an authority outright.
 * The rules below fire on the authority's own name or on an unmistakable synonym (Iqama → Muqeem,
 * work permit → Qiwa), and mark fee approvals and document collection as office work. Everything
 * else is left alone and counted, because a step filed under the wrong authority is worse than one
 * filed under none: it appears in an officer's Qiwa queue, they cannot action it there, and the
 * queue stops being trustworthy.
 *
 * DRY RUN BY DEFAULT.  npx tsx scripts/set-step-portals.ts          → prints the plan
 *                      npx tsx scripts/set-step-portals.ts --apply  → writes it
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const SKIP_TEMPLATE = /^(DEMO|QA PROBE|TEST)/i;

/**
 * label → portal, PER COUNTRY. The country matters: an earlier run of this script matched "entry
 * permit" and "residence visa" on a UAE template and filed both under Muqeem, which is Saudi. A
 * step under the wrong authority is worse than one under none — it appears in an officer's Muqeem
 * queue, they cannot action it there, and the queue stops being trusted. So the rules are chosen by
 * the template's own country, and a template whose country has no rules is left alone rather than
 * matched against somebody else's authorities.
 */
const PORTAL_BY_COUNTRY: Record<string, Array<[RegExp, string, string]>> = {
  AE: [
    [/mohre|labour card|labor card|work permit|establishment card/i, "MOHRE", "work permits and labour cards are MOHRE"],
    [/\bicp\b|emirates id|entry permit|residence visa|visa stamping/i, "ICP", "Emirates ID, entry permits and residence visas are ICP"],
    [/trade licen[cs]e|\bded\b|commercial registration/i, "DED", "trade licence is DED"],
    [/ejari|tenancy/i, "Ejari", "tenancy registration is Ejari"],
    [/\bfta\b|\bvat\b(?!.*approve)/i, "FTA", "UAE VAT is the FTA"],
  ],
  SA: [
    [/\bqiwa\b|work permit|labour contract|labor contract/i, "Qiwa", "work permits and labour contracts are Qiwa"],
    [/\bgosi\b/i, "GOSI", "names GOSI"],
    [/\bzatca\b|\bvat\b(?!.*approve)/i, "ZATCA", "VAT is ZATCA"],
    [/\bmhrsd\b/i, "MHRSD", "names MHRSD"],
    [/absher|muqeem|\biqama\b|residence visa|exit visa|entry permit/i, "Muqeem", "Iqama and residence/exit visas are filed on Absher / Muqeem"],
  ],
};

/** label → office work. Internal steps that never touch a portal. */
const OFFICE: Array<[RegExp, string]> = [
  [/^approve .*(fee|renewal)/i, "an internal approval of a fee — no portal involved"],
  [/collect|upload|obtain .*(letter|document)|resignation|termination letter/i, "collecting papers from the client"],
  [/confirm (with|the client)|notify|inform|email|remind/i, "talking to the client"],
  [/close file|close the file|archive|record .* in the system|raise .*invoice|settle dues|final salary/i, "office work"],
];

async function main() {
  const templates = await prisma.workflowTemplate.findMany({
    where: { retired: false }, select: { id: true, name: true, active: true, country: true, graph: true }, orderBy: { name: "asc" },
  });
  const centers = new Set((await prisma.govCenter.findMany({ select: { name: true } })).map(c => c.name));

  let portal = 0, office = 0, undecided = 0, skipped = 0;
  const undecidedList: string[] = [];
  const writes: Array<{ id: string; graph: any }> = [];

  for (const t of templates) {
    const graph: any = t.graph ?? {};
    const nodes: any[] = Array.isArray(graph.nodes) ? graph.nodes : [];
    const open = nodes.filter(n =>
      (n?.type === "task" || n?.type === "approval") && !n?.config?.govCenter && !n?.config?.noPortal);
    if (!open.length) continue;
    if (SKIP_TEMPLATE.test(t.name)) { skipped += open.length; continue; }

    // Only this template's own country's authorities are candidates. Unknown country → no portal
    // rules at all, so every step falls through to the office-work rules or to undecided. That is
    // the safe direction: the cost of an undecided step is a row on a list, the cost of a wrongly
    // filed one is an officer trusting a queue that is lying to them.
    const PORTAL = PORTAL_BY_COUNTRY[String(t.country ?? "").toUpperCase()] ?? [];

    const lines: string[] = [];
    let touched = false;
    for (const n of open) {
      const label = String(n.label ?? n.id);
      const hit = PORTAL.find(([re]) => re.test(label));
      if (hit && centers.has(hit[1])) {
        lines.push(`   →  ${label}\n        ${hit[1]}  (${hit[2]})`);
        n.config = { ...(n.config ?? {}), govCenter: hit[1] };
        delete n.config.noPortal;
        portal++; touched = true; continue;
      }
      // A portal the rules recognise but Country Rules has no center for cannot be assigned: the
      // queue only has columns for the centers that exist.
      if (hit && !centers.has(hit[1])) {
        lines.push(`   ?  ${label}\n        looks like ${hit[1]}, but no "${hit[1]}" center is configured`);
        undecided++; undecidedList.push(`${t.name} — ${label}`); continue;
      }
      // STRUCTURAL, not name-matching: an approval is a decision somebody makes at their desk. No
      // approval is carried out at a government portal — the portal work is the task that follows
      // it. So any approval step that has not already matched a portal above is office work, and
      // that holds however it happens to be worded ("Approval", "Finance Sign-off", "Internal
      // Approval" — all the same thing, and all previously undecided for want of a matching phrase).
      const off = n.type === "approval"
        ? ["approval", "an approval is a decision made in the office, never at a portal"] as const
        : OFFICE.find(([re]) => re.test(label));
      if (off) {
        lines.push(`   ·  ${label}\n        office work  (${off[1]})`);
        n.config = { ...(n.config ?? {}), noPortal: true };
        delete n.config.govCenter;
        office++; touched = true; continue;
      }
      lines.push(`   ?  ${label}\n        NEEDS A DECISION — no rule matches this step's name`);
      undecided++; undecidedList.push(`${t.name} — ${label}`);
    }
    console.log(`\n${t.name}${t.active ? "  [ACTIVE]" : "  [draft]"}`);
    for (const l of lines) console.log(l);
    if (touched) writes.push({ id: t.id, graph });
  }

  console.log(`\n${"─".repeat(74)}`);
  console.log(`${portal} step(s) → a portal · ${office} → office work · ${undecided} need a decision · ${skipped} skipped (demo/QA)`);
  console.log(`centers configured: ${[...centers].join(", ")}`);
  if (undecided) {
    console.log(`\nStill undecided (${undecided}) — first 15:`);
    for (const u of undecidedList.slice(0, 15)) console.log("   " + u);
  }

  if (!APPLY) console.log(`\nDRY RUN — nothing written. Re-run with --apply to write it.`);
  else {
    for (const w of writes) await prisma.workflowTemplate.update({ where: { id: w.id }, data: { graph: w.graph } });
    console.log(`\nAPPLIED to ${writes.length} template(s).`);
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
