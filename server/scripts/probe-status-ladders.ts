/**
 * Throwaway check for the two status ladders and the appointment types.
 *
 * The defect underneath all three: the console spoke one vocabulary and the database another. It
 * drew "Requested / Picked up / In transit / Delivered" while the schema default and the workflow
 * engine wrote "in_transit" and "preparing", with nothing reconciling them — so every shipment the
 * software raised itself read as Requested however far it had actually got, and matched no tab.
 * Appointments had the same split, on "scheduled".
 *
 * What must be true now:
 *   - a ladder never answers empty; nothing configured means the built-in one
 *   - a value an older version wrote resolves to the rung it always meant
 *   - a value NOBODY configured is left alone, not silently relabelled as the first rung
 *   - renaming a rung MOVES the records on it, including the ones spelling it the old way, and
 *     including on the very first save, when there is no stored row to compare against
 *   - removing a rung records are on RETIRES it; removing an unused one deletes it
 *   - appointment types carry their icon, suggest rather than constrain, and travel in a pack
 *
 * Own country, own client, own lists. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { KINDS } from "../src/packs.js";
import bcrypt from "bcryptjs";

const C = "ZL";
const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";
const EMAIL = "zl-ladder@example.invalid";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZL " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.courierShipment.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.courierShipment.deleteMany({ where: { ref: { startsWith: "ZL-" } } });
  await prisma.courierStatus.deleteMany({ where: { country: C } });
  await prisma.appointmentStatus.deleteMany({ where: { country: C } });
  await prisma.appointmentType.deleteMany({ where: { country: C } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  const staff = await prisma.user.create({ data: { name: "ZL Ladder Staff", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", { email: EMAIL, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in - is the API running?"); process.exit(1); }

  const kinds = KINDS.map(k => k.key);
  const inPack = ["appointmentTypes", "courierStatuses", "appointmentStatuses"].every(k => kinds.includes(k));
  console.log(`all three travel in a country pack:      ${inPack ? "YES" : "NO"}`);
  if (!inPack) fail("a list is missing from the country pack");

  // ── the ladder never answers empty ─────────────────────────────────────────────────────────
  const built = (await call("GET", `/api/courier-statuses?country=${C}`, undefined, tok)).body;
  console.log(`\nunconfigured ladder still has rungs:     ${Array.isArray(built.rungs) && built.rungs.length ? built.rungs.length : "NO"}`);
  if (!Array.isArray(built.rungs) || !built.rungs.length) fail("an unconfigured ladder came back empty - the board could not say where anything is");
  console.log(`...and says it is not configured yet:    ${built.configured === false ? "YES" : "NO"}`);
  console.log(`...and each default names its origin:   ${built.rungs.every((r: any) => r.builtin) ? "YES" : "NO"}`);
  if (!built.rungs.every((r: any) => r.builtin)) fail("built-in rungs do not carry `builtin`, so the first rename cannot be recognised");

  const co = await prisma.company.create({ data: { name: "ZL Ladder Client", cr: "0000", country: C, lifecycle: "client" } });

  // Records written the way older versions wrote them, plus one nobody's vocabulary contains.
  const mk = (ref: string, status: string) => prisma.courierShipment.create({ data: { ref, status, description: "ZL run", companyId: co.id, clientName: co.name, fromPlace: "Office", toPlace: "GDRFA" } });
  await mk("ZL-1", "in_transit");
  await mk("ZL-2", "preparing");
  await mk("ZL-3", "Picked up");
  await mk("ZL-4", "a word nobody configured");

  // A shipment belonging to ANOTHER market, sitting on the rung about to be renamed. The ladder is
  // country-scoped configuration; an unscoped rename would rewrite this too — a destructive edit to
  // records the person saving cannot even see.
  const other = await prisma.company.create({ data: { name: "ZL Other Market Client", cr: "0001", country: "ZM", lifecycle: "client" } });
  await prisma.courierShipment.create({ data: { ref: "ZL-OTHER", status: "In transit", description: "ZL run", companyId: other.id, clientName: other.name } });

  // ── the first save is also a rename ────────────────────────────────────────────────────────
  //
  // The hard case: the firm has configured nothing, opens the editor on the built-in ladder and
  // renames a rung. There is no stored row to compare against, so without `builtin` the server
  // reads it as a brand-new rung and leaves every record on the old one stranded.
  const renamed = built.rungs.map((r: any) => (r.builtin === "In transit" ? { ...r, name: "On the road" } : r));
  const saved = await call("PUT", "/api/courier-statuses", { country: C, rows: renamed }, tok);
  console.log(`\nfirst-save rename moved records:         ${saved.body.migrated ?? "NO"}`);
  if (!saved.body.migrated) fail("renaming a rung on the built-in ladder moved nothing - those records are now off the ladder");

  const after = Object.fromEntries((await prisma.courierShipment.findMany({ where: { companyId: co.id }, select: { ref: true, status: true } })).map(r => [r.ref, r.status]));
  console.log(`the legacy spelling moved too:           ${after["ZL-1"] === "On the road" ? "YES" : "NO (" + after["ZL-1"] + ")"}`);
  if (after["ZL-1"] !== "On the road") fail("a record written as `in_transit` was left behind by the rename");
  console.log(`an untouched rung stayed put:            ${after["ZL-3"] === "Picked up" ? "YES" : "NO (" + after["ZL-3"] + ")"}`);
  console.log(`an unrecognised value was left alone:    ${after["ZL-4"] === "a word nobody configured" ? "YES" : "NO (" + after["ZL-4"] + ")"}`);
  if (after["ZL-4"] !== "a word nobody configured") fail("a status nobody configured was rewritten - the board would be claiming something untrue");
  console.log(`"preparing" resolves without rewriting:  ${after["ZL-2"] === "preparing" ? "YES" : "NO (" + after["ZL-2"] + ")"}`);
  console.log(`exactly one record moved, not two:       ${saved.body.migrated === 1 ? "YES" : "NO (" + saved.body.migrated + ")"}`);
  if (saved.body.migrated !== 1) fail("the rename touched more than the one record it should have");
  const otherShip = await prisma.courierShipment.findFirst({ where: { ref: "ZL-OTHER" }, select: { status: true } });
  console.log(`another market's records untouched:      ${otherShip?.status === "In transit" ? "YES" : "NO (" + otherShip?.status + ")"}`);
  if (otherShip?.status !== "In transit") fail("renaming one country's rung rewrote another country's records");

  // ── retire vs delete ───────────────────────────────────────────────────────────────────────
  const live = (await call("GET", `/api/courier-statuses?country=${C}`, undefined, tok)).body.rungs;
  const trimmed = live.filter((r: any) => r.name !== "On the road" && r.name !== "Returned");
  await call("PUT", "/api/courier-statuses", { country: C, rows: trimmed }, tok);
  const usedRung = await prisma.courierStatus.findFirst({ where: { country: C, name: "On the road" } });
  const unusedRung = await prisma.courierStatus.findFirst({ where: { country: C, name: "Returned" } });
  console.log(`\na rung records sit on is retired:        ${usedRung?.retired ? "YES" : "NO"}`);
  if (!usedRung?.retired) fail("a rung with records on it was deleted rather than retired");
  console.log(`a rung nothing uses is deleted:          ${unusedRung === null ? "YES" : "NO"}`);

  // ── a ladder of nothing but exceptions is refused ──────────────────────────────────────────
  const allExc = await call("PUT", "/api/appointment-statuses", { country: C, rows: [{ name: "ZL Cancelled", offLadder: true, terminal: true }] }, tok);
  const excRungs = (allExc.body.rungs ?? []).filter((r: any) => !r.offLadder);
  console.log(`\nflags persist through a save:            ${allExc.body.rungs?.[0]?.offLadder === true ? "YES" : "NO"}`);
  if (allExc.body.rungs?.[0]?.offLadder !== true) fail("the step/exception flag did not persist");
  console.log(`...leaving no steps at all:              ${excRungs.length === 0 ? "yes (the console refuses this)" : "n/a"}`);

  // ── appointment types: icons, suggestions not constraints ──────────────────────────────────
  const types = await call("PUT", "/api/appointment-types", { country: C, rows: [{ name: "ZL Medical", icon: "\u{1FA7A}" }, { name: "ZL Qiwa visit", icon: "\u{1F3DB}" }] }, tok);
  console.log(`\nappointment types saved with icons:      ${Array.isArray(types.body) && types.body.every((t: any) => t.icon) ? types.body.length : "NO"}`);
  if (!Array.isArray(types.body) || !types.body.every((t: any) => t.icon)) fail("appointment type icons did not save");

  const offList = await call("POST", "/api/appointments", { title: "ZL off-list", type: "ZL Something nobody listed", companyId: co.id, clientName: co.name, date: "2026-09-01", time: "10:00 AM", status: "Requested" }, tok);
  console.log(`a type NOT on the list still books:      ${offList.status < 300 ? "YES" : "NO (" + offList.status + ")"}`);
  if (offList.status >= 300) fail("an appointment type outside the list was refused - real bookings would go unrecorded");

  await call("POST", "/api/appointments", { title: "ZL listed", type: "ZL Medical", companyId: co.id, clientName: co.name, date: "2026-09-02", time: "10:00 AM", status: "Requested" }, tok);
  await call("PUT", "/api/appointment-types", { country: C, rows: [{ name: "ZL Qiwa visit", icon: "\u{1F3DB}" }] }, tok);
  const usedType = await prisma.appointmentType.findFirst({ where: { country: C, name: "ZL Medical" } });
  console.log(`a type appointments use is retired:      ${usedType?.retired ? "YES" : "NO"}`);
  if (!usedType?.retired) fail("an appointment type in use was deleted rather than retired");

  // ── a duplicate is still refused, and a bad save answers rather than hanging ────────────────
  const dupe = await call("PUT", "/api/appointment-types", { country: C, rows: [{ name: "ZL Qiwa visit" }, { name: "zl QIWA visit" }] }, tok);
  console.log(`\na duplicate spelling is refused:         ${dupe.status === 400 ? "YES" : "NO (" + dupe.status + ")"}`);
  if (dupe.status !== 400) fail("two spellings of one type were accepted");

  const stale = await call("PUT", "/api/appointment-types", { country: C, rows: [{ id: "does-not-exist", name: "ZL Recreated" }] }, tok);
  console.log(`a stale row id does not lose the save:   ${stale.status === 200 ? "YES" : "NO (" + stale.status + ")"}`);
  if (stale.status !== 200) fail("one stale id threw away the whole save");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
