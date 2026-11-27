/**
 * DOES A SECOND ROLE ACTUALLY CHANGE WHAT THE SERVER ANSWERS?
 *
 * The multi-role layer is a handful of lines inside can(), and lines that sit on all 168 staff
 * routes are exactly the ones somebody refactors without reading. So it asserts the rules out
 * loud: a second role grants what the first refuses, it never takes anything away, it reaches the
 * grid the console draws from, it does NOT leak to anybody else of the same primary role,
 * append-only still beats it, super_admin can never be granted as an extra, and removing it puts
 * the person back where their own role left them.
 *
 * Writes to a real user and restores what was there — a local/staging tool, not something to point
 * at live during office hours.
 *
 *   npx tsx scripts/perm-multirole-check.ts
 */
import { prisma } from "../src/db.js";
import { can, gridForUser, invalidatePermissions, labelForRole } from "../src/permissions.js";

const u = await prisma.user.findFirst({ where: { roleId: "accountant", type: "staff" }, select: { id: true, name: true, roleId: true, extraRoles: true } });
if (!u) { console.log("no accountant on this database — nothing to check"); process.exit(0); }
const keep = u.extraRoles;
const label = (await labelForRole(u.roleId))!;

// A cell the accountant does NOT have and an admin does, so "granted by the second role" is
// unambiguous. The first draft of this check used Invoices|Approve, which the Accountant role
// already grants, and two assertions "passed" by being true all along.
const before = await can(u.roleId, "Organisation", "Edit", u.id);
const keepsOwn0 = await can(u.roleId, "Invoices", "Create", u.id);
await prisma.user.update({ where: { id: u.id }, data: { extraRoles: ["admin"] } });
invalidatePermissions();
const after = await can(u.roleId, "Organisation", "Edit", u.id);
const keepsOwn = await can(u.roleId, "Invoices", "Create", u.id);
const grid = await gridForUser(label, u.id);
const roleOnly = await can(u.roleId, "Organisation", "Edit", undefined);
const audit = await can(u.roleId, "Activity Log", "Delete", u.id);
await prisma.user.update({ where: { id: u.id }, data: { extraRoles: ["super_admin"] } });
invalidatePermissions();
const rootSmuggled = await can(u.roleId, "Users & Roles", "Delete", u.id);
await prisma.user.update({ where: { id: u.id }, data: { extraRoles: (keep ?? []) as any } });
invalidatePermissions();
const back = await can(u.roleId, "Organisation", "Edit", u.id);

const checks: [string, boolean][] = [
  ["their own role alone says no", before === false],
  ["a second role grants it", after === true],
  ["their own role's access is untouched", keepsOwn0 === true && keepsOwn === true],
  ["the grid the console draws shows the union", grid["Organisation|Edit"] === true && grid["Invoices|Create"] === true],
  ["the same role, without the person, is untouched", roleOnly === false],
  ["append-only still beats a second role", audit === false],
  ["super_admin cannot be smuggled in as an extra role", rootSmuggled === false],
  ["removing it puts the person back", back === false],
];
for (const [what, ok] of checks) console.log((ok ? "ok  " : "FAIL") + "  " + what);
const allOk = checks.every(c => c[1]);
console.log(allOk ? `perm-multirole-check: ${checks.length} assertions passed` : "perm-multirole-check: FAILURES");
await prisma.$disconnect();
if (!allOk) process.exit(1);
