/**
 * Paste an email signature, get a lead.
 *
 * How a PRO lead actually arrives: somebody forwards an enquiry, and under it sits the block the
 * sender's phone appended — name, title, company, mobile, email, sometimes a website. Every one of
 * those is a field on the Add lead form, and until now they were retyped one at a time, which is
 * both slow and where the typos come from.
 *
 * NO MODEL, NO NETWORK. A signature is one of the most formulaic things a person ever writes, and
 * the fields worth having — email, phone, website — are the ones a regular expression gets right
 * every time. Reading it with a model would cost a key this installation does not have, send a
 * client's details to somebody else's server, and be less reliable at the only part that matters.
 * The guesses that genuinely need judgement (which line is the company, which is the job title)
 * are offered as suggestions a person accepts, never written on their own.
 *
 * IT SAYS HOW SURE IT IS, per field. "sure" is something matched by shape — an address with an @,
 * a number of the right length. "guess" is a line that looked like a name because of where it sat.
 * The two are not the same claim, and the form marks them differently so nobody accepts a guess by
 * reflex.
 *
 * IT NEVER RETURNS A FIELD IT DID NOT FIND. An empty string would overwrite something the person
 * had already typed; absent means absent.
 */

export type Confidence = "sure" | "guess";
export type SignatureField = { value: string; confidence: Confidence; why: string };
export type ParsedSignature = Partial<Record<
  "contactName" | "jobTitle" | "companyName" | "email" | "phone" | "website" | "city",
  SignatureField
