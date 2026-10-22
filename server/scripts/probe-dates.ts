/**
 * Prove that a business date is the firm's day, not the server's.
 *
 * The container runs in UTC and Riyadh is UTC+3, so for the first three hours of every local day the
 * server's `toISOString().slice(0, 10)` named YESTERDAY. A payment recorded at 01:30 on the 1st was
 * dated the last day of the previous month — the previous VAT return.
 *
 * Four things are worth proving:
 *
 *   1. Inside the shifted window the business day is a day AHEAD of the UTC day. This is the bug.
 *   2. Outside it, the two agree — so this changed nothing about the rest of the day.
 *   3. A zone BEHIND UTC shifts the other way, because the fix must not be "add three hours".
 *   4. Day arithmetic stays exact across a month end and a leap day, and an unusable zone name is
 *      survivable rather than fatal — a bad setting must not break every date in the product.
 *
 * Pure functions. Touches nothing, needs no database.
 */
import { businessToday, businessZone, setBusinessZone, dayStart, addDays } from "../src/dates.js";

let bad = 0;
const fail = (msg: string) => { console.error(`  ✗ ${msg}`); bad++; };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const eq = (got: unknown, want: unknown, what: string) =>
  got === want ? ok(`${what} = ${got}`) : fail(`${what}: got ${got}, expected ${want}`);

const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);

function main() {
  console.log("Riyadh, in the three hours that used to be yesterday");
  setBusinessZone("Asia/Riyadh");
  eq(businessZone(), "Asia/Riyadh", "zone in use");
  // 01:30 on 1 August in Riyadh is 22:30 on 31 July in UTC. The old code dated this 2026-07-31.
  const earlyAug = "2026-07-31T22:30:00Z";
  eq(utcDay(earlyAug), "2026-07-31", "what the server clock said");
  eq(businessToday(new Date(earlyAug)), "2026-08-01", "what day it is in Riyadh");
  if (utcDay(earlyAug) === businessToday(new Date(earlyAug))) fail("the month boundary is still wrong");

  console.log("\nand the rest of the day is untouched");
  const midday = "2026-07-15T09:00:00Z";                          // 12:00 in Riyadh
  eq(businessToday(new Date(midday)), utcDay(midday), "midday agrees with UTC");
  const lateEvening = "2026-07-15T20:59:00Z";                      // 23:59 in Riyadh
  eq(businessToday(new Date(lateEvening)), "2026-07-15", "23:59 local is still the same day");
  eq(businessToday(new Date("2026-07-15T21:00:00Z")), "2026-07-16", "00:00 local is the next day");

  console.log("\na zone behind UTC shifts the other way");
  setBusinessZone("America/New_York");
  // 23:30 on 31 December in UTC is 18:30 on 31 December in New York — same day. But 00:30 on 1
  // January UTC is still 31 December there, which is the mirror of the Riyadh case.
  eq(businessToday(new Date("2027-01-01T00:30:00Z")), "2026-12-31", "New Year's Eve in New York");

  console.log("\nday arithmetic");
  setBusinessZone("Asia/Riyadh");
  eq(addDays("2026-01-31", 1), "2026-02-01", "across a month end");
  eq(addDays("2024-02-28", 1), "2024-02-29", "onto a leap day");
  eq(addDays("2026-03-01", -1), "2026-02-28", "backwards across a month end");
  eq(addDays("2026-07-15", 0), "2026-07-15", "no movement");
  eq(dayStart("2026-07-15"), Date.parse("2026-07-15T00:00:00Z"), "a day as a number");
  eq(dayStart("2026-07-15T13:45:00Z"), Date.parse("2026-07-15T00:00:00Z"), "a timestamp truncated to its day");

  console.log("\na bad zone name is survivable");
  setBusinessZone("Not/AZone");
  eq(businessZone(), "Asia/Riyadh", "an unusable zone is refused and the working one kept");
  setBusinessZone("");
  eq(businessZone(), "UTC", "an empty setting falls back to UTC");
  eq(businessToday(new Date(midday)), utcDay(midday), "…and then answers in UTC");

  console.log(bad === 0 ? "\nall good" : `\n${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
main();
