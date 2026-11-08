/**
 * A TOKEN FOR A CHECK, WITHOUT SPENDING A SIGN-IN.
 *
 * Imported by the checks that need to call the API as somebody. Not a script — see MODULES in
 * suite-manifest.ts.
 *
 * WHY THIS EXISTS — the measurement.
 *
 * `/api/auth/login` and `/api/auth/portal-login` are rate limited to 20 attempts per 15 minutes
 * per IP, which is the right number for a login form. 33 of the checks in this folder sign in, and
 * each one mints its OWN user on purpose — a PRO officer, an accountant, a portal user — because
 * what several of them are checking is that work reaches the right person. So they cannot share an
 * identity, and a full suite run asks for 33 sign-ins from one address and gets 429s.
 *
 * Measured: a clean run of the suite gave 71 pass / 25 fail, and every single failure was a
 * sign-in. `probe-suspend-lockout` reported "sign-in: ALLOWED (429)" — a check reading a rate-limit
 * refusal as a successful login, which is worse than failing.
 *
 * Caching one token does not help: 33 identities is 33 sign-ins however they are cached.
 *
 * SO THIS DOES NOT SIGN IN. It mints the token the same way the server does — the same
 * `signToken` from src/auth.ts, the same payload `doLogin` builds, the same secret — in process.
 * No request reaches an auth route, so nothing is rate limited, and every subsequent request still
 * carries a genuine signed token through the real middleware. The only step skipped is the password
 * comparison, which these checks are not about.
 *
 * WHAT MUST KEEP USING THE REAL ROUTE. Anything whose subject IS signing in: a wrong password being
 * refused, lockout after repeated failures, a suspended client losing portal access, a token
 * invalidated by a tokenVersion bump. Those have to go through the endpoint or they test nothing.
 * There are few enough of them to fit inside the 20 comfortably. If you are adding a check and
 * wondering which you need: if the assertion would still make sense with the password already
 * accepted, use this.
 *
 * IT REFUSES TO WORK ANYWHERE REAL. A function that mints a staff token for any user id is a back
 * door with a friendly name, so it is guarded on the host AND the database name — the same anchored
 * rule suite-run.ts and suite-seed.ts use. It cannot run against production (whose DATABASE_URL
 * names host `db` and database `stimespro`) and it cannot run against a local copy of live data.
 */
import { signToken } from "../src/auth.js";
import { isScratchDb, refusal } from "./_scratch-db.js";

type TokenUser = {
  id: string;
  type?: string | null;
  roleId?: string | null;
  companyId?: string | null;
  tokenVersion?: number | null;
};

let checked = false;
function assertScratch() {
  if (checked) return;
  // One rule, in _scratch-db.ts, shared with suite-seed and suite-run.
  const url = process.env.DATABASE_URL ?? "";
  if (!isScratchDb(url)) {
    throw new Error("_suite-auth: " + refusal(url,
      "This signs a valid session for any user id, so it is deliberately unusable anywhere else."));
  }
  checked = true;
}

/**
 * The token `doLogin` would have issued for this user.
 *
 * Mirrors src/index.ts: a portal user's token carries their companyId, a staff user's carries their
 * role, and both carry tokenVersion so a bump invalidates them exactly as it does a real session.
 */
export function tokenFor(user: TokenUser): string {
  assertScratch();
  if (!user?.id) throw new Error("_suite-auth: tokenFor needs a user with an id");
  return user.type === "portal"
    ? signToken({ sub: user.id, type: "portal", companyId: user.companyId ?? undefined, tv: user.tokenVersion ?? 0 })
    : signToken({ sub: user.id, type: "staff", role: user.roleId ?? "admin", tv: user.tokenVersion ?? 0 });
}

/** `Authorization` header for that user, since that is what every call site actually wants. */
export function authHeader(user: TokenUser): { Authorization: string } {
  return { Authorization: "Bearer " + tokenFor(user) };
}

/**
 * The same, by email — which is what the call sites can actually offer.
 *
 * Most of these checks hold an `EMAIL` constant rather than the row they just created, so looking
 * the user up here is what makes the replacement a one-liner everywhere instead of a different
 * edit per script. It throws rather than returning null: a check that silently proceeded without a
 * token would report the API refusing it as a finding about the feature.
 */
export async function tokenForEmail(email: string): Promise<string> {
  assertScratch();
  const { prisma } = await import("../src/db.js");
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, type: true, roleId: true, companyId: true, tokenVersion: true },
  });
  if (!user) throw new Error(`_suite-auth: no user ${email} — create it before asking for its token`);
  return tokenFor(user);
}
