/**
 * Strip this installation's country configuration back to Employee Onboarding and nothing else.
 *
 * The country pack carries a whole market — eighteen workflows, fourteen document types, fourteen
 * services, packages, bands. That is the right shape for a finished market and the wrong shape for
 * building one flow at a time: every screen fills with renewals and company-formation work nobody
 * has designed yet, and a mistake in any of it looks identical to a mistake in the flow being built.
 *
 * WHAT IS KEPT is computed from the workflow itself rather than listed here, so this stays correct
 * as the graph changes: the document types its issue_document nodes name, the checklist rule its
 * steps read, and the authorities those document types cite.
 *
 * REFERENCED ROWS ARE RETIRED, NOT DELETED — the same rule the delete guards apply. A document type
 * with a real client document behind it must not vanish and take that record out of every list that
 * joins on it. Retired means gone from the pickers and still valid where it is already used.
 *
 * DELIBERATELY OUT OF SCOPE: services, packages, pipeline stages, lead sources, loss reasons. The
 * first two are a commercial catalogue with live client subscriptions attached and they reference
 * each other, so removing one without the other creates exactly the dangling reference this codebase
 * has been fixing all week. The last three are the sales board, on a different screen, and were
 * installed on purpose. Pass --with-catalogue / --with-crm to include them.
 *
 * Dry run by default; --apply writes.
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");
const WITH_CATALOGUE = process.argv.includes("--with-catalogue");
const WITH_CRM = process.argv.includes("--with-crm");
const KEEP_WORKFLOW = "Employee Onboarding";

type Plan = { model: string; label: string; id: string; name: string; holders: string[] };

async function main() {
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: KEEP_WORKFLOW } });
  if (!tpl) { console.log(`"${KEEP_WORKFLOW}" is not on this installation — refusing to strip everything.`); process.exit(1); }
  const nodes: any[] = ((tpl.graph as any)?.nodes ?? []);
  const keepDocs = new Set(nodes.filter(n => n.type === "issue_document").map(n => String(n.config?.docType)));
  const keepRuleIds = new Set(nodes.map(n => String(n?.config?.checklistRuleId ?? "")).filter(Boolean));
  // A document type the flow does not ISSUE can still be one it depends on. Iqama and Work Visa both
  // carry a prerequisite naming Passport — nobody issues a passport, but retiring it left two
  // prerequisites that could never resolve, which is the same defect as a step naming a type that
  // does not exist. Pulled in transitively, so a prerequisite added later is kept automatically.
  for (const d of await prisma.documentType.findMany({ where: { name: { in: [...keepDocs] } }, select: { prereqs: true } }))
    for (const r of (Array.isArray(d.prereqs) ? (d.prereqs as any[]) : []))
      if (r?.requiresDocType) keepDocs.add(String(r.requiresDocType));

  // Checklist rows may ask for a document BY TYPE rather than as a manual upload.
  for (const r of await prisma.checklistRule.findMany({ where: { id: { in: [...keepRuleIds] } }, select: { rows: true } }))
    for (const row of (Array.isArray(r.rows) ? (r.rows as any[]) : []))
      for (const it of (row?.documents ?? row?.items ?? []))
        if (it?.source === "document" && it?.docType) keepDocs.add(String(it.docType));

  // Authorities: read AFTER the set above is complete, and include the ones workflow steps file under.
  const keepAuth = new Set((await prisma.documentType.findMany({ where: { name: { in: [...keepDocs] } }, select: { authority: true } }))
    .map(d => d.authority).filter(Boolean) as string[]);
  for (const n of nodes) if (n?.config?.govCenter) keepAuth.add(String(n.config.govCenter));

  if (keepDocs.size === 0) { console.log("the workflow issues no documents — that cannot be right, refusing"); process.exit(1); }
  console.log(`keeping: ${KEEP_WORKFLOW} · ${keepDocs.size} document types · ${keepRuleIds.size} checklist rule · ${keepAuth.size} authorities\n`);

  const plan: Plan[] = [];
  const add = async (model: string, label: string, rows: any[], holders: (r: any) => Promise<string[]>) => {
    for (const r of rows) plan.push({ model, label, id: r.id, name: r.name, holders: await holders(r) });
  };

  await add("workflowTemplate", "workflow", await prisma.workflowTemplate.findMany({ where: { name: { not: KEEP_WORKFLOW } } }),
    async r => { const n = await prisma.workflowInstance.count({ where: { templateId: r.id } }); return n ? [`${n} run(s)`] : []; });

  await add("documentType", "document type", await prisma.documentType.findMany({ where: { name: { notIn: [...keepDocs] } } }),
    async r => {
      const out: string[] = [];
      const docs = await prisma.document.count({ where: { docType: r.name } });
      if (docs) out.push(`${docs} client document(s)`);
      // A RETIRED service is not a holder: it is already off the catalogue and cannot be ordered, so
      // counting it would keep a document type alive for something nobody can reach.
      const svc = await prisma.serviceItem.count({ where: { docType: r.name, retired: false } });
      if (svc && !WITH_CATALOGUE) out.push(`${svc} service(s)`);
      return out;
    });

  await add("checklistRule", "checklist rule", await prisma.checklistRule.findMany({ where: { id: { notIn: [...keepRuleIds] } } }),
    async r => {
      const st = await prisma.pipelineStage.count({ where: { checklistRuleId: r.id } });
      return st ? [`${st} pipeline stage(s)`] : [];
    });

  await add("workforceBand", "workforce band", await prisma.workforceBand.findMany({}), async () => []);

  if (WITH_CATALOGUE) {
    await add("serviceItem", "service", await prisma.serviceItem.findMany({}), async r => {
      const out: string[] = [];
      for (const p of await prisma.package.findMany({ select: { name: true, serviceIds: true } }))
        if (Array.isArray(p.serviceIds) && (p.serviceIds as string[]).includes(r.id)) out.push(`package "${p.name}"`);
      return out;
    });
    await add("package", "package", await prisma.package.findMany({}), async r => {
      const n = await prisma.subscription.count({ where: { packageId: r.id } });
      return n ? [`${n} client subscription(s)`] : [];
    });
  }
  if (WITH_CRM) {
    for (const [m, l] of [["pipelineStage", "pipeline stage"], ["leadSource", "lead source"], ["lostReason", "loss reason"]] as const)
      await add(m, l, await (prisma as any)[m].findMany({}), async () => []);
  }

  // Authorities last: a document type removed above may free one, so this is computed after.
  const doomedDocNames = new Set(plan.filter(p => p.model === "documentType").map(p => p.name));
  await add("govCenter", "authority", await prisma.govCenter.findMany({ where: { name: { notIn: [...keepAuth] } } }),
    async r => {
      const out: string[] = [];
      const dts = await prisma.documentType.findMany({ where: { authority: r.name }, select: { name: true } });
      const survivors = dts.filter(d => !doomedDocNames.has(d.name));
      if (survivors.length) out.push(`document type "${survivors[0].name}"`);
      const t = await prisma.task.count({ where: { govCenter: r.name } });
      if (t) out.push(`${t} task(s)`);
      const wt = await prisma.workflowTask.count({ where: { govCenter: r.name } });
      if (wt) out.push(`${wt} workflow step(s)`);
      const cr = await prisma.siteCredential.count({ where: { govCenter: r.name } });
      if (cr) out.push(`${cr} credential(s)`);
      return out;
    });

  let del = 0, ret = 0;
  for (const p of plan) {
    const action = p.holders.length ? "retire" : "delete";
    console.log(`  ${action === "retire" ? "RETIRE" : "delete"}  ${p.label.padEnd(15)} ${p.name.slice(0, 34).padEnd(36)} ${p.holders.join(", ")}`);
    if (!APPLY) { action === "retire" ? ret++ : del++; continue; }
    if (action === "retire") { await (prisma as any)[p.model].update({ where: { id: p.id }, data: { retired: true } }); ret++; }
    else {
      if (p.model === "workflowTemplate") {
        const runs = await prisma.workflowInstance.findMany({ where: { templateId: p.id }, select: { id: true } });
        const ids = runs.map(r => r.id);
        if (ids.length) {
          await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
          await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
          await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
        }
        await prisma.serviceItem.updateMany({ where: { workflowId: p.id }, data: { workflowId: null } });
      }
      await (prisma as any)[p.model].delete({ where: { id: p.id } });
      del++;
    }
  }

  console.log(`\n${del} removed · ${ret} retired (still referenced)${APPLY ? "" : "  — dry run, nothing written"}`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
