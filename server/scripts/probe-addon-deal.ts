/**
 * Throwaway check: a client asking to buy something reaches the pipeline.
 *
 * Before this, an add-on request was approved, invoiced and added to the plan without ever being on
 * the board — so money the client themselves asked for appeared in the accounts having never been in
 * a forecast, and the win rate counted none of it.
 *
 * What is asserted:
 *   - a request opens exactly ONE deal, unpriced, owned by the client's owner, sourced as a request
 *   - a second request for the same thing cannot produce a second card
 *   - approving it WINS the deal at the price somebody actually agreed
 *   - refusing it LOSES the deal, with a reason, so it counts in the loss report
 *   - the deal then appears in the win rate for the period, which is the whole point
 *   - with no pipeline configured the client's request still goes through — a sales gap must never
 *     stop a client spending money
 *
 * Own client, own service, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { dealForAddonRequest, closeAddonDeal, statusOf } from "../src/pipeline.js";
import { salesReport } from "../src/salesreport.js";

const COUNTRY = "ZZ";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.upgradeRequest.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.invoice.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.subscription.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: "ZZ " } } });
  await prisma.pipelineStage.deleteMany({ where: { country: { in: [COUNTRY, "QQ"] } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const owner = await prisma.user.create({ data: { name: "ZZ Addon Owner", email: "zz-addon-owner@example.invalid", roleId: "sales", status: "active", type: "staff" } });
  for (const s of [
    { name: "ZZ Enquiry", sort: 0, probabilityBp: 1000, followUpDays: 2, followUpAction: "ZZ Price it up" },
    { name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
    { name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
  ]) await prisma.pipelineStage.create({ data: { ...s, country: COUNTRY } });

  const co = await prisma.company.create({ data: { name: "ZZ Addon Client", cr: "9997770001", country: COUNTRY, lifecycle: "client", ownerId: owner.id } });
  const mkReq = (service: string) => prisma.upgradeRequest.create({
    data: { companyId: co.id, clientName: co.name, kind: "addon", serviceId: "svc-" + service, serviceName: service, status: "pending", date: new Date().toISOString().slice(0, 10) },
  });

  // ── a request lands on the board ───────────────────────────────────────────────────────────
  const req1 = await mkReq("ZZ Exit Re-entry Visa");
  const deal = await dealForAddonRequest(req1, { homeCountry: "SA" });
  console.log(`a request opens a deal:                  ${deal ? "YES — " + deal.title : "NO"}`);
  if (!deal) fail("a client asking to buy something did not reach the board");
  console.log(`  unpriced until somebody agrees a fee:  ${deal?.valueMinor == null ? "YES" : "NO (" + deal?.valueMinor + ")"}`);
  if (deal?.valueMinor != null) fail("a price was invented before anybody quoted one");
  console.log(`  owned by the client's owner:           ${deal?.ownerId === owner.id ? "YES" : "NO"}`);
  if (deal?.ownerId !== owner.id) fail("the deal has no owner, so no sales user can see it");
  console.log(`  sourced as a client request:           ${deal?.source === "client request" ? "YES" : "NO (" + deal?.source + ")"}`);
  if (deal?.source !== "client request") fail("the source attribution is wrong, so the report cannot tell where this came from");

  const chase = await prisma.interaction.count({ where: { opportunityId: deal!.id, auto: true, nextActionDoneAt: null } });
  console.log(`  the stage's chase window applied:      ${chase === 1 ? "YES" : "NO (" + chase + ")"}`);
  if (chase !== 1) fail("a client request lands on the board and nobody is reminded to price it");

  // ── it cannot be doubled ───────────────────────────────────────────────────────────────────
  const again = await dealForAddonRequest(req1, { homeCountry: "SA" });
  const count1 = await prisma.opportunity.count({ where: { companyId: co.id } });
  console.log(`\nre-submitting cannot double it:          ${again === null && count1 === 1 ? "YES" : "NO (" + count1 + " deals)"}`);
  if (count1 !== 1) fail("one request produced two cards");

  // ── approving wins it at the agreed price ──────────────────────────────────────────────────
  const won = await closeAddonDeal(req1.id, { won: true, priceMinor: 250000 });
  console.log(`\napproving wins the deal:                 ${won && statusOf(won.stage) === "won" ? "YES" : "NO"}`);
  if (!won || statusOf(won.stage) !== "won") fail("approving an add-on left the deal open");
  console.log(`  …at the price actually agreed:         ${won?.valueMinor === 250000 ? "YES (SAR 2,500)" : "NO (" + won?.valueMinor + ")"}`);
  if (won?.valueMinor !== 250000) fail("the approved price did not become the deal's value");
  console.log(`  …and closedAt was stamped:             ${won?.closedAt ? "YES" : "NO"}`);
  if (!won?.closedAt) fail("a closed deal has no closed date");

  const twiceWon = await closeAddonDeal(req1.id, { won: true, priceMinor: 999999 });
  console.log(`  approving twice changes nothing:       ${twiceWon === null ? "YES" : "NO"}`);
  if (twiceWon !== null) fail("a second approval re-wrote the deal's value");

  // ── refusing loses it, with a reason ───────────────────────────────────────────────────────
  const req2 = await mkReq("ZZ Family Visa");
  await dealForAddonRequest(req2, { homeCountry: "SA" });
  const lost = await closeAddonDeal(req2.id, { won: false, reason: "ZZ Not offered to this client" });
  console.log(`\nrefusing loses the deal:                 ${lost && statusOf(lost.stage) === "lost" ? "YES" : "NO"}`);
  if (!lost || statusOf(lost.stage) !== "lost") fail("a refused request left the deal open forever");
  console.log(`  …with the reason recorded:             ${lost?.lostReason === "ZZ Not offered to this client" ? "YES" : "NO (" + lost?.lostReason + ")"}`);
  if (lost?.lostReason !== "ZZ Not offered to this client") fail("a refusal recorded no reason, so the loss report learns nothing");

  // ── it reaches the win rate ────────────────────────────────────────────────────────────────
  const period = new Date().toISOString().slice(0, 7);
  const rep = await salesReport({ period, companyIds: [co.id] });
  console.log(`\nin this period's figures: won ${rep.won.count} (${rep.won.valueMinor}) · lost ${rep.lost.count}`);
  if (rep.won.count !== 1 || rep.won.valueMinor !== 250000) fail("client-initiated business is still missing from the win rate");
  if (rep.lost.count !== 1) fail("the refused request is missing from the loss figures");
  console.log(`  attributed to the right source:        ${rep.sources.some(s => s.key === "client request") ? "YES" : "NO"}`);
  if (!rep.sources.some(s => s.key === "client request")) fail("source attribution did not reach the report");

  // ── no pipeline configured must not block the client ───────────────────────────────────────
  const bare = await prisma.company.create({ data: { name: "ZZ No Pipeline Co", cr: "9997770002", country: "QQ", lifecycle: "client" } });
  const bareReq = await prisma.upgradeRequest.create({
    data: { companyId: bare.id, clientName: bare.name, kind: "addon", serviceId: "svc-zz", serviceName: "ZZ Something", status: "pending", date: new Date().toISOString().slice(0, 10) },
  });
  const noBoard = await dealForAddonRequest(bareReq, { homeCountry: "QQ" });
  const stillThere = await prisma.upgradeRequest.findUnique({ where: { id: bareReq.id } });
  console.log(`\nno stages: no deal, request survives:    ${noBoard === null && stillThere ? "YES" : "NO"}`);
  if (noBoard !== null) fail("a deal was invented for a country with no pipeline");
  if (!stillThere) fail("the client's request was lost because the pipeline was unconfigured");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await sweep();
  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.opportunity.count({ where: { title: { contains: "ZZ " } } })) +
    (await prisma.pipelineStage.count({ where: { country: COUNTRY } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
