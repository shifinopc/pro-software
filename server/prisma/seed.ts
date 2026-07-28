import { PrismaClient } from "@prisma/client";
import { hashPassword, encrypt } from "../src/auth.js";

const prisma = new PrismaClient();

async function main() {
  // Clear in FK-safe order
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

  // Packages
  await prisma.package.createMany({
    data: [
      { id: "pkg_silver", name: "Silver", tier: "Silver", basePrice: 2500, billingCycle: "monthly", empMin: 1, empMax: 25, color: "#94a3b8", features: ["Up to 25 employees", "Iqama & visa tracking", "Email support"] },
      { id: "pkg_gold", name: "Gold", tier: "Gold", basePrice: 5000, billingCycle: "monthly", empMin: 26, empMax: 60, color: "#f59e0b", features: ["Up to 60 employees", "Priority renewals", "Dedicated PRO officer"] },
      { id: "pkg_platinum", name: "Platinum", tier: "Platinum", basePrice: 8500, billingCycle: "monthly", empMin: 61, empMax: 150, color: "#7105ef", features: ["Up to 150 employees", "SLA guarantees", "Account manager"] },
      { id: "pkg_ent", name: "Enterprise", tier: "Enterprise", basePrice: 15000, billingCycle: "monthly", empMin: 151, empMax: 9999, color: "#0ea5e9", features: ["Unlimited employees", "Custom workflows", "24/7 support"] },
    ],
  });

  // Groups
  await prisma.clientGroup.createMany({
    data: [
      { id: "grp1", name: "Al-Ghamdi Group", contact: "Abdullah Al-Ghamdi", email: "group@alghamdi.sa" },
      { id: "grp2", name: "Otaibi Industries", contact: "Mohammed Al-Otaibi", email: "corp@otaibi.sa" },
      { id: "grp3", name: "AlFuturo Group", contact: "Tariq Al-Dosari", email: "hq@alfuturo.sa" },
    ],
  });

  // Companies
  await prisma.company.createMany({
    data: [
      { id: "cl1", name: "Global Tech LLC", cr: "1010123456", industry: "Technology", employees: 45, status: "active", overdue: 8, expiring: 12, contact: "Abdullah Al-Ghamdi", email: "abdullah@globaltech.sa", phone: "+966 50 123 4567", city: "Riyadh", groupId: "grp1" },
      { id: "cl2", name: "SkyBridge Corp", cr: "1010234567", industry: "Logistics", employees: 23, status: "active", overdue: 2, expiring: 5, contact: "Sarah Mitchell", email: "sarah@skybridge.com", phone: "+966 55 234 5678", city: "Jeddah" },
      { id: "cl3", name: "TechVault Arabia", cr: "1010345678", industry: "Fintech", employees: 67, status: "active", overdue: 15, expiring: 23, contact: "Mohammed Al-Otaibi", email: "mo@techvault.sa", phone: "+966 56 345 6789", city: "Riyadh", groupId: "grp2" },
      { id: "cl4", name: "Meridian Services", cr: "1010456789", industry: "Consulting", employees: 12, status: "suspended", overdue: 0, expiring: 3, contact: "Layla Hassan", email: "layla@meridian.com", phone: "+966 54 456 7890", city: "Dammam" },
      { id: "cl5", name: "AlFuturo Holdings", cr: "1010567890", industry: "Investment", employees: 89, status: "active", overdue: 4, expiring: 8, contact: "Tariq Al-Dosari", email: "tariq@alfuturo.sa", phone: "+966 50 567 8901", city: "Riyadh", groupId: "grp3" },
      { id: "cl6", name: "Nexus Digital Arabia", cr: "1010678901", industry: "Technology", employees: 31, status: "active", overdue: 3, expiring: 6, contact: "Omar Bin Sultan", email: "omar@nexusdigital.sa", phone: "+966 55 678 9012", city: "Riyadh", groupId: "grp1" },
      { id: "cl7", name: "Arabian Horizons Co.", cr: "1010789012", industry: "Hospitality", employees: 54, status: "active", overdue: 1, expiring: 9, contact: "Nadia Al-Farsi", email: "nadia@horizons.sa", phone: "+966 56 789 0123", city: "Jeddah" },
      { id: "cl8", name: "Gulf Dynamics Ltd", cr: "1010890123", industry: "Engineering", employees: 112, status: "active", overdue: 6, expiring: 14, contact: "Faisal Al-Shehri", email: "faisal@gulfdynamics.sa", phone: "+966 54 890 1234", city: "Dammam", groupId: "grp2" },
      { id: "cl9", name: "Riyadh Ventures", cr: "1010901234", industry: "Investment", employees: 18, status: "inactive", overdue: 0, expiring: 1, contact: "Hessa Al-Qasem", email: "hessa@rvc.sa", phone: "+966 50 901 2345", city: "Riyadh", groupId: "grp3" },
      { id: "cl10", name: "ProLink Solutions", cr: "1010012345", industry: "IT Services", employees: 38, status: "active", overdue: 2, expiring: 7, contact: "Khaled Mansour", email: "khaled@prolink.sa", phone: "+966 55 012 3456", city: "Riyadh" },
    ],
  });

  // Subscriptions (group- and company-scoped, some custom-priced)
  await prisma.subscription.createMany({
    data: [
      { id: "sub1", scope: "group", refId: "grp1", packageId: "pkg_gold", price: 4500, startDate: "Aug 1, 2024", endDate: "Feb 5, 2025", daysLeft: 6, autoRenew: true, custom: true },
      { id: "sub2", scope: "group", refId: "grp2", packageId: "pkg_platinum", price: 8500, startDate: "Jan 1, 2025", endDate: "Dec 31, 2025", daysLeft: 210, autoRenew: true, custom: false },
      { id: "sub3", scope: "group", refId: "grp3", packageId: "pkg_platinum", price: 8000, startDate: "Mar 1, 2024", endDate: "Feb 28, 2025", daysLeft: 28, autoRenew: false, custom: true },
      { id: "sub4", scope: "company", refId: "cl2", companyId: "cl2", packageId: "pkg_silver", price: 2500, startDate: "Nov 1, 2024", endDate: "Apr 30, 2025", daysLeft: 90, autoRenew: true, custom: false },
      { id: "sub5", scope: "company", refId: "cl4", companyId: "cl4", packageId: "pkg_silver", price: 2200, startDate: "Jun 1, 2024", endDate: "Jan 20, 2025", daysLeft: -5, autoRenew: false, custom: true },
      { id: "sub6", scope: "company", refId: "cl7", companyId: "cl7", packageId: "pkg_gold", price: 5000, startDate: "Sep 1, 2024", endDate: "Feb 18, 2025", daysLeft: 19, autoRenew: true, custom: false },
      { id: "sub7", scope: "company", refId: "cl10", companyId: "cl10", packageId: "pkg_gold", price: 4800, startDate: "Oct 1, 2024", endDate: "Jul 1, 2025", daysLeft: 152, autoRenew: true, custom: true },
    ],
  });

  // A few employees (for Global Tech)
  await prisma.employee.createMany({
    data: [
      { companyId: "cl1", name: "Ahmed Al-Rashid", role: "Engineer", iqamaExpiry: "Feb 10, 2025", status: "expiring" },
      { companyId: "cl1", name: "Maria Santos", role: "Analyst", iqamaExpiry: "Feb 13, 2025", status: "valid" },
      { companyId: "cl1", name: "Kim Lee", role: "Manager", iqamaExpiry: "Feb 16, 2025", status: "expiring" },
      { companyId: "cl1", name: "Roberto Alvarez", role: "Developer", iqamaExpiry: "Feb 19, 2025", status: "expiring" },
    ],
  });

  // Sample documents, invoices
  await prisma.document.createMany({
    data: [
      { companyId: "cl1", person: "Kim Lee", docType: "Work Visa", expiryDate: "Feb 6, 2025", status: "overdue", daysLeft: -14 },
      { companyId: "cl3", person: "Ahmed Al-Rashid", docType: "Iqama", expiryDate: "Feb 20, 2025", status: "expiring", daysLeft: 24 },
    ],
  });
  await prisma.invoice.createMany({
    data: [
      { number: "INV-2025-001", companyId: "cl1", clientName: "Global Tech LLC", amount: 12500, currency: "SAR", status: "paid", date: "Jan 15, 2025", dueDate: "Jan 30, 2025", services: "Iqama Renewals (8), Visa Processing (2)" },
      { number: "INV-2025-002", companyId: "cl2", clientName: "SkyBridge Corp", amount: 8750, currency: "SAR", status: "pending", date: "Jan 20, 2025", dueDate: "Feb 4, 2025", services: "Passport Processing (5), CR Amendment (1)" },
    ],
  });

  // Staff users (hashed passwords)
  const [pwAdmin, pwOfficer, pwAcct, pwSales, pwClient] = await Promise.all([
    hashPassword("admin123"), hashPassword("officer123"), hashPassword("accounts123"), hashPassword("sales123"), hashPassword("client123"),
  ]);
  await prisma.user.createMany({
    data: [
      { name: "Khalid Al-Mutairi", email: "admin@stimes.sa", roleId: "super_admin", status: "active", lastActive: "Now", type: "staff", passwordHash: pwAdmin },
      { name: "Omar Abdullah", email: "officer@stimes.sa", roleId: "pro_officer", status: "active", lastActive: "Yesterday", type: "staff", passwordHash: pwOfficer },
      { name: "Sara Ahmed", email: "accounts@stimes.sa", roleId: "accountant", status: "active", lastActive: "Jan 20", type: "staff", passwordHash: pwAcct },
      { name: "Yousef Al-Harbi", email: "yousef@stimes.sa", roleId: "sales", status: "active", lastActive: "2h ago", type: "staff", assignedClientIds: ["cl1", "cl6"], passwordHash: pwSales },
    ],
  });

  // Portal users — one per company (login with the company's contact email + "client123")
  const allCompanies = await prisma.company.findMany();
  await prisma.user.createMany({
    data: allCompanies.filter(c => c.email).map(c => ({
      name: c.contact ?? c.name, email: c.email!.toLowerCase(), roleId: "client_admin",
      status: "active", lastActive: "Today", type: "portal", companyId: c.id, passwordHash: pwClient,
    })),
  });

  // A pending upgrade request + a couple credentials
  await prisma.upgradeRequest.create({
    data: { companyId: "cl2", clientName: "SkyBridge Corp", fromPackageId: "pkg_silver", toPackageId: "pkg_gold", note: "Growing headcount, need priority renewals", status: "pending", date: "Today" },
  });
  await prisma.siteCredential.createMany({
    data: [
      { companyId: "cl1", label: "Qiwa", url: "https://qiwa.sa", username: "globaltech@qiwa.sa", password: encrypt("Qw!7fA2xL9pR"), notes: "Labor / Nitaqat platform" },
      { companyId: "cl1", label: "Muqeem", url: "https://muqeem.sa", username: "admin@globaltech.sa", password: encrypt("Mq#3kD8vN4zT"), notes: "Iqama & visa services" },
    ],
  });

  const counts = {
    packages: await prisma.package.count(),
    groups: await prisma.clientGroup.count(),
    companies: await prisma.company.count(),
    subscriptions: await prisma.subscription.count(),
    users: await prisma.user.count(),
  };
  console.log("Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
