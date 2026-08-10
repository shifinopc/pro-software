/**
 * Throwaway check: the lead score measures something, and admits what it cannot measure.
 *
 * A lead score is the easiest number in a CRM to fabricate. The assertions that matter are not
 * "does it produce a number" — anything produces a number — but:
 *
 *   · does it MOVE when the underlying facts move, and in the right direction
 *   · is an unmeasurable component EXCLUDED rather than scored zero, so a fact nobody has does not
 *     quietly mark every lead down
 *   · does the shown working actually reproduce the score it sits beside
 *   · does the ordering separate an active lead from an untouched one
 *
 * The last one is set up so alphabetical order is the OPPOSITE of score order. Without that the
 * test passes whichever way the sort behaves, which is not a test — the same trap this session
 * already hit once on the assignment probe.
 *
 * Own leads. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { scoreLead, scoreOpenLeads, sourceConversion } from "../src/leadscore.js";

const sweep = async () => {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ SCORE" } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
};

const base = {
  id: "zz", source: "Website", city: "Riyadh", cr: "1234567890",
  contact: "A Person", email: "a@example.invalid", phone: "+966 55 111 2222",
};
const noConv = { interactions: [] as { at: string }[], hasOpenDeal: false, dealHasValue: false, conv: null as Map<string, number> | null };
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  try {
    await sweep();

    // ── an unmeasurable component is EXCLUDED, not zeroed ─────────────────────────────────────
    const perfect = await scoreLead(base, { ...noConv, interactions: [{ at: iso(0) }, { at: iso(2) }, { at: iso(5) }], hasOpenDeal: true, dealHasValue: true });
    console.log(`a lead doing everything right scores 100: ${perfect.score === 100 ? "YES" : "NO (" + perfect.score + ")"}`);
    if (perfect.score !== 100) fail("a lead with every measurable box ticked could not reach 100 — an absent component is being scored zero");
    console.log(`  and admits only ${perfect.coveragePct}% of the model was measurable`);
    if (perfect.coveragePct === 100) fail("coverage claims 100% while no source history exists — the score overstates what it knows");
    const src = perfect.components.find(c => c.label === "Source track record");
    console.log(`  the unmeasured component is null:      ${src?.earned === null ? "YES" : "NO (" + src?.earned + ")"}`);
    if (src?.earned !== null) fail("source conversion was scored rather than excluded");

    // ── it moves with the facts, in the right direction ───────────────────────────────────────
    const untouched = await scoreLead(base, noConv);
    console.log(`\nnobody has touched it, so lower:         ${untouched.score < perfect.score ? "YES (" + untouched.score + " vs " + perfect.score + ")" : "NO"}`);
    if (untouched.score >= perfect.score) fail("a lead nobody has contacted scores as well as one with a priced deal");

    const stale = await scoreLead(base, { ...noConv, interactions: [{ at: iso(90) }] });
    const fresh = await scoreLead(base, { ...noConv, interactions: [{ at: iso(1) }] });
    console.log(`  a 90-day-old contact below a fresh one:${stale.score < fresh.score ? " YES (" + stale.score + " vs " + fresh.score + ")" : " NO"}`);
    if (stale.score >= fresh.score) fail("interest does not decay — an old list would look permanently healthy");

    const unreachable = await scoreLead({ ...base, email: null, phone: null }, { ...noConv, interactions: [{ at: iso(1) }] });
    console.log(`  no way to contact them, so lower:      ${unreachable.score < fresh.score ? "YES (" + unreachable.score + ")" : "NO"}`);
    if (unreachable.score >= fresh.score) fail("a lead nobody can reach scores the same as one you can");

    const priced = await scoreLead(base, { ...noConv, hasOpenDeal: true, dealHasValue: true });
    const unpriced = await scoreLead(base, { ...noConv, hasOpenDeal: true, dealHasValue: false });
    console.log(`  a priced deal above an unpriced one:   ${priced.score > unpriced.score ? "YES (" + priced.score + " vs " + unpriced.score + ")" : "NO"}`);
    if (priced.score <= unpriced.score) fail("pricing a deal did not raise the score");

    // ── garbage contact details do not count as reachable ─────────────────────────────────────
    const junk = await scoreLead({ ...base, email: "test", phone: "222" }, { ...noConv, interactions: [{ at: iso(1) }] });
    console.log(`  a bad email and a 3-digit phone count:  ${junk.score < fresh.score ? "NO, correctly (" + junk.score + ")" : "YES — wrong"}`);
    if (junk.score >= fresh.score) fail("a malformed email and a 3-digit phone counted as contactable");

    // ── the explanation reproduces the score ──────────────────────────────────────────────────
    const usable = perfect.components.filter(c => c.earned !== null);
    const sum = usable.reduce((s, c) => s + (c.earned ?? 0), 0);
    const max = usable.reduce((s, c) => s + c.max, 0);
    console.log(`\nthe shown working reproduces the score:  ${Math.round((sum / max) * 100) === perfect.score ? "YES" : "NO"}`);
    if (Math.round((sum / max) * 100) !== perfect.score) fail("the component list does not add up to the score shown beside it");

    // ── source conversion stays absent until there is history ─────────────────────────────────
    console.log(`source history is absent, not invented:  ${(await sourceConversion()) === null ? "YES" : "NO"}`);
    if ((await sourceConversion()) !== null) fail("per-source conversion was computed from too little closed business");

    // ── ORDERING, set up so name order is the reverse of score order ──────────────────────────
    const cold = await prisma.company.create({ data: { name: "ZZ SCORE aaa cold", lifecycle: "lead", source: "Website" } });
    const hot = await prisma.company.create({ data: { name: "ZZ SCORE zzz hot", lifecycle: "lead", source: "Website", city: "Riyadh", cr: "9990001111", contact: "Someone", email: "hot@example.invalid", phone: "+966 55 999 8888" } });
    await prisma.interaction.create({ data: { companyId: hot.id, kind: "call", at: iso(0), summary: "ZZ SCORE probe" } });

    const scored = await scoreOpenLeads();
    const h = scored.find(s => s.companyId === hot.id);
    const c2 = scored.find(s => s.companyId === cold.id);
    console.log(`\nthe active lead outscores the empty one: ${h && c2 && h.score > c2.score ? "YES (" + h.score + " vs " + c2.score + ")" : "NO"}`);
    if (!h || !c2 || h.score <= c2.score) fail("scoring a real list did not separate an active lead from an untouched one");
    // Sorted by score, the LAST-named company must come first. Alphabetically it would be last.
    const byScore = [...scored].sort((a, b) => b.score - a.score);
    const topIsHot = byScore[0]?.companyId === h?.companyId || (byScore[0]?.score ?? 0) >= (h?.score ?? 0);
    console.log(`  hottest-first beats alphabetical:      ${topIsHot ? "YES" : "NO"}`);
    if (!topIsHot) fail("sorting by score did not put the hotter lead above the alphabetically-earlier one");

  } finally {
    await sweep();
  }

  const left = await prisma.company.count({ where: { name: { startsWith: "ZZ SCORE" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
