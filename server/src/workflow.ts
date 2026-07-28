// ── BPM Workflow engine ───────────────────────────────────────────────
// A token/frontier executor over a DAG stored on WorkflowTemplate.graph.
// Auto nodes (start/notify/webhook/delay/decision/parallel_*/end) execute and advance
// immediately; wait nodes (task/approval) create a WorkflowTask and pause until it is
// completed via completeTask(), which resumes the frontier from that node.
import { Router } from "express";
import { prisma } from "./db.js";
import { requireAuth, requireStaff, requireWriteRole, logActivity, logNotification, logAudit } from "./auth.js";

const nowISO = () => new Date().toISOString();

// ── Structured document checklists (items + per-item state + dynamic resolution) ──
type ChecklistItem = { key: string; label: string; required: boolean };
const slug = (s: string) => (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "item");
// Normalize a checklist config (string[] | {key?,label,required?}[] | legacy {label,done}[]) → item defs.
function normalizeItems(raw: any): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map((x: any) => typeof x === "string"
    ? { key: slug(x), label: x, required: true }
    : { key: x.key || slug(x.label || ""), label: x.label ?? x.key ?? "Item", required: x.required !== false });
}
// Overall run progress for a workflow instance.
// Denominator = the human (task|approval) nodes in the TEMPLATE graph — a stable total. Using
// "tasks created so far" would inflate progress, because steps are only materialised as the token
// reaches them (a 5-step run with 1 created step would read 0/1 = 0%, then 1/1 = 100%).
// Falls back to the created-task count when the graph is unavailable.
export function runProgress(graph: any, tasks: { status: string }[]): { done: number; total: number; pct: number } {
  const total = (graph?.nodes || []).filter((n: any) => n.type === "task" || n.type === "approval").length || tasks.length;
  const done = tasks.filter(t => t.status !== "active").length;
  return { done, total, pct: total ? Math.min(100, Math.round((done / total) * 100)) : 0 };
}

function matchCond(left: any, op: string, right: any): boolean {
  const L = String(left ?? "").toLowerCase(), R = String(right ?? "").toLowerCase();
  switch (op) {
    case "eq": return L === R;
    case "ne": return L !== R;
    case "contains": return L.includes(R);
    case "in": return R.split(",").map(s => s.trim()).includes(L);
    default: return true; // blank op → always applies (base document set)
  }
}
// Union of document sets from a ChecklistRule's rows whose conditions all match the instance variables.
async function resolveDynamic(ruleId: string, vars: Record<string, any>): Promise<ChecklistItem[]> {
  const rule = await prisma.checklistRule.findUnique({ where: { id: ruleId } });
  const rows: any[] = Array.isArray((rule as any)?.rows) ? (rule as any).rows : [];
  const out: Record<string, ChecklistItem> = {};
  for (const row of rows) {
    const conds: any[] = Array.isArray(row.conditions) ? row.conditions : [];
    if (conds.every(c => matchCond(vars[c.var], c.op, c.value))) {
      for (const it of normalizeItems(row.documents || [])) out[it.key] = it;
    }
  }
  return Object.values(out);
}
/**
 * Choose who a new step belongs to: the ACTIVE staff member holding that role with the fewest open
 * tasks. Least-loaded rather than plain round-robin, because a round robin keeps handing work to
 * someone already buried. Ties break on name so the result is deterministic (and testable).
 * Returns the user's NAME — that is what WorkflowTask.assignee holds and what /my-work matches on.
 * Null when nobody holds the role, which leaves the old unassigned behaviour intact.
 */
async function pickAssignee(role: string): Promise<string | null> {
  const candidates = await prisma.user.findMany({
    where: { roleId: role, status: "active", type: "staff" },
    select: { name: true },
  });
  if (!candidates.length) return null;
  const names = candidates.map(c => c.name).filter(Boolean) as string[];
  if (!names.length) return null;
  const load = await prisma.workflowTask.groupBy({
    by: ["assignee"],
    where: { status: "active", assignee: { in: names } },
    _count: { _all: true },
  });
  const byName = new Map(load.map(l => [l.assignee as string, l._count._all]));
  return names
    .map(n => ({ n, c: byName.get(n) ?? 0 }))
    .sort((a, b) => (a.c - b.c) || a.n.localeCompare(b.n))[0].n;
}

