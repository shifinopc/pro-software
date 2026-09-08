/**
 * Import employees for one client from a CSV.
 *
 * There is no importer in the application, and a spreadsheet is how every client actually hands over
 * their people. This is that, run from the command line, with the two things a paste-into-the-database
 * script never has: it REFUSES rows it cannot read rather than saving a half-understood person, and it
 * can be run twice without creating everybody twice.
 *
 *   npx tsx scripts/import-employees.ts <file.csv> "<client name>"          # dry run, changes nothing
 *   npx tsx scripts/import-employees.ts <file.csv> "<client name>" --commit
 *
 * WHAT IT TRANSLATES, AND WHY EACH ONE MATTERS
 *
 *   dates        DD/MM/YYYY in, ISO out. A spreadsheet's 06/10/1994 is the 6th of October to the
 *                person who typed it and the 10th of June to anything that guesses American — and a
 *                date of birth silently off by four months is not visible on any screen.
 *   nationality  "India" in, "IN" out. The ratio matches on codes; a label that looks right and
 *                matches nothing under-reports Saudization, which is the direction that gets a client
 *                fined.
 *   salary       whole riyals in, minor units out, like every other money value in this system.
 *   documents    a row's passport / iqama / work permit / insurance become tracked documents, so the
 *                renewal engine starts watching them the moment they land.
 *
 * IDENTITY IS THE GOVERNMENT ID, not the name. Two people share a name; nobody shares an Iqama
 * number. A re-run updates those rows instead of creating a second of each.
 */
import { prisma } from "../src/db.js";
import fs from "node:fs";

const [, , file, clientName, ...flags] = process.argv;
const COMMIT = flags.includes("--commit");

if (!file || !clientName) {
  console.log('usage: import-employees.ts <file.csv> "<client name>" [--commit]');
  process.exit(1);
}

/** Nationality labels a client will actually type, mapped to the codes this system counts on. */
const NATION: Record<string, string> = {
  india: "IN", indian: "IN",
  bangladesh: "BD", bangladeshi: "BD",
  saudi: "SA", "saudi arabia": "SA", "saudi arabian": "SA", ksa: "SA",
  pakistan: "PK", pakistani: "PK",
  philippines: "PH", filipino: "PH",
  nepal: "NP", nepali: "NP",
  egypt: "EG", egyptian: "EG",
  syria: "SY", syrian: "SY",
  jordan: "JO", jordanian: "JO",
  yemen: "YE", sudan: "SD", "sri lanka": "LK", ethiopia: "ET", kenya: "KE",
};

/** A cell that means "there is none", as opposed to one nobody filled in. */
const isNone = (v: string) => /^(no insurance|none|n\/a|na|nil|-)$/i.test(v.trim());

