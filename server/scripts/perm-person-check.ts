/**
 * EXCEPTIONS AND SECOND ROLES, TOGETHER — which is where the order matters.
 *
 * Both layers now sit on can(), and the interesting assertions are the ones that cross them: an
 * exception has to beat a role, including a SECOND role, in both directions. Otherwise giving
 * somebody an extra hat would silently undo a withdrawal nobody revisited, and "this accountant,
 * not the receipts" would quietly stop being true.
 *
 * Writes to a real user and restores what was there — local/staging, not live during office hours.
 *
 *   npx tsx scripts/perm-person-check.ts
 */
import { prisma } from "../src/db.js";
import { can, gridForUser, invalidatePermissions, labelForRole } from "../src/permissions.js";

const u = await prisma.user.findFirst({ where: { roleId: "accountant", type: "staff" }, select: { id: true, name: true, roleId: true, permOverrides: true, extraRoles: true } });
if (!u) { console.log("no accountant on this database — nothing to check"); process.exit(0); }
const keepOv = u.permOverrides, keepEx = u.extraRoles;
const label = (await labelForRole(u.roleId))!;
const set = async (ov: any, ex: any) => {
  await prisma.user.update({ where: { id: u.id }, data: { permOverrides: ov, extraRoles: ex } });
  invalidatePermissions();
};

// A cell the Accountant role does not have, and one it does.
await set({}, []);
const roleNo = await can(u.roleId, "Organisation", "Edit", u.id);
const roleYes = await can(u.roleId, "Invoices", "Create", u.id);

await set({ "Organisation|Edit": true, "Invoices|Create": false }, []);
const added = await can(u.roleId, "Organisation", "Edit", u.id);
const removed = await can(u.roleId, "Invoices", "Create", u.id);
const grid = await gridForUser(label, u.id);

// THE CROSSING CASE: a second role grants what an exception has withdrawn. The exception wins.
await set({ "Organisation|Edit": false }, ["admin"]);
const exBeatsRole = await can(u.roleId, "Organisation", "Edit", u.id);
await set({}, ["admin"]);
const roleAloneGrants = await can(u.roleId, "Organisation", "Edit", u.id);

// Neither layer may reach the audit trail.
await set({ "Activity Log|Delete": true }, ["admin"]);
const audit = await can(u.roleId, "Activity Log", "Delete", u.id);

await set((keepOv ?? undefined) as any, (keepEx ?? []) as any);
const back = await can(u.roleId, "Organisation", "Edit", u.id);

const checks: [string, boolean][] = [
  ["the role alone refuses what it refuses", roleNo === false],
  ["the role alone grants what it grants", roleYes === true],
  ["an exception adds", added === true],
  ["an exception withdraws", removed === false],
  ["the grid the console draws shows both", grid["Organisation|Edit"] === true && grid["Invoices|Create"] === false],
  ["a second role alone grants", roleAloneGrants === true],
  ["an exception BEATS a second role", exBeatsRole === false],
  ["append-only beats both", audit === false],
  ["clearing puts the person back", back === false],
];
for (const [what, ok] of checks) console.log((ok ? "ok  " : "FAIL") + "  " + what);
const allOk = checks.every(c => c[1]);
console.log(allOk ? `perm-person-check: ${checks.length} assertions passed` : "perm-person-check: FAILURES");
await prisma.$disconnect();
if (!allOk) process.exit(1);
