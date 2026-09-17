/**
 * RENEWAL PREPARATION AGENT.
 *
 * When a renewal run reaches its gate check, the agent answers every item it can prove from records
 * already on file — the passport has 6+ months, the insurance is current, the work permit is valid —
 * and ticks those. What only a government portal knows (fines, travel bans, violations) it leaves
 * unticked and says where to look. Then it drafts the fee-approval message to the client, so the
 * officer starts at "review and send" instead of a blank page.
 *
 * WHAT IT NEVER DOES: complete the step, mark an item VERIFIED, reject anything, or send the message.
 * A tick here means "received, with the evidence in the note"; the officer still verifies and moves
 * the run on. The draft goes nowhere until someone presses Send.
 */
import { prisma } from "./db.js";
import { askJson, AiError } from "./ai.js";
import { claimTask, finishTask, currentDoc, daysFromToday, usableModel, decide, requirePerm, AgentActionError, type AgentActor } from "./agent-core.js";
import { workforceFor, bandsInSet } from "./workforce.js";
import { homeCurrency } from "./orgsettings.js";
import { orgName } from "./emailshell.js";
import { clientRecipients, sendClientMessage } from "./notify.js";
import { emailEnabled } from "./mailer.js";
import { logActivity } from "./auth.js";

export const KEY = "renewal-prep";
const AGENT_NAME = "Renewal Preparation Agent";

type Check = { key: string; label: string; state: "ok" | "flag" | "unknown"; note: string; ticked?: boolean };

