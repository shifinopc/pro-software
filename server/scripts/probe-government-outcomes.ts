/**
 * Throwaway check that a government "no" has somewhere to go, and that the steps which must happen
 * before a visa actually happen before it.
 *
 * Every government step used to have exactly two ways out: complete it, or leave it open forever. A
 * rejected visa had to be recorded as a successful application, because that was the only button on
 * the screen — and the run then issued a Work Visa document for a visa that does not exist, went on
 * to arrival, and put somebody on the compliance reports who was never coming.
 *
 * The pre-visa half is the other order-of-operations trap. Professional qualification verification
 * has to be done before the visa is stamped and CANNOT be done after entry: get it wrong and the
 * employee is already in the country on a permit that should not have been issued, with exit and
 * re-entry as the cheapest remedy.
 *
 * Reads the stored graph and walks it the way the engine routes. Creates nothing.
 */
import { prisma } from "../src/db.js";

/** Every step where a government body decides something, and what a refusal is called there. */
const GOV = [
  { step: "visa_auth",      outcome: "quotaOutcome",         refuse: "refused",        doc: null },
  { step: "prof_verify",    outcome: "verificationOutcome",  refuse: "rejected",       doc: null },
  { step: "medical_wafid",  outcome: "wafidOutcome",         refuse: "unfit",          doc: null },
  { step: "visa_apply",     outcome: "visaOutcome",          refuse: "rejected",       doc: "Work Visa" },
  { step: "arrival",        outcome: "arrivalOutcome",       refuse: "medical_failed", doc: null },
  { step: "permit_task",    outcome: "permitOutcome",        refuse: "refused",        doc: "Work Permit" },
  { step: "iqama_task",     outcome: "iqamaOutcome",         refuse: "refused",        doc: "Iqama" },
  { step: "iqama_transfer", outcome: "iqamaTransferOutcome", refuse: "refused",        doc: "Iqama" },
];

