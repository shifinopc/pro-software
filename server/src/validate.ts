// Server-side validation for write operations. Mirrors the frontend checks so the
// rules can't be bypassed by hitting the API directly. Returns an error string or null.
const isEmail = (s: any) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s ?? "").trim());
const toNum = (v: any) => (typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, "")));
const blank = (v: any) => v === undefined || v === null || String(v).trim() === "";

// isCreate=true → required fields enforced. isCreate=false (PUT) → only validate fields that are present.
export function validate(model: string, data: any, isCreate: boolean): string | null {
  if (!data || typeof data !== "object") return "Request body is required";
  const has = (k: string) => Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined && data[k] !== null;

  switch (model) {
    case "company":
      if (isCreate && blank(data.name)) return "Company name is required";
      // "—" is the UI's empty placeholder; only reject a real, malformed email
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
