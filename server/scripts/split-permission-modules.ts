/**
 * Carry the saved permission grid across the module split.
 *
 * Every tick an admin has made is stored in AppSetting "perms" under a key of
 * `Role|Module|Action` — "Accountant|Finance|Create". Three of those module names no longer exist,
 * so without this every one of those ticks would simply stop matching anything and the role would
 * silently fall back to its preset. Somebody's deliberate decision would be undone by a rename.
 *
 * So each saved parent tick is written onto the children it became, and the parent key is left
 * behind untouched: it costs nothing, it is the only record of what was configured before, and if
 * this ever has to be reversed the original is still there.
 *
 * Idempotent. A child that already has its own explicit tick is never overwritten — an admin who
 * has since made a finer decision outranks what the parent used to say — so running this twice,
 * or after someone has started using the new grid, changes nothing the second time.
 *
 *   npx tsx scripts/split-permission-modules.ts          # report only
 *   npx tsx scripts/split-permission-modules.ts --apply  # write
 */
import { prisma } from "../src/db.js";
import { SPLIT_PARENTS } from "../src/permissions.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  const row = await prisma.appSetting.findUnique({ where: { key: "perms" } });
  const grid = (row?.value && typeof row.value === "object" && !Array.isArray(row.value))
    ? { ...(row.value as Record<string, boolean>) }
    : {};

  const before = Object.keys(grid).length;
  const added: string[] = [];
  const kept: string[] = [];

  for (const key of Object.keys(grid)) {
    const parts = key.split("|");
    if (parts.length !== 3) continue;                      // not a grid key; leave it alone
    const [role, mod, action] = parts;
    const children = SPLIT_PARENTS[mod];
    if (!children) continue;
    for (const child of children) {
      const childKey = `${role}|${child}|${action}`;
      if (childKey in grid) { kept.push(childKey); continue; }   // a finer decision already exists
      grid[childKey] = grid[key];
      added.push(`${childKey} = ${grid[key]}`);
    }
  }

  console.log(`saved grid: ${before} keys`);
  console.log(`would add:  ${added.length}`);
  for (const a of added) console.log("   +", a);
  if (kept.length) console.log(`left alone (already set finer): ${kept.length}`);

  if (!added.length) { console.log("\nnothing to carry across — the grid is already split."); return; }
  if (!APPLY) { console.log("\nreport only. Re-run with --apply to write."); return; }

  await prisma.appSetting.upsert({
    where: { key: "perms" },
    update: { value: grid },
    create: { key: "perms", value: grid },
  });
  console.log(`\nwritten: ${before} keys -> ${Object.keys(grid).length}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
