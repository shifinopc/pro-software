/**
 * Throwaway check for what a checklist rule may be written against.
 *
 * Two problems. The console carried its OWN copy of the vocabulary to draw the rule editor's
 * "fields available" note, so the editor and the evaluator each believed a different thing about
 * what words mean anything — which is how an editor comes to bless a condition that can never
 * match. And the list itself was fixed in code, so a firm that tracked something of its own about a
 * client could not write a rule on it at any price.
 *
 * What must be true now:
 *   - one definition, served, and it names every fact the evaluator actually assembles
 *   - the added facts (package, group, clientStatus, hasCr) resolve for a real deal
 *   - a rule conditioning on the ADMIN'S OWN field on the client record really matches
 *   - a custom field named after a built-in fact does NOT shadow it, and is reported as ignored
 *   - the coverage counts are real, so a field nobody fills reads as 0 rather than as available
 *
 * Own client, own rule, own stage. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { factsFor, itemsForStage, DEAL_FACTS } from "../src/dealchecklist.js";
import bcrypt from "bcryptjs";

const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";
const EMAIL = "zv-vocab@example.invalid";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZV " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.checklistRule.deleteMany({ where: { name: { startsWith: "ZV " } } });
  await prisma.pipelineStage.deleteMany({ where: { country: "ZV" } });
  await prisma.clientGroup.deleteMany({ where: { name: { startsWith: "ZV " } } });
  await prisma.package.deleteMany({ where: { name: { startsWith: "ZV " } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "ZV Vocab Staff", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", { email: EMAIL, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in - is the API running?"); process.exit(1); }

  // A client carrying every kind of fact: real columns, a group, a package, and two fields of the
  // admin's own — one useful, one deliberately named after a built-in fact.
  const grp = await prisma.clientGroup.create({ data: { name: "ZV Holdings" } });
  const pkg = await prisma.package.create({ data: { name: "ZV Premium", tier: "premium", basePrice: 1000, empMin: 0, empMax: 9999, features: [] } });
  const co = await prisma.company.create({ data: {
    name: "ZV Vocab Client", cr: "1234", country: "ZV", city: "Riyadh", industry: "Construction",
    employees: 80, lifecycle: "client", status: "active", groupId: grp.id,
    customData: { visaCategory: "skilled", country: "THIS MUST BE IGNORED" },
  } });
  await prisma.subscription.create({ data: { companyId: co.id, refId: co.id, scope: "company", packageId: pkg.id, price: 1000 } });

  const stage = await prisma.pipelineStage.create({ data: { name: "ZV Quoted", sort: 0, country: "ZV" } });
  const deal = await prisma.opportunity.create({ data: { companyId: co.id, title: "ZV deal", valueMinor: 7500000, source: "Referral", stageId: stage.id } });

  // ── the facts a real deal resolves to ──────────────────────────────────────────────────────
  const full = await prisma.opportunity.findUnique({ where: { id: deal.id }, include: { stage: true } });
  const facts = await factsFor(full, co);
  console.log("resolved facts:");
  for (const k of ["package", "group", "clientStatus", "hasCr", "employees", "value", "visaCategory"]) {
    console.log(`  ${k.padEnd(14)} ${JSON.stringify(facts[k])}`);
  }
  if (facts.package !== "ZV Premium") fail("`package` did not resolve - a rule could not ask which package a client is on");
  if (facts.group !== "ZV Holdings") fail("`group` did not resolve");
  if (facts.hasCr !== "yes") fail("`hasCr` did not resolve");
  if (facts.value !== 75000) fail("`value` is not in major units");
  if (facts.visaCategory !== "skilled") fail("the admin's own field is not a fact - the whole point of a configurable rule engine");
  console.log(`\nthe custom field does NOT shadow:        ${facts.country === "ZV" ? "YES" : "NO (" + facts.country + ")"}`);
  if (facts.country !== "ZV") fail("a custom field named `country` replaced the real one - every rule in the system would quietly change meaning");

  // ── a rule written on the admin's own field really fires ───────────────────────────────────
  const rule = await prisma.checklistRule.create({ data: {
    name: "ZV Skilled visa documents", country: "ZV",
    rows: [
      { conditions: [{ var: "visaCategory", op: "eq", value: "skilled" }], items: [{ key: "zv_degree", label: "ZV Attested degree certificate", required: true, source: "manual" }] },
      { conditions: [{ var: "visaCategory", op: "eq", value: "unskilled" }], items: [{ key: "zv_none", label: "ZV Should not appear", required: true, source: "manual" }] },
      { conditions: [{ var: "package", op: "eq", value: "ZV Premium" }], items: [{ key: "zv_fast", label: "ZV Priority handling form", required: false, source: "manual" }] },
    ] as any,
  } });
  await prisma.pipelineStage.update({ where: { id: stage.id }, data: { checklistSource: "dynamic", checklistRuleId: rule.id } });

  const stage2 = await prisma.pipelineStage.findUnique({ where: { id: stage.id } });
  const items = await itemsForStage(stage2, full, co);
  const labels = items.map(i => i.label);
  console.log(`\nrule on a custom field resolved to:      ${labels.join(" | ") || "(nothing)"}`);
  if (!labels.includes("ZV Attested degree certificate")) fail("a rule conditioning on the admin's own field matched nothing");
  if (labels.includes("ZV Should not appear")) fail("a row whose condition was false still contributed items");
  if (!labels.includes("ZV Priority handling form")) fail("a rule conditioning on `package` matched nothing");

  // ── the served vocabulary agrees with the evaluator ────────────────────────────────────────
  const v = (await call("GET", "/api/checklist-vocabulary", undefined, tok)).body;
  const served = new Set(v.deal.map((f: any) => f.name));
  const missing = DEAL_FACTS.map(f => f.name).filter(n => !served.has(n));
  console.log(`\nevery declared fact is served:           ${missing.length === 0 ? "YES" : "NO (" + missing.join(",") + ")"}`);
  if (missing.length) fail("the served vocabulary is missing facts the evaluator assembles");
  console.log(`the custom field is offered:             ${served.has("visaCategory") ? "YES" : "NO"}`);
  if (!served.has("visaCategory")) fail("the admin's own field is not offered to whoever writes a rule");
  console.log(`the shadowing one is reported ignored:   ${v.clashes.includes("country") ? "YES" : "NO"}`);
  if (!v.clashes.includes("country")) fail("a custom field that clashes is silently dropped - it would look like the list is broken");

  const cover = Object.fromEntries(v.deal.map((f: any) => [f.name, f.filled]));
  console.log(`coverage is counted, not asserted:       package=${cover.package} group=${cover.group} of ${v.total} clients`);
  if (!(cover.package >= 1)) fail("coverage counts are not real");
  console.log(`a deal-only fact claims no coverage:     ${cover.source === null ? "YES" : "NO (" + cover.source + ")"}`);
  if (cover.source !== null) fail("a fact that lives on the deal reported a client-coverage figure it cannot know");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
