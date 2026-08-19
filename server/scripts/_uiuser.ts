import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
async function main() {
  const email = "ui-probe@example.invalid", pw = "UiProbe!2026";
  await prisma.user.deleteMany({ where: { email } });
  await prisma.user.create({ data: { name: "UI Probe", email, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(pw, 10) } });
  const r = await (await fetch("http://localhost:4100/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pw }) })).json() as any;
  console.log("TOKEN=" + r.token);
  await prisma.$disconnect();
}
main();
