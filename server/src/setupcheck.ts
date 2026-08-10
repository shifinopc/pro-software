/**
 * What is not set up, and what that stops working.
 *
 * WHY THIS IS NOT A CHECKLIST
 *
 * A list of things somebody has not filled in is a nag. What makes this worth a screen is the second
 * half of every line: the CONSEQUENCE. "9 services have no workflow" is a statistic; "winning a deal
 * for these 9 services starts no work" is a reason to go and fix it. Every finding below states what
 * it breaks, and findings that break nothing do not appear.
 *
 * EVERYTHING IS COUNTED WHEN ASKED
 *
 * No stored score, no cached counts. The whole point is that the number goes down as somebody works
 * through it, and a cached figure would keep congratulating them for work they have not done.
 *
 * SEVERITY MEANS SOMETHING SPECIFIC
 *
 *   broken     — a feature cannot work at all until this is set. Not "should"; cannot.
 *   degraded   — it works, but silently gives a worse or partial answer.
 *   incomplete — real data is missing. Nothing misbehaves; you just cannot see as much.
 */
import { prisma } from "./db.js";
import { ACTIVE_CLIENT } from "./validate.js";
import { homeCountry, homeMarketIsConfigured } from "./orgsettings.js";
import { countryName } from "./countries.js";
import { existingDuplicatePairs } from "./duplicates.js";

export type Severity = "broken" | "degraded" | "incomplete";

export interface Finding {
  key: string;
  severity: Severity;
  title: string;
  /** What this stops working, in one sentence, in the words of somebody using the product. */
  blocks: string;
  count: number;
  /** The total it is a count OF, where that makes the number readable ("9 of 14"). */
  of?: number;
  /** The console screen that fixes it. */
  screen: string;
  /** A few examples, so it is obvious which rows are meant. */
  examples?: string[];
}

const some = (names: (string | null | undefined)[], n = 3) =>
  names.filter(Boolean).slice(0, n) as string[];

