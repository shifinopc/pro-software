import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import crypto from "node:crypto";
import { hashPassword } from "../src/auth.js";

const prisma = new PrismaClient();

// PRODUCTION initial seed for a freshly-wiped database.
// Creates a WORKING blank system: one super-admin login + reference/config data (packages,
// document types, government centers, and the production workflow templates). It does NOT create
// any client companies, employees, documents or invoices — you add those from the app.
//
// Config data (documentTypes / govCenters / workflowTemplates) is loaded verbatim from
// seed-prod-data.json (exported from the working system), so the compliance dropdowns and the
// Workflow Builder are populated on first boot.
//
// Run on an empty DB (after `prisma migrate deploy`):  npx tsx prisma/seed-prod.ts
// It is idempotent — safe to re-run; it wipes and re-creates the seeded rows.

type SeedData = {
  documentTypes: any[];
  govCenters: any[];
  workflowTemplates: any[];
};

async function main() {
  const data: SeedData = JSON.parse(
    readFileSync(new URL("./seed-prod-data.json", import.meta.url), "utf8")
  );

  // ── Wipe in FK-safe order (no-op on an already-empty DB) ──
  await prisma.workflowLog.deleteMany();
  await prisma.workflowTask.deleteMany();
  await prisma.workflowInstance.deleteMany();
  await prisma.workflowTemplate.deleteMany();
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
  await prisma.documentType.deleteMany();
  await prisma.govCenter.deleteMany();
  await prisma.appSetting.deleteMany();
  await prisma.user.deleteMany();

  // ── Super-admin login ──
  // Credentials come from the environment, never from source: this file is in version control, and a
  // hardcoded default is a published password for every deployment that runs the seed unchanged.
  // With nothing set we generate a strong one and print it once.
  const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@example.com";
  const generated = !process.env.SEED_ADMIN_PASSWORD;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
  const pwAdmin = await hashPassword(adminPassword);
  await prisma.user.create({
    data: { name: "Administrator", email: adminEmail, roleId: "super_admin", status: "active", lastActive: "Now", type: "staff", passwordHash: pwAdmin },
  });

  // ── Packages (plans you can assign to a client) ──
  await prisma.package.createMany({
    data: [
      { id: "pkg_silver", name: "Silver", tier: "Silver", basePrice: 2500, billingCycle: "monthly", empMin: 1, empMax: 25, color: "#94a3b8", features: ["Up to 25 employees", "Iqama & visa tracking", "Email support"] },
      { id: "pkg_gold", name: "Gold", tier: "Gold", basePrice: 5000, billingCycle: "monthly", empMin: 26, empMax: 60, color: "#f59e0b", features: ["Up to 60 employees", "Priority renewals", "Dedicated PRO officer"] },
      { id: "pkg_platinum", name: "Platinum", tier: "Platinum", basePrice: 8500, billingCycle: "monthly", empMin: 61, empMax: 150, color: "#7105ef", features: ["Up to 150 employees", "SLA guarantees", "Account manager"] },
      { id: "pkg_ent", name: "Enterprise", tier: "Enterprise", basePrice: 15000, billingCycle: "monthly", empMin: 151, empMax: 9999, color: "#0ea5e9", features: ["Unlimited employees", "Custom workflows", "24/7 support"] },
    ],
  });

  // ── Reference config (loaded from the export) ──
  if (data.documentTypes?.length) await prisma.documentType.createMany({ data: data.documentTypes });
  if (data.govCenters?.length) await prisma.govCenter.createMany({ data: data.govCenters });
  for (const t of (data.workflowTemplates || [])) {
    await prisma.workflowTemplate.create({ data: { ...t, active: true, createdAt: t.createdAt ?? "seed" } });
  }

  // ── Settings defaults (empty org/branding, no custom roles yet) ──
  await prisma.appSetting.createMany({
    data: [
      { key: "org", value: {} },
      { key: "notifRules", value: {} },
      { key: "roles", value: [] },
    ],
  });

  const counts = {
    users: await prisma.user.count(),
    packages: await prisma.package.count(),
    documentTypes: await prisma.documentType.count(),
    govCenters: await prisma.govCenter.count(),
    workflowTemplates: await prisma.workflowTemplate.count(),
    companies: await prisma.company.count(),
  };
  console.log("Production seed complete:", counts);
  console.log(`Login: ${adminEmail} / ${generated ? adminPassword : "(the SEED_ADMIN_PASSWORD you set)"}`);
  if (generated) console.log("This password was generated and is shown ONCE — save it now, then change it after first login.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
