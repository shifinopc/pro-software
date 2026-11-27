/**
 * WHAT EACH PIPELINE STAGE ASKS FOR BEFORE A DEAL MAY LEAVE IT.
 *
 * The gate engine has been built and working for a long time and was wired to nothing: every stage
 * carried checklistSource "(none)" and zero items, so blockersFor returned an empty list for all 53
 * live deals and a deal could move from anywhere to anywhere with nothing required. Measured before
 * this ran — Enquiry 9 deals / 0 items / 0 blocked, Quoted 20 / 0 / 0, Won 15 / 0 / 0.
 *
 * THE GATE IS ON LEAVING, not on entering. A stage's list is what THAT column asks you to have
 * finished before the deal goes further, which is why the Won and Lost columns have none: there is
 * nothing after them.
 *
 * EVERY ITEM IS DERIVED, not ticked. The module's own doctrine: a checklist maintained alongside
 * reality becomes a second to-do list and the two disagree within a week. So each item here is a
 * `field` item reading a fact the system already holds — a contact's phone number, a linked
 * quotation, whether it was sent, whether they agreed. Nobody is asked to confirm something the
 * database can already answer. hasValue() treats "no" and "false" as absent, which is what makes a
 * yes/no fact usable as a gate.
 *
 * WHAT THIS DELIBERATELY DOES NOT GATE:
 *   • Lost — exempt in the route itself. A dead deal is precisely the one whose paperwork was never
 *     finished, and refusing the loss would leave corpses in the pipeline to keep a list tidy.
 *   • Enquiry on a value or a close date. Early deals legitimately have neither, and a gate nobody
 *     can pass is a gate everybody learns to waive.
 *
 * Idempotent and dry-run by default; --apply writes. Existing items on a stage are REPLACED, so
 * anything configured by hand is reported before it is overwritten.
 *
 *   npx tsx scripts/configure-stage-gates.ts [--apply]
 */
import { prisma } from "../src/db.js";

type Item = { key: string; label: string; required: boolean; source: "field" | "manual" | "document"; field?: string };

const GATES: Record<string, Item[]> = {
  // → Qualified: there is somebody to talk to, and we know what they want. Both are typed on the
  // lead form already, so this gates nothing a salesperson has not been asked for anyway.
  Enquiry: [
    { key: "reachable", label: "A way to contact them", required: true, source: "field", field: "contactReach" },
    /**
     * WHAT THEY ARE BUYING. Added on the firm's instruction after the reach item on its own turned
     * out to gate nothing anybody could feel: it was already satisfied on 7 of the 8 deals sitting
     * in Enquiry, so a card dragged to Qualified just went.
     *
     * This one refuses ALL of them, which was the reason it was left out the first time — a gate
     * that stops every deal in its column usually becomes a gate everybody waives. It is in now
     * because the refusal is answerable in the moment: `product` is wired into _FIX_ACTIONS in the
     * console, so the refusal offers the deal's own product picker rather than only naming the
     * field. A blocker you can clear from the dialog that raised it is a prompt; one you cannot is
     * the wall that teaches the habit.
     */
    { key: "product", label: "What they are buying", required: true, source: "field", field: "product" },
  ],
  // → Quoted: the column claims a quotation exists, so it must.
  Qualified: [
    { key: "quotation", label: "A quotation on the deal", required: true, source: "field", field: "hasQuotation" },
  ],
  // → Negotiation: you cannot negotiate a quotation the client has never seen. `quotationSent`
  // rather than a status equality, so a quotation that went out and came back rejected still counts
  // as sent — it is, and the deal moving to Negotiation off a rejection is a real sequence.
  Quoted: [
    { key: "quote_sent", label: "The quotation has been sent to the client", required: true, source: "field", field: "quotationSent" },
  ],
  // → Won: the client agreed. Satisfied by `accepted` OR `invoiced`, because "Accept & invoice" is
  // one press that never passes through accepted — gating on accepted alone would refuse to let a
  // deal be won because it had been invoiced.
  Negotiation: [
    { key: "quote_agreed", label: "The client has accepted the quotation (or been invoiced)", required: true, source: "field", field: "quotationAccepted" },
  ],
};

async function main() {
  const apply = process.argv.includes("--apply");
  const skipArg = process.argv.find(a => a.startsWith("--skip="));
  const skip = skipArg ? skipArg.split("=")[1].split(",").map(s => s.trim()).filter(Boolean) : [];
  const stages = await prisma.pipelineStage.findMany({ where: { retired: false }, orderBy: { sort: "asc" } });

  /**
   * HOW MANY DEALS THIS WOULD STOP, before it stops them.
   *
   * A gate that refuses every deal in its column is not a gate, it is a wall somebody will route
   * around by waiving — and then the waiver becomes the habit. So the blast radius is measured and
   * printed per stage against the deals actually sitting there, which is the number that decides
   * whether a rule is a standard or an obstacle. Measured with the real facts, not a guess.
   */
  const { factsFor } = await import("../src/dealchecklist.js");
  const deals = await prisma.opportunity.findMany({ include: { stage: true } });
  const impact: Record<string, { here: number; blocked: number }> = {};
  for (const d of deals) {
    const name = d.stage?.name ?? "";
    const want = GATES[name];
    impact[name] = impact[name] || { here: 0, blocked: 0 };
    impact[name].here++;
    if (!want) continue;
    const co = await prisma.company.findUnique({ where: { id: d.companyId } });
    const f = await factsFor(d, co);
    const short = want.filter(i => {
      const v = String(f[String(i.field)] ?? "").trim().toLowerCase();
      return !v || v === "no" || v === "false" || v === "0";
    });
    if (short.length) impact[name].blocked++;
  }

  for (const st of stages) {
    const want = GATES[st.name];
    const have: any[] = Array.isArray(st.checklistItems) ? (st.checklistItems as any[]) : [];
    if (!want) {
      console.log(`  ${st.name.padEnd(13)} — no gate by design${have.length ? ` (but it carries ${have.length} item(s) — left alone)` : ""}`);
      continue;
    }
    const same = JSON.stringify(have) === JSON.stringify(want) && st.checklistSource === "static";
    if (same) { console.log(`  ${st.name.padEnd(13)} — already configured (${want.length})`); continue; }
    if (skip.includes(st.name)) {
      const im = impact[st.name] ?? { here: 0, blocked: 0 };
      console.log(`  ${st.name.padEnd(13)} — SKIPPED by request (would have blocked ${im.blocked} of ${im.here} deals sitting there)`);
      continue;
    }
    const im = impact[st.name] ?? { here: 0, blocked: 0 };
    console.log(`→ ${st.name.padEnd(13)} ${have.length ? `replacing ${have.length} item(s)` : "setting"} ${want.length}`
      + `  — blocks ${im.blocked} of the ${im.here} deal(s) in this stage today:`);
    for (const i of want) console.log(`       ${i.label}  [${i.source}:${i.field}]`);
    if (apply) {
      await prisma.pipelineStage.update({
        where: { id: st.id },
        // "static" = the list is on the stage itself rather than derived from a ChecklistRule. The
        // rule engine stays available for anything conditional; these four are unconditional.
        data: { checklistSource: "static", checklistItems: want as any },
      });
    }
  }

  if (!apply) { console.log("\n(dry run — pass --apply to write)"); return; }
  console.log("\nconfigured. The gate fires on a MOVE, so deals already sitting in a stage are not");
  console.log("retrospectively blocked — they are asked the next time somebody moves one.");
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