// The effective checklist for a task node at runtime: dynamic rule (if configured) else the node's own list.
async function resolveChecklist(config: any, vars: Record<string, any>): Promise<ChecklistItem[]> {
  const c = config ?? {};
  if (c.checklistSource === "dynamic" && c.checklistRuleId) {
    try { const dyn = await resolveDynamic(c.checklistRuleId, vars); if (dyn.length) return dyn; } catch { /* fall back to static */ }
  }
  return normalizeItems(c.checklist);
}
// Runtime state for a task, deriving from legacy {label,done} checklist if no checklistState exists yet.
function effectiveState(task: any): Record<string, any> {
  if (task.checklistState && typeof task.checklistState === "object" && Object.keys(task.checklistState).length) return { ...task.checklistState };
  const state: Record<string, any> = {};
  for (const x of (Array.isArray(task.checklist) ? task.checklist : [])) {
    if (x && typeof x === "object" && "done" in x) { const k = x.key || slug(x.label || ""); state[k] = { received: !!x.done, verified: !!x.done }; }
  }
  return state;
}
// Are all REQUIRED items satisfied? (received, or received && verified when requireVerification.)
function checklistSatisfied(items: ChecklistItem[], state: Record<string, any>, requireVerification: boolean): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const it of items) {
    if (!it.required) continue;
    const s = state[it.key] || {};
    const done = requireVerification ? (s.received && s.verified) : s.received;
    if (!done) missing.push(it.label || it.key);
  }
  return { ok: missing.length === 0, missing };
}

type Node = { id: string; type: string; label?: string; config?: any };
type Edge = { id?: string; from: string; to: string; label?: string; condition?: string };
type Graph = { nodes: Node[]; edges: Edge[] };

function asGraph(g: any): Graph {
  const graph = (g && typeof g === "object") ? g : {};
  return { nodes: Array.isArray(graph.nodes) ? graph.nodes : [], edges: Array.isArray(graph.edges) ? graph.edges : [] };
}
const getNode = (g: Graph, id: string) => g.nodes.find(n => n.id === id);
const outEdges = (g: Graph, id: string) => g.edges.filter(e => e.from === id);
const inDegree = (g: Graph, id: string) => g.edges.filter(e => e.to === id).length;

// Which successor nodes to activate from `nodeId`, optionally filtered by an outcome/branch `key`.
// `blankFallback` (default true): when the exact branch has no wire, is a bare unconditional edge
// (condition "") an acceptable fallback? For an approval REJECT it must be FALSE — a blank edge is
// the approve/continuation path, and a rejection must never silently flow down it.
function nextTargets(g: Graph, nodeId: string, key?: string | null, blankFallback: boolean = true): string[] {
  const edges = outEdges(g, nodeId);
  if (key != null && key !== "") {
    const matched = edges.filter(e => (e.condition ?? "") === key);
    if (matched.length) return matched.map(e => e.to);
    // fall back to an else/default edge if the exact branch has no wire; a bare "" edge only counts
    // when blankFallback is allowed (never for reject).
    const conds: any[] = blankFallback ? ["else", "default", "", undefined, null] : ["else", "default"];
    const fallback = edges.filter(e => conds.includes(e.condition as any));
    return fallback.map(e => e.to);
  }
  // no key → unconditional edges (or all, if none are marked unconditional)
  const uncond = edges.filter(e => !e.condition);
  return (uncond.length ? uncond : edges).map(e => e.to);
}

// Evaluate a decision node's branches against the instance variables → returns a branch key ("else" if none match).
function evalDecision(node: Node, vars: Record<string, any>): string {
  const branches: any[] = Array.isArray(node.config?.branches) ? node.config.branches : [];
  for (const b of branches) {
    const left = vars[b.var];
    const right = b.value;
    let ok = false;
    switch (b.op) {
      case "eq":  ok = String(left) === String(right); break;
      case "ne":  ok = String(left) !== String(right); break;
      case "gt":  ok = Number(left) > Number(right); break;
      case "lt":  ok = Number(left) < Number(right); break;
      case "gte": ok = Number(left) >= Number(right); break;
      case "lte": ok = Number(left) <= Number(right); break;
      case "contains": ok = String(left ?? "").toLowerCase().includes(String(right ?? "").toLowerCase()); break;
      case "truthy": ok = !!left && left !== "no" && left !== "false"; break;
      default: ok = false;
    }
    if (ok) return b.key;
  }
  return "else";
}

