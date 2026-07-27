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
  await prisma.salesRep.deleteMany();
  await prisma.package.deleteMany();
  await prisma.user.deleteMany();

  // Re-create ONLY the super-admin login. Real staff are added later via Invite User.
  const pwAdmin = await hashPassword("admin123");
  await prisma.user.create({
    data: { name: "Administrator", email: "shifin@ionob.com", roleId: "super_admin", status: "active", lastActive: "Now", type: "staff", passwordHash: pwAdmin },
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
