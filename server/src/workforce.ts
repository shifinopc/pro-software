/**
 * Workforce nationalisation — the ratio, and how far it has moved since anyone last checked.
 *
 * WHAT THIS DOES AND DOES NOT CLAIM
 *
 * It counts. Saudization (Nitaqat), Emiratisation and their equivalents all rest on the same
 * arithmetic — how many of a company's workforce hold the nationality of the country it operates in —
 * and that part is a fact this database can establish. So that part is computed here.
 *
 * It does NOT decide a BAND. Platinum/Green/Yellow/Red thresholds are published by MHRSD per economic
 * activity and per size bracket; a construction firm and a retailer with identical headcounts have
 * different targets. Inventing those tables would let the console announce "Green" while Qiwa says
 * Yellow — worse than saying nothing, because somebody would act on it. The band is therefore a
 * RECORDED FACT: whoever reads it on the official portal writes it down, and this module remembers
 * the ratio at that moment so it can say how far things have drifted since.
 *
 * NOTHING IS ASSUMED ABOUT MISSING DATA
 *
 * An employee with no nationality is not quietly treated as an expat. The ratio is returned as a
 * RANGE — what it is if every unknown turns out to be a national, and what it is if none of them do —
 * and `certain` says whether those two are the same number. A single figure computed from incomplete
 * records is the failure mode this whole area is exposed to: under-reporting is the direction that
 * gets a client fined.
 */
import { prisma } from "./db.js";
import { sameCountry, countryName } from "./countries.js";

export type Workforce = {
  companyId: string;
  companyName: string;
  country: string | null;
  countryLabel: string;
  /** Everyone counted: on the books, not archived, not already exited. */
  total: number;
  /** Holds the nationality of the country the company operates in. */
  nationals: number;
  /** Holds a different nationality — known, not merely unrecorded. */
  expats: number;
  /** Nationality not recorded. Counted in the total, excluded from both certainties. */
  unknown: number;
  /** Basis points, so no float ever decides a percentage. 3333 = 33.33%. */
  ratioBp: number;
  ratioMinBp: number;
  ratioMaxBp: number;
  certain: boolean;
  /** Qualifiers that stop the number being read as more precise than it is. */
  partTime: number;
  unknownEmploymentType: number;
  /** The band somebody read on the official portal, and when. */
  band: string | null;
  bandAt: string | null;
  bandNote: string | null;
  /** The ratio at the moment that band was recorded — what "drift" is measured against. */
  bandRatioBp: number | null;
  driftBp: number | null;
  /** True only when the ratio has FALLEN since the band was recorded. Rising is not a warning. */
  slipped: boolean;
  /** Employees counted toward another country, so the reader knows why a headcount looks short. */
  elsewhere: number;

  /**
   * The band the CONFIGURED thresholds put this ratio in, or null if no bands are set up for the
   * country. Separate from `band` (what someone read on the portal) on purpose: when both exist and
   * they disagree, that disagreement is the single most useful thing on the screen — either the
   * thresholds are wrong or the portal knows something the headcount does not.
   */
  computedBand: { name: string; color: string | null; bg: string | null } | null;
  /** True only when both are known and they differ. */
  bandMismatch: boolean;
  /** How far into the current band, and what reaching the next one would take. */
  nextBand: { name: string; atBp: number; needBp: number } | null;
};

/**
 * Which configured band a ratio falls in.
 *
 * Bands are the firm's own record of what a regulator publishes — this module never invents one, and
 * with none configured it returns null rather than guessing, which is what keeps the recorded-band
 * behaviour working for a country nobody has set thresholds up for yet.
 */
export async function bandsFor(country: string | null) {
  if (!country) return [];
  return prisma.workforceBand.findMany({
    where: { country, retired: false },
    orderBy: [{ sort: "asc" }, { minBp: "asc" }],
  });
}

const bp = (part: number, whole: number) => (whole > 0 ? Math.round((part * 10000) / whole) : 0);

/**
 * One company's position.
 *
 * `workCountry` decides which country a person counts toward, falling back to the employer's country.
 * A group with entities in two countries needs that — an employee counts once, not in both places.
 */
