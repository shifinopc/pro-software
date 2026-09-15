/**
 * DATA QUALITY AGENT.
 *
 * Once a day it looks for what nobody is looking at, and raises a review queue — never a fix:
 *   · active employees with no government ID (nothing can be matched to them)
 *   · likely duplicate employees (same ID on two records; same name and date of birth)
 *   · documents that have expired with no renewal running
 *   · job titles that are not on Qiwa's occupation list (once that list is loaded)
 *
 * Findings are grouped per client, so a client imported with 300 blank IDs is one item to deal with,
 * not 300. A finding that is fixed closes itself on the next pass; one a person dismissed stays
 * dismissed. No model: every check is a query.
 *
 * THE QIWA LIST IS NOT INVENTED HERE. The occupation vocabulary is published by Qiwa and changes; an
 * admin pastes it into the agent's settings. Until then that check reports that it has nothing to
 * check against, rather than guessing which job titles are valid.
 */
import { prisma } from "./db.js";
import { upsertFinding, closeMissing, markRun, decide, requirePerm, AgentActionError, agentSetting, daysFromToday, normName, type AgentActor } from "./agent-core.js";
import { ACTIVE_CLIENT } from "./validate.js";

export const KEY = "data-quality";
const LIST_MAX = 60;

export async function qiwaOccupations(): Promise<string[]> {
  const s = await agentSetting(KEY);
  const raw = (s.options as any)?.qiwaOccupations;
  return Array.isArray(raw) ? raw.map((x: any) => String(x).trim()).filter(Boolean) : [];
}