// Terminate an instance with an outcome and write the result back to the linked subject. Shared by
// the `end` node and by any terminal path (e.g. a rejected approval with no reject branch drawn), so
// a run can never be left "running" with no open task. Idempotent: no-op if already completed.
async function finalizeInstance(inst: any, result: string, nodeId?: string | null, label?: string | null) {
  if (inst.status === "completed") return;
  const vars: Record<string, any> = (inst.variables && typeof inst.variables === "object") ? inst.variables : {};
  vars._result = result;
  inst.status = "completed";
  inst.completedAt = nowISO();
  inst.variables = vars;
  const log = (action: string, detail?: string) =>
    prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: nodeId ?? null, action, detail: detail ?? null, actor: "engine", at: nowISO() } });
  await prisma.workflowInstance.update({ where: { id: inst.id }, data: { status: "completed", completedAt: inst.completedAt, variables: vars } });
  await log("instance.completed", `${label ?? "End"} · ${result}`);
  logActivity({ type: "task", message: `Workflow ${result}: ${inst.title}${inst.clientName ? ` (${inst.clientName})` : ""}` });
  // Update the linked subject. subjectKind = "company" → the run concerns the client itself
  // (CR/GOSI/VAT); otherwise it's an employee (Iqama/visa) — update that person + history.
  try {
    const subjectKind = String(vars.subjectKind || "").toLowerCase();
    const tpl2 = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
    if (subjectKind === "company") {
      await log("company.document_processed", `${inst.clientName ?? inst.companyId ?? "company"} → ${result}`);
      logActivity({ type: "client", message: `${tpl2?.name ?? "Workflow"} ${result} for ${inst.clientName ?? "company"}` });
    } else {
      const empId = vars.employeeId;
      const applicant = vars.applicant || vars.employee || vars.applicantName;
      let emp: any = null;
      if (empId) emp = await prisma.employee.findUnique({ where: { id: String(empId) } });
      else if (applicant && inst.companyId) emp = await prisma.employee.findFirst({ where: { companyId: inst.companyId, name: String(applicant) } });
      if (emp) {
        const hist = Array.isArray(emp.history) ? emp.history : [];
        hist.unshift({ at: nowISO(), event: `${tpl2?.name ?? "Workflow"} — ${result}`, detail: inst.title, by: "workflow" });
        const data: any = { history: hist };
        if (result === "approved") data.status = "valid"; // rejected: keep status, just record history
        await prisma.employee.update({ where: { id: emp.id }, data });
        await log("employee.updated", `${emp.name} → ${result}`);
        logActivity({ type: "client", message: `${emp.name} updated by workflow: ${result}${inst.clientName ? ` (${inst.clientName})` : ""}` });
      }
    }
  } catch { /* non-fatal */ }
}

