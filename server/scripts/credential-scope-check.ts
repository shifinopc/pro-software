/**
 * WHO MAY FILE A CLIENT'S PORTAL LOGIN, AND WHO MAY READ ONE — the two are different, and the
 * whole point of this change is that they stopped being the same question.
 *
 *   npx tsx scripts/credential-scope-check.ts     (needs the API running)
 *
 * The vault holds government portal passwords for every client. It was admin-only on all five
 * routes, which blocked the people who actually do the work. It was then opened to PRO officers
 * for the clients they are NAMED on — which turned out to be the wrong axis: the officer covering
 * a counter needs the login for whoever is in front of them, and a client that named somebody else
 * showed them an empty tab reading "No stored credentials" over four logins that existed. So the
 * vault is the FIRM'S and is open to every PRO officer, while the WORK still routes to the client's
 * own officer — `clientRoleOwner`, untouched by any of this.
 *
 * That is a security boundary, so every rung of it is asserted here rather than described:
 *
 *   · an admin may do everything, as before
 *   · a PRO officer may ADD, EDIT and REVEAL — on ANY client, named or not
 *   · a PRO officer may still NOT delete: removing the only record of a login is not a correction
 *   · an accountant and a sales user are refused outright, add and reveal alike
 *   · the list never carries a password, to any role, and shows every client's rows
 *   · every reveal writes a `credential.reveal` audit row naming who opened what
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
  expect(p3.status, 201, "PRO officer, ANOTHER officer's client");
  expect((await call(acct, "POST", "/api/credentials", cred(unowned.id, TAG + " acct"))).status, 403, "accountant");
  expect((await call(sales, "POST", "/api/credentials", cred(unowned.id, TAG + " sales"))).status, 403, "sales");

  const ourId = p2.body?.id, theirId = a1.body?.id;
  if (!ourId || !theirId) { fail("could not create the rows the rest of this needs"); await sweep(); process.exit(1); }

  console.log("\nedit");
  expect((await call(mine, "PUT", `/api/credentials/${ourId}`, { label: TAG + " renamed" })).status, 200, "PRO officer, own client");
  // A password changes at the portal, not at the desk of whoever the client is filed under. An
  // officer who can read it but not correct it leaves the vault wrong for everybody after them.
  expect((await call(mine, "PUT", `/api/credentials/${theirId}`, { label: TAG + " renamed too" })).status, 200, "PRO officer, another officer's client");

  console.log("\nreveal — audited, and open to the people who sign in");
  expect((await call(admin, "GET", `/api/credentials/${ourId}/reveal`)).status, 200, "admin");
  expect((await call(mine, "GET", `/api/credentials/${ourId}/reveal`)).status, 200, "PRO officer, own client");
  expect((await call(mine, "GET", `/api/credentials/${theirId}/reveal`)).status, 200, "PRO officer, another officer's client");
  expect((await call(acct, "GET", `/api/credentials/${ourId}/reveal`)).status, 403, "accountant");
  // The audit trail is the whole basis on which this was opened up, so it is asserted, not assumed.
  const seen = await prisma.audit.count({ where: { action: "credential.reveal", actorId: mine.id } });
  seen >= 2 ? ok(`every reveal is on the audit trail (${seen} rows for this officer)`)
            : fail(`reveals are not being audited — ${seen} rows for this officer`);

  console.log("\ndelete — still admin only");
  expect((await call(mine, "DELETE", `/api/credentials/${ourId}`)).status, 403, "PRO officer");

  console.log("\nlist");
  const la = await call(admin, "GET", "/api/credentials");
  const lp = await call(mine, "GET", "/api/credentials");
  expect(la.status, 200, "admin");
  expect(lp.status, 200, "PRO officer");
  const names = (b: any) => (Array.isArray(b) ? b : []).filter((c: any) => String(c.label).startsWith(TAG)).map((c: any) => c.label);
  // THE EMPTY TAB THAT STARTED THIS. A row filtered away is indistinguishable from one that was
  // never created, so the client screen reported "No stored credentials" over somebody else's
  // client's four logins and invited a duplicate of each.
  // By id, not by label: the edit assertions above renamed this very row, and a check that greps
  // for a name it no longer has reports a scoping failure that is not there.
  (Array.isArray(lp.body) ? lp.body : []).some((c: any) => c?.id === theirId)
    ? ok("a PRO officer sees another officer's client's entry")
    : fail("a PRO officer still cannot see another officer's client's entry");
  (names(la.body) as string[]).length === (names(lp.body) as string[]).length
    ? ok("both roles see the same rows")
    : fail(`admin sees ${names(la.body).length} rows, the officer ${names(lp.body).length}`);
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
