/**
 * Import leads from a spreadsheet, and hand out the template they should be typed into.
 *
 * A list of leads arrives as a spreadsheet — from an exhibition, a bought list, a colleague's
 * notebook — and until now the only way in was the Add lead form, one at a time.
 *
 * IT IS A TWO-STEP OPERATION, like the employee import it is modelled on. `planLeadImport` reads
 * the file and says what would happen, writing nothing; `applyLeadImport` does it. Nobody should
 * discover after importing three hundred rows that the Product column was ignored.
 *
 * IT DOES NOT KNOW HOW TO CREATE A LEAD, AND THAT IS THE POINT.
 *
 * Creating one is not `company.create`. It is validation, the contact rules, owner routing through
 * the sales rules, the lifecycle history row, the assignment history row with its reason, and the
 * activity line — all of it already written, in POST /api/companies, and all of it easy to
 * half-copy. So apply posts each row to that route, in process. A rule added there tomorrow applies
 * to imports without anybody remembering this file exists, and a lead typed in by hand and a lead
 * imported are the same object by construction rather than by inspection.
 *
 * THE TEMPLATE IS SERVED FROM HERE for the same reason. The employee template is built in the
 * browser from its own copy of the column list, and the two can drift — which is why there is a
 * check script whose whole job is to notice. One list, written once, is cheaper than a guard.
 */
import type { Express, Request } from "express";
import { parseCsv } from "./employee-import.js";
import { duplicateIndex, type DuplicateMatch } from "./duplicates.js";
import { runInProcess } from "./boot.js";
import { publish } from "./realtime.js";
import { prisma } from "./db.js";

/** The columns the template offers, in order — and the only ones read. */
export const LEAD_IMPORT_COLUMNS = [
  "company_name", "contact_name", "job_title", "email", "phone",
  "source", "city", "industry", "product", "campaign", "note",
] as const;

/**
 * ONE example row, not three.
 *
 * Three rows teach the format no better and invite the mistake the employee template keeps
 * producing: somebody edits the examples instead of replacing them. One row is unmistakably a
 * sample, and the example.invalid address is one that cannot reach a real person if it is.
 */
export const LEAD_EXAMPLE_ROW: Record<string, string> = {
  company_name: "Al Noor Contracting Est",
  contact_name: "Faisal Al Otaibi",
  job_title: "Operations Manager",
  email: "faisal@alnoor-contracting.example",
  phone: "+966 55 123 4567",
  source: "Exhibition",
  city: "Riyadh",
  industry: "Construction",
  // TWO PRODUCTS, not one. A lead wanting PRO and VAT is the ordinary case, and the only place
  // anybody learns that one cell can hold both is here. The commas are also why the cell is quoted
  // in the file, which is the other thing the example has to show.
  product: "PRO, VAT",
  campaign: "Riyadh Build 2026",
  note: "Met at stand 4B — 40 staff, renewals due in March",
};

const MAX_ROWS = 1000;

/** Column names people actually use, mapped to the ones this reads. */
const ALIAS: Record<string, string> = {
  company: "company_name", name: "company_name", client: "company_name", lead: "company_name",
  "company name": "company_name", organisation: "company_name", organization: "company_name",
  contact: "contact_name", person: "contact_name", "contact person": "contact_name",
  title: "job_title", designation: "job_title", position: "job_title",
  "e-mail": "email", mail: "email", "email address": "email",
  mobile: "phone", telephone: "phone", tel: "phone", "phone number": "phone", whatsapp: "phone",
  "lead source": "source", channel: "source",
  service: "product", "service required": "product", interest: "product", requirement: "product",
  town: "city", location: "city", sector: "industry",
  remarks: "note", notes: "note", comment: "note", details: "note",
};

const clean = (v: unknown) => String(v ?? "").trim();
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A configured list, or nothing at all — a template must not fail because a table is empty. */
const names = async (q: () => Promise<Array<{ name: string }>>) =>
  (await q().catch(() => [])).map(r => clean(r.name)).filter(Boolean);

/**
 * The file the Template button hands out — the headings, then the single example.
 *
 * THE EXAMPLE USES THIS INSTALL'S OWN PRODUCTS AND SOURCES where it has them. A sample naming
 * products nobody has configured teaches the wrong words and then warns about them on the way back
 * in, which makes the template look broken the first time it is used. It falls back to the literals
 * when nothing is configured yet, because a template must still download on a new install.
 */
export async function leadImportTemplateCsv(): Promise<string> {
  const products = await names(() => prisma.product.findMany({ select: { name: true }, orderBy: { name: "asc" } }));
  const sources = await names(() => prisma.leadSource.findMany({ select: { name: true } }));
  const example: Record<string, string> = {
    ...LEAD_EXAMPLE_ROW,
    // Two of them, so the example still shows that one cell can hold several.
    ...(products.length ? { product: products.slice(0, 2).join(", ") } : {}),
    ...(sources.length ? { source: sources[0] } : {}),
  };
  const head = LEAD_IMPORT_COLUMNS.join(",");
  const row = LEAD_IMPORT_COLUMNS.map(c => csvCell(example[c] ?? "")).join(",");
  // The BOM is what makes Excel read it as UTF-8; without it an Arabic name arrives as mojibake.
  return `﻿${head}\n${row}\n`;
}

