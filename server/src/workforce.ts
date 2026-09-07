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
import { ACTIVE_CLIENT } from "./validate.js";

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
  /**
   * Which scheme placed the ratio, and how this client came to be judged by it.
   *
   * On screen beside the band because a computed band is only as good as the ladder behind it, and
   * "Green" against the wrong thresholds looks exactly like "Green" against the right ones.
   * `assigned` separates a scheme somebody chose from the country default a client merely fell to.
   */
  bandSet: { id: string; name: string; assigned: boolean; isDefault: boolean } | null;
  /**
   * A scheme that fits this client's activity and headcount better than the one in force, if there
   * is one. A SUGGESTION - never applied. Assigning thresholds nobody chose is the guessing this
   * module exists to avoid; the officer confirms it or ignores it.
   */
  bandSetSuggestion: { id: string; name: string; why: string } | null;
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
  const set = await defaultSetFor(country);
  return set ? bandsInSet(set.id) : [];
}

/** The rows of one scheme, lowest first. */
export async function bandsInSet(setId: string) {
  return prisma.workforceBand.findMany({
    where: { setId, retired: false },
    orderBy: [{ sort: "asc" }, { minBp: "asc" }],
  });
}

/** The scheme a client falls to when nobody has chosen one for it. */
export async function defaultSetFor(country: string | null) {
  if (!country) return null;
  return prisma.workforceBandSet.findFirst({
    where: { country, retired: false, isDefault: true },
    orderBy: [{ sort: "asc" }],
  });
}

/**
 * The scheme that judges one client, and how it got there.
 *
 * A scheme that has been RETIRED is treated as no scheme rather than followed quietly: retiring the
 * thresholds is somebody saying they no longer describe the regulator, and continuing to place
 * clients against them because a foreign key still points there is the opposite of what was meant.
 */
export async function bandSetForCompany(co: { country: string | null; workforceBandSetId?: string | null }) {
  if (co.workforceBandSetId) {
    const chosen = await prisma.workforceBandSet.findFirst({ where: { id: co.workforceBandSetId, retired: false } });
    if (chosen) return { set: chosen, assigned: true };
  }
  const fallback = await defaultSetFor(co.country ?? null);
  return fallback ? { set: fallback, assigned: false } : null;
}

/** The bands that place one client's ratio. */
export async function bandsForCompany(co: { country: string | null; workforceBandSetId?: string | null }) {
  const hit = await bandSetForCompany(co);
  return hit ? bandsInSet(hit.set.id) : [];
}

/**
 * A better-fitting scheme than the one in force, if the schemes on file describe one.
 *
 * Matched on what a scheme SAYS it covers - activity wording and headcount bracket - and returned
 * only when it is not already the scheme in use. Both halves have to agree: a scheme claiming an
 * activity is not a match for a client of a different activity merely because the headcount fits,
 * which is the failure that would file a retailer under construction targets.
 */
