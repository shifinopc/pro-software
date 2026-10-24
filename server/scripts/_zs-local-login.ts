/**
 * A throwaway staff login for the LOCAL copy of live data.
 *
 * The copy carries the real accounts and their real password hashes, and none of those passwords
 * are mine to use or to reset — overwriting one is unrecoverable, the old hash is gone. So this
 * ADDS an account instead, clearly named, and removes it again.
 *
 *   npx tsx scripts/_zs-local-login.ts create
 *   npx tsx scripts/_zs-local-login.ts clean
 *
 * REFUSES TO RUN against a database that is not obviously a local copy, because the one thing this
 * script must never do is add a back door to production.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../src/db.js";

const EMAIL = "zs-local-probe@example.invalid";
const PASSWORD = "ZsLocalProbe!2026";

function guard() {
  const url = String(process.env.DATABASE_URL ?? "");
  const host = url.split("@")[1] ?? "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])/.test(host)) {
    console.error(`\nRefusing to run: DATABASE_URL does not point at localhost (${host.split("/")[0]}).\n`);
    process.exit(2);
  }
}

async function clean() {
  const { count } = await prisma.user.deleteMany({ where: { email: EMAIL } });
  console.log(`removed ${count} probe login(s)`);
}

async function create() {
  await clean();
  const u = await prisma.user.create({ data: {
    name: "ZS Local Probe", email: EMAIL, roleId: "admin", status: "active", type: "staff",
    passwordHash: await bcrypt.hash(PASSWORD, 10),
  } });
  console.log(`created ${u.email} / ${PASSWORD} (admin, local copy only)`);
}

guard();
(process.argv[2] === "clean" ? clean() : create())
  .then(() => prisma.$disconnect())
  .catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
