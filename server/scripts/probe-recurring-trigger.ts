/**
 * The recurring trigger: the engine's fifth, and the one two services were blocked on.
 *
 * A calendar knows nothing about who a job is for. That is the whole difficulty, and the whole risk:
 * opened carelessly this raises a VAT return every month for every client on the books, including
 * the ones who are not VAT registered — a queue of invented work, which is worse than no automation.
 * So what this proves is mostly about restraint:
 *
 *   1. An entitled client gets exactly one run for the period.
 *   2. Running the tick again opens NOTHING. The tick is hourly and the period is monthly; without
 *      this a client would end the month owing seven hundred VAT returns.
 *   3. A client with no entitlement gets nothing, even though the template is active.
 *   4. A suspended client gets nothing — new work is paused for them by definition.
 *   5. A template no service points at fires for nobody rather than for everybody.
 *
 * Own client, own package, own subscription, own template. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import { startPeriodicRuns } from "../src/jobs.js";

const TAG = "ZS recurring probe";
const ENTITLED = "ZS Recurring Entitled";
const OUTSIDER = "ZS Recurring Outsider";
const SUSPENDED = "ZS Recurring Suspended";

let bad = 0;
const fail = (m: string) => { bad++; console.log(`   FAIL  ${m}`); };
const ok = (m: string) => console.log(`   ok    ${m}`);

async function sweep() {
  for (const n of [ENTITLED, OUTSIDER, SUSPENDED]) {
    const co = await prisma.company.findFirst({ where: { name: n } });
    if (!co) continue;
    const runs = await prisma.workflowInstance.findMany({ where: { companyId: co.id }, select: { id: true } });
    const ids = runs.map(r => r.id);
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.task.deleteMany({ where: { companyId: co.id } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { companyId: co.id } });
    await prisma.company.delete({ where: { id: co.id } }).catch(() => {});
  }
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.package.deleteMany({ where: { name: { startsWith: TAG } } });
}

const countFor = (coId: string) => prisma.workflowInstance.count({ where: { companyId: coId } });

async function main() {
  await sweep();

  // The smallest possible recurring workflow: one step, then done.
  const tpl = await prisma.workflowTemplate.create({ data: {
    name: `${TAG} template`, country: "SA", entityType: "company",
    trigger: "recurring", triggerConfig: { every: "monthly", opensOnDay: 1 } as any,
    graph: { nodes: [
      { id: "start", type: "start", label: "S", config: {} },
      { id: "step", type: "task", label: "The Only Step", config: { assigneeRole: "pro_officer", slaHours: 24 } },
      { id: "end_done", type: "end", label: "E", config: {} },
    ], edges: [{ from: "start", to: "step" }, { from: "step", to: "end_done" }] } as any,
    active: true, createdAt: new Date().toISOString(),
  } });

  const entitled = await prisma.company.create({ data: { name: ENTITLED, country: "SA", status: "active" } as any });
  const outsider = await prisma.company.create({ data: { name: OUTSIDER, country: "SA", status: "active" } as any });
  const suspended = await prisma.company.create({ data: { name: SUSPENDED, country: "SA", status: "suspended" } as any });

  // ── 5. no service points at it yet ──────────────────────────────────────────────────────────
  console.log("1. a template no service points at fires for nobody");
  {
    const r = await startPeriodicRuns();
    if (r.started !== 0) fail(`opened ${r.started} run(s) with no service bound — it should be inert`);
    else ok("inert until a service points at it");
  }

  // Bind a service, and entitle exactly one client through a package.
  const svc = await prisma.serviceItem.create({ data: { name: `${TAG} service`, country: "SA", workflowId: tpl.id } as any });
  const pkg = await prisma.package.create({ data: { name: `${TAG} package`, tier: "probe", basePrice: 0, empMin: 0, empMax: 9999, features: [] as any, serviceIds: [svc.id] as any } as any });
  await prisma.subscription.create({ data: { scope: "company", refId: entitled.id, companyId: entitled.id, packageId: pkg.id, price: 0, daysLeft: 30 } as any });
  // The suspended client is entitled too — the point is that being suspended overrides it.
  await prisma.subscription.create({ data: { scope: "company", refId: suspended.id, companyId: suspended.id, packageId: pkg.id, price: 0, daysLeft: 30 } as any });

  // ── 1. one run for the entitled client ──────────────────────────────────────────────────────
  console.log("\n2. an entitled client gets exactly one run for the period");
  {
    const r = await startPeriodicRuns();
    const n = await countFor(entitled.id);
    if (n !== 1) fail(`expected exactly 1 run for the entitled client, found ${n}`);
    else ok(`one run opened (${r.details[0] ?? ""})`);
  }

  // ── 2. the same tick again opens nothing ────────────────────────────────────────────────────
  console.log("\n3. running the tick again opens nothing — the period is already open");
  {
    const r = await startPeriodicRuns();
    const n = await countFor(entitled.id);
    if (r.started !== 0) fail(`a second tick opened ${r.started} more run(s) — the period guard is not holding`);
    else if (n !== 1) fail(`the entitled client now has ${n} runs, expected 1`);
    else ok("second tick opened nothing; still one run");
  }
  console.log("   (and a third, because hourly means this happens all day)");
  {
    await startPeriodicRuns();
    const n = await countFor(entitled.id);
    if (n !== 1) fail(`after a third tick the client has ${n} runs, expected 1`);
    else ok("still one run");
  }

  // ── 3 and 4. everybody else is left alone ───────────────────────────────────────────────────
  console.log("\n4. nobody else is touched");
  {
    const nOut = await countFor(outsider.id);
    if (nOut !== 0) fail(`a client with no entitlement got ${nOut} run(s)`);
    else ok("a client with no entitlement got nothing");

    const nSusp = await countFor(suspended.id);
    if (nSusp !== 0) fail(`a suspended client got ${nSusp} run(s) despite being entitled`);
    else ok("a suspended client got nothing, though entitled");
  }

  // ── the run is real, and carries its period ─────────────────────────────────────────────────
  console.log("\n5. the run knows which period it is");
  {
    const inst = await prisma.workflowInstance.findFirst({ where: { companyId: entitled.id } });
    const vars: any = inst?.variables ?? {};
    const now = new Date();
    const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    if (vars.period !== expected) fail(`the run records period "${vars.period}", expected "${expected}"`);
    else ok(`period recorded as ${vars.period}`);
    if (!String(inst?.title ?? "").includes(expected)) fail(`the title does not carry the period: "${inst?.title}"`);
    else ok(`title carries it: "${inst?.title}"`);
    const step = await prisma.workflowTask.findFirst({ where: { instanceId: inst!.id, status: "active" } });
    if (!step) fail("the run opened with no active step");
    else ok(`opened at "${step.title}"`);
  }

  // ── an unbound period is inert rather than firing every hour ────────────────────────────────
  console.log("\n6. a recurring template with no period set is inert, not hourly");
  {
    await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { triggerConfig: {} as any } });
    const before = await countFor(entitled.id);
    const r = await startPeriodicRuns();
    const after = await countFor(entitled.id);
    if (r.started !== 0 || after !== before) fail(`a template with no period opened ${r.started} run(s)`);
    else ok("no period set -> nothing opened");
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
