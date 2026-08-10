// Server-side validation for write operations. Mirrors the frontend checks so the
// rules can't be bypassed by hitting the API directly. Returns an error string or null.
const isEmail = (s: any) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const toNum = (v: any) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "")));
const blank = (v: any) => v === undefined || v === null || String(v).trim() === "";

/**
 * The states one company record moves through.
 *
 * `lost` never bought; `churned` bought and left. Kept apart because they are different failures —
 * one is a sales problem and the other is a service problem, and a single "inactive" bucket hides
 * which of the two is happening.
 */
export const LIFECYCLES = ["lead", "prospect", "client", "lost", "churned"];
/**
 * The one state that means "this company pays us today".
 *
 * Everything that bills, reports compliance, counts clients or grants a portal login filters on
 * exactly this. `churned` deliberately does NOT qualify: their invoices and documents stay readable
 * — those are fetched by companyId and never by lifecycle — but nobody should be invoicing them.
 */
export const ACTIVE_CLIENT = "client";
/** Companies that are not clients and must stay out of every client-facing surface. */
export const NON_CLIENT = ["lead", "prospect", "lost"];

// isCreate=true → required fields enforced. isCreate=false (PUT) → only validate fields that are present.
export function validate(model: string, data: any, isCreate: boolean): string | null {
  if (!data || typeof data !== "object") return "Request body is required";
  const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined && data[k] !== null;

  switch (model) {
    case "company":
      if (isCreate && blank(data.name)) return "Company name is required";
      // "—" is the UI's empty placeholder; only reject a real, malformed email
      if (has("email") && !blank(data.email) && data.email !== "—" && !isEmail(data.email)) return "Invalid email address";
      // A CR is required of a CLIENT and meaningless for a lead — a company being pitched has not
      // handed one over. Enforced against the lifecycle rather than always, which is what stops
      // people typing "0000" to get past the form.
      if (has("lifecycle") && !LIFECYCLES.includes(String(data.lifecycle))) return `Lifecycle must be one of: ${LIFECYCLES.join(", ")}`;
      if (isCreate && (data.lifecycle ?? "client") === "client" && blank(data.cr)) return "CR number is required for a client";
      return null;

    case "contact":
      if (isCreate && blank(data.name)) return "Contact name is required";
      if (isCreate && blank(data.companyId)) return "companyId is required";
      if (has("email") && !blank(data.email) && data.email !== "—" && !isEmail(data.email)) return "Invalid email address";
      return null;

    case "invoice":
      if (isCreate && blank(data.number)) return "Invoice number is required";
      if (has("amount") && (!Number.isFinite(toNum(data.amount)) || toNum(data.amount) <= 0)) return "Amount must be a number greater than 0";
      return null;

    case "package":
      if (isCreate && blank(data.name)) return "Package name is required";
      if (has("basePrice") && (!Number.isFinite(toNum(data.basePrice)) || toNum(data.basePrice) <= 0)) return "Price must be a number greater than 0";
      if (has("empMin") && (!Number.isFinite(toNum(data.empMin)) || toNum(data.empMin) < 1)) return "Min employees must be at least 1";
      if (has("empMax") && (!Number.isFinite(toNum(data.empMax)) || toNum(data.empMax) < 1)) return "Max employees must be at least 1";
      if (has("empMin") && has("empMax") && toNum(data.empMin) > toNum(data.empMax)) return "Min employees can't exceed max";
      return null;

    case "user":
      if (isCreate && blank(data.name)) return "Name is required";
      if (has("email") && !isEmail(data.email)) return "Invalid email address";
      return null;

    case "subscription":
      if (has("price") && (!Number.isFinite(toNum(data.price)) || toNum(data.price) < 0)) return "Price must be 0 or more";
      return null;

    case "employee":
      if (isCreate && blank(data.name)) return "Employee name is required";
      return null;

    case "document":
      if (isCreate && blank(data.person)) return "Person is required";
      if (isCreate && blank(data.companyId)) return "companyId is required";
      return null;

    case "task":
      if (isCreate && blank(data.title)) return "Task title is required";
      return null;

    case "clientGroup":
      if (isCreate && blank(data.name)) return "Group name is required";
      return null;

    default:
      return null;
  }
}

