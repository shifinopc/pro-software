/**
 * Throwaway check: only people who can carry a book are offered as an account manager.
 *
 * The console's owner picker listed EVERY active member of staff, which contradicted assignment.ts —
 * auto-assignment only ever hands a client to a `sales` user. A lead parked on the accountant looked
 * owned, sat in no salesperson's book, and sent its chasing to somebody who was never going to make
 * the call. Two lists, two answers. This asserts there is now one.
 *
 * What is asserted:
 *   - sales and admins are offered; accountants and PRO officers are not
 *   - inactive and portal users are never offered
 *   - the rotation stays NARROWER than the manual list — an admin may be chosen but never auto-given
 *   - somebody already on a record stays visible even when their role no longer qualifies, so opening
 *     the record cannot silently drop its current manager
 *   - load is real and excludes lost/churned, matching the rotation's own definition
 *
 * Own users, own company. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { assignableOwners, OWNER_ROLES, rotation } from "../src/assignment.js";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  if (cos.length) {
    await prisma.contact.deleteMany({ where: { companyId: { in: cos.map(c => c.id) } } });
    await prisma.company.deleteMany({ where: { id: { in: cos.map(c => c.id) } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    const mk = (name: string, roleId: string, status = "active", type = "staff") =>
      prisma.user.create({ data: { name, email: `zz-${name.toLowerCase().replace(/\W+/g, "-")}@example.invalid`, roleId, status, type } });

    const seller = await mk("ZZ Seller", "sales");
    const admin = await mk("ZZ Admin", "admin");
    const acct = await mk("ZZ Accountant", "accountant");
    const officer = await mk("ZZ Officer", "pro_officer");
    const gone = await mk("ZZ Departed", "sales", "inactive");
    const portal = await mk("ZZ Portal", "client_admin", "active", "portal");

    const list = await assignableOwners();
    const has = (id: string) => list.some(u => u.id === id);

    console.log(`offered: ${list.filter(u => u.name.startsWith("ZZ ")).map(u => `${u.name} (${u.roleId})`).join(", ") || "none"}`);
    console.log(`  a sales user is offered:               ${has(seller.id) ? "YES" : "NO"}`);
    if (!has(seller.id)) fail("the one role the scoping is built around is not offerable");
    console.log(`  an admin is offered:                   ${has(admin.id) ? "YES" : "NO"}`);
    if (!has(admin.id)) fail("admins cannot be chosen, but they genuinely carry accounts in a firm this size");
    console.log(`  an accountant is NOT offered:          ${!has(acct.id) ? "YES" : "NO"}`);
    if (has(acct.id)) fail("an accountant can still be made an account manager — the original bug");
    console.log(`  a PRO officer is NOT offered:          ${!has(officer.id) ? "YES" : "NO"}`);
    if (has(officer.id)) fail("a PRO officer can still be made an account manager");
    console.log(`  an inactive user is NOT offered:       ${!has(gone.id) ? "YES" : "NO"}`);
    if (has(gone.id)) fail("somebody who has left is offered as a manager");
    console.log(`  a portal user is NOT offered:          ${!has(portal.id) ? "YES" : "NO"}`);
    if (has(portal.id)) fail("a CLIENT was offered as a manager of clients");

    // ── the rotation must stay narrower than the manual list ──────────────────────────────────
    const rot = await rotation();
    console.log(`\nrotation is narrower than the picker:    auto=${rot.filter(r => r.name.startsWith("ZZ ")).map(r => r.name).join(",") || "none"}`);
    if (rot.some(r => r.id === admin.id)) fail("auto-assignment would drop clients on an admin — the thing assignment.ts refuses to do");
    if (!rot.some(r => r.id === seller.id)) fail("auto-assignment cannot see the sales user");
    console.log(`  OWNER_ROLES is a superset of selling:  ${OWNER_ROLES.includes("sales") ? "YES" : "NO"}`);
    if (!OWNER_ROLES.includes("sales")) fail("the manual list excludes the role auto-assignment uses — they would disagree again");

    // ── an existing manager stays visible ─────────────────────────────────────────────────────
    // The accountant is deliberately used here: somebody assigned before the rule existed.
    await prisma.company.create({ data: { name: "ZZ Legacy Co", cr: "9992220001", lifecycle: "client", ownerId: acct.id } });
    const withInclude = await assignableOwners(acct.id);
    const row = withInclude.find(u => u.id === acct.id);
    console.log(`\nan existing manager stays visible:       ${row ? "YES" : "NO"}`);
    if (!row) fail("the current manager vanishes from their own record's picker — the next person to open it would 'fix' it by accident");
    console.log(`  …and is marked as no longer eligible:  ${row?.eligible === false ? "YES" : "NO"}`);
    if (row?.eligible !== false) fail("nothing on screen says this person should not be picked again");
    console.log(`  without include they are gone again:   ${!(await assignableOwners()).some(u => u.id === acct.id) ? "YES" : "NO"}`);

    // ── load is real ──────────────────────────────────────────────────────────────────────────
    await prisma.company.create({ data: { name: "ZZ Live One", cr: "9992220002", lifecycle: "client", ownerId: seller.id } });
    await prisma.company.create({ data: { name: "ZZ Lost One", cr: "9992220003", lifecycle: "lost", ownerId: seller.id } });
    const loaded = (await assignableOwners()).find(u => u.id === seller.id);
    console.log(`\nload counts live work only:              ${loaded?.load} (1 live + 1 lost)`);
    if (loaded?.load !== 1) fail(`a lost client is being counted as load (got ${loaded?.load})`);

  } finally {
    await sweep();
  }

  const left =
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
