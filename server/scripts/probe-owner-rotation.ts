/**
 * Throwaway check for automatic ownership.
 *
 * The assertions that matter are about what it must NOT do, because this writes to a field that
 * decides who can see a client at all:
 *   - an owner somebody named explicitly is never overridden
 *   - with nobody in the rotation, the record stays UNOWNED rather than being filed under an
 *     administrator who does not sell — unowned is a visible problem; wrongly owned looks handled
 *   - a user who is inactive, or has any other role, is never in the rotation
 *   - it only ever fills an empty owner; it never moves one
 *   - the setting turns it off
 *
 * And the fairness:
 *   - the lightest-loaded person takes the next one
 *   - a run over several records spreads them rather than giving them all to one person
 *   - lost and churned companies do not count as load, or whoever handled them is penalised forever
 *   - distribute previews before it writes, and running it again finds nothing left to do
 *
 * Own users, own companies. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { rotation, nextOwner, distributeUnowned } from "../src/assignment.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const PW = "ProbeOnly!2026";
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
    for (const m of ["opportunity", "interaction", "contact", "user", "quotation"] as const)
      await (prisma as any)[m].deleteMany({ where: { companyId: { in: ids } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "example.invalid" } } });
  await prisma.appSetting.deleteMany({ where: { key: "salesRules" } });
  await prisma.activity.deleteMany({ where: { message: { contains: "ZZ " } } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  await sweep();

  const hash = await bcrypt.hash(PW, 10);
  const mk = (name: string, email: string, roleId: string, status = "active") =>
    prisma.user.create({ data: { name, email, roleId, status, type: "staff", passwordHash: hash } });

  const admin = await mk("ZZ Rot Admin", "zz-rot-admin@example.invalid", "super_admin");
  const tok = (await call("POST", "/api/auth/login", undefined, { email: admin.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); await prisma.$disconnect(); process.exitCode = 1; return; }

  // ── what is already there ──────────────────────────────────────────────────────────────────
  // This database is the real one, and it may already have sales users. Every assertion below is
  // therefore about the DELTA this probe causes, not an absolute count — a probe that assumes an
  // empty starting point reports the installation's own data as a bug, which is what this one did
  // the first time it ran.
  const baseline = await rotation();
  console.log(`sales users already here: ${baseline.length ? baseline.map(p => p.name).join(" · ") : "none"}`);
  if (baseline.length) {
    console.log("  (cannot test the no-one-to-assign-to branch while real sales users exist — not silently skipped, just not testable here)");
  } else {
    const none = await call("POST", "/api/companies", tok, { name: "ZZ Orphan Co", cr: "9990100001", country: "SA" });
    console.log(`created with nobody to assign to:        ${none.body.ownerId == null ? "left unowned — YES" : "GIVEN AN OWNER — NO"}`);
    if (none.body.ownerId != null) fail("a client was filed under somebody who does not sell");
  }

  // ── a real rotation ────────────────────────────────────────────────────────────────────────
  const amina = await mk("ZZ Amina", "zz-rot-amina@example.invalid", "sales");
  const bilal = await mk("ZZ Bilal", "zz-rot-bilal@example.invalid", "sales");
  await mk("ZZ Dormant", "zz-rot-dormant@example.invalid", "sales", "inactive");
  await mk("ZZ Officer", "zz-rot-officer@example.invalid", "pro_officer");

  const r = await rotation();
  console.log(`\nrotation: ${r.map(p => `${p.name}(${p.load})`).join(" · ")}`);
  // The DELTA is what this probe caused: two sales users added. Anything else in there was already
  // the installation's, and counting it as a failure is how a probe reports real data as a bug.
  if (r.length !== baseline.length + 2) fail(`the rotation grew by ${r.length - baseline.length}, expected 2 — an inactive or non-sales user is in it`);
  if (r.some(p => /ZZ Dormant|ZZ Officer|ZZ Rot Admin/.test(p.name))) fail("somebody who should not be in the rotation is");

  // ── an explicit owner wins ─────────────────────────────────────────────────────────────────
  const named = await call("POST", "/api/companies", tok, { name: "ZZ Named Owner Co", cr: "9990100002", country: "SA", ownerId: bilal.id });
  console.log(`an explicitly named owner is kept:       ${named.body.ownerId === bilal.id ? "YES" : "NO"}`);
  if (named.body.ownerId !== bilal.id) fail("an owner somebody chose was overridden by the rotation");

  // An explicit null means "leave it for a manager to allocate" — also a decision, also respected.
  const deliberate = await call("POST", "/api/companies", tok, { name: "ZZ Deliberately Unowned Co", cr: "9990100003", country: "SA", ownerId: null });
  console.log(`an explicit null is respected:           ${deliberate.body.ownerId == null ? "YES" : "NO"}`);
  if (deliberate.body.ownerId != null) fail("a deliberate 'no owner' was overridden");

  // ── automatic, and fair ────────────────────────────────────────────────────────────────────
  // The invariant is "whoever is carrying least goes next" — NOT "Amina goes next". Which person
  // that is depends on who else the installation already has, and asserting a name would make this
  // fail on any database but an empty one. Bilal holds one by now, so he must not be the answer.
  const before = await rotation();
  const lightest = Math.min(...before.map(p => p.load));
  const first = await nextOwner();
  console.log(`\nlightest goes next:                      ${first?.name} (${first?.load}) · lightest load is ${lightest}`);
  if (first?.load !== lightest) fail(`next owner carries ${first?.load}, but somebody is carrying ${lightest}`);
  if (first?.id === bilal.id && before.some(p => p.load < first!.load)) fail("the heavier of two people was chosen");

  const made: string[] = [];
  for (let i = 0; i < 4; i++) {
    const c = await call("POST", "/api/companies", tok, { name: `ZZ Auto ${i}`, cr: `999020000${i}`, country: "SA" });
    made.push(c.body.ownerId);
  }
  const byAmina = made.filter(o => o === amina.id).length;
  const byBilal = made.filter(o => o === bilal.id).length;
  const byOthers = made.filter(o => o && o !== amina.id && o !== bilal.id).length;
  console.log(`four created automatically: Amina ${byAmina} · Bilal ${byBilal}${byOthers ? " · others " + byOthers : ""}`);
  // Every one must get SOMEBODY. Which of the rotation it is depends on who was lightest, and with
  // real users present that is not this probe's to predict — only that nobody was left out.
  if (made.some(o => o == null)) fail("some automatically created companies got no owner");
  // Fairness across the whole rotation: nobody should collect every one of them.
  const most = Math.max(byAmina, byBilal, byOthers);
  if (most === 4 && r.length > 1) fail("all four went to one person — they are not being spread");

  // ── lost work is not a burden ──────────────────────────────────────────────────────────────
  const loadBefore = (await rotation()).find(p => p.id === bilal.id)!.load;
  await prisma.company.updateMany({ where: { ownerId: bilal.id, name: "ZZ Named Owner Co" }, data: { lifecycle: "lost", lostReason: "probe" } });
  const loadAfter = (await rotation()).find(p => p.id === bilal.id)!.load;
  console.log(`\na lost company stops counting as load:   ${loadAfter === loadBefore - 1 ? "YES" : "NO (" + loadBefore + " → " + loadAfter + ")"}`);
  if (loadAfter !== loadBefore - 1) fail("whoever handles a lost deal is penalised by it forever");

  // ── the setting turns it off ───────────────────────────────────────────────────────────────
  await prisma.appSetting.upsert({
    where: { key: "salesRules" },
    create: { key: "salesRules", value: { autoAssignOwner: false } },
    update: { value: { autoAssignOwner: false } },
  });
  const off = await call("POST", "/api/companies", tok, { name: "ZZ Switched Off Co", cr: "9990300001", country: "SA" });
  console.log(`turning it off leaves records unowned:   ${off.body.ownerId == null ? "YES" : "NO"}`);
  if (off.body.ownerId != null) fail("the setting did not turn automatic assignment off");
  await prisma.appSetting.deleteMany({ where: { key: "salesRules" } });

  // ── distributing the backlog ───────────────────────────────────────────────────────────────
  // distributeUnowned sweeps EVERY unowned company, including the installation's real ones. Their
  // owners are recorded first and restored at the end — the first version of this probe handed
  // three real clients to users it then deleted, leaving them pointing at nobody, which looks
  // handled and is worse than unowned.
  const realBefore = new Map(
    (await prisma.company.findMany({ where: { NOT: { name: { startsWith: "ZZ " } } }, select: { id: true, ownerId: true } }))
      .map(c => [c.id, c.ownerId]),
  );
  const preview = await call("POST", "/api/companies/distribute-unowned", tok, { apply: false });
  const mine = (preview.body.assigned as any[]).filter(a => a.company.startsWith("ZZ "));
  console.log(`\npreview names who would get what:        ${mine.map(a => a.company + " → " + a.to).join(" · ") || "(nothing)"}`);
  const stillUnowned = await prisma.company.count({ where: { name: { startsWith: "ZZ " }, ownerId: null } });
  console.log(`…and writes nothing:                     ${stillUnowned === mine.length ? "YES" : "NO"}`);
  if (stillUnowned !== mine.length) fail("the preview wrote to the database");

  await call("POST", "/api/companies/distribute-unowned", tok, { apply: true });
  const leftUnowned = await prisma.company.count({ where: { name: { startsWith: "ZZ " }, ownerId: null, lifecycle: { notIn: ["lost", "churned"] } } });
  console.log(`applying assigns them all:               ${leftUnowned === 0 ? "YES" : "NO (" + leftUnowned + " left)"}`);
  if (leftUnowned) fail("companies were left unowned after distributing");

  const again = await call("POST", "/api/companies/distribute-unowned", tok, { apply: true });
  const againMine = (again.body.assigned as any[]).filter(a => a.company.startsWith("ZZ "));
  console.log(`running it again finds nothing to do:    ${againMine.length === 0 ? "YES" : "NO (" + againMine.length + ")"}`);
  if (againMine.length) fail("distributing twice reassigned companies that already had owners");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  // Put every real company back exactly as it was found, BEFORE the probe's users are deleted.
  let restored = 0;
  for (const [id, ownerId] of realBefore) {
    const now = await prisma.company.findUnique({ where: { id }, select: { ownerId: true } });
    if (now && now.ownerId !== ownerId) { await prisma.company.update({ where: { id }, data: { ownerId } }); restored++; }
  }
  console.log(`real companies put back as they were:    ${restored} restored`);
  const dangling = await prisma.company.count({
    where: { NOT: { name: { startsWith: "ZZ " } }, ownerId: { notIn: (await prisma.user.findMany({ select: { id: true } })).map(u => u.id) } },
  });
  if (dangling) fail(`${dangling} real company/companies point at a user that will not exist`);

  await sweep();
  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } })) +
    (await prisma.appSetting.count({ where: { key: "salesRules" } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exitCode = bad ? 1 : 0;
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
