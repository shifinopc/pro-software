/**
 * COMPLIANCE AGENTS — what the government portals say against what we hold, company licences about to
 * lapse, documents that contradict their owner, and family visas nobody is watching.
 *
 * THE RECONCILER READS AN EXPORT A PERSON UPLOADS. Muqeem, Qiwa and GOSI have no API we are allowed to
 * call, but each lets the establishment download its employee list. The agent compares that file with
 * the records and lists the differences — it never updates an employee or a document from it, because
 * which side is wrong is exactly what a person has to decide.
 */
import { prisma } from "./db.js";
import { daysFromToday, normName, AgentActionError, type AgentActor } from "./agent-core.js";
import { runFindings, standardAct, groupBy, plural, today, addDays, LIST_MAX, type Finding } from "./agent-kit.js";
import { upsertFinding, markRun } from "./agent-core.js";
import { splitCsv, toIsoDate } from "./agent-bank.js";
import { ACTIVE_CLIENT } from "./validate.js";
import { logAudit } from "./auth.js";
import { crLabel } from "./establishments.js";

// ── 14. Government portal reconciler ──────────────────────────────────────────────────────────

export const RECON = "portal-reconciler";
export class ExportError extends Error { constructor(message: string, public status = 400) { super(message); } }

const HEAD = {
  id: /iqama|border|national.?id|id.?(no|number)|resident|رقم.?(الإقامة|الاقامة|الهوية|الحدود)|الهوية|الإقامة|الاقامة/i,
  name: /^(employee.?)?name|full.?name|الاسم|اسم/i,
  expiry: /expir|valid.?(to|until)|انتهاء/i,
  occupation: /occupation|profession|job|المهنة|مهنة/i,
  nationality: /nationality|الجنسية/i,
};

export function parseExport(text: string) {
  const rows = splitCsv(text.replace(/^﻿/, ""));
  const hi = rows.findIndex(r => r.some(c => HEAD.id.test(c)) && r.some(c => HEAD.name.test(c) || HEAD.expiry.test(c) || HEAD.occupation.test(c)));
  if (hi < 0) throw new ExportError("Could not find the column headings. The export needs an ID column (Iqama / Border / National ID) and at least a name, expiry or occupation column.");
  const h = rows[hi];
  const col = (re: RegExp) => h.findIndex(c => re.test(c));
  const ci = { id: col(HEAD.id), name: col(HEAD.name), expiry: col(HEAD.expiry), occupation: col(HEAD.occupation), nationality: col(HEAD.nationality) };
  const out: { govId: string; name: string | null; expiry: string | null; occupation: string | null }[] = [];
  for (const r of rows.slice(hi + 1)) {
    const govId = String(r[ci.id] ?? "").replace(/\D/g, "");
    if (govId.length < 8) continue;
    out.push({
      govId,
      name: ci.name >= 0 ? (r[ci.name] || "").trim() || null : null,
      expiry: ci.expiry >= 0 ? toIsoDate(r[ci.expiry] ?? "") : null,
      occupation: ci.occupation >= 0 ? (r[ci.occupation] || "").trim() || null : null,
    });
  }
  if (!out.length) throw new ExportError("No rows with an ID number were found under the headings.");
  return { rows: out, columns: Object.entries(ci).filter(([, i]) => i >= 0).map(([k]) => k) };
}

const sourceOf = (fileName: string) => /qiwa/i.test(fileName) ? "Qiwa" : /gosi/i.test(fileName) ? "GOSI" : /muqeem|absher/i.test(fileName) ? "Muqeem" : "Government export";

