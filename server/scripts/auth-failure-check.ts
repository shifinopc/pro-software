/**
 * A FAILING DATABASE MUST NOT READ AS A REJECTED SESSION.
 *
 *   npx tsx scripts/auth-failure-check.ts
 *
 * requireAuth's catch-all answered 401, and the console treats any 401 as "your token is dead": it
 * wipes the token and shows the login screen. So one failed user lookup — a pool timeout while the
 * console fires its ~85 boot calls, with the hourly compliance scan on the same handful of
 * connections — signed people out of a session that was perfectly valid, seconds after they signed
 * in. The whole bug was one status code, which is exactly the kind of thing that gets "tidied" back.
 *
 * Both halves matter, so both are asserted: a broken database is 503, and a session that really is
 * refused is still 401. A fix that made everything 503 would be worse than the bug.
 */
import { signToken } from "../src/auth.js";
import { requireAuth } from "../src/auth.js";
import { prisma } from "../src/db.js";

// Enough of Express's res to see what was answered. Mutating prisma.user.findUnique works because
// every importer shares this one client object — the binding is frozen, the property is not.
const run = async (findUnique: any) => {
  const real = (prisma as any).user.findUnique;
  (prisma as any).user.findUnique = findUnique;
  let status = 0, body: any = null;
  const res: any = { status: (s: number) => { status = s; return res; }, json: (b: any) => { body = b; return res; } };
  const token = signToken({ sub: "whoever", type: "staff", role: "super_admin", companyId: null } as any);
  let nexted = false;
  try {
    await requireAuth({ headers: { authorization: "Bearer " + token } } as any, res, (() => { nexted = true; }) as any);
  } finally {
    (prisma as any).user.findUnique = real;
  }
  return { status, body, nexted };
};

const fail = (m: string) => { console.log("  FAIL  " + m); process.exitCode = 1; };

// The database is down.
const down = await run(async () => { throw new Error("P2024: Timed out fetching a new connection from the connection pool"); });
if (down.status === 503) console.log("  ok    database failure answers 503");
else fail(`a database failure answered ${down.status} — ${down.status === 401 ? "401 signs the user out of a valid session" : "expected 503"}`);
if (down.nexted) fail("the request was let through although the session could not be checked");

// The session really is refused: that is still a 401, or nothing is ever signed out.
const gone = await run(async () => null);
if (gone.status === 401) console.log("  ok    an unknown or inactive user still answers 401");
else fail(`an unknown user answered ${gone.status} — expected 401`);

// And a valid, active session passes.
const okUser = { id: "whoever", status: "active", tokenVersion: 0, type: "staff", companyId: null };
const good = await run(async () => okUser);
if (good.nexted && good.status === 0) console.log("  ok    a valid session is let through");
else fail(`a valid session answered ${good.status} instead of passing`);

await prisma.$disconnect();
console.log(process.exitCode ? "\nsomething regressed." : "\nin order.");
