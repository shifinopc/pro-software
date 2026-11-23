/**
 * Import a client's employees from a spreadsheet.
 *
 * A spreadsheet is how every client actually hands over their people. This started as a
 * command-line script (scripts/import-employees.ts) and now also sits behind a button on the
 * client's Employees tab; both call this, so there is one set of rules rather than two that drift.
 *
 * IT IS A TWO-STEP OPERATION, ALWAYS. `planEmployeeImport` reads the file and says what would
 * happen, writing nothing. `applyEmployeeImport` does it. The console shows the plan first, so
 * nobody imports three hundred people to discover afterwards that the dates were read American.
 *
 * WHAT IT TRANSLATES, AND WHY EACH ONE MATTERS
 *
 *   dates        DD/MM/YYYY in, ISO out. A spreadsheet's 06/10/1994 is the 6th of October to the
 *                person who typed it and the 10th of June to anything that guesses American — and a
 *                date of birth silently off by four months is not visible on any screen.
 *   nationality  "India" in, "IN" out. The Saudization ratio matches on codes; a label that looks
 *                right and matches nothing under-reports it, which is the direction that gets a
 *                client fined.
 *   salary       whole riyals in, minor units out, like every other money value in this system.
 *   documents    a row's passport / iqama / work permit / insurance become tracked documents, so the
 *                renewal engine starts watching them the moment they land.
 *
 * IDENTITY IS THE GOVERNMENT ID, NOT THE NAME. Two people share a name; nobody shares an Iqama
 * number. A re-run updates those people instead of creating a second of each.
 *
 * TWO DEFECTS CORRECTED ON THE WAY IN FROM THE SCRIPT:
 *
 *   The name fallback overrode the ID. A new person who happened to share a name with somebody
 *   already on file — but carried a DIFFERENT Iqama number — was treated as that existing person
 *   and overwrote their ID. Exactly the case the rule above exists for. Now a row with an ID is
 *   matched on the ID alone; the name is used only when there is no ID to go on, and never to merge
 *   two different IDs.
 *
 *   A bad cell was "refused" but imported anyway. An unreadable salary was listed under REFUSED and
 *   then written as NaN, which fails the database write halfway through. A row is now either
 *   refused outright — not imported, and said so — or imported with the unreadable field left
 *   empty and a warning naming it. Never both.
 */
import { prisma } from "./db.js";
import { normCr } from "./establishments.js";
import { resolveCountry } from "./countries.js";


/** Column names people actually use, mapped to the ones this reads. */
const ALIAS: Record<string, string> = {
  name: "full_name", "full name": "full_name", employee_name: "full_name",
  iqama: "gov_id", iqama_number: "gov_id", iqama_no: "gov_id", national_id: "gov_id", id_number: "gov_id",
  dob: "date_of_birth", "date of birth": "date_of_birth",
  salary: "salary_monthly", monthly_salary: "salary_monthly",
  sex: "gender",
  cr: "cr_number", cr_no: "cr_number", "cr number": "cr_number", sub_cr: "cr_number", branch_cr: "cr_number",
  commercial_registration: "cr_number", "commercial registration": "cr_number",
};

/** The person's own columns. The document ones are not here — see `cardDocColumns`. */
export const IMPORT_PERSON_COLUMNS = [
  "full_name", "nationality", "gov_id", "cr_number", "gender", "date_of_birth", "role", "job_category",
  "employment_type", "department", "joining_date", "salary_monthly",
];

/**
 * WHICH DOCUMENTS A FILE CAN CARRY — READ FROM THE EMPLOYEE CARD, NOT WRITTEN HERE.
 *
 * It used to be four types hardcoded below: passport, iqama, work permit, health insurance. The
 * card an employee is MEASURED against is configuration — the `onEmployeeCard` switch on each
 * document type — and it had grown a fifth, the Qiwa Employment Contract. So every imported
 * employee arrived one document short of complete with no column to supply it, and the only way
 * to close the gap was to upload the contract by hand, one person at a time.
 *
 * Reading the card instead means the two cannot disagree: tick a type onto the card and its column
 * appears in the template; untick it and the column goes. The column name is the type's own name
 * in snake case, which leaves the four that already existed spelled exactly as they were, so files
 * people already have keep importing.
 *
 * A `_number` column is offered only where the type declares a field whose purpose is `number` —
 * today the passport alone. Iqama numbers come from `gov_id`, and a type like the Qiwa contract
 * keeps its contract number as one of its own fields, which this importer does not write: it
 * creates a document with a number and an expiry, and anything further is captured on upload.
 */
