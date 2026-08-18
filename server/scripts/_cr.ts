import { prisma } from "../src/db.js";
const row = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
const list = (row?.value as any)?.countries ?? [];
console.log("countryRules rows:");
for (const c of list) console.log("  " + JSON.stringify(c));
import { KINDS } from "../src/packs.js";
for (const code of ["ZU", "ZX", "ZZ", "ZQ"]) {
  let n = 0;
  for (const k of KINDS) n += await (prisma as any)[k.model].count({ where: { country: code } });
  if (n) console.log(`  leftover config rows for ${code}: ${n}`);
}
await prisma.$disconnect();
