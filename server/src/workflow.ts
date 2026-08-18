// ── BPM Workflow engine ───────────────────────────────────────────────
// A token/frontier executor over a DAG stored on WorkflowTemplate.graph.
// Auto nodes (start/notify/webhook/delay/decision/parallel_*/end) execute and advance
// immediately; wait nodes (task/approval) create a WorkflowTask and pause until it is
// completed via completeTask(), which resumes the frontier from that node.
import { Router } from "express";
import { prisma } from "./db.js";
import { homeCurrency, homeCountry } from "./orgsettings.js";
import { nextNumber } from "./sequence.js";
import { notifyDocumentRenewed, notifyRequestCompleted, notifyRequestRejected } from "./notify.js";
import { validateGraph, stepsMissingRole, type GraphIssue } from "./workflow-validate.js";
import { evaluateRule } from "./dealchecklist.js";
import { figuresForFee } from "./money.js";
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

// matchCond used to live here with a SHORTER operator list — no gte/lte — so a rule that
// filtered on a pipeline stage matched every time on a workflow step. It lives in
// dealchecklist.ts now, with the evaluator, so a rule means one thing wherever it is used.
// Union of document sets from a ChecklistRule's rows whose conditions all match the instance variables.
async function resolveDynamic(ruleId: string, vars: Record<string, any>): Promise<ChecklistItem[]> {
  const rule = await prisma.checklistRule.findUnique({ where: { id: ruleId } });
  return evaluateRule(Array.isArray((rule as any)?.rows) ? (rule as any).rows : [], vars).items as ChecklistItem[];
}
/**
 * Choose who a new step belongs to: the ACTIVE staff member holding that role with the fewest open
 * tasks. Least-loaded rather than plain round-robin, because a round robin keeps handing work to
 * someone already buried. Ties break on name so the result is deterministic (and testable).
 * Returns the PERSON, not just their name. It used to return a string, which meant the caller wrote
 * a display name and nothing else — so a task could never be turned into a mailbox and the officer
 * doing the work could not be told about it. The name is still returned for the display mirror.
 * Null when nobody holds the role, which leaves the old unassigned behaviour intact.
 */
/**
 * Turn a display name back into a person — but only when there is exactly one candidate.
 *
 * Names reach this code from places that only ever held a name: a template that hard-codes "Layla
 * Ahmed", a run variable, the reassign form. Somebody has to bridge that to an id, and this is the
 * only place that does it.
 *
 * TWO MATCHES MEANS NO MATCH. Guessing between two people called Ahmed would send one of them
 * somebody else's work; returning null leaves the task showing the name it always showed, and the
 * notification falls back to the admins, who can see the ambiguity and fix it.
 */
export async function resolveStaffByName(name: string | null | undefined): Promise<{ id: string; name: string } | null> {
  const n = String(name ?? "").trim();
  if (!n || n === "Unassigned") return null;
  const hits = await prisma.user.findMany({
    where: { name: n, type: "staff", status: "active" },
    select: { id: true, name: true },
    take: 2,
  });
  return hits.length === 1 ? hits[0] : null;
}

export async function pickAssignee(
  role: string,
  /** What the step is about, so a routing rule can say who is right for it rather than who is free. */
  facts?: import("./routing.js").RoutingFacts,
): Promise<{ id: string; name: string; email: string } | null> {
  // A routing rule refines this decision; it never invents one. Nothing matching leaves the
  // load balancer below untouched, which is exactly how this behaved before rules existed.
  if (facts) {
    const { routeFor } = await import("./routing.js");
    const routed = await routeFor("task", facts);
    if (routed.userId) {
      // A rule naming a PERSON is honoured even when they do not hold the step's role: somebody
      // wrote "GOSI deregistration goes to Noura" on purpose, and silently overruling that with the
      // role would make the rule look broken rather than overridden.
      const u = await prisma.user.findUnique({ where: { id: routed.userId }, select: { id: true, name: true, email: true } });
      if (u) return u;
    }
    // A rule naming a ROLE redirects which team balances, then falls through to the same logic.
    if (routed.role) role = routed.role;
  }
  const candidates = await prisma.user.findMany({
    where: { roleId: role, status: "active", type: "staff" },
    select: { id: true, name: true, email: true },
  });
  const people = candidates.filter(c => c.name);
  if (!people.length) return null;
  // Counted by id now. Load was grouped by NAME, so two staff sharing one had their queues merged
  // and the balancer read one of them as twice as busy as they were.
  const load = await prisma.workflowTask.groupBy({
    by: ["assigneeId"],
    where: { status: "active", assigneeId: { in: people.map(p => p.id) } },
    _count: { _all: true },
  });
  const byId = new Map(load.map(l => [l.assigneeId as string, l._count._all]));
  return people
    .map(p => ({ p, c: byId.get(p.id) ?? 0 }))
    .sort((a, b) => (a.c - b.c) || a.p.name.localeCompare(b.p.name))[0].p;
}

// The effective checklist for a task node at runtime: dynamic rule (if configured) else the node's own list.
async function resolveChecklist(config: any, vars: Record<string, any>): Promise<ChecklistItem[]> {
  const c = config ?? {};
  if (c.checklistSource === "dynamic" && c.checklistRuleId) {
    try { const dyn = await resolveDynamic(c.checklistRuleId, vars); if (dyn.length) return dyn; } catch { /* fall back to static */ }
  }
  // Inherit the documents the SERVICE asks for — the same list the client's request form used. One
  // definition, so a collect step cannot drift from what the client was actually asked to upload,
  // and the ticks below can line up with the files that already arrived.
  if (c.checklistSource === "service") {
    try {
      const svc = vars.serviceId
        ? await prisma.serviceItem.findUnique({ where: { id: String(vars.serviceId) } })
        : (vars.serviceName ? await prisma.serviceItem.findFirst({ where: { name: String(vars.serviceName) } }) : null);
      const req: any[] = Array.isArray(svc?.requiredDocs) ? (svc!.requiredDocs as any[]) : [];
      const items = req.filter(d => d && d.key && d.label).map(d => ({ key: String(d.key), label: String(d.label), required: d.required !== false }));
      if (items.length) return items;
    } catch { /* fall through to the node's own list rather than creating a step with nothing on it */ }
  }
  return normalizeItems(c.checklist);
}

/**
 * Tick off what the client already sent.
 *
 * The whole point of asking for documents at request time is that nobody asks twice. Without this
 * the collect step opens with every box empty, so the officer either re-requests papers that are
 * sitting in the request or ticks them by hand from memory — and a required-item gate would block
 * completion over a document that arrived days ago.
 *
 * Only keys that MATCH are ticked; an "other" upload has no box to tick and stays an attachment.
 */
async function preTickFromRequest(requestId: string | undefined, items: ChecklistItem[]): Promise<Record<string, any>> {
  const state: Record<string, any> = {};
  if (!requestId || !items.length) return state;
  try {
    const files = await prisma.requestAttachment.findMany({ where: { requestId: String(requestId) } });
    for (const it of items) {
      const f = files.find(x => x.docKey === it.key);
      // Not verified — a human still has to look at it. Received is a fact; verified is a judgement.
      if (f) state[it.key] = { received: true, verified: false, fileRef: f.path, note: `Sent by the client: ${f.name ?? "file"}` };
    }
  } catch { /* an unreadable attachment table must not stop the step being created */ }
  return state;
}

/**
 * Which run variable a Document Type field feeds. `issue_document` reads these names when it writes
 * the renewed document back to Compliance, so a field marked "Expiry date" on the type lands in the
 * variable the issue step actually looks at — and the renewal updates the expiry instead of silently
 * keeping last year's.
 */
const FIELD_PURPOSE_VAR: Record<string, string> = {
  expiry: "newExpiry",
  number: "docNumber",
  issue: "issueDate",
  fee: "fee",
  receipt: "receipt",
};

/**
 * Capture fields for a step.
 *
 * Static by default. With `captureSource: "document_type"` the step instead inherits the fields
 * configured on the DOCUMENT TYPE the run is about (vars.docType) — so one generic step asks for
 * Iqama Number / New Expiry Date on an Iqama run and for the work-visa fields on a work-visa run,
 * without a template per document type.
 *
 * Resolved once, at step creation, and stored on the task: a later edit to the type must not change
 * what an in-flight step is asking for, the same rule the checklist snapshot follows.
 */
/**
 * Which document a STEP is about.
 *
 * A workflow routinely touches several documents — onboarding collects a passport, a medical and an
 * insurance card, each with its own fields — so the document cannot be a property of the run. It is a
 * property of the step. Defaults to the run's own document, which is what a single-document flow like
 * a renewal wants and means those templates need no configuration at all.
 */
function stepDocType(config: any, vars: Record<string, any>): string {
  const c = config ?? {};
  if (c.docTypeSource === "specific" && String(c.docType ?? "").trim()) return String(c.docType).trim();
  return String(vars.docType ?? "").trim();
}