/**
 * Is this a usable email address / phone number, if one was given at all?
 *
 * BLANK IS ALWAYS FINE. A lead taken off a phone call may have neither yet, and refusing to save it
 * would mean the lead lives on a sticky note instead. But "test" in an email field is not a lead
 * with no email — it is a lead nobody can reach, and it fails silently much later: the invitation
 * bounces, every notification aimed at them disappears, and the delivery log fills with a failure
 * nobody connects back to a form somebody filled in weeks ago.
 *
 * Deliberately loose. These reject nonsense, not unusual-but-real addresses — a validator strict
 * enough to argue with a real customer's email is worse than the problem it solves.
 */
export const looksLikeEmail = (v: unknown) => {
  const s = String(v ?? "").trim();
  return !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
};

export const looksLikePhone = (v: unknown) => {
  const s = String(v ?? "").trim();
  return !s || /^\+?[\d\s().-]{7,20}$/.test(s);
};

/** The complaint to send back, or null when the pair is acceptable. Same words the console uses. */
export function contactProblem(c: { name?: unknown; email?: unknown; phone?: unknown } | null | undefined): string | null {
  if (!c) return null;
  const email = String(c.email ?? "").trim();
  const phone = String(c.phone ?? "").trim();
  if (!looksLikeEmail(email)) return `"${email}" is not an email address. Leave it blank if you do not have one yet.`;
  if (!looksLikePhone(phone)) return `"${phone}" is not a phone number. Leave it blank if you do not have one yet.`;
  // Contact details with nobody attached to them are a record nobody can act on.
  if ((email || phone) && !String(c.name ?? "").trim()) return "Whose email or phone is this? Add the contact person, or clear those two fields.";
  return null;
}

/**
 * Money on a billing document, checked on the SERVER.
 *
 * The console already refuses a negative price or a quantity below one. That guard is real, but it
 * is the only one there was: POST /api/invoices with `units: -5, price: -100` returned 201 and
 * stored a document totalling 575.00, because negative × negative is positive and nothing between
 * the browser and the database looked. Anything that is not the console — a script, a stale tab, a
 * future integration, or somebody with a token and curl — bypassed the rule entirely.
 *
 * An invoice is not a credit note. A refund has to be its own document with its own number and its
 * own approval, or the ledger stops being able to explain itself: a negative line silently reduces
 * a total that has already been quoted, approved and sent, and the printed copy looks ordinary.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: reject a request that carries no items at all. A PUT that
 * only moves a due date must not have to resend the lines, and demanding it would push callers into
 * round-tripping figures they never meant to touch — which is its own way to corrupt a total.
 */
export function billingAmountProblem(body: any): string | null {
  const num = (v: unknown) => {
    // Absent is not zero, and a boolean is not a quantity. Same trap as the settings clamps:
    // Number(null), Number("") and Number(false) are all 0, which would pass a >= 0 test.
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };

  if (Array.isArray(body?.items)) {
    for (const [i, raw] of body.items.entries()) {
      const where = String(raw?.name ?? "").trim() || `line ${i + 1}`;
      const units = num(raw?.units);
      const price = num(raw?.price);
      if (units !== null && Number.isNaN(units)) return `"${where}" has a quantity that is not a number.`;
      if (price !== null && Number.isNaN(price)) return `"${where}" has a price that is not a number.`;
      // `units` absent means one, which is how the console's own writer treats it.
      if (units !== null && units < 1) return `"${where}" has a quantity below one. An invoice is never a credit note — raise a credit note for a refund.`;
      if (price !== null && price < 0) return `"${where}" has a negative price. An invoice is never a credit note — raise a credit note for a refund.`;
      if (units !== null && units > 9999) return `"${where}" has a quantity of ${units}, which is beyond anything this business bills. Please check it.`;
      if (price !== null && price > 10_000_000) return `"${where}" has a price beyond anything this business bills. Please check it.`;
    }
  }

  // The stored totals travel separately from the lines, so they need checking in their own right —
  // a caller can send sane lines and a negative total, and the total is what every report reads.
  for (const key of ["subtotalMinor", "vatMinor", "totalMinor", "amount", "valueMinor"]) {
    const v = num(body?.[key]);
    if (v === null) continue;
    if (Number.isNaN(v)) return `${key} is not a number.`;
    if (v < 0) return `${key} cannot be negative. An invoice is never a credit note — raise a credit note for a refund.`;
  }
  return null;
}