const HAPPY: Record<string, string> = {
  documentsVerified: "pass", employeeJoined: "yes", probationOutcome: "yes",
  transferOutcome: "approved", quotaOutcome: "authorised", verificationOutcome: "verified",
  wafidOutcome: "fit", visaOutcome: "issued", arrivalOutcome: "cleared", permitOutcome: "issued",
  iqamaOutcome: "issued", iqamaTransferOutcome: "updated", gosiOutcome: "registered",
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  if (!tpl) { console.log("template not found"); process.exit(1); }
  const g: any = tpl.graph;
  const nodes: any[] = g.nodes ?? [], edges: any[] = g.edges ?? [];
  const byId = new Map<string, any>(nodes.map(n => [n.id, n]));
  const out = (id: string) => edges.filter(e => e.from === id);

  /** Walk from start the way the engine routes, collecting nodes reached and documents issued. */
  const walk = (vars: Record<string, string>) => {
    const seen = new Set<string>(), docs: string[] = [];
    const step = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const n = byId.get(id); if (!n) return;
      if (n.type === "issue_document") docs.push(String(n.config?.docType));
      if (n.type === "decision") {
        const hit = (n.config?.branches ?? []).find((b: any) => String(vars[b.var] ?? "") === String(b.value));
        const key = hit ? hit.key : "else";
        let nx = out(id).filter(e => String(e.condition ?? "") === key);
        if (!nx.length) nx = out(id).filter(e => ["else", "default", ""].includes(String(e.condition ?? "")));
        for (const e of nx) step(e.to);
        return;
      }
      for (const e of out(id)) if (String(e.condition ?? "") !== "reject") step(e.to);
    };
    step("start");
    return { seen, docs };
  };

  // ── H10: the three steps that have to come first ──────────────────────────────────────────────
  console.log("pre-visa steps on the expatriate new-hire path:");
  const expat = walk({ ...HAPPY, hiringType: "expat_new_hire" });
  for (const id of ["visa_auth", "prof_verify", "medical_wafid"]) {
    const n = byId.get(id);
    console.log(`  ${id.padEnd(15)} ${n ? `"${n.label}"`.padEnd(38) : "MISSING".padEnd(38)} ${expat.seen.has(id) ? "on the path" : "NOT REACHED"}`);
    if (!n) fail(`${id} does not exist — a real expatriate visa application stalls without it`);
    else if (!expat.seen.has(id)) fail(`"${n.label}" exists but no expatriate run reaches it`);
  }

  // ORDER, not just presence. Verification after the visa is worse than useless: it cannot be done
  // once the employee has entered, and a workflow containing the step would have said it was fine.
  //
  // Asked as: is there a route from the start to the visa application that never passes through this
  // step? Anything else — an edge count, a position on the canvas — can be satisfied by a step that
  // sits beside the path rather than across it.
  const reachesWithout = (target: string, without: string) => {
    const q = ["start"], seen = new Set<string>();
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id) || id === without) continue;
      seen.add(id);
      if (id === target) return true;
      for (const e of out(id)) q.push(e.to);
    }
    return false;
  };
  console.log("");
  for (const id of ["visa_auth", "prof_verify", "medical_wafid"]) {
    const skippable = reachesWithout("visa_apply", id);
    console.log(`  the visa cannot be applied for without "${byId.get(id)?.label ?? id}": ${skippable ? "NO" : "YES"}`);
    if (skippable) fail(`the visa application is reachable without "${byId.get(id)?.label ?? id}" — the step exists but gates nothing`);
  }

  // and none of it lands on a Saudi national or an internal transfer
  console.log("");
  for (const [type, label] of [["saudi_national", "a Saudi national"], ["expat_transfer", "an internal transfer"]] as const) {
    const w = walk({ ...HAPPY, hiringType: type });
    const wrong = ["visa_auth", "prof_verify", "medical_wafid", "visa_apply"].filter(id => w.seen.has(id));
    console.log(`  ${label.padEnd(22)} reaches none of the visa steps: ${wrong.length === 0 ? "YES" : "NO (" + wrong.join(", ") + ")"}`);
    if (wrong.length) fail(`${label} is routed through ${wrong.join(", ")} — visa work that does not apply to them`);
  }

  // ── H13: a refusal at each government step ────────────────────────────────────────────────────
  console.log("\nwhat happens when the authority says no:");
  for (const gov of GOV) {
    const type = gov.step === "iqama_transfer" ? "expat_transfer" : "expat_new_hire";
    const w = walk({ ...HAPPY, hiringType: type, [gov.outcome]: gov.refuse });
    const stopped = w.seen.has("gov_stop");
    const confirmed = w.seen.has("end_ok");
    console.log(`  ${gov.step.padEnd(15)} ${(gov.outcome + "=" + gov.refuse).padEnd(34)} ${stopped ? "stops at the refusal desk" : "NOT MODELLED"}`);
    if (!stopped) fail(`a refusal at "${gov.step}" has no modelled outcome — the only ways out are to record it as a success or leave the task open`);
    if (confirmed) fail(`a refusal at "${gov.step}" still reaches Employee Confirmed`);
    if (gov.doc && w.docs.includes(gov.doc)) fail(`a refused ${gov.step} still issues a ${gov.doc} — a government record for a document the authority declined`);
  }

  // ── the refusal path is a desk, not a full stop ───────────────────────────────────────────────
  const stop = byId.get("gov_stop");
  console.log("");
  console.log(`the refusal path is a step somebody works:  ${stop?.type === "task" ? "YES" : "NO (" + (stop?.type ?? "missing") + ")"}`);
  if (stop?.type !== "task") fail("a refusal goes straight to an end node — whatever was already issued stays live on the record of somebody who will never join, and the renewal engine chases it for years");
  const items = (stop?.config?.checklist ?? []).map((i: any) => String(i.label ?? i.key));
  console.log(`  ${items.join(" · ") || "no checklist"}`);
  if (!items.some((i: string) => /withdraw|cancel/i.test(i))) fail("the refusal step never withdraws the documents already issued");
  if (!(stop?.config?.captures ?? []).some((c: any) => c.required)) fail("the refusal step records no reason, so nobody can tell later why the hire stopped");
  const after = out("gov_stop").map(e => byId.get(e.to)?.type);
  console.log(`  ...and then the run ends:                 ${after.includes("end") ? "YES" : "NO"}`);
  if (!after.includes("end")) fail("the refusal step does not end the run");

  // ── the one that must NOT leave its branch ────────────────────────────────────────────────────
  //
  // Payroll runs inside the parallel block. A branch that exits to the stop path never arrives at the
  // join, and the other two wait forever on a run that has already ended.
  const gosiExits = out("d_gosi").map(e => e.to);
  const escapes = gosiExits.filter(t => t === "gov_stop" || byId.get(t)?.type === "end");
  console.log(`\nthe GOSI branch never leaves the parallel block: ${escapes.length === 0 ? "YES" : "NO (" + escapes.join(", ") + ")"}`);
  if (escapes.length) fail(`the GOSI failure branch exits to ${escapes.join(", ")}, stranding the join — the other two branches would wait on a run that has already ended`);

  // ── every government step actually asks ───────────────────────────────────────────────────────
  console.log("\nevery government step records what was decided:");
  for (const gov of GOV) {
    const cap = (byId.get(gov.step)?.config?.captures ?? []).find((c: any) => c.var === gov.outcome);
    console.log(`  ${gov.step.padEnd(15)} ${cap ? (cap.required ? "required" : "OPTIONAL") : "MISSING"}`);
    if (!cap) fail(`"${gov.step}" never asks what the authority decided`);
    else if (cap.required !== true) fail(`"${gov.step}" asks for the outcome but does not require it — a blank falls to the retry edge and the file goes round in circles`);
  }

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
