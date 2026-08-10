/**
 * Does this workflow actually do what it looks like it does?
 *
 * The Builder and the engine were written against different vocabularies, and nothing checked the
 * graph on the way in. So a `charge_fee` node was saved, silently skipped at runtime, and the run
 * still reported success — a renewal that never billed looked exactly like one that did. A Decision
 * with no branches walked straight down its single edge. A Delay with no duration waited for nothing.
 *
 * None of those were errors. They were omissions that read as working configuration, which is worse:
 * an error gets fixed the day it appears.
 *
 * This runs on SAVE, on the server, deliberately — the engine lives here, so the rules cannot drift
 * away from what actually executes the graph. It never blocks a save: a half-built template is a
 * normal state to leave the Builder in. It says, in words the author can act on, what will not work.
 */

/** Every node type the engine's switch executes, including the aliases it accepts. Must be kept in
 *  step with runFrontier() in workflow.ts — if you add a `case` there, add it here. */
export const ENGINE_NODE_TYPES = new Set([
  "start", "trigger",
  "task", "approval",
  "decision",
  "notify",
  "webhook", "api",
  "issue_document",
  "draft_invoice", "charge_fee", "invoice", "create_invoice",
  "courier", "dispatch",
  "delay",
  "parallel_split", "split", "parallel_join", "join",
  "end",
]);

export type GraphIssue = { level: "error" | "warning"; nodeId?: string; node?: string; message: string };

type AnyNode = { id: string; type: string; label?: string; config?: any };
type AnyEdge = { from: string; to: string; condition?: string };

const nameOf = (n: AnyNode) => n.label || n.type || n.id;

/**
 * @param graph  the template's { nodes, edges }
 * @param tpl    trigger + triggerConfig, so an expiry template with no binding can be reported here
 *               too rather than only in the template list
 */
/**
 * The steps that will land on nobody's desk.
 *
 * `task` and `approval` are the only node types the engine turns into work a person has to do.
 * Every other type runs itself, so "no role" is the correct state for a delay or a split and
 * counting those was what produced the "122 of 190 steps" figure for a problem that is twelve
 * steps big.
 *
 * A roleless step is not an error — the engine handles it, falling back to the run-level owner and
 * then to unassigned. But "unassigned" in a compliance business means a government deadline sitting
 * in a pile nobody is notified about, and the cost of noticing late is a fine. So it is a warning
 * while a template is a draft, and a refusal at the moment somebody makes it live.
 */
