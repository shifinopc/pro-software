/**
 * REQUEST TRIAGE AGENT.
 *
 * A client files a request in the portal. The agent works out which service it is and which employee
 * it is about, checks the attachments against that service's required-documents list, and drafts the
 * reply — asking for what is missing, or confirming the next step. It proposes accepting the request
 * (which starts the service's workflow) or, when the client's plan does not include the service,
 * a draft quotation.
 *
 * WORKS WITHOUT A MODEL. Matching the service by name and the employee by ID number or full name is
 * done in code, and the document check is always code. With a model switched on, the model reads the
 * request text to pick the service and write the reply — useful for free-text requests like
 * "my driver's iqama is expiring, please help" — but its pick is checked against the catalogue and
 * the document check never comes from it.
 *
 * EMAIL: the mailbox sync stores only who, when and the subject of each email — no body and no
 * attachments — so emailed requests cannot be triaged until message bodies are kept.
 */
import { prisma } from "./db.js";
import { askJson, AiError } from "./ai.js";
import { claimTask, finishTask, usableModel, decide, requirePerm, AgentActionError, entitledServiceIds, normName, type AgentActor } from "./agent-core.js";
import { acceptServiceRequest } from "./delivery.js";
import { notifyRequestReply } from "./notify.js";
import { logActivity, logAudit } from "./auth.js";
import { publish } from "./realtime.js";
import { nextNumber } from "./sequence.js";
import { figuresFromAmount } from "./money.js";
import { orgName } from "./emailshell.js";

export const KEY = "request-triage";
/** Requests other agents or flows own. */
const NOT_OURS = new Set(["payment notification", "employee exit"]);

type Svc = { id: string; name: string; workflowId: string | null; requiredDocs: any; govFee: number; serviceFee: number };

function matchByName(text: string, services: Svc[]): Svc | null {
  const n = text.trim().toLowerCase();
  if (!n) return null;
  return services.find(s => s.name.trim().toLowerCase() === n)
    ?? services.find(s => n.includes(s.name.trim().toLowerCase()) || s.name.trim().toLowerCase().includes(n))
    ?? null;
}

/** Word overlap between the request text and each service name — a weak guess, labelled as one. */
function matchByWords(text: string, services: Svc[]): Svc | null {
  const words = new Set(normName(text).filter(w => w.length > 2));
  let best: { s: Svc; score: number } | null = null;
  for (const s of services) {
    const sw = normName(s.name).filter(w => w.length > 2 && !["AND", "THE", "FOR"].includes(w));
    if (!sw.length) continue;
    const hit = sw.filter(w => words.has(w)).length / sw.length;
    if (hit >= 0.6 && (!best || hit > best.score)) best = { s, score: hit };
  }
  return best?.s ?? null;
}

async function findEmployee(companyId: string | null, text: string) {
  if (!companyId) return null;
  const staff = await prisma.employee.findMany({ where: { companyId, archived: false }, select: { id: true, name: true, govId: true } });
  const ids = text.match(/\b[12]\d{9}\b/g) ?? [];
  const byId = staff.find(e => e.govId && (ids as string[]).includes(e.govId));
  if (byId) return { ...byId, how: "by ID number" };
  const words = new Set(normName(text));
  const named = staff.filter(e => { const n = normName(e.name); return n.length >= 2 && n.every(w => words.has(w)); });
  return named.length === 1 ? { ...named[0], how: "by full name" } : null;
}