>> & { lines: number };

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_RE = /\b((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|net|org|sa|ae|co|io|biz|info|me|app|dev|site|online|store|com\.sa|org\.sa|gov\.sa)(?:\/[^\s<>"']*)?)/i;

/** Words that mark a line as a job title rather than a name or a company. */
const TITLE_WORDS = /\b(manager|director|ceo|cto|cfo|coo|owner|founder|partner|head|chief|officer|executive|supervisor|coordinator|consultant|engineer|accountant|administrator|assistant|specialist|lead|president|proprietor|gm|md|hr|sales|marketing|operations|business development|bd|pro)\b/i;

/**
 * Legal forms. A line carrying one is the company, whatever else is on it.
 *
 * ARABIC IS A SEPARATE TEST ON PURPOSE. `\b` in JavaScript is defined against [A-Za-z0-9_], so it
 * never matches beside an Arabic letter — `\bشركة\b` is a pattern that cannot fire. Putting the
 * Arabic words in the same alternation looked right and silently matched nothing, which is exactly
 * how "مؤسسة الخليج للتجارة" came out as no company at all.
 */
const LEGAL_FORM = /\b(l\.?l\.?c|w\.?l\.?l|est(?:ablishment)?|co\.?|company|corp(?:oration)?|ltd|limited|trading|contracting|group|holding|enterprises|industries|factory|services|solutions|consultanc(?:y|ies)|foundation)\b/i;
const LEGAL_FORM_AR = /(مؤسسة|مؤسسه|شركة|شركه|مكتب|مجموعة|مصنع)/;
const isCompanyLine = (l: string) => LEGAL_FORM.test(l) || LEGAL_FORM_AR.test(l);

/** The cities a Saudi signature actually names. Matched whole-word, so "Jeddah Road" still counts. */
const CITIES = [
  "Riyadh", "Jeddah", "Dammam", "Khobar", "Al Khobar", "Mecca", "Makkah", "Medina", "Madinah",
  "Dhahran", "Jubail", "Yanbu", "Taif", "Tabuk", "Abha", "Khamis Mushait", "Najran", "Jazan",
  "Hail", "Buraidah", "Qassim", "Hofuf", "Al Ahsa", "Dubai", "Abu Dhabi", "Sharjah", "Doha",
  "Manama", "Kuwait", "Muscat",
];

/** The label people put before a number, which is not part of the number. */
const PHONE_LABEL = /^(mobile|mob|cell|tel|telephone|phone|ph|whatsapp|wa|direct|office|fax|م|جوال|هاتف)\s*[:.\-]?\s*/i;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * One shape for a number, so it is dialable and comparable.
 *
 * The same five shapes that arrived in a real 90-row import: a bare Saudi mobile, the local form
 * with a trunk 0, "966…" with no plus, "+966…", and the occasional foreign number. Anything this
 * cannot place is returned as typed rather than mangled into a wrong number.
 */
export function normalisePhone(raw: string, homeDial = "966"): string {
  const trimmed = raw.replace(PHONE_LABEL, "").trim();
  if (!trimmed) return "";
  const plus = trimmed.startsWith("+");
  const d = trimmed.replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith(homeDial) && d.length > homeDial.length) return `+${homeDial} ${d.slice(homeDial.length)}`;
  if (d.startsWith("0") && d.length === 10) return `+${homeDial} ${d.slice(1)}`;        // local trunk prefix
  if (d.length === 9 && d.startsWith("5")) return `+${homeDial} ${d}`;                   // bare Saudi mobile
  if (plus) return `+${d}`;                                                              // already international
  if (d.length >= 11) return `+${d}`;                                                    // long enough to carry its own country
  return trimmed;                                                                        // leave it alone rather than guess
}

/** Strip the decoration people put around a line: bullets, pipes, stray punctuation. */
const strip = (s: string) => clean(s)
  .replace(/^[\s|•·*\-–—>»]+/, "")
  .replace(/[\s|•·*\-–—<«]+$/, "")
  .replace(/^["'“”]+|["'“”]+$/g, "");

export function parseSignature(raw: string): ParsedSignature {
  const all = String(raw ?? "").split(/\r?\n/).map(strip).filter(Boolean);
  const out: ParsedSignature = { lines: all.length };
  if (!all.length) return out;

  const put = (k: keyof Omit<ParsedSignature, "lines">, value: string, confidence: Confidence, why: string) => {
    const v = clean(value);
    if (v && !out[k]) out[k] = { value: v, confidence, why };
  };

  // ── Matched by shape: these are facts, not readings ────────────────────────────────────────
  const joined = all.join("\n");
  const email = joined.match(EMAIL_RE)?.[0];
  if (email) put("email", email.toLowerCase(), "sure", "it is an email address");

  for (const line of all) {
    if (out.phone) break;
    // Skip a line that is only an address or a date; look for something number-shaped and long.
    const candidate = line.replace(PHONE_LABEL, "");
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (EMAIL_RE.test(line)) continue;
    const norm = normalisePhone(candidate);
    if (norm) put("phone", norm, "sure", PHONE_LABEL.test(line) ? "the line is labelled as a number" : "it is the right length for a phone number");
  }

  const url = joined.replace(EMAIL_RE, "").match(URL_RE)?.[1];
  // `https://` and a leading `www.` are decoration: the field holds the domain, and a duplicate
  // check comparing two websites must not read www.alnoor.com.sa and alnoor.com.sa as different.
  if (url && !/^www\.$/.test(url)) {
    put("website", url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, ""), "sure", "it is a web address");
  }

  const city = CITIES.find(c => new RegExp(`\\b${c.replace(/ /g, "\\s+")}\\b`, "i").test(joined));
  if (city) put("city", city, "sure", "the city is named in the block");

  // ── Read from position and wording: these are suggestions ──────────────────────────────────
  const nonContact = all.filter(l => !EMAIL_RE.test(l) && !URL_RE.test(l) && l.replace(/\D/g, "").length < 9);

  const companyLine = nonContact.find(isCompanyLine);
  if (companyLine) put("companyName", companyLine, "guess", "it names a legal form, so it reads as the company");

  const titleLine = nonContact.find(l => l !== companyLine && TITLE_WORDS.test(l));
  if (titleLine) put("jobTitle", titleLine, "guess", "it reads as a job title");

  // The name is whatever is left at the top — the one line everybody puts first.
  const nameLine = nonContact.find(l => l !== companyLine && l !== titleLine && l.split(" ").length <= 6);
  if (nameLine) put("contactName", nameLine, "guess", "it is the first line that is not a title, a company or contact details");

  // A website with no company line is still a company name: the domain is what they call themselves.
  if (!out.companyName && out.website) {
    const host = out.website.value.replace(/^www\./i, "").split("/")[0].split(".")[0];
    if (host.length >= 3) {
      const titled = host.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      put("companyName", titled, "guess", "taken from the web address, since no line names a company");
    }
  }

  return out;
}