export async function importExport(input: { fileName: string; text: string; companyId?: string | null; actor: AgentActor }) {
  if (!input.text || input.text.length > 3_000_000) throw new ExportError("The file is empty or larger than 3 MB.");
  const { rows, columns } = parseExport(input.text);
  const source = sourceOf(input.fileName);
  const ids = rows.map(r => r.govId);
  const matched = await prisma.employee.findMany({ where: { govId: { in: ids } }, select: { id: true, name: true, govId: true, companyId: true, role: true, iqamaExpiry: true, archived: true, exitStatus: true } });
  // Which client is this file for? The one most of its IDs belong to, unless the person said.
  const votes = [...groupBy(matched, m => m.companyId)].sort((a, b) => b[1].length - a[1].length);
  const companyId = input.companyId || votes[0]?.[0];
  if (!companyId) throw new ExportError("None of the ID numbers in this file belong to an employee on record, so the client could not be worked out.", 422);
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!co) throw new ExportError("That client no longer exists.", 404);
  const staff = await prisma.employee.findMany({ where: { companyId, archived: false, exitStatus: { not: "exited" } }, select: { id: true, name: true, govId: true, role: true, iqamaExpiry: true } });
  const iqamas = await prisma.document.findMany({ where: { companyId, supersededAt: null, docType: { contains: "Iqama" } }, select: { employeeId: true, expiryDate: true } });
  const byGov = new Map(staff.filter(s => s.govId).map(s => [String(s.govId).replace(/\D/g, ""), s]));
  const inFile = new Set(ids);

  const notOnRecord = rows.filter(r => !byGov.has(r.govId));
  const elsewhere = notOnRecord.map(r => ({ r, m: matched.find(m => String(m.govId).replace(/\D/g, "") === r.govId && m.companyId !== companyId) })).filter(x => x.m);
  const missingFromFile = staff.filter(s => s.govId && !inFile.has(String(s.govId).replace(/\D/g, "")));
  const expiryDiff: string[] = [], occupationDiff: string[] = [], nameDiff: string[] = [];
  for (const r of rows) {
    const s = byGov.get(r.govId);
    if (!s) continue;
    const ours = iqamas.find(d => d.employeeId === s.id)?.expiryDate ?? s.iqamaExpiry;
    if (r.expiry && ours && ours.slice(0, 10) !== r.expiry) expiryDiff.push(`${s.name} (${r.govId}): ${source} says ${r.expiry}, our record says ${ours.slice(0, 10)}`);
    if (r.expiry && !ours) expiryDiff.push(`${s.name} (${r.govId}): ${source} says ${r.expiry}, no expiry on our record`);
    if (r.occupation && s.role && r.occupation.trim().toLowerCase() !== s.role.trim().toLowerCase()) occupationDiff.push(`${s.name}: ${source} “${r.occupation}”, our record “${s.role}”`);
    if (r.name) { const a = normName(r.name), b = normName(s.name); if (a.length && b.length && !a.some(t => b.includes(t))) nameDiff.push(`${r.govId}: ${source} “${r.name}”, our record “${s.name}”`); }
  }

  const stamp = new Date().toISOString();
  const facts = [{ label: "File", value: `${input.fileName} · ${rows.length} rows · columns: ${columns.join(", ")}` }, { label: "Uploaded", value: `${stamp.slice(0, 16).replace("T", " ")} by ${input.actor.name}` }];
  const raised: Finding[] = [];
  const push = (kind: string, title: string, summary: string, items: string[]) => items.length && raised.push({ kind, key: `${kind}:${companyId}:${source}`, companyId, title, summary, output: { facts, lists: [{ title: "Differences", items: items.slice(0, LIST_MAX).map(text => ({ text })) }], more: Math.max(0, items.length - LIST_MAX) } });
  push("not-on-record", `${plural(notOnRecord.length, "person", "people")} on ${source} but not on our records — ${co.name}`, "Counted by the government against this establishment, invisible to us: no renewals, no Nitaqat count.", notOnRecord.map(r => { const e = elsewhere.find(x => x.r.govId === r.govId); return `${r.name ?? "?"} · ${r.govId}${r.occupation ? ` · ${r.occupation}` : ""}${e ? " — on record under another client" : ""}`; }));
  push("not-on-portal", `${plural(missingFromFile.length, "employee")} on our records but not on ${source} — ${co.name}`, "Left, transferred, or never registered. Either close them here or register them there.", missingFromFile.map(s => `${s.name} · ${s.govId}`));
  push("expiry-mismatch", `${plural(expiryDiff.length, "expiry date")} differ from ${source} — ${co.name}`, "Renewals are scheduled from our dates. Correct whichever side is wrong.", expiryDiff);
  push("occupation-mismatch", `${plural(occupationDiff.length, "occupation")} differ from ${source} — ${co.name}`, "Qiwa's occupation is what counts for Saudization and work permits.", occupationDiff);
  push("name-mismatch", `${plural(nameDiff.length, "name")} do not match ${source} — ${co.name}`, "The same ID with a different name is usually a wrong ID typed on our side.", nameDiff);

  let opened = 0;
  for (const f of raised) { const r = await upsertFinding(RECON, f.key, { kind: f.kind, title: f.title, summary: f.summary, companyId: f.companyId, output: f.output }); if (r.opened) opened++; }
  // Kinds that came back clean for this client and source are fixed.
  const clean = ["not-on-record", "not-on-portal", "expiry-mismatch", "occupation-mismatch", "name-mismatch"].filter(k => !raised.some(f => f.kind === k));
  await prisma.agentTask.updateMany({ where: { agent: RECON, status: "review", dedupeKey: { in: clean.map(k => `${k}:${companyId}:${source}`) } }, data: { status: "done", decidedAt: stamp, decision: { auto: `Matched on the ${source} export of ${stamp.slice(0, 10)}` } as any } });
  await markRun(RECON);
  await logAudit({ action: "agent.portal_export", actorId: input.actor.id, target: co.name, detail: `${input.fileName}: ${rows.length} rows, ${raised.length} difference groups` });
  return { client: co.name, source, rows: rows.length, differences: raised.length, opened, notOnRecord: notOnRecord.length, notOnPortal: missingFromFile.length, expiry: expiryDiff.length, occupation: occupationDiff.length, names: nameDiff.length };
}

