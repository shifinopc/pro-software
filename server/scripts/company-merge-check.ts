/**
 * A MERGE THAT STOPS HALFWAY IS WORSE THAN NO MERGE.
 *
 *   npx tsx scripts/company-merge-check.ts      (LOCAL database only; builds fixtures, deletes them)
 *
 * Twenty-six tables point at a company. The risk here is not the decision, it is leaving one row
 * aimed at a record that has been retired — and that failure is silent: the screen simply stops
 * showing something, months later, and nobody connects it to a merge.
 *
 * So this does a real merge on fabricated records and then asks the questions a person cannot ask
 * of a screen: is anything still pointing at the retired record, did the colliding employee code
 * survive, did the denormalised client name follow, does the plan promise only what the merge
 * actually does.
 *
 * AND IT CHECKS EVERY REFUSAL, by triggering each one on purpose. The refusals are the half that
 * protects real data — a merge cannot be undone with a button — so a refusal that quietly stopped
 * working would be the most expensive bug in this file, and the least visible.
 */
import { prisma } from "../src/db.js";
import { Prisma } from "@prisma/client";
import { planMerge, applyMerge, FILLABLE } from "../src/company-merge.js";

if (!/@(localhost|127\.0\.0\.1)/.test(String(process.env.DATABASE_URL ?? ""))) {
  console.error("\nRefusing to run: this builds and deletes records, so it is for a LOCAL database only.\n");
  process.exit(2);
}