async function resolveCaptures(config: any, vars: Record<string, any>): Promise<any[] | undefined> {
  const c = config ?? {};
  if (c.captureSource === "document_type") {
    const docType = stepDocType(c, vars);
    if (docType) {
      const dt = await prisma.documentType.findFirst({ where: { name: docType } }).catch(() => null);
      const fields: any[] = Array.isArray(dt?.fields) ? (dt!.fields as any[]) : [];
      const out = fields
        // A file upload is not a variable — it has nowhere to go in the run's data.
        .filter(f => f && f.label && String(f.type) !== "file")
        .map(f => ({
          // slug(label), not f.id: the Document Type editor regenerates field ids on every save, so
          // an id would rename the variable each time the type was edited and quietly orphan whatever
          // had already been captured under the old name.
          var: FIELD_PURPOSE_VAR[String(f.purpose ?? "")] || slug(String(f.label)),
          label: f.label,
          type: String(f.type) === "dropdown" ? "select" : (f.type || "text"),
          // Carried so completion can write the value into the right column of the document itself
          // rather than guessing from the variable name. Blank purpose → a custom field.
          purpose: String(f.purpose ?? ""),
          fieldId: f.id || slug(String(f.label)),
          ...(Array.isArray(f.options) && f.options.length ? { options: f.options } : {}),
          required: !!f.required,
        }));
      if (out.length) return out;
    }
  }
  return Array.isArray(c.captures) ? c.captures : undefined;
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

  // Close the client's request when the work it started has finished. Without this every completed
  // job needs a second, manual close, and the queue slowly fills with requests that are actually
  // done — which is how a client ends up chasing something that was delivered last week.
  // A rejected outcome is NOT resolved: the run ended, the client's request did not succeed.
  try {
    const linked = await prisma.serviceRequest.findFirst({ where: { workflowInstanceId: inst.id } });
    if (linked && String(linked.status).toLowerCase() === "accepted") {
      const done = result !== "rejected";
      const reason = linked.rejectedReason || "The process could not be completed";
      await prisma.serviceRequest.update({
        where: { id: linked.id },
        data: done ? { status: "resolved" } : { status: "rejected", rejectedReason: reason },
      });
      logNotification({
        type: "task",
        title: done ? `Request completed — ${linked.clientName ?? "client"}` : `Request could not be completed — ${linked.clientName ?? "client"}`,
        message: `${linked.number ?? "Request"} · ${inst.title}`,
      });
      // Close the loop the client can see. The acceptance message promised they could follow this
      // in the portal; the last thing it owes them is being told when it ends.
      const serviceName = String(vars.serviceName || linked.type || "") || null;
      if (done) notifyRequestCompleted({ companyId: linked.companyId ?? null, number: linked.number ?? null, serviceName });
      else notifyRequestRejected({ companyId: linked.companyId ?? null, number: linked.number ?? null, serviceName, reason });
    }
  } catch { /* the run is finished either way; a link that cannot be updated must not undo that */ }
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
      // `trigger` is what the create dialog seeds and what the Builder canvas shows; `start` is what
      // this engine and the authoring spec call it. Runs only ever worked by accident: entryNodes()
      // falls back to "any node with no incoming edge", which happened to be this one, and the switch
      // logged it as an unknown type on the way past. Draw a single edge into it and the run would
      // have had no entry point at all.
      case "trigger":
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

      // ALIASES, not a rename. The Builder writes `charge_fee` and older graphs carry `invoice` or
      // `create_invoice`, none of which this switch knew — so an invoice step drawn in the Builder fell
      // to `default:`, logged "unknown type", and the run walked on. The document was renewed and the
      // client was never billed, with nothing on screen to say a step had been dropped.
      // Renaming the stored type would have quietly rewritten templates already saved; accepting every
      // spelling fixes the existing ones too.
      case "charge_fee":
      case "invoice":
      case "create_invoice":
      case "draft_invoice": {
        // Fire a draft invoice into the Finance module — "task completion triggers invoice" from the spec.
        const c = node.config ?? {};
        const amount = Number(c.amount) || 0;
        // Whether the configured fee is what the client pays or what we charge before tax. Absent
        // means inclusive: that is how this amount has always been read, and defaulting the other way
        // would raise the price of every flow already in use without anyone asking for it.
        const includesVat = c.feeIncludesVat !== false;
        const figures = await figuresForFee(amount, includesVat);
        // An invoice raised by a workflow is still an invoice, so it follows the configured
        // sequence rather than a timestamp that collides once every million milliseconds.
        const number = await nextNumber("invoice");
        const label = c.service ?? node.label ?? "Workflow service";
        try {
          await prisma.invoice.create({ data: {
            number, companyId: inst.companyId ?? null, clientName: inst.clientName ?? null,
            ...figures,
            currency: c.currency || await homeCurrency(), status: "draft", date: nowISO().slice(0, 10),
            services: label,
            // This was the only one of the four invoice creators that stored no line items, so its tax
            // invoice printed a description with QTY, PRICE and AMOUNT all blank. The line is priced
            // from the SUBTOTAL rather than the configured figure, so the lines and the subtotal agree
            // whichever way the VAT question was answered — printing a 2,000 line above a 1,739.13
            // subtotal is the mismatch this whole area was just fixed to end.
            items: [{ name: label, units: 1, price: figures.subtotalMinor / 100 }],
          } });
          logActivity({ type: "finance", message: `Draft invoice ${number} (SAR ${(figures.totalMinor / 100).toFixed(2)}) from workflow: ${inst.title}` });
        } catch { /* non-fatal */ }
        await log("draft_invoice", nodeId, `${number} · SAR ${(figures.totalMinor / 100).toFixed(2)}${includesVat ? " (fee incl. VAT)" : ` (SAR ${amount} + VAT)`}`);
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
          // The type is already being read for leadDays; take the issuing authority from the same row.
          // Without it every issued document showed AUTHORITY "—", even though the type knows.
          const dtRow = await prisma.documentType.findFirst({ where: { name: docType } });
          const leadDays = dtRow?.leadDays ?? 30;
          const authority = dtRow?.authority ?? null;
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
              await prisma.document.create({ data: { companyId: inst.companyId, person, employeeId, docType, expiryDate: expiry || null, issueDate: issue || null, issuingAuthority: authority, docNumber: number || null, status: st.status, daysLeft: st.daysLeft } });
              await log("document.issued", nodeId, `${docType} (${subjectKind}) for ${person} → ${expiry || "?"}`);
              logActivity({ type: "compliance", message: `${docType} issued for ${person} — expiry ${expiry || "?"}${inst.clientName ? ` (${inst.clientName})` : ""}` });
              // Close the loop with the client. They were told the renewal had started; nothing
              // ever told them it finished.
              notifyDocumentRenewed({ companyId: inst.companyId, docType, person, expiryDate: expiry || null, docNumber: number || null });
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

      // A REAL pause. This used to log the intended wait and continue immediately, so a step that
      // said "wait 3 days then chase" chased instantly — the palette promised something the engine
      // did not do. The wait is recorded on the instance and the hourly tick resumes it; hours is as
      // fine-grained as this needs to be, since nothing here waits in minutes.
      // Send the paperwork somewhere, as a step of the flow.
      //
      // The last thing that happens to a renewed passport is that it goes back to the client, and that
      // was the one part no workflow could express: an officer raised the shipment by hand on another
      // screen, and the envelope had no connection to the document inside it. Raising it here links
      // both automatically, so the document can answer where it is.
      case "courier":
      case "dispatch": {
        const c = node.config ?? {};
        const direction = String(c.direction ?? "").toLowerCase() === "inbound" ? "inbound" : "outbound";
        const ref = await nextNumber("courier");
        // The document this run has been working on — set by an earlier issue/renew step. Null is a
        // normal outcome (a flow that ships something other than a tracked document); the shipment is
        // still created, it just carries no document link.
        const documentId = typeof vars.documentId === "string" && vars.documentId ? vars.documentId : null;
        // The case file this run belongs to, so the shipment shows on the task as well.
        const owningTask = await prisma.task.findFirst({ where: { workflowInstanceId: inst.id }, select: { id: true } }).catch(() => null);
        try {
          await prisma.courierShipment.create({ data: {
            ref,
            description: c.description || node.label || (direction === "inbound" ? "Document collection" : "Document delivery"),
            companyId: inst.companyId ?? null,
            clientName: inst.clientName ?? null,
            carrier: c.carrier || null,
            direction,
            // Not "in transit": nobody has handed it to a courier yet. Claiming otherwise would put a
            // parcel on the board that does not exist.
            //
            // "Requested", not "preparing", because that is the first rung of the ladder the board
            // actually draws. The old word was in no ladder at all, so every shipment this step
            // raised sat outside its own status filter — visible on the board, findable under
            // nothing. Rows written before this still resolve, through the legacy map in index.ts.
            status: "Requested",
            eta: c.eta || null,
            at: nowISO().slice(0, 10),
            documentId,
            taskId: owningTask?.id ?? null,
          } });
          logActivity({ type: "operations", message: `Courier ${ref} raised by workflow: ${inst.title}` });
        } catch { /* a shipment that cannot be raised must not strand the run */ }
        await log("courier.raised", nodeId, `${ref} · ${direction}${c.carrier ? ` · ${c.carrier}` : ""}${documentId ? " · linked to the document" : " · no document linked"}`);
        queue.push(...nextTargets(g, nodeId));
        break;
      }

      case "delay": {
        const c = node.config ?? {};
        const hours = Number(c.hours) > 0 ? Number(c.hours) : (Number(c.days) > 0 ? Number(c.days) * 24 : 0);
        if (!hours) {
          // Nothing to wait for. Passing straight through is right, but it is not a pause and the run
          // should not claim it was one.
          await log("delay.skipped", nodeId, `${node.label ?? "Delay"} — no duration set, so nothing was waited for`);
          queue.push(...nextTargets(g, nodeId));
          break;
        }
        const until = new Date(Date.now() + hours * 3600_000).toISOString();
        vars._delays = vars._delays || {};
        vars._delays[nodeId] = until;
        await log("delay.waiting", nodeId, `${node.label ?? "Delay"} — resumes ${until} (${hours}h)`);
        // Deliberately NOT queued onward: the frontier stops here and resumeDueDelays() picks it up.
        break;
      }

      case "decision": {
        const key = evalDecision(node, vars);
        await log("decision", nodeId, `${node.label ?? "Decision"} → ${key}`);
        queue.push(...nextTargets(g, nodeId, key));
        break;
      }

      // `split` / `join` are what the Builder palette saves; `parallel_*` is what this engine and the
      // authoring spec call them. Aliased rather than renamed — your templates already contain two of
      // each, and every one of them was being skipped silently.
      case "split":
      case "parallel_split":
        await log("parallel_split", nodeId, node.label);
        queue.push(...nextTargets(g, nodeId));
        break;

      case "join":
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
        // Whoever started the run may have named an owner ("Assign to" on the New task dialog). It
        // used to be collected and then ignored, so work you assigned to yourself landed on someone
        // else's desk; the fix for that made it beat everything, which is the opposite mistake — one
        // field on a creation dialog cannot express per-step intent, but it outranked the per-step
        // roles that can. A single choice of "Administrator" therefore routed the PRO-officer steps,
        // the accountant steps and the government steps all to one person, and the roles configured
        // in the builder became decorative.
        //
        // Specific beats general:
        //   1. the node's own assignee — a template author naming a person outright
        //   2. the node's ROLE — configured per step, so it decides who that step belongs to
        //   3. the run-level "Assign to" — the case owner, for steps that name no role
        //   4. unassigned — visible to the whole role pool rather than on the wrong desk
        //
        // APPROVAL steps still ignore the run assignee entirely: routing your own approval to
        // yourself defeats the control.
        const runAssignee = node.type === "approval" ? null : (typeof vars.assignee === "string" ? vars.assignee.trim() : "");
        const ownerFallback = runAssignee && runAssignee !== "Unassigned" ? runAssignee : null;
        // The id travels with the name from here on. A template-named or run-named assignee only has
        // a name, so it is resolved once, at creation — never re-derived later from the stored string.
        // The step's own facts, so a rule can route on the authority it is done at or the country
        // the run belongs to rather than only on who happens to be free this minute.
        const picked = role ? await pickAssignee(role, {
          govCenter: (typeof c.govCenter === "string" && c.govCenter.trim()) ? c.govCenter.trim() : null,
          country: typeof vars.country === "string" ? vars.country : null,
          service: typeof vars.service === "string" ? vars.service : null,
        }) : null;
        const assignee = c.assignee || picked?.name || ownerFallback;
        const assigneeId = c.assignee
          ? (await resolveStaffByName(c.assignee))?.id ?? null
          : picked?.id ?? (ownerFallback ? (await resolveStaffByName(ownerFallback))?.id ?? null : null);
        await prisma.workflowTask.create({
          data: {
            instanceId: inst.id, nodeId, nodeType: node.type,
            title: c.title || node.label || (node.type === "approval" ? "Approval" : "Task"),
            assignee,
            assigneeId,
            assigneeRole: role,
            status: "active",
            // Same story as `assignee` directly above: the dialog collects a priority, passes it in
            // as a run variable, and this ignored it — so a task raised as High carried a Medium
            // step, and the two disagreed on the same screen.
            //
            // A node's own priority wins ONLY when it says something. 37 of the 45 configured steps
            // in this system are set to "medium", which is what the builder writes when nobody chose
            // — treating that as an author's decision would let a default silently outrank the
            // person raising the work. Anything else (high/critical/low) was set on purpose and keeps.
            priority: (c.priority && c.priority !== "medium" ? c.priority : null)
              || (typeof vars.priority === "string" && vars.priority.trim() ? vars.priority.trim().toLowerCase() : null)
              || c.priority || "medium",
            dueDate: c.dueDate || null,
            slaHours: typeof c.slaHours === "number" ? c.slaHours : null,
            // Snapshotted, not read live from the template — a step someone is mid-way through must
            // keep the brief it was given.
            instructions: (typeof c.instructions === "string" && c.instructions.trim()) ? c.instructions.trim() : null,
            // The authority this step is done at, snapshotted for the same reason. This is what the
            // Government Centers queue groups by, so a step that names one appears in that portal's
            // list of work the moment it becomes active.
            govCenter: (typeof c.govCenter === "string" && c.govCenter.trim()) ? c.govCenter.trim() : null,
            // Snapshotted like everything else on the step. "The run's own document" resolves now, so
            // the rule cannot drift if the run's variables change later.
            verifyRule: String(c.verifyDocType ?? "").trim()
              ? { docType: (c.verifyDocType === "_run" ? String(vars.docType ?? "").trim() : String(c.verifyDocType).trim()), minMonths: Math.max(0, Number(c.verifyMinMonths) || 0) }
              : undefined,
            checklist: items.length ? items : undefined,
            // Pre-ticked with whatever the client already uploaded against this request. `requestId`
            // is put on the run by acceptServiceRequest, so this only fires for work that began as a
            // client request — a renewal started by the scheduler has nothing to inherit.
            checklistState: await preTickFromRequest(vars.requestId, items),
            requireVerification: !!c.requireVerification,
            captures: await resolveCaptures(c, vars),
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
        // Carried into the run's visible timeline, not just this table. A step the engine does not
        // recognise is dropped and the run still reports success — which is how an unbilled renewal
        // looked exactly like a billed one. The label is included because "unknown type charge_fee"
        // means nothing to the person reading it; "Raise invoice" does.
        await log("node.skipped", nodeId, `${node.label || "Step"} — the engine does not recognise "${node.type}", so it was skipped`);
        queue.push(...nextTargets(g, nodeId));
    }
  }

  inst.variables = vars;
  await prisma.workflowInstance.update({ where: { id: inst.id }, data: { variables: vars } });
}

// Find the entry node: an explicit start node, else any node with no incoming edge.
// Both spellings count as explicit — see the `trigger` case above. Without this the fallback was
// doing the work, and the fallback only holds while nothing points at the start node.
function entryNodes(g: Graph): string[] {
  const start = g.nodes.filter(n => n.type === "start" || n.type === "trigger");
  if (start.length) return start.map(n => n.id);
  return g.nodes.filter(n => inDegree(g, n.id) === 0).map(n => n.id);
}

/**
 * What running this template would produce, without producing it.
 *
 * Lives here, beside the engine, and walks with the engine's own `entryNodes`/`nextTargets` rather
 * than a second copy of the traversal — a preview that disagrees with what actually happens is worse
 * than no preview. `steps` counts the nodes that wait for a person, which is the same filter the
 * acceptance path uses to tell the client how many steps to expect.
 *
 * `firstStep` is the first waiting step reachable from the entry, breadth-first. It is a description
 * of the graph, not a promise about branching: a decision could route elsewhere at runtime.
 */
export async function describeTemplate(templateId: string): Promise<{
  name: string; steps: number; firstStep: string | null; hasSteps: boolean;
} | null> {
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id: templateId } }).catch(() => null);
  if (!tpl) return null;
  const g = asGraph(tpl.graph);
  const waits = (n: any) => n?.type === "task" || n?.type === "approval";

  let firstStep: string | null = null;
  const seen = new Set<string>();
  const queue = [...entryNodes(g)];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = getNode(g, id);
    if (!node) continue;
    if (waits(node)) { firstStep = node.label || node.type || "Step"; break; }
    queue.push(...nextTargets(g, id));
  }

  return { name: tpl.name, steps: g.nodes.filter(waits).length, firstStep, hasSteps: g.nodes.length > 0 };
}

