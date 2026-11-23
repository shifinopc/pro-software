/**
 * Writes the client-work report HTML to a file, from the SAME builder the route uses.
 *
 * It exists because the one thing that breaks this document cannot be seen in the HTML: LibreOffice
 * swallows the first block element of <body> and replaces it with a page break, which is how a
 * report shipped with a blank first page and no firm name on it. There is no LibreOffice on the
 * Windows dev box, so the loop is: run this, copy the file to the server, convert it there, and
 * check `pdfinfo` says 1 page and `pdftotext` shows the letterhead.
 *
 *   npx tsx scripts/client-report-pdf-check.ts [out.html]
 *
 * Reads nothing from the database and writes nothing to it.
 */
import { clientReportHtml } from "../src/clientwork.js";
import fs from "node:fs";

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const line = (person: string, num: string, exp: string, detail: string, at: string, after?: [string, string]) => ({
  caseTitle: "Iqama renewal — " + person, person, docType: "Iqama",
  beforeNumber: num, beforeExpiry: exp,
  afterNumber: after ? after[0] : null, afterExpiry: after ? after[1] : null,
  at, detail,
});

const html = clientReportHtml({
  org: {
    legalName: "STIMES PRO Business Services LLC",
    address: "King Fahd Road, Al Olaya, Riyadh 12345, Kingdom of Saudi Arabia",
    vatNumber: "300123456700003", crNumber: "1010123456",
    phone: "+966 11 000 0000", email: "info@stimespro.com",
  },
  client: "PRO DESK Company",
  from: "2026-11-01", to: "2026-11-30",
  S: { totals: { cases: 1, casesClosed: 0, steps: 3, tasks: 0 } },
  D: {
    completed: [line("MUHAMMED SHANVEEL NAITHRAM VEETIL", "2623312549", "2026-11-27",
      "Issue Work Permit, Payment for Jawazat, Check Traffic / Other Violations", "2026-11-23",
      ["2623312549", "2027-11-27"])],
    pending: [
      line("MUHAMMED SHANVEEL NAITHRAM VEETIL", "2623312549", "2026-11-27", "Waiting on: Renew Iqama", "2026-11-23"),
      line("NAJEEB RAHIMAN VETTIKKATTIL", "2596068904", "2027-01-07", "Waiting on: Issue Work Permit", "2026-11-23"),
      line("SHABEEB KUDIKKIL PUTHIRIKANDAM", "2386010405", "2026-10-14", "Waiting on: Issue Work Permit", "2026-11-23"),
    ],
  },
  esc, logoImg: "",
});

// The page break is invisible in the HTML; what is checkable here is the rule that avoids it.
const bodyStartsWithTable = /<body>\s*<table/.test(html);
if (!bodyStartsWithTable) {
  console.error("FAIL: <body> must open with <table> or LibreOffice eats the first element");
  process.exit(1);
}
const out = process.argv[2] ?? "client-report-sample.html";
fs.writeFileSync(out, html);
console.log("ok: body opens with <table>;", html.length, "bytes written to", out);
