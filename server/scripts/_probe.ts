import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
await prisma.user.create({ data: { id: "fixp", name: "Fix Probe", email: "fix@example.invalid",
  type: "staff", roleId: "super_admin", status: "active", passwordHash: await hashPassword("Probe!2026xyz") } });
console.log("ok"); await prisma.$disconnect();