export async function startInstance(templateId: string, opts: { title?: string; companyId?: string | null; clientName?: string | null; variables?: any }) {
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id: templateId } });
  if (!tpl) throw new Error("Template not found");
  // A retired template must not start new work. Hiding it from the lists is not enough: a service
  // binding, the nightly expiry job and the accept-a-request path all start runs by ID and would
  // happily keep using one long after it was uninstalled. Existing runs are left alone — retiring is
  // about stopping NEW work, not abandoning work already under way.
  if (tpl.retired) throw new Error(`"${tpl.name}" has been retired and cannot start new work`);
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

/**
 * The document a step has to check, and whether it passes.
 *
 * Shared by the route the drawer reads and by completeTask, so what the officer is shown and what the
 * server enforces cannot disagree — a gate that only exists in the UI is not a gate.
 *
 * Reads the LIVE document (most life left first), so a superseded row cannot satisfy a requirement.
 */
export async function evalVerifyRule(task: { verifyRule?: any; instanceId: string }): Promise<null | {
  docType: string; minMonths: number; ok: boolean; why: string;
  document: null | { id: string; docNumber: string | null; expiryDate: string | null; daysLeft: number; person: string; filePath: string | null };
}> {
  const rule: any = task.verifyRule;
  const docType = String(rule?.docType ?? "").trim();
  if (!docType) return null;
  const minMonths = Math.max(0, Number(rule?.minMonths) || 0);
  const inst = await prisma.workflowInstance.findUnique({ where: { id: task.instanceId } });
  const vars: any = (inst?.variables && typeof inst.variables === "object") ? inst.variables : {};
  const employeeId = vars.employeeId ? String(vars.employeeId) : null;
  const person = String(vars.person ?? vars.applicant ?? "").trim();
  const dt = await prisma.documentType.findFirst({ where: { name: docType } });
  const byCompany = dt?.subjectKind === "company";
  // Matched on the EMPLOYEE where the run knows one. A gate that resolves by name would show the
  // officer someone else's passport and let them pass a check on it — which is worse than no gate,
  // because it produces a record of a verification that never happened.
  const doc = await prisma.document.findFirst({
    where: {
      docType, companyId: inst?.companyId ?? undefined, supersededAt: null,
      ...(byCompany ? {} : (employeeId ? { employeeId } : (person ? { person } : {}))),
    },
    orderBy: [{ expiryDate: "desc" }],
  });
  // Linked run, nothing linked to it, but the name matches something. Report it as unlinked rather
  // than reaching for the name — this is the case where two same-name people diverge.
  if (!doc && !byCompany && employeeId && person) {
    const loose = await prisma.document.findFirst({ where: { docType, companyId: inst?.companyId ?? undefined, supersededAt: null, person }, orderBy: [{ expiryDate: "desc" }] });
    if (loose) return { docType, minMonths, ok: false, document: null,
      why: `A ${docType} is on file under the name "${person}" but is not linked to this employee record. Link it on the document before this step can be completed.` };
  }
  const shape = (d: typeof doc) => d ? {
    id: d.id, docNumber: d.docNumber ?? null, expiryDate: d.expiryDate ?? null, person: d.person,
    daysLeft: d.expiryDate && !isNaN(new Date(d.expiryDate).getTime()) ? Math.ceil((new Date(d.expiryDate).getTime() - Date.now()) / 86400000) : 0,
    filePath: (() => { const cd: any = d.customData ?? {}; const f = cd.filePath || cd.file; return typeof f === "string" && f.startsWith("/") ? f : null; })(),
  } : null;

  if (!doc) return { docType, minMonths, ok: false, why: `No ${docType} is on file for this ${byCompany ? "client" : "person"}.`, document: null };
  const t = doc.expiryDate ? new Date(doc.expiryDate).getTime() : NaN;
  if (isNaN(t)) return { docType, minMonths, ok: false, why: `The ${docType} on file has no expiry date recorded.`, document: shape(doc) };
  const limit = new Date(); limit.setMonth(limit.getMonth() + minMonths);
  const days = Math.ceil((t - Date.now()) / 86400000);
  if (t < limit.getTime()) {
    return { docType, minMonths, ok: false, document: shape(doc),
      why: days < 0
        ? `The ${docType} expired ${Math.abs(days)} days ago; this step needs at least ${minMonths} month${minMonths === 1 ? "" : "s"} left.`
        : `The ${docType} has ${days} days left; this step needs at least ${minMonths} month${minMonths === 1 ? "" : "s"}.` };
  }
  return { docType, minMonths, ok: true, why: `${docType} has ${days} days left.`, document: shape(doc) };
}

