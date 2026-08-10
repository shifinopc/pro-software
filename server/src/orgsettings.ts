/**
 * THE FIRM'S OWN SETTINGS — which market it operates in, and what it charges in.
 *
 * WHAT THIS REPLACES
 *
 * `HOME_COUNTRY` was a source-code constant, `export const HOME_COUNTRY = "SA"`, and its own comment
 * said what should happen next: "when a second market opens this becomes an org setting and only this
 * line changes". Beside it, six places fell back to a literal `"SAR"` when nothing said otherwise.
 *
 * Between them those two decided the country stamped on every record created without one, and the
 * currency printed beside every figure that arrived without one — from source code, where nobody
 * running the business could see or change them. A firm operating from Dubai would have had its
 * records quietly filed as Saudi and its invoices labelled in riyals, with no screen admitting it.
 *
 * WHY THERE IS STILL A CONSTANT AT THE BOTTOM
 *
 * A fresh install has no settings row, and every one of these paths has to return SOMETHING — a
 * create cannot pause and ask. So there is a documented seed default rather than a hidden one, and
 * Setup Check raises the fact that it has not been chosen. The difference that matters is not
 * whether a default exists; it is whether anybody can see it and change it.
 *
 * NOT CACHED. Each of these is one lookup on a unique key, and the paths that use them are creates
 * and request handlers rather than tight loops. A cache here would mean an admin changing the
 * setting, testing it, and being told the old answer — which is exactly the kind of thing that
 * teaches people a setting "doesn't work".
 */
import { prisma } from "./db.js";
import { countryCurrency, SEED_MARKET } from "./countries.js";

/**
 * Where the firm is until somebody says otherwise. The seed value for a fresh install, and the last
 * resort when the settings row cannot be read — NOT a statement that this product is Saudi-only.
 * Taken from countries.ts so the country and its currency cannot come from two different opinions.
 */
export const DEFAULT_HOME_COUNTRY = SEED_MARKET;

async function org(): Promise<Record<string, unknown>> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "org" } });
    return (row?.value && typeof row.value === "object" ? row.value : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The market this installation operates in, for records created without one stated. */
export async function homeCountry(): Promise<string> {
  const v = await org();
  const code = String(v.country ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : DEFAULT_HOME_COUNTRY;
}

/**
 * The currency for figures that arrive without one.
 *
 * Settings → General stores a label chosen for reading — "SAR — Saudi Riyal" — so the code is taken
 * from the front of it. When nothing is configured it is DERIVED from the home country rather than
 * defaulted separately: a firm that has said it operates in the UAE should not have to say "AED"
 * twice, and two independent defaults are two things that can disagree.
 */
export async function homeCurrency(): Promise<string> {
  const v = await org();
  const code = String(v.currency ?? "").trim().split(/[\s—-]/)[0].toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  return countryCurrency(await homeCountry());
}

/** Both at once, for the callers that need them together. One round trip instead of two. */
export async function homeMarket(): Promise<{ country: string; currency: string }> {
  const v = await org();
  const code = String(v.country ?? "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(code) ? code : DEFAULT_HOME_COUNTRY;
  const cur = String(v.currency ?? "").trim().split(/[\s—-]/)[0].toUpperCase();
  return { country, currency: /^[A-Z]{3}$/.test(cur) ? cur : countryCurrency(country) };
}

/** True when the firm has actually chosen, rather than living on the seed default. */
export async function homeMarketIsConfigured(): Promise<boolean> {
  const v = await org();
  return /^[A-Z]{2}$/.test(String(v.country ?? "").trim().toUpperCase());
}

/**
 * The organisation's timezone, as an IANA name Intl will actually accept.
 *
 * Settings → General stores a human label like "AST · Asia/Riyadh (UTC+3)" — chosen for reading, not
 * for computing with. The IANA name is pulled out of it and then VERIFIED by asking Intl to use it,
 * because a zone that only looks right would silently shift everything by hours.
 *
 * Lives here rather than in digest.ts, where it started: the daily digest was the first thing to
 * need it, but a booking page offering "10:00" has to mean the same 10:00, and two copies of this
 * function would be two answers to what time it is.
 */
export function zoneFrom(label: unknown): string {
  const m = /([A-Za-z]+(?:_[A-Za-z]+)*\/[A-Za-z]+(?:[_/][A-Za-z]+)*)/.exec(String(label ?? ""));
  if (!m) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: m[1] }).format(new Date());
    return m[1];
  } catch {
    return "UTC";
  }
}

/** The firm's own timezone. Everything shown to a client outside the console is stated in it. */
export async function orgTimezone(): Promise<string> {
  const v = await org();
  return zoneFrom((v as any)?.timezone);
}