export type DocColumn = { type: string; col: string; numberCol: string | null };

export const colName = (typeName: string) =>
  typeName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export async function cardDocColumns(): Promise<DocColumn[]> {
  const rows = await prisma.documentType.findMany({
    where: { onEmployeeCard: true, retired: false },
    select: { name: true, cardOrder: true, fields: true, subjectKind: true },
    orderBy: [{ cardOrder: "asc" }, { name: "asc" }],
  });
  return rows
    .filter(r => (r.subjectKind ?? "employee") === "employee")
    .map(r => {
      const fields = Array.isArray(r.fields) ? (r.fields as any[]) : [];
      const hasNumber = fields.some(f => String(f?.purpose ?? "") === "number");
      const col = colName(r.name);
      return { type: r.name, col, numberCol: hasNumber ? `${col}_number` : null };
    });
}

/** The columns the template offers, in order: the person, then a pair per card document. */
export async function importColumns(): Promise<string[]> {
  const docs = await cardDocColumns();
  const out = [...IMPORT_PERSON_COLUMNS];
  for (const d of docs) {
    if (d.numberCol) out.push(d.numberCol);
    out.push(`${d.col}_expiry`);
  }
  return out;
}

/**
 * THE FILE THE TEMPLATE BUTTON HANDS OUT — BUILT HERE, WHERE THE IMPORTER LIVES.
 *
 * The console used to write this CSV itself from its own copy of the headings, which is two lists
 * in two files describing one contract. There is a check script whose whole job is to catch them
 * drifting; the cheaper answer is to have one list. The server reads the file, so the server
 * offers the file.
 *
 * Three example rows, because the mistakes worth pre-empting are visible only in examples: dates
 * are DD/MM/YYYY (the one that silently moves a birthday four months), a Saudi national carries no
 * iqama or work permit, and a client with sub CRs gets one row per CR so the column is filled the
 * way the importer reads it.
 */
export async function employeeImportTemplateCsv(companyId?: string): Promise<string> {
  const cols = await importColumns();
  const docs = await cardDocColumns();
  const ests = companyId
    ? await prisma.establishment.findMany({ where: { companyId, status: "active" }, select: { crNumber: true }, orderBy: { crNumber: "asc" } })
    : [];

  // Expiries spread across the examples so no two columns look copied from one another.
  const docDates = ["20/11/2026", "31/12/2026", "09/05/2027", "14/02/2028", "03/04/2030"];
  const person = (base: Record<string, string>, withResidency: boolean, i: number): Record<string, string> => {
    const row: Record<string, string> = { ...base };
    docs.forEach((d, j) => {
      // A Saudi national holds no iqama and no work permit; leaving them blank in an example is
      // how somebody learns that without reading a manual.
      const residency = /iqama|work permit|exit|re-entry/i.test(d.type);
      row[`${d.col}_expiry`] = (!withResidency && residency) ? "" : docDates[(i + j) % docDates.length];
      if (d.numberCol) row[d.numberCol] = withResidency || !/passport/i.test(d.type) ? (i === 1 ? "" : ["Z1234567", "", "P7654321"][i] ?? "") : "";
    });
    return row;
  };

  const people = [
    person({ full_name: "Mohammed Rahman", nationality: "India", gov_id: "2123456789", gender: "male", date_of_birth: "06/10/1994", role: "Electrician", job_category: "skilled", employment_type: "full_time", department: "Maintenance", joining_date: "01/03/2024", salary_monthly: "3500" }, true, 0),
    person({ full_name: "Abdullah Al Harbi", nationality: "Saudi", gov_id: "1098765432", gender: "male", date_of_birth: "14/02/1990", role: "Accountant", job_category: "high skilled", employment_type: "full_time", department: "Finance", joining_date: "15/01/2023", salary_monthly: "9000" }, false, 1),
    person({ full_name: "Maria Santos", nationality: "Philippines", gov_id: "2234567890", gender: "female", date_of_birth: "22/07/1992", role: "Receptionist", job_category: "basic skilled", employment_type: "full_time", department: "Admin", joining_date: "10/05/2025", salary_monthly: "3000" }, true, 2),
  ];

  const crs = ests.map(e => e.crNumber).filter(Boolean) as string[];
  const rows: Record<string, string>[] = (crs.length ? crs.slice(0, 3) : [""]).map((cr, i) => ({ ...people[i % people.length], cr_number: cr }));

  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const body = rows.map(r => cols.map(c => cell(r[c] ?? "")).join(",")).join("\n");
  // The BOM is what makes Excel read it as UTF-8; without it an Arabic name arrives as mojibake.
  return `\ufeff${cols.join(",")}\n${body}\n`;
}

