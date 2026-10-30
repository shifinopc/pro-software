/**
 * A disposable admin account for driving the console locally. Never run this against live.
 *
 *   npx tsx scripts/throwaway-staff.ts          create (prints the password once)
 *   npx tsx scripts/throwaway-staff.ts clean    delete it
 *
 * WHY THIS EXISTS. The obvious way to get into the console for a test is to set a password on an
 * account that is already there. Don't: this database is a copy of live, those are real people, and
 * bcrypt is one-way — the hash you overwrite is gone and that person is locked out for good.
 */
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import crypto from "node:crypto";

const EMAIL = "zz-throwaway@example.invalid";

// A guard, not a note. "Never run this against live" in a comment is advice; this is the thing that
// stops a copied command line from minting an admin account on the production database.
const host = String(process.env.DATABASE_URL ?? "").match(/@([^:/]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`refusing: DATABASE_URL points at "${host || "an unknown host"}", not a local database.`);
  process.exit(2);
}

if (process.argv[2] === "clean") {
  const { count } = await prisma.user.deleteMany({ where: { email: EMAIL } });
  console.log(count ? "removed" : "nothing to remove");
} else {
  const pw = crypto.randomBytes(12).toString("base64url");
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  const data = { name: "ZZ Throwaway", passwordHash: await hashPassword(pw), roleId: "admin", status: "active", type: "staff" };
  if (existing) await prisma.user.update({ where: { email: EMAIL }, data });
  else await prisma.user.create({ data: { email: EMAIL, ...data } });
  console.log(EMAIL);
  console.log(pw);
}
await prisma.$disconnect();