export async function suggestBandSet(
  co: { id?: string; country: string | null; industry?: string | null },
  headcount: number,
  currentSetId: string | null,
): Promise<{ id: string; name: string; why: string } | null> {
  if (!co.country) return null;
  const activity = String(co.industry ?? "").trim().toLowerCase();
  // Nothing to match on. A client with no activity recorded, placed by size alone, would be a coin
  // toss dressed as a recommendation.
  if (!activity || activity === "\u2014") return null;

  const sets = await prisma.workforceBandSet.findMany({ where: { country: co.country, retired: false } });
  // A client already on a ladder SET UP FOR THEM is where they are meant to be. Another client's
  // ladder can match the same activity and bracket, and suggesting a move to it would be the app
  // second-guessing a decision somebody made about this client specifically.
  if (co.id && currentSetId && sets.some(s => s.id === currentSetId && s.ownerCompanyId === co.id)) return null;
  const fits = sets.filter(s => {
    const act = String(s.activity ?? "").trim().toLowerCase();
    if (!act || act !== activity) return false;
    if (s.sizeMin != null && headcount < s.sizeMin) return false;
    if (s.sizeMax != null && headcount > s.sizeMax) return false;
    return true;
  });
  // Two schemes claiming the same activity and bracket is a configuration error, not a choice to
  // make on the client's behalf - say nothing rather than pick one.
  if (fits.length !== 1) return null;
  const s = fits[0];
  // Already on it. Suggesting the ladder a client is on reads as "something is wrong here" when
  // nothing is.
  if (s.id === currentSetId) return null;
  // "0-49 staff" is how a range is stored, not how a bracket is published. A scheme with no floor
  // covers everybody below its ceiling, and saying so is the difference between a suggestion that
  // reads like the regulator and one that reads like a database row.
  const size = s.sizeMin == null && s.sizeMax == null ? ""
    : s.sizeMax == null ? " and " + String(s.sizeMin) + "+ staff"
    : s.sizeMin == null ? " and under " + String(s.sizeMax + 1) + " staff"
    : " and " + String(s.sizeMin) + "-" + String(s.sizeMax) + " staff";
  return { id: s.id, name: s.name, why: `matches ${s.activity}${size}` };
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
    select: { id: true, name: true, country: true, industry: true, workforceBand: true, workforceBandAt: true, workforceBandNote: true, workforceBandRatioBp: true, workforceBandSetId: true },
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
  // The client's own scheme, not the country's - thresholds are published per activity and per size
  // bracket, so one country-wide ladder placed most clients against numbers they are not judged by.
  const scheme = await bandSetForCompany(company);
  const bands = scheme ? await bandsInSet(scheme.set.id) : [];
  // A client with nobody on the books has no ratio to place. 0 of 0 arithmetically reads as 0%, which
  // would drop them in the bottom band and show a compliance failure for a workforce that does not
  // exist — the same "answer to a question nobody asked" the headline figure already avoids.
  const placeable = total > 0;
  const placed = placeable
    ? (bands.find(b => ratioMinBp >= b.minBp && (b.maxBp == null || ratioMinBp < b.maxBp)) ?? null)
    : null;
  const above = placeable
    ? (bands.filter(b => b.minBp > ratioMinBp).sort((a, b) => a.minBp - b.minBp)[0] ?? null)
    : null;

  return {
    computedBand: placed ? { name: placed.name, color: placed.color ?? null, bg: placed.bg ?? null } : null,
    bandSet: scheme ? { id: scheme.set.id, name: scheme.set.name, assigned: scheme.assigned, isDefault: scheme.set.isDefault } : null,
    bandSetSuggestion: await suggestBandSet(company, total, scheme?.set.id ?? null),
    // Only a real disagreement counts: both known, and different.
    bandMismatch: !!(placed && company.workforceBand && placed.name !== company.workforceBand),
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

/**
 * Every client, for the list and the dashboard.
 *
 * CLIENTS — not leads. A company being pitched has no employees on this system, so it would arrive
 * here as 0 of 0, be reported at 0% nationalisation, and sit in the compliance list looking like a
 * client in trouble. Nothing about a prospect's real workforce is knowable from this database, and a
 * figure that looks knowable is worse than an absent one.
 */
export async function workforceAll(): Promise<Workforce[]> {
  const ids = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true }, orderBy: { name: "asc" } });
  const out: Workforce[] = [];
  for (const c of ids) {
    const w = await workforceFor(c.id);
    if (w) out.push(w);
  }
  return out;
}

/**
 * Record what every client's workforce looks like today.
 *
 * Idempotent through the unique (companyId, day): the tick runs hourly, and the FIRST run of a day
 * writes the row. Later runs UPDATE it, so a hire at 4pm is reflected in today's row rather than
 * being lost until tomorrow — the row means "as at the end of this day", and the day is not over.
 *
 * A client with nobody on the books is still recorded. "They had no staff on the 5th" is history,
 * and leaving a gap would make the trend interpolate across it as though nothing had changed.
 */
export interface SnapshotResult { day: string; written: number; skipped: number }

export async function captureWorkforceSnapshots(day = new Date().toISOString().slice(0, 10)): Promise<SnapshotResult> {
  const out: SnapshotResult = { day, written: 0, skipped: 0 };
  const rows = await workforceAll();
  for (const w of rows) {
    // No country means no thresholds and no meaningful comparison; recording a ratio against
    // nothing would put a line on a chart that cannot be read.
    if (!w.country) { out.skipped++; continue; }
    const data = {
      country: w.country,
      total: w.total, nationals: w.nationals, expats: w.expats, unknown: w.unknown, partTime: w.partTime,
      ratioMinBp: w.ratioMinBp, ratioMaxBp: w.ratioMaxBp, certain: w.certain,
      // The band as the thresholds read it TODAY, by name. See the model comment: recomputing this
      // later from changed thresholds would rewrite a day that has already happened.
      bandName: w.computedBand?.name ?? null,
    };
    await prisma.workforceSnapshot.upsert({
      where: { companyId_day: { companyId: w.companyId, day } },
      create: { companyId: w.companyId, day, ...data, createdAt: new Date().toISOString() },
      update: data,
    });
    out.written++;
  }
  return out;
}

/**
 * One client's series, oldest first, with the change between the ends.
 *
 * `enough` is the honest part: two points is the minimum that can show a direction, and a single
 * point drawn as a flat line reads as "stable" when what it means is "we have only just started
 * looking". The screen is told which it is rather than being left to guess from the array length.
 */
export async function workforceHistory(companyId: string, days = 90) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const points = await prisma.workforceSnapshot.findMany({
    where: { companyId, day: { gte: from } },
    orderBy: { day: "asc" },
  });
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const changeBp = first && last ? last.ratioMinBp - first.ratioMinBp : null;
  return {
    points,
    from, days,
    enough: points.length >= 2,
    changeBp,
    /** Only a real move counts as a direction; a ratio that has not shifted is not "up". */
    direction: changeBp === null || changeBp === 0 ? "flat" : changeBp > 0 ? "up" : "down",
    /** Whether the band changed over the window, which is the part somebody acts on. */
    bandFrom: first?.bandName ?? null,
    bandTo: last?.bandName ?? null,
    bandMoved: !!(first && last && first.bandName !== last.bandName),
  };
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
