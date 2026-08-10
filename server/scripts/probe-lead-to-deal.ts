/**
 * Throwaway check for turning a lead into a deal.
 *
 * The judgement — is there business here — stays a person's. What is tested is that the machinery
 * around it cannot produce something nobody chose:
 *   - the press opens exactly ONE deal, pre-filled, unpriced, owned by the company's owner
 *   - a second press is refused while the first is still open — two cards for one conversation is
 *     how a pipeline double-counts the same money
 *   - a deal opened this way gets the stage's chase window, like one dragged in would
 *   - promoting to prospect opens one only when ASKED; without the flag it opens nothing
 *   - promoting a lead that already has a live deal never opens a second, flag or not
 *   - a company marked lost is refused
 *   - a country with no stages is refused with a reason, not a crash
 *
 * And the nudge:
 *   - a lead with no deal and no contact is raised once a day, not once ever
 *   - opening a deal, or logging a call, silences it
 *
 * Own country, own client, own stages. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { checkIdleLeads, IDLE_LEAD_DAYS } from "../src/jobs.js";
import { logInteraction } from "../src/interactions.js";
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
  await prisma.pipelineStage.deleteMany({ where: { country: { in: [COUNTRY, "QQ"] } } });
  await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: "idle-lead:" } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const hash = await bcrypt.hash(PW, 10);
  const admin = await prisma.user.create({ data: { name: "ZZ L2D Admin", email: "zz-l2d-admin@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: hash } });
  const owner = await prisma.user.create({ data: { name: "ZZ L2D Owner", email: "zz-l2d-owner@example.invalid", roleId: "sales", status: "active", type: "staff", passwordHash: hash } });
  const tok = (await call("POST", "/api/auth/login", undefined, { email: admin.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); await prisma.$disconnect(); process.exitCode = 1; return; }

  await call("PUT", "/api/pipeline-stages", tok, {
    country: COUNTRY,
    stages: [
      { name: "ZZ Enquiry", sort: 0, probabilityBp: 1000, followUpDays: 2, followUpAction: "ZZ Qualify it" },
      { name: "ZZ Won", sort: 1, probabilityBp: 10000, isWon: true },
      { name: "ZZ Lost", sort: 2, probabilityBp: 0, isLost: true },
    ],
  });

  const mkLead = (name: string, over: any = {}) => prisma.company.create({
    data: { name, country: COUNTRY, lifecycle: "lead", ownerId: owner.id, source: "referral", createdAt: new Date().toISOString(), ...over },
  });

  // ── one press ──────────────────────────────────────────────────────────────────────────────
  const lead = await mkLead("ZZ Pressable Lead");
  const opened = await call("POST", `/api/companies/${lead.id}/open-deal`, tok, {});
  console.log(`the press opens a deal:                  ${opened.status === 201 ? "YES — " + opened.body.title : "NO (" + opened.status + ")"}`);
  if (opened.status !== 201) fail(`could not open a deal: ${JSON.stringify(opened.body)}`);
  console.log(`  titled from the company:               ${/ZZ Pressable Lead/.test(opened.body.title) ? "YES" : "NO"}`);
  console.log(`  unpriced, not guessed:                 ${opened.body.valueMinor == null ? "YES" : "NO (" + opened.body.valueMinor + ")"}`);
  if (opened.body.valueMinor != null) fail("a value was invented for a deal nobody has priced");
  console.log(`  owned by the COMPANY's owner:          ${opened.body.ownerId === owner.id ? "YES" : "NO"}`);
  if (opened.body.ownerId !== owner.id) fail("the deal went to whoever pressed the button, not the lead's owner");
  console.log(`  source carried over:                   ${opened.body.source === "referral" ? "YES" : "NO"}`);

  const chase = await prisma.interaction.findMany({ where: { opportunityId: opened.body.id, auto: true, nextActionDoneAt: null } });
  console.log(`  the stage's chase window applied:      ${chase.length === 1 ? "YES — " + chase[0].nextAction : "NO (" + chase.length + ")"}`);
  if (chase.length !== 1) fail("a deal opened by the button never gets chased");

  const twice = await call("POST", `/api/companies/${lead.id}/open-deal`, tok, {});
  console.log(`a second press is refused:               ${twice.status === 409 ? "YES" : "NO (" + twice.status + ")"}`);
  if (twice.status !== 409) fail("two live deals were opened for one conversation");

  // ── promoting ──────────────────────────────────────────────────────────────────────────────
  const quiet = await mkLead("ZZ Promote Quietly");
  const noFlag = await call("POST", `/api/companies/${quiet.id}/lifecycle`, tok, { to: "prospect" });
  console.log(`\npromoting without asking opens nothing:  ${!noFlag.body.openedDeal ? "YES" : "NO"}`);
  if (noFlag.body.openedDeal) fail("a card appeared on the board that nobody chose");
  if (await prisma.opportunity.count({ where: { companyId: quiet.id } })) fail("a deal was created without the flag");

  const asked = await mkLead("ZZ Promote With Deal");
  const withFlag = await call("POST", `/api/companies/${asked.id}/lifecycle`, tok, { to: "prospect", openDeal: true });
  console.log(`promoting with the box ticked opens one: ${withFlag.body.openedDeal ? "YES — " + withFlag.body.openedDeal.title : "NO"}`);
  if (!withFlag.body.openedDeal) fail("the ticked box did not open a deal");
  if (await prisma.opportunity.count({ where: { companyId: asked.id } }) !== 1) fail("promoting opened more than one deal");

  // Already has one: the flag must not produce a second.
  const already = await call("POST", `/api/companies/${asked.id}/lifecycle`, tok, { to: "lead" });
  const backAgain = await call("POST", `/api/companies/${asked.id}/lifecycle`, tok, { to: "prospect", openDeal: true });
  console.log(`…and never a second for the same lead:   ${!backAgain.body.openedDeal ? "YES" : "NO"}`);
  if (backAgain.body.openedDeal) fail("a second deal was opened for a lead that already had one");
  if (await prisma.opportunity.count({ where: { companyId: asked.id } }) !== 1) fail("a duplicate deal exists");

  // ── refusals ───────────────────────────────────────────────────────────────────────────────
  const dead = await mkLead("ZZ Written Off", { lifecycle: "lost", lostReason: "probe" });
  const onDead = await call("POST", `/api/companies/${dead.id}/open-deal`, tok, {});
  console.log(`\na lost company is refused:               ${onDead.status === 409 ? "YES" : "NO (" + onDead.status + ")"}`);
  if (onDead.status !== 409) fail("a deal was opened for a company already written off");

  const bare = await prisma.company.create({ data: { name: "ZZ No Stages Co", country: "QQ", lifecycle: "lead", createdAt: new Date().toISOString() } });
  const onBare = await call("POST", `/api/companies/${bare.id}/open-deal`, tok, {});
  console.log(`a country with no stages says why:       ${onBare.status === 409 && /stages/i.test(onBare.body.error ?? "") ? "YES" : "NO (" + onBare.status + ")"}`);
  if (onBare.status !== 409) fail("opening a deal with no stages configured did not fail cleanly");

  // ── the nudge ──────────────────────────────────────────────────────────────────────────────
  const old = new Date(Date.now() - (IDLE_LEAD_DAYS + 4) * 86400000).toISOString();
  const forgotten = await mkLead("ZZ Forgotten Lead", { createdAt: old });
  const fresh = await mkLead("ZZ Fresh Lead");
  const notes = (id: string) => prisma.notification.count({ where: { dedupeKey: { contains: id } } });

  const r = await checkIdleLeads();
  console.log(`\nidle leads nudged: ${r.nudged} — ${r.details.join(" · ")}`);
  console.log(`  the forgotten one is raised:           ${(await notes(forgotten.id)) === 1 ? "YES" : "NO"}`);
  if ((await notes(forgotten.id)) !== 1) fail("a lead with no deal and no contact for a fortnight raised nothing");
  console.log(`  a lead typed in today is left alone:   ${(await notes(fresh.id)) === 0 ? "YES" : "NO"}`);
  if (await notes(fresh.id)) fail("a lead created today was already being nagged about");
  console.log(`  one that HAS a deal is left alone:     ${(await notes(lead.id)) === 0 ? "YES" : "NO"}`);
  if (await notes(lead.id)) fail("a lead with a deal on the board was nudged about having nothing happening");

  await checkIdleLeads();
  console.log(`  a second tick adds nothing:            ${(await notes(forgotten.id)) === 1 ? "YES" : "NO"}`);
  if ((await notes(forgotten.id)) !== 1) fail("the same idle lead was announced twice in one day");

  // Speaking to them stops it.
  await logInteraction({ companyId: forgotten.id, kind: "call", summary: "ZZ finally called them" });
  await prisma.notification.deleteMany({ where: { dedupeKey: { contains: forgotten.id } } });
  await checkIdleLeads();
  console.log(`  logging a call silences it:            ${(await notes(forgotten.id)) === 0 ? "YES" : "NO"}`);
  if (await notes(forgotten.id)) fail("a lead somebody just called is still reported as neglected");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.company.deleteMany({ where: { id: bare.id } }).catch(() => {});
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
