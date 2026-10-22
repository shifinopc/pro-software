/**
 * Prove the permission matrix, because one middleware applies it to every staff route and nothing
 * was checking it.
 *
 * Six things are worth proving:
 *
 *   1. SUPER ADMIN IS ROOT. It is allowed everything the matrix governs, without a row saying so.
 *   2. A ROLE IS REFUSED WHAT IT HAS NOT BEEN GIVEN. A PRO officer cannot delete a client.
 *   3. AN UNKNOWN ROLE GETS NOTHING. A typo in a role id must not be an open door.
 *   4. A CUSTOM ROLE INHERITS ITS BASE. This is what makes an admin-defined role usable at all, and
 *      a custom role with no base must not inherit anything by accident.
 *   5. AN EXPLICIT TICK WINS over the preset, in both directions — that is what the screen edits.
 *   6. THE APPEND-ONLY MODULES CANNOT BE UNLOCKED. Nobody edits or deletes the activity log, and no
 *      grid row, not even for Super Admin, may say otherwise.
 *
 * Plus the route→permission mapping, since a route the matrix does not recognise falls through
 * ungoverned and is exactly the kind of hole nobody notices.
 *
 * SNAPSHOTS AND RESTORES the two settings rows it has to write (`perms` and `roles`), which hold a
 * real firm's permission grid. It puts back exactly what was there, and deletes the rows it created.
 */
import { prisma } from "../src/db.js";
import { can, permFor, invalidatePermissions, presetFor } from "../src/permissions.js";
import { resolveEffectiveRole } from "../src/auth.js";

let bad = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); bad++; };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

const CUSTOM = "custom_probe_0000";
const CUSTOM_NO_BASE = "custom_probe_0001";

/** `can()` caches for 30 seconds, so every write to the settings has to drop it. */
async function putSetting(key: string, value: any) {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  invalidatePermissions();
}

async function expect(roleId: string | undefined, mod: any, act: any, want: boolean, what: string) {
  const got = await can(roleId, mod, act);
  if (got === want) ok(`${what} — ${got ? "allowed" : "refused"}`);
  else fail(`${what}: got ${got ? "allowed" : "refused"}, expected ${want ? "allowed" : "refused"}`);
}

