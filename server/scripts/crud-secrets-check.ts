/**
 * THE API MUST NOT HAND OUT PASSWORD HASHES, AND MUST NOT ACCEPT THEM EITHER.
 *
 *   npx tsx scripts/crud-secrets-check.ts        (needs the API running on this database)
 *
 * `src/crud.ts` is the engine behind roughly a hundred routes, and it is the only large module in
 * the server that no check imports. Two of the things it does are the kind that are silently
 * correct for years and catastrophic the day they are not:
 *
 *   redact()   strips passwordHash, resetTokenHash, resetExpires, tokenVersion, failedLogins and
 *              lockedUntil from anything the API returns for a user. Without it, every bcrypt hash
 *              in the company is readable by any session allowed to list staff — and resetTokenHash
 *              is enough to take an account over while a reset is in flight.
 *   sanitize() drops those same fields from anything written, so nobody can set their own hash or
 *              reset their own lockout by PUTting a user.
 *
 * Neither is hard to break: adding a model to SECRET_FIELDS is easy to forget, and a well-meant
 * "return the whole row" refactor undoes redact() without touching it.
 *
 * Makes one disposable user and deletes it.
 */
import { prisma } from "../src/db.js";
import { tokenForEmail } from "./_suite-auth.js";
import { assertTarget } from "./_live-guard.js";

assertTarget("crud-secrets-check");

const API = process.env.SUITE_API ?? "http://localhost:4100";
const EMAIL = "zz-crud-secrets@example.invalid";
/** Recognisable on sight, so a leak in the output is unmistakable rather than a plausible hash. */
const HASH = "$2a$10$ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

let bad = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) bad++; };

const sweep = () => prisma.user.deleteMany({ where: { email: EMAIL } });

await sweep();
try {
  const made = await prisma.user.create({
    data: {
      name: "ZZ Crud Secrets", email: EMAIL, roleId: "pro_officer", status: "active", type: "staff",
      passwordHash: HASH, resetTokenHash: "zz-reset-token-hash", tokenVersion: 7,
    } as any,
  });

  const admin = await prisma.user.findFirst({
    where: { type: "staff", roleId: { in: ["admin", "super_admin"] }, status: "active" },
    select: { email: true },
  });
  if (!admin) throw new Error("no active admin to call the API as");
  const token = await tokenForEmail(admin.email);
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  console.log("what the API gives back about a user:");
  const listRes = await fetch(`${API}/api/users`, { headers: H });
  ok(listRes.ok, `GET /api/users answers (${listRes.status})`);
  const listText = await listRes.text();
  // Checked on the RAW text, not on a parsed field: a secret nested anywhere in the payload — in an
  // include, a count, an audit row — is just as leaked as one at the top level.
  ok(!listText.includes(HASH), "the list does not contain the password hash");
  ok(!listText.includes("zz-reset-token-hash"), "…nor the reset token hash");
  for (const f of ["passwordHash", "resetTokenHash", "resetExpires", "failedLogins", "lockedUntil"]) {
    ok(!listText.includes(`"${f}"`), `…nor a "${f}" field at all`);
  }
  // Deliberately readable — the console needs it to force a password change, and it reveals nothing.
  const rows = JSON.parse(listText);
  const mine = (Array.isArray(rows) ? rows : rows.items ?? []).find((u: any) => u.email === EMAIL);
  ok(!!mine, "…and the user is actually in the list, so the checks above had something to miss");
  ok(mine && "mustChangePassword" in mine, "mustChangePassword IS returned — the console needs it and it tells nobody anything");

  const oneRes = await fetch(`${API}/api/users/${made.id}`, { headers: H });
  if (oneRes.ok) {
    const oneText = await oneRes.text();
    ok(!oneText.includes(HASH) && !oneText.includes("zz-reset-token-hash"), "fetching the single user leaks nothing either");
  } else {
    ok(true, `single-user route is not exposed (${oneRes.status}) — nothing to leak`);
  }

  console.log("\nand what it refuses to be told:");
  const put = await fetch(`${API}/api/users/${made.id}`, {
    method: "PUT",
    headers: H,
    body: JSON.stringify({ name: "ZZ Crud Secrets", passwordHash: "$2a$10$ATTACKERCHOSENVALUE000000000000000000000000000000000", tokenVersion: 0, lockedUntil: null }),
  });
  ok(put.status < 500, `PUT /api/users/:id answers (${put.status})`);
  const after = await prisma.user.findUnique({ where: { id: made.id }, select: { passwordHash: true, tokenVersion: true } });
  // The whole point: the request may be accepted, but these fields must be untouched by it.
  ok(after?.passwordHash === HASH, "a password hash sent in the body did NOT become the user's password");
  ok(after?.tokenVersion === 7, "…and tokenVersion was not reset, so existing sessions stay invalidatable");
} finally {
  await sweep();
  await prisma.$disconnect();
}

console.log(bad ? `\n${bad} failed` : "\nall good");
process.exitCode = bad ? 1 : 0;
