/**
 * THE AGENTS — one registry for the Configure → Agents screen, the scheduler and the routes.
 *
 * Each agent prepares work and a person decides. They all start switched off. Those that can use a
 * model say whether they need one ("required"), work better with one ("optional"), or never use one
 * ("none") — and why, because that is the question an admin choosing a model is actually asking.
 */
import { prisma } from "./db.js";
import { anyModelReady, availableModels, isAvailableModel, modelLabel } from "./ai.js";
import { agentSetting, saveAgentSetting, lastRun, dueDaily, isAdmin, AgentActionError, type AgentActor, type ModelUse } from "./agent-core.js";
import { intakeStatus, setIntakeSettings, intakeActivity } from "./intake-agent.js";
import * as renewal from "./agent-renewal-prep.js";
import * as triage from "./agent-triage.js";
import * as collections from "./agent-collections.js";
import * as quality from "./agent-data-quality.js";
import * as nitaqat from "./agent-nitaqat.js";
import * as assistant from "./agent-assistant.js";
import * as unbilled from "./agent-unbilled.js";
import * as chaser from "./agent-chaser.js";
import * as sla from "./agent-sla.js";
import * as bank from "./agent-bank.js";
import * as visits from "./agent-visits.js";
import * as crm from "./agent-crm.js";
import * as proOps from "./agent-pro-ops.js";
import * as clientsAg from "./agent-clients.js";
import * as compliance from "./agent-compliance.js";
import * as financeOps from "./agent-finance-ops.js";
import * as brief from "./agent-brief.js";

type Def = {
  key: string; name: string; icon: string; does: string; never: string;
  modelUse: ModelUse; modelWhy: string; cadence: string;
  run?: () => Promise<any>; daily?: boolean;
  act?: (id: string, action: string, input: any, actor: AgentActor) => Promise<any>;
  /** Agents built on agent-kit: their actions come from what the item carries — see kitActions. */
  kit?: boolean; openTab?: string;
};

const NONE = "Every check is a comparison of records — nothing is sent to a model.";
const daily = (d: Omit<Def, "modelUse" | "modelWhy" | "daily" | "kit">): Def => ({ modelUse: "none", modelWhy: NONE, daily: true, kit: true, ...d });

