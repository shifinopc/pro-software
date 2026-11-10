/**
 * WHAT CATEGORY AN AUDIT ROW BELONGS TO — written once, used three ways.
 *
 * The console's Audit screen has filter chips (Auth, Users, Roles, Credentials, Workflow, System)
 * that are prefix rules over `action`. Once the SERVER pages the trail it has to apply those rules
 * too, or page 3 of "Auth" is page 3 of everything. That needs the rules as SQL. The screen also
 * labels and colours each row, which needs them as a function. Writing them twice is how the two
 * quietly stop agreeing — so they are written once, as Prisma filters, and `auditMatches` runs the
 * same objects in memory.
 *
 * ORDER MATTERS: a row belongs to the FIRST category that claims it. `user.login_as` starts with
 * "user" and contains "login_as", and it is Auth — reading somebody taking over another account as
 * a routine user edit is exactly the mistake an audit screen must not make.
 *
 * Its own module so that a check can import it without starting the server.
 */
export const AUDIT_CATS: ReadonlyArray<readonly [string, any]> = [
  ["Auth", { OR: [{ action: { startsWith: "login" } }, { action: { startsWith: "password" } }, { action: { contains: "login_as" } }] }],
  ["Users", { action: { startsWith: "user" } }],
  ["Roles", { OR: [{ action: { startsWith: "role" } }, { action: { startsWith: "perm" } }, { action: { startsWith: "settings" } }] }],
  ["Credentials", { action: { contains: "credential" } }],
  ["Workflow", { action: { startsWith: "workflow" } }],
] as const;

/** The chip names, in the order the screen shows them. */
export const AUDIT_CAT_NAMES = [...AUDIT_CATS.map(([n]) => n), "System"] as const;

/** Evaluate one of the filters above against an action, so SQL and label cannot drift apart. */
export function auditMatches(where: any, action: string): boolean {
  if (!where || typeof where !== "object") return true;
  if (Array.isArray(where.OR)) return where.OR.some((w: any) => auditMatches(w, action));
  if (Array.isArray(where.AND)) return where.AND.every((w: any) => auditMatches(w, action));
  if (where.NOT) return !auditMatches(where.NOT, action);
  const f = where.action ?? {};
  if (typeof f.startsWith === "string") return action.startsWith(f.startsWith);
  if (typeof f.contains === "string") return action.includes(f.contains);
  return true;
}

/** The category a row is shown under — the first that claims it, else System. */
export function auditCatOf(action: string): string {
  const hit = AUDIT_CATS.find(([, w]) => auditMatches(w, String(action || "")));
  return hit ? hit[0] : "System";
}

/** The SQL for one chip. "System" is everything no earlier category claimed. */
export function auditWhereFor(cat: string): any {
  if (!cat || cat === "All") return {};
  if (cat === "System") return { NOT: { OR: AUDIT_CATS.map(([, w]) => w) } };
  const i = AUDIT_CATS.findIndex(([n]) => n === cat);
  if (i < 0) return {}; // an unknown chip shows everything rather than nothing
  const earlier = AUDIT_CATS.slice(0, i).map(([, w]) => w);
  return earlier.length ? { AND: [AUDIT_CATS[i][1], { NOT: { OR: earlier } }] } : AUDIT_CATS[i][1];
}