/**
 * Retire documents that a newer one has replaced.
 *
 * Kept rather than deleted — the old number and expiry are the only record of what the person held
 * before, and a compliance system that forgets that has no audit trail. Every reader filters on
 * `supersededAt: null`, so exactly one document of a type is authoritative for a subject.
 */
async function supersede(rows: { id: string; docNumber?: string | null; expiryDate?: string | null }[], byId: string, docType: string, person: string, instanceId?: string, nodeId?: string | null) {
  for (const r of rows) {
    if (r.id === byId) continue;
    await prisma.document.update({ where: { id: r.id }, data: { supersededAt: nowISO(), supersededById: byId } });
    if (instanceId) {
      await prisma.workflowLog.create({ data: { instanceId, nodeId: nodeId ?? null, action: "document.superseded",
        detail: `${docType} for ${person}: ${r.docNumber ?? "no number"} (exp ${r.expiryDate ?? "none"}) replaced`, actor: "engine", at: nowISO() } }).catch(() => {});
    }
    logActivity({ type: "compliance", message: `${docType} for ${person}: an older record (${r.docNumber ?? "no number"}) was superseded` });
  }
}

/** Is this instance parked on a `delay` node? Its waits live in variables._delays as { nodeId: ISO }. */
function hasPendingDelay(inst: any): boolean {
  const d = (inst?.variables as any)?._delays;
  return !!d && typeof d === "object" && Object.keys(d).length > 0;
}

/**
 * Resume every run whose delay has come due. Called by the hourly tick.
 *
 * Idempotent: the wait is DELETED from the instance before the frontier advances, so a tick that
 * overlaps the previous one cannot advance the same pause twice. A run whose template has since lost
 * the node is released rather than left parked for good.
 */
export async function resumeDueDelays(): Promise<{ waiting: number; resumed: number; details: string[] }> {
  const out = { waiting: 0, resumed: 0, details: [] as string[] };
  const running = await prisma.workflowInstance.findMany({ where: { status: "running" } });
  const now = Date.now();
  for (const inst of running) {
    const vars: any = (inst.variables && typeof inst.variables === "object") ? inst.variables : {};
    const delays: Record<string, string> = vars._delays || {};
    const nodeIds = Object.keys(delays);
    if (!nodeIds.length) continue;
    const due = nodeIds.filter(id => { const t = new Date(delays[id]).getTime(); return !isNaN(t) && t <= now; });
    out.waiting += nodeIds.length - due.length;
    if (!due.length) continue;

    const tpl = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
    const g = asGraph(tpl?.graph);
    for (const nodeId of due) {
      delete delays[nodeId];
      vars._delays = delays;
      // Cleared FIRST, so a failure below cannot leave a wait that fires again every hour.
      await prisma.workflowInstance.update({ where: { id: inst.id }, data: { variables: vars } });
      await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId, action: "delay.resumed", detail: "the wait is over", actor: "engine", at: nowISO() } });
      const targets = nextTargets(g, nodeId);
      if (!targets.length) {
        out.details.push(`${inst.title}: waited at ${nodeId} and had nowhere to go — closing`);
        await finalizeInstance({ ...inst, variables: vars }, String(vars._result || "completed").toLowerCase(), nodeId, "After delay");
        out.resumed++;
        continue;
      }
      await runFrontier({ ...inst, variables: vars }, g, targets);
      out.resumed++;
      out.details.push(`${inst.title}: resumed after delay`);
    }
    // Same zombie guard as completeTask: a resumed run that produced no work and no end node must not
    // be left running with nothing open.
    const fresh = await prisma.workflowInstance.findUnique({ where: { id: inst.id } });
    if (fresh && fresh.status === "running" && !hasPendingDelay(fresh)) {
      const open = await prisma.workflowTask.count({ where: { instanceId: inst.id, status: "active" } });
      if (open === 0) await finalizeInstance(fresh, String((fresh.variables as any)?._result || "completed").toLowerCase(), null, "Auto-close after delay");
    }
  }
  return out;
}