// One synchronous execution pass. Mutates `inst.variables` (persisted by the caller) and
// creates WorkflowTasks / logs as side effects. `frontier` = node ids to activate now.
async function runFrontier(inst: any, g: Graph, frontier: string[]) {
  const vars: Record<string, any> = (inst.variables && typeof inst.variables === "object") ? inst.variables : {};
  vars._joins = vars._joins || {}; // parallel-join arrival counters
  const log = (action: string, nodeId?: string, detail?: string) =>
    prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: nodeId ?? null, action, detail: detail ?? null, actor: "engine", at: nowISO() } });

  let guard = 0;
  const queue = [...frontier];
  while (queue.length) {
    if (guard++ > 500) { await log("engine.guard_stop", undefined, "frontier exceeded 500 steps"); break; }
    const nodeId = queue.shift()!;
    const node = getNode(g, nodeId);
    if (!node) continue;

    switch (node.type) {
      case "start":
        queue.push(...nextTargets(g, nodeId));
        break;

      case "notify": {
        const ch = node.config?.channel ?? "Email";
        await log("notify", nodeId, `${node.label ?? "Notify"} · ${ch}`);
        logNotification({ type: "system", title: node.label || "Workflow notification", message: node.config?.template ?? inst.title });
        queue.push(...nextTargets(g, nodeId));
        break;
      }

      case "webhook":
      case "api":
        await log(node.type, nodeId, `${node.label ?? node.type} → ${node.config?.url ?? "(no url)"} [stub — not sent]`);
        queue.push(...nextTargets(g, nodeId));
        break;

      case "draft_invoice": {
        // Fire a draft invoice into the Finance module — "task completion triggers invoice" from the spec.
        const c = node.config ?? {};
        const amount = Number(c.amount) || 0;
        const number = `WF-${String(Date.now()).slice(-6)}`;
        try {
          await prisma.invoice.create({ data: { number, companyId: inst.companyId ?? null, clientName: inst.clientName ?? null, amount, currency: c.currency || "SAR", status: "draft", date: nowISO().slice(0, 10), services: c.service ?? node.label ?? "Workflow service" } });
          logActivity({ type: "finance", message: `Draft invoice ${number} (SAR ${amount}) from workflow: ${inst.title}` });
        } catch { /* non-fatal */ }
        await log("draft_invoice", nodeId, `${number} · SAR ${amount}`);
        queue.push(...nextTargets(g, nodeId));
        break;
      }

      case "issue_document": {
        // Close the loop: write the workflow's result back to Compliance. Reads the new document details
        // from process variables (captured at earlier stages). If vars.documentId is set → RENEW that doc
        // (archives old→new into history[]); otherwise → ISSUE a new doc against the subject
        // (employee for person docs, the company itself for company docs). Non-fatal on any error.
        const c = node.config ?? {};
        const pick = (...keys: string[]) => { for (const k of keys) { if (!k) continue; const v = vars[k]; if (v !== undefined && v !== null && String(v).trim() !== "") return String(v); } return ""; };
        const expiry  = pick(c.expiryVar, "newExpiry", "expiryDate", "expiry");
        const number  = pick(c.numberVar, "docNumber", "newNumber", "documentNumber");
        const issue   = pick(c.issueVar, "issueDate", "issue");
        const fee     = pick(c.feeVar, "fee", "renewalFee");
        const receipt = pick(c.receiptVar, "receipt", "receiptNo");
        const docType = String(c.docType || vars.docType || node.label || "Document");
        try {
          const tpl = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
          const leadDays = (await prisma.documentType.findFirst({ where: { name: docType } }))?.leadDays ?? 30;
          const statusOf = (exp: string) => { const t = new Date(exp).getTime(); if (isNaN(t)) return { daysLeft: 0, status: "valid" }; const dl = Math.round((t - Date.now()) / 86400000); return { daysLeft: dl, status: dl < 0 ? "overdue" : dl <= leadDays ? "expiring" : "valid" }; };
          const documentId = vars.documentId ? String(vars.documentId) : "";
          if (documentId) {
            const existing = await prisma.document.findUnique({ where: { id: documentId } });
            if (existing) {
              const st = expiry ? statusOf(expiry) : { daysLeft: existing.daysLeft, status: "valid" };
              const hist = Array.isArray(existing.history) ? (existing.history as any[]) : [];
              hist.unshift({ at: nowISO(), by: "workflow", oldExpiry: existing.expiryDate ?? undefined, newExpiry: expiry || existing.expiryDate, oldNumber: existing.docNumber ?? undefined, newNumber: number || existing.docNumber, fee: fee || undefined, receipt: receipt || undefined, note: `Renewed via ${tpl?.name ?? "workflow"}` });
              await prisma.document.update({ where: { id: documentId }, data: { expiryDate: expiry || existing.expiryDate, docNumber: number || existing.docNumber, issueDate: issue || existing.issueDate, status: st.status, daysLeft: st.daysLeft, history: hist } });
              await log("document.renewed", nodeId, `${docType} → ${expiry || "?"} (no. ${number || "—"})`);
              logActivity({ type: "compliance", message: `${docType} renewed for ${existing.person} — new expiry ${expiry || "?"}${inst.clientName ? ` (${inst.clientName})` : ""}` });
            }
          } else {
            // Subject scope is a property of the DOCUMENT TYPE — read it from the DB (authoritative),
            // falling back to the process var, then "employee". A manually-started run won't set
            // vars.subjectKind, so without this a company-scoped doc (e.g. Commercial Register) is
            // mis-treated as employee-scoped, comes out with an empty owner, and is silently skipped.
            const dtRec = await prisma.documentType.findFirst({ where: { OR: [{ name: docType }, { id: docType }] } });
            const subjectKind = String(vars.subjectKind || dtRec?.subjectKind || "employee").toLowerCase();
            let employeeId = subjectKind === "company" ? null : (vars.employeeId ? String(vars.employeeId) : null);
            let person = subjectKind === "company" ? (inst.clientName || "Company") : String(vars.applicant || vars.employee || "");
            // Employee-scoped but the applicant name wasn't captured: resolve it from the bound employeeId.
            if (subjectKind !== "company" && !person && employeeId) {
              const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
              if (emp) person = emp.name;
            }
            if (inst.companyId && person) {
              const st = expiry ? statusOf(expiry) : { daysLeft: 0, status: "valid" };
              await prisma.document.create({ data: { companyId: inst.companyId, person, employeeId, docType, expiryDate: expiry || null, issueDate: issue || null, docNumber: number || null, status: st.status, daysLeft: st.daysLeft } });
              await log("document.issued", nodeId, `${docType} (${subjectKind}) for ${person} → ${expiry || "?"}`);
              logActivity({ type: "compliance", message: `${docType} issued for ${person} — expiry ${expiry || "?"}${inst.clientName ? ` (${inst.clientName})` : ""}` });
            } else {
              // Couldn't attach the new document to an owner. Make this VISIBLE — a silent skip made
              // the run look fully successful even though no document was created.
              const why = !inst.companyId ? "no client/company is linked to this run"
                : `no ${subjectKind === "company" ? "client name" : "employee/applicant"} is bound — start this workflow from the client's Compliance page (or bind a subject) so the issued document has an owner`;
              await log("issue_document.skipped", nodeId, `${docType} (${subjectKind}): ${why}`);
              logActivity({ type: "alert", message: `⚠ Workflow finished but could not issue ${docType} — ${why}${inst.clientName ? ` (${inst.clientName})` : ""}` });
            }
          }
        } catch { /* non-fatal */ }
        queue.push(...nextTargets(g, nodeId));
        break;
      }

      case "delay":
        // No scheduler yet — record the intended wait and pass straight through.
        await log("delay", nodeId, `${node.config?.hours ?? node.config?.days ?? "?"} (skipped — scheduler pending)`);
        queue.push(...nextTargets(g, nodeId));
        break;

      case "decision": {
        const key = evalDecision(node, vars);
        await log("decision", nodeId, `${node.label ?? "Decision"} → ${key}`);
        queue.push(...nextTargets(g, nodeId, key));
        break;
      }

      case "parallel_split":
        await log("parallel_split", nodeId, node.label);
        queue.push(...nextTargets(g, nodeId));
        break;

      case "parallel_join": {
        const need = inDegree(g, nodeId);
        const got = (vars._joins[nodeId] ?? 0) + 1;
        vars._joins[nodeId] = got;
        if (got >= need) {
          vars._joins[nodeId] = 0; // reset for potential re-entry
          await log("parallel_join", nodeId, `all ${need} branches joined`);
          queue.push(...nextTargets(g, nodeId));
        } else {
          await log("parallel_join.wait", nodeId, `${got}/${need} branches arrived`);
        }
        break;
      }

      case "task":
      case "approval": {
        // Idempotency: don't spawn a second live task for the same node.
        const existing = await prisma.workflowTask.findFirst({ where: { instanceId: inst.id, nodeId, status: "active" } });
        if (existing) break;
        const c = node.config ?? {};
        // Snapshot the effective checklist (dynamic rule → variables, else static) so later template edits don't change in-flight runs.
        const items = await resolveChecklist(c, vars);
        const role = c.assigneeRole || c.approverRole || null;
        // Give the step an owner. Templates name a ROLE, not a person, so every task landed with
        // assignee null and sat in a shared pile until somebody claimed it. Falls back to null (the
        // old behaviour) when nobody holds the role — better unassigned than assigned to the wrong desk.
        const assignee = c.assignee || (role ? await pickAssignee(role) : null);
        await prisma.workflowTask.create({
          data: {
            instanceId: inst.id, nodeId, nodeType: node.type,
            title: c.title || node.label || (node.type === "approval" ? "Approval" : "Task"),
            assignee,
            assigneeRole: role,
            status: "active",
            priority: c.priority || "medium",
            dueDate: c.dueDate || null,
            slaHours: typeof c.slaHours === "number" ? c.slaHours : null,
            checklist: items.length ? items : undefined,
            checklistState: {},
            requireVerification: !!c.requireVerification,
            captures: Array.isArray(c.captures) ? c.captures : undefined,
            createdAt: nowISO(),
          },
        });
        await log(node.type === "approval" ? "approval.requested" : "task.created", nodeId, node.label);
        // wait — do not advance
        break;
      }

      case "end":
        // End nodes can declare an outcome: config.result = "approved" | "rejected" | "completed".
        await finalizeInstance(inst, String(node.config?.result || "completed").toLowerCase(), nodeId, node.label);
        break;

      default:
        await log("node.skipped", nodeId, `unknown type ${node.type}`);
        queue.push(...nextTargets(g, nodeId));
    }
  }

  inst.variables = vars;
  await prisma.workflowInstance.update({ where: { id: inst.id }, data: { variables: vars } });
}