export type LeadIssue = { row: number; name: string; what: string };
export type LeadPlanRow = {
  row: number;
  name: string;
  body: Record<string, unknown>;
  /** What the preview shows about this row, in the words the reader needs. */
  contact: string;
  source: string;
  product: string;
  duplicate: DuplicateMatch | null;
};
export type LeadPlan = {
  rowsRead: number;
  creates: number;
  skipped: LeadIssue[];
  refused: LeadIssue[];
  warnings: LeadIssue[];
  rows: LeadPlanRow[];
  unknownColumns: string[];
};

const looksLikeEmail = (v: string) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const looksLikePhone = (v: string) => !v || /^[+()\d][\d\s()+.-]{5,}$/.test(v);

export async function planLeadImport(csvText: string): Promise<LeadPlan> {
  const grid = parseCsv(csvText.replace(/^﻿/, ""));
  if (!grid.length) throw new Error("That file is empty.");

  const header = grid[0].map(h => {
    const k = clean(h).toLowerCase().replace(/\s+/g, " ");
    return ALIAS[k] ?? k.replace(/\s+/g, "_");
  });
  if (!header.includes("company_name")) {
    throw new Error(`This file has no company_name column. It has: ${grid[0].map(clean).filter(Boolean).join(", ") || "nothing"}. Download the template to see the headings.`);
  }
  const known = new Set<string>(LEAD_IMPORT_COLUMNS);
  const unknownColumns = [...new Set(header.filter(h => h && !known.has(h)))];

  const body = grid.slice(1);
  if (body.length > MAX_ROWS) throw new Error(`That file has ${body.length} rows. Import at most ${MAX_ROWS} at a time.`);

  const index = await duplicateIndex();
  // The configured sources, so a typo in that column is said out loud rather than quietly stored as
  // a source nothing reports on.
  const sources = await names(() => prisma.leadSource.findMany({ select: { name: true } }));
  const sourceByLower = new Map(sources.map(s => [s.toLowerCase(), s]));
  /**
   * ONE CELL, SEVERAL PRODUCTS.
   *
   * `service` is a comma-separated list, because the Add lead form's Product box is a multi-select
   * and writes "PRO, VAT". So a lead wanting Auditing, VAT and PRO is ONE row with all three in the
   * one column — quoted in the file, because of the commas.
   *
   * Each name is checked against the configured products and snapped to their spelling. The Leads
   * product filter offers exactly those names and matches on them, so a product typed as anything
   * else is stored and then cannot be found under any option the filter has: present in the data
   * and absent from every screen that exists to find it.
   */
  const products = await names(() => prisma.product.findMany({ select: { name: true } }));
  const productByLower = new Map(products.map(x => [x.toLowerCase(), x]));

  const refused: LeadIssue[] = [], warnings: LeadIssue[] = [], skipped: LeadIssue[] = [];
  const rows: LeadPlanRow[] = [];
  /**
   * TWO ROWS FOR THE SAME LEAD INSIDE ONE FILE — the commonest duplicate of all, and one the
   * database cannot catch, because neither row exists yet while the plan is being made.
   *
   * THE EMAIL DECIDES IT, NOT THE NAME. Keying on the name alone looked obvious and is wrong in
   * both directions, which a real file of ninety leads showed in one pass:
   *
   *   two people called "Latheef", with different email addresses, are two leads — and the second
   *   was being dropped as a repeat of the first, silently, which is the worst way to lose a lead;
   *
   *   "Hadil" and "HADIL CHEVIDIKUNNAN KOYAMMU" share one address and are one person, and keying
   *   on the name let both through.
   *
   * So a row with an address is identified by it, and the name is the fallback only for a row that
   * has none — where it is the only thing there is to go on.
   */
  const seen = new Map<string, number>();

  for (let i = 0; i < body.length; i++) {
    const lineNo = i + 2;                       // 1-based, and the header is line 1
    const cell = (col: string) => clean(body[i][header.indexOf(col)]);
    const name = cell("company_name");
    if (!name) { refused.push({ row: lineNo, name: "—", what: "No company name" }); continue; }

    let email = cell("email"), phone = cell("phone");
    // A bad cell loses THAT cell, never the row — the stance the employee import settled on after
    // refusing rows and importing them anyway.
    if (!looksLikeEmail(email)) { warnings.push({ row: lineNo, name, what: `"${email}" is not an email address — imported without it` }); email = ""; }
    if (!looksLikePhone(phone)) { warnings.push({ row: lineNo, name, what: `"${phone}" is not a phone number — imported without it` }); phone = ""; }

    const key = email ? `email:${email.toLowerCase()}` : `name:${name.toLowerCase()}`;
    const earlier = seen.get(key);
    if (earlier) {
      skipped.push({ row: lineNo, name, what: email
        ? `Same email as row ${earlier} in this file (${email})`
        : `Same name as row ${earlier} in this file, and no email to tell them apart` });
      continue;
    }
    seen.set(key, lineNo);

    const dup = index.match({ name, email, phone })[0] ?? null;
    if (dup && dup.confidence === "certain") {
      skipped.push({ row: lineNo, name, what: `Already on file as "${dup.name}" — ${dup.why}` });
      continue;
    }

    const rawSource = cell("source");
    const source = rawSource ? (sourceByLower.get(rawSource.toLowerCase()) ?? rawSource) : "";
    if (rawSource && sources.length && !sourceByLower.has(rawSource.toLowerCase())) {
      warnings.push({ row: lineNo, name, what: `Source "${rawSource}" is not one of yours — imported as typed` });
    }

    const wanted = cell("product").split(",").map(x => x.trim()).filter(Boolean);
    const unknownProducts = products.length ? wanted.filter(x => !productByLower.has(x.toLowerCase())) : [];
    const product = wanted.map(x => productByLower.get(x.toLowerCase()) ?? x).join(", ");
    if (unknownProducts.length) {
      warnings.push({ row: lineNo, name, what:
        `${unknownProducts.map(x => `"${x}"`).join(", ")} ${unknownProducts.length === 1 ? "is not one of your products" : "are not among your products"} `
        + `(${products.join(", ")}) — imported as typed, and the Product filter will not find it` });
    }

    const contactName = cell("contact_name");
    // Exactly what the Add lead form sends: contact details with nobody attached are refused by the
    // route, so an email with no contact name is filed against the company's own name, as the form
    // does rather than as this file would decide for itself.
    const contacts = (contactName || email || phone)
      ? [{ name: contactName || name, jobTitle: cell("job_title") || null, email: email || null, phone: phone || null }]
      : [];

    rows.push({
      row: lineNo, name,
      contact: contactName || (contacts.length ? name : "—"),
      source: source || "—",
      product: product || "—",
      duplicate: dup,
      body: {
        name, lifecycle: "lead",
        city: cell("city") || null,
        source: source || null,
        sourceDetail: cell("note") || null,
        industry: cell("industry") || null,
        campaign: cell("campaign") || null,
        service: product || null,
        contacts,
      },
    });
    if (dup) warnings.push({ row: lineNo, name, what: `Looks like "${dup.name}" — ${dup.why}. Imported anyway; check it.` });
  }

  return { rowsRead: body.length, creates: rows.length, skipped, refused, warnings, rows, unknownColumns };
}

