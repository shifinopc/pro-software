/**
 * A standard Saudi Nitaqat ladder, available to pick on any Saudi client.
 *
 * Creates ONE named ladder and its counting rules. It is not marked as a country default and nothing
 * is assigned to it — every client is still put on a ladder deliberately, on their own screen. This
 * exists so the common case is one click instead of twenty rows of typing.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS A NUMBER HERE, AND WHAT IS DELIBERATELY NOT
 *
 * COUNTING RULES — carried, because they are stable and widely published:
 *
 *   A Saudi employee with a disability counts as FOUR Saudi employees.
 *   A part-time employee counts as a HALF.
 *
 * GENDER — deliberately NOT carried. As far as can be established, Nitaqat counts a Saudi man and a
 * Saudi woman identically, at one each. There are real incentives around employing Saudi women —
 * HRDF/Hadaf wage support, childcare subsidies — but those are money, not a multiplier in the
 * Saudization percentage. Seeding a female multiplier would inflate every client's ratio, which is
 * the direction that gets somebody fined for being told they were compliant.
 *
 *   If the client's Qiwa reading says otherwise, it is one rule to add and no code to change:
 *   the employee record now carries `gender`, and a rule conditioned on { gender: "female" } works
 *   immediately. Add it in the band editor, or uncomment RULE_FEMALE below and set the figure.
 *
 * BAND THRESHOLDS — the shape, NOT the published figures. MHRSD publishes them per economic activity
 * and per size bracket; a general ladder cannot be right for every activity, and this one is a
 * starting point to correct against Qiwa rather than a table to adopt. That is why the ladder is
 * named "general" and why the app never computes a band it has not been given.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";
const NAME = "Saudi Arabia — general (Nitaqat)";
const PACK = "sa.bandset.nitaqat-general";

const PALETTE: Record<string, [string, string]> = {
  Red: ["#C0353A", "#FEECEC"],
  Yellow: ["#B8860B", "#FEF9EF"],
  Green: ["#0E9355", "#E7F8EF"],
  Platinum: ["#4B4757", "#F2F1F5"],
};

/** Percentages as published; stored as basis points so no float decides a boundary. */
const BANDS: [string, number, number | null][] = [
  ["Red", 0, 10],
  ["Yellow", 10, 25],
  ["Green", 25, 40],
  ["Platinum", 40, null],
];

const COUNTING: any[] = [
  {
    key: "disability", label: "Has a disability",
    when: { nationality: "national" },
    // Hundredths. 400 = counts as four.
    countsAs: 400,
    // Both halves of the sum. Confirm against Qiwa whether the credit lands in the workforce total
    // as well as in the nationals figure — it is worth about 11 points on a ten-person company, and
    // the app will not choose it for anybody.
    appliesTo: "both",
  },
  {
    key: "part_time", label: "Part time",
    // Read from the employment type already on the record rather than asked again as a tick box.
    from: "employmentType=part_time",
    countsAs: 50,
    appliesTo: "both",
  },
  // RULE_FEMALE — intentionally absent. See the note at the top of this file. To add it, uncomment
  // and set the published figure. `from` reads the gender column directly, so there is no tick box
  // and nothing for anybody to forget to tick — verified to weight a Saudi woman and leave a Saudi
  // man, an unrecorded gender and an expatriate woman untouched.
  // { key: "female_saudi", label: "Saudi woman", when: { nationality: "national" },
  //   from: "gender=female", countsAs: <the published figure, in hundredths>, appliesTo: "both" },
];

async function main() {
  const found = await prisma.workforceBandSet.findFirst({
    where: { OR: [{ packKey: PACK }, { name: NAME, country: COUNTRY }] },
  });
  const data = {
    country: COUNTRY, name: NAME, activity: null, sizeMin: null, sizeMax: null,
    // NOT the country default: clients are put on a ladder deliberately, one at a time.
    isDefault: false, sort: 0, retired: false, packKey: PACK,
    counting: COUNTING as any,
  };
  const set = found
    ? await prisma.workforceBandSet.update({ where: { id: found.id }, data })
    : await prisma.workforceBandSet.create({ data });
  console.log(`${found ? "updated" : "created"} "${NAME}"`);

  let sort = 0;
  for (const [name, from, to] of BANDS) {
    const key = `${PACK}.${name.toLowerCase()}`;
    const row = {
      country: COUNTRY, setId: set.id, name,
      minBp: Math.round(from * 100), maxBp: to == null ? null : Math.round(to * 100),
      color: PALETTE[name]?.[0] ?? null, bg: PALETTE[name]?.[1] ?? null,
      sort: sort++, retired: false,
    };
    const existing = await prisma.workforceBand.findFirst({ where: { packKey: key } });
    if (existing) await prisma.workforceBand.update({ where: { id: existing.id }, data: row });
    else await prisma.workforceBand.create({ data: { ...row, packKey: key } });
  }

  console.log(`  bands:  ${BANDS.map(([n, f, t]) => `${n} ${f}%${t == null ? "+" : "–" + t + "%"}`).join("  ·  ")}`);
  console.log(`  counts: ${COUNTING.map(c => `${c.label} ×${c.countsAs / 100}`).join("  ·  ")}`);
  console.log("");
  console.log("Available to pick on any Saudi client. Nothing is assigned to it and it is not a default.");
  console.log("The BAND PERCENTAGES are a starting point, not the published figures — MHRSD sets them per");
  console.log("activity and size bracket. Check this ladder against Qiwa before a client is judged by it.");
  console.log("NO GENDER MULTIPLIER is set: a Saudi man and a Saudi woman count the same. If Qiwa says");
  console.log("otherwise for this client, add the rule in the band editor — the employee record now");
  console.log("carries gender, so a rule on { gender: \"female\" } works with no code change.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
