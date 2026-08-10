/**
 * Bind services to the workflow that delivers them.
 *
 * Nine of fourteen services had no workflow, which Setup Check reports as "accepting a quotation or a
 * request for these starts no work — the client is waiting and nobody has a task". It is also what
 * blocks step SLAs: with no service bound, there is no stated duration to derive one from.
 *
 * WHY AN EXPLICIT TABLE AND NOT FUZZY MATCHING
 *
 * Name similarity is exactly wrong here. "GOSI Registration" and "GOSI Registration Renewal" match
 * on almost every string metric, and binding them would mean accepting a first-time REGISTRATION
 * starts a RENEWAL workflow — the wrong steps, silently, for a client who is paying. A fuzzy matcher
 * would make that mistake confidently. So every row below is a decision with a reason attached, and
 * the ones that cannot be decided from the data are refused rather than guessed.
 *
 * WHAT `active` DOES AND DOES NOT MEAN
 *
 * Three targets are marked inactive in the Builder. That does NOT stop them: `startInstance` refuses
 * only RETIRED templates, and `active` gates one thing — the document-expiry auto-renewal job in
 * jobs.ts. So a binding to an inactive template delivers work correctly; it just will not auto-start
 * on an expiry. Flagged per row rather than quietly switched on, because turning on auto-renewal is
 * a decision about the firm chasing work by itself.
 *
 *   npx tsx scripts/bind-services-to-workflows.ts          # propose, write nothing
 *   npx tsx scripts/bind-services-to-workflows.ts --apply  # write
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

interface Row { service: string; template: string | null; why: string }

/** Decided by reading the two lists, not by an algorithm. Order is the order they are reported in. */
const BIND: Row[] = [
  { service: "Company Formation", template: "New Company Formation",
    why: "Same job, 14 steps, the only formation template there is." },
  { service: "Family Visa", template: "Saudi Family Visa Processing",
    why: "The home market is Saudi Arabia; there is no other family-visa flow." },
  { service: "New Employment Visa", template: "Saudi Employment Visa",
    why: "Saudi, not the UAE Employment Visa template beside it — that one is for a different market." },
  { service: "Work Visa Renewal", template: "Work Visa Renewal",
    why: "Exact name. Deliberately NOT 'DEMO — Work Visa Renewal', which is a demo despite being the active one." },
  { service: "Exit / Re-entry Visa", template: "Exit/Re-entry Visa Renewal",
    why: "Same process, and the only exit/re-entry flow." },
  { service: "Iqama Issuance / Renewal", template: "Iqama Renewal (KSA)",
    why: "Two candidates; this one is active, has 11 steps and 5 real runs. The plain 'Iqama Renewal' is a 4-step seeded shell." },
];

/** Refused on purpose. Each of these would look done and behave wrongly. */
const HOLD: Row[] = [
  { service: "GOSI Registration", template: "GOSI Registration Renewal",
    why: "REGISTERING is not RENEWING. Binding it would run renewal steps for a first-time registration. Needs its own template." },
  { service: "VAT Registration", template: "VAT Certificate Renewal",
    why: "Same problem: registration against a renewal flow. The steps for a first VAT registration are not these." },
  { service: "Medical Test", template: null,
    why: "No template exists for it at all. Nothing to bind to — one has to be built first." },
];

async function main() {
  const services = await prisma.serviceItem.findMany({ where: { retired: false }, select: { id: true, name: true, workflowId: true, sla: true, time: true } });
  const templates = await prisma.workflowTemplate.findMany({ where: { retired: false }, select: { id: true, name: true, active: true, graph: true } });
  const svcBy = new Map(services.map(s => [s.name, s]));
  const tplBy = new Map(templates.map(t => [t.name, t]));

  let wrote = 0;
  console.log(APPLY ? "BINDING\n" : "PROPOSED (dry run)\n");

  for (const row of BIND) {
    const s = svcBy.get(row.service);
    const t = row.template ? tplBy.get(row.template) : null;
    if (!s) { console.log(`  ! no service called "${row.service}" — skipped`); continue; }
    if (!t) { console.log(`  ! no template called "${row.template}" — skipped`); continue; }
    if (s.workflowId === t.id) { console.log(`  = ${row.service} → already bound`); continue; }
    if (s.workflowId) { console.log(`  ! ${row.service} is already bound to something else — left alone`); continue; }

    const steps = ((t.graph as any)?.nodes ?? []).filter((n: any) => n?.type !== "trigger" && n?.type !== "end").length;
    console.log(`  ${row.service}\n      → ${t.name} (${steps} steps${t.active ? "" : ", INACTIVE — will not auto-start on a document expiry"})`);
    console.log(`      ${row.why}`);
    console.log(`      duration to derive an SLA from: ${s.sla ?? s.time ?? "NONE STATED — no SLA can be derived"}`);
    if (APPLY) { await prisma.serviceItem.update({ where: { id: s.id }, data: { workflowId: t.id } }); wrote++; }
  }

  console.log(`\nREFUSED — these need a decision or a template, not a guess\n`);
  for (const row of HOLD) {
    console.log(`  ${row.service}${row.template ? `  (nearest: ${row.template})` : ""}`);
    console.log(`      ${row.why}`);
  }

  const after = await prisma.serviceItem.count({ where: { retired: false, NOT: { workflowId: null } } });
  console.log(`\n${APPLY ? `${wrote} binding(s) written. ` : "Nothing written. Re-run with --apply. "}${after} of ${services.length} services now have a workflow.`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
