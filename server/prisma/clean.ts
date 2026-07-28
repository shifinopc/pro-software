import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/auth.js";

const prisma = new PrismaClient();

// Wipes ALL business data so you can create everything manually from the app.
// Keeps only the staff login accounts (without them the API returns 401 and you
// cannot get into the console). Change these passwords after first login.
async function main() {
  // Delete in FK-safe order
  await prisma.notification.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.siteCredential.deleteMany();
  await prisma.upgradeRequest.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.task.deleteMany();
  await prisma.document.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.company.deleteMany();
  await prisma.clientGroup.deleteMany();
  await prisma.package.deleteMany();
  await prisma.user.deleteMany();

  // Re-create ONLY the super-admin login. Real staff are added later via Invite User.
  // Neither the address nor the password is hardcoded: this repo is public, so a literal here means
  // every install ships with a super_admin whose credentials anyone can read. Supply both via the
  // environment, or take the generated password printed once below.
  const adminEmail = process.env.ADMIN_EMAIL?.trim() || "admin@example.com";
  const suppliedPw = process.env.ADMIN_PASSWORD;
  const adminPw = suppliedPw && suppliedPw.length >= 8 ? suppliedPw : randomBytes(12).toString("base64url");
  await prisma.user.create({
    data: { name: "Administrator", email: adminEmail, roleId: "super_admin", status: "active", lastActive: "Now", type: "staff", passwordHash: await hashPassword(adminPw) },
  });

  const counts = {
    users: await prisma.user.count(),
    packages: await prisma.package.count(),
    companies: await prisma.company.count(),
    groups: await prisma.clientGroup.count(),
    subscriptions: await prisma.subscription.count(),
    invoices: await prisma.invoice.count(),
    employees: await prisma.employee.count(),
  };
  console.log("Clean complete — empty DB, staff logins only:", counts);
  console.log(`\nSuper admin: ${adminEmail}`);
  if (!suppliedPw || suppliedPw.length < 8) {
    console.log(`Generated password: ${adminPw}`);
    console.log("Shown once — not stored anywhere. Set ADMIN_EMAIL / ADMIN_PASSWORD to choose your own, and change it after signing in.\n");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
