/**
 * One-off, idempotent: move client ownership out of a JSON array on the user and onto the client.
 *
 * WHAT WAS WRONG WITH WHERE IT WAS
 *
 * `User.assignedClientIds` is a JSON array, which means the question "who owns this client?" could
 * only be answered by loading every user and scanning their arrays — which is exactly what the
 * Clients list did, in the browser, to render one column. It cannot be joined, cannot be sorted,
 * cannot be grouped, and nothing stops two people holding the same client id.
 *
 * `Company.ownerId` is the same fact as a column: one row, one owner, joinable and reportable.
 *
 * CONFLICTS ARE REPORTED, NOT RESOLVED QUIETLY
 *
 * A client that appears in two people's arrays has no single answer, and inventing one silently is
 * how somebody later finds their client belongs to a colleague. Each conflict is printed with both
 * names; --apply takes the FIRST claimant by user id so a re-run is deterministic, and says so.
 *
 *   pnpm tsx scripts/migrate-ownership.ts          # report only
 *   pnpm tsx scripts/migrate-ownership.ts --apply
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const users = await prisma.user.findMany({
    where: { type: "staff" },
    select: { id: true, name: true, email: true, roleId: true, assignedClientIds: true },
    orderBy: { id: "asc" },
  });
  const companies = await prisma.company.findMany({ select: { id: true, name: true, ownerId: true } });
  const byId = new Map(companies.map(c => [c.id, c]));

  // companyId → the users claiming it, in a stable order.
  const claims = new Map<string, typeof users>();
  for (const u of users) {
    const ids = Array.isArray(u.assignedClientIds) ? (u.assignedClientIds as unknown[]).map(String) : [];
    for (const id of ids) {
      if (!byId.has(id)) continue; // an assignment pointing at a deleted client
      claims.set(id, [...(claims.get(id) ?? []), u]);
    }
  }

  const conflicts = [...claims.entries()].filter(([, us]) => us.length > 1);
  const already = companies.filter(c => c.ownerId);
  const toSet = [...claims.entries()].filter(([id]) => !byId.get(id)!.ownerId);
  const orphans = companies.filter(c => !c.ownerId && !claims.has(c.id));
  const stale = users.flatMap(u => {
    const ids = Array.isArray(u.assignedClientIds) ? (u.assignedClientIds as unknown[]).map(String) : [];
    return ids.filter(id => !byId.has(id)).map(id => `${u.name} → ${id}`);
  });

  console.log(`staff users: ${users.length} · companies: ${companies.length}`);
  console.log(`  already have an owner set:      ${already.length}`);
  console.log(`  ownership to migrate:           ${toSet.length}`);
  console.log(`  nobody claims them:             ${orphans.length}${orphans.length ? " — " + orphans.map(o => o.name).join(", ") : ""}`);
  console.log(`  assignments to deleted clients: ${stale.length}${stale.length ? " — " + stale.join(", ") : ""}`);

  if (conflicts.length) {
    console.log(`\n  ${conflicts.length} client(s) claimed by more than one person:`);
    for (const [id, us] of conflicts) {
      console.log(`    ${byId.get(id)!.name}: ${us.map(u => u.name).join(" AND ")} — taking ${us[0].name}`);
    }
  }

  for (const [id, us] of toSet) {
    const owner = us[0];
    console.log(`  ${APPLY ? "→" : "would"} ${byId.get(id)!.name} → ${owner.name}`);
    if (APPLY) await prisma.company.update({ where: { id }, data: { ownerId: owner.id } });
  }

  if (APPLY) {
    // Emptied, not dropped by this script: the column goes when the schema does, and leaving the
    // old values behind would give a future reader a second, stale answer to the same question.
    const cleared = await prisma.user.updateMany({ where: { type: "staff" }, data: { assignedClientIds: [] } });
    console.log(`\ncleared the old array on ${cleared.count} user(s) — Company.ownerId is now the only answer`);
  }

  console.log(APPLY ? "applied." : "\nnothing written — re-run with --apply");
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