export async function completeTask(taskId: string, opts: { actor?: string; outcome?: string; checklist?: any; variables?: any }) {
  const task = await prisma.workflowTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Task not found");
  if (task.status !== "active") throw new Error("This task is already completed");
  const inst = await prisma.workflowInstance.findUnique({ where: { id: task.instanceId } });
  if (!inst) throw new Error("Instance not found");
  const tpl = await prisma.workflowTemplate.findUnique({ where: { id: inst.templateId } });
  const g = asGraph(tpl?.graph);

  // The document gate, enforced HERE and not only in the drawer. A check that lives in the UI is a
  // suggestion: anything calling the API directly walks straight past it. No override — a control any
  // officer can wave through is not a control, which is the same stance the renewal prerequisite takes.
  {
    const v = await evalVerifyRule(task);
    if (v && !v.ok) throw new Error(v.why);
  }

  // Reject nonsense dates at the boundary rather than letting them through.
  //
  // A step captured "not-a-date" and "31/13/2026" and completed without complaint. Downstream,
  // issue_document's statusOf() treats an unparseable date as `{ status: "valid" }`, so the run
  // wrote a document whose expiry printed as "?" — a compliance record with no usable expiry, which
  // is worse than no record. The value is checked here, once, where it enters the engine.
  {
    const node0 = getNode(g, task.nodeId);
    // Read the captures the TASK was created with, not the node's config. They are the same thing for
    // a statically configured step, but a step inheriting its fields from the document type has none
    // on the node — so validating against the node would skip every dynamic field, and a bad date
    // would sail through into issue_document exactly as it used to.
    const caps0: any[] = Array.isArray(task.captures)
      ? (task.captures as any[])
      : (Array.isArray((node0?.config as any)?.captures) ? (node0!.config as any).captures : []);
    const supplied = (opts.variables && typeof opts.variables === "object") ? opts.variables as Record<string, any> : {};
    for (const cap of caps0) {
      if (!cap || String(cap.type) !== "date") continue;
      const raw = supplied[cap.var];
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const t0 = new Date(String(raw)).getTime();
      // Also rejects 31/13/2026, which Date parses as Invalid rather than rolling over.
      if (isNaN(t0)) throw new Error(`${cap.label || cap.var}: "${raw}" is not a valid date`);
    }
  }

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

  // Write what was captured onto the DOCUMENT this step is about.
  //
  // Run variables are flat, so they cannot hold two documents at once: a passport step and an Iqama
  // step would both write `newExpiry` and the second would silently overwrite the first. A workflow
  // that touches several documents therefore has to put each value on its own document row, which is
  // where the data belongs anyway — it shows up in Compliance the moment the step is completed,
  // instead of only if an Issue/renew node happens to run later in the flow.
  try {
    const node1 = getNode(g, task.nodeId);
    const caps1: any[] = Array.isArray(task.captures) ? (task.captures as any[]) : [];
    const docType1 = stepDocType(node1?.config, vars);
    const suppliedAny = caps1.some(c => {
      const v = (opts.variables ?? {})[c?.var];
      return v !== undefined && v !== null && String(v).trim() !== "";
    });
    if (docType1 && caps1.length && suppliedAny && inst.companyId) {
      const dt1 = await prisma.documentType.findFirst({ where: { name: docType1 } });
      const byCompany = (dt1?.subjectKind ?? "employee") === "company";
      const employeeId = byCompany ? null : (vars.employeeId ? String(vars.employeeId) : null);
      let person = byCompany ? (inst.clientName || "Company") : String(vars.applicant ?? vars.employee ?? "");
      if (!byCompany && !person && employeeId) {
        const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
        if (emp) person = emp.name;
      }

      if (person) {
        // The LIVE document of this type for this subject, most life left first. A subject could hold
        // two of the same type, and this used to take whichever the database returned — so a renewal
        // could update the wrong passport and leave the real one untouched.
        const existing = await prisma.document.findFirst({
          where: { docType: docType1, companyId: inst.companyId, supersededAt: null, ...(employeeId ? { employeeId } : { person }) },
          orderBy: [{ expiryDate: "desc" }],
        });
        // Anything else still live for the same subject and type is history the moment this step
        // records the current one. Kept, not deleted: the old number and expiry are the audit trail.
        //
        // SUPERSEDING REQUIRES A LINKED EMPLOYEE. Two people can share a name, and retiring a document
        // is destructive-ish — it takes a real record out of every list that matters. Matching on a
        // name would let one Mohammed Ali's renewal retire the other one's passport. With no
        // employeeId, nothing is superseded and the duplicate is reported instead of resolved by guess.
        const canSupersede = !!employeeId || dt1?.subjectKind === "company";
        const alsoLive = canSupersede
          ? await prisma.document.findMany({
              where: { docType: docType1, companyId: inst.companyId, supersededAt: null,
                ...(employeeId ? { employeeId } : {}), ...(existing ? { NOT: { id: existing.id } } : {}) },
            })
          : [];
        if (!canSupersede) {
          const others = await prisma.document.count({ where: { docType: docType1, companyId: inst.companyId, supersededAt: null, person, ...(existing ? { NOT: { id: existing.id } } : {}) } });
          if (others) {
            await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: "document.supersede_skipped",
              detail: `${others} other live ${docType1} for the name "${person}" — this run has no linked employee, so nothing was retired on a name match`, actor: "engine", at: nowISO() } }).catch(() => {});
            logActivity({ type: "alert", message: `⚠ ${docType1} for "${person}": ${others} duplicate left in place — the run is not linked to an employee record, and a name is not enough to retire someone's document` });
          }
        }

        // Purposed fields land in the document's own columns; everything else is a custom field of
        // that type, keyed by field id the way customData already is.
        const val = (purpose: string) => {
          const cap = caps1.find(c => String(c?.purpose ?? "") === purpose);
          const raw = cap ? (opts.variables ?? {})[cap.var] : undefined;
          return raw === undefined || raw === null || String(raw).trim() === "" ? null : String(raw).trim();
        };
        const expiry = val("expiry"), number = val("number"), issue = val("issue");
        const custom: Record<string, any> = { ...((existing?.customData as any) ?? {}) };
        for (const cap of caps1) {
          if (String(cap?.purpose ?? "")) continue;
          const raw = (opts.variables ?? {})[cap.var];
          if (raw !== undefined && raw !== null && String(raw).trim() !== "") custom[cap.fieldId || cap.var] = raw;
        }

        const lead = dt1?.leadDays ?? 30;
        const effExpiry = expiry ?? existing?.expiryDate ?? null;
        const t1 = effExpiry ? new Date(effExpiry).getTime() : NaN;
        const daysLeft = isNaN(t1) ? (existing?.daysLeft ?? 0) : Math.round((t1 - Date.now()) / 86400000);
        const status = isNaN(t1) ? (existing?.status ?? "valid") : daysLeft < 0 ? "overdue" : daysLeft <= lead ? "expiring" : "valid";

        if (existing) {
          const hist = Array.isArray(existing.history) ? (existing.history as any[]) : [];
          // Only record a version when something a person would recognise actually moved.
          if ((expiry && expiry !== existing.expiryDate) || (number && number !== existing.docNumber)) {
            hist.unshift({ at: nowISO(), by: opts.actor ?? "workflow", oldExpiry: existing.expiryDate ?? undefined, newExpiry: expiry ?? existing.expiryDate,
              oldNumber: existing.docNumber ?? undefined, newNumber: number ?? existing.docNumber, note: `Recorded on "${task.title}"` });
          }
          await prisma.document.update({
            where: { id: existing.id },
            data: { expiryDate: effExpiry, docNumber: number ?? existing.docNumber, issueDate: issue ?? existing.issueDate,
              customData: custom, status, daysLeft, history: hist },
          });
          await supersede(alsoLive, existing.id, docType1, person, inst.id, task.nodeId);
          await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: "document.updated", detail: `${docType1} for ${person} → ${expiry ?? "expiry unchanged"}`, actor: opts.actor ?? "engine", at: nowISO() } });
          logActivity({ type: "compliance", message: `${docType1} updated for ${person} from "${task.title}"${inst.clientName ? ` (${inst.clientName})` : ""}` });
        } else {
          // Create if absent: onboarding records a document that has never existed before, and
          // refusing to would mean the captured details had nowhere to go.
          const made = await prisma.document.create({
            data: { companyId: inst.companyId, person, employeeId, docType: docType1, expiryDate: effExpiry,
              issueDate: issue, docNumber: number, issuingAuthority: dt1?.authority ?? null,
              customData: custom, status, daysLeft },
          });
          await supersede(alsoLive, made.id, docType1, person, inst.id, task.nodeId);
          await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: "document.created", detail: `${docType1} for ${person} → ${expiry ?? "no expiry"}`, actor: opts.actor ?? "engine", at: nowISO() } });
          logActivity({ type: "compliance", message: `${docType1} filed for ${person} from "${task.title}"${inst.clientName ? ` (${inst.clientName})` : ""}` });
        }
      }
    }
  } catch (e: any) {
    // Completing the step must not fail because the write-back did — the officer did their part. But
    // it must not vanish either: a step that reports success while the document was never updated is
    // the failure mode this whole feature exists to remove.
    await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: "document.write_failed", detail: String(e?.message ?? e).slice(0, 400), actor: "engine", at: nowISO() } }).catch(() => {});
    logActivity({ type: "alert", message: `⚠ "${task.title}" completed but its document could not be updated — ${String(e?.message ?? e).slice(0, 160)}` });
  }

  const finalStatus = task.nodeType === "approval" ? (opts.outcome === "reject" ? "rejected" : "approved") : "done";
  await prisma.workflowTask.update({
    where: { id: taskId },
    data: { status: finalStatus, outcome: opts.outcome ?? null, completedBy: opts.actor ?? null, completedAt: nowISO(),
             checklist: Array.isArray(opts.checklist) ? opts.checklist : task.checklist as any },
  });
  // The reviewer's note is the reason for the decision — the one thing an audit actually wants to
  // read back. It was collected in the UI and dropped; now it rides on the log line beside the
  // step it explains.
  const _note = String((opts.variables as any)?.decisionNote ?? "").trim();
  await prisma.workflowLog.create({ data: { instanceId: inst.id, nodeId: task.nodeId, action: `${task.nodeType}.${finalStatus}`, detail: _note ? `${task.title} — ${_note}` : task.title, actor: opts.actor ?? null, at: nowISO() } });

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
    // A run waiting on a delay has no open task BY DESIGN — it is not a zombie. Without this check the
    // net would close the instance the moment it reached the pause, which is the opposite of waiting.
    if (open === 0 && !hasPendingDelay(fresh)) {
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
/**
 * THE CHECKS THAT NEED THE DATABASE.
 *
 * validateGraph is deliberately pure — it reads the graph and nothing else, which is why it can run
 * anywhere and never lies about what the engine does. But the most damaging mistakes in a template
 * are not shape mistakes, they are REFERENCE mistakes: a step issuing a document type that belongs
 * to another country, a checklist rule that was deleted last month, a role nobody holds. Every one
 * of those saves cleanly, reads correctly, and fails on a real client.
 *
 * The country check is the one worth having. Nothing stops a Saudi workflow naming a document type
 * filed under AE — it resolves here only because this database holds every country, and it issues a
 * document against the wrong market's rules, with the wrong authority and the wrong lead days.
 *
 * Reported on every save alongside the graph issues; ENFORCED only on the draft → active
 * transition, the same line the roleless-step rule already draws.
 */
async function validateReferences(graph: any, tpl: { country?: string | null }): Promise<GraphIssue[]> {
  const out: GraphIssue[] = [];
  const nodes: any[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const country = String(tpl?.country ?? "").trim().toUpperCase();

  const docNodes = nodes.filter(n => n?.type === "issue_document");
  if (docNodes.length) {
    const wanted = [...new Set(docNodes.map(n => String(n?.config?.docType ?? "").trim()).filter(Boolean))];
    const rows = await prisma.documentType.findMany({ where: { name: { in: wanted } }, select: { name: true, country: true, retired: true } });
    for (const n of docNodes) {
      const name = String(n?.config?.docType ?? "").trim();
      const label = n.label || n.id;
      if (!name) { out.push({ level: "error", nodeId: n.id, node: label, message: `"${label}" issues a document but names no type.` }); continue; }
      const hits = rows.filter(r => r.name === name);
      if (!hits.length) {
        out.push({ level: "error", nodeId: n.id, node: label, message: `"${label}" issues "${name}", which is not a document type on this installation. It would still create a document — with no authority and default lead days.` });
        continue;
      }
      if (hits.every(h => h.retired)) {
        out.push({ level: "error", nodeId: n.id, node: label, message: `"${label}" issues "${name}", which is retired.` });
        continue;
      }
      // The one that matters: right name, wrong market.
      if (country && !hits.some(h => String(h.country ?? "").toUpperCase() === country)) {
        const where = [...new Set(hits.map(h => h.country ?? "no country"))].join(", ");
        out.push({ level: "error", nodeId: n.id, node: label, message: `"${label}" issues "${name}", which is filed under ${where} — this workflow is ${country}. It resolves here only because this database holds every country.` });
      }
    }
  }

  const ruleIds = [...new Set(nodes.map(n => String(n?.config?.checklistRuleId ?? "").trim()).filter(Boolean))];
  if (ruleIds.length) {
    const found = await prisma.checklistRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, retired: true } });
    for (const n of nodes) {
      const id = String(n?.config?.checklistRuleId ?? "").trim();
      if (!id || n?.config?.checklistSource !== "dynamic") continue;
      const hit = found.find(f => f.id === id);
      const label = n.label || n.id;
      if (!hit) out.push({ level: "error", nodeId: n.id, node: label, message: `"${label}" uses a checklist rule that no longer exists, so it falls back to its own list — which is usually empty.` });
      else if (hit.retired) out.push({ level: "warning", nodeId: n.id, node: label, message: `"${label}" uses the retired rule "${hit.name}".` });
    }
  }

  // A role nobody holds is work that lands on an empty desk.
  const roles = [...new Set(nodes.flatMap(n => [n?.config?.assigneeRole, n?.config?.approverRole]).map(r => String(r ?? "").trim()).filter(Boolean))];
  if (roles.length) {
    const builtIn = new Set(["super_admin", "admin", "pro_officer", "accountant", "sales", "client_admin"]);
    const rolesRow = await prisma.appSetting.findUnique({ where: { key: "roles" } });
    const custom = new Set((Array.isArray(rolesRow?.value) ? (rolesRow!.value as any[]) : []).map(r => String(r?.id ?? "")));
    for (const n of nodes) {
      for (const key of ["assigneeRole", "approverRole"]) {
        const r = String(n?.config?.[key] ?? "").trim();
        if (!r || builtIn.has(r) || custom.has(r)) continue;
        out.push({ level: "error", nodeId: n.id, node: n.label || n.id, message: `"${n.label || n.id}" is owned by the role "${r}", which does not exist.` });
      }
    }
  }
  return out;
}

