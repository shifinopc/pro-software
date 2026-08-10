/**
 * Throwaway check: what a `sales` user can actually see and touch.
 *
 * Every CRM route carries a row-level scope for this role and none of it had ever been exercised as
 * one — only as an admin, who is exempt from all of it. A scope nobody has run is a guess.
 *
 * The assertions are deliberately about the NEGATIVE case, because that is the one that costs
 * something when it is wrong:
 *   - a salesperson sees the clients they own, and NOT a colleague's
 *   - the same for leads, contacts, deals, follow-ups and the contact log
 *   - reaching for somebody else's record BY ID is refused, not silently answered
 *   - writing to somebody else's record is refused
 *   - an unowned client is invisible to every salesperson — nobody inherits it by accident
 *   - handing a client over moves it: the new owner gains it and the old one loses it
 *   - an admin still sees everything, so the scope did not leak upward
 *
 * Two salespeople, one admin, three clients, all its own. Deletes every row afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const PW = "ProbeOnly!2026";

const call = (method: string, p: string, tok?: string, body?: any) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
const get = (p: string, tok: string) => call("GET", p, tok);

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZZ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    for (const m of ["document", "opportunity", "interaction", "contact", "user", "subscription"] as const)
      await (prisma as any)[m].deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.pipelineStage.deleteMany({ where: { country: "ZZ" } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const hash = await bcrypt.hash(PW, 10);
  const mk = (name: string, email: string, roleId: string) =>
    prisma.user.create({ data: { name, email, roleId, status: "active", type: "staff", passwordHash: hash } });

  const amina = await mk("ZZ Amina", "zz-amina@example.invalid", "sales");
  const bilal = await mk("ZZ Bilal", "zz-bilal@example.invalid", "sales");
  const admin = await mk("ZZ Admin", "zz-scope-admin@example.invalid", "super_admin");

  const tokenFor = async (email: string) => (await call("POST", "/api/auth/login", undefined, { email, password: PW })).body.token as string;
  const [tA, tB, tAdmin] = await Promise.all([tokenFor(amina.email), tokenFor(bilal.email), tokenFor(admin.email)]);
  if (!tA || !tB || !tAdmin) { console.log("could not sign in — is the API running, and is the rate limiter clear?"); await prisma.$disconnect(); process.exitCode = 1; return; }

  // Amina's client, Bilal's client, and one nobody owns.
  const hers = await prisma.company.create({ data: { name: "ZZ Amina Client", cr: "1", country: "ZZ", lifecycle: "client", ownerId: amina.id } });
  const his = await prisma.company.create({ data: { name: "ZZ Bilal Client", cr: "2", country: "ZZ", lifecycle: "client", ownerId: bilal.id } });
  const nobodys = await prisma.company.create({ data: { name: "ZZ Unowned Client", cr: "3", country: "ZZ", lifecycle: "client" } });
  const herLead = await prisma.company.create({ data: { name: "ZZ Amina Lead", country: "ZZ", lifecycle: "lead", ownerId: amina.id } });

  for (const co of [hers, his, nobodys]) {
    await prisma.contact.create({ data: { companyId: co.id, name: `ZZ Contact of ${co.name}`, isPrimary: true } });
  }
  for (const s of [{ name: "ZZ Open", sort: 0 }, { name: "ZZ Won", sort: 1, isWon: true }, { name: "ZZ Lost", sort: 2, isLost: true }])
    await prisma.pipelineStage.create({ data: { ...s, country: "ZZ" } });
  const stage = (await prisma.pipelineStage.findFirst({ where: { country: "ZZ", isWon: false, isLost: false } }))!;
  const herDeal = await prisma.opportunity.create({ data: { companyId: hers.id, title: "ZZ her deal", stageId: stage.id, country: "ZZ", valueMinor: 100000 } });
  const hisDeal = await prisma.opportunity.create({ data: { companyId: his.id, title: "ZZ his deal", stageId: stage.id, country: "ZZ", valueMinor: 900000 } });
  await prisma.interaction.create({ data: { companyId: hers.id, kind: "call", at: new Date().toISOString(), summary: "ZZ her call", nextAction: "ZZ her follow-up", nextActionAt: new Date().toISOString().slice(0, 10), ownerId: amina.id } });
  await prisma.interaction.create({ data: { companyId: his.id, kind: "call", at: new Date().toISOString(), summary: "ZZ his call", nextAction: "ZZ his follow-up", nextActionAt: new Date().toISOString().slice(0, 10), ownerId: bilal.id } });

  const names = (rows: any[], k = "name") => rows.map(r => r[k]).filter((n: string) => String(n).startsWith("ZZ ")).sort();

  // ── lists ──────────────────────────────────────────────────────────────────────────────────
  const clients = names((await get("/api/companies", tA)).body);
  console.log(`clients Amina sees:        ${clients.join(", ") || "(none)"}`);
  if (clients.join() !== "ZZ Amina Client") fail(`a salesperson sees ${clients.join(", ")} — should be only her own`);

  const leads = names((await get("/api/companies?lifecycle=lead", tA)).body);
  console.log(`leads Amina sees:          ${leads.join(", ") || "(none)"}`);
  if (leads.join() !== "ZZ Amina Lead") fail("lead scoping does not follow ownership");

  const contacts = names((await get("/api/contacts", tA)).body);
  console.log(`contacts Amina sees:       ${contacts.join(", ") || "(none)"}`);
  if (contacts.some(c => c.includes("Bilal") || c.includes("Unowned"))) fail("a salesperson can read another client's contacts");

  const board = (await get("/api/pipeline?country=ZZ", tA)).body;
  const deals = (board.columns ?? []).flatMap((c: any) => c.deals.map((d: any) => d.title)).filter((t: string) => t.startsWith("ZZ "));
  console.log(`deals on Amina's board:    ${deals.join(", ") || "(none)"}`);
  if (deals.join() !== "ZZ her deal") fail(`the pipeline shows ${deals.join(", ")} — a salesperson sees another's deals`);

  const fus = ((await get("/api/follow-ups", tA)).body as any[]).map(f => f.nextAction).filter((n: string) => String(n).startsWith("ZZ "));
  console.log(`follow-ups Amina owes:     ${fus.join(", ") || "(none)"}`);
  if (fus.join() !== "ZZ her follow-up") fail("the follow-up queue is not scoped to the owner's clients");

  const log = ((await get("/api/interactions", tA)).body as any[]).map(i => i.summary).filter((s: string) => String(s).startsWith("ZZ "));
  console.log(`contact log Amina sees:    ${log.join(", ") || "(none)"}`);
  if (log.some(s => s.includes("his"))) fail("a salesperson can read another client's contact history");

  // ── an unowned client belongs to nobody ────────────────────────────────────────────────────
  const bilalSees = names((await get("/api/companies", tB)).body);
  console.log(`\nclients Bilal sees:        ${bilalSees.join(", ") || "(none)"}`);
  if (bilalSees.join() !== "ZZ Bilal Client") fail("scoping is not symmetric between two salespeople");
  if (clients.includes("ZZ Unowned Client") || bilalSees.includes("ZZ Unowned Client"))
    fail("an unowned client was handed to a salesperson who never claimed it");

  // ── by id, not just by list ────────────────────────────────────────────────────────────────
  const byId = await get(`/api/companies/${his.id}`, tA);
  console.log(`\nreaching for his client by id: ${byId.status}`);
  if (byId.status === 200 && byId.body?.id === his.id) fail("a scoped LIST with an unscoped /:id is no restriction at all");

  const write = await call("PUT", `/api/companies/${his.id}`, tA, { city: "ZZ Hijacked" });
  const after = await prisma.company.findUnique({ where: { id: his.id } });
  console.log(`writing to his client:         ${write.status} · city is now "${after?.city ?? "unset"}"`);
  if (after?.city === "ZZ Hijacked") fail("a salesperson WROTE to another salesperson's client");

  const hisDealMove = await call("POST", `/api/opportunities/${hisDeal.id}/move`, tA, { stageId: stage.id });
  console.log(`moving his deal:               ${hisDealMove.status}`);
  if (hisDealMove.status === 200) fail("a salesperson moved another salesperson's deal");

  // ── the admin is not scoped ────────────────────────────────────────────────────────────────
  const adminSees = names((await get("/api/companies", tAdmin)).body);
  console.log(`\nclients the admin sees:    ${adminSees.length} (expect 3)`);
  if (adminSees.length !== 3) fail(`the admin sees ${adminSees.length} of 3 — the sales scope leaked upward`);

  // ── handing a client over ──────────────────────────────────────────────────────────────────
  await call("PUT", `/api/companies/${hers.id}`, tAdmin, { ownerId: bilal.id });
  const aminaNow = names((await get("/api/companies", tA)).body);
  const bilalNow = names((await get("/api/companies", tB)).body);
  console.log(`\nafter handing it to Bilal — Amina: ${aminaNow.join(", ") || "(none)"} · Bilal: ${bilalNow.join(", ")}`);
  if (aminaNow.includes("ZZ Amina Client")) fail("the old owner still sees a client that was handed over");
  if (!bilalNow.includes("ZZ Amina Client")) fail("the new owner did not gain the client");

  // …and the deal on it moves with the client, because the deal is scoped through the company.
  const bilalBoard = (await get("/api/pipeline?country=ZZ", tB)).body;
  const bilalDeals = (bilalBoard.columns ?? []).flatMap((c: any) => c.deals.map((d: any) => d.title)).filter((t: string) => t.startsWith("ZZ ")).sort();
  console.log(`…and its deal moved too:   ${bilalDeals.join(", ")}`);
  if (!bilalDeals.includes("ZZ her deal")) fail("the deal did not follow the client to its new owner");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  const ids = [hers.id, his.id, nobodys.id, herLead.id];
  await prisma.interaction.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.opportunity.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
  await prisma.company.deleteMany({ where: { id: { in: ids } } });
  await prisma.pipelineStage.deleteMany({ where: { country: "ZZ" } });
  await prisma.user.deleteMany({ where: { id: { in: [amina.id, bilal.id, admin.id] } } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });
  await prisma.notification.deleteMany({ where: { OR: [{ title: { contains: "ZZ " } }, { message: { contains: "ZZ " } }] } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.opportunity.count({ where: { title: { startsWith: "ZZ " } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