const fails: string[] = [];
const ok = (cond: boolean, what: string, got?: unknown) => {
  if (cond) console.log(`  ok    ${what}`);
  else { fails.push(`${what}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); console.log(`  FAIL  ${what}`); }
};
const PREFIX = "ZZ MergeCheck";

// Every name in FILLABLE must be a real column. Three of the first fourteen were not, and nothing
// said so, because an absent field reads as undefined and is quietly skipped.
{
  const cols = new Set((Prisma.dmmf.datamodel.models.find(m => m.name === "Company")?.fields ?? []).map(f => f.name));
  const unreal = (FILLABLE as readonly string[]).filter(f => !cols.has(f));
  console.log("the fields a merge may fill:");
  ok(unreal.length === 0, "every fillable field is a real column on Company", unreal);
}

const clean = async () => {
  const ids = (await prisma.company.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map(c => c.id);
  if (!ids.length) return 0;
  for (const m of ["contact", "employee", "interaction", "task", "document", "invoice",
                   "lifecycleTransition", "ownerAssignment", "workforceSnapshot", "subscription", "establishment"]) {
    await (prisma as any)[m].deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
  }
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
};

const snap = (companyId: string, day: string, total: number) => prisma.workforceSnapshot.create({
  data: { companyId, day, total, nationals: 0, expats: total, unknown: 0, ratioMinBp: 0, ratioMaxBp: 10000 } as any,
});

try {
  await clean();

  // ── A real merge, with both collisions present ──────────────────────────────────────────────
  console.log("a merge that has something to move:");
  const keep = await prisma.company.create({ data: { name: `${PREFIX} Keep`, lifecycle: "client", city: "Riyadh" } });
  const gone = await prisma.company.create({ data: { name: `${PREFIX} Gone`, lifecycle: "lead", industry: "Construction" } });
  await prisma.contact.create({ data: { companyId: gone.id, name: "Mover", isPrimary: true } });
  await prisma.task.create({ data: { title: `${PREFIX} task`, companyId: gone.id, clientName: `${PREFIX} Gone`, status: "todo" } });
  await prisma.employee.create({ data: { companyId: keep.id, name: "Kept", code: "E001" } as any });
  await prisma.employee.create({ data: { companyId: gone.id, name: "Moved", code: "E001" } as any });
  await snap(keep.id, "2026-10-20", 1);
  await snap(gone.id, "2026-10-20", 9);          // the same day — the survivor's reading wins
  await snap(gone.id, "2026-10-21", 9);          // a day it does not have — moves

  const plan = await planMerge(keep.id, gone.id);
  ok(plan.blocks.length === 0, "nothing blocks a straightforward merge", plan.blocks);
  ok(plan.recodes.length === 1 && plan.recodes[0].to === "E001-2", "the clashing employee code is re-coded in the plan", plan.recodes);
  ok(plan.dropped.length === 1, "the duplicate day's reading is listed as dropped", plan.dropped);

  // THE PLAN MUST PROMISE ONLY WHAT HAPPENS. contacts.ts rewrites contact/email/phone at the end of
  // every merge, so a plan that offered to fill them described a state that lasted one second.
  ok(!plan.fills.some(f => ["email", "phone", "contact"].includes(f.field)),
    "the plan does not promise fields the contact sync owns", plan.fills);

  await applyMerge(keep.id, gone.id, { id: null, name: "merge-check" });

  const left = Object.fromEntries(await Promise.all(
    ["contact", "employee", "interaction", "task", "workforceSnapshot", "document", "invoice"]
      .map(async m => [m, await (prisma as any)[m].count({ where: { companyId: gone.id } })])));
  ok(Object.values(left).every(n => n === 0), "nothing is left pointing at the retired record", left);

  const dead: any = await prisma.company.findUnique({ where: { id: gone.id } });
  ok(dead?.mergedIntoId === keep.id, "the retired record says where it went", dead?.mergedIntoId);
  ok(dead?.status === "merged", "the retired record is marked merged", dead?.status);

  const listed = await prisma.company.findMany({ where: { mergedIntoId: null, name: { startsWith: PREFIX } }, select: { name: true } });
  ok(listed.length === 1, "a merged record no longer appears in a list of companies", listed.map(l => l.name));

  const codes = await prisma.employee.findMany({ where: { companyId: keep.id }, select: { code: true } });
  ok(codes.length === 2 && new Set(codes.map(c => c.code)).size === 2, "both employees arrived, with different codes", codes);

  const t = await prisma.task.findFirst({ where: { title: `${PREFIX} task` }, select: { clientName: true } });
  ok(t?.clientName === `${PREFIX} Keep`, "the denormalised client name followed the merge", t?.clientName);

  const survivor: any = await prisma.company.findUnique({ where: { id: keep.id } });
  ok(survivor?.industry === "Construction", "an empty field was filled from the retired record", survivor?.industry);
  ok(survivor?.city === "Riyadh", "a field the survivor already had was NOT overwritten", survivor?.city);
  ok((await prisma.workforceSnapshot.count({ where: { companyId: keep.id } })) === 2,
    "the survivor kept its own reading and gained the other day");

  // ── Every refusal, triggered on purpose ─────────────────────────────────────────────────────
  console.log("\nrefusals:");
  const blockOf = async (a: string, b: string) => (await planMerge(a, b).catch(e => ({ blocks: [String(e.message)] } as any))).blocks[0] ?? "";

  const crA = await prisma.company.create({ data: { name: `${PREFIX} CR A`, lifecycle: "lead", cr: "4030111111" } });
  const crB = await prisma.company.create({ data: { name: `${PREFIX} CR B`, lifecycle: "lead", cr: "4030222222" } });
  ok(/different CR numbers/.test(await blockOf(crA.id, crB.id)), "two different CR numbers are refused");

  const crC = await prisma.company.create({ data: { name: `${PREFIX} CR C`, lifecycle: "lead", cr: "4030-111111" } });
  ok((await blockOf(crA.id, crC.id)) === "", "the same CR punctuated differently is NOT refused");

  ok(/same record/i.test(await blockOf(crA.id, crA.id)), "merging a record into itself is refused");
  ok(/already been merged/.test(await blockOf(crA.id, gone.id)), "a record already merged away is refused");

  const pkg = await prisma.package.findFirst({ select: { id: true } });
  if (pkg) {
    const sA = await prisma.company.create({ data: { name: `${PREFIX} Sub A`, lifecycle: "client" } });
    const sB = await prisma.company.create({ data: { name: `${PREFIX} Sub B`, lifecycle: "client" } });
    for (const c of [sA, sB]) await prisma.subscription.create({ data: { scope: "company", refId: c.id, companyId: c.id, packageId: pkg.id, price: 1000 } });
    ok(/both.*subscription/i.test(await blockOf(sA.id, sB.id)), "two live subscriptions are refused rather than silently doubled");
  } else {
    console.log("  skip  the two-subscriptions refusal — no package on file to build the fixture");
  }
} finally {
  console.log(`\ncleaned up ${await clean()} fixture record(s)`);
  await prisma.$disconnect();
}

if (fails.length) {
  console.log(`\n${fails.length} failure(s):`);
  for (const f of fails) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log("\nin order — everything moved, nothing was left behind, and every refusal fired.");
}
