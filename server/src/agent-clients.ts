/**
 * CLIENT AGENTS — getting a new client fully set up, a weekly status note to each client, portal access
 * nobody uses, and clients showing signs they may leave.
 *
 * The weekly report is a DRAFT a person reads and sends. The portal agent re-sends invitations only
 * when someone presses the button. Nothing here is emailed on its own.
 */
import { prisma } from "./db.js";
import { daysFromToday, AgentActionError, requirePerm, decide, type AgentActor } from "./agent-core.js";
import { runFindings, standardAct, plural, money, today, addDays, check, LIST_MAX } from "./agent-kit.js";
import { ACTIVE_CLIENT } from "./validate.js";
import { sendInvitation } from "./invitations.js";
import { logAudit } from "./auth.js";
import { orgName } from "./emailshell.js";

const daysSince = (iso?: string | null) => { const d = daysFromToday(iso); return d === null ? null : -d; };
const OPEN_INV = ["pending", "unpaid", "sent", "overdue"];
const clients = () => prisma.company.findMany({ where: { lifecycle: ACTIVE_CLIENT }, select: { id: true, name: true, cr: true, email: true, status: true, createdAt: true, ownerId: true, groupId: true }, take: 5000 });

async function outstandingBy(companyIds: string[]) {
  const invs = await prisma.invoice.findMany({ where: { companyId: { in: companyIds }, status: { in: OPEN_INV } }, select: { id: true, number: true, amount: true, dueDate: true, companyId: true, currency: true, promisedDate: true } });
  const paid = await prisma.payment.groupBy({ by: ["invoiceId"], where: { invoiceId: { in: invs.map(i => i.id) } }, _sum: { amount: true } });
  const paidBy = new Map(paid.map(p => [p.invoiceId, p._sum.amount ?? 0]));
  return invs.map(i => ({ ...i, outstanding: i.amount - (paidBy.get(i.id) ?? 0), late: (daysFromToday(i.dueDate) ?? 1) < 0 })).filter(i => i.outstanding > 0);
}

// ── 10. New client onboarding ─────────────────────────────────────────────────────────────────

export const ONBOARD = "client-onboarding";
const NEW_DAYS = 90;

export async function runClientOnboarding() {
  return runFindings(ONBOARD, ["incomplete"], async raise => {
    const all = await clients();
    const fresh = all.filter(c => c.createdAt ? (daysSince(c.createdAt) ?? 999) <= NEW_DAYS : true);
    if (!fresh.length) return ["No clients taken on in the last 90 days."];
    const ids = fresh.map(c => c.id);
    const [subs, portal, staff, contacts, coDocs] = await Promise.all([
      prisma.subscription.findMany({ where: { OR: [{ companyId: { in: ids } }, { scope: "company", refId: { in: ids } }, { scope: "group" }] }, select: { companyId: true, refId: true, scope: true, daysLeft: true } }),
      prisma.user.findMany({ where: { type: "portal", companyId: { in: ids } }, select: { companyId: true, lastActive: true } }),
      prisma.employee.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, archived: false }, _count: { _all: true } }),
      prisma.contact.findMany({ where: { companyId: { in: ids }, archived: false }, select: { companyId: true, email: true, isPrimary: true } }),
      prisma.document.findMany({ where: { companyId: { in: ids }, employeeId: null, supersededAt: null }, select: { companyId: true, docType: true } }),
    ]);
    for (const c of fresh) {
      const hasSub = subs.some(s => (s.companyId === c.id || s.refId === c.id || (s.scope === "group" && c.groupId && s.refId === c.groupId)) && (s.daysLeft ?? 0) > 0);
      const logins = portal.filter(p => p.companyId === c.id);
      const people = staff.find(s => s.companyId === c.id)?._count._all ?? 0;
      const primary = contacts.find(x => x.companyId === c.id && x.isPrimary);
      const docs = coDocs.filter(d => d.companyId === c.id).map(d => d.docType);
      const hasCr = docs.some(d => /\bcr\b|commercial reg/i.test(d));
      const checks = [
        check(c.cr ? "ok" : "flag", "CR number", c.cr || "Missing."),
        check(primary?.email || c.email ? "ok" : "flag", "Main contact with email", primary?.email || c.email || "No email to send documents and invoices to."),
        check(hasSub ? "ok" : "flag", "Package", hasSub ? "Active." : "No active package — nothing will be billed."),
        check(logins.length ? (logins.some(l => l.lastActive) ? "ok" : "unknown") : "flag", "Portal", !logins.length ? "No portal user." : logins.some(l => l.lastActive) ? "The client has signed in." : "Invited, never signed in."),
        check(people ? "ok" : "flag", "Employees", people ? `${people} on file.` : "None imported — renewals cannot be tracked."),
        check(hasCr ? "ok" : "flag", "Company documents", docs.length ? `${docs.length} on file${hasCr ? "" : " — but no CR document"}.` : "None — upload the CR, GOSI and Chamber certificates."),
      ];
      const open = checks.filter(x => x.state === "flag");
      if (!open.length) continue;
      await raise({
        kind: "incomplete", key: `onboard:${c.id}`, companyId: c.id,
        title: `${c.name} is not fully set up — ${plural(open.length, "gap")}`,
        summary: `${open.map(x => x.label).join(", ")}. This closes itself once they are filled.`,
        output: { checks },
      });
    }
  });
}