export const AGENTS: Def[] = [
  {
    key: "document-intake", name: "Document Intake", icon: "scan",
    does: "Reads scanned passports, Iqamas, CRs, permits and insurance cards, checks them against what is on file, and prepares the document for a person to accept.",
    never: "Never creates a document by itself — every reading waits for a person to accept or reject it.",
    modelUse: "optional", modelWhy: "Passports are read by the built-in reader — OCR of the machine-readable zone, proven by its check digits — and never leave the server. Iqamas, CRs, permits, insurance cards and PDFs need a model; with one chosen, the scan image is sent to it.",
    cadence: "When someone scans a document",
  },
  {
    key: renewal.KEY, name: "Renewal Preparation", icon: "renew",
    does: "When a renewal run reaches its gate check, ticks what the records prove (passport 6+ months, insurance current, work permit valid), flags what only a government portal can show, and drafts the fee-approval message to the client.",
    never: "Never completes a step, verifies an item or sends the message — the officer reviews and sends.",
    modelUse: "optional", modelWhy: "Checks never use a model. With one, the fee message is written for each case; without, a standard wording is used. Client, employee and fee details are sent to it.",
    cadence: "Every hour", run: () => renewal.runRenewalPrep(), act: renewal.act,
  },
  {
    key: triage.KEY, name: "Request Triage", icon: "inbox",
    does: "Works out which service a portal request is for and which employee it concerns, checks the attachments against that service's required documents, drafts the reply, and proposes accepting it or quoting it.",
    never: "Never replies, accepts or quotes by itself. Emailed requests cannot be triaged yet — mailbox sync stores no message bodies.",
    modelUse: "optional", modelWhy: "Without a model it matches by service name, ID number and full name. With one it can read free-text requests. The request text and employee names are sent to it.",
    cadence: "When a request arrives, and every hour", run: () => triage.runTriage(), act: triage.act,
  },
  {
    key: collections.KEY, name: "Collections", icon: "coins",
    does: "Pairs a client's “I've paid” notice with the open invoices it covers so the accountant just confirms, and adds a line to each overdue reminder written from that client's own payment history.",
    never: "Never records a payment by itself — the accountant confirms the money landed first.",
    modelUse: "none", modelWhy: "Reminders go out automatically, so their wording comes from the payment records only — no model writes unsupervised mail about money.",
    cadence: "When a payment is reported, and every hour", run: () => collections.runCollections(), act: collections.act,
  },
  {
    key: quality.KEY, name: "Data Quality", icon: "sweep",
    does: "Once a day, finds employees with no government ID, likely duplicate employees, expired documents with no renewal running, and job titles not on Qiwa's occupation list.",
    never: "Raises a review queue — never edits, merges or deletes a record.",
    modelUse: "none", modelWhy: "Every check is a database query.",
    cadence: "Once a day", run: quality.runDataQuality, daily: true, act: quality.act,
  },
  {
    key: nitaqat.KEY, name: "Nitaqat Advisor", icon: "gauge",
    does: "Projects each client's Saudization band from the exits already requested and the hires already in progress, warns before a band drops, and works out the cheapest way to hold it — including counting rules like a Saudi with a disability counting as four.",
    never: "Advice only — never changes a band, an employee or a workflow.",
    modelUse: "none", modelWhy: "The projection uses the client's own ladder and counting rules, the same arithmetic as the band on their screen.",
    cadence: "Once a day", run: nitaqat.runNitaqat, daily: true, act: nitaqat.act,
  },
  {
    key: unbilled.KEY, name: "Unbilled Work", icon: "receipt",
    does: "Once a day, finds work that was done but never charged: quotations the client accepted that were never invoiced, delivered requests for services outside the client's plan, and finished renewals whose fees were never billed. Proposes a draft invoice for each.",
    never: "Never raises an invoice by itself — it creates a draft only when someone presses the button, and the draft still needs approving.",
    modelUse: "none", modelWhy: "Every check is a comparison of work records against invoices.",
    cadence: "Once a day", run: unbilled.runUnbilled, daily: true, act: unbilled.act,
  },
  {
    key: chaser.KEY, name: "Client Document Chaser", icon: "bell",
    does: "Finds work waiting on the client — documents missing from a request, a renewal held for a passport or insurance, a fee approval not answered — and reminds them after 2, 5 and 9 days, stopping as soon as it arrives. At 12 days the officer is told to call.",
    never: "Sends only templated reminders built from the records, only in office hours, and never to a suspended client. It never changes the work itself.",
    modelUse: "none", modelWhy: "Reminders go out unreviewed, so they are templates filled with facts from the records.",
    cadence: "Every hour", run: () => chaser.runChaser(), act: chaser.act,
  },
  {
    key: sla.KEY, name: "SLA Rescue and Workload", icon: "timer",
    does: "Warns before a step misses its deadline, from how long that same step has really taken before. Spots officers carrying far more than their colleagues, steps left with deactivated accounts, and ordinary tasks past due — and proposes who should take the work.",
    never: "Moves nothing by itself. An admin moves the work, the new person is told, and a stale proposal cannot take work off whoever holds it now.",
    modelUse: "none", modelWhy: "Estimates come from the real durations of past steps.",
    cadence: "Every hour", run: () => sla.runSlaRescue(), act: sla.act,
  },
  {
    key: bank.KEY, name: "Bank Reconciliation", icon: "bank",
    does: "Reads the bank statement you upload (CSV from any bank), recognises deposits already recorded, and matches the rest to invoices — by invoice number in the transfer, a client's payment notice, the client's name with the amount owed, or a unique amount. Lists what it cannot place.",
    never: "Never records a payment by itself — the accountant confirms each match. A statement uploaded twice imports each line once.",
    modelUse: "none", modelWhy: "Every match is text and arithmetic, and says which rule made it.",
    cadence: "When a statement is uploaded, and once a day", run: () => bank.runBank(), daily: true, act: bank.act,
  },
  {
    key: visits.KEY, name: "Government Visit Planner", icon: "route",
    does: "Gathers the coming week's in-person work — booked appointments, workflow steps at government offices, courier pickups — and plans it as the fewest trips that still meet every deadline. One click turns each trip into a task for the officer.",
    never: "Plans only — it books nothing, moves no appointment and assigns no step.",
    modelUse: "none", modelWhy: "The plan is dates, deadlines and places.",
    cadence: "Once a day", run: () => visits.runVisitPlanner(), daily: true, act: visits.act,
  },
  {
    key: assistant.KEY, name: "Console Assistant", icon: "chat",
    does: "Answers plain-language questions — “which Iqamas expire this month for Malbriz, and what's blocking each?” — from the same data the person asking can already see, with links to the records.",
    never: "Read-only: it has lookup tools and nothing that writes, sends or starts anything.",
    modelUse: "required", modelWhy: "Understanding the question needs a model. The records it looks up to answer are sent to it.",
    cadence: "When someone asks",
  },
  // ── CRM ──
  daily({ key: crm.LEADS, name: "Lead Follow-up", icon: "phone", cadence: "Once a day", run: crm.runLeadFollowUp, act: crm.actLeads, openTab: "Overview",
    does: "Builds each salesperson's call list: follow-ups that are due or overdue, and leads nobody has contacted for a week — most urgent first. Unowned leads get their own list.",
    never: "Never calls, emails or changes a lead. The list clears itself as calls are logged." }),
  daily({ key: crm.QUOTES, name: "Quotation Chaser", icon: "quote", cadence: "Once a day", run: crm.runQuoteChaser, act: crm.actQuotes, openTab: "Overview",
    does: "Follows every sent quotation: a first, second and third follow-up at 3, 7 and 14 days with what to say, and quotations that expired unanswered so they are re-issued or recorded as lost.",
    never: "Never contacts the client or changes a quotation's status." }),
  daily({ key: crm.WON, name: "Won Deal to Onboarding", icon: "handshake", cadence: "Once a day", run: crm.runWonOnboarding, act: crm.actWon, openTab: "Overview",
    does: "When a quotation is accepted or a deal is won, checks the client is really set up — client record, CR, package, portal, employees, work started, invoiced — and prepares the onboarding tasks.",
    never: "Creates tasks only when someone presses the button. Changes no record." }),
  daily({ key: crm.DUPES, name: "Duplicate Records", icon: "copy", cadence: "Once a day", run: crm.runCrmDuplicates, act: crm.actDupes, openTab: "Overview",
    does: "Finds leads and clients entered twice — same CR, phone, email or name — and contacts that appear at several companies.",
    never: "Never merges or deletes anything." }),
  // ── PRO work ──
  daily({ key: proOps.STUCK, name: "Stuck Workflows", icon: "pause", cadence: "Once a day", run: proOps.runStuckWorkflows, act: proOps.actStuck, openTab: "Overview",
    does: "Finds workflow runs that stopped moving: no step open but never finished, steps nobody can pick up, approvals waiting two days or more, and runs with no movement for five days.",
    never: "Never moves, completes or cancels a step." }),
  daily({ key: proOps.EXIT, name: "Employee Exit", icon: "exit", cadence: "Once a day", run: proOps.runEmployeeExits, act: proOps.actExit, openTab: "Employees",
    does: "For everyone leaving, checks the full exit — final exit visa, Qiwa contract ended, GOSI removal, insurance cancelled, final settlement — flags renewals still running on them, and prepares the missing tasks.",
    never: "Cancels nothing and closes no exit. Tasks are created only when someone presses the button." }),
  daily({ key: proOps.APPT, name: "Appointment Prep", icon: "calendar", cadence: "Once a day", run: proOps.runAppointmentPrep, act: proOps.actAppt, openTab: "Overview",
    does: "Checks the next two days' government appointments: confirmed, time and place set, the employee on file, passport and Iqama not expired, and an officer assigned.",
    never: "Never books, confirms or reschedules." }),
  daily({ key: proOps.ORIGINALS, name: "Original Documents", icon: "folder", cadence: "Once a day", run: proOps.runOriginalsTracker, act: proOps.actOriginals, openTab: "Overview",
    does: "Tracks original passports and cards the office collected: which have been held over 14 days without being sent back, and courier jobs past their expected date.",
    never: "Never changes a courier job." }),
  daily({ key: proOps.REPEAT, name: "Repeat Work", icon: "repeat", cadence: "Once a day", run: proOps.runRepeatWork, act: proOps.actRepeat, openTab: "Overview",
    does: "Spots work done by hand again and again — services with no workflow requested several times, and the same task typed in for many clients — so it can become a workflow.",
    never: "Suggests only. Creates no template." }),
  // ── Clients ──
  daily({ key: clientsAg.ONBOARD, name: "Client Onboarding", icon: "userplus", cadence: "Once a day", run: clientsAg.runClientOnboarding, act: clientsAg.actOnboard, openTab: "Overview",
    does: "For clients taken on in the last 90 days, checks CR, a contact with email, package, portal sign-in, employees and company documents — and keeps the gap list until it is complete.",
    never: "Changes nothing on the client." }),
  daily({ key: clientsAg.WEEKLY, name: "Weekly Client Report", icon: "mail", cadence: "Once a day, one draft per client per week", run: clientsAg.runWeeklyClientReport, act: clientsAg.actWeekly, openTab: "Overview",
    does: "Drafts each client's weekly update: work in progress, what is waiting on them, documents expiring in 30 days and invoices open. Staff read it, edit it and send it.",
    never: "Never sends by itself. Unsent drafts are replaced by the next week's." }),
  daily({ key: clientsAg.PORTAL, name: "Portal Adoption", icon: "key", cadence: "Once a day", run: clientsAg.runPortalAdoption, act: clientsAg.actPortal, openTab: "Overview",
    does: "Finds clients with no portal access, and clients whose invitations were never used — and re-sends those invitations when you press the button.",
    never: "Never creates a portal user. Invitations go out only when someone presses Re-send." }),
  daily({ key: clientsAg.RISK, name: "Client Risk Watch", icon: "alert", cadence: "Once a day", run: clientsAg.runClientRisk, act: clientsAg.actRisk, openTab: "Overview",
    does: "Adds up warning signs for each client — overdue invoices, missed deadlines, ignored document requests, rejected requests, no contact for 60 days, a package not set to renew — and flags those that may leave.",
    never: "Advice only. Contacts nobody." }),
  // ── Compliance ──
  { key: compliance.RECON, name: "Government Portal Reconciler", icon: "compare", modelUse: "none", modelWhy: NONE, kit: true, openTab: "Employees", act: compliance.actRecon,
    cadence: "When an export is uploaded",
    does: "Upload an employee export from Muqeem, Qiwa or GOSI (CSV). It lists people the government counts that you do not have, employees you have that the portal does not, and different expiry dates, occupations and names.",
    never: "Never updates an employee or document from the file — a person decides which side is wrong." },
  daily({ key: compliance.LICENCES, name: "Company Licence Watch", icon: "building", cadence: "Once a day", run: compliance.runCompanyLicences, act: compliance.actLicences, openTab: "Documents",
    does: "Watches each client's company documents — CR, Chamber, GOSI and Zakat certificates, municipality licence — and warns 60 days before one expires with no renewal started.",
    never: "Starts no renewal." }),
  daily({ key: compliance.INTEGRITY, name: "Document Integrity", icon: "shield", cadence: "Once a day", run: compliance.runDocumentIntegrity, act: compliance.actIntegrity, openTab: "Documents",
    does: "Finds documents that contradict their owner: one number on two people, an Iqama number that is not the employee's ID, a name that does not match, an expiry before the issue date.",
    never: "Never edits or moves a document." }),
  daily({ key: compliance.FAMILY, name: "Dependents and Re-entry", icon: "family", cadence: "Once a day", run: compliance.runDependentsWatch, act: compliance.actFamily, openTab: "Documents",
    does: "Watches dependents' Iqamas, family visas and exit re-entry visas — the ones that are not the employee's own and get forgotten — and warns 45 days before they expire.",
    never: "Starts no renewal." }),
  // ── Finance ──
  daily({ key: financeOps.FEES, name: "Government Fee Recovery", icon: "coins", cadence: "Once a day", run: financeOps.runFeeRecovery, act: financeOps.actFees, openTab: "Invoices",
    does: "Finds government fees recorded on renewals done by hand that were never charged back to the client, and proposes a draft invoice for each. (Fees on workflow runs are covered by Unbilled Work.)",
    never: "Creates a draft only when someone presses the button; the draft still needs approving." }),
  daily({ key: financeOps.SUBS, name: "Subscription Billing Check", icon: "receipt", cadence: "Once a day", run: financeOps.runSubscriptionBilling, act: financeOps.actSubs, openTab: "Invoices",
    does: "Checks every active package: no invoice for a full billing period, a plan invoice at a different price, and add-ons unlocked but never charged.",
    never: "Creates a draft only when someone presses the button." }),
  // ── Management ──
  daily({ key: brief.BRIEF, name: "Daily Manager Brief", icon: "sun", cadence: "Every morning", run: brief.runManagerBrief, act: brief.actBrief, openTab: "Overview",
    does: "One page each morning: late tasks, steps past deadline, legal deadlines in 3 days, today's appointments, cash expected this week and overdue, workload per person, and what every agent is waiting on.",
    never: "Read-only." }),
];
const byKey = (k: string) => AGENTS.find(a => a.key === k);

