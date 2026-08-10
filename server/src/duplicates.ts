/**
 * "Have we already got this company?"
 *
 * WHY IT WARNS AND NEVER BLOCKS
 *
 * "Al Noor Trading Est" and "Al Noor Contracting Est" are two real companies with the same owner and
 * a shared word. Any matcher good enough to catch a genuine re-entry will sometimes flag a pair like
 * that, so refusing the save would eventually stop somebody recording a real client — and the first
 * time it does, they work around it by typing a wrong name. Warning costs a glance; blocking costs
 * the data.
 *
 * WHY EVERY MATCH CARRIES ITS REASON
 *
 * A similarity score is unpredictable: a person cannot tell why 0.82 appeared, so they stop reading
 * the warning. Each rule here is one sentence long and says which field matched, which makes the
 * warning either obviously right or obviously wrong at a glance.
 *
 * WHY THIS RUNS ON THE SERVER
 *
 * A `sales` user's console holds only the clients they own. Matching in the browser would therefore
 * miss precisely the duplicate that matters most — a colleague's client, typed in again because the
 * person entering it had no way to see it.
 */
import { prisma } from "./db.js";

/** Legal forms, not industries. Stripping "Trading" would merge "Al Noor Trading" with "Al Noor". */
const LEGAL_FORMS = [
  "llc", "l l c", "wll", "w l l", "est", "establishment", "co", "company", "ltd", "limited",
  "inc", "incorporated", "corp", "corporation", "plc", "jsc", "sarl", "sa", "spc", "mlc",
  "for trading", "and partners", "sons",
];

/**
 * Arabic normalisation, because the same company is written several ways in practice:
 * أ إ آ ٱ → ا, ى → ي, ة → ه, and the short-vowel marks are dropped entirely.
 */
const arabic = (s: string) => s
  .replace(/[أإآٱ]/g, "ا")
  .replace(/ى/g, "ي")
  .replace(/ة/g, "ه")
  .replace(/[ً-ْـ]/g, "");

/** A company name reduced to the part that identifies it. */
export function normName(raw: unknown): string {
  let s = arabic(String(raw ?? "").toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // Suffixes come off the END only. "Est Al Noor" is a different name from "Al Noor Est".
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of LEGAL_FORMS) {
      if (s.endsWith(" " + f)) { s = s.slice(0, -(f.length + 1)).trim(); changed = true; }
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Digits only. A CR is quoted with and without separators, and both mean the same registration. */
export const normCr = (raw: unknown) => String(raw ?? "").replace(/\D+/g, "");

/**
 * The last nine digits. Country codes and trunk zeros are written half a dozen ways
 * (+966 50…, 0096650…, 050…) and all of them reach the same handset.
 */
export const normPhone = (raw: unknown) => {
  const d = String(raw ?? "").replace(/\D+/g, "");
  return d.length >= 9 ? d.slice(-9) : d;
};

export const normEmail = (raw: unknown) => String(raw ?? "").trim().toLowerCase();

export type Confidence = "certain" | "likely" | "possible";

export interface DuplicateMatch {
  id: string;
  name: string;
  lifecycle: string;
  cr: string | null;
  ownerName: string | null;
  confidence: Confidence;
  /** One sentence saying which field matched — the whole reason the warning is trustworthy. */
  why: string;
}

const RANK: Record<Confidence, number> = { certain: 0, likely: 1, possible: 2 };

/**
 * Companies that look like the one described.
 *
 * `excludeId` is the record being edited — a company always matches itself, and reporting that would
 * make the warning appear every time somebody corrected a typo on an existing client.
 */
export async function findDuplicates(input: {
  name?: string | null; cr?: string | null; email?: string | null; phone?: string | null;
  excludeId?: string | null;
}): Promise<DuplicateMatch[]> {
  const name = normName(input.name);
  const cr = normCr(input.cr);
  const email = normEmail(input.email);
  const phone = normPhone(input.phone);
  if (!name && !cr && !email && !phone) return [];

  const all = await prisma.company.findMany({
    select: { id: true, name: true, cr: true, email: true, phone: true, lifecycle: true, ownerId: true },
    take: 5000,
  });
  const owners = await prisma.user.findMany({ select: { id: true, name: true } });
  const ownerName = new Map(owners.map(u => [u.id, u.name]));

  const out: DuplicateMatch[] = [];
  for (const c of all) {
    if (input.excludeId && c.id === input.excludeId) continue;
    const cName = normName(c.name);
    let hit: { confidence: Confidence; why: string } | null = null;

    // A commercial registration is issued once. Two records carrying it are the same company.
    if (cr && normCr(c.cr) === cr) hit = { confidence: "certain", why: `Same CR number (${c.cr})` };
    else if (email && normEmail(c.email) === email && email.includes("@")) hit = { confidence: "certain", why: `Same email address (${c.email})` };
    else if (phone && normPhone(c.phone) === phone && phone.length >= 9) hit = { confidence: "likely", why: `Same phone number (${c.phone})` };
    else if (name && cName === name) hit = { confidence: "likely", why: "Same name once spelling and legal form are ignored" };
    // One name inside the other — "Al Noor" against "Al Noor Trading". Only where the shorter is
    // long enough to mean something; a two-letter overlap is a coincidence, not a match.
    else if (name && cName && name.length >= 5 && cName.length >= 5 && (cName.startsWith(name + " ") || name.startsWith(cName + " "))) {
      hit = { confidence: "possible", why: `"${c.name}" starts with the same words` };
    }
    if (!hit) continue;

    out.push({
      id: c.id, name: c.name, lifecycle: c.lifecycle, cr: c.cr,
      ownerName: c.ownerId ? (ownerName.get(c.ownerId) ?? null) : null,
      ...hit,
    });
  }
  return out.sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || a.name.localeCompare(b.name)).slice(0, 8);
}

/**
 * Pairs that are ALREADY in the data — the part that gets harder the longer nobody looks.
 *
 * Only `certain` and `likely` are reported. "Possible" is the right level for a warning while
 * somebody is typing, and the wrong level for a list that claims these are duplicates.
 */
export async function existingDuplicatePairs(): Promise<Array<{ a: string; b: string; why: string; confidence: Confidence }>> {
  const all = await prisma.company.findMany({ select: { id: true, name: true, cr: true, email: true, phone: true } });
  const seen = new Set<string>();
  const pairs: Array<{ a: string; b: string; why: string; confidence: Confidence }> = [];

  for (const c of all) {
    const found = await findDuplicates({ name: c.name, cr: c.cr, email: c.email, phone: c.phone, excludeId: c.id });
    for (const m of found) {
      if (m.confidence === "possible") continue;
      // One entry per pair, whichever way round it was found.
      const key = [c.id, m.id].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: c.name, b: m.name, why: m.why, confidence: m.confidence });
    }
  }
  return pairs;
}
