import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
await prisma.user.deleteMany({ where: { email: "dashprobe@example.invalid" } });
await prisma.user.create({ data: { name: "Dash Probe", email: "dashprobe@example.invalid", roleId: "super_admin", status: "active", lastActive: "Now", type: "staff", passwordHash: await bcrypt.hash("Probe!2026x", 10) } });
console.log("created"); await prisma.$disconnect();