// Find the entry node: an explicit start node, else any node with no incoming edge.
function entryNodes(g: Graph): string[] {
  const start = g.nodes.filter(n => n.type === "start");
  if (start.length) return start.map(n => n.id);
  return g.nodes.filter(n => inDegree(g, n.id) === 0).map(n => n.id);
}

export async function startInstance(templateId: string, opts: { title?: string; companyId?: string | null; clientName?: string | null; variables?: any }) {
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) throw new Error("Template not found");
  const g = asGraph(tpl.graph);
  if (!g.nodes.length) throw new Error("This workflow has no steps yet");
  const inst = await prisma.workflowInstance.create({
    data: {
      templateId,
      title: opts.title || tpl.name,
      companyId: opts.companyId ?? null,
      clientName: opts.clientName ?? null,
      variables: (opts.variables && typeof opts.variables === "object") ? opts.variables : {},
      status: "running",
      startedAt: nowISO(),
    },
  });
  await prisma.workflowLog.create({ data: { instanceId: inst.id, action: "instance.started", detail: tpl.name, actor: "engine", at: nowISO() } });
  logActivity({ type: "task", message: `Workflow started: ${inst.title}${opts.clientName ? ` (${opts.clientName})` : ""}` });
  await runFrontier(inst, g, entryNodes(g));
  return prisma.workflowInstance.findUnique({ where: { id: inst.id }, include: { tasks: true, logs: true } });
}

