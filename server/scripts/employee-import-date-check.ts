/**
 * WHICH DATE A TWO-DIGIT YEAR MEANS — the import's own rule, checked.
 *
 * A real client file arrived as "19-02-92", "12-01-26", "27-04-27": DD-MM-YY, which the importer
 * refused outright, so three people came in with no birthday, no joining date and no documents.
 * Reading them means choosing a century, and choosing it wrongly is worse than refusing — a
 * work permit filed as expiring in 1927 is a renewal nobody is ever reminded about.
 *
 *   npx tsx scripts/employee-import-date-check.ts
 */
import { isoDate } from "../src/employee-import.js";

const now = new Date().getFullYear();
let bad = 0;
const is = (got: string | null, want: string | null, what: string) => {
  const ok = got === want;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `  — wanted ${want}, got ${got}`}`);
  if (!ok) bad++;
};

console.log("\nthe file that started this:");
is(isoDate("19-02-92", "past").iso, "1992-02-19", "19-02-92 as a birthday is 1992");
is(isoDate("12-01-26").iso, "2026-01-12", "12-01-26 is 2026");
is(isoDate("27-04-27").iso, "2027-04-27", "27-04-27 is 2027");
is(isoDate("07-06-27").iso, "2027-06-07", "07-06-27 is 2027");

console.log("\nthe century, by nearness:");
is(isoDate("01/01/99").iso, "1999-01-01", "99 is the recent past, not 2099");
is(isoDate("01/01/05").iso, "2005-01-01", "05 is this century");
is(isoDate("31.12.30").iso, "2030-12-31", "a date four years out is next decade, not 1930");

console.log("\nand by what the field can be:");
is(isoDate("01/01/68", "past").iso, "1968-01-01", "an employee born in 1968, not 2068");
is(isoDate("01/01/68").iso, String(now - 1968 < 2068 - now ? 1968 : 2068) + "-01-01", "the same digits on an expiry take the nearer year");

console.log("\nwhat already worked still works:");
is(isoDate("06/10/1994").iso, "1994-10-06", "four-digit years are untouched");
is(isoDate("2024-03-01").iso, "2024-03-01", "ISO passes through");
is(isoDate("").iso, null, "blank is blank, not an error");
is(isoDate("none").iso, null, '"none" means there is none');

console.log("\nand what must still be refused:");
is(isoDate("19-13-92").iso, null, "month 13 is not a month");
is(isoDate("32/01/26").iso, null, "day 32 is not a day");
is(isoDate("19 Feb 92").iso, null, "a month in words is not guessed at");
is(isoDate("1992").iso, null, "a year on its own is not a date");

console.log(`\nfailures: ${bad}`);
process.exit(bad ? 1 : 0);
