// Reconcile the denormalized Company.employees counter to the real Employee row count.
// This is the root of the "6 vs 5" console-vs-portal drift: the console shows the counter,
// the portal counts actual rows. Safe/idempotent. Run: node reconcile-employee-counts.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const cos = await prisma.company.findMany({ include: { employeeList: { where: { archived: false } } } });
let changed = 0;
for (const c of cos) {
  const real = c.employeeList.length;
  if (c.employees !== real) { await prisma.company.update({ where: { id: c.id }, data: { employees: real } }); console.log(`  ${c.name}: ${c.employees} → ${real}`); changed++; }
}
console.log(`\nReconciled ${changed} of ${cos.length} companies (counter now matches non-archived employee rows).`);
await prisma.$disconnect();
process.exit(0);
