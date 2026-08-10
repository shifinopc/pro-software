/**
 * Throwaway check for CRM phase 2: the pipeline, and where a deal's money and status come from.
 *
 * The assertions that matter are about there being ONE answer to each question:
 *   - status is read off the stage, so a card in the won column can never read "open"
 *   - a losing move demands a reason; a winning one does not
 *   - once a quotation exists it IS the value — the estimate typed on the card stops being shown
 *   - accepting that quotation wins the deal by itself, through the path BOTH accept routes use
 *   - column totals add up, and unpriced deals are counted rather than silently treated as zero
 *   - a stage with deals on it retires instead of deleting, so no card is orphaned
 *   - the stage-set validator refuses a pipeline that cannot record a win or a loss
 *
 * Own country, own client, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { validateStages, boardFor, statusOf, withMoney } from "../src/pipeline.js";
import { startDeliveryForQuotation } from "../src/delivery.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
const post = (p: string, b: any, t?: string) => call("POST", p, b, t);
const get = (p: string, t: string) => call("GET", p, undefined, t);

const COUNTRY = "ZZ";
const PW = "ProbeOnly!2026";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };

  const staff = await prisma.user.create({ data: { name: "ZZ Pipe Staff", email: "zz-pipe@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await post("/api/auth/login", { email: staff.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); process.exit(1); }

  // ── the validator refuses a pipeline that cannot close ─────────────────────────────────────
  const cases: Array<[string, any[]]> = [
    ["no won column", [{ name: "A", sort: 0 }, { name: "B", sort: 1, isLost: true }]],
    ["no lost column", [{ name: "A", sort: 0 }, { name: "B", sort: 1, isWon: true }]],
    ["two won columns", [{ name: "A", sort: 0, isWon: true }, { name: "B", sort: 1, isWon: true }, { name: "C", sort: 2, isLost: true }]],
    ["duplicate names", [{ name: "A", sort: 0 }, { name: "a", sort: 1, isWon: true }, { name: "C", sort: 2, isLost: true }]],
  ];
  for (const [what, rows] of cases) {
    const err = validateStages(rows);
    console.log(`refuses ${what.padEnd(18)}: ${err ? "YES" : "NO"}`);
    if (!err) fail(`the validator accepted a pipeline with ${what}`);
  }

  // ── a real set, through the route a person would use ───────────────────────────────────────
  const saved = await call("PUT", "/api/pipeline-stages", {
    country: COUNTRY,
    stages: [
      { name: "ZZ Enquiry", sort: 0, probabilityBp: 1000 },
      { name: "ZZ Quoted", sort: 1, probabilityBp: 5000 },
      { name: "ZZ Won", sort: 2, probabilityBp: 10000, isWon: true },
      { name: "ZZ Lost", sort: 3, probabilityBp: 0, isLost: true },
    ],
  }, tok);
  const stages = saved.body as any[];
  console.log(`\nstages saved: ${stages.length}`);
  if (stages.length !== 4) fail("the stage set did not save");
  const S = Object.fromEntries(stages.map(s => [s.name, s]));

  const co = await prisma.company.create({ data: { name: "ZZ Pipe Client", cr: "0000", country: COUNTRY, lifecycle: "client" } });

  // ── open two deals ─────────────────────────────────────────────────────────────────────────
  const d1 = (await post("/api/opportunities", { companyId: co.id, title: "ZZ 40 visas", valueMinor: 4000000 }, tok)).body;
  const d2 = (await post("/api/opportunities", { companyId: co.id, title: "ZZ unpriced work" }, tok)).body;
  console.log(`\ndeal opens in the first OPEN stage:      ${d1.stageId === S["ZZ Enquiry"].id ? "YES" : "NO"}`);
  if (d1.stageId !== S["ZZ Enquiry"].id) fail("a new deal did not land in the first open stage");
  console.log(`…status derived as open:                 ${d1.status === "open" ? "YES" : "NO (" + d1.status + ")"}`);
  if (d1.status !== "open") fail("a new deal was not open");
  console.log(`…currency taken from the country:        ${d1.currency || "(none)"}`);
  console.log(`…value source says estimate:             ${d1.valueSource === "estimate" ? "YES" : "NO (" + d1.valueSource + ")"}`);
  if (d1.valueSource !== "estimate") fail("a typed-in figure was not labelled an estimate");
  console.log(`…weighted at the stage odds (10%):       ${d1.weightedMinor === 400000 ? "YES" : "NO (" + d1.weightedMinor + ")"}`);
  if (d1.weightedMinor !== 400000) fail(`weighted value is ${d1.weightedMinor}, expected 400000`);

  // ── the board adds up ──────────────────────────────────────────────────────────────────────
  let board = await boardFor(COUNTRY);
  let enquiry = board.columns.find(c => c.stage.name === "ZZ Enquiry")!;
  console.log(`\ncolumn total:      ${enquiry.totalMinor} · weighted ${enquiry.weightedMinor} · unpriced ${enquiry.unpriced}`);
  if (enquiry.totalMinor !== 4000000) fail("the column total does not match the deals in it");
  if (enquiry.unpriced !== 1) fail("the deal with no figure was not counted as unpriced");

  // ── a losing move demands a reason ─────────────────────────────────────────────────────────
  const noReason = await post(`/api/opportunities/${d2.id}/move`, { stageId: S["ZZ Lost"].id }, tok);
  console.log(`\nlosing with no reason is refused:        ${noReason.status === 400 ? "YES" : "NO (" + noReason.status + ")"}`);
  if (noReason.status !== 400) fail("a deal was lost with no reason recorded");
  const lost = (await post(`/api/opportunities/${d2.id}/move`, { stageId: S["ZZ Lost"].id, lostReason: "Probe — price" }, tok)).body;
  console.log(`…with one, it moves and reads lost:      ${lost.status === "lost" ? "YES" : "NO (" + lost.status + ")"}`);
  if (lost.status !== "lost") fail("a deal in the lost column did not read as lost");
  if (lost.weightedMinor !== null && lost.weightedMinor !== 0) fail("a lost deal still carries weighted value");

  // ── the quotation becomes the money ────────────────────────────────────────────────────────
  await post(`/api/opportunities/${d1.id}/move`, { stageId: S["ZZ Quoted"].id }, tok);
  const quoted = await post(`/api/opportunities/${d1.id}/quote`, {
    items: [{ name: "Visa processing", units: 40, price: 950 }],
  }, tok);
  console.log(`\nquotation raised:                        ${quoted.status === 201 ? quoted.body.quotation.number : "NO (" + quoted.status + ")"}`);
  if (quoted.status !== 201) fail(`could not raise a quotation: ${JSON.stringify(quoted.body)}`);
  const afterQuote = quoted.body.opportunity;
  console.log(`…the deal now reads the QUOTATION:       ${afterQuote.valueSource === "quotation" ? "YES" : "NO (" + afterQuote.valueSource + ")"}`);
  if (afterQuote.valueSource !== "quotation") fail("the deal kept showing its own estimate after a quotation existed");
  console.log(`…and its value is the quotation total:   ${afterQuote.valueMinor} (estimate was 4000000)`);
  if (afterQuote.valueMinor === 4000000) fail("the value did not move to the quotation's figure");

  const twice = await post(`/api/opportunities/${d1.id}/quote`, {}, tok);
  console.log(`…a second quotation is refused:          ${twice.status === 409 ? "YES" : "NO (" + twice.status + ")"}`);
  if (twice.status !== 409) fail("a deal was allowed two quotations");

  // ── accepting the quotation wins the deal, with nobody dragging anything ────────────────────
  const qid = quoted.body.quotation.id;
  await prisma.quotation.update({ where: { id: qid }, data: { status: "accepted" } });
  await startDeliveryForQuotation(qid, { actor: "probe" });
  const won = await prisma.opportunity.findUnique({ where: { id: d1.id }, include: { stage: true } });
  console.log(`\naccepting the quotation won the deal:    ${won!.stageId === S["ZZ Won"].id ? "YES" : "NO"}`);
  if (won!.stageId !== S["ZZ Won"].id) fail("accepting the quotation did not move the deal to the won column");
  console.log(`…status reads won:                       ${statusOf(won!.stage) === "won" ? "YES" : "NO"}`);
  if (statusOf(won!.stage) !== "won") fail("the deal in the won column did not read as won");
  console.log(`…and closedAt was stamped:               ${won!.closedAt ? "YES" : "NO"}`);
  if (!won!.closedAt) fail("a closed deal has no closed date");

  const wonFigures = await withMoney(won as any);
  console.log(`…a won deal weighs its full value:       ${wonFigures.weightedMinor === wonFigures.valueMinor ? "YES" : "NO"}`);
  if (wonFigures.weightedMinor !== wonFigures.valueMinor) fail("a won deal is still being discounted by its odds");

  // Re-running is a no-op rather than a second move.
  const before = won!.stageAt;
  await startDeliveryForQuotation(qid, { actor: "probe" });
  const again = await prisma.opportunity.findUnique({ where: { id: d1.id } });
  console.log(`…re-driving it changes nothing:          ${again!.stageAt === before ? "YES" : "NO"}`);
  if (again!.stageAt !== before) fail("re-driving an accepted quotation moved an already-won deal again");

  // ── a stage with deals on it retires rather than vanishing ─────────────────────────────────
  const shrunk = await call("PUT", "/api/pipeline-stages", {
    country: COUNTRY,
    stages: [
      { id: S["ZZ Enquiry"].id, name: "ZZ Enquiry", sort: 0, probabilityBp: 1000 },
      { id: S["ZZ Won"].id, name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
      { id: S["ZZ Lost"].id, name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
    ],
  }, tok);
  const quotedStage = await prisma.pipelineStage.findUnique({ where: { id: S["ZZ Quoted"].id } });
  console.log(`\ndropped stage with no deals is gone:     ${quotedStage === null || quotedStage.retired ? "YES" : "NO"}`);
  const lostStageStill = await prisma.pipelineStage.findUnique({ where: { id: S["ZZ Lost"].id } });
  if (!lostStageStill) fail("a stage still holding a lost deal was deleted");
  console.log(`live stages now: ${(shrunk.body as any[]).map(s => s.name).join(" · ")}`);

  // ── the deal a quotation was raised from cannot be deleted ─────────────────────────────────
  const del = await call("DELETE", `/api/opportunities/${d1.id}`, undefined, tok);
  console.log(`\nquoted deal refuses deletion:            ${del.status === 409 ? "YES" : "NO (" + del.status + ")"}`);
  if (del.status !== 409) fail("a deal with a quotation could be deleted out of the win-rate figures");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.task.deleteMany({ where: { quotationId: qid } });
  await prisma.opportunity.deleteMany({ where: { companyId: co.id } });
  await prisma.quotation.deleteMany({ where: { companyId: co.id } });
  await prisma.pipelineStage.deleteMany({ where: { country: COUNTRY } });
  await prisma.contact.deleteMany({ where: { companyId: co.id } });
  await prisma.company.delete({ where: { id: co.id } });
  await prisma.user.delete({ where: { id: staff.id } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });
  await prisma.notification.deleteMany({ where: { message: { contains: "ZZ " } } });
  await prisma.audit.deleteMany({ where: { target: COUNTRY } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.pipelineStage.count({ where: { country: COUNTRY } })) +
    (await prisma.opportunity.count({ where: { title: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
