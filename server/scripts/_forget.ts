import { prisma } from "../src/db.js";
import { forgetCountryRow, KINDS } from "../src/packs.js";
const row = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
const before = ((row?.value as any)?.countries ?? []).map((c: any) => c[0]);
console.log("before: " + JSON.stringify(before));
for (const code of ["ZU", "ZX", "ZZ", "ZQ"]) {
  let n = 0;
  for (const k of KINDS) n += await (prisma as any)[k.model].count({ where: { country: code } });
  if (n) { console.log(`  ${code} still has ${n} config rows — left alone, not a leftover`); continue; }
  await forgetCountryRow(code);
}
const after = await prisma.appSetting.findUnique({ where: { key: "countryRules" } });
console.log("after:  " + JSON.stringify(((after?.value as any)?.countries ?? []).map((c: any) => c[0])));
await prisma.$disconnect();