export async function setupCheck(countryArg?: string): Promise<{
  country: string; countryLabel: string;
  findings: Finding[];
  totals: { broken: number; degraded: number; incomplete: number };
}> {
  // Resolved here rather than as a default parameter, because the home market is a setting now and a
  // default parameter cannot await one.
  const country = String(countryArg ?? "").trim().toUpperCase() || await homeCountry();

  const findings: Finding[] = [];
  const add = (f: Finding) => { if (f.count > 0) findings.push(f); };

  // ── has the firm actually said where it operates? ──────────────────────────────────────────
  // Everything below is scoped to a country, and every record created without one inherits it. On a
  // fresh install that is a seed default nobody chose — worth saying so, once, rather than letting
  // a whole database quietly fill up as Saudi because nobody was asked.
  add({
    key: "no-home-country", severity: "degraded", count: (await homeMarketIsConfigured()) ? 0 : 1, screen: "Settings",
    title: "No home market chosen",
    blocks: `Records created without a country are filed as ${countryName(country)} and figures default to its currency, because that is the seed default rather than a decision.`,
  });

  // ── the country's own lists ────────────────────────────────────────────────────────────────
  const [stages, bands, sources, reasons] = await Promise.all([
    prisma.pipelineStage.count({ where: { country, retired: false } }),
    prisma.workforceBand.count({ where: { country, retired: false } }),
    prisma.leadSource.count({ where: { country, retired: false } }),
    prisma.lostReason.count({ where: { country, retired: false } }),
  ]);
  add({
    key: "no-stages", severity: "broken", count: stages === 0 ? 1 : 0, screen: "Sales Settings",
    title: `No pipeline stages for ${countryName(country)}`,
    blocks: "The pipeline board is empty and no deal can be created at all.",
  });
  add({
    key: "no-bands", severity: "broken", count: bands === 0 ? 1 : 0, screen: "Country Rules",
    title: `No nationalisation bands for ${countryName(country)}`,
    blocks: "Every client's Saudization ratio is shown with no band, so nothing can be flagged as at risk.",
  });
  add({
    key: "no-sources", severity: "degraded", count: sources === 0 ? 1 : 0, screen: "Sales Settings",
    title: "No lead sources set up",
    blocks: "\"Where from\" is free text, so the source report splits one answer across every spelling of it.",
  });
  add({
    key: "no-reasons", severity: "degraded", count: reasons === 0 ? 1 : 0, screen: "Sales Settings",
    title: "No loss reasons set up",
    blocks: "\"Price\", \"price\" and \"too expensive\" arrive as three rows in the loss report, hiding the pattern.",
  });

  // ── services and the work they are meant to start ──────────────────────────────────────────
  const services = await prisma.serviceItem.findMany({ where: { retired: false }, select: { name: true, workflowId: true, requiredDocs: true } });
  const unbound = services.filter(s => !s.workflowId);
  add({
    key: "services-no-workflow", severity: "broken", count: unbound.length, of: services.length, screen: "Service Catalog",
    title: "Services with no workflow bound",
    blocks: "Accepting a quotation or a request for these starts no work — the client is waiting and nobody has a task.",
    examples: some(unbound.map(s => s.name)),
  });

  // ── document types ─────────────────────────────────────────────────────────────────────────
  const docTypes = await prisma.documentType.findMany({ where: { retired: false }, select: { name: true, fields: true, authority: true } });
  const noFields = docTypes.filter(d => !Array.isArray(d.fields) || (d.fields as any[]).length === 0);
  add({
    key: "doctypes-no-fields", severity: "degraded", count: noFields.length, of: docTypes.length, screen: "Document Types",
    title: "Document types that capture no details",
    blocks: "Only a number and an expiry date are recorded, so anything else on the document lives in somebody's memory.",
    examples: some(noFields.map(d => d.name)),
  });

  // ── workflow steps ─────────────────────────────────────────────────────────────────────────
  const templates = await prisma.workflowTemplate.findMany({ where: { retired: false }, select: { name: true, graph: true, active: true } });
  let steps = 0, noPortal = 0, noRole = 0, humanSteps = 0;
  const portalEx: string[] = [], roleEx: string[] = [];
  for (const t of templates) {
    const nodes = ((t.graph as any)?.nodes ?? []) as any[];
    for (const n of nodes) {
      if (n?.type === "trigger" || n?.type === "end") continue;
      steps++;
      // ONLY STEPS THAT CAN PRODUCE A TASK. `task` and `approval` are the two node types the engine
      // turns into work on somebody's desk; a delay, a split, a decision, a notify or an invoice
      // step runs itself and has nobody to assign. Counting all of them said "122 of 190 steps have
      // no role" when the answer was 12 of 105 — and a finding inflated tenfold is one people learn
      // to scroll past, which costs more than the twelve steps it was trying to report.
      if (n?.type !== "task" && n?.type !== "approval") continue;
      humanSteps++;
      if (!n?.config?.assigneeRole && !n?.config?.approverRole) {
        noRole++;
        if (roleEx.length < 3) roleEx.push(`${t.name} — ${n.label ?? n.id}`);
      }
      // UNANSWERED, not "has no portal". `noPortal: true` is somebody having decided this step is
      // office work, which is a complete answer and must not be reported as a gap — otherwise the
      // list can never reach zero and stops being worth opening. The Builder used to store that
      // choice as a deleted key, indistinguishable from never having been asked, which is why this
      // read "190 of 190" for a question most steps had a real answer to.
      if (!n?.config?.govCenter && !n?.config?.noPortal) {
        noPortal++;
        if (portalEx.length < 3) portalEx.push(`${t.name} — ${n.label ?? n.id}`);
      }
    }
  }
  add({
    key: "steps-no-portal", severity: "degraded", count: noPortal, of: humanSteps, screen: "Workflow Builder",
    title: "Workflow steps not yet marked portal or office work",
    blocks: "The Government Centers queue cannot group work by authority, so an officer going to Qiwa cannot see everything waiting there.",
    examples: portalEx,
  });
  add({
    key: "steps-no-role", severity: "degraded", count: noRole, of: humanSteps, screen: "Workflow Builder",
    title: "Workflow steps with no role",
    blocks: "Tasks from these steps land unassigned and wait for somebody to notice them.",
    examples: roleEx,
  });

  // ── clients ────────────────────────────────────────────────────────────────────────────────
  const clients = await prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { name: true, cr: true, ownerId: true, country: true } });
  const unowned = clients.filter(c => !c.ownerId);
  add({
    key: "clients-no-owner", severity: "broken", count: unowned.length, of: clients.length, screen: "Clients",
    title: "Clients nobody owns",
    blocks: "A sales user sees only the clients they own, so these are invisible to every one of them.",
    examples: some(unowned.map(c => c.name)),
  });
  const noCr = clients.filter(c => !c.cr);
  add({
    key: "clients-no-cr", severity: "incomplete", count: noCr.length, of: clients.length, screen: "Clients",
    title: "Clients with no CR number",
    blocks: "Government submissions are filed under the CR, so it has to be found somewhere else each time.",
    examples: some(noCr.map(c => c.name)),
  });
  const noCountry = clients.filter(c => !c.country);
  add({
    key: "clients-no-country", severity: "broken", count: noCountry.length, of: clients.length, screen: "Clients",
    title: "Clients with no country",
    blocks: "No country means no bands, no pipeline and no document types apply — the client falls out of every country-scoped rule.",
    examples: some(noCountry.map(c => c.name)),
  });

  // ── employees, and the figures Saudization is measured on ──────────────────────────────────
  const emps = await prisma.employee.findMany({
    where: { archived: false, exitStatus: { not: "exited" } },
    select: { name: true, nationality: true, dob: true, salary: true, employmentType: true },
  });
  const noNationality = emps.filter(e => !e.nationality);
  add({
    key: "employees-no-nationality", severity: "broken", count: noNationality.length, of: emps.length, screen: "Employees",
    title: "Employees with no nationality recorded",
    blocks: "The nationalisation ratio cannot be stated as a single figure — it is reported as a range until every one is known.",
    examples: some(noNationality.map(e => e.name)),
  });
  const noType = emps.filter(e => !e.employmentType);
  add({
    key: "employees-no-type", severity: "incomplete", count: noType.length, of: emps.length, screen: "Employees",
    title: "Employees with no employment type",
    blocks: "Part-time staff count differently towards nationalisation, and without this everybody counts as full-time.",
    examples: some(noType.map(e => e.name)),
  });
  const noDob = emps.filter(e => !e.dob);
  add({
    key: "employees-no-dob", severity: "incomplete", count: noDob.length, of: emps.length, screen: "Employees",
    title: "Employees with no date of birth",
    blocks: "Age-based prerequisites on a document type cannot be checked, so they are skipped rather than enforced.",
    examples: some(noDob.map(e => e.name)),
  });

  // ── companies entered twice ────────────────────────────────────────────────────────────────
  // The one finding here that gets HARDER with time: every month of entry adds pairs, and merging
  // two records that both have documents, invoices and history against them is a job nobody wants.
  const dupes = await existingDuplicatePairs();
  add({
    key: "duplicate-companies", severity: "degraded", count: dupes.length, screen: "Clients",
    title: "Companies that look like they were entered twice",
    blocks: "Documents, deals and invoices split across two records, so neither one shows the full picture of that client.",
    examples: dupes.slice(0, 3).map(d => `${d.a} ↔ ${d.b} · ${d.why.toLowerCase()}`),
  });

  // ── email ──────────────────────────────────────────────────────────────────────────────────
  const mail = await prisma.appSetting.findUnique({ where: { key: "email" } });
  const mailOk = !!((mail?.value as any)?.host);
  add({
    key: "no-smtp", severity: "degraded", count: mailOk ? 0 : 1, screen: "Settings",
    title: "No mail server configured",
    blocks: "Nothing is emailed: portal invitations, password resets and every expiry reminder stay inside the console.",
  });

  // Mail that was attempted and did not arrive. Distinct from "no mail server": this one is
  // configured and failing, which is worse — everybody believes the clients were told.
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const failedMail = await prisma.mailLog.findMany({
    where: { status: "failed", at: { gte: since7 } },
    orderBy: { at: "desc" }, take: 3,
    select: { to: true, error: true },
  });
  const failedCount = await prisma.mailLog.count({ where: { status: "failed", at: { gte: since7 } } });
  add({
    key: "mail-failing", severity: "broken", count: failedCount, screen: "Settings",
    title: "Emails are failing to send",
    blocks: "Those messages did not arrive. Nobody is told when a send fails, so a client waiting on an invitation or an invoice is simply waiting.",
    examples: failedMail.map(f => `${f.to} — ${(f.error ?? "no reason recorded").slice(0, 90)}`),
  });

  const totals = {
    broken: findings.filter(f => f.severity === "broken").length,
    degraded: findings.filter(f => f.severity === "degraded").length,
    incomplete: findings.filter(f => f.severity === "incomplete").length,
  };
  // Worst first: somebody working down this list should hit the things that are actually broken
  // before the things that are merely thin.
  const rank: Record<Severity, number> = { broken: 0, degraded: 1, incomplete: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);

  return { country, countryLabel: countryName(country), findings, totals };
}
