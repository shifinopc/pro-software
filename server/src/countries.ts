/**
 * Countries, in one place.
 *
 * Nationality was a free-text box with the placeholder "e.g. Saudi". Two values were on file and both
 * happened to be clean, but "Saudi", "Saudi Arabian", "KSA" and "saudi" are all one keystroke away —
 * and a workforce-quota calculation that misses a spelling reports a lower percentage than the truth,
 * which is the dangerous direction to be wrong in.
 *
 * So a country is stored as its ISO 3166-1 alpha-2 code. The list lives here and is SERVED to the
 * console rather than copied into it: a picker built from a second list is how the two drift.
 *
 * `resolveCountry` is the other half. Both the stored value and anything a human typed go through it,
 * so a prerequisite rule written as "Saudi" still matches an employee stored as "SA". Without that,
 * moving to codes would have silently broken every nationality rule anyone writes.
 */

export type Country = { code: string; name: string; nationality: string; currency: string };

/**
 * Not the full ISO list. These are the countries this product actually deals with: the GCC it operates
 * in, the labour-sending countries its clients hire from, and the places clients are headquartered.
 * Add rows as needed — nothing computes off the length of this list.
 */
export const COUNTRIES: Country[] = [
  // ── GCC — where the product operates ──
  { code: "SA", name: "Saudi Arabia", nationality: "Saudi", currency: "SAR" },
  { code: "AE", name: "United Arab Emirates", nationality: "Emirati", currency: "AED" },
  { code: "QA", name: "Qatar", nationality: "Qatari", currency: "QAR" },
  { code: "KW", name: "Kuwait", nationality: "Kuwaiti", currency: "KWD" },
  { code: "BH", name: "Bahrain", nationality: "Bahraini", currency: "BHD" },
  { code: "OM", name: "Oman", nationality: "Omani", currency: "OMR" },

  // ── South Asia ──
  { code: "IN", name: "India", nationality: "Indian", currency: "INR" },
  { code: "PK", name: "Pakistan", nationality: "Pakistani", currency: "PKR" },
  { code: "BD", name: "Bangladesh", nationality: "Bangladeshi", currency: "BDT" },
  { code: "LK", name: "Sri Lanka", nationality: "Sri Lankan", currency: "LKR" },
  { code: "NP", name: "Nepal", nationality: "Nepali", currency: "NPR" },
  { code: "AF", name: "Afghanistan", nationality: "Afghan", currency: "AFN" },

  // ── South-East and East Asia ──
  { code: "PH", name: "Philippines", nationality: "Filipino", currency: "PHP" },
  { code: "ID", name: "Indonesia", nationality: "Indonesian", currency: "IDR" },
  { code: "MY", name: "Malaysia", nationality: "Malaysian", currency: "MYR" },
  { code: "TH", name: "Thailand", nationality: "Thai", currency: "THB" },
  { code: "VN", name: "Vietnam", nationality: "Vietnamese", currency: "VND" },
  { code: "CN", name: "China", nationality: "Chinese", currency: "CNY" },
  { code: "MM", name: "Myanmar", nationality: "Burmese", currency: "MMK" },

  // ── Middle East and Levant ──
  { code: "YE", name: "Yemen", nationality: "Yemeni", currency: "YER" },
  { code: "JO", name: "Jordan", nationality: "Jordanian", currency: "JOD" },
  { code: "SY", name: "Syria", nationality: "Syrian", currency: "SYP" },
  { code: "LB", name: "Lebanon", nationality: "Lebanese", currency: "LBP" },
  { code: "IQ", name: "Iraq", nationality: "Iraqi", currency: "IQD" },
  { code: "PS", name: "Palestine", nationality: "Palestinian", currency: "ILS" },
  { code: "TR", name: "Türkiye", nationality: "Turkish", currency: "TRY" },
  { code: "IR", name: "Iran", nationality: "Iranian", currency: "IRR" },

  // ── North and East Africa ──
  { code: "EG", name: "Egypt", nationality: "Egyptian", currency: "EGP" },
  { code: "SD", name: "Sudan", nationality: "Sudanese", currency: "SDG" },
  { code: "MA", name: "Morocco", nationality: "Moroccan", currency: "MAD" },
  { code: "TN", name: "Tunisia", nationality: "Tunisian", currency: "TND" },
  { code: "DZ", name: "Algeria", nationality: "Algerian", currency: "DZD" },
  { code: "LY", name: "Libya", nationality: "Libyan", currency: "LYD" },
  { code: "ET", name: "Ethiopia", nationality: "Ethiopian", currency: "ETB" },
  { code: "ER", name: "Eritrea", nationality: "Eritrean", currency: "ERN" },
  { code: "SO", name: "Somalia", nationality: "Somali", currency: "SOS" },
  { code: "KE", name: "Kenya", nationality: "Kenyan", currency: "KES" },
  { code: "UG", name: "Uganda", nationality: "Ugandan", currency: "UGX" },
  { code: "TZ", name: "Tanzania", nationality: "Tanzanian", currency: "TZS" },
  { code: "NG", name: "Nigeria", nationality: "Nigerian", currency: "NGN" },
  { code: "GH", name: "Ghana", nationality: "Ghanaian", currency: "GHS" },
  { code: "ZA", name: "South Africa", nationality: "South African", currency: "ZAR" },

  // ── Europe and the Americas ──
  { code: "GB", name: "United Kingdom", nationality: "British", currency: "GBP" },
  { code: "IE", name: "Ireland", nationality: "Irish", currency: "EUR" },
  { code: "FR", name: "France", nationality: "French", currency: "EUR" },
  { code: "DE", name: "Germany", nationality: "German", currency: "EUR" },
  { code: "IT", name: "Italy", nationality: "Italian", currency: "EUR" },
  { code: "ES", name: "Spain", nationality: "Spanish", currency: "EUR" },
  { code: "PT", name: "Portugal", nationality: "Portuguese", currency: "EUR" },
  { code: "NL", name: "Netherlands", nationality: "Dutch", currency: "EUR" },
  { code: "PL", name: "Poland", nationality: "Polish", currency: "PLN" },
  { code: "RO", name: "Romania", nationality: "Romanian", currency: "RON" },
  { code: "UA", name: "Ukraine", nationality: "Ukrainian", currency: "UAH" },
  { code: "RU", name: "Russia", nationality: "Russian", currency: "RUB" },
  { code: "US", name: "United States", nationality: "American", currency: "USD" },
  { code: "CA", name: "Canada", nationality: "Canadian", currency: "CAD" },
  { code: "BR", name: "Brazil", nationality: "Brazilian", currency: "BRL" },
  { code: "AU", name: "Australia", nationality: "Australian", currency: "AUD" },
  { code: "NZ", name: "New Zealand", nationality: "New Zealander", currency: "NZD" },
];

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");

