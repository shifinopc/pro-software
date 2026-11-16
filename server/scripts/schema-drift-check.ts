/**
 * DOES THE LIVE DATABASE STILL MATCH THE SCHEMA FILE?
 *
 *   npx tsx scripts/schema-drift-check.ts            # against $DATABASE_URL
 *
 * This project applies its schema with `prisma db push` on every container start, and keeps no
 * migration history. That is a deliberate choice and the runbook explains it — but it has one cost
 * nothing else covers: there is no record of what the database looks like. Nobody can answer "when
 * did this column appear?", and a column or index added by hand on the server is invisible forever.
 *
 * `prisma migrate diff` answers the only question that matters here — is the live database still
 * what `schema.prisma` describes? Silence means yes.
 *
 * RUN IT BEFORE AND AFTER A DEPLOY. Before, so a surprise is found while the old code still works;
 * after, so you know the push did what you expected. DEPLOY.md lists it in both places.
 *
 * READ-ONLY. `migrate diff` compares and prints; it never writes.
 */
import { execFileSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("DATABASE_URL is not set — nothing to compare against.");
  process.exit(2);
}

// Host and database only. The password is in this string and must not reach a log or a CI record.
const shown = (() => {
  try { const u = new URL(url); return `${u.hostname}/${u.pathname.replace(/^\//, "")}`; }
  catch { return "(unparseable DATABASE_URL)"; }
})();
console.log(`comparing ${shown} against prisma/schema.prisma\n`);

let out = "";
try {
  out = execFileSync("npx", [
    "prisma", "migrate", "diff",
    "--from-url", url,
    "--to-schema-datamodel", "prisma/schema.prisma",
    "--script",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
} catch (e: any) {
  console.log("could not compare:", String(e?.stderr || e?.message || e).slice(0, 400));
  process.exit(2);
}

/**
 * An empty diff prints a comment and nothing else. Prisma's wording has changed between versions,
 * so this looks for statements rather than for a sentence: if there is no SQL, there is no drift.
 */
const statements = out
  .split("\n")
  .map(l => l.trim())
  .filter(l => l && !l.startsWith("--") && !l.startsWith("/*") && !l.startsWith("*"));

if (statements.length === 0) {
  console.log("  ok   the database matches the schema file");
  process.exit(0);
}

console.log(`  DRIFT  ${statements.length} statement(s) would be needed to bring the database up to the schema file:\n`);
for (const l of statements.slice(0, 40)) console.log("    " + l);
if (statements.length > 40) console.log(`    … and ${statements.length - 40} more`);
console.log(`
What this means: the database and schema.prisma disagree. Either a deploy has not pushed yet —
normal BEFORE a release, and these are the changes it will make — or something changed the
database outside this repo, which is the case worth stopping for.

This does not apply anything. The entrypoint's own \`prisma db push\` does that on the next start.`);
process.exit(1);
