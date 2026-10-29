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
 * IT ALSO FILLS IN WHAT A FILE FORGOT, when asked to. A list arrives without a City column,
 * three hundred leads are created without one, and the only way back was to open three hundred
 * records. So `fill` mode treats a row that matches a lead already on file as a correction to that
 * lead rather than a second one: it writes the fields the record has NOTHING in, and never touches
 * a field that has an answer. The round trip is already there — the Leads export writes a sheet
 * whose headings this reads — so the repair is export, type the column in, upload the same file.
 *
 * It is a mode and not the default because the two intents are genuinely different, and no amount
 * of looking at a row tells you which one you are holding. A fresh list of ninety prospects wants
 * every near-match created and flagged; a corrections sheet wants every near-match completed. Guess
 * wrong on the first and you merge two real companies that share a trade name; guess wrong on the
 * second and you duplicate the list you were trying to fix.
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
import { INDIVIDUAL } from "./validate.js";
import { FILLABLE } from "./company-merge.js";

/** The columns the template offers, in order — and the only ones read. */
export const LEAD_IMPORT_COLUMNS = [
  "company_name", "company_type", "contact_name", "job_title", "email", "country_code", "phone", "website",
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
  company_type: "Company",
  contact_name: "Faisal Al Otaibi",
  job_title: "Operations Manager",
  email: "faisal@alnoor-contracting.example",
  // SPLIT, because a column nobody sees used is a column nobody fills in. A number that already
  // carries its code in the phone cell still imports — see the join in planLeadImport.
  country_code: "+966",
  phone: "55 123 4567",
  website: "alnoor-contracting.example",
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

/**
 * What a re-import may fill in: the columns this file reads that a MERGE is also allowed to copy.
 *
 * FILLABLE is the vetted list — same rule (never an overwrite), already asserted against the
 * schema by its own check script, and `contact`, `email` and `phone` are deliberately absent from
 * it because contacts.ts owns those three and writing them here would promise something that is
 * overwritten a second later. Which is why a fill leaves the contact alone and the dialog says so.
 */
export const IMPORT_FILLS = ["companyType", "city", "source", "sourceDetail", "industry", "campaign", "service", "website"] as const;
for (const f of IMPORT_FILLS) {
  if (!(FILLABLE as readonly string[]).includes(f)) throw new Error(`IMPORT_FILLS has "${f}", which a merge will not copy — one of the two lists is wrong`);
}

/** Column names people actually use, mapped to the ones this reads. */
const ALIAS: Record<string, string> = {
  company: "company_name", name: "company_name", client: "company_name", lead: "company_name",
  "company name": "company_name", organisation: "company_name", organization: "company_name",
  contact: "contact_name", person: "contact_name", "contact person": "contact_name",
  type: "company_type", kind: "company_type", "lead type": "company_type",
  "client type": "company_type", "type of client": "company_type",
  // `role` is there because the Leads EXPORT heads that column "Role", and that sheet coming back
  // with a column filled in is the whole point of fill mode.
  title: "job_title", designation: "job_title", position: "job_title", role: "job_title",
  "e-mail": "email", mail: "email", "email address": "email",
  url: "website", site: "website", web: "website", "web site": "website", homepage: "website",
  mobile: "phone", telephone: "phone", tel: "phone", "phone number": "phone", whatsapp: "phone",
  "country code": "country_code", "dial code": "country_code", dial: "country_code",
  code: "country_code", cc: "country_code", isd: "country_code", "isd code": "country_code",
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
  /** A new lead, or the blank fields of one already on file. */
  kind: "new" | "fill";
  /** The record being completed, for a fill. */
  id: string | null;
  /** Which fields a fill would write, for the preview — a fill with none is skipped, not planned. */
  fills: string[];
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
  updates: number;
  skipped: LeadIssue[];
  refused: LeadIssue[];
  warnings: LeadIssue[];
  rows: LeadPlanRow[];
  unknownColumns: string[];
};

const looksLikeEmail = (v: string) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
const looksLikePhone = (v: string) => !v || /^[+()\d][\d\s()+.-]{5,}$/.test(v);

export async function planLeadImport(csvText: string, opts: { fill?: boolean } = {}): Promise<LeadPlan> {
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
  // What the records already hold, so "is this field empty" is answered from the database rather
  // than from the match. Read once for the file, and only in fill mode — a normal import asks
  // nothing of it. Keyed by id, which is what a match hands back.
  const onFileFields = opts.fill
    ? new Map((await prisma.company.findMany({
        select: { id: true, ...Object.fromEntries(IMPORT_FILLS.map(f => [f, true])) } as any,
      })).map((c: any) => [String(c.id), c as Record<string, unknown>]))
    : null;
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

    /**
     * THE CODE ARRIVES IN ITS OWN COLUMN, because that is how these lists are written: a sheet of
     * local numbers with the country in a column beside them, or named once at the top and pasted
     * down. Until now that column was simply ignored and every number imported without its code.
     *
     * The Add lead form stores the code in front of the number ("+966 55 123 4567"), so that is
     * what is built here — a lead typed in and a lead imported hold the same shape of string.
     * A number that already carries a code keeps it, and a code with no number stays nothing,
     * exactly as the form refuses to store a bare "+966".
     */
    const dial = cell("country_code").replace(/\D/g, "");
    if (phone && dial && !/^(\+|00)/.test(phone)) {
      // 05x is how a Saudi mobile is written at home; the trunk zero goes once a country code is
      // in front of it, or the number dials nowhere.
      phone = `+${dial} ${phone.replace(/^0+/, "")}`.trim();
    }

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
    /**
     * IS THIS A LEAD WE ALREADY HAVE?
     *
     * A normal import answers only on `certain` — a shared CR or a shared email address, where
     * there is nothing to weigh — and stops the row there, which is what it has always done.
     *
     * FILL MODE ALSO ACCEPTS `likely`: the same phone number, or the same name once spelling and
     * legal form are ignored. That is the match a corrections sheet lands on, because 26 of this
     * firm's 117 leads have no email address for a `certain` match to use — and without it the
     * file meant to repair them would create a second copy of each instead.
     *
     * `possible` is still a new lead in both modes. That rule is one name being the start of
     * another — "Al Noor" against "Al Noor Trading" — which is as often two real companies as one,
     * and the mode does not make that guess any safer.
     */
    const onFile = dup && (dup.confidence === "certain" || (!!opts.fill && dup.confidence === "likely"));
    if (onFile && !opts.fill) {
      skipped.push({ row: lineNo, name, what: `Already on file as "${dup!.name}" — ${dup!.why}` });
      continue;
    }

    /**
     * PERSON OR COMPANY, the one distinction the Add lead form asks at lead time — and the one
     * the import was silently dropping, so every imported lead came in as a company and a sheet of
     * individual sponsors had to be corrected by hand afterwards.
     *
     * WHICH kind of company is not asked here any more than it is on the form; that is the client
     * form's question, where the answer decides which registrations are collected.
     */
    const rawKind = cell("company_type");
    const kind = /^(individual|person)$/i.test(rawKind) ? INDIVIDUAL : "";
    if (rawKind && !kind && !/^company$/i.test(rawKind)) {
      warnings.push({ row: lineNo, name, what: `"${rawKind}" is not Company or Person — imported as a company` });
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

    // Stored as a bare domain, matching what the site lookup writes: two records must not differ
    // only by "https://" or a "www.", which is exactly what a duplicate check would compare.
    const website = cell("website").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");

    const contactName = cell("contact_name");
    // Exactly what the Add lead form sends: contact details with nobody attached are refused by the
    // route, so an email with no contact name is filed against the company's own name, as the form
    // does rather than as this file would decide for itself.
    const contacts = (contactName || email || phone)
      ? [{ name: contactName || name, jobTitle: cell("job_title") || null, email: email || null, phone: phone || null }]
      : [];

    const fields: Record<string, string | null> = {
      companyType: kind || null,
      city: cell("city") || null,
      source: source || null,
      sourceDetail: cell("note") || null,
      industry: cell("industry") || null,
      campaign: cell("campaign") || null,
      service: product || null,
      website: website || null,
    };

    if (onFile) {
      /**
       * ONLY WHAT IS EMPTY. A field with an answer is somebody's answer, and a sheet is not
       * evidence that it is wrong — which is also what makes this safe to run twice.
       *
       * THE NAME IS NOT TOUCHED EITHER, and the record's own name is what gets sent: a fill is
       * reached by a name that matched once legal forms were ignored, so writing the sheet's
       * spelling over it would rename the company as a side effect of filling in its city — and
       * a rename re-addresses its unsent quotations.
       */
      // No row for it means this cannot tell what is empty, and "assume everything" would write
      // over answers that are already there. The only safe reading of a gap is to leave it alone.
      const have = onFileFields!.get(dup!.id);
      if (!have) {
        skipped.push({ row: lineNo, name, what: `Already on file as "${dup!.name}" — could not read what it already holds` });
        continue;
      }
      const fills = IMPORT_FILLS.filter(f => !clean(have[f]) && clean(fields[f]));
      if (!fills.length) {
        skipped.push({ row: lineNo, name, what: `Already on file as "${dup!.name}", with nothing this row adds` });
        continue;
      }
      rows.push({
        row: lineNo, name: dup!.name, kind: "fill", id: dup!.id, fills,
        contact: contactName || "—",
        source: source || "—",
        product: product || "—",
        duplicate: dup,
        body: { name: dup!.name, ...Object.fromEntries(fills.map(f => [f, fields[f]])) },
      });
      continue;
    }

    rows.push({
      row: lineNo, name, kind: "new", id: null, fills: [],
      contact: contactName || (contacts.length ? name : "—"),
      source: source || "—",
      product: product || "—",
      duplicate: dup,
      body: { name, lifecycle: "lead", ...fields, contacts },
    });
    if (dup) warnings.push({ row: lineNo, name, what: `Looks like "${dup.name}" — ${dup.why}. Imported anyway; check it.` });
  }

  return {
    rowsRead: body.length,
    creates: rows.filter(r => r.kind === "new").length,
    updates: rows.filter(r => r.kind === "fill").length,
    skipped, refused, warnings, rows, unknownColumns,
  };
}

/**
 * Create them, through the route that already knows how — and fill the others in through the route
 * the edit form uses, which writes only the fields it is handed and leaves the rest alone.
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
): Promise<{ made: number; filled: number; failed: LeadIssue[] }> {
  let made = 0, filled = 0;
  const failed: LeadIssue[] = [];
  const total = plan.rows.length;
  const say = (done: number, name: string) => {
    if (!job) return;
    try { publish("lead-import", { job, done, total, name }, { to: "staff" }); } catch { /* a progress bar is not worth failing an import for */ }
  };
  say(0, plan.rows[0]?.name ?? "");
  for (const r of plan.rows) {
    const a = r.kind === "fill"
      ? await runInProcess(app, parent, `/api/companies/${r.id}/details`, { method: "PUT", body: r.body })
      : await runInProcess(app, parent, "/api/companies", { method: "POST", body: r.body });
    if (a.status >= 200 && a.status < 300) { if (r.kind === "fill") filled++; else made++; }
    else failed.push({ row: r.row, name: r.name, what: String((a.body as any)?.error ?? `The server refused this row (${a.status})`) });
    say(made + filled + failed.length, r.name);
  }
  return { made, filled, failed };
}
