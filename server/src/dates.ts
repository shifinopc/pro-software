/**
 * ONE FORMAT IN THE DATABASE.
 *
 * Every date on these models is a `String?` column, and nothing ever checked what went into it. The
 * result was a table where `Invoice.date` held both `2026-07-28` and `15 Jul 2026`, `Payment.date`
 * held both, and `ServiceRequest.date` held the literal word `Just now` — a display string written
 * by the server itself.
 *
 * That is not only untidy. These columns are compared, sorted and bucketed as strings: `"15 Jul
 * 2026" < "2026-07-28"` is true, because `1` sorts before `2`. So an ageing report, an overdue
 * check, or an ordered list silently puts a July invoice before a January one and nobody sees an
 * error — they see a number that is merely wrong. It is very likely part of why the dashboard
 * counters disagree with each other.
 *
 * Fixing the column types is a migration for another day. Fixing what is allowed IN is this file:
 * writes are normalised to `YYYY-MM-DD` where the intent is unambiguous, and refused where it is
 * not, so the problem stops growing while the existing rows are cleaned up separately.
 */

/** `YYYY-MM-DD`, optionally with a time part we keep for the timestamp-ish columns. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

// ── WHAT DAY IT IS WHERE THE FIRM IS ─────────────────────────────────────────────────────────────
//
// Every business date in the product came from `new Date().toISOString().slice(0, 10)`, which is the
// date in UTC. The container sets no TZ, so it runs in UTC, and Riyadh is UTC+3 — meaning between
// midnight and 03:00 local the server's idea of "today" was still YESTERDAY. A payment recorded at
// 01:30 on the 1st was dated the last day of the previous month, and therefore the previous VAT
// return. The same three hours shifted invoice dates and every "is this due today" comparison.
//
// The firm's zone was already a setting (`orgTimezone()` in orgsettings.ts) and simply was not used
// here. It is held in a module variable rather than read per call because most callers are
// synchronous — `setBusinessZone` is called once at boot and again whenever the setting is saved, so
// a change takes effect without a restart.
let _zone = "UTC";
let _fmt: Intl.DateTimeFormat | null = null;

/** Point the date helpers at the firm's zone. Called from boot and from PUT /api/settings/org. */
export function setBusinessZone(zone: string): void {
  const next = zone || "UTC";
  if (next === _zone && _fmt) return;
  try {
    _fmt = new Intl.DateTimeFormat("en-GB", { timeZone: next, year: "numeric", month: "2-digit", day: "2-digit" });
    _zone = next;
  } catch {
    // An unusable zone must not break every date in the product. orgTimezone() already verifies the
    // name, so reaching this means something stranger — keep whatever was working.
  }
}

/** The zone the helpers below are using, for anything that needs to state it. */
export const businessZone = (): string => _zone;

/**
 * Today's date in the firm's zone, as `YYYY-MM-DD`.
 *
 * Built from parts rather than from a locale's own ordering, so the output cannot change because of
 * how a locale happens to format. Takes an instant so callers that already hold one can pass it.
 */
