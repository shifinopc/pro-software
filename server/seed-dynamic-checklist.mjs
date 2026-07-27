// Issue #6 — seed a PERSISTENT dynamic ChecklistRule + a template node using checklistSource:"dynamic",
// start a live run, and assert the resolved documents are snapshotted onto the task (and that editing the
// rule afterwards does NOT change the in-flight run). Leaves the seed + one demo instance in place so the
// dynamic path is inspectable in the UI. Run: node seed-dynamic-checklist.mjs
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();
const BASE = process.env.API_BASE || "http://localhost:4100";
const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const RULE_NAME = "Visa Documents by Type";
const TPL_NAME = "Visa Processing (dynamic docs)";

// Canonical rule: a base document set + type-specific rows unioned in.
const CANONICAL_ROWS = [
  { conditions: [], documents: [ { key: "passport", label: "Passport copy", required: true }, { key: "photo", label: "Photograph", required: true } ] },
  { conditions: [{ var: "visaType", op: "eq", value: "work" }], documents: [ { key: "work_contract", label: "Work contract", required: true }, { key: "medical_report", label: "Medical report", required: true } ] },
  { conditions: [{ var: "visaType", op: "eq", value: "family" }], documents: [ { key: "marriage_certificate", label: "Marriage certificate", required: true }, { key: "sponsor_iqama", label: "Sponsor Iqama", required: false } ] },
];

const api = async (method, path, body, token) => {
  const r = await fetch(`${BASE}/api/workflow${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let json; try { json = txt ? JSON.parse(txt) : null; } catch { json = txt; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${txt}`);
  return json;
};

let pass = 0, fail = 0;
const assert = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };

(async () => {
  // 1. A real staff user to mint a token for (never mutate them — read only).
  const user = await prisma.user.findFirst({ where: { type: "staff", status: "active", roleId: { in: ["super_admin", "admin"] } }, orderBy: { roleId: "asc" } });
  if (!user) throw new Error("No active super_admin/admin staff user to mint a token for");
  const token = jwt.sign({ sub: user.id, type: "staff", role: user.roleId, tv: user.tokenVersion ?? 0 }, SECRET, { expiresIn: "12h" });
  console.log(`Using token for ${user.email} (${user.roleId})\n`);

  // 2. Upsert the persistent rule (canonical rows).
  let rule = await prisma.checklistRule.findFirst({ where: { name: RULE_NAME } });
  rule = rule
    ? await prisma.checklistRule.update({ where: { id: rule.id }, data: { rows: CANONICAL_ROWS } })
    : await prisma.checklistRule.create({ data: { name: RULE_NAME, rows: CANONICAL_ROWS } });
  console.log(`Rule seeded: ${rule.name} (${rule.id})`);

  // 3. Upsert the persistent template with a dynamic-checklist task node.
  const graph = {
    nodes: [
      { id: "start", type: "start", label: "Start" },
      { id: "collect", type: "task", label: "Collect visa documents", config: { title: "Collect visa documents", checklistSource: "dynamic", checklistRuleId: rule.id, requireVerification: true, assigneeRole: "pro_officer" } },
      { id: "end", type: "end", label: "Done", config: { result: "completed" } },
    ],
    edges: [ { from: "start", to: "collect" }, { from: "collect", to: "end" } ],
  };
  let tpl = await prisma.workflowTemplate.findFirst({ where: { name: TPL_NAME } });
  tpl = tpl
    ? await prisma.workflowTemplate.update({ where: { id: tpl.id }, data: { graph, active: true, entityType: "visa", trigger: "manual" } })
    : await prisma.workflowTemplate.create({ data: { name: TPL_NAME, graph, active: true, entityType: "visa", trigger: "manual", createdAt: new Date().toISOString() } });
  console.log(`Template seeded: ${tpl.name} (${tpl.id})\n`);

  // Tidy: cancel/remove prior demo instances of this template so we leave exactly one.
  const priors = await prisma.workflowInstance.findMany({ where: { templateId: tpl.id } });
  for (const p of priors) { await prisma.workflowTask.deleteMany({ where: { instanceId: p.id } }); await prisma.workflowLog.deleteMany({ where: { instanceId: p.id } }); }
  await prisma.workflowInstance.deleteMany({ where: { templateId: tpl.id } });

  // 4. Start a live run with visaType=work via the REAL engine (so resolveChecklist runs).
  console.log("Starting a run with variables { visaType: 'work' }…");
  const inst = await api("POST", "/instances", { templateId: tpl.id, title: "Visa — Demo Applicant (work)", clientName: "Demo Client", variables: { visaType: "work" } }, token);
  console.log(`  instance ${inst.id}`);

  // 5. Assert the task snapshot resolved to the WORK document set (base + work rows).
  const detail = await api("GET", `/instances/${inst.id}`, null, token);
  const task = (detail.tasks || []).find(t => t.nodeId === "collect");
  assert(!!task, "dynamic task was created");
  const keys = (task?.checklist || []).map(x => x.key).sort();
  const expected = ["medical_report", "passport", "photo", "work_contract"].sort();
  assert(JSON.stringify(keys) === JSON.stringify(expected), `snapshot resolved to work docs [${keys.join(", ")}]`);
  assert(task?.requireVerification === true, "requireVerification carried from node config");
  assert(task?.checklist?.some(x => x.key === "medical_report"), "work-specific 'medical_report' present");
  assert(!task?.checklist?.some(x => x.key === "marriage_certificate"), "family-only 'marriage_certificate' NOT present");

  // 6. Snapshot immutability: mutate the rule, then re-read the SAME in-flight instance → checklist unchanged.
  console.log("\nEditing the rule (adding a new doc to the work row)…");
  const mutated = JSON.parse(JSON.stringify(CANONICAL_ROWS));
  mutated[1].documents.push({ key: "bank_statement", label: "Bank statement", required: true });
  await api("PUT", `/checklist-rules/${rule.id}`, { rows: mutated }, token);
  const detail2 = await api("GET", `/instances/${inst.id}`, null, token);
  const task2 = (detail2.tasks || []).find(t => t.nodeId === "collect");
  assert(!task2?.checklist?.some(x => x.key === "bank_statement"), "in-flight run did NOT pick up the rule edit (snapshot immutable)");

  // Restore the rule to canonical so the seed stays clean.
  await api("PUT", `/checklist-rules/${rule.id}`, { rows: CANONICAL_ROWS }, token);
  console.log("Rule restored to canonical rows.");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  console.log(`\nLeft in DB for UI inspection:\n  • Rule "${RULE_NAME}" (${rule.id})\n  • Template "${TPL_NAME}" (${tpl.id})\n  • Running instance ${inst.id} with a dynamic checklist snapshot`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async e => { console.error("ERROR:", e.message); await prisma.$disconnect(); process.exit(1); });