const MAX_ROWS = 2000;

/** A cell that means "there is none", as opposed to one nobody filled in. */
const isNone = (v: string) => /^(no insurance|none|n\/a|na|nil|-)$/i.test(v.trim());

/**
 * WHICH CENTURY A TWO-DIGIT YEAR MEANS.
 *
 * Day and month order is never guessed — DD/MM, stated on the template, because guessing between
 * that and MM/DD is how a birthday moves. The century is a different question: "19-02-92" and
 * "07-06-27" are both unambiguous to a person and neither says 19 or 20.
 *
 * NEAREST TO TODAY, then corrected by what the field is. 92 is 1992 and not 2092 because 1992 is
 * closer; 27 is 2027 and not 1927 for the same reason. That rule alone gets expiry dates right and
 * gets one kind of birthday wrong — somebody born in 1968 would arrive as 2068 — so a field that
 * can only be in the past says so and the year drops a century. A joining date is left on the
 * nearest rule: a contract starting next month is as ordinary as one from last year.
 */
function twoDigitYear(yy: number, era: "past" | "any"): number {
  const now = new Date().getFullYear();
  const cands = [1900 + yy, 2000 + yy, 2100 + yy];
  let year = cands.reduce((best, c) => (Math.abs(c - now) < Math.abs(best - now) ? c : best), cands[0]);
  if (era === "past" && year > now) year -= 100;
  return year;
}