// ── 11. Weekly client report ──────────────────────────────────────────────────────────────────

export const WEEKLY = "weekly-client-report";
const isoWeek = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((+t - +y) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
};

export async function runWeeklyClientReport() {
  const week = isoWeek();
  return runFindings(WEEKLY, [], async raise => {
    const all = (await clients()).filter(c => String(c.status).toLowerCase() !== "suspended");
    if (!all.length) return ["No active clients."];
    // Last week's unsent drafts are out of date now.
    await prisma.agentTask.updateMany({ where: { agent: WEEKLY, status: "review", NOT: { dedupeKey: { endsWith: `:${week}` } } }, data: { status: "done", decidedAt: new Date().toISOString(), decision: { auto: "Replaced by this week's report" } as any } });
    const ids = all.map(c => c.id);
    const [runs, waiting, expiring, owed, portal, org] = await Promise.all([
      prisma.workflowInstance.findMany({ where: { companyId: { in: ids }, status: "running" }, select: { companyId: true, title: true } }),
      prisma.agentTask.findMany({ where: { agent: "document-chaser", status: { in: ["watching", "review"] }, companyId: { in: ids } }, select: { companyId: true, title: true } }),
      prisma.document.findMany({ where: { companyId: { in: ids }, supersededAt: null, expiryDate: { gte: today(), lte: addDays(today(), 30) } }, select: { companyId: true, docType: true, person: true, expiryDate: true } }),
      outstandingBy(ids),
      prisma.user.findMany({ where: { type: "portal", companyId: { in: ids }, status: { in: ["active", "invited"] } }, select: { companyId: true } }),
      orgName(),
    ]);
    const reachable = new Set([...portal.map(p => p.companyId), ...all.filter(c => c.email).map(c => c.id)]);
    let made = 0;
    for (const c of all) {
      if (!reachable.has(c.id)) continue;
      const r = runs.filter(x => x.companyId === c.id), w = waiting.filter(x => x.companyId === c.id), e = expiring.filter(x => x.companyId === c.id), o = owed.filter(x => x.companyId === c.id);
      if (!r.length && !w.length && !e.length && !o.length) continue;
      const section = (title: string, lines: string[]) => lines.length ? `${title}\n${lines.slice(0, 15).map(l => `• ${l}`).join("\n")}${lines.length > 15 ? `\n• …and ${lines.length - 15} more` : ""}` : "";
      const body = [
        `Dear ${c.name} team,`,
        `Here is where your files stand this week.`,
        section("In progress", r.map(x => x.title)),
        section("Waiting on you", w.map(x => x.title.replace(/\s+—\s+.*$/, ""))),
        section("Expiring in the next 30 days", e.map(x => `${x.docType} — ${x.person} (${x.expiryDate})`)),
        section("Invoices open", o.map(x => `${x.number}: ${x.currency} ${money(x.outstanding)}${x.late ? " — overdue" : x.dueDate ? ` — due ${x.dueDate}` : ""}`)),
        `You can follow every item in your portal. Reply to this message if anything looks wrong.`,
        `Kind regards,\n${org}`,
      ].filter(Boolean).join("\n\n");
      await raise({
        kind: "report", key: `weekly:${c.id}:${week}`, companyId: c.id,
        title: `Weekly update for ${c.name} (${week})`,
        summary: [r.length && plural(r.length, "item") + " in progress", w.length && `${w.length} waiting on them`, e.length && `${e.length} expiring`, o.length && `${o.length} invoice${o.length === 1 ? "" : "s"} open`].filter(Boolean).join(" · "),
        output: { draft: { subject: `${org} — your weekly update`, body, writtenBy: "template" } },
      });
      made++;
    }
    return [`${made} drafts for week ${week}.`];
  });
}

