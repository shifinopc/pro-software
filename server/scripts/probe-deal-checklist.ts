/**
 * Throwaway check: a deal's checklist ticks itself where it can, and refuses the move where it must.
 *
 * THE TWO ASSERTIONS THAT MATTER MOST, because they are the ones a plausible-looking implementation
 * gets wrong:
 *
 *   1. A DOCUMENT ITEM IS DERIVED, NOT STORED. The fixture ticks nothing, creates the document, and
 *      expects the item to be satisfied — then EXPIRES the document and expects it to go back to
 *      outstanding without anybody touching the deal. A stored tick cannot do that, so this is the
 *      assertion that tells a derived list from a copied one.
 *   2. CONDITIONS ACTUALLY SELECT. Two deals sit in the same stage under the same rule and must get
 *      DIFFERENT lists. A rule engine that ignored conditions entirely would give both the union and
 *      still pass every other test here, so the lists are built to be visibly unequal.
 *
 * Everything is exercised through the modules the routes call, so no server needs to be running.
 *
 * Own stage, rule, companies, deals and documents. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { itemsForStage, statusFor, blockersFor, summaryFor, factsFor } from "../src/dealchecklist.js";

const MARK = "ZZ CHK";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: MARK } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.document.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.pipelineStage.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.checklistRule.deleteMany({ where: { name: { startsWith: MARK } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  const yn = (b: boolean) => (b ? "YES" : "NO");
  const labels = (rows: { label: string }[]) => rows.map(r => r.label).sort().join(", ") || "(none)";

  try {
    await sweep();

    // ── the rule: a base set everybody gets, plus one row that only big deals match ───────────────
    const rule = await prisma.checklistRule.create({
      data: {
        name: `${MARK} Before quoting`, country: "SA",
        rows: [
          {
            conditions: [],                                     // the base set
            documents: [
              { key: "cr_copy", label: "Commercial Register copy", required: true, source: "document", docType: "Commercial Register" },
              { key: "budget", label: "Budget confirmed", required: true, source: "manual" },
              { key: "nice", label: "Org chart (optional)", required: false, source: "manual" },
            ],
          },
          {
            // Only a deal over 50,000 asks for this. The small deal below must NOT get it.
            conditions: [{ var: "value", op: "gte", value: 50000 }],
            documents: [{ key: "board_ok", label: "Board approval", required: true, source: "manual" }],
          },
        ] as any,
      },
    });

    const stage = await prisma.pipelineStage.create({
      data: {
        name: `${MARK} Documents in`, country: "SA", sort: 990,
        checklistSource: "dynamic", checklistRuleId: rule.id,
      },
    });
    const nextStage = await prisma.pipelineStage.create({ data: { name: `${MARK} Quoted`, country: "SA", sort: 991 } });

    const bigCo = await prisma.company.create({ data: { name: `${MARK} Big Co`, lifecycle: "prospect", cr: "1112223330", country: "SA", employees: 80 } });
    const smallCo = await prisma.company.create({ data: { name: `${MARK} Small Co`, lifecycle: "prospect", cr: "1112223331", country: "SA", employees: 4 } });
    const mkDeal = (co: any, n: string, minor: number) => prisma.opportunity.create({
      data: {
        number: n, title: `${MARK} ${n}`, companyId: co.id, stageId: stage.id, country: "SA",
        valueMinor: minor, currency: "SAR", createdAt: new Date().toISOString(),
      },
      include: { stage: true },
    });
    const big = await mkDeal(bigCo, "ZZCHK-BIG", 9_000_000);     // SAR 90,000
    const small = await mkDeal(smallCo, "ZZCHK-SML", 500_000);   // SAR 5,000

    // ── 2. conditions select ──────────────────────────────────────────────────────────────────────
    const bigList = await itemsForStage(stage, big, bigCo);
    const smallList = await itemsForStage(stage, small, smallCo);
    console.log(`the big deal is asked for board approval: ${yn(bigList.some(i => i.key === "board_ok"))}`);
    if (!bigList.some(i => i.key === "board_ok")) fail("a condition that should have matched did not — the rule engine is not evaluating them");
    console.log(`  the small one is NOT:                  ${yn(!smallList.some(i => i.key === "board_ok"))}`);
    if (smallList.some(i => i.key === "board_ok")) fail("both deals got the same list — conditions are being ignored");
    console.log(`  so the two lists differ:               ${yn(labels(bigList) !== labels(smallList))}`);
    if (labels(bigList) === labels(smallList)) fail("this fixture cannot tell a conditional engine from an unconditional one");
    console.log(`  facts read real columns:               ${yn(factsFor(big, bigCo).employees === 80 && factsFor(big, bigCo).value === 90000)}`);
    // Every printed check below asserts. A line that can print NO while the probe reports success
    // teaches people to skim the output, which is how a real failure gets read as noise.
    if (factsFor(big, bigCo).employees !== 80 || factsFor(big, bigCo).value !== 90000) fail("the facts a rule conditions on disagree with the record they came from");

    // ── the live fallback: nothing was snapshotted, so the stage's list applies now ───────────────
    console.log(`\na deal with no snapshot still has a list:${yn((await statusFor(big, bigCo, stage)).length === 4)}`);
    if ((await statusFor(big, bigCo, stage)).length !== 4) fail("configuring a stage's checklist had no effect on a deal already sitting in it");

    // ── 1. THE DOCUMENT ITEM IS DERIVED ───────────────────────────────────────────────────────────
    const before = await statusFor(big, bigCo, stage);
    console.log(`\nthe CR item starts outstanding:          ${yn(!before.find(i => i.key === "cr_copy")!.done)}`);
    if (before.find(i => i.key === "cr_copy")!.done) fail("the CR item was satisfied before any document existed");
    const doc = await prisma.document.create({
      data: { companyId: bigCo.id, person: bigCo.name, docType: "Commercial Register", status: "valid", docNumber: "CR-99", expiryDate: "2027-01-01" },
    });
    const after = await statusFor(big, bigCo, stage);
    const cr = after.find(i => i.key === "cr_copy")!;
    console.log(`  …and ticks ITSELF once the doc exists: ${yn(cr.done && cr.how === "document")}`);
    if (!cr.done) fail("a document item did not satisfy from the document that exists — the list is not derived");
    if (cr.how !== "document") fail("a document item reported as if a person had ticked it");
    console.log(`  naming what satisfied it:              ${yn(!!cr.evidence && cr.evidence.includes("CR-99"))}`);
    if (!cr.evidence || !cr.evidence.includes("CR-99")) fail("a satisfied document item does not say WHICH document satisfied it");
    // Nothing was written to the deal. A stored tick is exactly what this design refuses.
    const fresh = await prisma.opportunity.findUniqueOrThrow({ where: { id: big.id } });
    const stored = (fresh.checklistState && typeof fresh.checklistState === "object") ? Object.keys(fresh.checklistState as any) : [];
    console.log(`  and NOTHING was stored for it:         ${yn(!stored.includes("cr_copy"))}`);
    if (stored.includes("cr_copy")) fail("a document tick was persisted — it can now disagree with the documents themselves");

    // …and it goes back on its own when the document stops being valid.
    await prisma.document.update({ where: { id: doc.id }, data: { status: "expired" } });
    const expired = (await statusFor(big, bigCo, stage)).find(i => i.key === "cr_copy")!;
    console.log(`  an EXPIRED document unticks it:        ${yn(!expired.done)}`);
    if (expired.done) fail("an expired document still satisfies the requirement — a stored tick could not have unticked itself, so this is the assertion that proves derivation");
    await prisma.document.update({ where: { id: doc.id }, data: { status: "valid" } });

    // ── blocking ──────────────────────────────────────────────────────────────────────────────────
    const blocked = await blockersFor(big, bigCo, stage);
    console.log(`\nthe outstanding required items block:    ${yn(blocked.length === 2)} (${labels(blocked)})`);
    if (blocked.length !== 2) fail(`expected budget + board approval outstanding, got ${labels(blocked)}`);
    console.log(`  the OPTIONAL one never blocks:         ${yn(!blocked.some(i => i.key === "nice"))}`);
    if (blocked.some(i => i.key === "nice")) fail("an optional item blocked the move");

    // ── manual ticks ARE stored ───────────────────────────────────────────────────────────────────
    const ticked = await prisma.opportunity.update({
      where: { id: big.id },
      data: { checklistState: { budget: { done: true, at: new Date().toISOString(), by: "ZZ Tester" } } as any },
      include: { stage: true },
    });
    const afterTick = (await statusFor(ticked, bigCo, stage)).find(i => i.key === "budget")!;
    console.log(`\na manual tick is stored and reported:    ${yn(afterTick.done && afterTick.how === "manual")}`);
    if (afterTick.how !== "manual") fail("a manual tick was not attributed to a person");

    // ── the waiver ────────────────────────────────────────────────────────────────────────────────
    const waived = await prisma.opportunity.update({
      where: { id: big.id },
      data: { checklistWaived: { board_ok: { reason: "Owner-managed, no board", at: new Date().toISOString(), by: "ZZ Admin" } } as any },
      include: { stage: true },
    });
    const wItem = (await statusFor(waived, bigCo, stage)).find(i => i.key === "board_ok")!;
    console.log(`\na waiver satisfies the item:            ${yn(wItem.done)}`);
    console.log(`  …but is reported as WAIVED, not done: ${yn(wItem.how === "waived")}`);
    if (wItem.how !== "waived") fail("a waived item is indistinguishable from one that was actually satisfied");
    console.log(`  carrying the reason:                   ${yn(!!wItem.evidence && wItem.evidence.includes("no board"))}`);
    if (!wItem.evidence || !wItem.evidence.includes("no board")) fail("a waiver lost the reason it was granted for");
    const nowClear = await blockersFor(waived, bigCo, stage);
    console.log(`  nothing blocks any more:               ${yn(nowClear.length === 0)} (${labels(nowClear)})`);
    if (nowClear.length) fail("the deal is still blocked after every item was satisfied or waived");

    // Asserted BEFORE the rule edit below. This deal has no snapshot, so it resolves the rule LIVE —
    // measuring it afterwards measured a different list and printed a baffling "0 of 1".
    const sum = await summaryFor(waived, bigCo, stage);
    console.log(`\nthe card summary counts correctly:       ${yn(sum.requiredDone === sum.requiredTotal && !sum.blocked)} (${sum.done} of ${sum.total})`);
    if (sum.blocked || sum.requiredDone !== sum.requiredTotal) fail(`the summary disagrees with the blockers — ${sum.requiredDone} of ${sum.requiredTotal} required done, blocked=${sum.blocked}`);

    // ── the snapshot does not follow later edits ──────────────────────────────────────────────────
    const snapped = await prisma.opportunity.update({
      where: { id: small.id },
      data: { checklist: (await itemsForStage(stage, small, smallCo)) as any },
      include: { stage: true },
    });
    const snapCount = (await statusFor(snapped, smallCo, stage)).length;
    await prisma.checklistRule.update({
      where: { id: rule.id },
      data: { rows: [{ conditions: [], documents: [{ key: "brand_new", label: "Added after the fact", required: true, source: "manual" }] }] as any },
    });
    const afterEdit = await statusFor(await prisma.opportunity.findUniqueOrThrow({ where: { id: small.id }, include: { stage: true } }), smallCo, stage);
    console.log(`\nediting the rule leaves a snapshot alone:${yn(afterEdit.length === snapCount && !afterEdit.some(i => i.key === "brand_new"))}`);
    if (afterEdit.some(i => i.key === "brand_new")) fail("a rule edit rewrote what a deal in flight had already been asked for");
    if (afterEdit.length !== snapCount) fail("the snapshotted list changed length after the rule was edited");

  } finally {
    await sweep();
  }

  const left = (await prisma.company.count({ where: { name: { startsWith: MARK } } }))
    + (await prisma.pipelineStage.count({ where: { name: { startsWith: MARK } } }))
    + (await prisma.checklistRule.count({ where: { name: { startsWith: MARK } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
