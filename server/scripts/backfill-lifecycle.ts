/**
 * THE LEADS THAT WERE ALREADY PAST BEING LEADS.
 *
 * Two rules decide the lifecycle ladder, and both were added as HOOKS: promoteOnDeal lifts a lead to
 * prospect when a deal is opened on them, and promoteOnInvoice lifts a prospect to client when a
 * quotation is invoiced. A hook only fires on the next event, so neither has ever looked at the
 * records that passed that point before the hook existed — a lead with a deal in Quoted since last
 * month is still filed under Lead, and the Leads list says so on every row.
 *
 * Measured on live when this was written: 180 leads, of which 21 were holding an open deal, and one
 * lead or prospect already had an invoice raised against them.
 *
 * It calls the SAME two functions the hooks call rather than writing lifecycle itself. They are the
 * one place the rule lives — they refuse anything that is not a lead or prospect, they write the
 * lifecycle history row, and promoteOnInvoice also sets crPending for a company that has no CR. A
 * second implementation here would be a second definition of what a prospect is.
 *
 * Won and Lost deals do not count as open: a lost deal is evidence the lead did NOT progress, and
 * promoting on it would file a dead lead as a live prospect.
 *
 * Dry run by default. Pass --apply to write.
 *   npx tsx scripts/backfill-lifecycle.ts [--apply]
 */
import { prisma } from "../src/db.js";
import { promoteOnDeal, promoteOnInvoice } from "../src/pipeline.js";

const CLOSED = ["won", "lost", "closed won", "closed lost", "closed"];

async function main() {
  const apply = process.argv.includes("--apply");

  // → prospect: a lead with a deal that is still live.
  const leads = await prisma.company.findMany({
    where: { lifecycle: "lead" },
    select: { id: true, name: true, lifecycle: true, opportunities: { select: { stage: { select: { name: true } } } } },
  });
  const toProspect = leads.filter(c =>
    c.opportunities.some(o => !CLOSED.includes(String(o.stage?.name ?? "").trim().toLowerCase())));

  // → client: anybody not yet a client who has been invoiced. Checked second, because a lead with
  // both a deal and an invoice should land on client rather than stopping at prospect.
  const notClients = await prisma.company.findMany({
    where: { lifecycle: { in: ["lead", "prospect"] } },
    select: { id: true, name: true, lifecycle: true, invoices: { select: { id: true }, take: 1 } },
  });
  const toClient = notClients.filter(c => c.invoices.length > 0);

  console.log(`→ prospect (lead holding an open deal): ${toProspect.length}`);
  for (const c of toProspect.slice(0, 15)) console.log(`     ${c.name}`);
  if (toProspect.length > 15) console.log(`     … and ${toProspect.length - 15} more`);
  console.log(`→ client (already invoiced): ${toClient.length}`);
  for (const c of toClient) console.log(`     ${c.name} (${c.lifecycle})`);

  if (!apply) { console.log("\n(dry run — pass --apply to write)"); return; }

  let prospects = 0, clients = 0;
  for (const c of toProspect) if (await promoteOnDeal({ id: c.id, lifecycle: c.lifecycle })) prospects++;
  // Re-read: one of these may just have become a prospect above, and promoteOnInvoice reads the
  // stored lifecycle rather than trusting what this script remembers.
  for (const c of toClient) if (await promoteOnInvoice(c.id)) clients++;

  console.log(`\npromoted ${prospects} to prospect and ${clients} to client`);
  const after = await prisma.company.groupBy({ by: ["lifecycle"], _count: { _all: true } });
  console.log("lifecycle now:", after.map(r => `${r.lifecycle}=${r._count._all}`).join("  "));
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
