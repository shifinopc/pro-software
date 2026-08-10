/**
 * Throwaway check for CRM phase 5: lead sources and loss reasons as country configuration.
 *
 * The assertions that matter are all about the lists SUGGESTING rather than constraining, because a
 * picklist that can refuse is a picklist that will one day stop somebody recording a real loss:
 *   - a value that is not on the list still saves, through the real route
 *   - a country with NO list configured can still record a loss — the "say why" rule stays satisfiable
 *   - removing an entry that records already use RETIRES it, so their wording keeps its meaning
 *   - removing an entry nothing uses deletes it outright, so the list does not fill with debris
 *   - a duplicate entry is refused, because two spellings of one answer is the problem being fixed
 *   - both lists travel in a country pack and install on the far side
 *   - the loss report groups by the configured wording
 *
 * Own country, own client, own lists. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { salesReport } from "../src/salesreport.js";
import { KINDS } from "../src/packs.js";
import bcrypt from "bcryptjs";

const COUNTRY = "ZZ";
const BARE = "QQ"; // a country with nothing configured at all
const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const stale = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = stale.map(c => c.id);
  if (ids.length) {
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  for (const c of [COUNTRY, BARE]) {
    await prisma.pipelineStage.deleteMany({ where: { country: c } });
    await prisma.leadSource.deleteMany({ where: { country: c } });
    await prisma.lostReason.deleteMany({ where: { country: c } });
  }
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const staff = await prisma.user.create({ data: { name: "ZZ List Staff", email: "zz-lists@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", { email: staff.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); process.exit(1); }

  // ── the packs machinery knows about both ───────────────────────────────────────────────────
  const kindKeys = KINDS.map(k => k.key);
  console.log(`pack sections include both lists:        ${kindKeys.includes("leadSources") && kindKeys.includes("lostReasons") ? "YES" : "NO"}`);
  if (!kindKeys.includes("leadSources") || !kindKeys.includes("lostReasons")) fail("the country pack does not carry the two lists");

  // ── saving a list ──────────────────────────────────────────────────────────────────────────
  const saved = await call("PUT", "/api/lost-reasons", {
    country: COUNTRY,
    rows: [{ name: "ZZ Price" }, { name: "ZZ Went elsewhere" }, { name: "ZZ Postponed" }],
  }, tok);
  console.log(`\nloss reasons saved: ${(saved.body as any[]).length}`);
  if ((saved.body as any[]).length !== 3) fail("the loss-reason list did not save");

  const dupe = await call("PUT", "/api/lost-reasons", { country: COUNTRY, rows: [{ name: "ZZ Price" }, { name: "zz price" }] }, tok);
  console.log(`a duplicate spelling is refused:         ${dupe.status === 400 ? "YES" : "NO (" + dupe.status + ")"}`);
  if (dupe.status !== 400) fail("two spellings of one answer were accepted — that is the problem this exists to fix");

  await call("PUT", "/api/lead-sources", { country: COUNTRY, rows: [{ name: "ZZ Referral" }, { name: "ZZ Website" }] }, tok);

  // ── a deal lost for a reason that is NOT on the list ───────────────────────────────────────
  for (const s of [
    { name: "ZZ Open", sort: 0, probabilityBp: 2000 },
    { name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
    { name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
  ]) await prisma.pipelineStage.create({ data: { ...s, country: COUNTRY } });
  const stages = await prisma.pipelineStage.findMany({ where: { country: COUNTRY } });
  const S = Object.fromEntries(stages.map(s => [s.name, s]));
  const co = await prisma.company.create({ data: { name: "ZZ List Client", cr: "0000", country: COUNTRY, lifecycle: "client" } });

  const d1 = (await call("POST", "/api/opportunities", { companyId: co.id, title: "ZZ off-list loss", valueMinor: 100000 }, tok)).body;
  const offList = await call("POST", `/api/opportunities/${d1.id}/move`, { stageId: S["ZZ Lost"].id, lostReason: "ZZ Something nobody listed" }, tok);
  console.log(`\na reason not on the list still saves:    ${offList.status === 200 ? "YES" : "NO (" + offList.status + ")"}`);
  if (offList.status !== 200) fail("a loss reason outside the list was refused — real losses would go unrecorded");

  const d2 = (await call("POST", "/api/opportunities", { companyId: co.id, title: "ZZ listed loss", valueMinor: 300000 }, tok)).body;
  await call("POST", `/api/opportunities/${d2.id}/move`, { stageId: S["ZZ Lost"].id, lostReason: "ZZ Price" }, tok);

  // ── a country with NO lists at all can still record a loss ─────────────────────────────────
  for (const s of [
    { name: "QQ Open", sort: 0 }, { name: "QQ Won", sort: 1, isWon: true }, { name: "QQ Lost", sort: 2, isLost: true },
  ]) await prisma.pipelineStage.create({ data: { ...s, country: BARE } });
  const qStages = await prisma.pipelineStage.findMany({ where: { country: BARE } });
  const qco = await prisma.company.create({ data: { name: "ZZ Bare Country Co", cr: "0001", country: BARE, lifecycle: "client" } });
  const d3 = (await call("POST", "/api/opportunities", { companyId: qco.id, title: "ZZ bare loss" }, tok)).body;
  const bareLoss = await call("POST", `/api/opportunities/${d3.id}/move`, { stageId: qStages.find(s => s.isLost)!.id, lostReason: "Anything at all" }, tok);
  console.log(`a country with no list can still record: ${bareLoss.status === 200 ? "YES" : "NO (" + bareLoss.status + ")"}`);
  if (bareLoss.status !== 200) fail("a country with no configured list could not record a loss");

  const bareList = await call("GET", `/api/lost-reasons?country=${BARE}`, undefined, tok);
  console.log(`…and its list is simply empty:           ${Array.isArray(bareList.body) && bareList.body.length === 0 ? "YES" : "NO"}`);

  // ── removing entries: retire what is used, delete what is not ──────────────────────────────
  const after = await call("PUT", "/api/lost-reasons", { country: COUNTRY, rows: [{ name: "ZZ Went elsewhere" }] }, tok);
  const priceRow = await prisma.lostReason.findFirst({ where: { country: COUNTRY, name: "ZZ Price" } });
  const postponedRow = await prisma.lostReason.findFirst({ where: { country: COUNTRY, name: "ZZ Postponed" } });
  console.log(`\nan entry deals use is retired:           ${priceRow?.retired ? "YES" : "NO"}`);
  if (!priceRow?.retired) fail("a loss reason still carried by a deal was deleted rather than retired");
  console.log(`an entry nothing uses is deleted:        ${postponedRow === null ? "YES" : "NO"}`);
  if (postponedRow !== null) fail("an unused entry was retired instead of removed — the list fills with debris");
  console.log(`…and the live list no longer offers it:  ${(after.body as any[]).every(r => r.name !== "ZZ Price") ? "YES" : "NO"}`);

  // ── the old wording keeps its meaning in the report ────────────────────────────────────────
  const period = new Date().toISOString().slice(0, 7);
  const rep = await salesReport({ period, companyIds: [co.id] });
  const reasons = rep.lossReasons.map(r => r.key);
  console.log(`\nthe report still groups by wording: ${reasons.join(" · ")}`);
  if (!reasons.includes("ZZ Price")) fail("a retired reason's deals lost their wording in the report");
  if (!reasons.includes("ZZ Something nobody listed")) fail("the off-list reason is missing from the report");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.opportunity.deleteMany({ where: { companyId: { in: [co.id, qco.id] } } });
  await prisma.pipelineStage.deleteMany({ where: { country: { in: [COUNTRY, BARE] } } });
  await prisma.leadSource.deleteMany({ where: { country: { in: [COUNTRY, BARE] } } });
  await prisma.lostReason.deleteMany({ where: { country: { in: [COUNTRY, BARE] } } });
  await prisma.contact.deleteMany({ where: { companyId: { in: [co.id, qco.id] } } });
  await prisma.company.deleteMany({ where: { id: { in: [co.id, qco.id] } } });
  await prisma.user.delete({ where: { id: staff.id } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: "ZZ " } }, { message: { contains: "ZZ " } }] } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.lostReason.count({ where: { country: { in: [COUNTRY, BARE] } } })) +
    (await prisma.leadSource.count({ where: { country: { in: [COUNTRY, BARE] } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
