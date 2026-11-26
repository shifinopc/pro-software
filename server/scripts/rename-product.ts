/**
 * RENAME A PRODUCT, AND CARRY IT TO THE CLIENTS WHO NAME IT.
 *
 * `Product` is a configuration row; `Company.service` is the free text the lead form writes — "pick
 * as many as apply, or type your own" — stored as a comma-separated list of product names. Two
 * stores of one fact, which is the shape the type-your-own contract forces, so renaming the row on
 * its own renames nothing anybody looks at: the Clients list, the Leads list and the product filter
 * are all built from the clients' own values.
 *
 * Measured the first time "Company Formation" became "Business Setup": the row changed, and 55
 * clients went on saying the old name. The console does this correctly through PUT /api/products —
 * this is the same call for a database where that rename was never made, so the two cannot drift.
 *
 * It is the token that moves, not the string: a client whose service reads "Auditing, Company
 * Formation" keeps Auditing, in place, and one that somehow names both old and new keeps one rather
 * than gaining a duplicate. renameProductEverywhere is the one implementation of that rule.
 *
 * Dry run by default — it prints every client it would touch. Pass --apply to write.
 *
 * Usage: npx tsx scripts/rename-product.ts "Company Formation" "Business Setup" [--apply]
 */
import { prisma } from "../src/db.js";
import { renameProductEverywhere } from "../src/productname.js";

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");
  const [from, to] = args;
  if (!from || !to) throw new Error('usage: rename-product.ts "<old name>" "<new name>" [--apply]');
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) throw new Error("those are the same name");

  const row = await prisma.product.findFirst({ where: { name: from } });
  const already = await prisma.product.findFirst({ where: { name: to } });
  if (!row && already) { console.log(`"${to}" already exists and "${from}" does not — nothing to rename`); }
  else if (!row) throw new Error(`no product called "${from}"`);
  // Refused, not merged: two products collapsing into one is a decision about what the firm sells,
  // and the clients naming each would silently become one group.
  if (row && already) throw new Error(`both "${from}" and "${to}" exist — merging two products is not this script's call`);

  const affected = await prisma.company.findMany({
    where: { service: { contains: from } },
    select: { id: true, name: true, service: true },
  });
  // `contains` is the coarse filter; the token check is what decides, so the count printed here is
  // an upper bound and the number written below is the real one.
  console.log(`product row : ${row ? `"${row.name}" → "${to}"` : "(already renamed)"}`);
  console.log(`clients named: ${affected.length} mention "${from}"`);
  for (const c of affected.slice(0, 12)) console.log(`   ${c.name}: "${c.service}"`);
  if (affected.length > 12) console.log(`   … and ${affected.length - 12} more`);

  if (!apply) { console.log("\n(dry run — pass --apply to write)"); return; }

  if (row) await prisma.product.update({ where: { id: row.id }, data: { name: to } });
  const moved = await renameProductEverywhere(from, to);
  console.log(`\nrenamed the product row and carried it to ${moved} client(s)`);

  const left = await prisma.company.count({ where: { service: { contains: from } } });
  console.log(left
    ? `NOTE: ${left} client(s) still contain "${from}" — a longer name that merely includes it keeps its own wording, which is the token rule working`
    : `no client still names "${from}"`);
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error("refused:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
