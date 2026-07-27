// ─────────────────────────────────────────────────────────────
// DOMAIN LOGIC & CATALOGS  (extracted from App.tsx)
// Package/subscription/prerequisite business rules + the module-level
// catalogs (packages, custom fields, document types) shared by the
// console and portal via same-origin localStorage.
//
// Pure functions here (subStatus, clientSubscription, suggestedPackage,
// prereqFailures) are unit-tested in lib/domain.test.ts. Imports only from
// ./types so there is no circular dependency back into App.tsx.
// ─────────────────────────────────────────────────────────────
import type {
  Package, Subscription, Client, ComplianceDoc, PrereqFailure,
  CustomFieldDef, DocFieldDef, DocType, CustomObjectDef,
} from "../types";

// Seed package catalog (also the fallback when nothing is persisted).
export const PACKAGES: Package[] = [
  { id: "pkg_silver",   name: "Silver",     tier: "Silver",     basePrice: 2500,  billingCycle: "monthly", empMin: 1,   empMax: 25,   color: "#94a3b8", features: ["Up to 25 employees", "Iqama & visa tracking", "Email support"] },
  { id: "pkg_gold",     name: "Gold",       tier: "Gold",       basePrice: 5000,  billingCycle: "monthly", empMin: 26,  empMax: 60,   color: "#f59e0b", features: ["Up to 60 employees", "Priority renewals", "Dedicated PRO officer"] },
  { id: "pkg_platinum", name: "Platinum",   tier: "Platinum",   basePrice: 8500,  billingCycle: "monthly", empMin: 61,  empMax: 150,  color: "#7105ef", features: ["Up to 150 employees", "SLA guarantees", "Account manager"] },
  { id: "pkg_ent",      name: "Enterprise", tier: "Enterprise", basePrice: 15000, billingCycle: "monthly", empMin: 151, empMax: 9999, color: "#0ea5e9", features: ["Unlimited employees", "Custom workflows", "24/7 support"] },
];

// Built-in document type names (fallback when no admin-managed types exist).
export const DOC_TYPES = ["Iqama","Work Visa","Commercial Register","GOSI","Municipal License","Work Permit","Exit/Re-entry","Passport","VAT Certificate","Insurance","Contract"];

// Dynamic package catalog — synced from persisted state (shared by console + portal via same-origin localStorage)
export let PACKAGE_CATALOG: Package[] = (() => {
  try { const s = typeof localStorage !== "undefined" ? localStorage.getItem("stimespro:v1:packages") : null; return s ? (JSON.parse(s) as Package[]) : [...PACKAGES]; } catch { return [...PACKAGES]; }
})();
export const setPackageCatalog = (list: Package[]) => { PACKAGE_CATALOG = list; };
// Admin-defined custom fields for ALL entities (employee, client, …) — module-level so forms + the Form Builder share one source without prop-threading.
export let CUSTOM_FIELDS: CustomFieldDef[] = (() => {
  try { const s = typeof localStorage !== "undefined" ? localStorage.getItem("stimespro:v1:customFields") : null; return s ? (JSON.parse(s) as CustomFieldDef[]) : []; } catch { return []; }
})();
export const setCustomFieldsCatalog = (list: CustomFieldDef[]) => { CUSTOM_FIELDS = list; };
// The entity-bound Form Builder forms FULLY DRIVE the Add Employee / Add Client forms
// (labels/order/required + column mapping via field.key). Empty → hardcoded fallback.
export let EMPLOYEE_FORM_FIELDS: DocFieldDef[] = [];
export const setEmployeeFormFields = (fields: DocFieldDef[]) => { EMPLOYEE_FORM_FIELDS = fields; };
export let CLIENT_FORM_FIELDS: DocFieldDef[] = [];
export const setClientFormFields = (fields: DocFieldDef[]) => { CLIENT_FORM_FIELDS = fields; };
export let TASK_FORM_FIELDS: DocFieldDef[] = [];
export const setTaskFormFields = (fields: DocFieldDef[]) => { TASK_FORM_FIELDS = fields; };
export const applyBoundForms = (forms: CustomObjectDef[]) => {
  const empForm = forms.find(o => o.appliesTo === "employee");
  setEmployeeFormFields(empForm ? (empForm.fields || []) : []);
  const clientForm = forms.find(o => o.appliesTo === "client");
  setClientFormFields(clientForm ? (clientForm.fields || []) : []);
  const taskForm = forms.find(o => o.appliesTo === "task");
  setTaskFormFields(taskForm ? (taskForm.fields || []) : []);
};
// Built-in keys map to real columns/relationships (rendered specially); everything else is a custom field.
export const ENTITY_BUILTIN_KEYS: Record<string, string[]> = {
  employee: ["name", "role"],
  client: ["name", "cr", "industry", "city", "contact", "email", "phone", "status", "group", "salesRep", "package"],
  task: ["title", "client", "docType", "assignee", "priority", "dueDate", "workflow"],
};
// Custom (non-built-in) fields for an entity's Add form: the bound form's keyless fields + any legacy
// CustomField rows (deduped by id). Built-in keyed fields (name/role/… ) are rendered separately.
export const fieldsFor = (entity: string): CustomFieldDef[] => {
  const formSrc = entity === "employee" ? EMPLOYEE_FORM_FIELDS : entity === "client" ? CLIENT_FORM_FIELDS : entity === "task" ? TASK_FORM_FIELDS : [];
  const builtin = ENTITY_BUILTIN_KEYS[entity] ?? [];
  const fromForm: CustomFieldDef[] = formSrc.filter(f => !f.key || !builtin.includes(f.key)).map(f => ({ id: f.id, entity, label: f.label, type: f.type, options: f.options, required: f.required, sortOrder: 0 }));
  const seen = new Set(fromForm.map(f => f.id));
  const legacy = CUSTOM_FIELDS.filter(f => f.entity === entity && !seen.has(f.id));
  return [...fromForm, ...legacy].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
};
// Entities the Form Builder can add custom fields to (built-in record types with forms).
export const FORM_ENTITIES: { id: string; label: string }[] = [{ id: "employee", label: "Employee" }, { id: "client", label: "Client" }, { id: "task", label: "Task" }];
// Admin-defined document types (module-level so Add Document forms + the Document Types manager share one source).
export let DOCUMENT_TYPES: DocType[] = (() => {
  try { const s = typeof localStorage !== "undefined" ? localStorage.getItem("stimespro:v1:documentTypes") : null; return s ? (JSON.parse(s) as DocType[]) : []; } catch { return []; }
})();
export const setDocumentTypesCatalog = (list: DocType[]) => { DOCUMENT_TYPES = list; };
// Names to offer in doc-type pickers: managed types if any, else the built-in defaults.
export const docTypeNames = (): string[] => (DOCUMENT_TYPES.length ? DOCUMENT_TYPES.map(t => t.name) : DOC_TYPES);
export const docTypeByName = (name: string): DocType | undefined => DOCUMENT_TYPES.find(t => t.name === name);

