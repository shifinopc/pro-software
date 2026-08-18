/**
 * Create a staff account that can actually be given work.
 *
 * WHY THIS EXISTS RATHER THAN "just use the invite flow".
 *
 * pickAssignee only considers `status: "active"`, so an INVITED account staffs nothing: the role
 * still has nobody who can hold a task, and every step naming it lands unassigned. That is exactly
 * the state the live installation was in — an hr_officer existed, had been invited, and four steps
 * of the onboarding workflow were still waiting on a role the engine counted as empty.
 *
 * So this creates the account ACTIVE with a one-time password, and marks it must-change. The person
 * can be given work immediately and still chooses their own password the first time they sign in.
 *
 * The password is printed ONCE and never stored anywhere else in readable form. It is not emailed —
 * hand it over however you normally would.
 *
 *   npx tsx scripts/add-staff-user.ts --name "Layla Ahmed" --email layla@example.com --role hr_officer
 *   npx tsx scripts/add-staff-user.ts ... --apply
 *
 * Dry run by default. Re-running for an existing email does NOT touch their password; it only
 * reports what the account already is, and activates an invited one if --activate is passed.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const arg = (n: string) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "";
};
const APPLY = process.argv.includes("--apply");
const ACTIVATE = process.argv.includes("--activate");

/** Readable enough to pass on by phone, random enough not to be guessed. */
function oneTimePassword(): string {
  const words = "Anchor Basalt Cedar Delta Ember Falcon Granite Harbour Indigo Juniper".split(" ");
  const w = words[randomBytes(1)[0] % words.length];
  const n = 1000 + (randomBytes(2).readUInt16BE(0) % 9000);
  const sym = "!@#$%&*"[randomBytes(1)[0] % 7];
  return `${w}${n}${sym}`;
}

async function main() {
  const name = arg("name").trim();
  const email = arg("email").trim().toLowerCase();
  const role = arg("role").trim();

  if (!name || !email || !role) {
    console.error("Usage: add-staff-user.ts --name \"Full Name\" --email a@b.com --role hr_officer [--apply] [--activate]");
    const roles = await prisma.user.groupBy({ by: ["roleId"], where: { type: "staff" }, _count: { _all: true } });
    console.error("\nRoles already held here: " + roles.map(r => `${r.roleId} (${r._count._all})`).join(", "));
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { console.error(`"${email}" is not an email address`); process.exit(1); }

  const existing = await prisma.user.findFirst({ where: { email } });
  if (existing) {
    console.log(`${email} already exists — ${existing.name} · ${existing.roleId} · ${existing.status}`);
    if (existing.status !== "active" && ACTIVATE) {
      // An invited account holds no password, so activating it without one would lock them out of
      // their own account. A fresh one-time password comes with the activation.
      const pw = oneTimePassword();
      if (APPLY) {
        await prisma.user.update({ where: { id: existing.id }, data: { status: "active", passwordHash: await bcrypt.hash(pw, 10), mustChangePassword: true } });
      }
      console.log(`  ${APPLY ? "activated" : "would activate"}, one-time password: ${APPLY ? pw : "(dry run)"}`);
    } else if (existing.status !== "active") {
      console.log(`  still "${existing.status}" — the engine only assigns work to ACTIVE staff. Pass --activate to change that.`);
    }
    await prisma.$disconnect();
    return;
  }

  const pw = oneTimePassword();
  console.log(`${APPLY ? "creating" : "would create"}: ${name} · ${email} · ${role} · active`);
  if (APPLY) {
    await prisma.user.create({
      data: {
        name, email, roleId: role, type: "staff", status: "active",
        passwordHash: await bcrypt.hash(pw, 10),
        mustChangePassword: true,
      },
    });
    console.log(`  one-time password: ${pw}`);
    console.log("  they will be asked to replace it on first sign-in. It is not stored in readable form anywhere.");
  } else {
    console.log("  dry run — pass --apply to create");
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