const fmt = (iso: string | null | undefined) => {
  if (!iso) return "no date";
  const t = Date.parse(String(iso).slice(0, 10));
  return Number.isNaN(t) ? String(iso) : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const months = (days: number) => Math.floor(days / 30.4);

/** Is this document valid for at least `minDays` more days? */
async function docCheck(label: string, key: string, docType: string, companyId: string | null, employeeId: string | null, minDays: number, what: string): Promise<Check> {
  const d = await currentDoc(docType, companyId, employeeId);
  if (!d) return { key, label, state: "flag", note: `No ${docType} on file${employeeId ? " for this employee" : ""}. Add it, then re-check.` };
  const left = daysFromToday(d.expiryDate);
  if (left === null) return { key, label, state: "flag", note: `${docType}${d.docNumber ? ` ${d.docNumber}` : ""} has no expiry date recorded.` };
  const num = d.docNumber ? ` ${d.docNumber}` : "";
  if (left < 0) return { key, label, state: "flag", note: `${docType}${num} expired on ${fmt(d.expiryDate)}.` };
  if (left < minDays) return { key, label, state: "flag", note: `${docType}${num} expires ${fmt(d.expiryDate)} — only ${left} days left; ${what}.` };
  return { key, label, state: "ok", note: `${docType}${num} valid until ${fmt(d.expiryDate)} (${left >= 60 ? months(left) + " months" : left + " days"} left).` };
}

/** A company document found by keyword, for gate items like Zakat or GOSI certificates. */
async function companyDocByWord(label: string, key: string, companyId: string | null, words: string[]): Promise<Check> {
  if (!companyId) return { key, label, state: "unknown", note: "No client on this run." };
  const docs = await prisma.document.findMany({ where: { companyId, employeeId: null, supersededAt: null }, select: { docType: true, docNumber: true, expiryDate: true } });
  const d = docs.find(x => words.some(w => x.docType.toLowerCase().includes(w)));
  if (!d) return { key, label, state: "unknown", note: `No ${words[0]} document is recorded for this client, so this must be checked on the portal.` };
  const left = daysFromToday(d.expiryDate);
  if (left !== null && left < 0) return { key, label, state: "flag", note: `${d.docType} expired on ${fmt(d.expiryDate)}.` };
  return { key, label, state: "ok", note: `${d.docType}${d.docNumber ? ` ${d.docNumber}` : ""}${d.expiryDate ? ` valid until ${fmt(d.expiryDate)}` : " on file"}.` };
}

const PORTAL_ONLY: Record<string, string> = {
  no_restriction: "Travel bans and government restrictions are only visible on Absher / Muqeem.",
  no_fines: "Traffic and labour fines are only visible on Absher / Muqeem.",
  contract_authenticated: "Contract authentication is only visible on Qiwa.",
  mc_violations: "Ministry of Commerce violations are only visible on the MC portal.",
  cr_data: "CR data must be compared against the MC portal record.",
};

async function proveItem(item: { key: string; label: string }, ctx: { companyId: string | null; employeeId: string | null; establishmentId?: string | null }): Promise<Check> {
  const { key, label } = item;
  const { companyId, employeeId } = ctx;
  switch (key) {
    case "passport_6m": return docCheck(label, key, "Passport", companyId, employeeId, 183, "renew the passport first");
    case "insurance_current": return docCheck(label, key, "Health Insurance", companyId, employeeId, 1, "insurance must be current");
    case "permit_current": return docCheck(label, key, "Work Permit", companyId, employeeId, 1, "the work permit must be current");
    case "iqama_valid": return docCheck(label, key, "Iqama", companyId, employeeId, 1, "the Iqama must be valid");
    case "establishment_active": {
      const co = companyId ? await prisma.company.findUnique({ where: { id: companyId }, select: { status: true, name: true } }) : null;
      if (!co) return { key, label, state: "unknown", note: "No client on this run." };
      if (String(co.status).toLowerCase() === "suspended") return { key, label, state: "flag", note: `${co.name} is suspended in this system.` };
      // Which CR: the one the run names, else the one the employee works under. Null = the main CR.
      const estId = ctx.establishmentId !== undefined ? ctx.establishmentId
        : employeeId ? ((await prisma.employee.findUnique({ where: { id: employeeId }, select: { establishmentId: true } }))?.establishmentId ?? null) : undefined;
      const cr = (await currentDoc("Commercial Registration", companyId, null, estId));
      const left = cr ? daysFromToday(cr.expiryDate) : null;
      if (cr && left !== null && left < 0) return { key, label, state: "flag", note: `The Commercial Registration expired on ${fmt(cr.expiryDate)}.` };
      if (cr) return { key, label, state: "ok", note: `Client active; CR ${cr.docNumber ?? ""} valid until ${fmt(cr.expiryDate)}.`.replace("  ", " ") };
      return { key, label, state: "unknown", note: "Client is active, but no CR is on file to confirm the establishment." };
    }
    case "nitaqat_ok": case "nitaqat_band": {
      const wf = companyId ? await workforceFor(companyId).catch(() => null) : null;
      if (!wf?.computedBand) return { key, label, state: "unknown", note: "No band can be computed for this client (no ladder set up, or no staff on file)." };
      const bands = wf.bandSet ? (await bandsInSet(wf.bandSet.id)).sort((a, b) => a.minBp - b.minBp) : [];
      const bottom = bands[0]?.name === wf.computedBand.name;
      const pct = (wf.ratioMinBp / 100).toFixed(1);
      return bottom
        ? { key, label, state: "flag", note: `Computed band is ${wf.computedBand.name} (${pct}%), the lowest band — renewals may be blocked.` }
        : { key, label, state: "ok", note: `Computed band ${wf.computedBand.name} at ${pct}% nationals. Confirm on Qiwa before submitting.` };
    }
    case "zakat_current": return companyDocByWord(label, key, companyId, ["zakat"]);
    case "gosi_current": return companyDocByWord(label, key, companyId, ["gosi"]);
    case "chamber_status": return companyDocByWord(label, key, companyId, ["chamber"]);
    case "national_address": return companyDocByWord(label, key, companyId, ["national address", "address"]);
    case "misa_licence": return companyDocByWord(label, key, companyId, ["misa"]);
    default:
      return { key, label, state: "unknown", note: PORTAL_ONLY[key] ?? "The agent has no record that proves this — check it by hand." };
  }
}

// ── the fee-approval draft ────────────────────────────────────────────────────────────────────

type Draft = { to: string[]; subject: string; body: string; writtenBy: "model" | "template"; note?: string };

async function draftFeeMessage(f: {
  clientName: string; person: string; docType: string; expiry: string | null; daysLeft: number | null;
  govFee: number | null; serviceFee: number | null; fallbackFee: number | null; currency: string; clientTodo: string[]; companyId: string | null;
}): Promise<Draft> {
  const org = await orgName();
  const to = await clientRecipients(f.companyId);
  const lines: string[] = [];
  const total = (f.govFee ?? 0) + (f.serviceFee ?? 0);
  if (f.govFee) lines.push(`Government fee: ${f.currency} ${f.govFee.toLocaleString()}`);
  if (f.serviceFee) lines.push(`Service fee: ${f.currency} ${f.serviceFee.toLocaleString()}`);
  if (!lines.length && f.fallbackFee) lines.push(`Renewal fee: ${f.currency} ${f.fallbackFee.toLocaleString()}`);
  const feeBlock = lines.length ? lines.join("\n") + (f.govFee && f.serviceFee ? `\nTotal: ${f.currency} ${total.toLocaleString()}` : "") : "Fee: to be confirmed";
  const when = f.expiry ? `expires on ${fmt(f.expiry)}${f.daysLeft !== null ? ` (${f.daysLeft < 0 ? `${-f.daysLeft} days ago` : `in ${f.daysLeft} days`})` : ""}` : "is due for renewal";

  const template: Draft = {
    to, writtenBy: "template",
    subject: `Approval needed: ${f.docType} renewal for ${f.person}`,
    body: [
      `Dear ${f.clientName},`,
      `${f.person}'s ${f.docType} ${when}, and we are ready to start the renewal.`,
      `The fees for this renewal are:\n${feeBlock}`,
      f.clientTodo.length ? `Before we can submit, please also arrange:\n${f.clientTodo.map(t => `- ${t}`).join("\n")}` : "",
      `Please reply to approve so we can proceed.`,
      `Kind regards,\n${org}`,
    ].filter(Boolean).join("\n\n"),
  };

  const model = await usableModel(KEY);
  if (!model) return template;
  try {
    const out = await askJson<{ subject: string; body: string }>({
      model,
      system: `You write short, polite emails from a PRO (government relations) firm in Saudi Arabia to its business clients, asking them to approve the fee for a document renewal.
Use ONLY the facts given. Quote every amount exactly as given, with its currency. Never add fees, dates, deadlines, discounts or promises that are not in the facts. If a fee is "to be confirmed", say so.
Plain text, no markdown. Under 140 words. Sign off with the firm name given.`,
      prompt: JSON.stringify({ firm: org, client: f.clientName, employee: f.person, document: f.docType, expiry: f.expiry, daysLeft: f.daysLeft, fees: feeBlock, clientMustArrange: f.clientTodo }),
      schema: { type: "object", additionalProperties: false, required: ["subject", "body"], properties: { subject: { type: "string" }, body: { type: "string" } } },
      maxTokens: 1500,
    });
    if (!out.subject?.trim() || !out.body?.trim()) return { ...template, note: "The model returned an empty draft, so the standard wording is used." };
    return { to, subject: out.subject.trim(), body: out.body.trim(), writtenBy: "model" };
  } catch (e) {
    return { ...template, note: `${e instanceof AiError ? e.message : "The model could not write the draft."} The standard wording is used.` };
  }
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────────

const GATE_NODES = new Set(["prereq", "check", "gate", "company_check"]);
const FEE_NODES = new Set(["fee", "approval"]);

export async function runRenewalPrep(onlyInstanceId?: string) {
  const out = { considered: 0, prepared: 0, ticked: 0, details: [] as string[] };
  const runs = await prisma.workflowInstance.findMany({
    where: { status: "running", ...(onlyInstanceId ? { id: onlyInstanceId } : {}) },
    select: { id: true, title: true, companyId: true, clientName: true, variables: true, templateId: true, tasks: { where: { status: "active" } } },
  });
  for (const run of runs) {
    const v = (run.variables ?? {}) as any;
    if (v._trigger !== "document_expiry") continue;
    const gate = run.tasks.find(t => GATE_NODES.has(t.nodeId));
    const fee = run.tasks.find(t => FEE_NODES.has(t.nodeId));
    if (!gate && !fee) continue;
    out.considered++;
    // One preparation per run. A run without a gate step (Health Insurance) is prepared at its fee step.
    if (!gate && (await prisma.agentTask.findFirst({ where: { agent: KEY, refType: "workflowInstance", refId: run.id } }))) continue;
    const step = gate ?? fee!;
    const task = await claimTask(KEY, `step:${step.id}`, {
      kind: "gate-check", title: `${v.docType ?? "Renewal"} — ${v.person ?? run.clientName ?? ""}`.trim(),
      companyId: run.companyId, employeeId: v.employeeId ?? null, refType: "workflowInstance", refId: run.id,
    });
    if (!task) continue;

    try {
      const checks: Check[] = [];
      if (gate) {
        const items = (Array.isArray(gate.checklist) ? gate.checklist : []) as any[];
        const state = { ...((gate.checklistState ?? {}) as Record<string, any>) };
        let changed = false;
        for (const it of items) {
          if (!it?.key) continue;
          const c = await proveItem({ key: it.key, label: it.label ?? it.key }, { companyId: run.companyId, employeeId: v.employeeId ?? null, establishmentId: v.establishmentId === undefined ? undefined : (v.establishmentId ?? null) });
          const s = { ...(state[it.key] ?? {}) };
          if (c.state === "ok" && !s.received && !s.rejected) {
            s.received = true; s.note = `Checked by agent: ${c.note}`; s.agent = true;
            state[it.key] = s; c.ticked = true; changed = true; out.ticked++;
            await prisma.workflowLog.create({ data: { instanceId: run.id, nodeId: gate.nodeId, action: "checklist.item.received", detail: `${it.key} — ${c.note}`, actor: AGENT_NAME, at: new Date().toISOString() } });
          } else if (c.state === "flag" && !s.note) {
            s.note = `Agent: ${c.note}`; state[it.key] = s; changed = true;
          }
          checks.push(c);
        }
        if (changed) await prisma.workflowTask.update({ where: { id: gate.id }, data: { checklistState: state } });
      }

      const svc = await prisma.serviceItem.findFirst({ where: { workflowId: run.templateId, retired: false }, select: { govFee: true, serviceFee: true } });
      const doc = v.documentId ? await prisma.document.findUnique({ where: { id: String(v.documentId) }, select: { expiryDate: true } }) : null;
      const expiry = doc?.expiryDate ?? v.currentExpiry ?? null;
      // Only what the CLIENT can fix goes in their email; portal checks are the firm's job.
      const clientTodo = checks.filter(c => c.state === "flag" && ["passport_6m", "insurance_current"].includes(c.key))
        .map(c => c.key === "passport_6m" ? `A passport renewal for ${v.person ?? "the employee"} (${c.note.replace(/;.*$/, "")})` : `Current health insurance for ${v.person ?? "the employee"}`);
      const draft = await draftFeeMessage({
        clientName: run.clientName ?? "Client", person: String(v.person ?? "your employee"), docType: String(v.docType ?? "document"),
        expiry, daysLeft: daysFromToday(expiry), govFee: svc?.govFee || null, serviceFee: svc?.serviceFee || null,
        fallbackFee: Number(v.fee) || null, currency: await homeCurrency(), clientTodo, companyId: run.companyId,
      });

      const ok = checks.filter(c => c.state === "ok").length, flagged = checks.filter(c => c.state === "flag").length, unknown = checks.filter(c => c.state === "unknown").length;
      await finishTask(task.id, "review", {
        summary: gate
          ? `Ticked ${checks.filter(c => c.ticked).length} of ${checks.length} checks from records; ${flagged} flagged, ${unknown} need the portal. Fee message drafted.`
          : "No gate step on this renewal. Fee message drafted.",
        output: { runTitle: run.title, stepTitle: step.title, checks, draft, counts: { ok, flagged, unknown } },
        model: draft.writtenBy === "model" ? await usableModel(KEY) : null,
      });
      out.prepared++;
      out.details.push(`${run.title}: ${ok} ok, ${flagged} flagged, ${unknown} unknown`);
    } catch (e: any) {
      await finishTask(task.id, "failed", { error: String(e?.message ?? e).slice(0, 1000) });
      out.details.push(`${run.title}: failed — ${e?.message ?? e}`);
    }
  }
  return out;
}

// ── a person acting on it ─────────────────────────────────────────────────────────────────────

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That task no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This task is already ${t.status}.`, 409);
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || null });
  if (action !== "send") throw new AgentActionError("Unknown action.");

  await requirePerm(actor, "Tasks", "Edit", "send client messages for renewals");
  const o = (t.output ?? {}) as any;
  const subject = String(input?.subject ?? o.draft?.subject ?? "").trim();
  const body = String(input?.body ?? o.draft?.body ?? "").trim();
  if (!subject || !body) throw new AgentActionError("The message needs a subject and a body.");
  const sent = await sendClientMessage({ companyId: t.companyId, subject, heading: subject, body });
  if (!sent.to.length) throw new AgentActionError("This client has no portal user or company email address to send to.", 409);
  const mailOn = await emailEnabled();
  if (t.refId) {
    await prisma.workflowLog.create({ data: { instanceId: t.refId, nodeId: "fee", action: "agent.fee_request.sent", detail: `${subject} → ${sent.to.join(", ")}${mailOn ? "" : " (email is not set up: logged, not delivered)"}`, actor: actor.name, at: new Date().toISOString() } }).catch(() => {});
  }
  logActivity({ type: "client", message: `Fee approval requested: ${t.title}`, user: actor.name });
  const edited = subject !== o.draft?.subject || body !== o.draft?.body;
  await decide(t.id, "done", actor, { sent: { to: sent.to, subject, edited, delivered: mailOn } });
  return { ok: true, to: sent.to, delivered: mailOn, message: mailOn ? `Sent to ${sent.to.join(", ")}.` : "Email is not set up on this server, so the message was logged but not delivered." };
}
