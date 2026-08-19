/**
 * Throwaway check that publishing a workflow says which of its steps nobody can do.
 *
 * The live installation has no hr_officer, no it_officer and no admin. Five steps of Employee
 * Onboarding are owned by those roles, two of them approvals, and nothing else can clear an
 * approval — so a run reaching one stops there permanently. The template validated clean the whole
 * time, because the only role check asked whether the role was DEFINED.
 *
 * The engine does say something when a run arrives at an empty desk, but that arrives mid-flight,
 * once per run, in one instance's log. The person who can fix it is the one publishing the workflow,
 * and this is the moment they are looking.
 *
 * Reads users; builds a throwaway graph in memory. Creates nothing.
 */
import { prisma } from "../src/db.js";
import { validateReferences } from "../src/workflow.js";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };

  const staffed = await prisma.user.findFirst({ where: { status: "active", type: "staff" }, select: { roleId: true } });
  const HELD = String(staffed?.roleId ?? "pro_officer");

  // client_admin is the case worth testing rather than an invented one: the role exists and has
  // users, but every one of them is a PORTAL account. If this check counted heads instead of
  // matching how the engine picks, it would call the desk staffed and say nothing.
  const portalOnly = await prisma.user.groupBy({ by: ["type"], where: { roleId: "client_admin" }, _count: { _all: true } });
  console.log(`client_admin users: ${portalOnly.map(p => `${p._count._all} ${p.type}`).join(", ") || "none"}`);

  const graph = { nodes: [
    { id: "held",     type: "task",     label: "Collect documents", config: { assigneeRole: HELD } },
    { id: "empty",    type: "task",     label: "Raise the file",    config: { assigneeRole: "client_admin" } },
    { id: "approve",  type: "approval", label: "Manager sign-off",  config: { approverRole: "client_admin" } },
  ], edges: [] };

  const issues = await validateReferences(graph, { country: null });
  const about = (r: string) => issues.filter(i => i.message.includes(`"${r}"`));

  console.log(`\na staffed role ("${HELD}") is not flagged:      ${about(HELD).length === 0 ? "YES" : "NO"}`);
  if (about(HELD).length) fail(`a role with active staff was reported empty — every template would cry wolf: ${about(HELD)[0].message}`);

  const empty = about("client_admin");
  console.log(`a role held only by portal users is flagged: ${empty.length ? "YES" : "NO"}`);
  if (!empty.length) fail("a role whose only members are portal accounts was called staffed — the engine cannot assign to any of them");
  else console.log(`  "${empty[0].message}"`);

  console.log(`\nit names the steps that would wait:         ${empty[0] && /Raise the file/.test(empty[0].message) && /Manager sign-off/.test(empty[0].message) ? "YES" : "NO"}`);
  if (empty[0] && !/Raise the file/.test(empty[0].message)) fail("the warning does not say which steps are affected, so it cannot be acted on");
  console.log(`it says the approval stops the run:         ${empty[0] && /approval/i.test(empty[0].message) ? "YES" : "NO"}`);
  if (empty[0] && !/approval/i.test(empty[0].message)) fail("an unclearable approval reads the same as an ordinary unowned task, though only one of them halts the run");

  console.log(`...as a warning, not a publish-blocker:     ${empty[0]?.level === "warning" ? "YES" : "NO (" + empty[0]?.level + ")"}`);
  if (empty[0]?.level !== "warning") fail("an operational staffing fact blocks publishing — the last member of a team leaving would retroactively invalidate the workflow");

  // the pre-existing check must keep failing hard for a role that does not exist at all
  const bogus = await validateReferences({ nodes: [{ id: "x", type: "task", label: "Ghost step", config: { assigneeRole: "no_such_role" } }], edges: [] }, { country: null });
  console.log(`a role that does not exist is still an error: ${bogus.some(i => i.level === "error") ? "YES" : "NO"}`);
  if (!bogus.some(i => i.level === "error")) fail("a step owned by a nonexistent role no longer fails validation");

  // ── and what the real template says here ──────────────────────────────────────────────────────
  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  if (tpl) {
    const real = (await validateReferences(tpl.graph, tpl)).filter(i => /Nobody holds/.test(i.message));
    console.log(`\nEmployee Onboarding on THIS installation:  ${real.length ? real.length + " unstaffed role(s)" : "every role is staffed"}`);
    for (const r of real) console.log(`  ${r.message}`);
  }

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
