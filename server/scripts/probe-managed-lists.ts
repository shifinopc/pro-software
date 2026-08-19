/**
 * Check that the government document lists a step actually hands somebody come from the country
 * rules, and that a run still asks for the right papers when they do not.
 *
 * The twelve government-facing lists were moved out of the workflow and into checklist rules, so a
 * change Qiwa makes travels in the Saudi pack instead of needing a workflow edit in every tenant.
 * That move is invisible from the outside: a step whose rule resolves to NOTHING looks exactly like
 * a step with no checklist, and every existing probe would still pass, because ticking an empty list
 * satisfies "all required items are ticked" trivially. So the assertion here is not "the run
 * completes" — it is that the list on the task holds the items the rule holds, by key.
 *
 * The second half is the fallback. Each step kept its own inline list, because a pack installed
 * where the rule did not come across must still produce a step that asks for papers rather than one
 * that asks for nothing. That is tested against a throwaway template pointing at a rule id that does
 * not exist, which is what a half-installed pack looks like.
 *
 * The THIRD part is the same question about fields. A step's captures moved into field sets for
 * the same reason, and they fail the same silent way: a set that resolves to nothing leaves a step
 * asking no questions, which a probe walking the workflow would sail straight through, because a
 * form with no required fields is a form you can submit. So the intake step's captures are checked
 * against the SET, by variable name, and a run is then made to prove the fields are really enforced
 * rather than merely displayed.
 *
 * Own run, own user, own template. Deletes everything it makes.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "cl-probe@example.invalid";
const PW = "ClProbe!2026";
const PREFIX = "ZS checklist";
const TITLE = "ZS checklist probe";
const FALLBACK = "ZS checklist fallback probe";
const WHO = "ZS Checklist Probe Person";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const insts = await prisma.workflowInstance.findMany({ where: { title: { startsWith: PREFIX } }, select: { id: true } });
  const ids = insts.map(i => i.id);
  if (ids.length) {
    await prisma.workflowTask.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowLog.deleteMany({ where: { instanceId: { in: ids } } });
    await prisma.workflowInstance.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.workflowTemplate.deleteMany({ where: { name: FALLBACK } });
  await prisma.document.deleteMany({ where: { person: WHO } });
  await prisma.employee.deleteMany({ where: { name: WHO } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

/** The answer that keeps a run moving forward, wherever a step asks for a decision. */
const HAPPY: Record<string, string> = {
  nationality: "Indian", employmentType: "permanent",
  documentsVerified: "pass", transferOutcome: "approved",
  quotaOutcome: "authorised", verificationOutcome: "verified", wafidOutcome: "fit",
  visaOutcome: "issued", arrivalOutcome: "cleared", permitOutcome: "issued", iqamaOutcome: "issued",
  iqamaTransferOutcome: "updated", gosiOutcome: "registered", employeeJoined: "yes",
  probationOutcome: "yes", probationFinal: "confirm",
};