// ── what is running right now (one process — this is the truth for the working animation) ─────

const running = new Map<string, { since: string; what: string }>();

async function runOne(def: Def, source: string) {
  if (!def.run || running.has(def.key)) return { skipped: running.has(def.key) ? "already running" : "nothing to run" };
  running.set(def.key, { since: new Date().toISOString(), what: source === "manual" ? "Running now" : "Checking" });
  try { return await def.run(); } finally { running.delete(def.key); }
}

/** The scheduler's pass: every switched-on agent with work to do. */
export async function runAgents(source = "tick") {
  const out: Record<string, unknown> = {};
  for (const def of AGENTS) {
    if (!def.run || !(await agentSetting(def.key)).enabled) continue;
    if (def.daily && !(await dueDaily(def.key))) continue;
    try { out[def.key] = await runOne(def, source); } catch (e: any) { out[def.key] = { error: String(e?.message ?? e) }; }
  }
  return out;
}

/** Something just happened that an agent handles — run it now rather than at the next hour. */
export function kickAgent(key: string) {
  const def = byKey(key);
  if (!def?.run) return;
  void (async () => { if ((await agentSetting(key)).enabled) await runOne(def, "event"); })().catch(e => console.error(`[agents] ${key}:`, e?.message ?? e));
}

export async function runNow(key: string, actor: AgentActor) {
  if (!isAdmin(actor)) throw new AgentActionError("Only an admin can run an agent by hand.", 403);
  const def = byKey(key);
  if (!def?.run) throw new AgentActionError("This agent does not run on a schedule.", 400);
  if (!(await agentSetting(key)).enabled) throw new AgentActionError("Turn the agent on first.", 409);
  return runOne(def, "manual");
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────

export async function updateAgent(key: string, next: { enabled?: boolean; model?: string | null; qiwaOccupations?: string[]; inPersonCenters?: string[] | null }, actor: AgentActor) {
  if (!isAdmin(actor)) throw new AgentActionError("Only an admin can change agents.", 403);
  const def = byKey(key);
  if (!def) throw new AgentActionError("Unknown agent.", 404);
  if (key === "document-intake") {
    if (next.model && !isAvailableModel(next.model)) throw new AgentActionError("That model is not configured on this server.", 400);
    await setIntakeSettings({ enabled: next.enabled, model: next.model });
    return;
  }
  if (next.enabled === true && def.modelUse === "required" && !anyModelReady()) throw new AgentActionError("This agent needs a model, and no model is connected on the server.", 409);
  if (next.model && !isAvailableModel(next.model)) throw new AgentActionError("That model is not configured on this server.", 400);
  const model = def.modelUse === "none" ? null : next.model;
  await saveAgentSetting(key, {
    enabled: next.enabled,
    ...(model !== undefined ? { model } : {}),
    ...(next.qiwaOccupations ? { options: { qiwaOccupations: next.qiwaOccupations.map(s => String(s).trim()).filter(Boolean).slice(0, 5000) } } : {}),
    // null goes back to the agent's own guess from the center names.
    ...(next.inPersonCenters !== undefined ? { options: { inPersonCenters: next.inPersonCenters === null ? undefined : next.inPersonCenters.map(s => String(s).trim()).filter(Boolean).slice(0, 500) } } : {}),
  });
  // A required-model agent turned on without a model gets the most capable one rather than failing later.
  const s = await agentSetting(key);
  if (s.enabled && def.modelUse === "required" && !s.model && availableModels()[0]) await saveAgentSetting(key, { model: availableModels()[0].id });
}

export async function actOnTask(id: string, action: string, input: any, actor: AgentActor) {
  const t = await prisma.agentTask.findUnique({ where: { id }, select: { agent: true } });
  if (!t) throw new AgentActionError("That task no longer exists.", 404);
  const def = byKey(t.agent);
  if (!def?.act) throw new AgentActionError("This agent has nothing to act on.", 400);
  return def.act(id, action, input, actor);
}

export const askAssistant = assistant.ask;
export const importGovExport = compliance.importExport;
export const GovExportError = compliance.ExportError;

// ── the screen ────────────────────────────────────────────────────────────────────────────────

const STALE_WORKING_MS = 5 * 60 * 1000;

function kitActions(t: { agent: string; status: string; output: any }) {
  if (t.status !== "review") return [];
  const o = t.output ?? {};
  const a: { key: string; label: string; primary?: boolean }[] = [];
  if (t.agent === clientsAg.PORTAL && Array.isArray(o.invitees) && o.invitees.length) a.push({ key: "resend", label: "Re-send invitations", primary: true });
  if (Array.isArray(o.tasks) && o.tasks.length) a.push({ key: "tasks", label: `Create ${o.tasks.length} task${o.tasks.length === 1 ? "" : "s"}`, primary: true });
  if (Array.isArray(o.lines) && o.lines.length) a.push({ key: "invoice", label: "Create draft invoice", primary: true });
  if (o.draft) a.push({ key: "send", label: "Review and send", primary: true });
  a.push({ key: "done", label: t.agent === brief.BRIEF ? "Mark read" : "Mark handled", primary: !a.length });
  if (t.agent !== brief.BRIEF) a.push({ key: "dismiss", label: "Not a problem" });
  return a;
}

function actionsFor(t: { agent: string; kind: string; status: string; output: any }) {
  if (byKey(t.agent)?.kit) return kitActions(t);
  if (t.agent === chaser.KEY && (t.status === "review" || t.status === "watching")) {
    return [{ key: "done", label: t.status === "review" ? "Called the client" : "Handled another way", primary: t.status === "review" }, { key: "dismiss", label: "Stop reminding" }];
  }
  if (t.status !== "review") return [];
  const a: { key: string; label: string; primary?: boolean }[] = [];
  if (t.agent === unbilled.KEY) a.push({ key: "invoice", label: "Create draft invoice", primary: true });
  if (t.agent === bank.KEY && t.kind === "bank-match") a.push({ key: "record", label: "Confirm and record", primary: true });
  if (t.agent === visits.KEY) a.push({ key: "tasks", label: "Create visit tasks", primary: true });
  if (t.agent === sla.KEY && t.output?.proposal?.kind === "move" && (t.kind !== "likely-breach" || t.output?.toUserId)) a.push({ key: "move", label: t.kind === "likely-breach" ? "Move it" : "Move the steps", primary: true });
  if (t.agent === sla.KEY) a.push({ key: "done", label: "Mark handled" });
  if (t.agent === renewal.KEY) a.push({ key: "send", label: "Review and send", primary: true });
  if (t.agent === triage.KEY) {
    a.push({ key: "send", label: t.output?.replied ? "Reply again" : "Send reply", primary: !t.output?.replied });
    if (t.output?.proposal?.kind === "accept") a.push({ key: "accept", label: "Accept request", primary: !!t.output?.replied });
    if (t.output?.proposal?.kind === "quote") a.push({ key: "quote", label: "Draft quotation", primary: !!t.output?.replied });
  }
  if (t.agent === collections.KEY && t.output?.match?.allocations?.length) a.push({ key: "record", label: "Confirm and record", primary: true });
  if (t.agent === nitaqat.KEY) a.push({ key: "done", label: "Mark handled", primary: true });
  a.push({ key: "dismiss", label: t.agent === quality.KEY ? "Not a problem" : t.agent === unbilled.KEY ? "Covered — don't bill" : t.agent === bank.KEY ? "Not a client payment" : "Dismiss" });
  return a;
}

export async function agentsOverview(actor: AgentActor) {
  const now = Date.now();
  const intake = (await intakeActivity()).agents[0];
  const iStatus = await intakeStatus();
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const rows = await prisma.agentTask.findMany({ where: { OR: [{ status: { in: ["review", "working", "watching"] } }, { createdAt: { gte: since } }] }, orderBy: { createdAt: "desc" }, take: 2000 });
  const coIds = [...new Set(rows.map(r => r.companyId).filter(Boolean) as string[])];
  const userIds = [...new Set(rows.flatMap(r => [r.decidedBy, r.createdBy]).filter(Boolean) as string[])];
  const [cos, users] = await Promise.all([
    prisma.company.findMany({ where: { id: { in: coIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const coName = (id: string | null) => (id ? cos.find(c => c.id === id)?.name ?? null : null);
  const userName = (id: string | null) => (id ? users.find(u => u.id === id)?.name ?? null : null);
  const days = (list: { createdAt: string }[]) => [...Array(7)].map((_, i) => {
    const d = new Date(now - (6 - i) * 86_400_000); const key = d.toISOString().slice(0, 10);
    return { day: key, label: d.toLocaleDateString("en-GB", { weekday: "short" }), count: list.filter(r => r.createdAt.slice(0, 10) === key).length };
  });

  const agents = [];
  for (const def of AGENTS) {
    if (def.key === "document-intake") {
      agents.push({
        ...def, run: undefined, act: undefined,
        enabled: iStatus.enabled, model: iStatus.model, modelLabel: iStatus.readerLabel,
        state: intake.state, why: intake.why, lastRunAt: null, canRunNow: false,
        nowLabel: intake.working.length ? `Reading ${intake.working.length === 1 ? (intake.working[0].fileName || "a document") : intake.working.length + " documents"}` : null,
        review: intake.stats.waiting,
        tiles: [
          { label: "Documents read", value: intake.stats.read, sub: intake.stats.failed ? `${intake.stats.failed} could not be read` : "no failures" },
          { label: "Accepted as read", value: intake.stats.acceptedAsReadPct == null ? "—" : `${intake.stats.acceptedAsReadPct}%`, sub: intake.stats.accepted ? `${intake.stats.acceptedAsRead} of ${intake.stats.accepted} needed no changes` : "nothing accepted yet", tone: "good" },
          { label: "Waiting for review", value: intake.stats.waiting, sub: intake.stats.waiting ? "a person needs to decide" : "all decided", tone: intake.stats.waiting ? "warn" : undefined },
          { label: "Fields corrected", value: intake.stats.fieldsCorrected, sub: `${intake.stats.rejected} rejected` },
        ],
        days: intake.days,
        tasks: intake.tasks.map(t => ({
          id: t.id, source: "intake", kind: "reading", companyId: t.companyId, client: t.client,
          status: t.status === "pending" ? "review" : t.status === "accepted" ? "done" : t.status === "rejected" ? "dismissed" : t.status === "reading" ? "working" : "failed",
          title: `${t.docType || "Unrecognised document"}${t.person ? ` · ${t.person}` : ""}`,
          summary: t.status === "accepted" ? (t.corrected.length ? `Accepted after correcting ${t.corrected.join(", ")}` : "Accepted exactly as read")
            : t.status === "rejected" ? "Reading rejected — nothing added"
            : t.status === "pending" ? (t.issues ? `${t.issues} thing${t.issues === 1 ? "" : "s"} to check before accepting` : "Read cleanly — waiting for a person")
            : t.status === "reading" ? "Reading the document now" : t.status === "interrupted" ? "Stopped before finishing — scan it again" : (t.error || "Could not be read"),
          createdAt: t.createdAt, finishedAt: t.readAt, decidedAt: t.decidedAt, decidedBy: t.decidedBy, by: t.scannedBy,
          output: null, actions: [], openTab: "Documents",
        })),
      });
      continue;
    }
    const s = await agentSetting(def.key);
    const mine = rows.filter(r => r.agent === def.key);
    const working = mine.filter(r => r.status === "working" && now - Date.parse(r.createdAt) < STALE_WORKING_MS);
    const live = running.get(def.key);
    const needsKey = def.modelUse === "required" && !(s.model && isAvailableModel(s.model)) && !anyModelReady();
    const recent = mine.filter(r => r.createdAt >= since);
    const review = mine.filter(r => r.status === "review").length;
    const done7 = recent.filter(r => r.status === "done").length;
    const failed7 = recent.filter(r => r.status === "failed" || (r.status === "working" && now - Date.parse(r.createdAt) >= STALE_WORKING_MS)).length;
    const dismissed7 = recent.filter(r => r.status === "dismissed").length;
    const decided = recent.filter(r => r.decidedBy);
    const watching = mine.filter(r => r.status === "watching");
    const reminders7 = mine.reduce((n, r) => n + (((r.output as any)?.reminders ?? []) as any[]).filter(x => x.at >= since).length, 0);
    const openValue = mine.filter(r => r.status === "review").reduce((n, r) => n + (Number((r.output as any)?.amount) || 0), 0);
    const tiles = def.key === assistant.KEY
      ? [{ label: "Questions answered", value: done7, sub: "last 7 days" }, { label: "Could not answer", value: failed7, sub: "last 7 days", tone: failed7 ? "warn" : undefined }]
      : def.key === chaser.KEY
      ? [
        { label: "Waiting on clients", value: watching.length + review, sub: review ? `${review} need a call` : "being reminded", tone: review ? "warn" : undefined },
        { label: "Reminders sent", value: reminders7, sub: "last 7 days" },
        { label: "Provided", value: recent.filter(r => r.status === "done" && (r.decision as any)?.auto).length, sub: "after reminding, last 7 days", tone: "good" },
        { label: "Stopped", value: dismissed7, sub: "by an officer" },
      ]
      : def.key === unbilled.KEY
      ? [
        { label: "Unbilled work found", value: review, sub: review ? "waiting for a decision" : "nothing found", tone: review ? "warn" : undefined },
        { label: "Value waiting", value: openValue ? openValue.toLocaleString() : "0", sub: "proposed, before VAT review", tone: openValue ? "warn" : undefined },
        { label: "Invoiced", value: recent.filter(r => r.status === "done" && (r.decision as any)?.invoiced).length, sub: "drafts raised, last 7 days", tone: "good" },
        { label: "Covered", value: dismissed7, sub: "dismissed as not billable" },
      ]
      : [
        { label: "Waiting for review", value: review, sub: review ? "a person needs to decide" : "nothing waiting", tone: review ? "warn" : undefined },
        { label: def.daily ? "Resolved" : "Completed", value: done7, sub: decided.length ? `${decided.length} by a person` : "last 7 days", tone: "good" },
        { label: "Dismissed", value: dismissed7, sub: "last 7 days" },
        { label: "Failed", value: failed7, sub: failed7 ? "see the task for why" : "no failures", tone: failed7 ? "bad" : undefined },
      ];

    agents.push({
      key: def.key, name: def.name, icon: def.icon, does: def.does, never: def.never, modelUse: def.modelUse, modelWhy: def.modelWhy, cadence: def.cadence,
      enabled: s.enabled, model: s.model, modelLabel: def.modelUse === "none" ? "No model" : s.model ? modelLabel(s.model) : def.modelUse === "required" ? "Needs a model" : "No model — templates",
      state: live || working.length ? "working" : s.enabled && !needsKey ? "idle" : "off",
      why: needsKey ? "Needs a model, and none is connected on the server." : !s.enabled ? "Switched off. An admin can turn it on." : null,
      nowLabel: working.length ? (def.key === assistant.KEY ? `Answering “${working[0].title.slice(0, 60)}”` : `Working on ${working[0].title}`) : live ? live.what : null,
      lastRunAt: await lastRun(def.key), canRunNow: !!def.run && s.enabled && isAdmin(actor),
      review, tiles, days: days(recent),
      options: def.key === quality.KEY ? { qiwaOccupations: (await quality.qiwaOccupations()).length }
        : def.key === visits.KEY ? await (async () => { const c = await visits.inPersonCenters(); return { inPersonCount: c.names.length, inPersonConfigured: c.configured, centers: c.all }; })()
        : def.key === bank.KEY ? await (async () => {
          const since = new Date(now - 30 * 86_400_000).toISOString();
          const lines = await prisma.bankLine.findMany({ where: { createdAt: { gte: since } }, select: { status: true, amountMinor: true, date: true, fileName: true, createdAt: true }, orderBy: { createdAt: "desc" } });
          const credits = lines.filter(l => l.amountMinor > 0);
          return { imported: lines.length, credits: credits.length, recorded: credits.filter(l => l.status === "recorded").length, matched: credits.filter(l => l.status === "matched").length, proposed: credits.filter(l => l.status === "proposed").length, unmatched: credits.filter(l => l.status === "unmatched").length, lastFile: lines[0]?.fileName ?? null, lastAt: lines[0]?.createdAt ?? null };
        })()
        : def.key === compliance.RECON ? { lastUpload: await lastRun(def.key) }
        : undefined,
      // What needs a person first, then what is being watched, then the most recent.
      tasks: mine.filter(r => r.kind !== "question" || r.createdBy === actor.id || isAdmin(actor))
        .sort((a, b) => ((a.status === "review" ? 0 : a.status === "watching" ? 1 : 2) - (b.status === "review" ? 0 : b.status === "watching" ? 1 : 2)) || b.createdAt.localeCompare(a.createdAt))
        .slice(0, 40).map(r => ({
        id: r.id, source: "agent", kind: r.kind, status: r.status === "working" && now - Date.parse(r.createdAt) >= STALE_WORKING_MS ? "failed" : r.status,
        title: r.title, summary: r.status === "failed" ? (r.error || "Failed") : r.summary, companyId: r.companyId, client: coName(r.companyId),
        createdAt: r.createdAt, finishedAt: r.finishedAt, decidedAt: r.decidedAt, decidedBy: userName(r.decidedBy), by: userName(r.createdBy),
        decision: r.decision, model: r.model, output: r.output, actions: actionsFor(r as any),
        openTab: byKey(r.agent)?.openTab ? byKey(r.agent)!.openTab : r.agent === nitaqat.KEY ? "Workforce" : r.agent === quality.KEY ? (r.kind === "expired-no-renewal" ? "Documents" : "Employees") : r.agent === unbilled.KEY ? "Invoices" : r.agent === chaser.KEY ? (r.refType === "document" ? "Documents" : "Overview") : "Overview",
      })),
    });
  }
  return { agents, connection: { keyPresent: anyModelReady(), models: availableModels() } };
}
