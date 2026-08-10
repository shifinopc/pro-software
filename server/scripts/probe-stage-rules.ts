/**
 * Throwaway check for stage-level chase windows.
 *
 * The assertions that matter are about a queue staying worth reading:
 *   - landing in a stage with a rule books ONE follow-up, dated by the rule, worded by the rule
 *   - it is owed by the DEAL'S OWNER, not by whoever tidied the board
 *   - moving on retires the previous stage's chase instead of stacking another beside it
 *   - a deal bounced between stages ends with exactly one open chase, never a pile
 *   - a commitment somebody TYPED is never auto-closed — nothing in a pipeline knows better than
 *     the person who made the promise
 *   - a stage with no rule books nothing, and still clears the last one
 *   - won and lost book nothing and clear everything: a closed deal is nobody's homework
 *
 * Own country, own client, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { applyStageFollowUp } from "../src/pipeline.js";
import { logInteraction, openFollowUps } from "../src/interactions.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const PW = "ProbeOnly!2026";
const COUNTRY = "ZZ";
const call = (method: string, p: string, tok?: string, body?: any) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.pipelineStage.deleteMany({ where: { country: COUNTRY } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const hash = await bcrypt.hash(PW, 10);
  const admin = await prisma.user.create({ data: { name: "ZZ Stage Admin", email: "zz-stage-admin@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: hash } });
  const owner = await prisma.user.create({ data: { name: "ZZ Deal Owner", email: "zz-stage-owner@example.invalid", roleId: "sales", status: "active", type: "staff", passwordHash: hash } });
  const tok = (await call("POST", "/api/auth/login", undefined, { email: admin.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); await prisma.$disconnect(); process.exitCode = 1; return; }

  // ── stages with and without rules, through the real route ──────────────────────────────────
  const saved = await call("PUT", "/api/pipeline-stages", tok, {
    country: COUNTRY,
    stages: [
      { name: "ZZ Enquiry", sort: 0, probabilityBp: 1000, followUpDays: 2, followUpAction: "ZZ Qualify it" },
      { name: "ZZ Quoted", sort: 1, probabilityBp: 6000, followUpDays: 3, followUpAction: "ZZ Chase for a decision" },
      { name: "ZZ Parked", sort: 2, probabilityBp: 2000, followUpDays: "" },
      { name: "ZZ Won", sort: 3, probabilityBp: 10000, isWon: true },
      { name: "ZZ Lost", sort: 4, probabilityBp: 0, isLost: true },
    ],
  }, tok);
  const S = Object.fromEntries((saved.body as any[]).map(s => [s.name, s]));
  console.log(`stages saved with rules: ${(saved.body as any[]).map(s => `${s.name}${s.followUpDays == null ? "" : "(" + s.followUpDays + "d)"}`).join(" · ")}`);
  if (S["ZZ Parked"].followUpDays !== null) fail("a blank chase window was stored as a number — blank must mean no rule, not zero");
  if (S["ZZ Quoted"].followUpDays !== 3) fail("the chase window did not save");

  const co = await prisma.company.create({ data: { name: "ZZ Stage Co", cr: "9995550001", country: COUNTRY, lifecycle: "client", ownerId: owner.id } });
  const deal = (await call("POST", "/api/opportunities", tok, { companyId: co.id, title: "ZZ ruled deal", valueMinor: 500000, ownerId: owner.id })).body;

  const open = async () => (await prisma.interaction.findMany({
    where: { opportunityId: deal.id, nextActionAt: { not: null }, nextActionDoneAt: null },
    orderBy: { createdAt: "asc" },
  }));

  // Creating the deal does not move it, so nothing is booked yet.
  console.log(`\nopening a deal books nothing:            ${(await open()).length === 0 ? "YES" : "NO (" + (await open()).length + ")"}`);
  if ((await open()).length) fail("creating a deal already booked a chase — only a MOVE should");

  // ── a move into a ruled stage ──────────────────────────────────────────────────────────────
  const moved = await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S["ZZ Quoted"].id });
  const one = await open();
  console.log(`moving to Quoted books one chase:        ${one.length === 1 ? "YES" : "NO (" + one.length + ")"}`);
  if (one.length !== 1) fail(`${one.length} follow-ups booked by one move`);
  console.log(`  "${one[0]?.nextAction}" due ${one[0]?.nextActionAt}`);
  if (one[0]?.nextAction !== "ZZ Chase for a decision") fail("the stage's own wording was not used");
  const expected = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  if (one[0]?.nextActionAt !== expected) fail(`due ${one[0]?.nextActionAt}, expected ${expected}`);
  console.log(`  owed by the DEAL's owner:              ${one[0]?.ownerId === owner.id ? "YES" : "NO — " + one[0]?.ownerId}`);
  if (one[0]?.ownerId !== owner.id) fail("the chase was put on whoever moved the card, not the deal's owner");
  console.log(`  the move says what it booked:          ${moved.body.followUp ? moved.body.followUp.action + " · " + moved.body.followUp.due : "NOTHING SAID"}`);
  if (!moved.body.followUp) fail("the move response did not mention the follow-up it created");

  // The queue is "due today or already late", so a chase three days out must NOT be in it — a
  // follow-up that appears the moment it is booked is just noise on the day nothing is owed.
  const todayQueue = (await openFollowUps({})).filter(f => f.opportunityId === deal.id);
  console.log(`  not in today's queue yet:              ${todayQueue.length === 0 ? "YES" : "NO (" + todayQueue.length + ")"}`);
  if (todayQueue.length) fail("a chase due in three days is already on today's list");

  // …and it IS there on the day it falls due.
  const onTheDay = (await openFollowUps({ on: expected })).filter(f => f.opportunityId === deal.id);
  console.log(`  …and appears on ${expected}:        ${onTheDay.length === 1 ? "YES" : "NO (" + onTheDay.length + ")"}`);
  if (onTheDay.length !== 1) fail("the booked chase never reaches the queue on its due date");

  // ── moving on replaces, never stacks ───────────────────────────────────────────────────────
  await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S["ZZ Enquiry"].id });
  const afterBack = await open();
  console.log(`\nmoving back replaces, not stacks:        ${afterBack.length === 1 ? "YES" : "NO (" + afterBack.length + ")"}`);
  if (afterBack.length !== 1) fail(`${afterBack.length} open chases after moving twice — they are accumulating`);
  if (afterBack[0]?.nextAction !== "ZZ Qualify it") fail("the new stage's chase is not the one left standing");

  // Bounce it a few times: still exactly one.
  for (const s of ["ZZ Quoted", "ZZ Enquiry", "ZZ Quoted"]) {
    await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S[s].id });
  }
  console.log(`bounced four more times, still one:      ${(await open()).length === 1 ? "YES" : "NO (" + (await open()).length + ")"}`);
  if ((await open()).length !== 1) fail("a deal moved back and forth accumulated chases");

  // ── a stage with no rule ───────────────────────────────────────────────────────────────────
  await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S["ZZ Parked"].id });
  console.log(`a stage with no rule books nothing:      ${(await open()).length === 0 ? "YES" : "NO (" + (await open()).length + ")"}`);
  if ((await open()).length) fail("a stage with no chase window still booked one");

  // ── a promise somebody typed survives everything ───────────────────────────────────────────
  const byHand = await logInteraction({
    companyId: co.id, opportunityId: deal.id, kind: "call", summary: "ZZ spoke to Fahad",
    nextAction: "ZZ Call him back on Sunday as promised", nextActionAt: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    ownerId: owner.id,
  });
  await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S["ZZ Quoted"].id });
  const afterMove = await open();
  const handStill = afterMove.some(f => f.id === byHand.id);
  console.log(`\na hand-typed promise survives a move:    ${handStill ? "YES" : "NO — IT WAS CLOSED"}`);
  if (!handStill) fail("a commitment somebody made by hand was auto-closed by a stage move");
  console.log(`  …alongside the stage's own:            ${afterMove.length === 2 ? "YES" : "NO (" + afterMove.length + ")"}`);
  if (afterMove.length !== 2) fail(`expected the hand-typed one plus the rule's, got ${afterMove.length}`);

  // ── closing the deal clears the rule's, keeps the person's ─────────────────────────────────
  await call("POST", `/api/opportunities/${deal.id}/move`, tok, { stageId: S["ZZ Won"].id });
  const afterWon = await open();
  console.log(`\nwinning clears the rule's chase:         ${afterWon.every(f => !f.auto) ? "YES" : "NO"}`);
  if (afterWon.some(f => f.auto)) fail("a won deal still has an automatic chase against it");
  console.log(`…and still keeps the person's promise:   ${afterWon.some(f => f.id === byHand.id) ? "YES" : "NO"}`);
  if (!afterWon.some(f => f.id === byHand.id)) fail("winning the deal cancelled a promise made to a client");

  // ── the module refuses to book on a terminal stage even called directly ────────────────────
  const direct = await applyStageFollowUp(
    (await prisma.opportunity.findUnique({ where: { id: deal.id } }))!,
    (await prisma.pipelineStage.findUnique({ where: { id: S["ZZ Lost"].id } }))!,
  );
  console.log(`a terminal stage books nothing at all:   ${direct === null ? "YES" : "NO"}`);
  if (direct !== null) fail("a lost stage booked a chase");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await sweep();
  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.pipelineStage.count({ where: { country: COUNTRY } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