export function businessToday(at: Date | number = Date.now()): string {
  if (!_fmt) setBusinessZone(_zone);
  const parts = _fmt!.formatToParts(at instanceof Date ? at : new Date(at));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Midnight at the start of a `YYYY-MM-DD`, as a timestamp. The one way to turn a day into a number. */
export const dayStart = (iso: string): number => Date.parse(iso.slice(0, 10) + "T00:00:00Z");

/** `iso` moved by whole days, still `YYYY-MM-DD`. Day arithmetic stays in UTC so it cannot drift. */
export const addDays = (iso: string, n: number): string =>
  new Date(dayStart(iso) + n * 86_400_000).toISOString().slice(0, 10);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Placeholders the UI uses for "nothing here" that have been written to the database as if they were
 * values — an employee's iqama expiry came back from the API as "—". A column meaning "no date" should
 * say so in the way every query already understands.
 *
 * "Just now" is NOT here, though the server was writing it into ServiceRequest.date. It is a caption
 * for a time that did happen, so treating it as absent would throw away the fact that the request
 * has a date at all. It is refused instead, and the three existing rows were backfilled from the
 * timestamp beside them.
 */
const EMPTY_SENTINELS = new Set(["", "-", "--", "—", "–", "n/a", "na", "none", "null", "undefined", "tbd", "tba", "not set"]);

/**
 * How far from today a date is allowed to be.
 *
 * A due date of 01-01-1900 was accepted and rendered as "46288d overdue", which is not a date anyone
 * meant — it is a typo or a broken import. Measured from today rather than fixed at a year, so the
 * window does not quietly widen as the years pass: a hundred back covers the oldest birth date a
 * workforce system will ever hold, seventy-five forward covers any lease or licence, and 1900 sits
 * outside both.
 */
const MAX_YEARS_PAST = 100;
const MAX_YEARS_FUTURE = 75;

export class DateValueError extends Error {}

/**
 * Normalise one value to `YYYY-MM-DD`.
 *
 * - `undefined` is left alone: a PUT that does not mention a field must not clear it.
 * - `null` and the empty placeholders above all become `null` — an absent date, said once.
 * - Anything unrecognisable throws, rather than being stored to be misread later.
 */
export function toIsoDate(value: unknown, fieldLabel: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new DateValueError(`${fieldLabel} is not a valid date`);
    return bounded(value.toISOString().slice(0, 10), fieldLabel);
  }

  const raw = String(value).trim();
  if (EMPTY_SENTINELS.has(raw.toLowerCase())) return null;

  // Already ours. Keep only the date part: these columns are compared as strings, and a stray time
  // on some rows and not others reintroduces exactly the ordering bug this file exists to stop.
  const iso = ISO_DATE.exec(raw);
  if (iso) return bounded(`${iso[1]}-${iso[2]}-${iso[3]}`, fieldLabel);

  // "15 Jul 2026", "15 July 2026", "Jul 15 2026", "15-Jul-2026" — what the UI was writing back.
  const words = /^(\d{1,2})[\s\-/]+([A-Za-z]{3,})[\s\-/,]+(\d{4})$/.exec(raw)
    ?? flip(/^([A-Za-z]{3,})[\s\-/]+(\d{1,2})[\s\-/,]+(\d{4})$/.exec(raw));
  if (words) {
    const m = MONTHS[words[2].slice(0, 3).toLowerCase()];
    if (m) return bounded(`${words[3]}-${pad(m)}-${pad(Number(words[1]))}`, fieldLabel);
  }

  // Deliberately NOT falling back to `new Date(raw)`. It accepts almost anything and guesses at the
  // rest — "01/02/2026" is the 1st of February to half the world and the 2nd of January to the other
  // half, and on a visa expiry that guess is a month of someone's legal residency. Refuse instead.
  throw new DateValueError(`${fieldLabel} must be a date like 2026-07-28 — got "${raw}"`);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Reorders a "Month Day Year" match into the "Day Month Year" shape the caller reads. */
const flip = (m: RegExpExecArray | null) => (m ? ([m[0], m[2], m[1], m[3]] as unknown as RegExpExecArray) : null);

function bounded(isoDate: string, fieldLabel: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  // Round-tripping catches the dates that do not exist: `new Date("2026-02-31")` rolls forward to
  // 3 March rather than failing, and would otherwise be stored as a silent correction of a typo.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) {
    throw new DateValueError(`${fieldLabel} is not a real date — got "${isoDate}"`);
  }
  const thisYear = new Date().getUTCFullYear();
  const year = Number(isoDate.slice(0, 4));
  if (year < thisYear - MAX_YEARS_PAST || year > thisYear + MAX_YEARS_FUTURE) {
    throw new DateValueError(
      `${fieldLabel} must be between ${thisYear - MAX_YEARS_PAST} and ${thisYear + MAX_YEARS_FUTURE} — got "${isoDate}"`);
  }
  return isoDate;
}

/**
 * The date-bearing fields of each model written through the generic CRUD routes.
 *
 * Listed explicitly rather than matched on a `*date*` name. Guessing would catch `createdAt` and
 * `lastClientMsgAt`, which are full timestamps written by the server and would lose their time of
 * day the moment they passed through here.
 *
 * Taken from the schema, not from memory: the first draft of this list invented four fields that do
 * not exist and missed `Invoice.promisedDate` and `Employee.exitDate` that do. scripts/check-date-
 * fields.ts re-derives it and fails if the two ever drift apart.
 */
export const DATE_FIELDS: Record<string, string[]> = {
  invoice: ["date", "dueDate", "promisedDate"],
  quotation: ["date", "validUntil"],
  payment: ["date"],
  task: ["dueDate"],
  document: ["expiryDate", "issueDate"],
  employee: ["dob", "iqamaExpiry", "exitDate"],
  serviceRequest: ["date"],
  upgradeRequest: ["date"],
  appointment: ["date"],
  subscription: ["startDate", "endDate"],
  opportunity: ["expectedCloseDate"],
  bankLine: ["date"],
};

/**
 * Normalise every date field of `data` in place. Returns an error message for the caller to send
 * back, or null. Only touches fields the body actually carries, so a PUT of one field cannot blank
 * another.
 */
export function normalizeDates(model: string, data: any): string | null {
  const fields = DATE_FIELDS[model];
  if (!fields || !data || typeof data !== "object") return null;
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, f)) continue;
    try {
      const out = toIsoDate(data[f], label(f));
      if (out !== undefined) data[f] = out;
    } catch (e: any) {
      if (e instanceof DateValueError) return e.message;
      throw e;
    }
  }
  return null;
}

/** `dueDate` → "Due date", so the message names the field the way the screen does. */
function label(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
