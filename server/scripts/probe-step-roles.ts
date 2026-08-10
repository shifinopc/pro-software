/**
 * Throwaway check: a workflow cannot go live with work that lands on nobody's desk.
 *
 * Setup Check reported "122 of 190 steps have no role". It was counting every node except trigger
 * and end — delays, splits, decisions, notifies, invoice steps — none of which the engine turns
 * into work a person does. The real figure was 12 of 105. A finding inflated tenfold is one people
 * learn to scroll past, so the count is asserted here as well as the guard.
 *
 * What is asserted:
 *   · activating a template with a roleless task step is REFUSED, and says which steps
 *   · the same template SAVES fine while it stays a draft — a half-built graph is normal
 *   · editing a template that is ALREADY live is not blocked by this
 *   · activating is allowed the moment the roles are set
 *   · automatic steps (delay, split, notify) never count as missing a role
 *
 * Own templates. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";
import { stepsMissingRole } from "../src/workflow-validate.js";

const API = "http://localhost:4100";

const sweep = async () => {
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: "ZZ ROLE" } } });
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
};

const graph = (roles: (string | null)[]) => ({
  nodes: [
    { id: "n0", type: "trigger", label: "Start" },
    { id: "n1", type: "task", label: "ZZ do a thing", config: roles[0] ? { assigneeRole: roles[0] } : {} },
    { id: "n2", type: "approval", label: "ZZ sign it off", config: roles[1] ? { approverRole: roles[1] } : {} },
    // Automatic steps: these must NEVER be counted as missing a role.
    { id: "n3", type: "delay", label: "ZZ wait", config: { hours: 1 } },
    { id: "n4", type: "notify", label: "ZZ tell them", config: {} },
    { id: "n5", type: "parallel_split", label: "ZZ fork", config: {} },
    { id: "n6", type: "end", label: "Done" },
  ],
  edges: [{ from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n3", to: "n4" }, { from: "n4", to: "n5" }, { from: "n5", to: "n6" }],
});

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  try {
    await sweep();
    await prisma.user.create({ data: { name: "ZZ WF", email: "zz-wf@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash("zz-Throwaway-1!", 10) } });
    const lj: any = await (await fetch(`${API}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "zz-wf@example.invalid", password: "zz-Throwaway-1!" }) })).json();
    if (!lj.token) { console.log("login failed — is the API up?"); return; }
    const H = { "Content-Type": "application/json", Authorization: "Bearer " + lj.token };

    // ── only the steps a person works count ───────────────────────────────────────────────────
    const missing = stepsMissingRole(graph([null, null]));
    console.log(`counts only task/approval steps:        ${missing.length === 2 ? "YES (2, not 5)" : "NO (" + missing.length + ")"}`);
    if (missing.length !== 2) fail(`a delay/notify/split was counted as missing a role (got ${missing.length}, expected 2)`);
    console.log(`  a fully-roled graph reports none:     ${stepsMissingRole(graph(["pro_officer", "accountant"])).length === 0 ? "YES" : "NO"}`);
    if (stepsMissingRole(graph(["pro_officer", "accountant"])).length) fail("a fully configured graph still reported missing roles");

    const tpl: any = await (await fetch(`${API}/api/workflow/templates`, { method: "POST", headers: H, body: JSON.stringify({ name: "ZZ ROLE guard", entityType: "employee", graph: graph([null, null]), active: false }) })).json();
    if (!tpl?.id) { console.log("could not create template: " + JSON.stringify(tpl).slice(0, 160)); return; }

    const put = (body: any) => fetch(`${API}/api/workflow/templates/${tpl.id}`, { method: "PUT", headers: H, body: JSON.stringify(body) });

    // ── a draft saves regardless — that is the existing, deliberate design ────────────────────
    const draftSave = await put({ description: "ZZ still half-built" });
    console.log(`\na roleless DRAFT still saves:            ${draftSave.status < 300 ? "YES" : "NO (" + draftSave.status + ")"}`);
    if (draftSave.status >= 300) fail("saving a half-built draft was blocked — the Builder has to be able to hold one");
    const warned = ((await draftSave.json()) as any).validation ?? [];
    const roleWarnings = warned.filter((w: any) => /names no role/.test(w.message));
    console.log(`  …and is warned about it on save:      ${roleWarnings.length === 2 ? "YES (2 warnings)" : "NO (" + roleWarnings.length + ")"}`);
    if (roleWarnings.length !== 2) fail("the author is not told about roleless steps while still in the Builder");

    // ── but it cannot go live ─────────────────────────────────────────────────────────────────
    const activate = await put({ active: true });
    const aj: any = await activate.json();
    console.log(`\nactivating it is REFUSED:                ${activate.status === 400 ? "YES" : "NO (" + activate.status + ")"}`);
    if (activate.status !== 400) fail("a workflow whose steps land on nobody went live");
    console.log(`  names the steps:                      ${(aj.steps ?? []).length === 2 ? "YES" : "NO"}`);
    if ((aj.steps ?? []).length !== 2) fail("the refusal does not say which steps are at fault");
    console.log(`  in words: "${String(aj.error).slice(0, 74)}…"`);
    const still = await prisma.workflowTemplate.findUnique({ where: { id: tpl.id }, select: { active: true } });
    console.log(`  and it really did not activate:       ${still?.active === false ? "YES" : "NO"}`);
    if (still?.active !== false) fail("the request 400'd but the template was activated anyway");

    // ── set the roles, and it goes live ───────────────────────────────────────────────────────
    const ok = await put({ graph: graph(["pro_officer", "accountant"]), active: true });
    console.log(`\nwith roles set, it activates:            ${ok.status < 300 ? "YES" : "NO (" + ok.status + ")"}`);
    if (ok.status >= 300) fail("a properly configured workflow was still refused");

    // ── editing something already live is not blocked ─────────────────────────────────────────
    // Otherwise somebody halfway through repairing a live template gets stranded by their own fix.
    const liveEdit = await put({ graph: graph([null, null]), active: true });
    console.log(`  editing an ALREADY-live one is not:   ${liveEdit.status < 300 ? "YES" : "NO (" + liveEdit.status + ")"}`);
    if (liveEdit.status >= 300) fail("editing a live template was blocked — that strands whoever is fixing it");

  } finally {
    await sweep();
  }

  const left = await prisma.workflowTemplate.count({ where: { name: { startsWith: "ZZ ROLE" } } })
    + await prisma.user.count({ where: { email: { contains: "example.invalid" } } });
  console.log(`\ncleaned up: ${left === 0 ? "YES" : "NO — " + left + " rows left"}`);
  if (left) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
