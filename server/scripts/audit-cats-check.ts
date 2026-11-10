/**
 * THE AUDIT FILTER'S SQL AND ITS LABEL MUST AGREE.
 *
 *   npx tsx scripts/audit-cats-check.ts
 *
 * The Audit screen pages on the server, so each filter chip is a SQL predicate; each row also
 * arrives carrying the category it is shown under. Both come from src/audit-cats.ts, which is the
 * point — but "they come from the same file" is a claim, and this is the test of it.
 *
 * Run against the real table rather than a handful of invented actions: the rules are prefix
 * matches, and what actually breaks them is a new action name nobody thought about. `cron.*` is
 * 2,700 of the rows here and belongs to no rule at all, which is exactly the case "System" exists
 * to catch.
 *
 * Three properties, and each fails differently:
 *
 *   · every category's SQL count equals the number of rows the labeller puts in it — a disagreement
 *     means a row is filed under one category and filtered under another
 *   · the categories sum to the whole table — no row in two of them, no row in none
 *   · "All" is the whole table — the unfiltered view is not quietly dropping anything
 *
 * The third also guards the thing that started this: the route used to answer `take: 200`, so the
 * screen's "total" was a cap wearing a total's clothes.
 */
import { prisma } from "../src/db.js";
import { auditCatOf, auditWhereFor, auditMatches, AUDIT_CAT_NAMES } from "../src/audit-cats.js";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

console.log("the rules, on names that are easy to get wrong:");
// Precedence, stated as a case rather than as a comment. `user.login_as` satisfies BOTH the Users
// rule and the Auth rule; filing it under Users would hide an account takeover among profile edits.
ok(auditCatOf("user.login_as") === "Auth", "user.login_as is Auth, not Users — precedence holds");
ok(auditCatOf("login.fail") === "Auth", "login.fail is Auth");
ok(auditCatOf("user.invite") === "Users", "user.invite is Users");
ok(auditCatOf("settings.update") === "Roles", "settings.update is Roles");
ok(auditCatOf("credential.reveal") === "Credentials", "credential.reveal is Credentials");
ok(auditCatOf("workflow.task_complete") === "Workflow", "workflow.task_complete is Workflow");
ok(auditCatOf("cron.follow_ups") === "System", "cron.follow_ups falls through to System");
ok(auditCatOf("") === "System", "an empty action does not throw, it is System");
// The in-memory evaluator is what makes one definition serve both; if it stopped understanding a
// filter shape it would silently return true and label everything Auth.
ok(auditMatches({ OR: [{ action: { startsWith: "x" } }] }, "xy"), "OR is understood");
ok(!auditMatches({ NOT: { action: { contains: "y" } } }, "xy"), "NOT is understood");

const total = await prisma.audit.count();
if (!total) {
  console.log("\n  (no audit rows in this database — skipping the table comparison)");
} else {
  console.log(`\nagainst the real table (${total} rows):`);
  let sum = 0;
  const actions = await prisma.audit.findMany({ select: { action: true } });
  for (const cat of AUDIT_CAT_NAMES) {
    const sql = await prisma.audit.count({ where: auditWhereFor(cat) });
    const labelled = actions.filter(r => auditCatOf(r.action) === cat).length;
    sum += sql;
    ok(sql === labelled, `${cat.padEnd(12)} SQL ${String(sql).padStart(5)} = labelled ${labelled}`);
  }
  ok(sum === total, `the categories sum to the whole table (${sum} of ${total}) — no row in two, none in none`);
  ok((await prisma.audit.count({ where: auditWhereFor("All") })) === total, `"All" really is all ${total}`);
  ok((await prisma.audit.count({ where: auditWhereFor("Nonsense") })) === total, "an unknown chip shows everything, not nothing");
}

await prisma.$disconnect();
console.log(bad ? `\n${bad} failed` : "\nall good");
process.exit(bad ? 1 : 0);
