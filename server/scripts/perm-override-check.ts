/**
 * DOES AN EXCEPTION ACTUALLY CHANGE WHAT THE SERVER ANSWERS?
 *
 * The override layer is six lines inside can(), and six lines that sit on all 168 staff routes are
 * exactly the kind that get refactored by somebody who has not read this file. So it asserts the
 * rules out loud: an exception grants, an exception withdraws, it reaches the grid the console
 * draws from, it does NOT leak to anybody else of the same role, append-only still beats it, and
 * clearing it puts the person back where their role left them.
 *
 * Writes to a real user and restores what was there. Read-only in effect, not in method — so it is
 * a local/staging tool, not something to point at live during office hours.
 *
 *   npx tsx scripts/perm-override-check.ts
 */
import { prisma } from "../src/db.js";
import { can, gridForUser, invalidatePermissions, labelForRole } from "../src/permissions.js";

const u = await prisma.user.findFirst({ where: { roleId: "accountant", type: "staff" }, select: { id: true, name: true, roleId: true, permOverrides: true } });
if (!u) { console.log("no accountant on this database — nothing to check"); process.exit(0); }
const keep = u.permOverrides;
const label = (await labelForRole(u.roleId))!;

// A cell the role does NOT have, so "granted" is unambiguous. Picked deliberately: the first run of
// this check used Invoices|Approve, which the Accountant role already grants, and two assertions
// "failed" by being true all along.
const before = await can(u.roleId, "Organisation", "Edit", u.id);
await prisma.user.update({ where: { id: u.id }, data: { permOverrides: { "Organisation|Edit": true, "Invoices|Create": false } } });
invalidatePermissions();
const after = await can(u.roleId, "Organisation", "Edit", u.id);
const denied = await can(u.roleId, "Invoices", "Create", u.id);
const grid = await gridForUser(label, u.id);
const roleOnly = await can(u.roleId, "Organisation", "Edit", undefined);
await prisma.user.update({ where: { id: u.id }, data: { permOverrides: { "Activity Log|Delete": true } } });
invalidatePermissions();
const audit = await can(u.roleId, "Activity Log", "Delete", u.id);
await prisma.user.update({ where: { id: u.id }, data: { permOverrides: (keep ?? undefined) as any } });
invalidatePermissions();
const back = await can(u.roleId, "Organisation", "Edit", u.id);

const checks: [string, boolean][] = [
  ["the role alone says no", before === false],
  ["a + exception grants it", after === true],
  ["a - exception withdraws what the role gives", denied === false],
  ["the grid the console draws shows both", grid["Organisation|Edit"] === true && grid["Invoices|Create"] === false],
  ["the same role, without the person, is untouched", roleOnly === false],
  ["append-only still beats an exception", audit === false],
  ["clearing them puts the person back", back === false],
];
for (const [what, ok] of checks) console.log((ok ? "ok  " : "FAIL") + "  " + what);
const allOk = checks.every(c => c[1]);
console.log(allOk ? `perm-override-check: ${checks.length} assertions passed` : "perm-override-check: FAILURES");
await prisma.$disconnect();
if (!allOk) process.exit(1);
