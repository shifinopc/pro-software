/**
 * "IS THIS A DATABASE I AM ALLOWED TO WRECK?" — asked in one place.
 *
 * Three things in this folder need the answer and must never disagree about it: suite-seed.ts
 * wipes and rewrites configuration, suite-run.ts runs 124 checks that write, and _suite-auth.ts
 * signs a valid session for any user id. A copy of this rule in each was three places for it to
 * drift, and the drift would be silent until the day one of them said yes somewhere real.
 *
 * src/index.ts carries its own copy, deliberately — production code should not import from a dev
 * tooling folder — and scripts/auth-limit-gate-check.ts pins the two together so they cannot
 * diverge without the build failing.
 *
 * ANCHORED, NOT A SUBSTRING. The first version of this matched /(scratch|ci|test)/ anywhere in the
 * name, which would have accepted "precision", "practice" and "latest". A guard that errs towards
 * permitting is not a guard. A trailing number is allowed because `stimespro_ciscratch2` is an
 * obviously disposable name and refusing it taught people to work around the check instead.
 */

/** The name rule on its own, exported so src/index.ts's copy can be compared against it. */
export const SCRATCH_NAME = /(^|_)(scratch|ci|test)\d*$|scratch\d*$|_(ci|test)_/i;

/** A DATABASE_URL that is both local AND obviously disposable. */
export function isScratchDb(url: string | undefined): boolean {
  const u = url ?? "";
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(u)) return false;
  return SCRATCH_NAME.test(dbNameOf(u));
}

/** The database name out of a connection URL, without the query string. */
export function dbNameOf(url: string | undefined): string {
  return ((url ?? "").split("/").pop() ?? "").split("?")[0];
}

/** The refusal these three print, so the wording is the same wherever it comes from. */
export function refusal(url: string | undefined, whatItWouldDo: string): string {
  const name = dbNameOf(url);
  if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url ?? "")) {
    return `refusing: DATABASE_URL is not on localhost. ${whatItWouldDo}`;
  }
  return `refusing: "${name}" does not look like a scratch database.\n  ${whatItWouldDo}\n` +
    `  Name it so it cannot be mistaken for anything else — e.g. stimespro_ciscratch.`;
}
