/**
 * THE PERMISSIONS MATRIX, ENFORCED.
 *
 * Settings → Permissions has always drawn a full role × module × action grid, saved it to
 * AppSetting "perms", and reloaded it on the next visit. Nothing read it. Authorisation came
 * entirely from hardcoded middleware, so ticking "Delete" off for Accountant looked like it
 * worked, survived a reload, and changed nothing. An admin screen that appears to grant and
 * revoke access and does neither is worse than no screen at all.
 *
 * This is the missing half. It is the AUTHORITY for every route it maps: the grid grants as well
 * as removes, so a box ticked on is a permission the server will honour, and a box ticked off is
 * one it will refuse.
 *
 * FOUR RULES THAT KEEP IT SAFE
 *
 * 1. SUPER ADMIN IS NEVER RESTRICTED. The screen locks that row on; so does this. A permission
 *    system whose own editor can be locked away is one nobody can repair.
 * 2. THE PRESETS LIVE HERE, not in the browser. They used to exist only in index.html, so the
 *    server had no idea what an untouched cell meant. Two copies of a default is how a screen and
 *    its enforcement drift until the screen is lying again — the client now renders from this.
 * 3. AN UNMAPPED ROUTE IS NOT AN OPEN ONE. Anything this file does not recognise keeps exactly the
 *    gate it had before (admin-only for writes). New routes are therefore closed by default rather
 *    than silently unguarded, and `unmappedRoutes()` lists them so the gap is visible.
 * 4. THE AUDIT TRAIL CANNOT BE EDITED by anybody, at any level. Same lock the screen draws.
 */
import { prisma } from "./db.js";

/**
 * ONE MODULE PER THING SOMEBODY OPENS, not one per department.
 *
 * "Finance" used to be a single permission covering invoices, receipts, the price list and the
 * subscription plans — so an accountant who had to raise invoices was also handed the catalogue
 * the prices come from, and there was no way to say otherwise. "Compliance" and "Settings" were
 * the same shape: one answer to several different questions.
 *
 * The three have been split along the lines the work actually divides on. Nothing about the
 * mechanism changed — a module is still a set of route prefixes, an action is still derived from
 * the verb — there are simply more of them, and each one now matches a screen somebody can name.
 */
export const MODULES = [
  "Dashboard", "Tasks", "Approvals", "SLA Monitor", "Activity Log",
  "Clients",
  // was "Compliance"
  "Documents", "Appointments", "Courier", "Gov Centers", "Document Types",
  // was "Finance", plus Quotations which used to sit inside Sales
  "Invoices", "Payments", "Quotations", "Plan & Billing", "Service Catalog",
  // was "Sales" — one module over nine screens, so the only way to give the front line a client's
  // phone number was to hand them the whole deal pipeline
  "Pipeline", "Leads", "Contacts", "Sales Targets", "Teams & Routing",
  "Reports", "Workflow",
  // was "Settings"
  "Users & Roles", "Organisation", "Email", "Integrations", "API Keys",
] as const;
export type PermModule = (typeof MODULES)[number];

export const ACTIONS = ["View", "Create", "Edit", "Approve", "Delete", "Export"] as const;
export type PermAction = (typeof ACTIONS)[number];

/** Role id → the label the matrix is keyed by. The grid is stored under display names. */
export const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  pro_officer: "PRO Officer",
  accountant: "Accountant",
  sales: "Sales",
  client_admin: "Client Admin",
};

/** [View, Create, Edit, Approve, Delete, Export] — the default for every module of that role. */
const PRESET: Record<string, number[]> = {
  "Super Admin": [1, 1, 1, 1, 1, 1],
  Admin: [1, 1, 1, 1, 1, 1],
  "PRO Officer": [1, 1, 1, 0, 0, 1],
  Accountant: [1, 1, 1, 0, 0, 1],
  Sales: [1, 0, 0, 0, 0, 1],
  "Client Admin": [1, 0, 0, 0, 0, 0],
};

/**
 * Per-module departures from the preset above.
 *
 * WRITTEN OUT IN FULL FOR THE SPLIT MODULES, deliberately, rather than generated from the old
 * parent. A module nobody has configured falls back to the role preset, and for several roles that
 * preset says Create — so leaving the new children unlisted would have quietly handed an accountant
 * the power to edit document types the day this shipped. Every line below is what that role could
 * do before the split, re-stated against the finer module.
 */