export function stepsMissingRole(graph: any): AnyNode[] {
  const nodes: AnyNode[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.filter(n =>
    (n?.type === "task" || n?.type === "approval") &&
    !(n as any)?.config?.assigneeRole && !(n as any)?.config?.approverRole);
}

export function validateGraph(graph: any, tpl?: { trigger?: string | null; triggerConfig?: any }): GraphIssue[] {
  const out: GraphIssue[] = [];
  const nodes: AnyNode[] = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges: AnyEdge[] = Array.isArray(graph?.edges) ? graph.edges : [];

  if (!nodes.length) {
    out.push({ level: "error", message: "This workflow has no steps, so it cannot start." });
    return out;
  }

  const byId = new Map(nodes.map(n => [n.id, n]));
  const outEdges = (id: string) => edges.filter(e => e.from === id);
  const inDeg = (id: string) => edges.filter(e => e.to === id).length;

  // ── Can it start at all? ──
  const starts = nodes.filter(n => n.type === "start" || n.type === "trigger");
  const orphans = nodes.filter(n => inDeg(n.id) === 0);
  if (!starts.length && !orphans.length) {
    out.push({ level: "error", message: "Every step has something pointing at it, so there is no first step and the workflow can never begin." });
  }

  // ── Edges that go nowhere ──
  for (const e of edges) {
    if (!byId.has(e.from)) out.push({ level: "error", message: `A connection starts from a step that no longer exists (${e.from}).` });
    if (!byId.has(e.to)) out.push({ level: "error", message: `A connection points at a step that no longer exists (${e.to}).` });
  }

  // ── Unreachable steps: present on the canvas, never executed ──
  if (starts.length || orphans.length) {
    const entry = (starts.length ? starts : orphans).map(n => n.id);
    const seen = new Set(entry);
    const queue = [...entry];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of outEdges(id)) if (!seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    for (const n of nodes) {
      if (!seen.has(n.id)) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no path from the start, so it will never run.` });
    }
  }

  // ── Per-node configuration the engine actually reads ──
  for (const n of nodes) {
    const c = n.config ?? {};
    if (!ENGINE_NODE_TYPES.has(n.type)) {
      out.push({ level: "error", nodeId: n.id, node: nameOf(n), message: `The engine does not recognise "${n.type}", so "${nameOf(n)}" will be skipped and the run will still report success.` });
      continue;
    }

    if (n.type === "decision") {
      const branches: any[] = Array.isArray(c.branches) ? c.branches : [];
      if (!branches.length) {
        out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no conditions set, so it will not branch — every run takes the same path.` });
      } else {
        const conds = new Set(outEdges(n.id).map(e => e.condition ?? ""));
        for (const b of branches) {
          if (!b?.var) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `A condition on "${nameOf(n)}" has no variable to test, so it can never be true.` });
          if (b?.key && !conds.has(b.key)) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `Branch "${b.key}" on "${nameOf(n)}" has no connection leaving it, so choosing it leads nowhere.` });
        }
        if (!conds.has("else") && !conds.has("") && !conds.has("default")) {
          out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no fallback connection, so a run matching none of its conditions stops here.` });
        }
      }
    }

    if (n.type === "approval") {
      const hasReject = outEdges(n.id).some(e => e.condition === "reject");
      if (!hasReject) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no reject path, so rejecting it ends the whole run instead of routing anywhere.` });
    }

    if (n.type === "task" || n.type === "approval") {
      if (!String(c.assigneeRole ?? "").trim() && !String(c.assignee ?? "").trim()) {
        out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" names nobody, so it will sit unassigned until someone claims it.` });
      }
    }

    if (n.type === "delay") {
      const hours = Number(c.hours) > 0 ? Number(c.hours) : (Number(c.days) > 0 ? Number(c.days) * 24 : 0);
      if (!hours) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no duration, so it waits for nothing and the run continues immediately.` });
    }

    if (n.type === "issue_document") {
      if (!String(c.docType ?? "").trim()) {
        out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" does not say which document to issue, so nothing will be written to Compliance.` });
      }
    }

    if (n.type === "draft_invoice" || n.type === "charge_fee" || n.type === "invoice" || n.type === "create_invoice") {
      if (!(Number(c.amount) > 0)) {
        out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no amount, so it will raise an invoice for zero.` });
      }
    }

    if (n.type === "webhook" || n.type === "api") {
      if (!String(c.url ?? "").trim()) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no URL, so it calls nothing.` });
    }

    // A parallel split that fans into one branch is not a split. A join with one arrival is not a join.
    if (n.type === "parallel_split" || n.type === "split") {
      if (outEdges(n.id).length < 2) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has fewer than two outgoing connections, so there is nothing to run in parallel.` });
    }
    if (n.type === "parallel_join" || n.type === "join") {
      if (inDeg(n.id) < 2) out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has fewer than two incoming connections, so it is not joining anything.` });
    }

    // A step with no way onward, that is not an end. The engine auto-closes rather than hanging, but
    // the author almost certainly meant to continue somewhere.
    if (n.type !== "end" && !outEdges(n.id).length) {
      out.push({ level: "warning", nodeId: n.id, node: nameOf(n), message: `"${nameOf(n)}" has no connection leaving it, so the run ends there.` });
    }
  }

  if (!nodes.some(n => n.type === "end")) {
    out.push({ level: "warning", message: "There is no End step, so runs close automatically with no recorded outcome." });
  }

  // Branches that run at the same time and then all wire to End, with nothing joining them first.
  //
  // The End node finalises the instance, so whichever branch arrives first closes the case — while the
  // others are still open work on somebody's desk. Found by building exactly this shape while testing
  // the per-portal queue: a cancellation fanned out to Qiwa, Muqeem and GOSI, finishing the Qiwa job
  // closed the whole case, and the other two authorities still had a step waiting. That shape is now
  // the natural way to build these flows, which is what makes it worth saying out loud.
  const fanOut = nodes.filter(n =>
    n.type !== "decision" && n.type !== "branch" && n.type !== "approval" &&
    outEdges(n.id).filter(e => !e.condition).length >= 2);
  const hasJoin = nodes.some(n => n.type === "parallel_join" || n.type === "join");
  if (fanOut.length && !hasJoin) {
    const ends = nodes.filter(n => n.type === "end" && inDeg(n.id) >= 2);
    if (ends.length) {
      out.push({
        level: "warning",
        nodeId: fanOut[0].id, node: nameOf(fanOut[0]),
        message: `"${nameOf(fanOut[0])}" starts several steps at once and they all finish at the End step, with nothing waiting for them. Whichever one is completed first closes the whole case while the others are still open. Add a Parallel join before the End step.`,
      });
    }
  }

  // ── The trigger, checked here too so one screen reports everything ──
  if (tpl?.trigger === "document_expiry" && !String((tpl.triggerConfig ?? {}).docType ?? "").trim()) {
    out.push({ level: "error", message: "This starts on document expiry but is not bound to a document type, so it can never fire. Set it under Trigger." });
  }
  // A leftover from when "Client request intake" was offered as a trigger. It never selected anything:
  // a request starts the workflow bound to its SERVICE. Reported so the row explains itself instead of
  // looking configured, and re-saving the trigger settings clears it to manual.
  if (tpl?.trigger === "request_intake") {
    out.push({ level: "warning", message: "The old \"Client request intake\" trigger never started anything on its own. To run this from a client request, bind it to a service under Configure → Services; otherwise it is a manual workflow." });
  }

  // ── Steps that land on nobody's desk ──
  // A warning here, a refusal at activation. Told while it is still a draft so the author fixes it
  // in the Builder, rather than finding out only when they press Activate.
  for (const n of stepsMissingRole(graph)) {
    out.push({
      level: "warning", nodeId: n.id, node: nameOf(n),
      message: `"${nameOf(n)}" names no role, so the task it creates lands unassigned and waits for somebody to notice it. Set "Assigned role" on the step.`,
    });
  }

  return out;
}