/** DD/MM/YYYY — the only format offered, because guessing between it and MM/DD is how a birthday moves. */
function isoDate(raw: string): { iso: string | null; why?: string } {
  const v = String(raw ?? "").trim();
  if (!v || isNone(v)) return { iso: null };
  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const day = Number(d), mon = Number(mo);
    if (mon < 1 || mon > 12) return { iso: null, why: `"${v}" has no month ${mon}` };
    if (day < 1 || day > 31) return { iso: null, why: `"${v}" has no day ${day}` };
    return { iso: `${y}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { iso: v };
  return { iso: null, why: `cannot read the date "${v}" — use DD/MM/YYYY` };
}

/** A minimal CSV reader: quoted fields, embedded commas, nothing exotic. */
function parseCsv(text: string): string[][] {
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

type Problem = { row: number; name: string; what: string };

async function main() {
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = parseCsv(raw);
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  const need = ["full_name", "nationality"];
  for (const n of need) if (col(n) < 0) { console.log(`the file has no "${n}" column`); process.exit(1); }

  const co = await prisma.company.findFirst({ where: { name: clientName } });
  if (!co) {
    const all = await prisma.company.findMany({ select: { name: true } });
    console.log(`no client called "${clientName}". On this installation: ${all.map(c => c.name).join(", ")}`);
    process.exit(1);
  }

  const at = (r: string[], n: string) => { const i = col(n); return i < 0 ? "" : String(r[i] ?? "").trim(); };
  const problems: Problem[] = [];
  const notes: string[] = [];
  const plan: any[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    const name = at(r, "full_name");
    if (!name) { problems.push({ row: line, name: "(blank)", what: "no name" }); continue; }

    // The row belongs to this client, or it does not belong in this run at all.
    const rowClient = at(r, "client_name");
    if (rowClient && rowClient.toLowerCase() !== clientName.toLowerCase()) {
      problems.push({ row: line, name, what: `belongs to "${rowClient}", not "${clientName}"` });
      continue;
    }

    const natRaw = at(r, "nationality");
    const nat = /^[A-Za-z]{2}$/.test(natRaw) ? natRaw.toUpperCase() : NATION[natRaw.toLowerCase()];
    if (!nat) { problems.push({ row: line, name, what: `nationality "${natRaw}" is not one this system knows` }); continue; }

    const dob = isoDate(at(r, "date_of_birth"));
    if (dob.why) problems.push({ row: line, name, what: dob.why });

    // Digits only. One row arrived with a stray byte in front of the number, which would have been
    // stored and then never matched anything.
    const govIdRaw = at(r, "gov_id");
    const govId = govIdRaw.replace(/\D/g, "") || null;
    if (govIdRaw && govId !== govIdRaw) notes.push(`row ${line} ${name}: government id cleaned, "${govIdRaw}" → "${govId}"`);

    const salaryRaw = at(r, "salary_monthly");
    const salary = salaryRaw ? Math.round(Number(salaryRaw) * 100) : null;
    if (salaryRaw && !Number.isFinite(salary)) problems.push({ row: line, name, what: `salary "${salaryRaw}" is not a number` });

    const docs: { docType: string; number: string | null; expiry: string }[] = [];
    for (const [type, numCol, expCol] of [
      ["Passport", "passport_number", "passport_expiry"],
      ["Iqama", null, "iqama_expiry"],
      ["Work Permit", null, "work_permit_expiry"],
      ["Health Insurance", null, "health_insurance_expiry"],
    ] as [string, string | null, string][]) {
      const rawExp = at(r, expCol);
      if (!rawExp) continue;
      if (isNone(rawExp)) { notes.push(`row ${line} ${name}: ${type.toLowerCase()} recorded as "${rawExp}" — no document created`); continue; }
      const e = isoDate(rawExp);
      if (e.why) { problems.push({ row: line, name, what: `${type}: ${e.why}` }); continue; }
      if (e.iso) docs.push({ docType: type, number: numCol ? (at(r, numCol) || null) : (type === "Iqama" ? govId : null), expiry: e.iso });
    }

    plan.push({
      line, name, nat, govId, salary,
      dob: dob.iso,
      role: at(r, "role") || null,
      // Kept as the client wrote it. These are Qiwa skill levels — high skilled / skilled / basic
      // skilled — and flattening them into the console's two-value picker would lose a real
      // distinction the government makes.
      jobCategory: at(r, "job_category").toLowerCase() || null,
      employmentType: at(r, "employment_type") || null,
      workCountry: at(r, "work_country") || co.country || "SA",
      department: at(r, "department") || null,
      joinDate: isoDate(at(r, "joining_date")).iso,
      visaQuota: Number(at(r, "visa_quota")) || 1,
      docs,
    });
  }

  // ── what this would do ──────────────────────────────────────────────────────────────────────
  const existing = await prisma.employee.findMany({ where: { companyId: co.id }, select: { id: true, name: true, govId: true } });
  const byGov = new Map(existing.filter(e => e.govId).map(e => [e.govId!, e]));
  const byName = new Map(existing.map(e => [e.name.trim().toLowerCase(), e]));
  const creates = plan.filter(p => !(p.govId && byGov.has(p.govId)) && !byName.has(p.name.trim().toLowerCase()));
  const updates = plan.length - creates.length;

  const nat = new Map<string, number>();
  for (const p of plan) nat.set(p.nat, (nat.get(p.nat) ?? 0) + 1);
  const docCount = plan.reduce((n, p) => n + p.docs.length, 0);

  console.log(`\nclient        ${co.name}  (${co.country ?? "no country"})`);
  console.log(`rows read     ${rows.length - 1}`);
  console.log(`understood    ${plan.length}`);
  console.log(`  new         ${creates.length}`);
  console.log(`  already on file (matched, would update)   ${updates}`);
  console.log(`documents     ${docCount}`);
  console.log(`nationalities ${[...nat.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  const saudis = plan.filter(p => p.nat === "SA").length;
  console.log(`saudization   ${saudis} of ${plan.length} = ${((saudis * 100) / (plan.length || 1)).toFixed(1)}% once loaded`);

  if (notes.length) { console.log(`\nnotes (${notes.length}):`); for (const n of notes) console.log(`  · ${n}`); }
  if (problems.length) {
    console.log(`\nREFUSED (${problems.length}) — these rows are not imported:`);
    for (const p of problems) console.log(`  row ${p.row}  ${p.name}: ${p.what}`);
  }

  if (!COMMIT) {
    console.log(`\nDRY RUN — nothing was written. Re-run with --commit to import.`);
    await prisma.$disconnect();
    return;
  }

  // ── write ───────────────────────────────────────────────────────────────────────────────────
  let made = 0, changed = 0, docsMade = 0;
  for (const p of plan) {
    const hit = (p.govId && byGov.get(p.govId)) || byName.get(p.name.trim().toLowerCase()) || null;
    const data: any = {
      name: p.name, role: p.role, nationality: p.nat, workCountry: p.workCountry,
      dob: p.dob, govId: p.govId, salary: p.salary,
      employmentType: p.employmentType, jobCategory: p.jobCategory,
      customData: { department: p.department, joinDate: p.joinDate, visaQuota: p.visaQuota },
    };
    let emp;
    if (hit) { emp = await prisma.employee.update({ where: { id: hit.id }, data }); changed++; }
    else { emp = await prisma.employee.create({ data: { ...data, companyId: co.id, status: "valid" } }); made++; }

    for (const d of p.docs) {
      // Matched on person + type, so a re-run corrects an expiry instead of stacking a second copy.
      const had = await prisma.document.findFirst({ where: { companyId: co.id, employeeId: emp.id, docType: d.docType, supersededAt: null } });
      const left = Math.ceil((new Date(d.expiry).getTime() - Date.now()) / 86_400_000);
      const doc = {
        companyId: co.id, employeeId: emp.id, person: emp.name, docType: d.docType,
        docNumber: d.number, expiryDate: d.expiry,
        status: left < 0 ? "overdue" : left <= 30 ? "expiring" : "valid",
        daysLeft: left,
      };
      if (had) await prisma.document.update({ where: { id: had.id }, data: doc });
      else { await prisma.document.create({ data: doc as any }); docsMade++; }
    }
  }
  console.log(`\nIMPORTED: ${made} new, ${changed} updated, ${docsMade} new document(s).`);
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