const TUNE: Record<string, Partial<Record<PermModule, number[]>>> = {
  "PRO Officer": {
    Reports: [1, 0, 0, 0, 0, 1],
    Workflow: [1, 0, 0, 0, 0, 0],
    // Front-line ops read the pipeline to know what work is coming; they do not sell. Was one
    // "Sales: view only" — restated unchanged, so nobody gains or loses anything on the day of the
    // split. Untick Pipeline and Sales Targets here if the front line should not see deal values.
    Pipeline: [1, 0, 0, 0, 0, 0],
    Leads: [1, 0, 0, 0, 0, 0],
    Contacts: [1, 0, 0, 0, 0, 0],
    "Sales Targets": [1, 0, 0, 0, 0, 0],
    "Teams & Routing": [1, 0, 0, 0, 0, 0],
    // …and do not price. Quotations came out of Sales, where they were read-only for this role.
    Quotations: [1, 0, 0, 0, 0, 0],
    // Was one "Finance: view only".
    Invoices: [1, 0, 0, 0, 0, 0],
    Payments: [1, 0, 0, 0, 0, 0],
    "Plan & Billing": [1, 0, 0, 0, 0, 0],
    "Service Catalog": [1, 0, 0, 0, 0, 0],
    // Was one "Compliance", on the role preset: the front line's own work, unchanged.
    Documents: [1, 1, 1, 0, 0, 1],
    Appointments: [1, 1, 1, 0, 0, 1],
    Courier: [1, 1, 1, 0, 0, 1],
    "Gov Centers": [1, 1, 1, 0, 0, 1],
    "Document Types": [1, 1, 1, 0, 0, 1],
    // Was one "Settings: nothing".
    "Users & Roles": [0, 0, 0, 0, 0, 0],
    Organisation: [0, 0, 0, 0, 0, 0],
    Email: [0, 0, 0, 0, 0, 0],
    Integrations: [0, 0, 0, 0, 0, 0],
    "API Keys": [0, 0, 0, 0, 0, 0],
  },
  Accountant: {
    Tasks: [1, 0, 0, 0, 0, 0],
    Approvals: [1, 0, 0, 1, 0, 0],
    Clients: [1, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    // Was one "Sales: view and export", restated five ways, unchanged.
    Pipeline: [1, 0, 0, 0, 0, 1],
    Leads: [1, 0, 0, 0, 0, 1],
    Contacts: [1, 0, 0, 0, 0, 1],
    "Sales Targets": [1, 0, 0, 0, 0, 1],
    "Teams & Routing": [1, 0, 0, 0, 0, 1],
    // THE POINT OF THE SPLIT. Money in and out is theirs; the price list and the plans that
    // generate the money are not, and before this there was no way to say so.
    Invoices: [1, 1, 1, 0, 0, 1],
    Payments: [1, 1, 1, 0, 0, 1],
    Quotations: [1, 0, 0, 0, 0, 1],
    "Plan & Billing": [1, 0, 0, 0, 0, 1],
    "Service Catalog": [1, 0, 0, 0, 0, 1],
    // Was one "Compliance: view only".
    Documents: [1, 0, 0, 0, 0, 0],
    Appointments: [1, 0, 0, 0, 0, 0],
    Courier: [1, 0, 0, 0, 0, 0],
    "Gov Centers": [1, 0, 0, 0, 0, 0],
    "Document Types": [1, 0, 0, 0, 0, 0],
    "Users & Roles": [0, 0, 0, 0, 0, 0],
    Organisation: [0, 0, 0, 0, 0, 0],
    Email: [0, 0, 0, 0, 0, 0],
    Integrations: [0, 0, 0, 0, 0, 0],
    "API Keys": [0, 0, 0, 0, 0, 0],
  },
  Sales: {
    Approvals: [0, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    "Activity Log": [1, 0, 0, 0, 0, 0],
    Tasks: [1, 0, 0, 0, 0, 0],
    "SLA Monitor": [1, 0, 0, 0, 0, 0],
    // The one module a salesperson actually works in. Read-only everywhere else, but they must be
    // able to log a call, move a deal and add a contact or the role cannot do its job — which is
    // exactly what the hardcoded admin-only gate did to it.
    // Working the pipeline IS the job, so all four selling modules keep what Sales had. Routing is
    // the exception worth making by hand: letting a rep edit the rules that decide who gets which
    // lead is letting them assign themselves the good ones. Left as it was — untick it to close that.
    Pipeline: [1, 1, 1, 0, 0, 1],
    Leads: [1, 1, 1, 0, 0, 1],
    Contacts: [1, 1, 1, 0, 0, 1],
    "Sales Targets": [1, 1, 1, 0, 0, 1],
    "Teams & Routing": [1, 1, 1, 0, 0, 1],
    // Quotations came out of Sales and keeps what Sales had: writing the offer IS the job.
    Quotations: [1, 1, 1, 0, 0, 1],
    // Was one "Finance: view only".
    Invoices: [1, 0, 0, 0, 0, 0],
    Payments: [1, 0, 0, 0, 0, 0],
    "Plan & Billing": [1, 0, 0, 0, 0, 0],
    "Service Catalog": [1, 0, 0, 0, 0, 0],
    // Was the role preset on "Compliance": view and export.
    Documents: [1, 0, 0, 0, 0, 1],
    Appointments: [1, 0, 0, 0, 0, 1],
    Courier: [1, 0, 0, 0, 0, 1],
    "Gov Centers": [1, 0, 0, 0, 0, 1],
    "Document Types": [1, 0, 0, 0, 0, 1],
    "Users & Roles": [0, 0, 0, 0, 0, 0],
    Organisation: [0, 0, 0, 0, 0, 0],
    Email: [0, 0, 0, 0, 0, 0],
    Integrations: [0, 0, 0, 0, 0, 0],
    "API Keys": [0, 0, 0, 0, 0, 0],
  },
  "Client Admin": {
    Tasks: [0, 0, 0, 0, 0, 0],
    Approvals: [0, 0, 0, 0, 0, 0],
    "SLA Monitor": [0, 0, 0, 0, 0, 0],
    "Activity Log": [0, 0, 0, 0, 0, 0],
    Reports: [0, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    // A client sees none of the firm's selling, as before.
    Pipeline: [0, 0, 0, 0, 0, 0],
    Leads: [0, 0, 0, 0, 0, 0],
    Contacts: [0, 0, 0, 0, 0, 0],
    "Sales Targets": [0, 0, 0, 0, 0, 0],
    "Teams & Routing": [0, 0, 0, 0, 0, 0],
    Quotations: [0, 0, 0, 0, 0, 0],
    // Was one "Finance: see and export your own".
    Invoices: [1, 0, 0, 0, 0, 1],
    Payments: [1, 0, 0, 0, 0, 1],
    "Plan & Billing": [1, 0, 0, 0, 0, 1],
    "Service Catalog": [1, 0, 0, 0, 0, 1],
    Documents: [1, 0, 0, 0, 0, 0],
    Appointments: [1, 0, 0, 0, 0, 0],
    Courier: [1, 0, 0, 0, 0, 0],
    "Gov Centers": [1, 0, 0, 0, 0, 0],
    "Document Types": [1, 0, 0, 0, 0, 0],
    "Users & Roles": [0, 0, 0, 0, 0, 0],
    Organisation: [0, 0, 0, 0, 0, 0],
    Email: [0, 0, 0, 0, 0, 0],
    Integrations: [0, 0, 0, 0, 0, 0],
    "API Keys": [0, 0, 0, 0, 0, 0],
  },
};

/**
 * Which module each split one came out of.
 *
 * Kept because the saved grid is keyed by module NAME: every tick an admin has made reads
 * "Accountant|Finance|Create", and "Finance" no longer exists. `migrateSplitModules()` reads this
 * to expand each saved parent tick onto its children, once, so nothing anybody configured is lost
 * in the rename. It is also the honest record of what this split did, for whoever reads it next.
 */
export const SPLIT_PARENTS: Record<string, PermModule[]> = {
  Finance: ["Invoices", "Payments", "Plan & Billing", "Service Catalog"],
  Compliance: ["Documents", "Appointments", "Courier", "Gov Centers", "Document Types"],
  Settings: ["Users & Roles", "Organisation", "Email", "Integrations", "API Keys"],
  // Quotations left Sales first; now Sales itself is gone. A saved Sales tick has to reach all six
  // or a sales rep loses the pipeline on the day this ships. Listing Quotations again is harmless:
  // the carry-across never overwrites a child that already has its own tick.
  Sales: ["Quotations", "Pipeline", "Leads", "Contacts", "Sales Targets", "Teams & Routing"],
};

/** No role may mutate the audit trail — it is append-only, and the screen locks these too. */
const APPEND_ONLY: Partial<Record<PermModule, PermAction[]>> = {
  "Activity Log": ["Create", "Edit", "Approve", "Delete"],
};

export const presetFor = (label: string, mod: PermModule): number[] =>
  TUNE[label]?.[mod] ?? PRESET[label] ?? [1, 0, 0, 0, 0, 0];

let _cache: { at: number; grid: Record<string, boolean>; labels: Record<string, string>; bases: Record<string, string> } | null = null;

/** Stored overrides + the custom-role id→label map, cached briefly (same 30s as role resolution). */
async function load() {
  if (_cache && Date.now() - _cache.at < 30000) return _cache;
  const labels: Record<string, string> = { ...ROLE_LABEL };
  // A custom role inherits its BASE role's defaults for any cell nobody has set. Without this a
  // role built on Admin would fall to the bare [View] default and lock its holders out of work
  // they were explicitly given — the opposite of what creating it was for.
  const bases: Record<string, string> = {};
  let grid: Record<string, boolean> = {};
  try {
    const [p, r] = await Promise.all([
      prisma.appSetting.findUnique({ where: { key: "perms" } }),
      prisma.appSetting.findUnique({ where: { key: "roles" } }),
    ]);
    const v = p?.value as any;
    if (v && typeof v === "object" && !Array.isArray(v)) grid = v;
    for (const row of (Array.isArray(r?.value) ? (r!.value as any[]) : [])) {
      // `label` is what the console has always written; `name` was what this read. So a role created
      // in Settings never reached the engine: labels[id] stayed undefined, can() found no grid and no
      // preset, and every holder of that role was refused everything the matrix governs — while the
      // role itself showed up perfectly in the picker and on the user. Both spellings accepted, the
      // console's first, because that is the one on disk.
      const rowLabel = row?.label ?? row?.name;
      if (row?.id && rowLabel) {
        labels[row.id] = String(rowLabel);
        if (row.base && PRESET[String(row.base)]) bases[row.id] = String(row.base);
      }
    }
  } catch {
    // A database blip must not lock the building. Fall through on presets rather than refusing
    // everybody — the hardcoded gates underneath are still in force.
    if (_cache) return _cache;
  }
  _cache = { at: Date.now(), grid, labels, bases };
  return _cache;
}

/** Drop the cache so an admin's change takes effect on the next request, not in half a minute. */
export const invalidatePermissions = () => { _cache = null; };

export async function labelForRole(roleId: string | undefined): Promise<string | null> {
  if (!roleId) return null;
  const { labels } = await load();
  return labels[roleId] ?? null;
}

/**
 * May this role do this? Unknown roles are refused rather than defaulted — a role nobody has
 * described is not one to hand permissions to.
 */
export async function can(roleId: string | undefined, mod: PermModule, act: PermAction): Promise<boolean> {
  if (!roleId) return false;
  // APPEND-ONLY FIRST, AND THAT ORDER IS THE POINT. These two were the other way round, so the root
  // account was handed every action before the lock was consulted — a super admin could delete
  // activity-log entries. `gridFor` below already draws that cell as locked for Super Admin, so the
  // screen said one thing and the server did another, and the whole value of an append-only audit
  // trail is that the most powerful account cannot edit it either.
  if ((APPEND_ONLY[mod] ?? []).includes(act)) return false;        // rule 4
  if (roleId === "super_admin") return true;                       // rule 1
  const { grid, labels, bases } = await load();
  const label = labels[roleId];
  if (!label) return false;
  const key = `${label}|${mod}|${act}`;
  if (typeof grid[key] === "boolean") return grid[key];
  const fallback = PRESET[label] ? label : (bases[roleId] ?? label);
  return !!presetFor(fallback, mod)[ACTIONS.indexOf(act)];
}

/** Every custom role's label, so the screen lists the roles the server actually knows about. */
export async function customRoleLabels(): Promise<string[]> {
  const { labels } = await load();
  const builtin = new Set(Object.values(ROLE_LABEL));
  return Object.values(labels).filter(l => !builtin.has(l));
}

/** The whole resolved grid for one role — what the screen must draw, so the two cannot disagree. */
export async function gridFor(label: string): Promise<Record<string, boolean>> {
  const { grid } = await load();
  const out: Record<string, boolean> = {};
  for (const mod of MODULES) {
    for (const act of ACTIONS) {
      const key = `${label}|${mod}|${act}`;
      const locked = (APPEND_ONLY[mod] ?? []).includes(act);
      out[`${mod}|${act}`] = label === "Super Admin" ? !locked
        : locked ? false
        : typeof grid[key] === "boolean" ? grid[key]
        : !!presetFor(label, mod)[ACTIONS.indexOf(act)];
    }
  }
  return out;
}

// ── Which module does a route belong to? ──────────────────────────────────────────────────────
//
// Longest prefix wins, so "/api/service-requests" is not swallowed by "/api/service-items". Order
// in this list is irrelevant; length decides.
const MODULE_OF: Array<[string, PermModule]> = [
  ["/api/workflow/tasks", "Tasks"],
  ["/api/workflow/my-work", "Tasks"],
  ["/api/workflow/instances", "Tasks"],
  ["/api/proposal-templates", "Quotations"],
  ["/api/workflow/templates", "Workflow"],
  ["/api/workflow/checklist-rules", "Workflow"],
  ["/api/workflow/field-sets", "Workflow"],
  ["/api/assignment-rules", "Workflow"],
  ["/api/prereq-check", "Workflow"],
  ["/api/team-performance", "Tasks"],
  ["/api/sla", "SLA Monitor"],
  ["/api/upgrade-requests", "Approvals"],
  ["/api/activities", "Activity Log"],
  ["/api/audit", "Activity Log"],
  ["/api/companies", "Clients"],
  ["/api/employees", "Clients"],
  ["/api/service-requests", "Clients"],
  ["/api/workforce", "Clients"],
  ["/api/workforce-history", "Clients"],
  // NOT "/api/credentials". The vault holds every client's government portal passwords, and mapping
  // it here handed it to the Clients module — which PRO Officer, Accountant and Sales all hold View
  // on by default. Because requireReadRole defers to this grid whenever it governs a route, the
  // admin-only rule written on those routes became dead code, and any of those roles could list the
  // vault and reveal any client's password in plaintext. Verified against a running server before
  // this line was removed.
  //
  // Ungoverned here means it keeps its own gate — requireReadRole("super_admin", "admin") on the
  // list and the reveal, requireWriteRole on the writes — which is what those routes always claimed
  // to do. The coverage report lists it as ungoverned, which is the honest answer: this grid is not
  // the whole story for the vault, deliberately.
  ["/api/documents", "Documents"],
  ["/api/courier-shipments", "Courier"],
  ["/api/setup-check", "Organisation"],
  ["/api/invoices", "Invoices"],
  ["/api/payments", "Payments"],
  ["/api/packages", "Plan & Billing"],
  ["/api/service-items", "Service Catalog"],
  ["/api/zatca-qr.svg", "Invoices"],
  // ── Sales, split five ways ──
  // One "Sales" could not say any of the things a PRO firm actually needs to say: that the front
  // line may look up a client's number but not the deal pipeline, that a junior may triage web
  // enquiries without seeing deal values, that a salesperson works the pipeline but must not edit
  // the routing rules that decide who gets which lead.
  ["/api/pipeline", "Pipeline"],
  // Configuration AND the board's columns come from here, so it travels with Pipeline rather than
  // with the setup screen — gating it elsewhere would leave a salesperson a board that cannot draw.
  ["/api/pipeline-stages", "Pipeline"],
  ["/api/opportunities", "Pipeline"],
  ["/api/crm-dashboard", "Pipeline"],
  ["/api/leads", "Leads"],
  ["/api/lead-scores", "Leads"],      // scores OF open leads, not the scoring rules
  ["/api/inbox", "Leads"],
  ["/api/mailbox", "Leads"],
  ["/api/contacts", "Contacts"],
  ["/api/interactions", "Contacts"],
  ["/api/follow-ups", "Contacts"],
  ["/api/booking-links", "Contacts"],
  ["/api/targets-forecast", "Sales Targets"],
  ["/api/sales-targets", "Sales Targets"],
  // Sales Teams and PRO Teams are one route and therefore one module. Saying otherwise in the
  // matrix would be a promise the server cannot keep.
  ["/api/teams", "Teams & Routing"],
  ["/api/assignable-owners", "Teams & Routing"],
  ["/api/owner-rotation", "Teams & Routing"],
  ["/api/quotations", "Quotations"],
  ["/api/sales-report", "Reports"],
  ["/api/ops-report", "Reports"],
  ["/api/stage-analytics", "Reports"],
  ["/api/email-log", "Reports"],
  ["/api/settings", "Organisation"],
  // An admin diagnostic about the grid itself. /api/permissions stays UNMAPPED on purpose, a few
  // lines down: it is how a role discovers its own grid, and gating that behind a permission would
  // mean needing the permission to find out you lack it.
  ["/api/permissions/coverage", "Users & Roles"],
  ["/api/users", "Users & Roles"],
  ["/api/api-keys", "API Keys"],
  ["/api/email-config", "Email"],
  ["/api/integrations", "Integrations"],
  ["/api/record-sequences", "Organisation"],
  ["/api/packs", "Organisation"],
  ["/api/countries", "Organisation"],
  ["/api/notifications", "Dashboard"],
  ["/api/appointments", "Appointments"],
  ["/api/gov-centers", "Gov Centers"],
  ["/api/document-types", "Document Types"],
  ["/api/workforce-bands", "Clients"],
  ["/api/groups", "Clients"],
  ["/api/subscriptions", "Plan & Billing"],
  ["/api/custom-objects", "Organisation"],
];

/**
 * Routes this file must NEVER gate.
 *
 * Signing in, reading who you are, reporting a crash and the health check cannot depend on a
 * permission — you would need the permission to discover you lack it. `/api/settings/perms` is
 * exempt on READ for the same reason the screen must load before it can be edited; its write is
 * still gated as Settings.Edit below.
 */
const EXEMPT = [
  "/api/auth", "/api/health", "/api/error-reports", "/api/cron", "/api/public",
  "/api/portal", "/api/upload", "/api/files", "/api/stream", "/api/stream-ticket", "/book/",
];

/**
 * ACTING ON A STEP THAT IS ASSIGNED TO YOU IS NOT EDITING THE TASK BOARD.
 *
 * These three already carry the authority on who may act: `mayActOnTask` requires the step to be
 * queued to your role, assigned to you by name, unclaimed, or you to be an admin — plus a scoped
 * rule letting a lead cover their own discipline. The matrix was a second, blunter gate on top of
 * it, and it mapped these to Tasks.Edit because the path ends in `/complete`.
 *
 * Which meant the Accountant preset — Tasks: View only, deliberately, because accountants do not
 * run the task board — refused an accountant the one thing a workflow had explicitly routed to
 * them. "Pay the Fee" on a live Work Permit renewal sat with the accountant it was assigned to,
 * and pressing Complete step answered "Your role does not have Edit access to Tasks". No
 * permission could be ticked to fix it without also handing that role the whole board.
 *
 * So the step's own gate is the authority here, and the matrix stands aside. Deliberately NOT the
 * whole `/tasks/` subtree: `/credential` reads a client's vault entry and keeps its Tasks.View
 * requirement.
 */
const STEP_ACTIONS = ["/complete", "/checklist", "/reassign"];
const isStepAction = (path: string) =>
  path.startsWith("/api/workflow/tasks/") && STEP_ACTIONS.some(a => path.endsWith(a));

const isExempt = (path: string) =>
  isStepAction(path) || EXEMPT.some(p => path === p || path.startsWith(p + "/") || path.startsWith(p));

/**
 * WHAT THIS GRID ACTUALLY GOVERNS.
 *
 * The modules are not a list somebody may add to, and that is worth saying plainly rather than
 * leaving people to discover it. A module means something only because MODULE_OF binds route
 * prefixes to it; a module an admin invented would bind to no routes, so every box ticked under it
 * would enforce precisely nothing — which is the exact lie this file was written to end. Adding one
 * is a code change because the thing being named has to exist in code.
 *
 * What CAN be fixed without code is the gap this reports: a route that no module governs keeps its
 * old hardcoded gate, which is safe but invisible. It means the grid is not the whole story for
 * that route, and until now nothing said which ones. Answering it from the router itself rather
 * than a maintained list is the point — a list of what we think we registered drifts from what we
 * registered, and drifts silently.
 */
export type Coverage = {
  modules: Array<{ module: PermModule; routes: number }>;
  ungoverned: string[];
  exempt: number;
  total: number;
};

/**
 * The mount path of a router, which Express keeps only as a compiled regexp.
 *
 * `app.use("/api/appointments", crud(...))` leaves no readable path anywhere on the layer — just
 * `/^\/api\/appointments\/?(?=\/|$)/`. Unpicking it is the only way to know what was mounted
 * where.
 */
function mountPathOf(layer: any): string {
  if (layer?.regexp?.fast_slash) return "";
  const src = String(layer?.regexp?.source ?? "");
  if (!src) return "";
  // Built with RegExp rather than literals: the pattern is itself full of escaped slashes, and a
  // literal would need every one of them escaped again, which is unreadable and was wrong twice.
  const TAIL = new RegExp("\\\\/\\?\\(\\?=\\\\/\\|\\$\\)\\$?$");
  return src
    .replace(/^\^/, "")
    .replace(TAIL, "")
    .replace(/\$$/, "")
    .replace(new RegExp("\\\\/", "g"), "/");
}

export function coverageOf(stack: any[]): Coverage {
  const seen = new Set<string>();
  const paths: string[] = [];
  // DESCENDS INTO MOUNTED ROUTERS, which it did not before.
  //
  // Every generic collection — appointments, document types, government centers, payments — is an
  // `app.use("/api/<thing>", crud(...))`, and a mounted router has no `.route` of its own. So this
  // walked straight past all of them and reported zero routes for each, while the matrix was in
  // fact governing them perfectly well. Harmless-looking undercounting until the modules were
  // split, at which point the panel started printing "Appointments 0" beside a permission that
  // visibly works — a screen calling its own enforcement imaginary.
  const walk = (layers: any[], prefix: string) => {
    for (const layer of layers ?? []) {
      const p = layer?.route?.path;
      if (typeof p === "string") {
        const full = (prefix + (p === "/" ? "" : p)) || p;
        if (!full.startsWith("/api")) continue;
        // One entry per path: the same path registered for GET and PUT is one thing to govern, and
        // counting it twice would overstate how much of the app each module covers.
        if (seen.has(full)) continue;
        seen.add(full);
        paths.push(full);
        continue;
      }
      const child = layer?.handle?.stack;
      if (Array.isArray(child)) walk(child, prefix + mountPathOf(layer));
    }
  };
  walk(stack ?? [], "");
  const counts = new Map<PermModule, number>();
  const ungoverned: string[] = [];
  let exempt = 0;
  for (const p of paths) {
    if (isExempt(p)) { exempt++; continue; }
    const m = moduleOf(p);
    if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    else ungoverned.push(p);
  }
  return {
    modules: MODULES.map(m => ({ module: m, routes: counts.get(m) ?? 0 })),
    ungoverned: ungoverned.sort(),
    exempt,
    total: paths.length,
  };
}

export function moduleOf(path: string): PermModule | null {
  let best: [string, PermModule] | null = null;
  for (const row of MODULE_OF) {
    if ((path === row[0] || path.startsWith(row[0] + "/")) && (!best || row[0].length > best[0].length)) best = row;
  }
  return best ? best[1] : null;
}

/**
 * Which action is this? The verb decides by default, but a POST is not always a creation: moving a
 * deal, completing a step or suspending a client are EDITS, and treating them as Create would hand
 * "may add things" to somebody who should only be allowed to change what exists.
 */
const EDIT_SUFFIX = [
  "/move", "/done", "/cancel", "/reschedule", "/complete", "/checklist", "/waive", "/revise",
  "/suspend", "/restore", "/extend", "/void", "/lead", "/members", "/make-primary", "/reassign",
  "/read", "/sync", "/disconnect", "/connect", "/open-deal", "/convert", "/status", "/edit",
  "/exit-request", "/commission-rate", "/target", "/score-preview", "/test", "/preview",
];

export function actionOf(method: string, path: string): PermAction {
  const p = path.toLowerCase();
  if (p.includes("/approve") || p.includes("/reject")) return "Approve";
  if (p.includes("/export")) return "Export";
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return "View";
  if (m === "DELETE") return "Delete";
  if (m === "PUT" || m === "PATCH") return "Edit";
  return EDIT_SUFFIX.some(s => p.endsWith(s) || p.includes(s + "/")) ? "Edit" : "Create";
}

/** null → this route is not governed by the matrix and keeps whatever gate it already had. */
export function permFor(method: string, path: string): { module: PermModule; action: PermAction } | null {
  if (isExempt(path)) return null;
  const mod = moduleOf(path);
  if (!mod) return null;
  return { module: mod, action: actionOf(method, path) };
}
