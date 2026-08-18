/**
 * Throwaway check that a country really can move between installations.
 *
 * The question this answers is the one somebody asks before trusting the Export button: if I export
 * a country here and import it on a new system, does EVERYTHING related to that country come with
 * it — or only the parts somebody remembered to add to the exporter?
 *
 * It has not always been everything. The workforce bands and the pipeline stages were each declared
 * and installable for a while before the exporter produced them, and the four courier/appointment
 * lists were in that state until today. Every one of those shipped a pack that installed a market
 * missing something, discovered on the far side.
 *
 * So this builds a country from nothing, exports it, DELETES it, installs the pack back, and
 * compares row for row. A section the exporter forgets fails here rather than at a customer.
 *
 * Own country. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { buildPack, applyInstall, KINDS, forgetCountryRow } from "../src/packs.js";

const C = "ZX";

/** Every country-scoped table a pack claims to carry, as {model: [names]}. */
async function snapshot(country: string) {
  const out: Record<string, string[]> = {};
  for (const kind of KINDS) {
    const rows = await (prisma as any)[kind.model].findMany({
      where: { country, retired: false }, select: { name: true },
    });
    out[kind.model] = rows.map((r: any) => r.name).sort();
  }
  return out;
}

async function wipe() {
  for (const kind of KINDS) await (prisma as any)[kind.model].deleteMany({ where: { country: C } });
  // applyInstall also puts the country on the Country Rules screen. Deleting the rows is not enough:
  // without this the fixture market stays listed, with Configure and Export leading to nothing. A
  // "ZU" appeared on the production screen exactly this way.
  await forgetCountryRow(C);
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await wipe();

  // ── build a country that has something in every kind a pack carries ────────────────────────
  const wf = await prisma.workflowTemplate.create({ data: { name: "ZX Visa Run", country: C, trigger: "manual", entityType: "employee", active: true, graph: { nodes: [], edges: [] } } });
  await prisma.documentType.create({ data: { name: "ZX Residence Permit", country: C, subjectKind: "employee", authority: "ZX Immigration" } });
  await prisma.govCenter.create({ data: { name: "ZX Immigration", country: C, sub: "Main office" } });
  await prisma.serviceItem.create({ data: { name: "ZX New Permit", country: C, docType: "ZX Residence Permit", workflowId: wf.id } });
  await prisma.package.create({ data: { name: "ZX Starter", country: C, tier: "basic", basePrice: 500, empMin: 0, empMax: 50, features: [] } });
  await prisma.checklistRule.create({ data: { name: "ZX Permit Documents", country: C, rows: [] as any } });
  await prisma.workforceBand.create({ data: { name: "ZX Green", country: C, minBp: 5000, maxBp: 10000, sort: 0 } });
  for (const [i, n] of ["ZX Enquiry", "ZX Won", "ZX Lost"].entries()) {
    await prisma.pipelineStage.create({ data: { name: n, country: C, sort: i, isWon: n.endsWith("Won"), isLost: n.endsWith("Lost") } });
  }
  await prisma.leadSource.create({ data: { name: "ZX Referral", country: C, sort: 0 } });
  await prisma.lostReason.create({ data: { name: "ZX Price", country: C, sort: 0 } });
  // The four that were declared and installable but never exported until today.
  await prisma.courierJobType.create({ data: { name: "ZX Passport pickup", country: C, sort: 0 } });
  await prisma.appointmentType.create({ data: { name: "ZX Medical", country: C, sort: 0, icon: "\u{1FA7A}" } });
  await prisma.courierStatus.create({ data: { name: "ZX Requested", country: C, sort: 0 } });
  await prisma.courierStatus.create({ data: { name: "ZX Delivered", country: C, sort: 1, terminal: true } });
  await prisma.appointmentStatus.create({ data: { name: "ZX Booked", country: C, sort: 0 } });
  await prisma.appointmentStatus.create({ data: { name: "ZX Cancelled", country: C, sort: 1, terminal: true, offLadder: true } });
  // The CRM vocabulary, which never travelled at all before today.
  await prisma.competitor.create({ data: { name: "ZX Rival Co", country: C, sort: 0 } });
  await prisma.industry.create({ data: { name: "ZX Construction", country: C, sort: 0 } });
  await prisma.campaign.create({ data: { name: "ZX Spring Push", country: C, sort: 0 } });
  await prisma.cancelReason.create({ data: { name: "ZX Client withdrew", country: C, sort: 0 } });

  const before = await snapshot(C);
  const total = Object.values(before).reduce((n, r) => n + r.length, 0);
  console.log(`built ${C}: ${total} rows across ${Object.values(before).filter(r => r.length).length} kinds`);

  // ── export ─────────────────────────────────────────────────────────────────────────────────
  const built = await buildPack(C, { version: "1.0" });
  const shipped = Object.fromEntries(
    KINDS.map(k => [k.model, Array.isArray((built.pack as any)[k.key]) ? (built.pack as any)[k.key].length : null]),
  );
  console.log("\nsections the pack carries:");
  let silent = 0;
  for (const kind of KINDS) {
    const had = before[kind.model].length;
    const got = shipped[kind.model];
    const mark = got === null ? "NOT WRITTEN AT ALL" : (got === had ? "ok" : `MISMATCH (had ${had})`);
    if (got !== had) { silent++; console.log(`  ${String(got ?? "-").padStart(3)}  ${kind.key.padEnd(20)} ${mark}`); }
  }
  if (silent) fail(`${silent} kind(s) did not travel intact - a pack like this installs a market missing something`);
  else console.log(`  all ${KINDS.length} kinds carried exactly what the country had`);

  // ── the pack must not carry anybody's clients ──────────────────────────────────────────────
  const forbidden = ["companies", "employees", "documents", "invoices", "users", "credentials", "contacts"];
  const leaked = forbidden.filter(k => k in (built.pack as any));
  console.log(`\ncarries no client data:                  ${leaked.length === 0 ? "YES" : "NO (" + leaked.join(",") + ")"}`);
  if (leaked.length) fail("the pack carries client data");

  // ── wipe, as if this were a new installation ───────────────────────────────────────────────
  await wipe();
  const emptied = await snapshot(C);
  console.log(`after wiping ${C}:                        ${Object.values(emptied).reduce((n, r) => n + r.length, 0)} rows`);

  // ── install it back ────────────────────────────────────────────────────────────────────────
  const res = await applyInstall(built.pack);
  console.log(`\ninstall created:                         ${res.created} rows`);
  if (res.unresolved.length) console.log(`  unresolved: ${res.unresolved.join("; ")}`);

  const after = await snapshot(C);
  console.log("\nwhat came back:");
  for (const kind of KINDS) {
    const a = before[kind.model], b = after[kind.model];
    const same = a.length === b.length && a.every((n, i) => n === b[i]);
    if (!same) {
      console.log(`  ${kind.key.padEnd(20)} before ${a.length} -> after ${b.length}`);
      const missing = a.filter(n => !b.includes(n));
      if (missing.length) console.log(`      missing: ${missing.join(", ")}`);
      fail(`${kind.key} did not survive the round trip`);
    }
  }
  const backTotal = Object.values(after).reduce((n, r) => n + r.length, 0);
  console.log(`  ${backTotal} of ${total} rows returned`);
  if (backTotal !== total) fail("the round trip lost rows");

  // ── the shape of a status ladder must survive, not just its wording ────────────────────────
  const cancelled = await prisma.appointmentStatus.findFirst({ where: { country: C, name: "ZX Cancelled" } });
  console.log(`\nladder flags survived:                   ${cancelled?.terminal && cancelled?.offLadder ? "YES" : "NO"}`);
  if (!cancelled?.terminal || !cancelled?.offLadder) fail("a status arrived without terminal/offLadder - the far end draws Cancelled as a step everything passes through");
  const appt = await prisma.appointmentType.findFirst({ where: { country: C, name: "ZX Medical" } });
  console.log(`appointment type kept its icon:          ${appt?.icon ? "YES" : "NO"}`);

  // ── a reference that is a database id here must arrive resolved there ──────────────────────
  const svc = await prisma.serviceItem.findFirst({ where: { country: C, name: "ZX New Permit" } });
  const wf2 = await prisma.workflowTemplate.findFirst({ where: { country: C, name: "ZX Visa Run" } });
  console.log(`service still points at its workflow:    ${svc?.workflowId && svc.workflowId === wf2?.id ? "YES" : "NO"}`);
  if (!svc?.workflowId || svc.workflowId !== wf2?.id) fail("the service lost its workflow - it travelled as a cuid that means nothing on the far side");

  await wipe();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await wipe(); process.exit(1); });
