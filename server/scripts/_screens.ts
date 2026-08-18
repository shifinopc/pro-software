import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
const API = "http://localhost:4100", EMAIL = "scr@example.invalid", PW = "Scr!2026";
await prisma.user.deleteMany({ where: { email: EMAIL } });
await prisma.user.create({ data: { name: "Scr", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
for (const path of ["document-types", "gov-centers", "workforce-bands"]) {
  const r = await (await fetch(`${API}/api/${path}?take=100`, { headers: { Authorization: "Bearer " + tok } })).json() as any;
  const rows = Array.isArray(r) ? r : (r.rows ?? r.data ?? []);
  console.log(`  ${path.padEnd(16)} ${rows.length}  ${rows.map((x: any) => x.name).join(", ")}`);
}
const wf = await (await fetch(`${API}/api/workflow/templates`, { headers: { Authorization: "Bearer " + tok } })).json() as any;
console.log(`  workflows        ${(Array.isArray(wf) ? wf : wf.rows ?? []).length}  ${(Array.isArray(wf) ? wf : wf.rows ?? []).map((x: any) => x.name).join(", ")}`);
await prisma.user.deleteMany({ where: { email: EMAIL } });
await prisma.$disconnect();