/** DD/MM/YYYY or DD/MM/YY — separated by / . or -, and ISO straight through. */
export function isoDate(raw: string, era: "past" | "any" = "any"): { iso: string | null; why?: string } {
  const v = String(raw ?? "").trim();
  if (!v || isNone(v)) return { iso: null };
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const day = Number(d), mon = Number(mo);
    if (mon < 1 || mon > 12) return { iso: null, why: `"${v}" has no month ${mon} — dates are DD/MM/YYYY` };
    if (day < 1 || day > 31) return { iso: null, why: `"${v}" has no day ${day}` };
    const year = y.length === 2 ? twoDigitYear(Number(y), era) : Number(y);
    return { iso: `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: v };
  return { iso: null, why: `cannot read the date "${v}" — use DD/MM/YYYY` };
}

/** A minimal CSV reader: quoted fields, embedded commas and newlines, nothing exotic. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim()));
}

export type ImportIssue = { row: number; name: string; what: string };
type PlannedDoc = { docType: string; number: string | null; expiry: string };
type PlannedRow = {
  line: number; name: string; nat: string; govId: string | null; gender: string | null;
  salary: number | null; dob: string | null; role: string | null; jobCategory: string | null;
  employmentType: string | null; workCountry: string; department: string | null; joinDate: string | null;
  docs: PlannedDoc[];
  matchId: string | null;          // existing employee this updates, or null for a new one
  /** The CR this person works under: an establishment id, null for the main CR, undefined = leave as it is. */
  establishmentId?: string | null;
  crLabel: string;
};

export type ImportPlan = {
  company: { id: string; name: string; country: string | null };
  rowsRead: number;
  creates: number;
  updates: number;
  documents: number;
  nationalities: { code: string; count: number }[];
  saudization: { saudis: number; total: number; pct: number };
  refused: ImportIssue[];          // rows NOT imported
  warnings: ImportIssue[];         // rows imported, with something left out
  preview: { line: number; name: string; nationality: string; govId: string | null; action: "new" | "update"; documents: number; cr: string }[];
  /** How the rows split across the client's CRs, with Saudis per CR. Empty when the file has no CR column. */
  crs: { cr: string; label: string; rows: number; saudis: number }[];
  rows: PlannedRow[];
};

/** Read the file and say exactly what an import would do. Writes nothing. */
export async function planEmployeeImport(companyId: string, csvText: string): Promise<ImportPlan> {
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, country: true } });
  if (!co) throw new Error("That client no longer exists");

  const rows = parseCsv(String(csvText ?? "").replace(/^﻿/, ""));
  if (rows.length < 2) throw new Error("The file has no employee rows — the first line should be the column headings, and each line after it one person.");
  if (rows.length - 1 > MAX_ROWS) throw new Error(`The file has ${rows.length - 1} rows. Import at most ${MAX_ROWS} at a time — split the file.`);

  const head = rows[0].map(h => { const k = h.trim().toLowerCase().replace(/\s+/g, "_"); return ALIAS[k] ?? ALIAS[h.trim().toLowerCase()] ?? k; });
  const col = (n: string) => head.indexOf(n);
  for (const n of ["full_name", "nationality"]) {
    if (col(n) < 0) throw new Error(`The file has no "${n}" column. Download the template to see the headings this reads.`);
  }
  const at = (r: string[], n: string) => { const i = col(n); return i < 0 ? "" : String(r[i] ?? "").trim(); };

  const existing = await prisma.employee.findMany({ where: { companyId: co.id }, select: { id: true, name: true, govId: true } });

  // THE CR COLUMN. A client with sub CRs imports one file for all of them; each row names the CR the
  // person works under. Blank means the main CR for a new person and "unchanged" for someone already on
  // file. A CR that is not one of this client's active CRs refuses the row — it is far more likely a
  // typo or the wrong client's file than a CR worth creating from a spreadsheet.
  const hasCrColumn = col("cr_number") >= 0;
  const ests = await prisma.establishment.findMany({ where: { companyId: co.id }, select: { id: true, crNumber: true, kind: true, status: true, name: true, city: true } });
  // Read once for the whole file rather than per row: it is one query either way, and a file of
  // three hundred people should not ask the database three hundred times what the card holds.
  const docCols = await cardDocColumns();
  const mainCr = ests.find(e => e.kind === "main" && e.status === "active") ?? null;
  const knownCrs = ests.filter(e => e.status === "active").map(e => e.crNumber).join(", ") || "none added yet";
  const byGov = new Map(existing.filter(e => e.govId).map(e => [e.govId!, e]));
  const byName = new Map<string, typeof existing>();
  for (const e of existing) {
    const k = e.name.trim().toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), e]);
  }

  const refused: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const planned: PlannedRow[] = [];
  const seenGov = new Map<string, number>();
  const claimed = new Set<string>(); // an existing employee may be updated by one row only

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const name = at(r, "full_name");
    if (!name) { refused.push({ row: line, name: "(blank)", what: "no name" }); continue; }

    const rowClient = at(r, "client_name");
    if (rowClient && rowClient.toLowerCase() !== co.name.toLowerCase()) {
      refused.push({ row: line, name, what: `the row says it belongs to "${rowClient}", not ${co.name}` });
      continue;
    }

    let establishmentId: string | null | undefined = undefined;
    let crShown = "";
    if (hasCrColumn) {
      const crRaw = at(r, "cr_number");
      const crN = normCr(crRaw);
      if (crN) {
        const hit = ests.find(e => normCr(e.crNumber) === crN);
        if (!hit && !(ests.length === 0 && normCr((await prisma.company.findUnique({ where: { id: co.id }, select: { cr: true } }))?.cr) === crN)) {
          refused.push({ row: line, name, what: `CR ${crRaw} is not one of ${co.name}'s CRs (${knownCrs}) — add it on the client's page first` });
          continue;
        }
        if (hit && hit.status !== "active") { refused.push({ row: line, name, what: `CR ${crRaw} is cancelled` }); continue; }
        establishmentId = !hit || hit.kind === "main" ? null : hit.id;
        crShown = hit ? hit.crNumber : crN;
      }
    }

    const natRaw = at(r, "nationality");
    const nat = resolveCountry(natRaw);
    if (!nat) { refused.push({ row: line, name, what: natRaw ? `nationality "${natRaw}" is not one this system recognises — use the country name or its 2-letter code` : "no nationality" }); continue; }

    // Digits only. One real file arrived with a stray byte in front of an Iqama number, which would
    // have been stored and then never matched anything.
    const govIdRaw = at(r, "gov_id");
    const govId = govIdRaw.replace(/\D/g, "") || null;
    if (govIdRaw && govId !== govIdRaw) warnings.push({ row: line, name, what: `government ID cleaned from "${govIdRaw}" to "${govId}"` });
    if (govId) {
      const dup = seenGov.get(govId);
      if (dup) { refused.push({ row: line, name, what: `government ID ${govId} is already used on row ${dup} of this file` }); continue; }
      seenGov.set(govId, line);
    }

    // Who this is. The ID decides when there is one; the name only when there is not.
    let matchId: string | null = null;
    if (govId && byGov.has(govId)) {
      matchId = byGov.get(govId)!.id;
    } else {
      const sameName = byName.get(name.trim().toLowerCase()) ?? [];
      // A same-named person counts as this row only if they have no ID on file to contradict it.
      // Two different ID numbers are two different people, whatever they are called.
      const candidates = sameName.filter(e => !e.govId);
      if (candidates.length === 1) matchId = candidates[0].id;
      else if (!govId && sameName.length > 1) {
        refused.push({ row: line, name, what: `${sameName.length} people called "${name}" are already on file and this row has no government ID to tell them apart` });
        continue;
      }
    }
    if (matchId) {
      if (claimed.has(matchId)) { refused.push({ row: line, name, what: "another row in this file already updates the same person" }); continue; }
      claimed.add(matchId);
    }

    // "past": a birthday cannot be in the future, which is what decides 68 → 1968 rather than 2068.
    const dob = isoDate(at(r, "date_of_birth"), "past");
    if (dob.why) warnings.push({ row: line, name, what: `date of birth left empty — ${dob.why}` });

    const salaryRaw = at(r, "salary_monthly").replace(/,/g, "");
    let salary: number | null = null;
    if (salaryRaw) {
      const n = Number(salaryRaw);
      if (Number.isFinite(n) && n >= 0) salary = Math.round(n * 100);
      else warnings.push({ row: line, name, what: `salary left empty — "${at(r, "salary_monthly")}" is not a number` });
    }

    const gRaw = at(r, "gender").toLowerCase();
    const gender = /^(m|male)$/.test(gRaw) ? "male" : /^(f|female)$/.test(gRaw) ? "female" : null;
    if (gRaw && !gender) warnings.push({ row: line, name, what: `gender left empty — "${at(r, "gender")}" is not male or female` });

    const joined = isoDate(at(r, "joining_date"));
    if (joined.why) warnings.push({ row: line, name, what: `joining date left empty — ${joined.why}` });

    const docs: PlannedDoc[] = [];
    for (const { type, col, numberCol } of docCols) {
      const numCol = numberCol;
      const expCol = `${col}_expiry`;
      const rawExp = at(r, expCol);
      if (!rawExp || isNone(rawExp)) continue;
      const e = isoDate(rawExp);
      if (e.why) { warnings.push({ row: line, name, what: `${type} not created — ${e.why}` }); continue; }
      if (e.iso) docs.push({ docType: type, number: numCol ? (at(r, numCol) || null) : (type === "Iqama" ? govId : null), expiry: e.iso });
    }

    planned.push({
      line, name, nat, govId, gender, salary,
      dob: dob.iso,
      role: at(r, "role") || null,
      // Kept as the client wrote it. These are Qiwa skill levels — high skilled / skilled / basic
      // skilled — and flattening them into a two-value picker would lose a distinction the
      // government makes.
      jobCategory: at(r, "job_category").toLowerCase() || null,
      employmentType: at(r, "employment_type") || null,
      workCountry: at(r, "work_country") || co.country || "SA",
      department: at(r, "department") || null,
      joinDate: joined.iso,
      docs,
      matchId,
      // Blank CR: main CR for someone new, unchanged for someone already on file.
      establishmentId: establishmentId !== undefined ? establishmentId : (hasCrColumn && !matchId ? null : undefined),
      crLabel: crShown || (matchId && hasCrColumn ? "unchanged" : mainCr ? mainCr.crNumber : ""),
    });
  }

  const nat = new Map<string, number>();
  for (const p of planned) nat.set(p.nat, (nat.get(p.nat) ?? 0) + 1);
  const saudis = planned.filter(p => p.nat === "SA").length;

  return {
    company: co,
    rowsRead: rows.length - 1,
    creates: planned.filter(p => !p.matchId).length,
    updates: planned.filter(p => p.matchId).length,
    documents: planned.reduce((n, p) => n + p.docs.length, 0),
    nationalities: [...nat.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
    saudization: { saudis, total: planned.length, pct: planned.length ? Math.round((saudis * 1000) / planned.length) / 10 : 0 },
    refused,
    warnings,
    preview: planned.slice(0, 200).map(p => ({ line: p.line, name: p.name, nationality: p.nat, govId: p.govId, action: p.matchId ? "update" as const : "new" as const, documents: p.docs.length, cr: p.crLabel })),
    crs: !hasCrColumn ? [] : [...planned.reduce((m, p) => {
      const k = p.crLabel || "main";
      const cur = m.get(k) ?? { cr: k, label: k === "unchanged" ? "CR unchanged (already on file)" : (() => { const e = ests.find(x => x.crNumber === k); return e ? `${e.kind === "main" ? "Main CR" : e.city || e.name || "Sub CR"} ${e.crNumber}` : `CR ${k}`; })(), rows: 0, saudis: 0 };
      cur.rows++; if (p.nat === "SA") cur.saudis++;
      return m.set(k, cur);
    }, new Map<string, { cr: string; label: string; rows: number; saudis: number }>()).values()],
    rows: planned,
  };
}

/** Do what the plan says. */
export async function applyEmployeeImport(plan: ImportPlan): Promise<{ made: number; changed: number; docsMade: number; docsUpdated: number }> {
  let made = 0, changed = 0, docsMade = 0, docsUpdated = 0;
  const companyId = plan.company.id;

  for (const p of plan.rows) {
    const data: any = {
      name: p.name, role: p.role, nationality: p.nat, workCountry: p.workCountry,
      dob: p.dob, govId: p.govId, salary: p.salary,
      employmentType: p.employmentType, jobCategory: p.jobCategory,
      customData: { department: p.department, joinDate: p.joinDate },
    };
    // Only write gender when the file said something. An update must not blank a gender that was
    // recorded by hand because the spreadsheet simply had no column for it.
    if (p.gender) data.gender = p.gender;
    if (p.establishmentId !== undefined) data.establishmentId = p.establishmentId;

    const emp = p.matchId
      ? await prisma.employee.update({ where: { id: p.matchId }, data })
      : await prisma.employee.create({ data: { ...data, companyId, status: "valid" } });
    if (p.matchId) changed++; else made++;

    for (const d of p.docs) {
      // Matched on person + type, so a re-run corrects an expiry instead of stacking a second copy.
      const had = await prisma.document.findFirst({ where: { companyId, employeeId: emp.id, docType: d.docType, supersededAt: null } });
      const left = Math.ceil((new Date(d.expiry).getTime() - Date.now()) / 86_400_000);
      const doc = {
        companyId, employeeId: emp.id, person: emp.name, docType: d.docType,
        docNumber: d.number, expiryDate: d.expiry,
        status: left < 0 ? "overdue" : left <= 30 ? "expiring" : "valid",
        daysLeft: left,
      };
      if (had) { await prisma.document.update({ where: { id: had.id }, data: doc }); docsUpdated++; }
      else { await prisma.document.create({ data: doc as any }); docsMade++; }
    }
  }
  return { made, changed, docsMade, docsUpdated };
}
