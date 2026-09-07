/**
 * Prove that a weighted headcount is actually weighted, and that the choice nobody should assume is
 * a choice the configuration makes rather than this code.
 *
 * The rule that prompted this: Saudi Nitaqat counts an employee with a disability as FOUR Saudi
 * employees. The question that has no safe default is whether those four land only in the nationals
 * figure or in the workforce total as well, because the two give materially different percentages:
 *
 *   10 staff, 2 Saudi, one of them with a disability
 *     ratio only          5 / 10  = 50.00%
 *     ratio and total     5 / 13  = 38.46%
 *
 * Both are computed here from the same people, differing only by `appliesTo` on the rule. If this
 * probe ever shows one number for both, the setting has stopped meaning anything and somebody is
 * reporting a compliance position that is not theirs.
 *
 * Also proves the things that would quietly go wrong:
 *   - a rule conditioned on nationals never fires for an expatriate
 *   - a rule nobody is claimed under changes nothing, and the screen is told the count is not weighted
 *   - rules compound rather than one silently winning
 *   - an unrecorded nationality is not given national-only credit at the LOW end of the range
 *
 * Own country, own client, own ladder. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { workforceFor } from "../src/workforce.js";

const COUNTRY = "ZY";
const CLIENT = "ZS Counting Probe";

async function sweep() {
  const co = await prisma.company.findFirst({ where: { name: CLIENT } });
  if (co) {
    await prisma.employee.deleteMany({ where: { companyId: co.id } });
    await prisma.workforceSnapshot.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  const sets = await prisma.workforceBandSet.findMany({ where: { country: COUNTRY }, select: { id: true } });
  await prisma.workforceBand.deleteMany({ where: { setId: { in: sets.map(s => s.id) } } });
  await prisma.workforceBandSet.deleteMany({ where: { country: COUNTRY } });
}

const DISABILITY = (appliesTo: "both" | "nationals") => ({
  key: "disability", label: "Has a disability",
  when: { nationality: "national" }, countsAs: 400, appliesTo,
});
const PART_TIME = { key: "part_time", label: "Part time", from: "employmentType=part_time", countsAs: 50, appliesTo: "both" };

async function setRules(setId: string, counting: any[]) {
  await prisma.workforceBandSet.update({ where: { id: setId }, data: { counting: counting as any } });
}

const pct = (bp: number) => (bp / 100).toFixed(2) + "%";
const ppl = (h: number) => String(h / 100);

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  const set = await prisma.workforceBandSet.create({
    data: { country: COUNTRY, name: "ZY ladder", isDefault: true },
  });
  await prisma.workforceBand.createMany({ data: [
    { country: COUNTRY, setId: set.id, name: "Red", minBp: 0, maxBp: 4000, sort: 0 },
    { country: COUNTRY, setId: set.id, name: "Green", minBp: 4000, maxBp: null, sort: 1 },
  ] });

  const co = await prisma.company.create({
    data: { name: CLIENT, country: COUNTRY, industry: "Construction", status: "active", lifecycle: "client" } as any,
  });
  // Ten people: two nationals, one of whom is claimed under the disability rule. Everyone full time,
  // so the only thing moving a number is the rule under test.
  const mk = (i: number, nat: string, traits: string[] = [], employmentType = "full_time") =>
    prisma.employee.create({ data: {
      companyId: co.id, name: `ZS counting ${i}`, nationality: nat, employmentType,
      countingTraits: traits as any, archived: false, exitStatus: "active",
    } as any });
  await mk(1, COUNTRY, ["disability"]);
  await mk(2, COUNTRY);
  for (let i = 3; i <= 10; i++) await mk(i, "IN");

  // ── the choice that has no safe default ────────────────────────────────────────────────────
  await setRules(set.id, [DISABILITY("nationals")]);
  const a = await workforceFor(co.id);
  console.log(`counted in the ratio only:     ${pct(a!.ratioMinBp)}   (${ppl(a!.countedNationals)} of ${ppl(a!.countedTotal)}, ${a!.total} on the books)`);
  if (a!.ratioMinBp !== 5000) fail(`ratio-only should be 50.00%, got ${pct(a!.ratioMinBp)}`);
  if (a!.countedTotal !== 1000) fail(`ratio-only must leave the total at ten people, got ${ppl(a!.countedTotal)}`);

  await setRules(set.id, [DISABILITY("both")]);
  const b = await workforceFor(co.id);
  console.log(`counted in the ratio and total: ${pct(b!.ratioMinBp)}   (${ppl(b!.countedNationals)} of ${ppl(b!.countedTotal)}, ${b!.total} on the books)`);
  if (b!.ratioMinBp !== 3846) fail(`ratio-and-total should be 38.46%, got ${pct(b!.ratioMinBp)}`);
  if (b!.countedTotal !== 1300) fail(`ratio-and-total should count thirteen people, got ${ppl(b!.countedTotal)}`);
  if (a!.ratioMinBp === b!.ratioMinBp) fail("both settings gave the same number — appliesTo has stopped meaning anything");

  // The headcount itself never moves. The rules change what a person is WORTH, never how many there are.
  if (a!.total !== 10 || b!.total !== 10) fail("the headcount moved — weighting must not invent or lose people");

  // ── the working is reportable ──────────────────────────────────────────────────────────────
  console.log(`  working:                      ${b!.counting.map(c => `${c.people} x ${c.label} ${c.word}`).join(" | ")}`);
  if (b!.counting.length !== 1 || b!.counting[0].people !== 1) fail("the working does not name the one person the rule touched");
  if (!b!.weighted) fail("a weighted count did not report itself as weighted");

  // ── a nationals-only rule never fires for an expatriate ────────────────────────────────────
  const expat = await mk(11, "IN", ["disability"]);
  const c = await workforceFor(co.id);
  console.log("");
  console.log(`an expat ticked for a nationals-only rule: total counted ${ppl(c!.countedTotal)} (was ${ppl(b!.countedTotal)} + 1 body)`);
  if (c!.countedTotal !== b!.countedTotal + 100) fail("an expatriate was given credit from a rule written for nationals");
  if (c!.countedNationals !== b!.countedNationals) fail("an expatriate moved the nationals figure");
  await prisma.employee.delete({ where: { id: expat.id } });

  // ── rules compound ─────────────────────────────────────────────────────────────────────────
  await setRules(set.id, [DISABILITY("both"), PART_TIME]);
  await prisma.employee.updateMany({ where: { companyId: co.id, name: "ZS counting 1" }, data: { employmentType: "part_time" } });
  const d = await workforceFor(co.id);
  console.log("");
  console.log(`a part-time national with a disability:  counted as ${ppl(d!.countedNationals - 100)} (4 x 0.5 = 2)`);
  // Person 1 is 4 x 0.5 = 2; person 2 is 1. Nationals = 3.
  if (d!.countedNationals !== 300) fail(`compounding gave ${ppl(d!.countedNationals)} nationals, expected 3`);
  await prisma.employee.updateMany({ where: { companyId: co.id, name: "ZS counting 1" }, data: { employmentType: "full_time" } });

  // ── an unrecorded nationality gets no national-only credit at the low end ──────────────────
  const mystery = await mk(12, "", ["disability"]);
  await prisma.employee.update({ where: { id: mystery.id }, data: { nationality: null } });
  await setRules(set.id, [DISABILITY("both")]);
  const e = await workforceFor(co.id);
  console.log("");
  console.log(`unrecorded nationality, ticked:  low ${pct(e!.ratioMinBp)} · high ${pct(e!.ratioMaxBp)}`);
  // At the low end they are an expatriate: one body, no credit. At the high end they are a national
  // with a disability: four. The range is meant to widen, which is the honest reading.
  if (e!.countedNationals !== b!.countedNationals) fail("an unrecorded nationality was given national credit at the low end");
  if (e!.ratioMaxBp <= e!.ratioMinBp) fail("the range did not widen for a person whose nationality is unknown");

  // ── no rules, nothing claimed: a plain headcount that says so ──────────────────────────────
  await prisma.employee.delete({ where: { id: mystery.id } });
  await setRules(set.id, []);
  const f = await workforceFor(co.id);
  console.log("");
  console.log(`with no counting rules at all:   ${pct(f!.ratioMinBp)} (${f!.nationals} of ${f!.total}) · weighted: ${f!.weighted}`);
  if (f!.ratioMinBp !== 2000) fail(`an unweighted ratio should be 20.00%, got ${pct(f!.ratioMinBp)}`);
  if (f!.weighted) fail("an unweighted count reported itself as weighted");

  // A rule configured but nobody claimed under it must also read as unweighted.
  await setRules(set.id, [DISABILITY("both")]);
  await prisma.employee.updateMany({ where: { companyId: co.id }, data: { countingTraits: [] as any } });
  const g = await workforceFor(co.id);
  console.log(`rule configured, nobody claimed: ${pct(g!.ratioMinBp)} · weighted: ${g!.weighted}`);
  if (g!.weighted) fail("a rule nobody is claimed under made the count report itself as weighted");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