export async function workforceFor(companyId: string): Promise<Workforce | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, country: true, workforceBand: true, workforceBandAt: true, workforceBandNote: true, workforceBandRatioBp: true },
  });
  if (!company) return null;

  const staff = await prisma.employee.findMany({
    // Archived and exited people are off the books. Counting someone who left last year inflates a
    // headcount the client would be measured on today.
    where: { companyId, archived: false, exitStatus: { not: "exited" } },
    select: { nationality: true, workCountry: true, employmentType: true },
  });

  const country = company.country ?? null;
  const here = staff.filter(e => sameCountry(e.workCountry ?? country, country));
  const elsewhere = staff.length - here.length;

  let nationals = 0, expats = 0, unknown = 0, partTime = 0, unknownEmploymentType = 0;
  for (const e of here) {
    if (!e.nationality) unknown++;
    else if (sameCountry(e.nationality, country)) nationals++;
    else expats++;
    if (e.employmentType === "part_time") partTime++;
    else if (!e.employmentType) unknownEmploymentType++;
  }

  const total = here.length;
  const ratioMinBp = bp(nationals, total);                 // every unknown turns out to be an expat
  const ratioMaxBp = bp(nationals + unknown, total);       // every unknown turns out to be a national
  const bandRatioBp = company.workforceBandRatioBp ?? null;
  // Drift is measured against the LOW end, the same end that gets a client into trouble.
  const driftBp = bandRatioBp === null ? null : ratioMinBp - bandRatioBp;

  // The band the thresholds put this ratio in. Measured against the LOW end, the same end drift is
  // measured against — the figure that holds if every unrecorded nationality turns out to be an expat.
  const bands = await bandsFor(country);
  // A client with nobody on the books has no ratio to place. 0 of 0 arithmetically reads as 0%, which
  // would drop them in the bottom band and show a compliance failure for a workforce that does not
  // exist — the same "answer to a question nobody asked" the headline figure already avoids.
  const placeable = total > 0;
  const hit = placeable
    ? (bands.find(b => ratioMinBp >= b.minBp && (b.maxBp == null || ratioMinBp < b.maxBp)) ?? null)
    : null;
  const above = placeable
    ? (bands.filter(b => b.minBp > ratioMinBp).sort((a, b) => a.minBp - b.minBp)[0] ?? null)
    : null;

  return {
    computedBand: hit ? { name: hit.name, color: hit.color ?? null, bg: hit.bg ?? null } : null,
    // Only a real disagreement counts: both known, and different.
    bandMismatch: !!(hit && company.workforceBand && hit.name !== company.workforceBand),
    nextBand: above ? { name: above.name, atBp: above.minBp, needBp: above.minBp - ratioMinBp } : null,
    companyId: company.id,
    companyName: company.name,
    country,
    countryLabel: country ? countryName(country) : "no country set",
    total, nationals, expats, unknown,
    ratioBp: ratioMinBp, ratioMinBp, ratioMaxBp,
    certain: unknown === 0,
    partTime, unknownEmploymentType,
    band: company.workforceBand ?? null,
    bandAt: company.workforceBandAt ?? null,
    bandNote: company.workforceBandNote ?? null,
    bandRatioBp,
    driftBp,
    slipped: driftBp !== null && driftBp < 0,
    elsewhere,
  };
}

/** Every client, for the list and the dashboard. */
export async function workforceAll(): Promise<Workforce[]> {
  const ids = await prisma.company.findMany({ select: { id: true }, orderBy: { name: "asc" } });
  const out: Workforce[] = [];
  for (const c of ids) {
    const w = await workforceFor(c.id);
    if (w) out.push(w);
  }
  return out;
}

/**
 * Write down the band somebody read on the official portal.
 *
 * The ratio at this moment is captured ALONGSIDE it, automatically. Without that there is nothing to
 * measure drift against, and "you were Green in March" tells you nothing about whether the workforce
 * has changed underneath since.
 */
export async function recordBand(companyId: string, band: string, at: string, note?: string | null) {
  const now = await workforceFor(companyId);
  if (!now) throw new Error("No such client");
  await prisma.company.update({
    where: { id: companyId },
    data: {
      workforceBand: band || null,
      workforceBandAt: band ? at : null,
      workforceBandNote: band ? (note ?? null) : null,
      // Cleared with the band: a captured ratio with no band attached measures drift from nothing.
      workforceBandRatioBp: band ? now.ratioMinBp : null,
    },
  });
  return workforceFor(companyId);
}
