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

export const MODULES = [
  "Dashboard", "Tasks", "Approvals", "SLA Monitor", "Activity Log", "Clients",
  "Compliance", "Finance", "Sales", "Reports", "Workflow", "Settings",
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

/** Per-module departures from the preset above. */
const TUNE: Record<string, Partial<Record<PermModule, number[]>>> = {
  "PRO Officer": {
    Finance: [1, 0, 0, 0, 0, 0],
    Reports: [1, 0, 0, 0, 0, 1],
    Workflow: [1, 0, 0, 0, 0, 0],
    Settings: [0, 0, 0, 0, 0, 0],
    // Front-line ops read the pipeline to know what work is coming; they do not sell.
    Sales: [1, 0, 0, 0, 0, 0],
  },
  Accountant: {
    Tasks: [1, 0, 0, 0, 0, 0],
    Approvals: [1, 0, 0, 1, 0, 0],
    Clients: [1, 0, 0, 0, 0, 0],
    Compliance: [1, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    Settings: [0, 0, 0, 0, 0, 0],
    Sales: [1, 0, 0, 0, 0, 1],
  },
  Sales: {
    Approvals: [0, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    Settings: [0, 0, 0, 0, 0, 0],
    "Activity Log": [1, 0, 0, 0, 0, 0],
    Finance: [1, 0, 0, 0, 0, 0],
    Tasks: [1, 0, 0, 0, 0, 0],
    "SLA Monitor": [1, 0, 0, 0, 0, 0],
    // The one module a salesperson actually works in. Read-only everywhere else, but they must be
    // able to log a call, move a deal and add a contact or the role cannot do its job — which is
    // exactly what the hardcoded admin-only gate did to it.
    Sales: [1, 1, 1, 0, 0, 1],
  },
  "Client Admin": {
    Tasks: [0, 0, 0, 0, 0, 0],
    Approvals: [0, 0, 0, 0, 0, 0],
    "SLA Monitor": [0, 0, 0, 0, 0, 0],
    "Activity Log": [0, 0, 0, 0, 0, 0],
    Finance: [1, 0, 0, 0, 0, 1],
    Reports: [0, 0, 0, 0, 0, 0],
    Workflow: [0, 0, 0, 0, 0, 0],
    Settings: [0, 0, 0, 0, 0, 0],
    Sales: [0, 0, 0, 0, 0, 0],
  },
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
      if (row?.id && row?.name) {
        labels[row.id] = String(row.name);
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
  if (roleId === "super_admin") return true;                       // rule 1
  if ((APPEND_ONLY[mod] ?? []).includes(act)) return false;        // rule 4
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
  ["/api/workflow/templates", "Workflow"],
  ["/api/workflow/checklist-rules", "Workflow"],
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
  ["/api/credentials", "Clients"],
  ["/api/documents", "Compliance"],
  ["/api/courier-shipments", "Compliance"],
  ["/api/setup-check", "Compliance"],
  ["/api/invoices", "Finance"],
  ["/api/payments", "Finance"],
  ["/api/packages", "Finance"],
  ["/api/service-items", "Finance"],
  ["/api/zatca-qr.svg", "Finance"],
  // ── Sales: the module added because the matrix could not express CRM at all ──
  ["/api/pipeline", "Sales"],
  ["/api/pipeline-stages", "Sales"],
  ["/api/opportunities", "Sales"],
  ["/api/leads", "Sales"],
  ["/api/lead-scores", "Sales"],
  ["/api/contacts", "Sales"],
  ["/api/interactions", "Sales"],
  ["/api/follow-ups", "Sales"],
  ["/api/quotations", "Sales"],
  ["/api/crm-dashboard", "Sales"],
  ["/api/targets-forecast", "Sales"],
  ["/api/sales-targets", "Sales"],
  ["/api/inbox", "Sales"],
  ["/api/mailbox", "Sales"],
  ["/api/teams", "Sales"],
  ["/api/assignable-owners", "Sales"],
  ["/api/owner-rotation", "Sales"],
  ["/api/booking-links", "Sales"],
  ["/api/sales-report", "Reports"],
  ["/api/ops-report", "Reports"],
  ["/api/stage-analytics", "Reports"],
  ["/api/email-log", "Reports"],
  ["/api/settings", "Settings"],
  // An admin diagnostic about the grid itself. /api/permissions stays UNMAPPED on purpose, a few
  // lines down: it is how a role discovers its own grid, and gating that behind a permission would
  // mean needing the permission to find out you lack it.
  ["/api/permissions/coverage", "Settings"],
  ["/api/users", "Settings"],
  ["/api/api-keys", "Settings"],
  ["/api/email-config", "Settings"],
  ["/api/integrations", "Settings"],
  ["/api/record-sequences", "Settings"],
  ["/api/packs", "Settings"],
  ["/api/countries", "Settings"],
  ["/api/notifications", "Dashboard"],
  ["/api/appointments", "Compliance"],
  ["/api/gov-centers", "Compliance"],
  ["/api/document-types", "Compliance"],
  ["/api/workforce-bands", "Compliance"],
  ["/api/groups", "Clients"],
  ["/api/subscriptions", "Finance"],
  ["/api/custom-objects", "Settings"],
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

const isExempt = (path: string) => EXEMPT.some(p => path === p || path.startsWith(p + "/") || path.startsWith(p));

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

export function coverageOf(stack: any[]): Coverage {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const layer of stack ?? []) {
    const p = layer?.route?.path;
    if (typeof p !== "string" || !p.startsWith("/api")) continue;
    // One entry per path: the same path registered for GET and PUT is one thing to govern, and
    // counting it twice would overstate how much of the app each module covers.
    if (seen.has(p)) continue;
    seen.add(p);
    paths.push(p);
  }
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
