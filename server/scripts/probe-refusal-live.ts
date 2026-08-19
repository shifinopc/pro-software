/**
 * Throwaway check that a government refusal can actually be RECORDED, by recording one.
 *
 * The failure branches added last round were verified by walking the graph, which proves the routing
 * and nothing about whether a person can get to it. They could not: every capture counts as required
 * unless it says otherwise, so a visa application asked for a number and an expiry before it would
 * accept "rejected" — and a rejected visa has neither. The same shape sat on the refused work permit,
 * the refused Iqama and the unfit medical. All of it routed perfectly and none of it was reachable,
 * which is the sort of thing only running it finds.
 *
 * So this drives a real run through the engine and refuses at a government step, twice: once at the
 * medical, where the refusal is the whole outcome, and once at the visa, where the step also asks for
 * a number that only exists on success. Then it checks the other direction — that a SUCCESSFUL visa
 * still cannot be recorded without its number, because the point was never to stop asking.
 *
 * Own run, own user, own company records. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "rl-probe@example.invalid";
const PW = "RlProbe!2026";
const TITLE = "ZS refusal probe";
const WHO = "ZS Refusal Probe Person";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: { startsWith: TITLE } }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.document.deleteMany({ where: { person: WHO } });
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "RL Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });

  /** Whatever step is live right now. */
  const current = (instId: string) =>
    prisma.workflowTask.findFirst({ where: { instanceId: instId, status: "active" }, orderBy: { createdAt: "desc" } });

  /** Complete the live step, ticking whatever documents it insists on seeing. */
  const done = async (instId: string, variables: Record<string, any>, outcome?: string) => {
    const t = await current(instId);
    if (!t) return { status: 0, body: { error: "no active step" }, title: "(none)", nodeId: "" };
    const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
    const checklistState: any = {};
    for (const i of items) checklistState[i.key ?? i.label] = { received: true, verified: true };
    const r = await call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
      variables, ...(outcome ? { outcome } : {}), ...(items.length ? { checklistState } : {}),
    });
    return { ...r, title: t.title, nodeId: t.nodeId };
  };

  const startRun = async (title: string) => {
    const s = await call("POST", "/api/workflow/instances", tok, {
      templateId: tpl!.id, title, companyId: co?.id ?? null, clientName: co?.name ?? null,
    });
    return s.body?.id ?? s.body?.instance?.id;
  };

  /** Walk an expatriate new hire as far as the step named, recording success at each one. */
  const walkTo = async (instId: string, stop: string) => {
    const steps: Record<string, any> = {
      profile: { applicant: WHO, nationality: "Indian", mobile: "+966500000000", email: "rl@example.invalid",
        hiringType: "expat_new_hire", employmentType: "permanent", profession: "Accountant", department: "Finance",
        reportingManager: "Ops Lead", expectedJoining: "2026-11-01", currentLocationStatus: "outside_ksa" },
      elig: {},
      collect: { documentsVerified: "pass" },
      hiring_appr: {},
      visa_auth: { quotaOutcome: "authorised", visaAuthNumber: "VA-9001" },
      prof_verify: { verificationOutcome: "verified", verificationRef: "SVP-771" },
      medical_wafid: { wafidOutcome: "fit", wafidCentre: "Wafid Kochi", wafidDate: "2026-09-10" },
      visa_apply: { visaOutcome: "issued", visaNumber: "V-7001", visaExpiry: "2027-06-30" },
      arrival: { arrivalOutcome: "cleared", entryDate: "2026-10-05" },
      insurance_task: { policyNumber: "POL-7001", policyExpiry: "2027-10-05" },
      contract: { contractNumber: "QC-7001", contractEnd: "2027-10-05" },
      permit_task: { permitOutcome: "issued", permitNumber: "WP-7001", permitExpiry: "2027-10-05" },
    };
    for (let i = 0; i < 14; i++) {
      const t = await current(instId);
      if (!t || t.nodeId === stop) return t;
      const r = await done(instId, steps[t.nodeId] ?? {}, t.nodeType === "approval" ? "approve" : undefined);
      if (r.status >= 400) { fail(`could not get as far as ${stop}: "${r.title}" refused — ${String(r.body?.error).slice(0, 96)}`); return null; }
    }
    return null;
  };

  // ── a medical that came back unfit ────────────────────────────────────────────────────────────
  const runA = await startRun(TITLE + " A");
  const atMedical = await walkTo(runA, "medical_wafid");
  console.log(`reached the Wafid medical:                 ${atMedical ? "YES" : "NO"}`);
  if (!atMedical) { await sweep(); console.log("\n1 problem(s)"); process.exit(1); }

  const unfit = await done(runA, { wafidOutcome: "unfit", wafidCentre: "Wafid Kochi", wafidDate: "2026-09-10" });
  console.log(`recording "unfit" is accepted:             ${unfit.status === 200 ? "YES" : "NO (" + unfit.status + ")"}`);
  if (unfit.status !== 200) fail(`an unfit medical cannot be recorded — ${String(unfit.body?.error).slice(0, 110)}`);
  const afterUnfit = await current(runA);
  console.log(`  ...and the run stops at:                 ${afterUnfit ? `"${afterUnfit.title}"` : "nothing is open"}`);
  if (afterUnfit?.nodeId !== "gov_stop") fail(`an unfit medical did not reach the refusal desk — the run is at "${afterUnfit?.nodeId ?? "nowhere"}"`);

  // ── a visa that was rejected, on a step that also asks for a number ───────────────────────────
  const runB = await startRun(TITLE + " B");
  const atVisa = await walkTo(runB, "visa_apply");
  console.log(`\nreached the visa application:              ${atVisa ? "YES" : "NO"}`);
  if (!atVisa) { await sweep(); console.log("\n1 problem(s)"); process.exit(1); }

  const rejected = await done(runB, { visaOutcome: "rejected" });
  console.log(`recording a rejection, with no number:     ${rejected.status === 200 ? "YES" : "NO (" + rejected.status + ")"}`);
  if (rejected.status !== 200) fail(`a rejected visa cannot be recorded — "${String(rejected.body?.error).slice(0, 120)}". The refusal branches route correctly and nobody can reach them.`);
  const afterReject = await current(runB);
  console.log(`  ...and the run stops at:                 ${afterReject ? `"${afterReject.title}"` : "nothing is open"}`);
  if (afterReject?.nodeId !== "gov_stop") fail(`a rejected visa did not reach the refusal desk — the run is at "${afterReject?.nodeId ?? "nowhere"}"`);

  const docs = await prisma.document.count({ where: { person: WHO, docType: "Work Visa" } });
  console.log(`  no Work Visa record was created:         ${docs === 0 ? "YES" : "NO (" + docs + ")"}`);
  if (docs) fail("a rejected application still issued a Work Visa document");

  // ── the other direction: success still has to bring its number ────────────────────────────────
  //
  // The point was never to stop asking. A visa recorded as ISSUED with no number is the blank-run
  // problem in a new place — the document would be created with nothing to reconcile it against.
  const runC = await startRun(TITLE + " C");
  const atVisaC = await walkTo(runC, "visa_apply");
  if (atVisaC) {
    const blank = await done(runC, { visaOutcome: "issued" });
    console.log(`\nan ISSUED visa with no number is refused:  ${blank.status >= 400 ? "YES" : "NO (" + blank.status + ")"}`);
    console.log(`  "${String(blank.body?.error ?? "").slice(0, 108)}"`);
    if (blank.status < 400) fail("a visa was recorded as issued with no number or expiry — the Work Visa record would have nothing to reconcile against");

    const good = await done(runC, { visaOutcome: "issued", visaNumber: "V-5501", visaExpiry: "2027-06-30" });
    console.log(`...and with them it goes through:          ${good.status === 200 ? "YES" : "NO (" + good.status + ")"}`);
    if (good.status !== 200) fail(`a properly filled visa was refused — ${String(good.body?.error).slice(0, 110)}`);
    const issued = await prisma.document.findFirst({ where: { person: WHO, docType: "Work Visa" }, select: { docNumber: true, expiryDate: true } });
    console.log(`  the Work Visa record carries its number: ${issued ? `${issued.docNumber} exp ${issued.expiryDate}` : "NO RECORD"}`);
    if (issued?.docNumber !== "V-5501") fail("the issued visa produced no document, or one without its number");

    // ── and the same shape one step later, where it decides a statutory clock ───────────────────
    //
    // Arrival asks for the date of entry, and "has not arrived" is exactly the case that has none.
    // The date is also what the 90 days to issue an Iqama are counted from, so it cannot simply be
    // optional either — it has to be required of everybody who is actually in the country.
    const noShow = await done(runC, { arrivalOutcome: "not_arrived" });
    console.log(`
"has not arrived" needs no entry date:      ${noShow.status === 200 ? "YES" : "NO (" + noShow.status + ")"}`);
    if (noShow.status !== 200) fail(`an employee who never arrived cannot be recorded — "${String(noShow.body?.error).slice(0, 96)}"`);

    const cleared = await done(runC, { arrivalOutcome: "cleared" });
    console.log(`...but clearing arrival does:              ${cleared.status >= 400 ? "YES" : "NO (" + cleared.status + ")"}`);
    console.log(`  "${String(cleared.body?.error ?? "").slice(0, 104)}"`);
    if (cleared.status < 400) fail("arrival was cleared with no date of entry — the 90-day Iqama deadline has nothing to count from and would never be computed");

    const withDate = await done(runC, { arrivalOutcome: "cleared", entryDate: "2026-10-05" });
    console.log(`...and with the date it goes through:      ${withDate.status === 200 ? "YES" : "NO (" + withDate.status + ")"}`);
    if (withDate.status !== 200) fail(`a properly recorded arrival was refused — ${String(withDate.body?.error).slice(0, 100)}`);
  }

  // ── the deepest refusal, and what it leaves behind ────────────────────────────────────────────
  //
  // An Iqama refusal is the worst case: by then the run has issued a visa, a policy, a contract and a
  // work permit. All of them belong to somebody who will never be onboarded, and none of them is
  // inert — they sit in compliance monitoring, count toward the client's totals, and are chased for
  // renewal year after year.
  const runD = await startRun(TITLE + " D");
  const atIqama = await walkTo(runD, "iqama_task");
  console.log(`
reached the Iqama, four documents in:      ${atIqama ? "YES" : "NO"}`);
  if (atIqama) {
    const before = await prisma.document.findMany({ where: { issuedByRunId: runD, supersededAt: null }, select: { docType: true } });
    console.log(`  live documents this run has issued:      ${before.map(d => d.docType).join(", ") || "none"}`);
    if (before.length < 3) fail(`only ${before.length} documents were issued before the Iqama, so this is not testing the case that matters`);

    // an unrelated record for the same person, to prove the sweep stays inside its own run
    const inst = await prisma.workflowInstance.findUnique({ where: { id: runD }, select: { companyId: true } });
    const bystander = await prisma.document.create({ data: {
      companyId: inst!.companyId!, person: WHO, docType: "Passport", docNumber: "P-BYSTANDER",
      status: "valid", daysLeft: 900, expiryDate: "2029-01-01",
    } });

    const refused = await done(runD, { iqamaOutcome: "refused" });
    console.log(`  recording the refusal is accepted:       ${refused.status === 200 ? "YES" : "NO (" + refused.status + ")"}`);
    if (refused.status !== 200) fail(`a refused Iqama cannot be recorded — ${String(refused.body?.error).slice(0, 100)}`);

    const stop = await current(runD);
    if (stop?.nodeId === "gov_stop") {
      const closed = await done(runD, { stopReason: "Iqama refused — profession not permitted for this nationality" });
      if (closed.status !== 200) fail(`the refusal desk could not be closed — ${String(closed.body?.error).slice(0, 100)}`);
    } else fail(`a refused Iqama did not reach the refusal desk — the run is at "${stop?.nodeId ?? "nowhere"}"`);

    const after = await prisma.document.findMany({ where: { issuedByRunId: runD }, select: { docType: true, supersededAt: true, history: true } });
    const stillLive = after.filter(d => !d.supersededAt);
    console.log(`
  once the run stops, still live:          ${stillLive.length ? stillLive.map(d => d.docType).join(", ") : "none — all withdrawn"}`);
    if (stillLive.length) fail(`${stillLive.length} document(s) from an abandoned hire are still live: ${stillLive.map(d => d.docType).join(", ")} — compliance and the renewal engine would chase them for an employee who was never onboarded`);
    const withReason = after.filter(d => (Array.isArray(d.history) ? d.history as any[] : []).some((h: any) => h.kind === "voided"));
    console.log(`  ...each saying why on its own record:    ${withReason.length === after.length ? "YES" : `NO (${withReason.length}/${after.length})`}`);
    if (withReason.length !== after.length) fail("a document was withdrawn with nothing on it to say why");

    const by = await prisma.document.findUnique({ where: { id: bystander.id }, select: { supersededAt: true } });
    console.log(`  a record this run did not issue is left:  ${by?.supersededAt === null ? "YES" : "NO"}`);
    if (by?.supersededAt) fail("withdrawing reached past the run's own documents and voided an unrelated record");

    const fin = await prisma.workflowInstance.findUnique({ where: { id: runD }, select: { status: true } });
    console.log(`  and the run is finished:                 ${fin?.status === "completed" ? "YES" : "NO (" + fin?.status + ")"}`);
  } else fail("could not drive a run as far as the Iqama");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
