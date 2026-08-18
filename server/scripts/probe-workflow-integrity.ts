/**
 * Throwaway check for the three repairs: custom roles, the hiring gate, and reference validation.
 *
 * The one that matters most is the country check. Nothing stopped a Saudi workflow from issuing a
 * document type filed under AE — it resolves on this database only because this database holds every
 * country, and on a fresh installation of SA alone it resolves to nothing. It saves cleanly, reads
 * correctly, and goes wrong on a real client.
 *
 * Also proves the thing that was silently broken underneath all of it: a custom role created the way
 * the console creates one was invisible to the permission engine, so its holders were refused
 * everything the matrix governs while the role showed up perfectly in every picker.
 *
 * Own template, own role. Deletes both afterwards.
 */
import { prisma } from "../src/db.js";
import { can, customRoleLabels } from "../src/permissions.js";
import bcrypt from "bcryptjs";

const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";
const EMAIL = "zi-integ@example.invalid";
const TPL = "ZI Integrity Probe";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: "ZI " } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "ZI Integ", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", { email: EMAIL, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in - is the API running?"); process.exit(1); }

  // ── 1. the two new roles reach the permission engine ───────────────────────────────────────
  const labels = await customRoleLabels();
  console.log(`custom roles the engine can see:       ${labels.join(", ") || "NONE"}`);
  for (const r of ["IT Officer", "HR Officer"]) if (!labels.includes(r)) fail(`${r} is invisible to the permission engine`);
  console.log(`IT Officer may edit Tasks:             ${await can("it_officer", "Tasks", "Edit") ? "YES" : "NO"}`);
  if (!(await can("it_officer", "Tasks", "Edit"))) fail("IT Officer cannot do the work it was created for");
  const hrApprove = await can("hr_officer", "Approvals", "Approve");
  console.log(`HR Officer may approve:                ${hrApprove ? "YES" : "NO"}`);
  if (!hrApprove) fail("HR Officer cannot approve, which is the reason the role exists");
  console.log(`a role nobody defined is still refused: ${await can("made_up_role", "Clients", "Edit") ? "NO" : "YES"}`);
  if (await can("made_up_role", "Clients", "Edit")) fail("an unknown role was granted access");

  // ── 2. the hiring gate is back, between verification and government work ───────────────────
  const onb = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const g: any = onb?.graph ?? {};
  const nodes: any[] = g.nodes ?? [], edges: any[] = g.edges ?? [];
  const gate = nodes.find(n => n.id === "hiring_appr");
  console.log(`\nhiring approval exists:                ${gate ? `YES (${gate.type}, ${gate.config?.approverRole})` : "NO"}`);
  if (!gate) fail("the hiring approval gate is missing");
  const fromDocs = edges.filter(e => e.from === "d_docs" && e.condition === "pass").map(e => e.to);
  console.log(`document verification leads to it:     ${fromDocs.includes("hiring_appr") ? "YES" : "NO (" + fromDocs.join(",") + ")"}`);
  if (!fromDocs.includes("hiring_appr")) fail("verification does not lead to the gate, so it can be walked past");
  const gateOut = edges.filter(e => e.from === "hiring_appr");
  console.log(`approve -> hiring type, reject -> end: ${gateOut.find(e => e.condition === "approve")?.to} / ${gateOut.find(e => e.condition === "reject")?.to}`);
  if (gateOut.find(e => e.condition === "approve")?.to !== "d_hiring") fail("approving does not continue to the hiring split");
  if (!gateOut.find(e => e.condition === "reject")) fail("a rejected hire has nowhere to go");

  console.log("\nstep owners:");
  for (const id of ["access", "assets", "joined", "prob_review", "payroll"]) {
    const n = nodes.find(x => x.id === id);
    console.log(`  ${String(n?.label).slice(0, 26).padEnd(28)} ${n?.config?.assigneeRole}`);
  }
  if (nodes.find(n => n.id === "access")?.config?.assigneeRole !== "it_officer") fail("System Access is still not owned by IT");
  if (nodes.find(n => n.id === "assets")?.config?.assigneeRole === "pro_officer") fail("Assets is still PRO-owned");

  // ── 3. reference validation, and the country rule in particular ────────────────────────────
  //
  // A Saudi workflow issuing an Emirates ID. It resolves on this database because this database
  // holds AE too; on an SA-only installation it resolves to nothing.
  const mk = (docType: string) => ({
    nodes: [
      { id: "start", type: "start", label: "Start", config: {} },
      { id: "t", type: "task", label: "Do it", config: { assigneeRole: "pro_officer" } },
      { id: "d", type: "issue_document", label: "Issue", config: { docType } },
      { id: "end", type: "end", label: "End", config: {} },
    ],
    edges: [{ from: "start", to: "t", condition: "" }, { from: "t", to: "d", condition: "" }, { from: "d", to: "end", condition: "" }],
  });

  const made = await call("POST", "/api/workflow/templates", { name: TPL, country: "SA", trigger: "manual", entityType: "employee", graph: mk("Emirates ID") }, tok);
  const id = made.body?.id;
  if (!id) { fail("could not create the probe template"); await sweep(); process.exit(1); }

  const saved = await call("PUT", `/api/workflow/templates/${id}`, { graph: mk("Emirates ID") }, tok);
  const issues = (saved.body?.validation ?? []).filter((i: any) => i.level === "error");
  console.log(`\nsaving a cross-country reference is allowed: ${saved.status === 200 ? "YES (a draft may be wrong)" : "NO"}`);
  console.log(`...but it is reported:                 ${issues.length ? "YES" : "NO"}`);
  if (!issues.length) fail("a Saudi workflow issuing an AE document reported nothing");
  else console.log(`   "${issues[0].message}"`);

  const act = await call("PUT", `/api/workflow/templates/${id}`, { active: true }, tok);
  console.log(`activating it is REFUSED:              ${act.status === 400 ? "YES (400)" : "NO (" + act.status + ")"}`);
  if (act.status !== 400) fail("a workflow issuing another country's document type went live");

  // the same graph with the right country's type must activate cleanly
  await call("PUT", `/api/workflow/templates/${id}`, { graph: mk("Iqama") }, tok);
  const ok = await call("PUT", `/api/workflow/templates/${id}`, { active: true }, tok);
  console.log(`the same graph with an SA type goes live: ${ok.status === 200 ? "YES" : "NO (" + ok.status + " " + (ok.body?.error ?? "") + ")"}`);
  if (ok.status !== 200) fail("a correct workflow was blocked, which would make the guard unusable");

  // a rule that does not exist
  const badRule = mk("Iqama");
  (badRule.nodes[1] as any).config = { assigneeRole: "pro_officer", checklistSource: "dynamic", checklistRuleId: "no-such-rule" };
  const r2 = await call("PUT", `/api/workflow/templates/${id}`, { graph: badRule, active: false }, tok);
  const ruleIssue = (r2.body?.validation ?? []).find((i: any) => /checklist rule/.test(i.message));
  console.log(`a deleted checklist rule is reported:  ${ruleIssue ? "YES" : "NO"}`);
  if (!ruleIssue) fail("a dangling checklist rule reference was not reported");

  // a role nobody holds
  const badRole = mk("Iqama");
  (badRole.nodes[1] as any).config = { assigneeRole: "ghost_officer" };
  const r3 = await call("PUT", `/api/workflow/templates/${id}`, { graph: badRole }, tok);
  const roleIssue = (r3.body?.validation ?? []).find((i: any) => /does not exist/.test(i.message));
  console.log(`a role nobody holds is reported:       ${roleIssue ? "YES" : "NO"}`);
  if (!roleIssue) fail("a step owned by a non-existent role was not reported");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
