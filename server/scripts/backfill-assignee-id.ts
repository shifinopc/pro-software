/**
 * One-off: give existing tasks an `assigneeId` to match the name they already carry.
 *
 * Every task written before this held only a display name, so none of them could be turned into a
 * mailbox. This resolves what it safely can and REPORTS what it cannot, rather than guessing.
 *
 * The rule is the same one `resolveStaffByName` uses: exactly one active staff member with that
 * name, or nothing. Two people called Ahmed would otherwise mean one of them starts receiving the
 * other's work — a wrong id is far worse than a null one, because a null falls back to the admins
 * and is visible, while a wrong one silently misroutes forever.
 *
 * Idempotent: only rows with a name and no id are touched. Run it as often as you like.
 *
 *   npx tsx scripts/backfill-assignee-id.ts          # report only
 *   npx tsx scripts/backfill-assignee-id.ts --apply  # write
 */
import { prisma } from "../src/db.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const staff = await prisma.user.findMany({ where: { type: "staff", status: "active" }, select: { id: true, name: true } });
  const byName = new Map<string, string[]>();
  for (const u of staff) {
    if (!u.name) continue;
    if (!byName.has(u.name)) byName.set(u.name, []);
    byName.get(u.name)!.push(u.id);
  }
  const ambiguous = [...byName.entries()].filter(([, ids]) => ids.length > 1).map(([n]) => n);
  if (ambiguous.length) console.log(`names held by more than one active staff member (left unresolved): ${ambiguous.join(", ")}`);

  const resolve = (name: string | null) => {
    const n = String(name ?? "").trim();
    if (!n || n === "Unassigned") return null;
    const ids = byName.get(n);
    return ids && ids.length === 1 ? ids[0] : null;
  };

  for (const [label, rows] of [
    ["workflow steps", await prisma.workflowTask.findMany({ where: { assigneeId: null, NOT: { assignee: null } }, select: { id: true, assignee: true } })],
    ["tasks", await prisma.task.findMany({ where: { assigneeId: null, NOT: { assignee: null } }, select: { id: true, assignee: true } })],
  ] as const) {
    let matched = 0;
    const unmatched = new Map<string, number>();
    for (const r of rows) {
      const id = resolve(r.assignee);
      if (!id) {
        const key = String(r.assignee ?? "(blank)");
        unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
        continue;
      }
      matched++;
      if (APPLY) {
        if (label === "workflow steps") await prisma.workflowTask.update({ where: { id: r.id }, data: { assigneeId: id } });
        else await prisma.task.update({ where: { id: r.id }, data: { assigneeId: id } });
      }
    }
    console.log(`\n${label}: ${rows.length} with a name and no id · ${matched} resolved${APPLY ? " (written)" : " (dry run)"}`);
    if (unmatched.size) {
      console.log(`  left null — these fall back to the admins, which is visible rather than wrong:`);
      for (const [name, n] of [...unmatched.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${n.toString().padStart(4)} × ${name}`);
    }
  }

  if (!APPLY) console.log(`\nnothing written. Re-run with --apply to write.`);
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
