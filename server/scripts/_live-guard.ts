/**
 * WHICH DATABASE THIS IS ABOUT TO REWRITE, SAID OUT LOUD.
 *
 * The tools in here change rows, and the obvious accident is running one against live while
 * thinking it is the local copy. Nothing in their output would tell you: the local database IS a
 * copy of live, so the same client names and the same document numbers come back either way.
 *
 * So a non-local database has to be named on the command line. `--live` is deliberately ugly and
 * lands in the shell history, which is where the record of a decision like that belongs — rather
 * than in whoever ran it remembering which terminal they were in.
 *
 * Checks only, writes nothing. Call it before the first query.
 */
export function assertTarget(toolName: string): { local: boolean; host: string } {
  const url = process.env.DATABASE_URL ?? "";
  const local = /@localhost|@127\.0\.0\.1/.test(url);
  const host = (/@([^/:]+)(?::\d+)?\//.exec(url) ?? [])[1] ?? "(no DATABASE_URL)";
  if (!local && !process.argv.includes("--live")) {
    console.error(`${toolName}: refusing — the database is at ${host}, which is not local.`);
    console.error("Pass --live as well if that is deliberate. Take a dump first.");
    process.exit(1);
  }
  if (!local) console.log(`!!  ${toolName} is running against ${host} — a NON-local database.\n`);
  return { local, host };
}