export async function completeTask(taskId: string, opts: { actor?: string; outcome?: string; checklist?: any; variables?: any }) {
  const task = await prisma.workflowTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Task not found");
  if (task.status !== "active") throw new Error("This task is already completed");
  const inst = await prisma.workflowInstance.findUnique({ where: { id: task.instanceId } });
  if (!inst) throw new Error("Instance not found");
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
  const g = asGraph(tpl?.graph);

  // Merge captured variables into the instance before routing.
  // IMPORTANT: never let a blank capture wipe an existing value (e.g. passportValid set at start
  // must survive completing a step whose empty capture field would otherwise overwrite it).
  const vars: Record<string, any> = (inst.variables && typeof inst.variables === "object") ? inst.variables as any : {};
  if (opts.variables && typeof opts.variables === "object") {
    for (const [k, v] of Object.entries(opts.variables)) {
      if (v !== undefined && v !== null && String(v).trim() !== "") vars[k] = v;
    }
  }
  (inst as any).variables = vars;

  const finalStatus = task.nodeType === "approval" ? (opts.outcome === "reject" ? "rejected" : "approved") : "done";
  await prisma.workflowTask.update({
    where: { id: taskId },
    data: { status: finalStatus, outcome: opts.outcome ?? null, completedBy: opts.actor ?? null, completedAt: nowISO(),
             checklist: Array.isArray(opts.checklist) ? opts.checklist : task.checklist as any },
  });
  await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: `${task.nodeType}.${finalStatus}`, detail: task.title, actor: opts.actor ?? null, at: nowISO() } });

  // Route: approvals branch on approve/reject; tasks branch on outcome if the graph wires one.
  if (task.nodeType === "approval" && opts.outcome === "reject") {
    // Reject must NEVER fall through to a bare unconditional (approve) edge — blankFallback=false.
    const targets = nextTargets(g, task.nodeId, "reject", false);
    if (targets.length) {
      await runFrontier(inst, g, targets);
    } else {
      // No reject branch authored → terminate the run as rejected rather than continue or stall.
      await finalizeInstance(inst, "rejected", task.nodeId, "Rejected");
    }
  } else {
    const key = task.nodeType === "approval" ? "approve" : (opts.outcome || null);
    await runFrontier(inst, g, nextTargets(g, task.nodeId, key));
  }

  // Safety net: never leave a "running" instance with no open task (a zombie). If routing produced
  // no further work and no end node fired, auto-close it so it can't hang indefinitely.
  const fresh = await prisma.workflowInstance.findUnique({ where: { id: inst.id } });
  if (fresh && fresh.status === "running") {
    const open = await prisma.workflowTask.count({ where: { instanceId: inst.id, status: "active" } });
    if (open === 0) {
      const r = String((fresh.variables as any)?._result || "completed").toLowerCase();
      await finalizeInstance(fresh, r, null, "Auto-close");
    }
  }
  return prisma.workflowInstance.findUnique({ where: { id: inst.id }, include: { tasks: true, logs: true } });
}

// ── REST API ──────────────────────────────────────────────────────────
export const workflowRouter = Router();
const R = workflowRouter;

