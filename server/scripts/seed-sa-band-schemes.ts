/**
 * A starting set of Saudi band schemes, so the console has something real to show.
 *
 * These are the SHAPE of what MHRSD publishes — a general ladder plus per-activity, per-size ones —
 * and NOT a claim about the current published figures. Nitaqat thresholds change, and they change
 * per activity; whoever runs this has to check each ladder against Qiwa before trusting a band that
 * comes out of it. The app's whole discipline here is that it never invents thresholds, and a seed
 * script is not an exception to that: it is a set of rows to correct, not to adopt.
 *
 * Idempotent: re-running updates in place rather than creating a second of anything.
 */
import { prisma } from "../src/db.js";

const COUNTRY = "SA";

const PALETTE: Record<string, [string, string]> = {
  Red: ["#C0353A", "#FEECEC"],
  Yellow: ["#B8860B", "#FEF9EF"],
  Green: ["#0E9355", "#E7F8EF"],
  Platinum: ["#4B4757", "#F2F1F5"],
};

async function scheme(
  key: string,
  name: string,
  opts: { activity?: string; sizeMin?: number; sizeMax?: number; isDefault?: boolean; sort?: number },
  rows: [string, number, number | null][],
) {
  const packKey = `sa.bandset.${key}`;
  const data = {
    country: COUNTRY, name, activity: opts.activity ?? null,
    sizeMin: opts.sizeMin ?? null, sizeMax: opts.sizeMax ?? null,
    isDefault: !!opts.isDefault, sort: opts.sort ?? 0, retired: false,
  };
  const found = await prisma.workforceBandSet.findFirst({ where: { OR: [{ packKey }, { name, country: COUNTRY }] } });
  const set = found
    ? await prisma.workforceBandSet.update({ where: { id: found.id }, data: { ...data, packKey } })
    : await prisma.workforceBandSet.create({ data: { ...data, packKey } });

  let sort = 0;
  for (const [bandName, from, to] of rows) {
    const bandKey = `${packKey}.${bandName.toLowerCase()}`;
    const bandData = {
      country: COUNTRY, setId: set.id, name: bandName,
      minBp: Math.round(from * 100), maxBp: to == null ? null : Math.round(to * 100),
      color: PALETTE[bandName]?.[0] ?? null, bg: PALETTE[bandName]?.[1] ?? null,
      sort: sort++, retired: false,
    };
    const existing = await prisma.workforceBand.findFirst({ where: { packKey: bandKey } });
    if (existing) await prisma.workforceBand.update({ where: { id: existing.id }, data: bandData });
    else await prisma.workforceBand.create({ data: { ...bandData, packKey: bandKey } });
  }
  console.log(`  ${found ? "updated" : "created"} "${name}" (${rows.length} bands)${opts.isDefault ? " · country default" : ""}`);
  return set;
}

async function main() {
  // Exactly one default, enforced here as well as by the route: two would mean an unassigned
  // client's ladder depends on row order.
  await prisma.workforceBandSet.updateMany({ where: { country: COUNTRY }, data: { isDefault: false } });

  await scheme("general", "General — all activities", { isDefault: true, sort: 0 },
    [["Red", 0, 10], ["Yellow", 10, 25], ["Green", 25, 40], ["Platinum", 40, null]]);

  await scheme("construction-small", "Construction · under 50", { activity: "Construction", sizeMax: 49, sort: 10 },
    [["Red", 0, 5], ["Yellow", 5, 12], ["Green", 12, 25], ["Platinum", 25, null]]);
  await scheme("construction-mid", "Construction · 50–499", { activity: "Construction", sizeMin: 50, sizeMax: 499, sort: 11 },
    [["Red", 0, 8], ["Yellow", 8, 16], ["Green", 16, 30], ["Platinum", 30, null]]);
  await scheme("construction-large", "Construction · 500+", { activity: "Construction", sizeMin: 500, sort: 12 },
    [["Red", 0, 12], ["Yellow", 12, 22], ["Green", 22, 38], ["Platinum", 38, null]]);

  await scheme("technology", "Technology · 50–499", { activity: "Technology", sizeMin: 50, sizeMax: 499, sort: 20 },
    [["Red", 0, 15], ["Yellow", 15, 30], ["Green", 30, 50], ["Platinum", 50, null]]);

  const sets = await prisma.workforceBandSet.count({ where: { country: COUNTRY, retired: false } });
  const bands = await prisma.workforceBand.count({ where: { country: COUNTRY, retired: false } });
  console.log(`\n${sets} scheme(s), ${bands} band(s) for ${COUNTRY}`);
  console.log("These are the SHAPE of the Nitaqat ladders, not the current published figures — check each one against Qiwa.");
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