/** Fill a step's captures without knowing which step it is — the shape is on the task itself. */
function answer(captures: any[], hiringType: string): Record<string, any> {
  const vars: Record<string, any> = {};
  for (const c of captures ?? []) {
    const v = String(c.var ?? "");
    if (!v) continue;
    if (v === "hiringType") { vars[v] = hiringType; continue; }
    // A transfer is somebody already working in the Kingdom, and the graph enforces that. Answering
    // "outside" here is not a shortcut the probe may take — it is a profile that cannot exist.
    if (v === "currentLocationStatus") { vars[v] = hiringType === "expat_transfer" ? "inside_ksa" : "outside_ksa"; continue; }
    if (HAPPY[v] !== undefined) { vars[v] = HAPPY[v]; continue; }
    const opts: any[] = c.options ?? [];
    if (opts.length) { vars[v] = String(opts[0]?.value ?? opts[0]); continue; }
    if (c.type === "date" || /date|expiry|end|joining|due/i.test(v)) { vars[v] = "2027-01-15"; continue; }
    if (c.type === "number") { vars[v] = 1; continue; }
    if (v === "applicant") { vars[v] = WHO; continue; }
    if (v === "email") { vars[v] = "cl@example.invalid"; continue; }
    if (v === "mobile") { vars[v] = "+966500000003"; continue; }
    vars[v] = "ZS-" + v;
  }
  return vars;
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "CL Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await (await fetch(API + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PW }) })).json() as any).token;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const tpl = await prisma.workflowTemplate.findFirst({ where: { name: "Employee Onboarding" } });
  const g: any = tpl?.graph ?? {};
  const nodes: any[] = g.nodes ?? [];

  // What each step is SUPPOSED to ask for, taken from the rule rather than from the step.
  const rules = await prisma.checklistRule.findMany({ where: { country: "SA", retired: false } });
  const byRule = new Map(rules.map(r => [r.id, r]));
  const expected = new Map<string, { rule: string; keys: string[]; inline: string[] }>();
  for (const n of nodes) {
    const rid = n?.config?.checklistRuleId;
    if (!rid) continue;
    const rule = byRule.get(rid);
    if (!rule) { fail(`step "${n.id}" points at checklist rule ${rid}, which does not exist`); continue; }
    const rows: any[] = (rule.rows as any[]) ?? [];
    // Only the unconditional rows — a run's hiring type decides the rest, and what is under test
    // here is whether the rule is consulted at all, not the conditions, which have their own probe.
    const keys = rows.filter(r => !(r.conditions ?? []).length).flatMap(r => (r.documents ?? []).map((d: any) => String(d.key)));
    expected.set(n.id, { rule: rule.name, keys, inline: ((n.config?.checklist ?? []) as any[]).map(i => String(i.key)) });
  }
  console.log(`steps whose list comes from a country rule:  ${expected.size}`);

  // The same, for what a step RECORDS.
  const sets = await prisma.fieldSet.findMany({ where: { country: "SA", retired: false } });
  const bySet = new Map(sets.map(r => [r.id, r]));
  const expectedFields = new Map<string, { set: string; vars: string[]; inline: string[] }>();
  for (const n of nodes) {
    const sid = n?.config?.captureRuleId;
    if (!sid) continue;
    const set = bySet.get(sid);
    if (!set) { fail(`step "${n.id}" points at field set ${sid}, which does not exist`); continue; }
    const rws: any[] = (set.rows as any[]) ?? [];
    const vars = rws.filter(r => !(r.conditions ?? []).length).flatMap(r => (r.fields ?? []).map((f: any) => String(f.var)));
    expectedFields.set(n.id, { set: set.name, vars, inline: ((n.config?.captures ?? []) as any[]).map(c => String(c.var)) });
  }
  console.log(`steps whose fields come from a field set:   ${expectedFields.size}`);

  // ── walk one of each kind of hire and look at what every step actually asked for ───────────────
  //
  // Two runs, because no single one reaches all thirteen: a transfer never applies for a visa, and a
  // new hire never asks Qiwa to move a sponsorship. Walking only the new-hire path would leave two
  // rules untested while reporting a clean pass.
  const co = await prisma.company.findFirst({ select: { id: true, name: true } });
  const seen = new Map<string, string[]>();
  const seenFields = new Map<string, string[]>();

  for (const hiringType of ["expat_new_hire", "expat_transfer"]) {
    const started = await call("POST", "/api/workflow/instances", tok, {
      templateId: tpl!.id, title: `${TITLE} ${hiringType}`, companyId: co?.id ?? null, clientName: co?.name ?? null,
    });
    const id = started.body?.id ?? started.body?.instance?.id;
    if (!id) { fail(`could not start a ${hiringType} run`); continue; }
    const live = () => prisma.workflowTask.findMany({ where: { instanceId: id, status: "active" } });

    for (let i = 0; i < 50; i++) {
      const tasks = await live();
      if (!tasks.length) break;
      for (const t of tasks) {
        const items: any[] = Array.isArray(t.checklist) ? (t.checklist as any[]) : [];
        if (expected.has(t.nodeId) && !seen.has(t.nodeId)) seen.set(t.nodeId, items.map(x => String(x.key)));
        if (expectedFields.has(t.nodeId) && !seenFields.has(t.nodeId)) {
          seenFields.set(t.nodeId, ((t.captures as any[]) ?? []).map(c => String(c.var)));
        }
        const checklistState: any = {};
        for (const x of items) checklistState[x.key ?? x.label] = { received: true, verified: true };
        const r = await call("POST", `/api/workflow/tasks/${t.id}/complete`, tok, {
          variables: answer(t.captures as any[], hiringType), ...(t.nodeType === "approval" ? { outcome: "approve" } : {}),
          ...(items.length ? { checklistState } : {}),
        });
        if (r.status >= 400) { fail(`"${t.title}" refused on the ${hiringType} path — ${String(r.body?.error).slice(0, 110)}`); await sweep(); console.log(`\n${bad} problem(s)`); process.exit(1); }
      }
    }
  }

  console.log(`...of which the two runs reached:           ${seen.size}\n`);
  for (const [nodeId, got] of seen) {
    const want = expected.get(nodeId)!;
    const ok = want.keys.length > 0 && want.keys.every(k => got.includes(k));
    console.log(`  ${nodeId.padEnd(15)} ${String(got.length).padStart(2)} item(s)  ${ok ? "from" : "NOT from"} "${want.rule}"`);
    if (!got.length) fail(`"${nodeId}" handed somebody an EMPTY checklist — the rule resolved to nothing and the step asks for no papers at all`);
    else if (!ok) fail(`"${nodeId}" asked for ${got.join(", ")} where the rule holds ${want.keys.join(", ")}`);
  }
  const missed = [...expected.keys()].filter(k => !seen.has(k));
  if (missed.length) { console.log(`
  never reached: ${missed.join(", ")}`); fail(`${missed.length} rule-backed step(s) were never exercised, so their lists are untested`); }
  if (!seen.size) fail("the runs reached none of the rule-backed steps, so nothing here was actually tested");

  // ── the fields, from the set ──────────────────────────────────────────────────────────────────
  console.log("");
  for (const [nodeId, got] of seenFields) {
    const want = expectedFields.get(nodeId)!;
    const ok = want.vars.length > 0 && want.vars.every(v => got.includes(v));
    console.log(`  ${nodeId.padEnd(15)} ${String(got.length).padStart(2)} field(s)  ${ok ? "from" : "NOT from"} "${want.set}"`);
    if (!got.length) fail(`"${nodeId}" handed somebody a form with NO fields — the set resolved to nothing and the step records nothing at all`);
    else if (!ok) fail(`"${nodeId}" asked for ${got.join(", ")} where the set holds ${want.vars.join(", ")}`);
  }
  if (!seenFields.size) fail("no step recording from a field set was reached, so nothing about them was tested");

  // AND THE FIELDS ARE ENFORCED, not merely displayed. A form resolved from a set that the engine
  // then ignores is indistinguishable from one it honours, right up until a run reaches the end
  // with nothing recorded on it — so a step is deliberately completed with a required field missing
  // and with a select answered outside its own list.
  const probeSet = [...expectedFields.keys()][0];
  if (probeSet) {
    const r3 = await call("POST", "/api/workflow/instances", tok, { templateId: tpl!.id, title: `${TITLE} enforcement` });
    const id3 = r3.body?.id ?? r3.body?.instance?.id;
    const t3 = id3 ? await prisma.workflowTask.findFirst({ where: { instanceId: id3, status: "active" } }) : null;
    if (!t3) fail("could not open a run to test that the fields are enforced");
    else {
      const caps: any[] = (t3.captures as any[]) ?? [];
      const req = caps.find(c => c.required !== false);
      const sel = caps.find(c => String(c.type) === "select" && String(c.options ?? "").trim());
      const full = answer(caps, "expat_new_hire");

      const missing = { ...full }; if (req) delete missing[String(req.var)];
      const a = await call("POST", `/api/workflow/tasks/${t3.id}/complete`, tok, { variables: missing });
      console.log("");
      console.log(`a required field from the set is enforced:  ${a.status >= 400 ? "YES" : "NO — the step completed without it"}`);
      if (req && a.status < 400) fail(`"${req.var}" is marked required in the set and the step completed without it`);

      if (sel) {
        const bad = { ...full, [String(sel.var)]: "definitely-not-an-option" };
        const b = await call("POST", `/api/workflow/tasks/${t3.id}/complete`, tok, { variables: bad });
        console.log(`its choices are a closed list:             ${b.status >= 400 ? "YES" : "NO — any value was accepted"}`);
        if (b.status < 400) fail(`"${sel.var}" accepted a value outside ${sel.options} — a decision reading it would fall through to else`);
      }
    }
  }

  // ── the rules that travel with the fields ─────────────────────────────────────────────────────
  //
  // A rule moved into a set and then EDITED there must change what the engine enforces. If the set's
  // rules were merely added to the step's own copy, deleting one on the screen would leave it being
  // enforced from the graph — the screen would look like it worked and the rule would still fire.
  // The check is therefore not "a rule is enforced" but "the set is the one in charge".
  const ruled = await prisma.fieldSet.findFirst({ where: { country: "SA", retired: false, NOT: { rules: { equals: [] } } } });
  console.log("");
  if (!ruled) {
    console.log("no field set carries a rule, so nothing here was tested");
  } else {
    const original = (ruled.rules as any[]) ?? [];
    console.log(`"${ruled.name}" carries ${original.length} rule(s) over its own fields`);
    const owner = nodes.find(n => n?.config?.captureRuleId === ruled.id);
    const r4 = await call("POST", "/api/workflow/instances", tok, { templateId: tpl!.id, title: `${TITLE} rules` });
    const id4 = r4.body?.id ?? r4.body?.instance?.id;
    const t4 = id4 ? await prisma.workflowTask.findFirst({ where: { instanceId: id4, status: "active" } }) : null;
    if (!t4 || !owner) fail("could not open the step whose fields come from a set carrying rules");
    else {
      // Answers that break the set's own rule: a Saudi national sent down an expatriate path.
      const bad = { ...answer(t4.captures as any[], "expat_new_hire"), nationality: "Saudi" };
      const a4 = await call("POST", `/api/workflow/tasks/${t4.id}/complete`, tok, { variables: bad });
      console.log(`  a rule from the set is enforced:          ${a4.status >= 400 ? "YES" : "NO — the step completed anyway"}`);
      if (a4.status < 400) fail("a cross-field rule held on the set was not enforced at all");
      else console.log(`    "${String(a4.body?.error ?? "").slice(0, 88)}"`);

      // NOW TAKE THE RULES AWAY. The step still holds its own copy, so if the set merely added to
      // them the same answers stay refused and the screen is a lie.
      try {
        await prisma.fieldSet.update({ where: { id: ruled.id }, data: { rules: [{ when: { var: "nationality", op: "eq", value: "__never__" }, then: { var: "nationality", op: "present" }, message: "ZS probe placeholder" }] as any } });
        const b4 = await call("POST", `/api/workflow/tasks/${t4.id}/complete`, tok, { variables: bad });
        console.log(`  editing the set changes what is enforced: ${b4.status < 400 ? "YES" : "NO — the step's own copy still fired"}`);
        if (b4.status >= 400) fail(`the set's rules were replaced and the same answers are still refused (${String(b4.body?.error).slice(0, 80)}) — the screen cannot actually govern`);
      } finally {
        await prisma.fieldSet.update({ where: { id: ruled.id }, data: { rules: original as any } });
      }
      const back = (await prisma.fieldSet.findUnique({ where: { id: ruled.id } }))?.rules as any[];
      console.log(`  the set is put back as it was:            ${(back ?? []).length === original.length ? "YES" : "NO"}`);
      if ((back ?? []).length !== original.length) fail("the probe did not restore the set's rules");
    }
  }

  // ── and when the rule did not come across ─────────────────────────────────────────────────────
  const donor = nodes.find(n => expected.has(n.id));
  if (!donor) { console.log("no rule-backed step to borrow for the fallback test"); await sweep(); process.exit(1); }
  const t2 = await prisma.workflowTemplate.create({ data: {
    name: FALLBACK, trigger: "manual", entityType: "employee", active: false, country: "SA",
    createdAt: new Date().toISOString(),
    graph: { nodes: [
      { id: "start", type: "start", label: "Start", config: {} },
      { id: "step", type: "task", label: "Step", config: {
        ...donor.config, checklistSource: "dynamic", checklistRuleId: "no-such-rule-id",
        captures: [], rules: [], statutory: undefined, docType: undefined,
      } },
      { id: "end", type: "end", label: "End", config: {} },
    ], edges: [{ from: "start", to: "step" }, { from: "step", to: "end" }] } as any,
  } });
  const run2 = await call("POST", "/api/workflow/instances", tok, { templateId: t2.id, title: FALLBACK });
  const id2 = run2.body?.id ?? run2.body?.instance?.id;
  const t2task = id2 ? (await prisma.workflowTask.findFirst({ where: { instanceId: id2, status: "active" } })) : null;
  const fb: any[] = Array.isArray(t2task?.checklist) ? (t2task!.checklist as any[]) : [];
  console.log("");
  console.log(`a step whose rule is missing falls back to:  ${fb.length ? `its own ${fb.length} item(s)` : "NOTHING"}`);
  if (!fb.length) fail("a step whose checklist rule did not resolve asks for no documents at all — a half-installed pack silently drops the paperwork");
  else {
    const want = expected.get(donor.id)!.inline;
    if (!want.every(k => fb.map(x => String(x.key)).includes(k))) fail(`the fallback list is not the step's own: got ${fb.map(x => x.key).join(", ")}`);
  }

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  await prisma.$disconnect();
  process.exit(bad === 0 ? 0 : 1);
}
main().catch(async e => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