// Templates (design-time) — admin/super_admin only for writes
R.get("/templates", requireAuth, requireStaff, async (_req, res) => {
  res.json(await prisma.workflowTemplate.findMany({ orderBy: { name: "asc" } }));
});
R.get("/templates/:id", requireAuth, requireStaff, async (req, res) => {
  const t = await prisma.workflowTemplate.findUnique({ where: { id: req.params.id }, include: { instances: { select: { id: true, status: true } } } });
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json(t);
});
R.post("/templates", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { name, description, trigger, triggerConfig, entityType, graph, active } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
    const t = await prisma.workflowTemplate.create({
      data: { name: String(name).trim(), description: description ?? null, trigger: trigger || "manual",
              triggerConfig: triggerConfig ?? undefined, entityType: entityType || "generic",
              graph: graph ?? { nodes: [], edges: [] }, active: !!active, createdAt: nowISO() },
    });
    logActivity({ type: "task", message: `Workflow template created: ${t.name}` });
    res.status(201).json(t);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.put("/templates/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { name, description, trigger, triggerConfig, entityType, graph, active, version } = req.body ?? {};
    const data: any = {};
    if (name !== undefined) data.name = String(name).trim();
    if (description !== undefined) data.description = description;
    if (trigger !== undefined) data.trigger = trigger;
    if (triggerConfig !== undefined) data.triggerConfig = triggerConfig;
    if (entityType !== undefined) data.entityType = entityType;
    if (graph !== undefined) data.graph = graph;
    if (active !== undefined) data.active = !!active;
    if (version !== undefined) data.version = version;
    const t = await prisma.workflowTemplate.update({ where: { id: req.params.id }, data });
    res.json(t);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.delete("/templates/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    await prisma.workflowInstance.deleteMany({ where: { templateId: req.params.id } }); // cascade instances
    await prisma.workflowTemplate.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Instances (run-time)
R.post("/instances", requireAuth, requireStaff, async (req, res) => {
  try {
    const { templateId, title, companyId, clientName, variables } = req.body ?? {};
    if (!templateId) return res.status(400).json({ error: "templateId is required" });
    const inst = await startInstance(templateId, { title, companyId, clientName, variables });
    res.status(201).json(inst);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.get("/instances", requireAuth, requireStaff, async (req, res) => {
  const where: any = {};
  if (req.query.templateId) where.templateId = String(req.query.templateId);
  if (req.query.status) where.status = String(req.query.status);
  const list = await prisma.workflowInstance.findMany({
    where, orderBy: { startedAt: "desc" },
    // include a per-task checklist summary (required/received/verified counts) so the list endpoint isn't a mystery vs the detail one.
    // `graph` is selected only to compute the stable progress denominator — it is stripped from the response below (keeps the payload small).
    include: {
      template: { select: { name: true, graph: true } },
      tasks: {
        select: {
          id: true, status: true, nodeType: true, title: true, requireVerification: true, checklist: true, checklistState: true,
          // owner/SLA fields — let the Tasks list render "Pending with: <dept> — <person>" without an N+1 per run.
          assignee: true, assigneeRole: true, dueDate: true, slaHours: true, completedBy: true, completedAt: true, createdAt: true,
        },
      },
    },
  });
  const withSummary = list.map(i => {
    const tasks = i.tasks.map((t: any) => {
      const items = normalizeItems(t.checklist);
      const st = (t.checklistState && typeof t.checklistState === "object") ? t.checklistState : {};
      const required = items.filter(x => x.required).length;
      const received = items.filter(x => (st[x.key]?.received)).length;
      const verified = items.filter(x => (st[x.key]?.verified)).length;
      const { checklist, checklistState, ...rest } = t;
      return { ...rest, checklistSummary: { total: items.length, required, received, verified } };
    });
    const { graph, ...templateRest } = (i.template ?? {}) as any;
    // Who the run is currently sitting with (roles double as departments).
    const pendingWith = tasks
      .filter((t: any) => t.status === "active")
      .map((t: any) => ({ id: t.id, title: t.title, assignee: t.assignee ?? null, assigneeRole: t.assigneeRole ?? null, dueDate: t.dueDate ?? null, nodeType: t.nodeType }));
    return { ...i, template: templateRest, tasks, progress: runProgress(graph, tasks), pendingWith };
  });
  res.json(withSummary);
});
R.get("/instances/:id", requireAuth, requireStaff, async (req, res) => {
  const inst = await prisma.workflowInstance.findUnique({
    where: { id: req.params.id },
    include: { template: true, tasks: true, logs: { orderBy: { at: "asc" } } },
  });
  if (!inst) return res.status(404).json({ error: "Not found" });
  res.json(inst);
});
R.post("/instances/:id/cancel", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const inst = await prisma.workflowInstance.update({ where: { id: req.params.id }, data: { status: "cancelled", completedAt: nowISO() } });
    await prisma.workflowTask.updateMany({ where: { instanceId: inst.id, status: "active" }, data: { status: "skipped" } });
    await prisma.workflowLog.create({ data: { instanceId: inst.id, action: "instance.cancelled", actor: (req as any).auth?.sub, at: nowISO() } });
    res.json(inst);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// Task inbox — active workflow tasks the current user may act on (role-gated).
R.get("/my-work", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const me = await prisma.user.findUnique({ where: { id: a.sub } });
  const tasks = await prisma.workflowTask.findMany({ where: { status: "active" }, orderBy: { id: "desc" } });
  const isAdmin = a.role === "admin" || a.role === "super_admin";
  // scope=personal → strictly "my work": only steps for my role or assigned to me by name.
  // Default (broad) is used by the Approvals queue: admins see everything + unassigned open work is visible.
  const personal = req.query.scope === "personal";
  const mine = tasks.filter(t =>
    (t.assigneeRole && t.assigneeRole === a.role) ||
    (t.assignee && me?.name && t.assignee === me.name) ||
    (!personal && isAdmin) ||                          // oversight view: admins see all
    (!personal && !t.assigneeRole && !t.assignee)      // oversight view: unassigned open work
  );
  // attach instance context
  const instIds = [...new Set(mine.map(t => t.instanceId))];
  const insts = await prisma.workflowInstance.findMany({ where: { id: { in: instIds } }, select: { id: true, title: true, clientName: true } });
  const imap = Object.fromEntries(insts.map(i => [i.id, i]));
  res.json(mine.map(t => ({ ...t, instance: imap[t.instanceId] })));
});
R.get("/tasks", requireAuth, requireStaff, async (req, res) => {
  const where: any = {};
  if (req.query.instanceId) where.instanceId = String(req.query.instanceId);
  res.json(await prisma.workflowTask.findMany({ where, orderBy: { id: "desc" } }));
});
// Update a task's checklist state WITHOUT changing status (partial save + per-item receive/verify/reject).
R.post("/tasks/:id/checklist", requireAuth, requireStaff, async (req, res) => {
  try {
    const a = (req as any).auth;
    const task = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "active") return res.status(400).json({ error: "This step is already completed" });
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const isAdmin = a.role === "admin" || a.role === "super_admin";
    const allowed = isAdmin || (task.assigneeRole && task.assigneeRole === a.role) || (task.assignee && me?.name && task.assignee === me.name) || (!task.assigneeRole && !task.assignee);
    if (!allowed) return res.status(403).json({ error: "This step is assigned to another role" });
    const { checklistState, itemKey, action, note, fileRef } = req.body ?? {};
    const state = effectiveState(task);
    const logItem = (act: string, detail: string) => prisma.workflowLog.create({ data: { instanceId: task.instanceId, nodeId: task.nodeId, action: act, detail, actor: me?.name ?? a.sub, at: nowISO() } });
    if (itemKey && action) {
      const s = { ...(state[itemKey] || {}) };
      if (fileRef !== undefined) s.fileRef = fileRef; // reference/receipt no. or file id (upload UI later)
      if (action === "receive") { s.received = true; if (note !== undefined) s.note = note; await logItem("checklist.item.received", `${itemKey}${s.fileRef ? ` · ref ${s.fileRef}` : ""}`); }
      else if (action === "unreceive") { s.received = false; s.verified = false; await logItem("checklist.item.unreceived", itemKey); }
      else if (action === "verify") { s.received = true; s.verified = true; await logItem("checklist.item.verified", itemKey); }
      else if (action === "reject") { s.received = false; s.verified = false; if (note !== undefined) s.note = note; await logItem("checklist.item.rejected", `${itemKey}${note ? ` — ${note}` : ""}`); }
      else if (action === "note") { if (note !== undefined) s.note = note; }
      state[itemKey] = s;
    } else if (checklistState && typeof checklistState === "object") {
      Object.assign(state, checklistState); // bulk partial save
    }
    const updated = await prisma.workflowTask.update({ where: { id: task.id }, data: { checklistState: state } });
    res.json(updated);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.post("/tasks/:id/complete", requireAuth, requireStaff, async (req, res) => {
  try {
    const a = (req as any).auth;
    const task = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "Task not found" });
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const isAdmin = a.role === "admin" || a.role === "super_admin";
    const allowed = isAdmin || (task.assigneeRole && task.assigneeRole === a.role) || (task.assignee && me?.name && task.assignee === me.name) || (!task.assigneeRole && !task.assignee);
    if (!allowed) return res.status(403).json({ error: "This step is assigned to another role" });
    const { outcome, checklist, checklistState, variables } = req.body ?? {};
    // #2/#3 completion gating (tasks only — approvals branch on approve/reject): every REQUIRED item must be
    // received (and verified when requireVerification). Enforced server-side even if the UI is bypassed.
    if (task.nodeType === "task") {
      const items = normalizeItems(task.checklist);
      if (items.length) {
        const state = { ...effectiveState(task), ...(checklistState && typeof checklistState === "object" ? checklistState : {}) };
        const { ok, missing } = checklistSatisfied(items, state, !!task.requireVerification);
        if (!ok) return res.status(400).json({ error: `Cannot complete — required document${missing.length > 1 ? "s" : ""} not ${task.requireVerification ? "verified" : "received"}: ${missing.join(", ")}` });
        if (checklistState && typeof checklistState === "object") await prisma.workflowTask.update({ where: { id: task.id }, data: { checklistState: state } });
      }
    }
    const inst = await completeTask(req.params.id, { actor: me?.name ?? a.sub, outcome, checklist, variables });
    await logAudit({ action: "workflow.task_complete", actorId: a.sub, target: `${task.title} (${task.id})`, detail: outcome ?? undefined });
    res.json(inst);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// Checklist rules (dynamic per-client document sets) CRUD — admin/super_admin for writes.
R.get("/checklist-rules", requireAuth, requireStaff, async (_req, res) => { res.json(await prisma.checklistRule.findMany({ orderBy: { name: "asc" } })); });
R.post("/checklist-rules", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try { const { name, rows } = req.body ?? {}; if (!name) return res.status(400).json({ error: "Name required" }); res.status(201).json(await prisma.checklistRule.create({ data: { name: String(name), rows: rows ?? [] } })); } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.put("/checklist-rules/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try { const { name, rows } = req.body ?? {}; const data: any = {}; if (name !== undefined) data.name = name; if (rows !== undefined) data.rows = rows; res.json(await prisma.checklistRule.update({ where: { id: req.params.id }, data })); } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.delete("/checklist-rules/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try { await prisma.checklistRule.delete({ where: { id: req.params.id } }); res.status(204).end(); } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// Delegate a workflow step to a specific person (admin only). Clears the role gate so the named person owns it.
R.post("/tasks/:id/reassign", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  if (a.role !== "admin" && a.role !== "super_admin") return res.status(403).json({ error: "Only an admin can delegate tasks" });
  try {
    const { assignee } = req.body ?? {};
    const t = await prisma.workflowTask.update({ where: { id: req.params.id }, data: { assignee: assignee || null, assigneeRole: null } });
    await logAudit({ action: "workflow.task_reassign", actorId: a.sub, target: `${t.title} (${t.id})`, detail: `→ ${assignee || "unassigned"}` });
    logActivity({ type: "task", message: `Workflow step "${t.title}" delegated to ${assignee || "unassigned"}` });
    res.json(t);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
