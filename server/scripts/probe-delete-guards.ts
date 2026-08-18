/**
 * Throwaway check that referenced configuration cannot be deleted out from under what uses it.
 *
 * The failure this prevents has happened twice. Six issue_document steps were left naming document
 * types that no longer existed — the steps still ran and produced documents with no authority and
 * default lead days. Separately a soft-deleted customer dropped approved orders out of a list that
 * inner-joined it. Neither delete failed, because these references are names and ids inside strings
 * and JSON: there is no foreign key for the database to refuse on.
 *
 * So this creates its own configuration, points something at it, and tries to delete it through the
 * REAL API — the same route the console calls.
 *
 * Own document type, own authority, own service, own workflow. Deletes all of it afterwards.
 */
import { prisma } from "../src/db.js";
import bcrypt from "bcryptjs";

const API = "http://localhost:4100";
const EMAIL = "dg-probe@example.invalid";
const PW = "DgProbe!2026";
const TAG = "DG Probe";

const call = (method: string, p: string, tok: string, body?: any) =>
  fetch(API + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + tok }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as any }));

async function sweep() {
  await prisma.workflowTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.serviceItem.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.documentType.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.govCenter.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
}

async function main() {
  let bad = 0;
  const fail = (m: string) => { console.log("  x " + m); bad++; };
  await sweep();

  await prisma.user.create({ data: { name: "DG Probe", email: EMAIL, roleId: "super_admin", status: "active", type: "staff", passwordHash: await bcrypt.hash(PW, 10) } });
  const tok = (await call("POST", "/api/auth/login", "", { email: EMAIL, password: PW })).body.token as string;
  if (!tok) { console.log("could not sign in — is the API running?"); await sweep(); process.exit(1); }

  const C = "ZQ";
  const auth = await prisma.govCenter.create({ data: { name: `${TAG} Authority`, country: C, sub: "probe" } });
  const dtUsed = await prisma.documentType.create({ data: { name: `${TAG} Used Type`, country: C, subjectKind: "employee", authority: auth.name } });
  const dtFree = await prisma.documentType.create({ data: { name: `${TAG} Unused Type`, country: C, subjectKind: "employee" } });
  await prisma.workflowTemplate.create({ data: {
    name: `${TAG} Flow`, country: C, trigger: "manual", entityType: "employee", active: false,
    graph: { nodes: [{ id: "d", type: "issue_document", label: "Issue it", config: { docType: dtUsed.name } }], edges: [] } as any } });

  // ── a document type a workflow issues ──────────────────────────────────────────────────────
  const u1 = await call("GET", `/api/document-types/${dtUsed.id}/usage`, tok);
  console.log(`the API can say what uses a type:      ${u1.status === 200 ? "YES" : "NO (" + u1.status + ")"}`);
  console.log(`  "${(u1.body.usedBy ?? []).join('", "')}"`);
  if (!(u1.body.usedBy ?? []).length) fail("a document type issued by a workflow reported no usage");
  if (u1.body.canDelete !== false) fail("the console would be told it is safe to delete");

  const d1 = await call("DELETE", `/api/document-types/${dtUsed.id}`, tok);
  const stillThere = await prisma.documentType.findUnique({ where: { id: dtUsed.id } });
  console.log(`deleting it does NOT remove the row:   ${stillThere ? "YES" : "NO — IT WAS DELETED"}`);
  if (!stillThere) fail("a document type a workflow issues was deleted, leaving the step naming nothing");
  console.log(`...it is retired instead:              ${stillThere?.retired ? "YES" : "NO"}`);
  if (!stillThere?.retired) fail("it survived but was not retired, so it still shows in every picker");
  console.log(`...and the caller is told why:         ${d1.body?.usedBy?.length ? "YES" : "NO"} (${d1.status})`);
  if (!d1.body?.usedBy?.length) fail("the response carried no reason, so the screen can only say 'could not delete'");

  // ── one nothing points at must still delete cleanly ────────────────────────────────────────
  const u2 = await call("GET", `/api/document-types/${dtFree.id}/usage`, tok);
  console.log(`\nan unused type reports nothing:        ${(u2.body.usedBy ?? []).length === 0 ? "YES" : "NO"}`);
  const d2 = await call("DELETE", `/api/document-types/${dtFree.id}`, tok);
  const gone = !(await prisma.documentType.findUnique({ where: { id: dtFree.id } }));
  console.log(`...and really is deleted:              ${gone ? "YES" : "NO"} (${d2.status})`);
  if (!gone) fail("the guard blocks deletes it should not — configuration would become un-removable");

  // ── an authority a document type names ─────────────────────────────────────────────────────
  const u3 = await call("GET", `/api/gov-centers/${auth.id}/usage`, tok);
  console.log(`\nan authority knows its documents:      ${(u3.body.usedBy ?? []).length ? "YES" : "NO"}`);
  console.log(`  "${(u3.body.usedBy ?? []).join('", "')}"`);
  await call("DELETE", `/api/gov-centers/${auth.id}`, tok);
  const auth2 = await prisma.govCenter.findUnique({ where: { id: auth.id } });
  console.log(`deleting it retires instead:           ${auth2?.retired ? "YES" : auth2 ? "NO (still active)" : "NO — IT WAS DELETED"}`);
  if (!auth2?.retired) fail("an authority its documents name was removed, so they now cite a body that does not exist");

  // ── a service in a package ─────────────────────────────────────────────────────────────────
  const svc = await prisma.serviceItem.create({ data: { name: `${TAG} Service`, country: C } });
  const pkg = await prisma.package.create({ data: { name: `${TAG} Package`, country: C, tier: "basic", basePrice: 1, empMin: 0, empMax: 1, features: [], serviceIds: [svc.id] as any } });
  // Service items have their OWN delete guard in index.ts and refuse outright rather than retiring —
  // right for something being sold, since a service inside a plan should be taken out of the plan by
  // somebody who knows what that plan is for. What matters is the same either way: it is not deleted
  // and the caller is told why.
  const d4 = await call("DELETE", `/api/service-items/${svc.id}`, tok);
  const svc2 = await prisma.serviceItem.findUnique({ where: { id: svc.id } });
  console.log(`
a service inside a package survives:   ${svc2 ? "YES" : "NO — IT WAS DELETED"}`);
  if (!svc2) fail("a service sold inside a package was deleted, so the package now lists a service that does not exist");
  console.log(`...refused with a reason:              ${d4.status === 409 && d4.body?.error ? "YES" : "NO (" + d4.status + ")"}`);
  console.log(`  "${d4.body?.error ?? ""}"`);
  if (d4.status !== 409 || !d4.body?.error) fail("it survived, but nothing told the user why — the screen can only say 'could not delete'");
  await prisma.package.delete({ where: { id: pkg.id } });

  await sweep();
  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async e => { console.error(e); await sweep(); process.exit(1); });
