/**
 * Throwaway check for CRM phase 1: leads, contacts, and the line between a lead and a client.
 *
 * The assertions that matter are the ones about a lead NOT being treated as a client:
 *   - a lead saves with no CR number, where a client refuses to
 *   - a lead gets no portal login, and cannot get one by signing in
 *   - a lead is absent from the default client list, the workforce report and the band job
 *   - becoming a client demands a CR, captures it, and provisions the login exactly once
 *   - being lost demands a reason, because a lost-reason nobody typed is the whole loss of the field
 *
 * And the ones about the contact mirror having exactly one writer:
 *   - the first contact added becomes primary without anyone saying so
 *   - making another primary moves the flag AND the company's three legacy columns together
 *   - deleting the primary promotes someone else rather than leaving the mirror pointing at a ghost
 *   - deleting the last contact clears the mirror instead of leaving a stale name on the record
 *
 * Own company, own users, own contacts. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import { workforceAll } from "../src/workforce.js";
import { checkWorkforceBands } from "../src/jobs.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const call = (method: string, p: string, body?: any, tok?: string) =>
  fetch(API + p, {
    method,
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: "Bearer " + tok } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));
const post = (p: string, b: any, t?: string) => call("POST", p, b, t);
const put = (p: string, b: any, t: string) => call("PUT", p, b, t);
const del = (p: string, t: string) => call("DELETE", p, undefined, t);
const get = (p: string, t: string) => call("GET", p, undefined, t);

const PW = "ProbeOnly!2026";

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  ✗ " + m); bad++; };
  const hash = await bcrypt.hash(PW, 10);

  const staff = await prisma.user.create({ data: { name: "ZZ CRM Staff", email: "zz-crm-staff@example.invalid", roleId: "super_admin", status: "active", type: "staff", passwordHash: hash } });
  const tok = (await post("/api/auth/login", { email: staff.email, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in as the probe's own staff user — is the API running?"); process.exit(1); }

  // ── a client refuses to be created without a CR ────────────────────────────────────────────
  const noCr = await post("/api/companies", { name: "ZZ Should Not Exist", email: "zz-nope@example.invalid" }, tok);
  console.log(`client with no CR is refused:            ${noCr.status === 400 ? "YES" : "NO (" + noCr.status + ")"}`);
  if (noCr.status !== 400) fail("a client was created with no CR number");

  // ── a LEAD saves with no CR, and gets no login ─────────────────────────────────────────────
  const leadRes = await post("/api/companies", {
    name: "ZZ Lead Contracting Co", lifecycle: "lead", country: "SA", source: "referral",
    sourceDetail: "probe", email: "zz-lead@example.invalid", contact: "ZZ Lead Person", phone: "+966500000001",
  }, tok);
  console.log(`lead saves with no CR:                   ${leadRes.status === 201 ? "YES" : "NO (" + leadRes.status + ")"}`);
  if (leadRes.status !== 201) fail(`a lead could not be saved without a CR: ${JSON.stringify(leadRes.body)}`);
  const lead = leadRes.body;
  if (lead?.portalTempPassword) fail("a lead was handed a portal password");

  const leadUsers = await prisma.user.count({ where: { companyId: lead.id } });
  console.log(`lead has no portal user:                 ${leadUsers === 0 ? "YES" : "NO (" + leadUsers + ")"}`);
  if (leadUsers) fail("a lead was given a portal login");

  // ── the lead is invisible where clients are meant to be ────────────────────────────────────
  const defaultList = await get("/api/companies", tok);
  const leadInDefault = (defaultList.body as any[]).some(c => c.id === lead.id);
  console.log(`lead absent from the default list:       ${!leadInDefault ? "YES" : "NO"}`);
  if (leadInDefault) fail("a lead appeared in the default client list");

  const asked = await get("/api/companies?lifecycle=lead", tok);
  console.log(`…but present when asked for:             ${(asked.body as any[]).some(c => c.id === lead.id) ? "YES" : "NO"}`);
  if (!(asked.body as any[]).some(c => c.id === lead.id)) fail("?lifecycle=lead did not return the lead");

  // Give it staff so the workforce module would have something to say, if it looked.
  await prisma.employee.create({ data: { companyId: lead.id, name: "ZZ Lead Staffer" + Math.random(), workCountry: "SA", nationality: "IN" } });
  const wf = await workforceAll();
  console.log(`lead absent from the workforce report:   ${!wf.some(w => w.companyId === lead.id) ? "YES" : "NO"}`);
  if (wf.some(w => w.companyId === lead.id)) fail("a lead was reported on for Saudization");

  const bandsBefore = await prisma.notification.count({ where: { dedupeKey: { contains: lead.id } } });
  await checkWorkforceBands();
  const bandsAfter = await prisma.notification.count({ where: { dedupeKey: { contains: lead.id } } });
  console.log(`band job raised nothing for the lead:    ${bandsAfter === bandsBefore ? "YES" : "NO"}`);
  if (bandsAfter !== bandsBefore) fail("the band job alerted about a lead");

  // ── contacts: first one is primary, mirror follows ─────────────────────────────────────────
  // The create route already made one from the flat columns; that is the behaviour being checked.
  const first = (await get(`/api/contacts?companyId=${lead.id}`, tok)).body as any[];
  console.log(`\nthe flat contact columns became a row:   ${first.length === 1 && first[0].isPrimary ? "YES" : "NO"}`);
  if (first.length !== 1 || !first[0].isPrimary) fail(`expected exactly one primary contact, got ${JSON.stringify(first)}`);

  const second = await post("/api/contacts", { companyId: lead.id, name: "ZZ HR Manager", jobTitle: "HR Manager", email: "zz-hr@example.invalid", phone: "+966500000002" }, tok);
  console.log(`a second contact is NOT primary:         ${second.body?.isPrimary === false ? "YES" : "NO"}`);
  if (second.body?.isPrimary !== false) fail("adding a second contact stole the primary flag");

  await post(`/api/contacts/${second.body.id}/make-primary`, {}, tok);
  let co = await prisma.company.findUnique({ where: { id: lead.id } });
  const all = await prisma.contact.findMany({ where: { companyId: lead.id, archived: false } });
  console.log(`make-primary moved the flag:             ${all.filter(c => c.isPrimary).length === 1 && all.find(c => c.isPrimary)!.id === second.body.id ? "YES" : "NO"}`);
  if (all.filter(c => c.isPrimary).length !== 1) fail(`${all.filter(c => c.isPrimary).length} contacts are flagged primary — must be exactly one`);
  console.log(`…and the company mirror followed it:     ${co!.contact === "ZZ HR Manager" && co!.email === "zz-hr@example.invalid" ? "YES" : "NO"}`);
  if (co!.contact !== "ZZ HR Manager" || co!.email !== "zz-hr@example.invalid" || co!.phone !== "+966500000002")
    fail(`the mirror says ${co!.contact}/${co!.email}/${co!.phone}, the primary contact is ZZ HR Manager/zz-hr@example.invalid/+966500000002`);

  // An edit to the primary reaches the mirror too — the case where a phone number changes.
  await put(`/api/contacts/${second.body.id}`, { phone: "+966599999999" }, tok);
  co = await prisma.company.findUnique({ where: { id: lead.id } });
  console.log(`editing the primary updates the mirror:  ${co!.phone === "+966599999999" ? "YES" : "NO"}`);
  if (co!.phone !== "+966599999999") fail(`the mirror kept the old phone number (${co!.phone})`);

  // Deleting the primary promotes the other one rather than leaving the mirror pointing at nobody.
  await del(`/api/contacts/${second.body.id}`, tok);
  co = await prisma.company.findUnique({ where: { id: lead.id } });
  const left = await prisma.contact.findMany({ where: { companyId: lead.id, archived: false } });
  console.log(`deleting the primary promotes another:   ${left.length === 1 && left[0].isPrimary ? "YES" : "NO"}`);
  if (left.length !== 1 || !left[0].isPrimary) fail("no primary contact left after deleting the primary one");
  console.log(`…and the mirror points at them:          ${co!.contact === left[0]?.name ? "YES" : "NO"}`);
  if (co!.contact !== left[0]?.name) fail(`the mirror says ${co!.contact}, the only contact is ${left[0]?.name}`);

  // ── lifecycle: becoming a client ───────────────────────────────────────────────────────────
  const noCrConvert = await post(`/api/companies/${lead.id}/lifecycle`, { to: "client" }, tok);
  console.log(`\nconverting with no CR is refused:        ${noCrConvert.status === 400 ? "YES" : "NO (" + noCrConvert.status + ")"}`);
  if (noCrConvert.status !== 400) fail("a lead became a client without a CR number");

  const won = await post(`/api/companies/${lead.id}/lifecycle`, { to: "client", cr: "1010101010" }, tok);
  console.log(`converting with a CR works:              ${won.status === 200 ? "YES" : "NO (" + won.status + ")"}`);
  if (won.status !== 200) fail(`converting failed: ${JSON.stringify(won.body)}`);
  console.log(`…the CR was captured:                    ${won.body?.company?.cr === "1010101010" ? "YES" : "NO"}`);
  if (won.body?.company?.cr !== "1010101010") fail("the CR given at conversion was not stored");
  console.log(`…and the portal login was provisioned:   ${won.body?.portalTempPassword ? "YES" : "NO"}`);
  if (!won.body?.portalTempPassword) fail("no portal login was created when the lead became a client");

  const nowClient = (await get("/api/companies", tok)).body as any[];
  console.log(`…now in the default client list:         ${nowClient.some(c => c.id === lead.id) ? "YES" : "NO"}`);
  if (!nowClient.some(c => c.id === lead.id)) fail("a converted client is missing from the client list");

  const wf2 = await workforceAll();
  console.log(`…and now in the workforce report:        ${wf2.some(w => w.companyId === lead.id) ? "YES" : "NO"}`);
  if (!wf2.some(w => w.companyId === lead.id)) fail("a converted client is missing from the workforce report");

  // Converting again does not mint a second login for the same address.
  const usersNow = await prisma.user.count({ where: { companyId: lead.id } });
  await post(`/api/companies/${lead.id}/lifecycle`, { to: "prospect" }, tok);
  await post(`/api/companies/${lead.id}/lifecycle`, { to: "client", cr: "1010101010" }, tok);
  const usersAfter = await prisma.user.count({ where: { companyId: lead.id } });
  console.log(`converting twice makes one login only:   ${usersAfter === usersNow ? "YES" : "NO (" + usersNow + " → " + usersAfter + ")"}`);
  if (usersAfter !== usersNow) fail("a second portal user was created on re-conversion");

  // ── the portal belongs to clients ──────────────────────────────────────────────────────────
  const portalUser = await prisma.user.findFirst({ where: { companyId: lead.id, type: "portal" } });
  await prisma.user.update({ where: { id: portalUser!.id }, data: { passwordHash: hash, mustChangePassword: false } });
  const inAsClient = await post("/api/auth/portal-login", { email: portalUser!.email, password: PW });
  console.log(`\nportal sign-in works while a client:     ${inAsClient.status === 200 ? "YES" : "NO (" + inAsClient.status + ")"}`);
  if (inAsClient.status !== 200) fail("a real client's portal user could not sign in");
  const liveToken = inAsClient.body.token;

  await post(`/api/companies/${lead.id}/lifecycle`, { to: "churned", lostReason: "Probe — moved to a competitor" }, tok);
  const afterChurn = await get("/api/portal/me", liveToken);
  console.log(`…their live session stops on churn:      ${afterChurn.status === 403 ? "YES" : "NO (" + afterChurn.status + ")"}`);
  if (afterChurn.status !== 403) fail("a churned client's portal session kept working");
  const reLogin = await post("/api/auth/portal-login", { email: portalUser!.email, password: PW });
  console.log(`…and they cannot sign in again:          ${reLogin.status === 403 ? "YES" : "NO (" + reLogin.status + ")"}`);
  if (reLogin.status !== 403) fail("a churned client's portal user could sign in");

  const noReason = await post(`/api/companies/${lead.id}/lifecycle`, { to: "lost" }, tok);
  console.log(`marking lost with no reason is refused:  ${noReason.status === 400 ? "YES" : "NO (" + noReason.status + ")"}`);
  if (noReason.status !== 400) fail("a company was marked lost with no reason recorded");

  // ── clean up ───────────────────────────────────────────────────────────────────────────────
  await prisma.notification.deleteMany({ where: { dedupeKey: { contains: lead.id } } });
  await prisma.employee.deleteMany({ where: { companyId: lead.id } });
  await prisma.contact.deleteMany({ where: { companyId: lead.id } });
  await prisma.user.deleteMany({ where: { companyId: lead.id } });
  await prisma.company.delete({ where: { id: lead.id } });
  await prisma.user.delete({ where: { id: staff.id } });
  await prisma.audit.deleteMany({ where: { target: lead.id } });

  const leftovers =
    (await prisma.company.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.contact.count({ where: { name: { startsWith: "ZZ " } } })) +
    (await prisma.user.count({ where: { email: { contains: "example.invalid" } } }));
  console.log(`\ncleaned up: ${leftovers === 0 ? "YES" : "NO — " + leftovers + " rows left"}`);
  if (leftovers) fail("probe rows left behind");

  console.log(`\nfailures: ${bad}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exitCode = 1; });
