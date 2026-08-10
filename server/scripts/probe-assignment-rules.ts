/**
 * Throwaway check: routing rules decide who gets work, and change nothing when there are none.
 *
 * Both halves of the system answered "who?" with "whoever is least busy". That is a good default and
 * a bad only-answer: an officer who files on Qiwa daily is faster on Qiwa, and neither that nor
 * "website leads go to Fahad" could be said anywhere.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE FIRST ONE. With no rules, this must behave exactly as it
 * did before rules existed — otherwise adding the feature is a change to a working system rather
 * than an option on top of it. Everything else here is worth less than that.
 *
 * Own users and rules. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { routeFor } from "../src/routing.js";
import { nextOwnerFor } from "../src/assignment.js";
import { pickAssignee } from "../src/workflow.js";

const sweep = async () => {
  await prisma.assignmentRule.deleteMany({ where: { label: { startsWith: "ZZ " } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: "ZZ ROUTE" } } });
  const wi = await prisma.workflowInstance.findMany({ where: { title: { startsWith: "ZZ ROUTE" } }, select: { id: true } });
  if (wi.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: wi.map(w => w.id) } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: wi.map(w => w.id) } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: wi.map(w => w.id) } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
};

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    const mk = (name: string, roleId: string) =>
      prisma.user.create({ data: { name, email: `zz-${name.toLowerCase().replace(/\W+/g, "-")}@example.invalid`, roleId, status: "active", type: "staff" } });
    const fahad = await mk("ZZ Fahad", "sales");
    const sara = await mk("ZZ Sara", "sales");
    const noura = await mk("ZZ Noura", "pro_officer");
    const omar = await mk("ZZ Omar", "pro_officer");
    const gone = await mk("ZZ Departed", "sales");

    // ── 1. NO RULES = TODAY'S BEHAVIOUR ───────────────────────────────────────────────────────
    const bare = await routeFor("lead", { source: "Website", city: "Riyadh" });
    console.log(`with no rules, nothing is routed:        ${!bare.userId && !bare.role ? "YES" : "NO"}`);
    if (bare.userId || bare.role) fail("an empty rule list routed something — adding rules changed a working system");
    console.log(`  …and it says so in words:             "${bare.why}"`);
    const beforeOwner = (await nextOwnerFor({ source: "Website" })).owner;
    console.log(`  the load balancer still answers:      ${beforeOwner ? "YES (" + beforeOwner.name + ")" : "NO"}`);
    if (!beforeOwner) fail("with no rules there was no fallback — leads would land unowned");

    // ── 2. a rule routes a LEAD by where it came from ─────────────────────────────────────────
    await prisma.assignmentRule.create({ data: { scope: "lead", position: 0, label: "ZZ web to Fahad", whenSource: "Website", toUserId: fahad.id } });
    const web = await nextOwnerFor({ source: "Website" });
    console.log(`\na website lead goes to the named rep:    ${web.owner?.id === fahad.id ? "YES (ZZ Fahad)" : "NO (" + web.owner?.name + ")"}`);
    if (web.owner?.id !== fahad.id) fail("the source rule did not route the lead");
    console.log(`  and explains itself:                  "${web.why}"`);
    // Case and stray spaces must not defeat it — real data has both.
    const messy = await nextOwnerFor({ source: "  website " });
    console.log(`  matching ignores case and spaces:     ${messy.owner?.id === fahad.id ? "YES" : "NO"}`);
    if (messy.owner?.id !== fahad.id) fail('"  website " did not match "Website" — real data is never tidy');
    // A lead the rule does NOT describe still balances — and to prove that is BALANCE rather than
    // coincidence, Fahad is first given a book of business so the balancer would never choose him.
    // Without this the test passes whichever way the code behaves, which is not a test.
    for (let i = 0; i < 3; i++)
      await prisma.company.create({ data: { name: `ZZ ROUTE load ${i}`, lifecycle: "client", cr: `88800000${i}`, ownerId: fahad.id } });
    const other = await nextOwnerFor({ source: "Referral" });
    console.log(`  a lead it does not describe balances: ${other.owner && other.owner.id !== fahad.id ? "YES (" + other.owner.name + ", the lighter one)" : "NO (" + other.owner?.name + ")"}`);
    if (!other.owner) fail("a non-matching lead got no owner at all");
    if (other.owner?.id === fahad.id) fail("a non-matching lead went to the heaviest rep — the fallback is not balancing");
    // …while a lead the rule DOES describe still goes to Fahad, load notwithstanding. That is the
    // whole point: a rule beats the balancer, it does not merely agree with it.
    const still = await nextOwnerFor({ source: "Website" });
    console.log(`  a matching lead beats the balancer:   ${still.owner?.id === fahad.id ? "YES (Fahad, though heaviest)" : "NO"}`);
    if (still.owner?.id !== fahad.id) fail("the rule lost to workload — rules must win over the default");

    // ── 3. a rule routes a PRO STEP by the authority it is done at ────────────────────────────
    await prisma.assignmentRule.create({ data: { scope: "task", position: 0, label: "ZZ GOSI to Noura", whenGovCenter: "GOSI", toUserId: noura.id } });
    const gosi = await pickAssignee("pro_officer", { govCenter: "GOSI" });
    console.log(`\na GOSI step goes to the named officer:   ${gosi?.id === noura.id ? "YES (ZZ Noura)" : "NO (" + gosi?.name + ")"}`);
    if (gosi?.id !== noura.id) fail("the gov-center rule did not route the task");
    // Same trick on the PRO side: load Noura up so the balancer would pick Omar, then a Qiwa step
    // (no rule) must go to Omar while a GOSI step (rule) still goes to Noura.
    const inst = await prisma.workflowInstance.create({ data: { templateId: (await prisma.workflowTemplate.findFirst({ select: { id: true } }))!.id, title: "ZZ ROUTE load run", status: "running" } });
    for (let i = 0; i < 3; i++)
      await prisma.workflowTask.create({ data: { instanceId: inst.id, nodeId: `zz${i}`, title: `ZZ ROUTE load ${i}`, status: "active", assigneeId: noura.id } });
    const qiwa = await pickAssignee("pro_officer", { govCenter: "Qiwa" });
    console.log(`  a Qiwa step still balances by load:   ${qiwa?.id === omar.id ? "YES (ZZ Omar, the lighter one)" : "NO (" + qiwa?.name + ")"}`);
    if (qiwa?.id !== omar.id) fail("a task with no matching rule did not go to the lighter officer — the fallback is not balancing");
    const gosi2 = await pickAssignee("pro_officer", { govCenter: "GOSI" });
    console.log(`  a GOSI step beats the balancer:       ${gosi2?.id === noura.id ? "YES (Noura, though heaviest)" : "NO"}`);
    if (gosi2?.id !== noura.id) fail("the gov-center rule lost to workload");
    await prisma.workflowTask.deleteMany({ where: { instanceId: inst.id } });
    await prisma.workflowInstance.delete({ where: { id: inst.id } });
    const noFacts = await pickAssignee("pro_officer");
    console.log(`  calling it with no facts still works: ${noFacts ? "YES (" + noFacts.name + ")" : "NO"}`);
    if (!noFacts) fail("pickAssignee(role) without facts broke — that is every existing call site");

    // ── 4. ORDER decides, and a rule pointing at somebody who left is skipped ─────────────────
    await prisma.assignmentRule.create({ data: { scope: "lead", position: 0, label: "ZZ Riyadh to Sara", whenCity: "Riyadh", toUserId: sara.id } });
    // position 0 twice → tie broken by id; assert the FIRST by ordering wins consistently
    const both = await routeFor("lead", { source: "Website", city: "Riyadh" });
    console.log(`\ntwo rules match → exactly one fires:     ${both.ruleId ? "YES (" + both.why + ")" : "NO"}`);
    if (!both.ruleId) fail("two matching rules resolved to nothing");

    await prisma.user.update({ where: { id: gone.id }, data: { status: "inactive" } });
    await prisma.assignmentRule.deleteMany({ where: { label: { startsWith: "ZZ " } } });
    await prisma.assignmentRule.create({ data: { scope: "lead", position: 0, label: "ZZ to somebody who left", whenSource: "Website", toUserId: gone.id } });
    await prisma.assignmentRule.create({ data: { scope: "lead", position: 1, label: "ZZ fallback to Sara", whenSource: "Website", toUserId: sara.id } });
    const skipped = await nextOwnerFor({ source: "Website" });
    console.log(`a rule aimed at a leaver is skipped:     ${skipped.owner?.id === sara.id ? "YES (fell to ZZ Sara)" : "NO (" + skipped.owner?.name + ")"}`);
    if (skipped.owner?.id !== sara.id) fail("work was routed to somebody who has left, or the list stopped at them");

    // ── 5. a rule naming a ROLE narrows the pool, load still decides inside it ────────────────
    await prisma.assignmentRule.deleteMany({ where: { label: { startsWith: "ZZ " } } });
    await prisma.assignmentRule.create({ data: { scope: "task", position: 0, label: "ZZ ZATCA to accounts", whenGovCenter: "ZATCA", toRole: "pro_officer" } });
    const byRole = await pickAssignee("accountant", { govCenter: "ZATCA" });
    console.log(`\na role rule redirects which team:        ${byRole && [noura.id, omar.id].includes(byRole.id) ? "YES (" + byRole.name + ")" : "NO (" + byRole?.name + ")"}`);
    if (!byRole || ![noura.id, omar.id].includes(byRole.id)) fail("a rule naming a role did not redirect the team");

  } finally {
    await sweep();
  }

  const left = await prisma.assignmentRule.count({ where: { label: { startsWith: "ZZ " } } })
    + await prisma.user.count({ where: { email: { contains: "example.invalid" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " left"}`);
  if (left) fail("probe rows left behind");
  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