export async function runTriage(onlyRequestId?: string) {
  const out = { considered: 0, triaged: 0, details: [] as string[] };
  const requests = await prisma.serviceRequest.findMany({
    where: { status: "open", taskId: null, ...(onlyRequestId ? { id: onlyRequestId } : {}) },
    orderBy: { lastClientMsgAt: "desc" }, take: 100,
  });
  if (!requests.length) return out;
  const services = (await prisma.serviceItem.findMany({
    where: { retired: false }, select: { id: true, name: true, workflowId: true, requiredDocs: true, govFee: true, serviceFee: true },
  })) as Svc[];

  for (const rq of requests) {
    if (NOT_OURS.has(String(rq.type ?? "").trim().toLowerCase())) continue;
    out.considered++;
    const files = await prisma.requestAttachment.findMany({ where: { requestId: rq.id }, select: { docKey: true, label: true, name: true } });
    // Re-triaged when new files arrive: that is exactly when the answer to "what is missing" changes.
    const task = await claimTask(KEY, `req:${rq.id}:${files.length}`, {
      kind: "triage", title: `${rq.number ?? "Request"} — ${rq.type ?? "request"}`, companyId: rq.companyId, refType: "serviceRequest", refId: rq.id,
    });
    if (!task) continue;
    await prisma.agentTask.updateMany({ where: { agent: KEY, refId: rq.id, status: "review", NOT: { id: task.id } }, data: { status: "done", decidedAt: new Date().toISOString(), decision: { auto: "Superseded — the client added files" } } });

    try {
      const text = `${rq.type ?? ""}\n${rq.message ?? ""}`;
      let svc = matchByName(String(rq.type ?? ""), services);
      let how = svc ? "matched on the request type" : "";
      if (!svc) { svc = matchByWords(text, services); if (svc) how = "guessed from words in the request — check it"; }
      let employee = await findEmployee(rq.companyId, text);
      let reply: string | null = null;
      let modelUsed: string | null = null;
      let modelNote: string | null = null;

      const model = await usableModel(KEY);
      if (model) {
        try {
          const staffNames = rq.companyId ? (await prisma.employee.findMany({ where: { companyId: rq.companyId, archived: false }, select: { name: true }, take: 400 })).map(e => e.name) : [];
          const got = await askJson<{ serviceId: string | null; employeeName: string | null; reason: string }>({
            model,
            system: `You sort client requests for a PRO (government relations) firm in Saudi Arabia. Pick the ONE service from the catalogue that the request is asking for, or null if none clearly fits. Pick the employee the request is about from the list of names, or null if none is named or implied clearly. Never invent a service or a name that is not in the lists. reason: one short sentence.`,
            prompt: JSON.stringify({ request: { type: rq.type, message: rq.message }, catalogue: services.map(s => ({ id: s.id, name: s.name })), employees: staffNames }),
            schema: { type: "object", additionalProperties: false, required: ["serviceId", "employeeName", "reason"], properties: { serviceId: { type: ["string", "null"] }, employeeName: { type: ["string", "null"] }, reason: { type: "string" } } },
            maxTokens: 1000,
          });
          modelUsed = model;
          const picked = got.serviceId ? services.find(s => s.id === got.serviceId) : null;
          if (picked && picked.id !== svc?.id) { svc = picked; how = `read from the request: ${got.reason}`; }
          if (!employee && got.employeeName && rq.companyId) {
            const e = await prisma.employee.findFirst({ where: { companyId: rq.companyId, name: got.employeeName, archived: false }, select: { id: true, name: true, govId: true } });
            if (e) employee = { ...e, how: "read from the request" };
          }
        } catch (e) { modelNote = e instanceof AiError ? `${e.message} Matched without the model instead.` : "The model could not read the request; matched without it."; }
      }

      const required = (Array.isArray(svc?.requiredDocs) ? svc!.requiredDocs : []).filter((d: any) => d && d.required !== false);
      const have = new Set(files.map(f => f.docKey));
      const missing = required.filter((d: any) => !have.has(d.key)).map((d: any) => String(d.label ?? d.key));
      const received = required.filter((d: any) => have.has(d.key)).map((d: any) => String(d.label ?? d.key));
      const entitled = svc && rq.companyId ? (await entitledServiceIds(rq.companyId)).has(svc.id) : false;
      const org = await orgName();

      const person = employee ? ` for ${employee.name}` : "";
      reply = !svc
        ? `Thank you for your request. So we can help, could you tell us which service you need${person}? For example: Iqama renewal, exit/re-entry visa, or work permit.`
        : missing.length
          ? `Thank you — we've received your ${svc.name} request${person}.\n\nTo get started we still need:\n${missing.map((m: string) => `- ${m}`).join("\n")}\n\nPlease upload these on the request in your portal.${entitled ? "" : " This service is not part of your current plan, so we'll also send you a quotation to approve."}`
          : entitled
            ? `Thank you — we've received your ${svc.name} request${person} with everything we need. Your PRO team will start on it and you'll see progress in your portal.`
            : `Thank you — we've received your ${svc.name} request${person}. This service is not part of your current plan, so we'll send you a quotation to approve before we start.`;
      reply += `\n\nKind regards,\n${org}`;

      const proposal = !svc ? null
        : entitled ? { kind: "accept", text: `Accept as ${svc.name}${svc.workflowId ? " and start its workflow" : ""}${missing.length ? ` (${missing.length} document${missing.length === 1 ? "" : "s"} still missing)` : ""}` }
        : { kind: "quote", text: `Draft a quotation for ${svc.name} — ${(svc.govFee + svc.serviceFee).toLocaleString()} (government ${svc.govFee.toLocaleString()} + service ${svc.serviceFee.toLocaleString()})` };

      await finishTask(task.id, "review", {
        employeeId: employee?.id ?? null,
        summary: svc
          ? `${svc.name}${employee ? ` · ${employee.name}` : ""} · ${required.length ? (missing.length ? `${missing.length} of ${required.length} documents missing` : "all documents attached") : "service has no required-documents list"} · ${entitled ? "in the client's plan" : "not in the client's plan"}`
          : "Could not tell which service this is — reply drafted to ask.",
        model: modelUsed,
        output: {
          request: { id: rq.id, number: rq.number, type: rq.type, message: rq.message, client: rq.clientName },
          service: svc ? { id: svc.id, name: svc.name, how, hasWorkflow: !!svc.workflowId, entitled, govFee: svc.govFee, serviceFee: svc.serviceFee } : null,
          employee: employee ? { id: employee.id, name: employee.name, how: employee.how } : null,
          checks: [
            ...received.map((r: string) => ({ label: r, state: "ok", note: "Attached" })),
            ...missing.map((m: string) => ({ label: m, state: "flag", note: "Not attached yet" })),
          ],
          files: files.map(f => f.label || f.name),
          proposal,
          draft: { subject: `Your request ${rq.number ?? ""}`.trim(), body: reply, writtenBy: "template" },
          note: modelNote,
        },
      });
      out.triaged++;
      out.details.push(`${rq.number}: ${svc?.name ?? "no service"}${missing.length ? `, ${missing.length} missing` : ""}`);
    } catch (e: any) {
      await finishTask(task.id, "failed", { error: String(e?.message ?? e).slice(0, 1000) });
    }
  }
  return out;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That task no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This task is already ${t.status}.`, 409);
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  const o = (t.output ?? {}) as any;
  const rq = t.refId ? await prisma.serviceRequest.findUnique({ where: { id: t.refId } }) : null;
  if (!rq) throw new AgentActionError("The request no longer exists.", 404);

  if (action === "send") {
    await requirePerm(actor, "Clients", "Edit", "reply to client requests");
    const body = String(input?.body ?? o.draft?.body ?? "").trim();
    if (!body) throw new AgentActionError("The reply is empty.");
    const at = new Date().toISOString();
    const msg = await prisma.serviceRequestMessage.create({ data: { requestId: rq.id, authorType: "staff", authorName: actor.name, body, internal: false, at } });
    await prisma.serviceRequest.update({ where: { id: rq.id }, data: { staffReadAt: at, lastStaffMsgAt: at } });
    publish("message", { requestId: rq.id, companyId: rq.companyId, message: msg, clientName: rq.clientName, type: rq.type }, { to: "all" });
    notifyRequestReply({ companyId: rq.companyId, requestType: rq.type, body });
    logActivity({ type: "client", message: `Replied to ${rq.clientName ?? "client"} (${rq.type ?? "request"})`, user: actor.name });
    const next = { ...o, replied: { at, by: actor.name, edited: body !== o.draft?.body } };
    // Replying is not the end of triage when accepting or quoting is still to do.
    if (o.proposal) { await prisma.agentTask.update({ where: { id: t.id }, data: { output: next } }); return { ok: true, message: "Reply sent. Accept or quote when ready." }; }
    await decide(t.id, "done", actor, { replied: true });
    return { ok: true, message: "Reply sent." };
  }

  if (action === "accept") {
    await requirePerm(actor, "Clients", "Edit", "accept client requests");
    const serviceItemId = String(input?.serviceItemId ?? o.service?.id ?? "") || null;
    if (!serviceItemId) throw new AgentActionError("No service was identified. Accept it from the requests queue and choose the service.");
    const res = await acceptServiceRequest(rq.id, { actor: actor.email ?? actor.name, serviceItemId });
    await logAudit({ action: "request.accepted", actorId: actor.id, target: rq.id, detail: [res.taskRef, res.serviceName, res.workflowInstanceId ? "run started" : "no run", "via request triage agent"].filter(Boolean).join(" · ") });
    await decide(t.id, "done", actor, { accepted: { taskRef: res.taskRef, run: res.workflowInstanceId, service: res.serviceName } });
    return { ok: true, message: `Accepted — ${res.taskRef ?? "task created"}${res.workflowInstanceId ? ", workflow started" : ""}${res.failure ? `. ${res.failure}` : ""}.` };
  }

  if (action === "quote") {
    await requirePerm(actor, "Sales", "Create", "create quotations");
    const svc = o.service;
    if (!svc?.id) throw new AgentActionError("No service was identified to quote.");
    const price = Number(svc.govFee || 0) + Number(svc.serviceFee || 0);
    const figures = await figuresFromAmount(price);
    const q = await prisma.quotation.create({
      data: {
        number: await nextNumber("quotation"), companyId: rq.companyId, clientName: rq.clientName, service: svc.name,
        ...figures, items: [{ name: svc.name, units: 1, price }] as any, status: "draft", date: new Date().toISOString().slice(0, 10),
        notes: `Drafted from request ${rq.number ?? ""} by the request triage agent.`.trim(),
      } as any,
    });
    await logAudit({ action: "quotation.create", actorId: actor.id, target: q.number, detail: `from ${rq.number} via request triage agent` });
    await decide(t.id, "done", actor, { quoted: q.number });
    return { ok: true, message: `Draft quotation ${q.number} created. Review and send it from Quotations.` };
  }
  throw new AgentActionError("Unknown action.");
}
