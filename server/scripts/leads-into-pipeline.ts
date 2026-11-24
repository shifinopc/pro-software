/**
 * THE LEADS THAT NEVER GOT A CARD.
 *
 *   npx tsx scripts/leads-into-pipeline.ts            say how many, change nothing
 *   npx tsx scripts/leads-into-pipeline.ts --apply    raise their deals
 *
 * From now on every lead enters the pipeline as it is captured (`ensureLeadDeal`, called by the
 * create route and the web intake), so the stage is the lead's status. This is the backfill for
 * the ones captured before that rule existed — on this database, 157 of 183.
 *
 * DELIBERATELY NOT RUN BY THE DEPLOY. It puts a card on the board for every open lead, which is
 * the point and is also a visible change to a screen the sales team uses every day. Somebody
 * should choose the moment, and should look at the dry run first.
 *
 * Raised with no value, in the first open stage, owned by whoever owns the lead — see
 * ensureLeadDeal. Reruns are free: a lead that already has any deal is skipped.
 */
import { prisma } from "../src/db.js";
import { ensureLeadDeal } from "../src/pipeline.js";

const APPLY = process.argv.includes("--apply");

(async () => {
  const leads = await prisma.company.findMany({
    where: { lifecycle: { in: ["lead", "prospect"] } },
    select: { id: true, name: true, country: true },
    orderBy: { name: "asc" },
  });
  const withDeal = new Set((await prisma.opportunity.findMany({
    where: { companyId: { in: leads.map(l => l.id) } }, select: { companyId: true },
  })).map(o => o.companyId));
  const missing = leads.filter(l => !withDeal.has(l.id));

  console.log(`${leads.length} open lead(s) and prospect(s); ${withDeal.size} already on the board; ${missing.length} without a card.`);
  if (!missing.length) { await prisma.$disconnect(); return; }

  if (!APPLY) {
    for (const l of missing.slice(0, 10)) console.log(`    ${l.name}`);
    if (missing.length > 10) console.log(`    …and ${missing.length - 10} more`);
    console.log("\nNothing was changed. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }

  let made = 0;
  const skipped: string[] = [];
  for (const l of missing) {
    // One at a time rather than a createMany: each needs its number, its country's stage and its
    // StageTransition row, and a card without the transition is a deal with no history.
    const id = await ensureLeadDeal(l.id);
    if (id) made++;
    else skipped.push(`${l.name}${l.country ? ` (${l.country})` : " (no country)"}`);
  }
  console.log(`\nRaised ${made} card(s).`);
  if (skipped.length) {
    // Almost always a country with no stages configured. Named rather than counted: "12 skipped"
    // is a number nobody can act on.
    console.log(`${skipped.length} could not be raised — no open pipeline stage for their country:`);
    for (const s of skipped.slice(0, 15)) console.log(`    ${s}`);
    if (skipped.length > 15) console.log(`    …and ${skipped.length - 15} more`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(String(e?.message ?? e)); await prisma.$disconnect(); process.exit(1); });