// Who a document type belongs to. Prefers the managed DocumentType.subjectKind; falls back to the
// canonical Saudi taxonomy for built-in names with no managed row. Default = "employee" (most PRO docs
// are person-scoped) so a new/unknown type never silently demands a company subject.
const COMPANY_DOC_HINTS = ["commercial register", "cr license", "cr", "gosi", "municipal license", "vat", "zakat", "chamber of commerce", "trade license"];
export const subjectKindFor = (docType: string): "employee" | "company" => {
  const managed = docTypeByName(docType)?.subjectKind;
  if (managed === "employee" || managed === "company") return managed;
  const n = (docType || "").toLowerCase();
  return COMPANY_DOC_HINTS.some(h => n.includes(h)) ? "company" : "employee";
};

// Renewal-prerequisite check (shared by Add Document + Start Renewal). Returns the unmet rules
// for adding/renewing `docType` for `person`@`client`, given all compliance docs.
export const monthsUntilDate = (dateStr: string) => { const t = new Date(dateStr); return isNaN(t.getTime()) ? -Infinity : (t.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44); };
export function prereqFailures(docType: string, person: string, client: string, allDocs: ComplianceDoc[]): PrereqFailure[] {
  const rules = docTypeByName(docType)?.prereqs ?? [];
  const fails: PrereqFailure[] = [];
  for (const r of rules) {
    // Cross-subject: a company-scoped prerequisite (CR/GOSI/VAT) belongs to the client, not the person —
    // so an employee's Iqama can require the company's valid CR. Match the prereq by its own subject.
    const prereqSubject = subjectKindFor(r.requiresDocType) === "company" ? client : person;
    const cand = allDocs.filter(x => x.docType === r.requiresDocType && x.person === prereqSubject && x.client === client).sort((a, b) => b.daysLeft - a.daysLeft)[0];
    const months = cand ? monthsUntilDate(cand.expiryDate) : -Infinity;
    if (!cand || months < r.minMonths) fails.push({ requiresDocType: r.requiresDocType, minMonths: r.minMonths, prereqDoc: cand, months });
  }
  return fails;
}
export const FEATURE_LIBRARY = ["Iqama & visa tracking", "Priority renewals", "Dedicated PRO officer", "SLA guarantees", "Account manager", "Email support", "24/7 phone support", "Custom workflows", "GOSI management", "Document vault", "API access", "Monthly reports", "Multi-branch support", "Compliance alerts"];

export const packageById = (id: string) => PACKAGE_CATALOG.find(p => p.id === id);
export const subStatus = (s: Subscription): "active" | "expiring" | "expired" => s.daysLeft < 0 ? "expired" : s.daysLeft <= 30 ? "expiring" : "active";
// A company's effective subscription: its own company-level one, else its group's
export function clientSubscription(c: Client, subs: Subscription[]): Subscription | undefined {
  const own = subs.find(s => s.scope === "company" && s.refId === c.id);
  if (own) return own;
  if (c.groupId) return subs.find(s => s.scope === "group" && s.refId === c.groupId);
  return undefined;
}
// Suggest a package upgrade if the employee count exceeds the current package tier's max
export function suggestedPackage(c: Client, subs: Subscription[]): Package | undefined {
  const sub = clientSubscription(c, subs);
  const current = sub ? packageById(sub.packageId) : undefined;
  if (!current || c.employees <= current.empMax) return undefined;
  return PACKAGE_CATALOG.find(p => c.employees >= p.empMin && c.employees <= p.empMax);
}