R.get("/templates", requireAuth, requireStaff, async (req, res) => {
  // Templates are served here rather than by the generic CRUD helper, so the retired filter that
  // covers every other collection does NOT reach them. Without this line a workflow retired by a pack
  // uninstall stays in the builder list and in every picker — retired in name only, which is worse
  // than not retiring it at all because the label says otherwise.
  const includeRetired = String((req.query as any)?.includeRetired ?? "") === "1";
  res.json(await prisma.workflowTemplate.findMany({
    where: includeRetired ? {} : { retired: false },
    orderBy: { name: "asc" },
  }));
});
R.get("/templates/:id", requireAuth, requireStaff, async (req, res) => {
  const t = await prisma.workflowTemplate.findUnique({ where: { id: req.params.id }, include: { instances: { select: { id: true, status: true } } } });
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json({ ...t, validation: [...validateGraph(t.graph, t), ...(await validateReferences(t.graph, t))] });
});
R.post("/templates", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    // `country` was silently dropped here and in the PUT below, so every workflow built in the
    // Builder was country-less for ever — only the pack installer ever set one. That is why nothing
    // could show which market a workflow belongs to, and why a cross-country document reference
    // could not be caught: the check has nothing to compare against when the template names no
    // country at all.
    const { name, description, trigger, triggerConfig, entityType, graph, active, country } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "Name is required" });
    const t = await prisma.workflowTemplate.create({
      data: { name: String(name).trim(), description: description ?? null, trigger: trigger || "manual",
              triggerConfig: triggerConfig ?? undefined, entityType: entityType || "generic",
              country: country ? String(country).trim().toUpperCase() : null,
              graph: graph ?? { nodes: [], edges: [] }, active: !!active, createdAt: nowISO() },
    });
    logActivity({ type: "task", message: `Workflow template created: ${t.name}` });
    res.status(201).json({ ...t, validation: validateGraph(t.graph, t) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.put("/templates/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { name, description, trigger, triggerConfig, entityType, graph, active, version, country } = req.body ?? {};
    const data: any = {};
    if (name !== undefined) data.name = String(name).trim();
    if (description !== undefined) data.description = description;
    if (trigger !== undefined) data.trigger = trigger;
    if (triggerConfig !== undefined) data.triggerConfig = triggerConfig;
    if (entityType !== undefined) data.entityType = entityType;
    if (graph !== undefined) data.graph = graph;
    if (active !== undefined) data.active = !!active;
    if (version !== undefined) data.version = version;
    if (country !== undefined) data.country = country ? String(country).trim().toUpperCase() : null;

    // ── Going live is the moment the roles have to exist ──────────────────────────────────────
    // Saving stays unblocked — a half-built template is a normal thing to leave the Builder holding,
    // and that is the whole reason validateGraph only ever reports. Activating is different: from
    // here the graph runs against real clients, and a `task` step with no role produces work that
    // lands unassigned and notifies nobody. In a business whose deadlines are government deadlines,
    // "sitting in a pile somebody will spot eventually" is how a fine happens.
    //
    // Only checked on the DRAFT → ACTIVE transition. Editing a template that is already live must
    // not be blocked by this — that would strand whoever is halfway through fixing it, and the runs
    // in flight are unaffected by the template anyway.
    if (data.active === true) {
      const current = await prisma.workflowTemplate.findUnique({ where: { id: req.params.id }, select: { active: true, graph: true } });
      if (current && !current.active) {
        const missing = stepsMissingRole(graph !== undefined ? graph : current.graph);
        if (missing.length) {
          const names = missing.map(n => `"${n.label || n.type || n.id}"`);
          const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "");
          return res.status(400).json({
            error: `${missing.length === 1 ? "One step names" : `${missing.length} steps name`} no role: ${shown}. Work from ${missing.length === 1 ? "it" : "them"} would land unassigned and notify nobody. Set "Assigned role" on each, then activate.`,
            steps: missing.map(n => ({ id: n.id, label: n.label || n.type || n.id })),
          });
        }
        // Same line, for the references. A document type from the wrong country, a checklist rule
        // that was deleted, a role nobody holds: each of these saves cleanly and fails on a real
        // client, which is exactly the kind of thing that must not reach one.
        const tplNow = await prisma.workflowTemplate.findUnique({ where: { id: req.params.id }, select: { country: true } });
        const refs = (await validateReferences(graph !== undefined ? graph : current.graph, tplNow ?? {}))
          .filter(i => i.level === "error");
        if (refs.length) {
          return res.status(400).json({
            error: `${refs.length === 1 ? "One reference does" : `${refs.length} references do`} not resolve: ${refs.slice(0, 3).map(i => i.message).join(" ")}${refs.length > 3 ? ` (and ${refs.length - 3} more)` : ""}`,
            issues: refs,
          });
        }
      }
    }

    const t = await prisma.workflowTemplate.update({ where: { id: req.params.id }, data });
    // Told on the way out, every time, whatever changed. Never blocking: a half-built template is a
    // normal thing to leave the Builder holding. The point is that "saved" stops implying "will work".
    res.json({ ...t, validation: [...validateGraph(t.graph, t), ...(await validateReferences(t.graph, t))] });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
/**
 * Remove a template — but never its history.
 *
 * This used to delete every instance of the template first, so removing a workflow erased the record
 * of every case that had ever run through it. That is not a template being deleted, it is a year of
 * work disappearing, and there was no way to tell from the button which one you were about to do.
 *
 * So it follows the rule the rest of this app already uses. A template nothing has ever run is
 * DELETED; one with runs behind it is RETIRED — it leaves the builder and every picker, its runs stay
 * exactly where they are, and `?force=1` is refused rather than offered, because there is no version
 * of "delete the history too" that is safe by accident.
 */
R.delete("/templates/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const id = String(req.params.id);
    const tpl = await prisma.workflowTemplate.findUnique({ where: { id } });
    if (!tpl) return res.status(404).json({ error: "No such workflow" });

    const runs = await prisma.workflowInstance.count({ where: { templateId: id } });
    const live = await prisma.workflowInstance.count({ where: { templateId: id, status: "running" } });
    // A running case has open tasks on somebody's list. Retiring it out from under them would leave
    // work nobody can finish and no template to explain it.
    if (live) {
      return res.status(409).json({
        error: `${live} case${live === 1 ? " is" : "s are"} still running on this workflow. Finish or cancel ${live === 1 ? "it" : "them"} first.`,
        running: live, runs,
      });
    }
    if (runs) {
      await prisma.workflowTemplate.update({ where: { id }, data: { retired: true, active: false } });
      return res.json({ retired: true, runs,
        message: `Retired — ${runs} case${runs === 1 ? " keeps its" : "s keep their"} history.` });
    }
    await prisma.workflowTemplate.delete({ where: { id } });
    res.json({ deleted: true, runs: 0, message: "Deleted — nothing had ever run on it." });
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
    // Close the task row that describes this run too. Cancelling the workflow while its task stays
    // open leaves an officer with work in their inbox for something that was called off, and the
    // two drift apart permanently. `done` is left alone — a finished task is a record, not a
    // loose end, and a cancellation should not rewrite it.
    const closed = await prisma.task.updateMany({
      where: { workflowInstanceId: inst.id, NOT: { status: "done" } },
      data: { status: "cancelled" },
    });
    await prisma.workflowLog.create({ data: { instanceId: inst.id, action: "instance.cancelled", detail: closed.count ? `${closed.count} linked task${closed.count === 1 ? "" : "s"} closed` : null, actor: (req as any).auth?.sub, at: nowISO() } });
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
/**
 * The document this step has to check, and the verdict — the same call completeTask makes, so the
 * drawer can never show a green light the server would refuse.
 */
R.get("/tasks/:id/verify", requireAuth, requireStaff, async (req, res) => {
  const task = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json(await evalVerifyRule(task) ?? { docType: null });
});
/**
 * The client's login for the authority this step is done at.
 *
 * Never returns the password. It answers "is there one, and which" so the officer stops hunting
 * through the vault by client and guessing from labels; revealing the secret still goes through
 * /api/credentials/:id/reveal with its own admin-only gate, its human check and its audit entry.
 * Widening who may SEE a client's government login is a security decision, not a convenience one,
 * so this deliberately does not do it — a PRO officer learns the credential exists and who to ask.
 */
R.get("/tasks/:id/credential", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const task = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
  if (!task) return res.status(404).json({ error: "Task not found" });
  if (!task.govCenter) return res.json({ portal: null, found: false });

  const inst = await prisma.workflowInstance.findUnique({ where: { id: task.instanceId }, select: { companyId: true } });
  if (!inst?.companyId) return res.json({ portal: task.govCenter, found: false, reason: "This run is not attached to a client, so there is no vault to look in." });

  const cred = await prisma.siteCredential.findFirst({
    where: { companyId: inst.companyId, govCenter: task.govCenter },
    select: { id: true, label: true, url: true, username: true },
  });
  if (!cred) return res.json({ portal: task.govCenter, found: false, reason: `No ${task.govCenter} login is stored for this client.` });

  // Reveal is admin-only, exactly as the vault screen is. Told plainly rather than shown a button
  // that returns 403.
  const canReveal = a?.role === "admin" || a?.role === "super_admin";
  res.json({ portal: task.govCenter, found: true, ...cred, canReveal });
});

R.get("/tasks", requireAuth, requireStaff, async (req, res) => {
  const where: any = {};
  if (req.query.instanceId) where.instanceId = String(req.query.instanceId);
  res.json(await prisma.workflowTask.findMany({ where, orderBy: { id: "desc" } }));
});
/**
 * MAY THIS PERSON ACT ON THIS STEP — the one answer, asked in two places.
 *
 * It was the same expression written out twice, in the checklist route and the complete route. Two
 * copies of a permission check is one copy that eventually stops matching the other, and the half
 * that gets forgotten is always the one nobody is testing.
 *
 * The rungs, narrowest first:
 *   · an admin, who moves anything
 *   · the role the step names, which is how templates address work
 *   · the person the step names
 *   · nobody named at all — a step in the open pool
 *   · A TEAM LEAD, for a step belonging to one of THEIR OWN people.
 *
 * That last rung is new, and it is deliberately not "a lead may approve anything". It requires the
 * step to sit with somebody in their team, which means a lead approving work is always approving
 * SOMEBODY ELSE'S — the second pair of eyes an approval step exists to be. A lead cannot use it to
 * reach a step assigned to a person in another team, and it grants nothing at all on their own
 * steps, where they already stood or did not on the rungs above.
 */
async function mayActOnTask(
  a: { sub?: string; role?: string },
  me: { name?: string | null } | null,
  task: { assigneeRole: string | null; assignee: string | null; assigneeId: string | null },
): Promise<boolean> {
  if (a.role === "admin" || a.role === "super_admin") return true;
  if (task.assigneeRole && task.assigneeRole === a.role) return true;
  if (task.assignee && me?.name && task.assignee === me.name) return true;
  if (!task.assigneeRole && !task.assignee) return true;

  if (!task.assigneeId || task.assigneeId === a.sub) return false;
  const { visibleUserIds } = await import("./visibility.js");
  const vis = await visibleUserIds(a);
  return vis.scope === "team" && !!vis.ids && vis.ids.includes(task.assigneeId);
}

// Update a task's checklist state WITHOUT changing status (partial save + per-item receive/verify/reject).
R.post("/tasks/:id/checklist", requireAuth, requireStaff, async (req, res) => {
  try {
    const a = (req as any).auth;
    const task = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status !== "active") return res.status(400).json({ error: "This step is already completed" });
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const isAdmin = a.role === "admin" || a.role === "super_admin";
    const allowed = await mayActOnTask(a, me, task);
    if (!allowed) return res.status(403).json({ error: "This step is assigned to another role" });
    const { checklistState, itemKey, action, note, fileRef } = req.body ?? {};
    const state = effectiveState(task);
    const logItem = (act: string, detail: string) => prisma.workflowLog.create({ data: { instanceId: task.instanceId, nodeId: task.nodeId, action: act, detail, actor: me?.name ?? a.sub, at: nowISO() } });
    if (itemKey && action) {
      const s = { ...(state[itemKey] || {}) };
      if (fileRef !== undefined) s.fileRef = fileRef; // reference/receipt no. or file id (upload UI later)
      if (action === "receive") { s.received = true; s.rejected = false; if (note !== undefined) s.note = note; await logItem("checklist.item.received", `${itemKey}${s.fileRef ? ` · ref ${s.fileRef}` : ""}`); }
      else if (action === "unreceive") { s.received = false; s.verified = false; await logItem("checklist.item.unreceived", itemKey); }
      else if (action === "verify") { s.received = true; s.verified = true; s.rejected = false; await logItem("checklist.item.verified", itemKey); }
      // A rejection is its own state. The server only cleared received/verified, so a document that
      // was TURNED DOWN was indistinguishable from one that never arrived — the client UI showed a
      // rejected badge from local state that vanished on reload, and nothing downstream could act on it.
      else if (action === "reject") { s.received = false; s.verified = false; s.rejected = true; if (note !== undefined) s.note = note; await logItem("checklist.item.rejected", `${itemKey}${note ? ` — ${note}` : ""}`); }
      else if (action === "note") { if (note !== undefined) s.note = note; }
      state[itemKey] = s;
    } else if (checklistState && typeof checklistState === "object") {
      Object.assign(state, checklistState); // bulk partial save
    }
    const updated = await prisma.workflowTask.update({ where: { id: task.id }, data: { checklistState: state } });

    // Surface the block on the task that carries this run, so it stops reading "To do" while its
    // step cannot advance. Derived from the whole checklist, never from the one item just touched:
    // un-rejecting the last outstanding document has to clear the flag as well as set it.
    try {
      const items = normalizeItems(task.checklist);
      const rejected = items.filter(it => it.required && (state as any)[it.key]?.rejected)
        .map(it => it.label || it.key);
      const linked = await prisma.task.findFirst({ where: { workflowInstanceId: task.instanceId, NOT: { status: "done" } } });
      if (linked) {
        const blockedBy = rejected.length
          ? { reason: `Rejected: ${rejected.join(", ")}`, stepId: task.id, at: nowISO() }
          : null;
        const had = !!(linked as any).blockedBy;
        if (rejected.length || had) {
          await prisma.task.update({ where: { id: linked.id }, data: { blockedBy: blockedBy as any } });
        }
      }
    } catch { /* the checklist write already succeeded; the flag is a convenience, not the record */ }

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
    const allowed = await mayActOnTask(a, me, task);
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
/**
 * WHERE EACH RULE IS ACTUALLY USED — one answer, two readers.
 *
 * The delete guard and the rules screen both need this. Computing it twice is how the screen ends up
 * saying "not used anywhere" about a rule the guard then refuses to delete, so it is written once and
 * both call it. Returns a Map of ruleId → plain sentences, already in the words a person would use.
 */
async function checklistRuleUsage(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const add = (id: string, what: string) => out.set(id, [...(out.get(id) ?? []), what]);

  for (const st of await prisma.pipelineStage.findMany({ where: { checklistRuleId: { not: null }, retired: false }, select: { name: true, country: true, checklistRuleId: true } })) {
    add(String(st.checklistRuleId), `Pipeline stage "${st.name}"${st.country ? ` · ${st.country}` : ""}`);
  }
  for (const t of await prisma.workflowTemplate.findMany({ select: { name: true, graph: true } })) {
    for (const n of (((t.graph as any)?.nodes ?? []) as any[])) {
      const id = String(n?.config?.checklistRuleId ?? "").trim();
      if (id) add(id, `Workflow "${t.name}" → step "${n.label ?? n.id}"`);
    }
  }
  return out;
}

// Checklist rules (dynamic per-client document sets) CRUD — admin/super_admin for writes.
R.get("/checklist-rules", requireAuth, requireStaff, async (_req, res) => {
  const [rules, usage] = await Promise.all([
    prisma.checklistRule.findMany({ orderBy: { name: "asc" } }),
    checklistRuleUsage(),
  ]);
  // `usedBy` travels with the rule so the screen can say what a change will affect BEFORE somebody
  // makes it — the delete guard already knew this and only ever said so at the moment of refusal.
  res.json(rules.map(r => ({ ...r, usedBy: usage.get(r.id) ?? [] })));
});
R.post("/checklist-rules", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { name, rows, country } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "Name required" });
    // COUNTRY, defaulted rather than left null. A rule with no country appears in every country's
    // pickers — the exact problem the column was added to solve — and it cannot travel in a pack.
    const c = String(country ?? "").trim().toUpperCase() || (await homeCountry());
    res.status(201).json(await prisma.checklistRule.create({ data: { name: String(name), country: c, rows: rows ?? [] } }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.put("/checklist-rules/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    const { name, rows, country } = req.body ?? {};
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (rows !== undefined) data.rows = rows;
    if (country !== undefined) data.country = String(country ?? "").trim().toUpperCase() || null;
    // Editing a pack-installed rule marks it modified, so an upgrade shows a diff instead of
    // silently overwriting somebody's changes — the same contract every other packable row has.
    data.packModified = true;
    res.json(await prisma.checklistRule.update({ where: { id: req.params.id }, data }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
R.delete("/checklist-rules/:id", requireAuth, requireStaff, requireWriteRole, async (req, res) => {
  try {
    // WHO IS STILL POINTING AT IT. A rule can be named by a pipeline stage and by any number of
    // workflow steps; deleting it leaves those pointing at nothing, and a step whose checklist
    // silently became empty is the kind of failure nobody notices until an audit.
    const id = req.params.id;
    const used = (await checklistRuleUsage()).get(id) ?? [];
    if (used.length) {
      return res.status(409).json({ error: `Still in use by ${used.join(", ")}. Point those somewhere else first.`, usedBy: used });
    }
    await prisma.checklistRule.delete({ where: { id } });
    res.status(204).end();
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// Delegate a workflow step to a specific person (admin only). Clears the role gate so the named person owns it.
R.post("/tasks/:id/reassign", requireAuth, requireStaff, async (req, res) => {
  const a = (req as any).auth;
  const isAdmin = a.role === "admin" || a.role === "super_admin";
  try {
    const { assignee } = req.body ?? {};
    const cur = await prisma.workflowTask.findUnique({ where: { id: req.params.id } });
    if (!cur) return res.status(404).json({ error: "Step not found" });

    // CLAIMING is not delegating. A step left to a role sits in a shared queue that every holder of
    // that role can see, and taking one out of it is ordinary work — requiring an admin for that
    // would mean nobody could ever pick up their own team's queue. It is allowed only in the one
    // shape that cannot move work onto anybody else:
    //   • the step is currently unclaimed,
    //   • it is queued to a role the caller actually holds,
    //   • and they are assigning it to THEMSELVES.
    // Anything else — moving a step to another person, or off someone who already has it — is
    // delegation and stays admin-only.
    const me = await prisma.user.findUnique({ where: { id: a.sub } });
    const claimingSelf = !!me?.name && assignee === me.name && !cur.assignee && !!cur.assigneeRole && cur.assigneeRole === a.role;

    // A TEAM LEAD MAY DELEGATE WITHIN THEIR TEAM. This is the rung between "claim your own" and
    // "admin moves anything": whoever leads a team (see teams.ts) handing a step to one of their own
    // people. It asks visibility.ts rather than reading membership itself, which is why it kept
    // working unchanged when teams stopped being a pointer on each user and became dated rows.
    // Both ends are checked —
    //   • the TARGET must be in their team (a lead oversees, they do not carry, so handing work to
    //     themselves is not part of the model and is deliberately not allowed here), and
    //   • the step must be UNASSIGNED, or currently on one of their team. A lead cannot pull work
    //     off somebody outside the team, however good their reasons — that stays an admin's call,
    //     because the person losing the step answers to a different lead.
    let leadDelegating = false;
    if (!isAdmin && !claimingSelf && assignee) {
      const target = await resolveStaffByName(assignee);
      if (target) {
        const { visibleUserIds } = await import("./visibility.js");
        const vis = await visibleUserIds(a);
        leadDelegating = vis.scope === "team"
          && vis.ids!.includes(target.id) && target.id !== a.sub
          && (!cur.assigneeId || vis.ids!.includes(cur.assigneeId));
      }
    }

    if (!isAdmin && !claimingSelf && !leadDelegating) {
      return res.status(403).json({ error: "You can claim unassigned work for your own role, or hand a step to one of your own team — anything wider needs an admin" });
    }

    // A claim keeps assigneeRole so the step still reads as role-owned work; a delegation clears it,
    // because the point of naming a person is to take it out of the role queue entirely.
    // Claiming resolves to the claimer with no lookup — they are signed in. A delegation carries only
    // a name from the form, so it goes through the one bridge that refuses to guess.
    const targetId = claimingSelf && !isAdmin ? a.sub : (await resolveStaffByName(assignee))?.id ?? null;
    const t = await prisma.workflowTask.update({
      where: { id: req.params.id },
      data: claimingSelf && !isAdmin
        ? { assignee, assigneeId: targetId }
        : { assignee: assignee || null, assigneeId: assignee ? targetId : null, assigneeRole: null },
    });
    const verb = claimingSelf && !isAdmin ? "claimed by" : "delegated to";
    await logAudit({ action: claimingSelf && !isAdmin ? "workflow.task_claim" : "workflow.task_reassign", actorId: a.sub, target: `${t.title} (${t.id})`, detail: `→ ${assignee || "unassigned"}` });
    logActivity({ type: "task", message: `Workflow step "${t.title}" ${verb} ${assignee || "unassigned"}` });
    res.json(t);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
