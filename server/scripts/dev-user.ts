/**
 * A DISPOSABLE STAFF LOGIN FOR LOCAL TESTING — created, proven, and removable.
 *
 *   npx tsx scripts/dev-user.ts                      → super_admin
 *   npx tsx scripts/dev-user.ts --role pro_officer    → to test role gating
 *   npx tsx scripts/dev-user.ts --delete              → remove it again
 *
 * This exists because the local database is a copy of real data: its super_admin is a real person's
 * account, and resetting a real passwordHash is unrecoverable — the old hash is gone. So testing
 * gets its own account instead, tagged, and deleted when the work is done.
 *
 * The password is random, written to LOCAL-LOGIN.txt (gitignored) and never printed, because this
 * runs in a terminal whose scrollback outlives the account.
 *
 * It REFUSES any database that is not on this machine. The guard is the host, not the name: the
 * local database here is called `stimespro_live`, so a name-based check would be no check at all.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth.js";

const EMAIL = "zz-disposable@example.invalid";
const NAME = "ZZ Disposable Login";
const OUT = resolve(import.meta.dirname, "../../LOCAL-LOGIN.txt");
const API = process.env.API_BASE || "http://localhost:4100";

const url = process.env.DATABASE_URL || "";
const host = url.match(/@([^:/?]+)/)?.[1] ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error(`REFUSED — DATABASE_URL points at "${host || "(unparseable)"}", not this machine.`);
  console.error("This creates a login with a known password. It only belongs on a local database.");
  process.exit(1);
}

const arg = (f: string) => process.argv.includes(f);
const roleArg = process.argv[process.argv.indexOf("--role") + 1];
const role = process.argv.includes("--role") && roleArg ? roleArg : "super_admin";

async function main() {
  if (arg("--delete")) {
    const { count } = await prisma.user.deleteMany({ where: { email: EMAIL } });
    writeFileSync(OUT, `The disposable login was deleted on ${new Date().toISOString()}.\n`);
    console.log(count ? `Deleted ${EMAIL}.` : `Nothing to delete — ${EMAIL} does not exist.`);
    return;
  }

  const password = randomBytes(12).toString("base64url");
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash, roleId: role, status: "active", failedLogins: 0, lockedUntil: null },
    create: { email: EMAIL, name: NAME, passwordHash, roleId: role, status: "active", type: "staff" },
  });

  // The check that matters: a login whose password does not work is worse than no login at all,
  // because the next person spends an hour blaming the password they were handed.
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  }).catch((e) => ({ ok: false, status: 0, text: () => String(e) }) as any);
  const proven = r.ok;
  if (!proven) console.error(`\nWARNING — the API refused this login (HTTP ${r.status}). ${await r.text()}`);

  writeFileSync(OUT, [
    "DISPOSABLE LOCAL LOGIN — not a real account, not on live.",
    "Gitignored. Delete the account with:  npx tsx scripts/dev-user.ts --delete",
    "",
    `  console   http://localhost:5188/dashboard`,
    `  email     ${EMAIL}`,
    `  password  ${password}`,
    `  role      ${role}`,
    "",
    `created   ${new Date().toISOString()}`,
    `login     ${proven ? "verified against the API" : `REFUSED by the API (HTTP ${r.status})`}`,
    "",
  ].join("\n"));

  console.log(`${proven ? "Created and login verified" : "Created but login FAILED"}: ${EMAIL} (${role}, id ${user.id})`);
  console.log(`Password written to ${OUT} — not printed here.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