// ── 12. Portal adoption ───────────────────────────────────────────────────────────────────────

export const PORTAL = "portal-adoption";

export async function runPortalAdoption() {
  return runFindings(PORTAL, ["no-portal", "never-signed-in"], async raise => {
    const all = await clients();
    const users = await prisma.user.findMany({ where: { type: "portal", companyId: { in: all.map(c => c.id) } }, select: { id: true, name: true, email: true, companyId: true, lastActive: true, status: true } });
    const contacts = await prisma.contact.findMany({ where: { companyId: { in: all.map(c => c.id) }, archived: false, NOT: { email: null } }, select: { companyId: true, name: true, email: true, isPrimary: true } });
    for (const c of all) {
      const mine = users.filter(u => u.companyId === c.id && u.status !== "inactive" && u.status !== "disabled");
      if (!mine.length) {
        const who = contacts.find(x => x.companyId === c.id && x.isPrimary) ?? contacts.find(x => x.companyId === c.id);
        await raise({ kind: "no-portal", key: `none:${c.id}`, companyId: c.id,
          title: `${c.name} has no portal access`,
          summary: who ? `Invite ${who.name} (${who.email}) from the client's page, so they can upload documents and follow requests themselves.` : "Add a contact with an email address, then invite them from the client's page.",
          output: {} });
        continue;
      }
      if (mine.some(u => u.lastActive)) continue;
      await raise({ kind: "never-signed-in", key: `idle:${c.id}`, companyId: c.id,
        title: `Nobody at ${c.name} has ever signed in to the portal`,
        summary: `${plural(mine.length, "invitation")} sent, none used. Re-send, and mention it on the next call.`,
        output: { people: mine.map(u => ({ name: u.name, code: u.email })), invitees: mine.map(u => u.id), proposal: { text: "Re-send the invitation emails." } } });
    }
  });
}

const actPortalStd = standardAct(PORTAL, { module: "Clients", what: "close portal findings" });
export async function actPortal(taskId: string, action: string, input: any, actor: AgentActor) {
  if (action !== "resend") return actPortalStd(taskId, action, input, actor);
  const t = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!t || t.agent !== PORTAL || t.status !== "review") throw new AgentActionError("That item is no longer open.", 409);
  await requirePerm(actor, "Clients", "Edit", "invite client users");
  const ids = (((t.output as any)?.invitees ?? []) as string[]);
  const users = await prisma.user.findMany({ where: { id: { in: ids }, type: "portal", lastActive: null } });
  const co = t.companyId ? await prisma.company.findUnique({ where: { id: t.companyId }, select: { name: true } }) : null;
  let emailed = 0;
  for (const u of users) {
    if (u.status && u.status !== "active" && u.status !== "invited") continue;
    const r = await sendInvitation(u, { companyName: co?.name, invitedBy: actor.email ?? actor.name, resend: true });
    if ((r as any).emailed) emailed++;
    await logAudit({ action: "user.invite_resent", actorId: actor.id, target: u.email, detail: `via ${PORTAL} agent · ${(r as any).emailed ? "emailed" : "not emailed"}` });
  }
  await decide(t.id, "done", actor, { resent: users.length, emailed });
  return { ok: true, message: emailed ? `Invitations re-sent to ${plural(emailed, "person", "people")}.` : users.length ? "Invitations were re-issued, but email is not set up on this server — share the links from the Users screen." : "Everyone on this list has signed in since." };
}

