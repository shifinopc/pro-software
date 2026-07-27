// One-time backfill: set companyId on invoices that have it null, matching clientName → company.
// Safe/idempotent — only touches rows where companyId is null and a unique name match exists.
// Run: node backfill-invoice-companyid.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const cos = await prisma.company.findMany({ select: { id: true, name: true } });
const byName = new Map(cos.map(c => [c.name.trim().toLowerCase(), c.id]));
const orphans = await prisma.invoice.findMany({ where: { companyId: null } });

let fixed = 0, skipped = 0;
for (const inv of orphans) {
  const id = inv.clientName ? byName.get(inv.clientName.trim().toLowerCase()) : null;
  if (id) { await prisma.invoice.update({ where: { id: inv.id }, data: { companyId: id } }); console.log(`  ✓ ${inv.number} → ${inv.clientName} (${id})`); fixed++; }
  else { console.log(`  – ${inv.number} · no company match for "${inv.clientName}" — left as-is`); skipped++; }
}
console.log(`\nBackfilled ${fixed}, skipped ${skipped} (of ${orphans.length} null-companyId invoices).`);
await prisma.$disconnect();
process.exit(0);
