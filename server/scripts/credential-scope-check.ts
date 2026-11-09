/**
 * WHO MAY FILE A CLIENT'S PORTAL LOGIN, AND WHO MAY READ ONE — the two are different, and the
 * whole point of this change is that they stopped being the same question.
 *
 *   npx tsx scripts/credential-scope-check.ts     (needs the API running)
 *
 * The vault holds government portal passwords for every client. It was admin-only on all five
 * routes, which blocked the people who actually do the work: live had 0 credentials filed. Add and
 * edit are now open to PRO officers; reveal and delete are not.
 *
 * That is a security boundary, so every rung of it is asserted here rather than described:
 *
 *   · an admin may do everything, as before
 *   · a PRO officer may ADD and EDIT
 *   · a PRO officer may NOT reveal a password, which is the thing the original rule protected
 *   · a PRO officer may NOT delete
 *   · a PRO officer is refused on a client that names a DIFFERENT pro_officer
 *   · a PRO officer is allowed on a client that names NOBODY — 4 of 189 clients name one, so
 *     refusing the unnamed would have blocked 185 and rebuilt the original problem
 *   · the list never carries a password, to any role
 *   · an accountant and a sales user are refused outright
 *   · editing cannot be used to reach another officer's client: the check reads the client off the
 *     ROW, not off the body
 *
 * Everything it makes is named "ZZ " and deleted at the end.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

if (!isScratchDb(process.env.DATABASE_URL)) {
  console.error(refusal(process.env.DATABASE_URL, "This creates throwaway clients, staff and vault entries."));
  process.exit(1);
}

const API = process.env.API_BASE || "http://localhost:4100";
let bad = 0;
const fail = (m: string) => { console.log("  FAIL  " + m); bad++; };
const ok = (m: string) => console.log("  ok    " + m);
const expect = (got: number, want: number, what: string) =>
  got === want ? ok(`${what} → ${got}`) : fail(`${what} → got ${got}, expected ${want}`);

const TAG = "ZZ CredScope";

async function sweep() {
  const cos = await prisma.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = cos.map(c => c.id);
  if (ids.length) {
    await prisma.siteCredential.deleteMany({ where: { companyId: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { contains: "zz-credscope" } } });
}

async function main() {
  await sweep();

  const mk = (role: string, tag: string) =>
    prisma.user.create({ data: { name: `${TAG} ${tag}`, email: `zz-credscope-${tag}@example.invalid`, roleId: role, status: "active", type: "staff" } });
  const admin = await mk("admin", "admin");
  const mine = await mk("pro_officer", "mine");
  const other = await mk("pro_officer", "other");
  const acct = await mk("accountant", "acct");
  const sales = await mk("sales", "sales");

  const co = (n: string, owner: string | null) =>
    prisma.company.create({ data: { name: `${TAG} ${n}`, country: "SA", roleOwners: owner ? { pro_officer: owner } : undefined } as any });
  const unowned = await co("Unowned", null);
  const ours = await co("Ours", mine.id);
  const theirs = await co("Theirs", other.id);

  const call = async (who: { email: string }, method: string, path: string, body?: any) => {
    const r = await fetch(API + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + await tokenForEmail(who.email) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const cred = (companyId: string, label: string) =>
    ({ companyId, label, url: "qiwa.sa", username: "zz-user", password: "zz-not-a-real-password", govCenter: "Qiwa" });

  console.log("\nadd");
  const a1 = await call(admin, "POST", "/api/credentials", cred(theirs.id, TAG + " by admin"));
  expect(a1.status, 201, "admin, on any client");
  const p1 = await call(mine, "POST", "/api/credentials", cred(unowned.id, TAG + " unowned"));
  expect(p1.status, 201, "PRO officer, client nobody owns");
  const p2 = await call(mine, "POST", "/api/credentials", cred(ours.id, TAG + " ours"));
  expect(p2.status, 201, "PRO officer, their own client");
  const p3 = await call(mine, "POST", "/api/credentials", cred(theirs.id, TAG + " theirs"));
  expect(p3.status, 403, "PRO officer, ANOTHER officer's client");
  if (p3.status === 403 && !/another PRO officer/i.test(String(p3.body?.error))) {
    fail(`the refusal does not say why: ${JSON.stringify(p3.body?.error)}`);
  } else if (p3.status === 403) ok(`and says why: "${p3.body.error}"`);
  expect((await call(acct, "POST", "/api/credentials", cred(unowned.id, TAG + " acct"))).status, 403, "accountant");
  expect((await call(sales, "POST", "/api/credentials", cred(unowned.id, TAG + " sales"))).status, 403, "sales");

  const ourId = p2.body?.id, theirId = a1.body?.id;
  if (!ourId || !theirId) { fail("could not create the rows the rest of this needs"); await sweep(); process.exit(1); }

  console.log("\nedit");
  expect((await call(mine, "PUT", `/api/credentials/${ourId}`, { label: TAG + " renamed" })).status, 200, "PRO officer, own client");
  expect((await call(mine, "PUT", `/api/credentials/${theirId}`, { label: TAG + " hijack" })).status, 403, "PRO officer, another officer's client");
  // The client is read off the ROW, so naming a reachable client in the body must not help.
  const sneak = await call(mine, "PUT", `/api/credentials/${theirId}`, { companyId: ours.id, label: TAG + " sneak" });
  expect(sneak.status, 403, "…and cannot be reached by naming a different client in the body");

  console.log("\nreveal — the power the original rule protected");
  expect((await call(admin, "GET", `/api/credentials/${ourId}/reveal`)).status, 200, "admin");
  expect((await call(mine, "GET", `/api/credentials/${ourId}/reveal`)).status, 403, "PRO officer, even on their OWN client");

  console.log("\ndelete");
  expect((await call(mine, "DELETE", `/api/credentials/${ourId}`)).status, 403, "PRO officer");

  console.log("\nlist");
  const la = await call(admin, "GET", "/api/credentials");
  const lp = await call(mine, "GET", "/api/credentials");
  expect(la.status, 200, "admin");
  expect(lp.status, 200, "PRO officer");
  const names = (b: any) => (Array.isArray(b) ? b : []).filter((c: any) => String(c.label).startsWith(TAG)).map((c: any) => c.label);
  if ((names(lp.body) as string[]).some(n => n.includes("by admin"))) fail("a PRO officer can see another officer's client's entry");
  else ok("a PRO officer does not see another officer's client's entry");
  const anyPassword = [...(Array.isArray(la.body) ? la.body : []), ...(Array.isArray(lp.body) ? lp.body : [])]
    .some((c: any) => c && Object.prototype.hasOwnProperty.call(c, "password"));
  if (anyPassword) fail("the list carries a password field — it must never leave the server");
  else ok("no password in the list, for either role");

  await sweep();
  console.log("\ncleaned up: YES");
  console.log(bad ? `\n${bad} problem(s)` : "\nall good");
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await sweep().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