// ── 13. Client risk watch ─────────────────────────────────────────────────────────────────────

export const RISK = "client-risk";
const RISK_AT = 4;

export async function runClientRisk() {
  return runFindings(RISK, ["at-risk"], async raise => {
    const all = await clients();
    if (!all.length) return ["No active clients."];
    const ids = all.map(c => c.id);
    const [owed, breached, escalations, rejected, touches, subs] = await Promise.all([
      outstandingBy(ids),
      prisma.workflowTask.findMany({ where: { status: "active", slaState: "breached" }, select: { instance: { select: { companyId: true } } } }),
      prisma.agentTask.findMany({ where: { agent: "document-chaser", status: "review", companyId: { in: ids } }, select: { companyId: true } }),
      prisma.serviceRequest.findMany({ where: { companyId: { in: ids }, status: "rejected", date: { gte: addDays(today(), -90) } }, select: { companyId: true } }),
      prisma.interaction.groupBy({ by: ["companyId"], where: { companyId: { in: ids }, cancelledAt: null }, _max: { at: true } }),
      prisma.subscription.findMany({ where: { OR: [{ companyId: { in: ids } }, { scope: "company", refId: { in: ids } }] }, select: { companyId: true, refId: true, daysLeft: true, autoRenew: true } }),
    ]);
    const last = new Map(touches.map(t => [t.companyId, t._max.at]));
    for (const c of all) {
      const signals: { points: number; text: string }[] = [];
      const late = owed.filter(i => i.companyId === c.id && i.late && !(i.promisedDate && (daysFromToday(i.promisedDate) ?? -1) >= 0));
      if (late.length) signals.push({ points: late.length >= 2 ? 3 : 2, text: `${plural(late.length, "overdue invoice")} (${money(late.reduce((s, i) => s + i.outstanding, 0))})` });
      const br = breached.filter(b => b.instance.companyId === c.id).length;
      if (br) signals.push({ points: br >= 2 ? 3 : 2, text: `${plural(br, "step")} past ${br === 1 ? "its" : "their"} deadline` });
      const esc = escalations.filter(x => x.companyId === c.id).length;
      if (esc) signals.push({ points: 1, text: `${plural(esc, "item")} the client has ignored for 12+ days` });
      const rej = rejected.filter(x => x.companyId === c.id).length;
      if (rej) signals.push({ points: 1, text: `${plural(rej, "request")} rejected in 90 days` });
      const quiet = daysSince(last.get(c.id) ?? null);
      if (quiet === null || quiet > 60) signals.push({ points: 1, text: quiet === null ? "no logged call or meeting, ever" : `no call or meeting for ${quiet} days` });
      const sub = subs.find(s => s.companyId === c.id || s.refId === c.id);
      if (sub && !sub.autoRenew && (sub.daysLeft ?? 0) <= 30) signals.push({ points: 2, text: `package ends in ${sub.daysLeft} days and will not renew by itself` });
      if (String(c.status).toLowerCase() === "suspended") signals.push({ points: 2, text: "account suspended" });
      const score = signals.reduce((s, x) => s + x.points, 0);
      if (score < RISK_AT) continue;
      await raise({
        kind: "at-risk", key: `risk:${c.id}`, companyId: c.id,
        title: `${c.name} may be unhappy — ${plural(signals.length, "warning sign")}`,
        summary: signals.map(s => s.text).join("; ") + ". A call from the account owner now is cheaper than winning them back.",
        output: { lists: [{ title: `Signs (score ${score})`, items: signals.slice(0, LIST_MAX).map(s => ({ text: s.text })) }], proposal: { text: "Call the client, fix the most visible problem first, and log the call." } },
      });
    }
  });
}

export const actOnboard = standardAct(ONBOARD, { module: "Clients", what: "close onboarding checklists" });
export const actWeekly = standardAct(WEEKLY, { module: "Clients", what: "close weekly reports" });
export const actRisk = standardAct(RISK, { module: "Clients", what: "close client risk warnings" });