/**
 * Create them, through the route that already knows how.
 *
 * A row the route refuses is reported against its line and the rest continue: one bad row in a file
 * of three hundred must not undo the other two hundred and ninety-nine, and stopping halfway leaves
 * somebody guessing where it got to.
 *
 * IT SAYS WHERE IT HAS GOT TO, ROW BY ROW. Ninety leads is ninety full passes through the creation
 * route, which is some seconds of nothing while the one request the browser made stays open. A
 * label reading "Importing…" for that long is indistinguishable from a hang, and the person
 * watching it has no way to tell whether to wait or to reload — and reloading mid-import is the one
 * thing they must not do.
 *
 * The progress goes out on the SSE channel the console is already connected to, tagged with the
 * `job` the browser made up when it pressed the button. Tagged, because `publish` fans out to every
 * staff member: without it, two people importing at once would drive each other's progress bars.
 * The browser keeps only the events carrying its own job and ignores the rest.
 *
 * It is a report, never a dependency: nothing here waits for a listener, and an import with no
 * console attached runs exactly as it did before.
 */
export async function applyLeadImport(
  app: Express, parent: Request, plan: LeadPlan, job?: string | null,
): Promise<{ made: number; failed: LeadIssue[] }> {
  let made = 0;
  const failed: LeadIssue[] = [];
  const total = plan.rows.length;
  const say = (done: number, name: string) => {
    if (!job) return;
    try { publish("lead-import", { job, done, total, name }, { to: "staff" }); } catch { /* a progress bar is not worth failing an import for */ }
  };
  say(0, plan.rows[0]?.name ?? "");
  for (const r of plan.rows) {
    const a = await runInProcess(app, parent, "/api/companies", { method: "POST", body: r.body });
    if (a.status >= 200 && a.status < 300) made++;
    else failed.push({ row: r.row, name: r.name, what: String((a.body as any)?.error ?? `The server refused this row (${a.status})`) });
    say(made + failed.length, r.name);
  }
  return { made, failed };
}
