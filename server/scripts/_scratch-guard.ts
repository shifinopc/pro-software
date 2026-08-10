/**
 * Refuse to run a pack probe against a database that holds real configuration.
 *
 * WHY THIS EXISTS
 *
 * The pack probes install, adopt, upgrade and uninstall whole country packs. Against a scratch
 * database that is exactly what they should do. Against the WORKING database they quietly rewrite
 * the provenance of the firm's real configuration — packKey, packVersion, packModified — which
 * decides what a future uninstall deletes and what a future upgrade overwrites. Nothing looks
 * broken afterwards; the damage only shows up the next time somebody presses Uninstall.
 *
 * That already happened here: a run against the working database left every Saudi workforce band
 * duplicated and a probe's invented document type sitting in the live configuration.
 *
 * A comment in a header cannot stop anybody, so this does. Imported by every probe that writes pack
 * provenance — one definition, so a new pack probe cannot quietly be written without it.
 */
import { prisma } from "../src/db.js";

/**
 * `seed` says what the probe needs INSIDE its scratch database, because the two kinds are not
 * interchangeable and getting it wrong produces failures that look like product bugs:
 *
 *   "empty" — an install/upgrade probe, which builds its own world from a pack.
 *   "copy"  — a probe whose whole premise is an existing hand-built configuration, so an empty
 *             database gives it nothing to adopt and every assertion fails for the wrong reason.
 */
export async function requireScratchDatabase(what: string, seed: "empty" | "copy" = "empty") {
  const url = String(process.env.DATABASE_URL ?? "");
  const dbName = url.split("/").pop()?.split("?")[0] ?? "";
  if (/scratch|test|tmp/i.test(dbName)) return;

  const [types, companies] = await Promise.all([prisma.documentType.count(), prisma.company.count()]);
  const how = seed === "copy"
    ? `    mysqldump -u… ${dbName} > /tmp/copy.sql\n` +
      `    npx tsx -e "import {prisma} from './src/db.js'; await prisma.$executeRawUnsafe('CREATE DATABASE stimespro_scratch'); await prisma.$disconnect()"\n` +
      `    mysql -u… stimespro_scratch < /tmp/copy.sql\n`
    : `    npx tsx -e "import {prisma} from './src/db.js'; await prisma.$executeRawUnsafe('CREATE DATABASE stimespro_scratch'); await prisma.$disconnect()"\n` +
      `    DATABASE_URL="mysql://…@localhost:3306/stimespro_scratch" npx prisma db push --skip-generate\n`;

  console.log(
    `\n${what} rewrites country-pack provenance on every configuration row it touches, so it needs a\n` +
    `database of its own — ${seed === "copy" ? "a COPY of this one" : "a FRESH empty one"}. It does not clean up after itself.\n\n` +
    `  DATABASE_URL points at "${dbName}", which holds ${types} document types and ${companies} companies.\n\n` +
    `  Prepare one and point at it:\n` + how +
    `    DATABASE_URL="mysql://…@localhost:3306/stimespro_scratch" npx tsx scripts/<probe>.ts\n`
  );
  await prisma.$disconnect();
  process.exit(2);
}