// ── 15. Company licence watch ─────────────────────────────────────────────────────────────────

export const LICENCES = "company-licence-watch";
const LICENCE_DAYS = 60;

export async function runCompanyLicences() {
  return runFindings(LICENCES, ["expiring"], async raise => {
    const cos = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true, status: true } });
    const docs = await prisma.document.findMany({ where: { companyId: { in: cos.map(c => c.id) }, employeeId: null, supersededAt: null, renewalRunId: null, renewalTaskId: null, expiryDate: { gte: today(), lte: addDays(today(), LICENCE_DAYS) } }, select: { id: true, companyId: true, docType: true, docNumber: true, expiryDate: true, establishmentId: true } });
    const name = new Map(cos.map(c => [c.id, c.name]));
    // A client with sub CRs: say which CR each certificate belongs to.
    const ests = await prisma.establishment.findMany({ where: { companyId: { in: [...new Set(docs.map(d => d.companyId))] }, status: "active" } });
    const crOf = (d: { companyId: string; establishmentId: string | null }) => { const mine = ests.filter(e => e.companyId === d.companyId); if (mine.length < 2) return ""; const e = d.establishmentId ? mine.find(x => x.id === d.establishmentId) : mine.find(x => x.kind === "main"); return e ? ` · ${crLabel(e)}` : ""; };
    for (const [co, rows] of groupBy(docs, d => d.companyId)) {
      rows.sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
      const first = daysFromToday(rows[0].expiryDate) ?? 0;
      await raise({ kind: "expiring", key: `licences:${co}`, companyId: co,
        title: `${plural(rows.length, "company licence")} expiring within ${LICENCE_DAYS} days — ${name.get(co)}`,
        summary: `First is ${rows[0].docType} in ${first} days, and no renewal has started. A lapsed CR or GOSI certificate stops every visa and Iqama for this client.`,
        output: { lists: [{ title: "Expiring", items: rows.map(d => ({ text: `${d.docType}${d.docNumber ? ` ${d.docNumber}` : ""}${crOf(d)} — ${d.expiryDate} (in ${daysFromToday(d.expiryDate)} days)` })) }] } });
    }
  });
}

// ── 16. Document integrity ────────────────────────────────────────────────────────────────────

export const INTEGRITY = "document-integrity";

export async function runDocumentIntegrity() {
  return runFindings(INTEGRITY, ["same-number", "id-mismatch", "name-mismatch", "dates"], async raise => {
    const docs = await prisma.document.findMany({ where: { supersededAt: null, NOT: { employeeId: null } }, select: { id: true, docType: true, docNumber: true, person: true, employeeId: true, companyId: true, expiryDate: true, issueDate: true }, take: 50000 });
    const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(docs.map(d => d.employeeId!))] } }, select: { id: true, name: true, govId: true, archived: true, companyId: true } });
    const empOf = new Map(emps.map(e => [e.id, e]));
    const live = docs.filter(d => !empOf.get(d.employeeId!)?.archived);

    for (const [k, rows] of groupBy(live.filter(d => String(d.docNumber ?? "").replace(/\W/g, "").length >= 6), d => `${d.docType}|${String(d.docNumber).replace(/\W/g, "").toUpperCase()}`)) {
      const people = new Set(rows.map(r => r.employeeId));
      if (people.size < 2) continue;
      await raise({ kind: "same-number", key: `num:${k}`, companyId: rows[0].companyId,
        title: `${rows[0].docType} ${rows[0].docNumber} is recorded for ${people.size} different people`,
        summary: "One document number belongs to one person. One of these was typed or scanned onto the wrong employee.",
        output: { lists: [{ title: "Held by", items: rows.map(r => ({ text: `${empOf.get(r.employeeId!)?.name ?? r.person} · expires ${r.expiryDate ?? "?"}` })) }] } });
    }
    for (const d of live) {
      const e = empOf.get(d.employeeId!);
      if (!e) continue;
      const num = String(d.docNumber ?? "").replace(/\D/g, ""), gov = String(e.govId ?? "").replace(/\D/g, "");
      if (/iqama|resident|national id/i.test(d.docType) && num.length === 10 && gov.length === 10 && num !== gov) {
        await raise({ kind: "id-mismatch", key: `id:${d.id}`, companyId: d.companyId, employeeId: e.id,
          title: `${e.name}'s Iqama number ${d.docNumber} is not their ID ${e.govId}`,
          summary: "The Iqama number is the person's ID. Either the document or the employee record has the wrong number.", output: {} });
      }
      const a = normName(d.person), b = normName(e.name);
      if (a.length >= 2 && b.length >= 2 && !a.some(t => b.includes(t))) {
        await raise({ kind: "name-mismatch", key: `name:${d.id}`, companyId: d.companyId, employeeId: e.id,
          title: `A ${d.docType} in the name of “${d.person}” is filed under ${e.name}`,
          summary: "No part of the two names matches. It is probably on the wrong person.", output: {} });
      }
      if (d.issueDate && d.expiryDate && d.issueDate.slice(0, 10) >= d.expiryDate.slice(0, 10)) {
        await raise({ kind: "dates", key: `dates:${d.id}`, companyId: d.companyId, employeeId: e.id,
          title: `${e.name}'s ${d.docType} expires before it was issued`,
          summary: `Issued ${d.issueDate}, expires ${d.expiryDate}. The dates are swapped or mistyped, so reminders fire at the wrong time.`, output: {} });
      }
    }
  });
}