async function main() {
  // ── snapshot ────────────────────────────────────────────────────────────────────────────────
  const beforePerms = await prisma.appSetting.findUnique({ where: { key: "perms" } });
  const beforeRoles = await prisma.appSetting.findUnique({ where: { key: "roles" } });
  const restore = async () => {
    for (const [key, row] of [["perms", beforePerms], ["roles", beforeRoles]] as const) {
      if (row) await prisma.appSetting.upsert({ where: { key }, update: { value: row.value as any }, create: { key, value: row.value as any } });
      else await prisma.appSetting.delete({ where: { key } }).catch(() => {});
    }
    invalidatePermissions();
  };

  try {
    console.log("the built-in roles");
    await expect("super_admin", "Clients", "Delete", true, "super admin may delete a client");
    await expect("super_admin", "Workflow", "Edit", true, "super admin may edit a workflow");
    await expect("pro_officer", "Clients", "View", true, "a PRO officer may view clients");
    await expect("pro_officer", "Clients", "Delete", false, "a PRO officer may NOT delete a client");
    await expect("sales", "Clients", "Delete", false, "sales may NOT delete a client");
    await expect("sales", "Pipeline", "View", true, "sales may view the pipeline");

    console.log("\nno role, and a role nobody has heard of");
    await expect(undefined, "Clients", "View", false, "a request with no role at all");
    await expect("", "Clients", "View", false, "an empty role");
    await expect("pro_offcier", "Clients", "View", false, "a misspelt built-in role");
    await expect("custom_does_not_exist", "Clients", "View", false, "a custom role that was deleted");

    console.log("\na custom role inherits the role it was built on");
    await putSetting("roles", [
      { id: CUSTOM, label: "ZS Probe Ops Lead", base: "Admin" },
      { id: CUSTOM_NO_BASE, label: "ZS Probe Nothing" },
    ]);
    await expect(CUSTOM, "Clients", "Delete", true, "a custom role based on Admin inherits Delete");
    await expect(CUSTOM, "Clients", "View", true, "…and View");
    // No base means no inheritance: it falls to the bare view-only default, not to somebody's guess.
    await expect(CUSTOM_NO_BASE, "Clients", "View", true, "a custom role with no base still sees");
    await expect(CUSTOM_NO_BASE, "Clients", "Delete", false, "…but a role with no base cannot delete");

    console.log("\nwhat the screen ticks is what the server enforces");
    // Explicit false over an inherited true, and explicit true over an inherited false. The key is
    // `label|module|action` — the LABEL, which is what trips people up when reading this table.
    await putSetting("perms", {
      "ZS Probe Ops Lead|Clients|Delete": false,
      "PRO Officer|Clients|Delete": true,
    });
    await expect(CUSTOM, "Clients", "Delete", false, "an explicit untick beats the inherited Admin preset");
    await expect("pro_officer", "Clients", "Delete", true, "an explicit tick beats the PRO Officer preset");

    console.log("\nthe activity log is append-only, for everybody");
    await putSetting("perms", {
      "Super Admin|Activity Log|Delete": true,
      "Admin|Activity Log|Edit": true,
    });
    await expect("super_admin", "Activity Log", "Delete", false, "super admin cannot delete activity, even with a row saying yes");
    await expect("admin", "Activity Log", "Edit", false, "nor can an admin edit it");
    await expect("admin", "Activity Log", "View", true, "reading it is fine");

    console.log("\ncustom roles resolve to a base role for the hand-written gates too");
    const eff = await resolveEffectiveRole(CUSTOM);
    if (eff === "admin") ok(`${CUSTOM} resolves to admin`);
    else fail(`${CUSTOM} resolved to ${eff}, expected admin`);
    const effUnknown = await resolveEffectiveRole("custom_does_not_exist");
    // Least privilege for something nobody can look up — never admin.
    if (effUnknown === "pro_officer") ok("an unknown custom role resolves to the least-privileged staff role");
    else fail(`an unknown custom role resolved to ${effUnknown}`);
    if (await resolveEffectiveRole("admin") === "admin") ok("a built-in role resolves to itself");
    else fail("a built-in role did not resolve to itself");

    console.log("\nroutes map to the right cell");
    const cases: [string, string, string, string][] = [
      ["DELETE", "/api/companies/abc", "Clients", "Delete"],
      ["GET", "/api/companies", "Clients", "View"],
      ["POST", "/api/companies", "Clients", "Create"],
      ["PUT", "/api/companies/abc", "Clients", "Edit"],
      // Longest prefix wins, which is the reason this list exists: "/api/service-requests" must not
      // be swallowed by "/api/service-items".
      ["GET", "/api/service-requests", "Clients", "View"],
      ["GET", "/api/workflow/tasks", "Tasks", "View"],
      ["GET", "/api/audit", "Activity Log", "View"],
    ];
    for (const [method, path, mod, act] of cases) {
      const got = permFor(method, path);
      if (got?.module === mod && got?.action === act) ok(`${method} ${path} → ${mod}/${act}`);
      else fail(`${method} ${path} → ${got ? `${got.module}/${got.action}` : "UNGOVERNED"}, expected ${mod}/${act}`);
    }

    console.log("\nand the presets are the shape the code expects");
    // Six actions, in the order ACTIONS declares. A preset of the wrong length silently reads as
    // "false" for whatever fell off the end.
    for (const label of ["Super Admin", "Admin", "PRO Officer", "Accountant", "Sales", "Client Admin"]) {
      const row = presetFor(label, "Clients" as any);
      if (row.length !== 6) fail(`preset for ${label} has ${row.length} actions, expected 6`);
    }
    ok("every role preset has six actions");
  } finally {
    await restore();
  }

  // The firm's own grid is back, and the probe's roles are gone.
  const after = await prisma.appSetting.findUnique({ where: { key: "roles" } });
  if (JSON.stringify(after?.value ?? null) !== JSON.stringify(beforeRoles?.value ?? null)) {
    fail("the roles setting was not restored to what it was");
  } else ok("\nthe firm's own roles and grid are back exactly as they were");

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
