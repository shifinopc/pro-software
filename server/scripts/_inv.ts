import { prisma } from "../src/db.js";
import { KINDS } from "../src/packs.js";

const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
const g: any = tpl?.graph ?? {};
const nodes: any[] = g.nodes ?? [];
const keepDocs = new Set(nodes.filter(n => n.type === "issue_document").map(n => String(n.config?.docType)));
const keepRules = new Set(nodes.map(n => String(n?.config?.checklistRuleId ?? "")).filter(Boolean));
const keepAuth = new Set((await prisma.documentType.findMany({ where: { name: { in: [...keepDocs] } }, select: { authority: true } })).map(d => d.authority).filter(Boolean) as string[]);

console.log("EMPLOYEE ONBOARDING NEEDS");
console.log("  document types : " + [...keepDocs].join(", "));
console.log("  checklist rules: " + (await prisma.checklistRule.findMany({ where: { id: { in: [...keepRules] } }, select: { name: true } })).map(r => r.name).join(", "));
console.log("  authorities    : " + [...keepAuth].join(", "));

console.log("\nEVERYTHING ELSE ON THIS INSTALLATION");
for (const k of KINDS) {
  const rows = await (prisma as any)[k.model].findMany({ select: { id: true, name: true } });
  let extra = rows;
  if (k.model === "workflowTemplate") extra = rows.filter((r: any) => r.name !== "Employee Onboarding");
  if (k.model === "documentType") extra = rows.filter((r: any) => !keepDocs.has(r.name));
  if (k.model === "checklistRule") extra = rows.filter((r: any) => !keepRules.has(r.id));
  if (k.model === "govCenter") extra = rows.filter((r: any) => !keepAuth.has(r.name));
  if (!extra.length) continue;
  console.log(`  ${String(extra.length).padStart(3)}  ${k.label.padEnd(22)} ${extra.map((r: any) => r.name).slice(0, 8).join(", ")}${extra.length > 8 ? " …" : ""}`);
}

console.log("\nCLIENT DATA THAT WOULD BE AFFECTED");
console.log("  companies           " + await prisma.company.count());
console.log("  subscriptions       " + await prisma.subscription.count());
console.log("  client documents    " + await prisma.document.count());
console.log("  invoices            " + await prisma.invoice.count());
console.log("  employees           " + await prisma.employee.count());
console.log("  workflow runs       " + await prisma.workflowInstance.count());
await prisma.$disconnect();