// ── 17. Dependents and family visas ───────────────────────────────────────────────────────────

export const FAMILY = "dependents-watch";
const FAMILY_TYPE = /dependent|dependant|family|spouse|child|exit.?re.?entry|re.?entry|تابع|مرافق|خروج وعودة/i;

export async function runDependentsWatch() {
  const types = (await prisma.documentType.findMany({ where: { retired: false }, select: { name: true } })).map(t => t.name).filter(n => FAMILY_TYPE.test(n));
  const docTypesInUse = (await prisma.document.findMany({ where: { supersededAt: null }, distinct: ["docType"], select: { docType: true } })).map(d => d.docType).filter(n => FAMILY_TYPE.test(n));
  const watch = [...new Set([...types, ...docTypesInUse])];
  if (!watch.length) {
    await markRun(FAMILY);
    return { opened: 0, open: 0, closed: 0, details: ["No dependent, family or exit re-entry document types exist yet — add them under Document Types to track them."] };
  }
  return runFindings(FAMILY, ["family"], async raise => {
    const docs = await prisma.document.findMany({ where: { docType: { in: watch }, supersededAt: null, renewalRunId: null, renewalTaskId: null, expiryDate: { lte: addDays(today(), 45) } }, select: { companyId: true, docType: true, person: true, expiryDate: true, employeeId: true } });
    const cos = await prisma.company.findMany({ where: { id: { in: [...new Set(docs.map(d => d.companyId))] }, lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true } });
    for (const co of cos) {
      const rows = docs.filter(d => d.companyId === co.id).sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
      if (!rows.length) continue;
      const expired = rows.filter(r => (daysFromToday(r.expiryDate) ?? 0) < 0).length;
      await raise({ kind: "family", key: `family:${co.id}`, companyId: co.id,
        title: `${plural(rows.length, "family or re-entry document")} ${expired ? `(${expired} expired)` : "expiring within 45 days"} — ${co.name}`,
        summary: "Dependents' Iqamas and exit re-entry visas are easy to miss because they are not the employee's own. An expired re-entry visa strands the person abroad.",
        output: { lists: [{ title: "Documents", items: rows.slice(0, LIST_MAX).map(r => ({ text: `${r.docType} — ${r.person} — ${r.expiryDate} (${(daysFromToday(r.expiryDate) ?? 0) < 0 ? `expired ${-(daysFromToday(r.expiryDate) ?? 0)} days ago` : `in ${daysFromToday(r.expiryDate)} days`})` })) }] } });
    }
    return [`Watching: ${watch.join(", ")}.`];
  });
}

export const actRecon = standardAct(RECON, { module: "Compliance", what: "close reconciliation findings" });
export const actLicences = standardAct(LICENCES, { module: "Compliance", what: "close licence warnings" });
export const actIntegrity = standardAct(INTEGRITY, { module: "Compliance", what: "close document findings" });
export const actFamily = standardAct(FAMILY, { module: "Compliance", what: "close dependent warnings" });
export { AgentActionError };
