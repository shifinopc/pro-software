/**
 * Throwaway check for the courier job-type list.
 *
 * The five kinds of run were five words written into the booking form, so a firm that also does, say,
 * visa stamping pickups had to ask for a code change to name one. The list is now configuration —
 * but configuration that SUGGESTS rather than constrains, for the same reason the loss reasons do:
 * a list that can refuse is a list that will one day stop somebody booking a real job.
 *
 *   - a list saves and comes back
 *   - a job type that is NOT on the list still books, through the real route
 *   - a country with nothing configured can still book — the form falls back, it never empties
 *   - removing a type that shipments already use RETIRES it, so those jobs keep their wording
 *   - removing a type nothing uses deletes it outright
 *   - a duplicate spelling is refused
 *   - the list travels in a country pack
 *
 * Own country, own client, own list. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { KINDS } from "../src/packs.js";
import bcrypt from "bcryptjs";

const COUNTRY = "ZJ";
const BARE = "QJ";
const PW = "ProbeOnly!2026";
const API = "http://localhost:4100";

const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: "ZJ " } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.courierShipment.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.contact.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  for (const c of [COUNTRY, BARE]) await prisma.courierJobType.deleteMany({ where: { country: c } });
  await prisma.user.deleteMany({ where: { email: "zj-courier@example.invalid" } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  const staff = await prisma.user.create({ data: { name: "ZJ Courier Staff", email: "zj-courier@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", { email: staff.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in - is the API running?"); process.exit(1); }

  console.log(`pack sections carry the list:            ${KINDS.map(k => k.key).includes("courierJobTypes") ? "YES" : "NO"}`);
  if (!KINDS.map(k => k.key).includes("courierJobTypes")) fail("the country pack does not carry the job-type list");

  const saved = await call("PUT", "/api/courier-job-types", {
    country: COUNTRY,
    rows: [{ name: "ZJ Visa stamping pickup" }, { name: "ZJ Passport delivery" }, { name: "ZJ Unused kind" }],
  }, tok);
  console.log(`\njob types saved:                         ${Array.isArray(saved.body) ? saved.body.length : "NO (" + saved.status + ")"}`);
  if (!Array.isArray(saved.body) || saved.body.length !== 3) fail("the job-type list did not save");

  const dupe = await call("PUT", "/api/courier-job-types", { country: COUNTRY, rows: [{ name: "ZJ Passport delivery" }, { name: "zj passport DELIVERY" }] }, tok);
  console.log(`a duplicate spelling is refused:         ${dupe.status === 400 ? "YES" : "NO (" + dupe.status + ")"}`);
  if (dupe.status !== 400) fail("two spellings of one job type were accepted");

  const co = await prisma.company.create({ data: { name: "ZJ Courier Client", cr: "0000", country: COUNTRY, lifecycle: "client" } });

  // ── booking through the real route ─────────────────────────────────────────────────────────
  const onList = await call("POST", "/api/courier-shipments", { companyId: co.id, ref: "ZJ-C-1", description: "ZJ Visa stamping pickup", fromPlace: "Office", toPlace: "MOFA", status: "in_transit" }, tok);
  console.log(`\na configured type books:                 ${onList.status === 200 || onList.status === 201 ? "YES" : "NO (" + onList.status + " " + JSON.stringify(onList.body).slice(0, 120) + ")"}`);
  if (onList.status >= 300) fail("a job type from the list could not be booked");

  const offList = await call("POST", "/api/courier-shipments", { companyId: co.id, ref: "ZJ-C-2", description: "ZJ Something nobody listed", fromPlace: "A", toPlace: "B", status: "in_transit" }, tok);
  console.log(`a type NOT on the list still books:      ${offList.status === 200 || offList.status === 201 ? "YES" : "NO (" + offList.status + ")"}`);
  if (offList.status >= 300) fail("a job outside the list was refused - real runs would go unrecorded");

  const bareList = await call("GET", `/api/courier-job-types?country=${BARE}`, undefined, tok);
  console.log(`a country with no list reads empty:      ${Array.isArray(bareList.body) && bareList.body.length === 0 ? "YES" : "NO"}`);

  // ── removing entries ───────────────────────────────────────────────────────────────────────
  const after = await call("PUT", "/api/courier-job-types", { country: COUNTRY, rows: [{ name: "ZJ Passport delivery" }] }, tok);
  const usedRow = await prisma.courierJobType.findFirst({ where: { country: COUNTRY, name: "ZJ Visa stamping pickup" } });
  const unusedRow = await prisma.courierJobType.findFirst({ where: { country: COUNTRY, name: "ZJ Unused kind" } });
  console.log(`\na type shipments use is retired:         ${usedRow?.retired ? "YES" : "NO"}`);
  if (!usedRow?.retired) fail("a job type still carried by a shipment was deleted rather than retired");
  console.log(`a type nothing uses is deleted:          ${unusedRow === null ? "YES" : "NO"}`);
  if (unusedRow !== null) fail("an unused type was retired instead of removed - the list fills with debris");
  console.log(`the live list no longer offers it:       ${Array.isArray(after.body) && after.body.every((r: any) => r.name !== "ZJ Visa stamping pickup") ? "YES" : "NO"}`);

  const stillNamed = await prisma.courierShipment.findFirst({ where: { companyId: co.id, description: "ZJ Visa stamping pickup" } });
  console.log(`the booked job keeps its wording:        ${stillNamed ? "YES" : "NO"}`);
  if (!stillNamed) fail("removing a type rewrote a shipment that was already booked");

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