export async function runDataQuality() {
  const out = { opened: 0, open: 0, closed: 0, details: [] as string[] };
  const clients = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true, status: true } });
  const clientIds = new Set(clients.map(c => c.id));
  const nameOf = new Map(clients.map(c => [c.id, c.name]));
  const staff = await prisma.employee.findMany({
    where: { archived: false, exitStatus: { not: "exited" } },
    select: { id: true, name: true, code: true, govId: true, dob: true, nationality: true, role: true, companyId: true },
  });
  const active = staff.filter(e => e.companyId && clientIds.has(e.companyId));
  const seen: Record<string, Set<string>> = { "missing-id": new Set(), duplicate: new Set(), "expired-no-renewal": new Set(), "qiwa-occupation": new Set() };
  const raise = async (kind: string, key: string, d: { title: string; summary: string; companyId: string | null; output: unknown }) => {
    seen[kind].add(key);
    const r = await upsertFinding(KEY, key, { kind, ...d });
    if (r.opened) out.opened++;
  };
  const byCompany = <T extends { companyId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { if (!r.companyId) continue; m.set(r.companyId, [...(m.get(r.companyId) ?? []), r]); }
    return m;
  };

  // 1. No government ID.
  for (const [co, rows] of byCompany(active.filter(e => !String(e.govId ?? "").trim()))) {
    await raise("missing-id", `missing-id:${co}`, {
      title: `${rows.length} employee${rows.length === 1 ? "" : "s"} without a government ID — ${nameOf.get(co)}`,
      summary: "Documents cannot be matched to these people, and duplicates cannot be caught.",
      companyId: co, output: { people: rows.slice(0, LIST_MAX).map(e => ({ id: e.id, name: e.name, code: e.code })), more: Math.max(0, rows.length - LIST_MAX) },
    });
  }

  // 2. Likely duplicates.
  const byId = new Map<string, typeof active>();
  for (const e of active) { const g = String(e.govId ?? "").trim(); if (g) byId.set(g, [...(byId.get(g) ?? []), e]); }
  for (const [gid, rows] of byId) {
    if (rows.length < 2) continue;
    const cos = [...new Set(rows.map(r => nameOf.get(r.companyId!)))];
    await raise("duplicate", `dup-id:${gid}`, {
      title: `ID ${gid} is on ${rows.length} employee records`,
      summary: cos.length > 1 ? `Across ${cos.join(" and ")} — a transfer that was never closed, or a typing mistake.` : `All at ${cos[0]} — the same person entered twice.`,
      companyId: rows[0].companyId, output: { people: rows.map(e => ({ id: e.id, name: e.name, code: e.code, client: nameOf.get(e.companyId!) })) },
    });
  }
  const byNameDob = new Map<string, typeof active>();
  for (const e of active) {
    const n = normName(e.name).sort().join(" ");
    if (!n || !e.dob) continue;
    const k = `${e.companyId}:${n}:${e.dob}`;
    byNameDob.set(k, [...(byNameDob.get(k) ?? []), e]);
  }
  for (const [k, rows] of byNameDob) {
    if (rows.length < 2) continue;
    const ids = new Set(rows.map(r => String(r.govId ?? "").trim()).filter(Boolean));
    if (ids.size > 1) continue; // same name and birthday, different IDs: two real people
    await raise("duplicate", `dup-name:${k}`, {
      title: `${rows.length} records for ${rows[0].name} (born ${rows[0].dob}) — ${nameOf.get(rows[0].companyId!)}`,
      summary: "Same name and date of birth at the same client, and no ID that tells them apart.",
      companyId: rows[0].companyId, output: { people: rows.map(e => ({ id: e.id, name: e.name, code: e.code, govId: e.govId })) },
    });
  }

  // 3. Expired, and nothing is renewing it.
  const exitedOrArchived = new Set((await prisma.employee.findMany({ where: { OR: [{ archived: true }, { exitStatus: "exited" }] }, select: { id: true } })).map(e => e.id));
  const docs = await prisma.document.findMany({
    where: { supersededAt: null, renewalRunId: null, NOT: { expiryDate: null } },
    select: { id: true, docType: true, docNumber: true, person: true, expiryDate: true, companyId: true, employeeId: true },
  });
  const templates = await prisma.workflowTemplate.findMany({ where: { active: true, retired: false, trigger: "document_expiry" }, select: { triggerConfig: true } });
  const renewable = new Set(templates.map(t => String((t.triggerConfig as any)?.docType ?? "")).filter(Boolean));
  const expired = docs.filter(d => clientIds.has(d.companyId) && (!d.employeeId || !exitedOrArchived.has(d.employeeId)) && (daysFromToday(d.expiryDate) ?? 0) < 0);
  for (const [co, rows] of byCompany(expired)) {
    const suspended = String(clients.find(c => c.id === co)?.status ?? "").toLowerCase() === "suspended";
    const noWorkflow = [...new Set(rows.map(r => r.docType).filter(t => !renewable.has(t)))];
    await raise("expired-no-renewal", `expired:${co}`, {
      title: `${rows.length} expired document${rows.length === 1 ? "" : "s"} with no renewal running — ${nameOf.get(co)}`,
      summary: [
        suspended ? "The client is suspended, so renewals are paused." : "",
        noWorkflow.length ? `No active renewal workflow exists for: ${noWorkflow.join(", ")}.` : "A renewal workflow exists, so these are probably held by missing prerequisites — check each one.",
      ].filter(Boolean).join(" "),
      companyId: co,
      output: { documents: rows.slice(0, LIST_MAX).map(d => ({ id: d.id, docType: d.docType, number: d.docNumber, person: d.person, expiry: d.expiryDate, daysAgo: -(daysFromToday(d.expiryDate) ?? 0) })), more: Math.max(0, rows.length - LIST_MAX), noWorkflow },
    });
  }

  // 4. Job titles against Qiwa's list.
  const occupations = await qiwaOccupations();
  let qiwaNote: string | null = null;
  if (!occupations.length) qiwaNote = "No Qiwa occupation list is loaded, so job titles were not checked.";
  else {
    const valid = new Set(occupations.map(o => o.toLowerCase()));
    const off = active.filter(e => String(e.role ?? "").trim() && !valid.has(String(e.role).trim().toLowerCase()));
    for (const [co, rows] of byCompany(off)) {
      const titles = [...new Set(rows.map(r => String(r.role).trim()))];
      await raise("qiwa-occupation", `qiwa:${co}`, {
        title: `${rows.length} job title${rows.length === 1 ? "" : "s"} not on Qiwa's list — ${nameOf.get(co)}`,
        summary: `Titles in use: ${titles.slice(0, 8).join(", ")}${titles.length > 8 ? "…" : ""}.`,
        companyId: co, output: { people: rows.slice(0, LIST_MAX).map(e => ({ id: e.id, name: e.name, role: e.role })), titles, more: Math.max(0, rows.length - LIST_MAX) },
      });
    }
  }

  for (const [kind, keys] of Object.entries(seen)) {
    if (kind === "qiwa-occupation" && !occupations.length) continue; // nothing checked, nothing fixed
    out.closed += await closeMissing(KEY, kind, keys, "Fixed — no longer found");
  }
  out.open = await prisma.agentTask.count({ where: { agent: KEY, status: "review" } });
  await markRun(KEY);
  if (qiwaNote) out.details.push(qiwaNote);
  return out;
}

export async function act(taskId: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== KEY) throw new AgentActionError("That finding no longer exists.", 404);
  if (t.status !== "review") throw new AgentActionError(`This finding is already ${t.status}.`, 409);
  await requirePerm(actor, "Clients", "Edit", "close data findings");
  if (action === "dismiss") return decide(t.id, "dismissed", actor, { reason: String(input?.reason ?? "") || "Not a problem" });
  throw new AgentActionError("Unknown action.");
}
