/**
 * WHICH ADDRESS THE AUDIT LOG RECORDS.
 *
 *   npx tsx scripts/client-ip-check.ts
 *
 * A pure function, so this needs no database and no running API. It is here because the thing it
 * guards is invisible until somebody needs it: for months every `login.success` recorded a
 * Cloudflare datacentre instead of the person, and nothing failed — the column was simply wrong,
 * and no screen was ever going to say so.
 */
import { clientIp } from "../src/auth.js";

let failures = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "  ok  " : "  FAIL"} ${what}`); if (!cond) failures++; };

/** Just enough of a request for the function under test. */
const req = (headers: Record<string, string>, remote = "172.18.0.10") =>
  ({ headers, socket: { remoteAddress: remote } }) as any;

const CF = "cf-connecting-ip", XFF = "x-forwarded-for";

console.log("behind Cloudflare:");
ok(clientIp(req({ [CF]: "49.47.197.234", [XFF]: "162.158.22.88" })) === "49.47.197.234",
  "the person's address wins over the edge that proxied them");
ok(clientIp(req({ [CF]: "49.47.197.234, 162.158.22.88" })) === "49.47.197.234",
  "a comma list takes the first entry");
ok(clientIp(req({ [CF]: "  49.47.197.234  " })) === "49.47.197.234", "surrounding space is trimmed");

console.log("without it, nothing changes:");
ok(clientIp(req({ [XFF]: "49.47.197.234, 10.0.0.1" })) === "49.47.197.234",
  "x-forwarded-for still answers when Cloudflare is not in front");
ok(clientIp(req({})) === "172.18.0.10", "and the socket answers when neither header is set");

// An empty header is what a misconfigured proxy sends, and it used to win by being present.
// Recording "" as somebody's address is worse than recording the proxy's.
console.log("what must not win:");
ok(clientIp(req({ [CF]: "", [XFF]: "49.47.197.234" })) === "49.47.197.234", "an empty cf header falls through");
ok(clientIp(req({ [CF]: "   ", [XFF]: "49.47.197.234" })) === "49.47.197.234", "so does a blank one");
ok(clientIp(req({ [CF]: ",,", [XFF]: "49.47.197.234" })) === "49.47.197.234", "so does a list of nothing");
ok(clientIp(req({ [XFF]: "" }, "172.18.0.10")) === "172.18.0.10", "an empty x-forwarded-for falls through too");
// Built by hand rather than through req(): passing `undefined` for the address would pick up the
// helper's default and quietly test the opposite of what this line claims.
ok(clientIp({ headers: {}, socket: {} } as any) === null,
  "and with nothing at all it is null, not a string saying so");

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(failures ? 1 : 0);