/**
 * Every spelling that should land on a given code. Only the ones a person genuinely types — this is
 * not a place to be clever. An entry here is a promise that the alias means exactly that country.
 */
const ALIASES: Record<string, string> = {
  ksa: "SA", saudiarabian: "SA", kingdomofsaudiarabia: "SA",
  uae: "AE", emirates: "AE", unitedarabemirates: "AE", emirian: "AE",
  uk: "GB", britain: "GB", greatbritain: "GB", england: "GB", scotland: "GB", wales: "GB", englishman: "GB",
  usa: "US", america: "US", unitedstatesofamerica: "US",
  filipina: "PH", pinoy: "PH",
  srilankan: "LK", ceylonese: "LK",
  burma: "MM", burmese: "MM",
  turkey: "TR", turkiye: "TR",
  persian: "IR",
  holland: "NL", dutchman: "NL",
  bangla: "BD",
};

// Built once: code → country, and every recognised spelling → code.
const BY_CODE = new Map(COUNTRIES.map(c => [c.code, c]));
const LOOKUP = new Map<string, string>();
for (const c of COUNTRIES) {
  LOOKUP.set(norm(c.code), c.code);
  LOOKUP.set(norm(c.name), c.code);
  LOOKUP.set(norm(c.nationality), c.code);
}
for (const [alias, code] of Object.entries(ALIASES)) LOOKUP.set(norm(alias), code);

/**
 * Turn whatever a human wrote into a country code, or null when it is not recognised.
 *
 * Null is a real answer and must not be treated as "no country". An unmatched value is data somebody
 * entered on purpose; the migration keeps it and flags the row rather than blanking it, because a
 * rule that quietly discards is worse than one that stops and asks.
 */
export function resolveCountry(input: unknown): string | null {
  const k = norm(input);
  return k ? LOOKUP.get(k) ?? null : null;
}

/** Display name for a stored code; falls back to the raw value so an unmigrated row still reads. */
export function countryName(code: unknown): string {
  const c = BY_CODE.get(String(code ?? "").trim().toUpperCase());
  return c ? c.name : String(code ?? "");
}

/**
 * The flag, worked out from the code rather than typed.
 *
 * The Add-country form had a box for pasting a flag emoji next to a free-text country name, which is
 * two chances to disagree — nothing stopped 🇦🇪 sitting beside "Kuwait". A regional-indicator pair is
 * a pure function of the two letters, so the flag cannot be wrong unless the code is.
 */
export function countryFlag(code: unknown): string {
  const c = String(code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "🏳️";
  return String.fromCodePoint(...[...c].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** The demonym, which is what a person means by "nationality" on a form. */
export function countryNationality(code: unknown): string {
  const c = BY_CODE.get(String(code ?? "").trim().toUpperCase());
  return c ? c.nationality : String(code ?? "");
}

/**
 * Do two nationality values mean the same country?
 *
 * This is what keeps a prerequisite rule working across the move to codes: the rule may say "Saudi"
 * and the employee may be stored as "SA". Both go through the resolver. When neither side resolves,
 * it falls back to a plain case-insensitive comparison so an unrecognised value still behaves the way
 * it did before rather than silently never matching.
 */
export function sameCountry(a: unknown, b: unknown): boolean {
  const ra = resolveCountry(a);
  const rb = resolveCountry(b);
  if (ra && rb) return ra === rb;
  return norm(a) !== "" && norm(a) === norm(b);
}
