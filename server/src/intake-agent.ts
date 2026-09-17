/**
 * THE DOCUMENT INTAKE AGENT.
 *
 * Staff drop in a scan of a passport, Iqama, CR, work permit or insurance card. Claude reads it; this
 * file checks what it read against what the system already holds; a person accepts or rejects the
 * result. Typing those documents in by hand is the slowest, most error-prone job in the office, and
 * every document confirmed here is picked up by the renewal engine the moment it lands.
 *
 * IT PREPARES, A PERSON DECIDES. The agent never creates a Document. It writes a DocumentSuggestion:
 * what it read, how sure it was of each field, and every problem found checking it. Only
 * `acceptSuggestion` — a staff member's explicit action — turns that into a record, and the officer
 * can correct any field first. What they changed is kept on the suggestion.
 *
 * OFF UNTIL SOMEBODY TURNS IT ON, AND A MODEL ONLY IF ONE IS CHOSEN. Passports are read first by the
 * built-in reader (mrz-reader.ts): OCR of the machine-readable zone, proven by its check digits, with
 * nothing leaving the server. Only when that finds no MRZ — Iqamas, CRs, permits, insurance cards,
 * PDFs — and an admin has chosen a model is the scan sent to one (Claude, or a self-hosted model on an
 * OpenAI-compatible server; see ai.ts). Sending an identity document to a model is a transfer of it
 * to wherever that model runs, which is the firm's decision, not a default.
 *
 * WHY THE CHECKS MATTER MORE THAN THE READING. A model that reads an Iqama correctly still cannot know
 * that the number already belongs to somebody else on file, that the employee picked is a different
 * person, or that the "renewed" passport expired last month. Those are what turn a fast wrong entry
 * into a caught one, so they are computed here from the database, not asked of the model.
 */
import { askJson, AiError, availableModels, isAvailableModel, isKnownModelId, modelLabel } from "./ai.js";
import { readPassportMrz } from "./mrz-reader.js";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./db.js";

/** The built-in passport reader's name on screen and in each suggestion's `model` column. */
export const BUILTIN_READER = "builtin:mrz";

export type Confidence = "high" | "medium" | "low" | "none";
export type Extraction = {
  documentType: string | null;
  isIdentityDocument: boolean;
  fields: {
    number: string | null;
    expiry: string | null;       // YYYY-MM-DD, Gregorian
    expiryHijri: string | null;  // as printed, when the document gives a Hijri date
    issueDate: string | null;    // YYYY-MM-DD
    name: string | null;
    nationality: string | null;  // ISO 3166-1 alpha-2
    dob: string | null;          // YYYY-MM-DD
  };
  confidence: Record<keyof Extraction["fields"], Confidence>;
  notes: string;
};
export type IntakeIssue = { level: "error" | "warning" | "info"; code: string; message: string };
/** The reading step, injectable so the checks and the accept flow can be tested without a model call. */
export type Extractor = (file: { data: Buffer; mediaType: string; fileName: string }, knownTypes: string[], model: string) => Promise<Extraction>;

/** A failure worth showing the person who pressed the button, as opposed to a bug. */
export class IntakeError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = "IntakeError"; }
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────

export async function intakeStatus() {
  const row = await prisma.appSetting.findUnique({ where: { key: "intakeAgent" } }).catch(() => null);
  const v = (row?.value ?? {}) as any;
  const enabled = v.enabled === true;
  // A model is used only when one was chosen AND it is configured on this server right now.
  const chosen = isKnownModelId(v.model) ? String(v.model) : null;
  const model = chosen && isAvailableModel(chosen) ? chosen : null;
  return {
    enabled,
    // The built-in passport reader needs nothing, so the agent can always be switched on.
    keyPresent: true,
    ready: enabled,
    model,
    modelChosen: chosen,
    readerLabel: model ? `Built-in passport reader, then ${modelLabel(model)}` : "Built-in passport reader only",
    why: !enabled ? "Document intake is switched off. An admin can turn it on."
      : chosen && !model ? `${modelLabel(chosen)} is not configured on this server, so only passports can be read.` : null,
  };
}

export async function setIntakeSettings(next: { enabled?: boolean; model?: string | null }) {
  const row = await prisma.appSetting.findUnique({ where: { key: "intakeAgent" } }).catch(() => null);
  const cur = (row?.value ?? {}) as any;
  const value = {
    ...cur,
    ...(typeof next.enabled === "boolean" ? { enabled: next.enabled } : {}),
    ...(next.model !== undefined ? { model: next.model && isKnownModelId(next.model) ? String(next.model) : null } : {}),
  };
  await prisma.appSetting.upsert({ where: { key: "intakeAgent" }, create: { key: "intakeAgent", value }, update: { value } });
  return intakeStatus();
}

// ── reading the document ──────────────────────────────────────────────────────────────────────

const FIELD_KEYS = ["number", "expiry", "expiryHijri", "issueDate", "name", "nationality", "dob"] as const;
const nullableString = { type: ["string", "null"] };
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "isIdentityDocument", "fields", "confidence", "notes"],
  properties: {
    documentType: nullableString,
    isIdentityDocument: { type: "boolean" },
    fields: {
      type: "object", additionalProperties: false, required: [...FIELD_KEYS],
      properties: Object.fromEntries(FIELD_KEYS.map(k => [k, nullableString])),
    },
    confidence: {
      type: "object", additionalProperties: false, required: [...FIELD_KEYS],
      properties: Object.fromEntries(FIELD_KEYS.map(k => [k, { type: "string", enum: ["high", "medium", "low", "none"] }])),
    },
    notes: { type: "string" },
  },
};

const SYSTEM = `You read scanned identity and compliance documents for a PRO (government relations) firm in Saudi Arabia, and report exactly what is printed on them.

Rules:
- Report only what you can read on the document. If a field is absent, cut off, or unreadable, return null for it and "none" for its confidence. Never infer a value from context or guess a plausible one.
- documentType: choose the matching name from the list of document types you are given. If none fits, return the plain name of the document you see. Return null if this is not a document at all.
- Dates: return Gregorian dates as YYYY-MM-DD. Saudi documents often print Hijri dates; if only a Hijri expiry is printed, put it exactly as printed in expiryHijri, and fill expiry only if a Gregorian date is also printed. Do not convert Hijri to Gregorian yourself.
- Passports: when the machine-readable zone (the two lines of chevrons at the bottom) is legible, prefer it for the number, name, nationality, date of birth and expiry, and say in notes that you used it.
- name: as printed, in Latin script where the document provides it.
- nationality: ISO 3166-1 alpha-2 code (IN, BD, SA, PK, PH ...).
- number: the document's own number (passport number, Iqama/ID number, CR number, permit number, policy number), without spaces.
- confidence per field: high = clearly legible; medium = legible but small, blurred, or partly obscured; low = you had to work to read it; none = not read.
- notes: one or two short sentences a clerk would find useful, such as glare over the expiry or a Hijri-only date. Empty string if nothing to add.`;

const SUPPORTED_IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The model reader: one structured-output call, to whichever model the admin chose. */
export const modelExtractor: Extractor = async (file, knownTypes, model) => {
  try {
    return await askJson<Extraction>({
      model, system: SYSTEM, schema: EXTRACTION_SCHEMA, maxTokens: 16000, file,
      prompt: `Document types this firm tracks: ${knownTypes.join(", ")}.
Read this document and report its fields.`,
    });
  } catch (e) {
    if (e instanceof AiError) throw new IntakeError(e.message, e.status);
    throw e;
  }
};

// ── checking what was read ────────────────────────────────────────────────────────────────────

const ALIAS: Record<string, string> = {
  "residence permit": "iqama", "resident identity": "iqama", "resident id": "iqama", "muqeem": "iqama",
  "commercial registration": "commercial registration", "cr": "commercial registration", "cr certificate": "commercial registration",
  "medical insurance": "health insurance", "insurance card": "health insurance",
};
const normName = (s: string) => s.toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(t => t.length > 1);
/** Share of the shorter name's words that appear in the longer — passports reorder given/family names. */
function nameOverlap(a: string, b: string): number {
  const A = new Set(normName(a)), B = new Set(normName(b));
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let hit = 0; for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}
const isIsoDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

export async function checkExtraction(ex: Extraction, ctx: { companyId: string; employeeId: string | null }) {
  const issues: IntakeIssue[] = [];
  const types = await prisma.documentType.findMany({ where: { retired: false }, select: { name: true, subjectKind: true, neverExpires: true, authority: true } });
  const read = String(ex.documentType ?? "").trim();
  const key = ALIAS[read.toLowerCase()] ?? read.toLowerCase();
  const dt = types.find(t => t.name.toLowerCase() === key) ?? null;

  if (!ex.documentType) issues.push({ level: "error", code: "not_a_document", message: "This does not look like a document the reader recognised." });
  else if (!dt) issues.push({ level: "error", code: "unknown_type", message: `Read as "${ex.documentType}", which is not a document type this system tracks. Pick the right type before accepting.` });

  const company = await prisma.company.findUnique({ where: { id: ctx.companyId }, select: { name: true, cr: true } });
  const f = ex.fields;

  // Who it belongs to.
  let employee = ctx.employeeId ? await prisma.employee.findUnique({ where: { id: ctx.employeeId }, select: { id: true, name: true, govId: true, nationality: true, dob: true, companyId: true } }) : null;
  if (employee && employee.companyId !== ctx.companyId) {
    issues.push({ level: "error", code: "employee_other_client", message: "The employee selected belongs to a different client." });
    employee = null;
  }
  let suggestedEmployeeId: string | null = employee?.id ?? null;
  if (dt?.subjectKind !== "company" && !employee) {
    const staff = await prisma.employee.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true, govId: true } });
    const byId = f.number ? staff.find(s => s.govId && s.govId === f.number) : null;
    const byName = f.name ? staff.filter(s => nameOverlap(s.name, f.name!) >= 0.75) : [];
    const guess = byId ?? (byName.length === 1 ? byName[0] : null);
    if (guess) {
      suggestedEmployeeId = guess.id;
      issues.push({ level: "info", code: "employee_matched", message: `Matched to ${guess.name} ${byId ? "by ID number" : "by name"} — confirm before accepting.` });
    } else if (dt) {
      issues.push({ level: "warning", code: "no_employee", message: byName.length > 1 ? `${byName.length} employees have a similar name. Choose the right one.` : "No employee on this client matches this document. Choose who it belongs to, or add them first." });
    }
  }

  if (employee && f.name && nameOverlap(employee.name, f.name) < 0.5) {
    issues.push({ level: "warning", code: "name_mismatch", message: `The document says "${f.name}" but the employee selected is "${employee.name}".` });
  }
  if (employee && dt?.name === "Iqama" && f.number && employee.govId && employee.govId !== f.number) {
    issues.push({ level: "warning", code: "id_mismatch", message: `This Iqama number (${f.number}) differs from the ID on ${employee.name}'s record (${employee.govId}).` });
  }
  if (employee && f.nationality && employee.nationality && employee.nationality.toUpperCase() !== f.nationality.toUpperCase()) {
    issues.push({ level: "warning", code: "nationality_mismatch", message: `Nationality reads ${f.nationality}, but ${employee.name} is recorded as ${employee.nationality}.` });
  }
  if (dt?.subjectKind === "company" && dt.name === "Commercial Registration" && f.number && company?.cr && company.cr.replace(/\D/g, "") !== f.number.replace(/\D/g, "")) {
    issues.push({ level: "warning", code: "cr_mismatch", message: `This CR number (${f.number}) differs from the one on ${company.name}'s record (${company.cr}).` });
  }

  // The number already belongs to somebody else.
  if (dt && f.number) {
    const clash = await prisma.document.findFirst({
      where: { docType: dt.name, docNumber: f.number, supersededAt: null, NOT: suggestedEmployeeId ? { employeeId: suggestedEmployeeId } : { companyId: ctx.companyId } },
      select: { person: true, company: { select: { name: true } } },
    });
    if (clash) issues.push({ level: "error", code: "duplicate_number", message: `${dt.name} ${f.number} is already on file for ${clash.person}${clash.company ? ` (${clash.company.name})` : ""}.` });
  }

  // Dates.
  if (dt && !dt.neverExpires) {
    if (!f.expiry) issues.push({ level: "warning", code: "no_expiry", message: f.expiryHijri ? `Only a Hijri expiry was printed (${f.expiryHijri}). Enter the Gregorian date before accepting — renewals are tracked on it.` : "No expiry date was read. Renewals cannot be tracked without one." });
    else if (!isIsoDate(f.expiry)) issues.push({ level: "error", code: "bad_expiry", message: `The expiry "${f.expiry}" is not a valid date.` });
    else if (Date.parse(f.expiry) < Date.now()) issues.push({ level: "warning", code: "expired", message: `This document expired on ${f.expiry}. Accepting records an expired document — its renewal will open immediately.` });
  }
  for (const k of FIELD_KEYS) {
    if (ex.confidence?.[k] === "low" && f[k]) issues.push({ level: "info", code: `low_${k}`, message: `The ${k === "dob" ? "date of birth" : k.replace(/([A-Z])/g, " $1").toLowerCase()} was hard to read — check it against the scan.` });
  }

  return { documentType: dt?.name ?? null, subjectKind: dt?.subjectKind ?? null, authority: dt?.authority ?? null, suggestedEmployeeId, issues, knownTypes: types.map(t => t.name) };
}

// ── the suggestion ────────────────────────────────────────────────────────────────────────────

/** Locate an uploaded private file on disk. Only files uploaded as private kinds are readable here. */
function readUpload(asset: { id: string; name: string; private: boolean; path: string }, privateDir: string) {
  if (!asset.private) throw new IntakeError("Upload the scan as a document first.");
  const ext = path.extname(asset.name || "").toLowerCase() || ".png";
  const file = path.join(privateDir, asset.id + ext);
  if (!fs.existsSync(file)) throw new IntakeError("The uploaded file could not be found on the server.", 404);
  const mediaType = ext === ".pdf" ? "application/pdf" : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg" : "";
  if (!mediaType || (mediaType !== "application/pdf" && !SUPPORTED_IMAGE.has(mediaType))) throw new IntakeError("The reader accepts PDF, JPG, PNG or WEBP scans.");
  return { data: fs.readFileSync(file), mediaType, fileName: asset.name };
}

export async function createSuggestion(input: {
  companyId: string; employeeId: string | null; fileAssetId: string; actorId: string | null; privateDir: string;
  extractor?: Extractor; ignoreSwitch?: boolean;
  /** Override the configured model (tests). null = built-in reader only. */
  model?: string | null;
}) {
  const status = await intakeStatus();
  if (!status.ready && !input.ignoreSwitch) throw new IntakeError(status.why ?? "Document intake is not available.", 409);
  const model = input.model !== undefined ? input.model : status.model;

  const company = await prisma.company.findUnique({ where: { id: input.companyId }, select: { id: true } });
  if (!company) throw new IntakeError("That client no longer exists.", 404);
  const asset = await prisma.fileAsset.findUnique({ where: { id: input.fileAssetId } });
  if (!asset) throw new IntakeError("The uploaded file no longer exists.", 404);
  const file = readUpload(asset as any, input.privateDir);

  const knownTypes = (await prisma.documentType.findMany({ where: { retired: false }, select: { name: true } })).map(t => t.name);
  const base = { companyId: input.companyId, employeeId: input.employeeId, fileAssetId: asset.id, fileName: asset.name, createdBy: input.actorId, createdAt: new Date().toISOString(), model: model ?? BUILTIN_READER };

  // Written BEFORE the model is called, as "reading". The call takes seconds, and the Agents screen
  // shows work in progress from this row — so what it shows is what is actually happening, not an
  // animation that plays regardless.
  const row = await prisma.documentSuggestion.create({ data: { ...base, status: "reading" } });

  let ex: Extraction;
  let usedModel: string = BUILTIN_READER;
  try {
    if (input.extractor) {
      ex = await input.extractor(file, knownTypes, model ?? BUILTIN_READER);
      usedModel = model ?? BUILTIN_READER;
    } else {
      // Free and local first. A passport whose MRZ passes its check digits never reaches a model.
      const mrz = await readPassportMrz(file);
      if (mrz.extraction) ex = mrz.extraction;
      else if (model) { ex = await modelExtractor(file, knownTypes, model); usedModel = model; }
      else throw new IntakeError(`${mrz.why} Other documents need a model, and none is chosen for document intake.`, 422);
    }
  } catch (e: any) {
    // Recorded, not swallowed: a failed reading is still a scan somebody tried to process.
    await prisma.documentSuggestion.update({ where: { id: row.id }, data: { status: "failed", readAt: new Date().toISOString(), model: usedModel, error: e instanceof IntakeError ? e.message : "The document could not be read." } });
    throw e;
  }

  const check = await checkExtraction(ex, { companyId: input.companyId, employeeId: input.employeeId });
  return prisma.documentSuggestion.update({
    where: { id: row.id },
    data: {
      readAt: new Date().toISOString(),
      model: usedModel,
      employeeId: check.suggestedEmployeeId,
      status: "pending",
      docType: check.documentType ?? ex.documentType,
      fields: ex.fields as any,
      confidence: ex.confidence as any,
      issues: check.issues as any,
      notes: ex.notes || null,
    },
  });
}

/** Turn a suggestion into a Document — the only way one is created. */
export async function acceptSuggestion(id: string, input: {
  actorId: string | null;
  docType?: string; employeeId?: string | null; establishmentId?: string | null;
  number?: string | null; expiry?: string | null; issueDate?: string | null;
}) {
  const s = await prisma.documentSuggestion.findUnique({ where: { id } });
  if (!s) throw new IntakeError("That suggestion no longer exists.", 404);
  if (s.status !== "pending") throw new IntakeError(`This suggestion was already ${s.status}.`, 409);

  const read = (s.fields ?? {}) as Extraction["fields"];
  const docTypeName = String(input.docType ?? s.docType ?? "").trim();
  const dt = await prisma.documentType.findFirst({ where: { name: docTypeName, retired: false } });
  if (!dt) throw new IntakeError("Choose a document type this system tracks.");

  const number = (input.number !== undefined ? input.number : read.number)?.toString().trim() || null;
  const expiry = (input.expiry !== undefined ? input.expiry : read.expiry) || null;
  const issueDate = (input.issueDate !== undefined ? input.issueDate : read.issueDate) || null;
  if (expiry && !isIsoDate(expiry)) throw new IntakeError("The expiry date is not a valid date.");
  if (!expiry && !dt.neverExpires) throw new IntakeError("Enter the expiry date — renewals are tracked on it.");
  if (issueDate && !isIsoDate(issueDate)) throw new IntakeError("The issue date is not a valid date.");

  const employeeId = input.employeeId !== undefined ? input.employeeId : s.employeeId;
  let employee: { id: string; name: string; govId: string | null; nationality: string | null; dob: string | null } | null = null;
  if (dt.subjectKind !== "company") {
    if (!employeeId) throw new IntakeError("Choose which employee this document belongs to.");
    const e = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!e || e.companyId !== s.companyId) throw new IntakeError("That employee does not belong to this client.");
    employee = e as any;
  }
  const company = await prisma.company.findUnique({ where: { id: s.companyId }, select: { name: true } });

  // The number on somebody else is a hard stop at acceptance too — the officer may have typed it.
  if (number) {
    const clash = await prisma.document.findFirst({
      where: { docType: dt.name, docNumber: number, supersededAt: null, NOT: employee ? { employeeId: employee.id } : { companyId: s.companyId } },
      select: { person: true },
    });
    if (clash) throw new IntakeError(`${dt.name} ${number} is already on file for ${clash.person}.`, 409);
  }

  const left = expiry ? Math.ceil((Date.parse(expiry) - Date.now()) / 86_400_000) : 0;
  const prior = await prisma.document.findFirst({
    where: { docType: dt.name, supersededAt: null, ...(employee ? { employeeId: employee.id } : { companyId: s.companyId, employeeId: null, establishmentId: input.establishmentId ?? null }) },
  });

  const doc = await prisma.document.create({
    data: {
      companyId: s.companyId, employeeId: employee?.id ?? null,
      establishmentId: employee ? null : input.establishmentId ?? null,
      person: employee?.name ?? company?.name ?? "—",
      docType: dt.name, docNumber: number, expiryDate: expiry, issueDate,
      issuingAuthority: dt.authority ?? null,
      status: !expiry ? "valid" : left < 0 ? "overdue" : left <= (dt.leadDays ?? 30) ? "expiring" : "valid",
      daysLeft: left,
      customData: { filePath: `/api/files/${s.fileAssetId}`, fileName: s.fileName, intakeSuggestionId: s.id } as any,
    } as any,
  });
  // One live document of a type per subject. The old one is kept as history, exactly as a manual
  // supersede does.
  if (prior) await prisma.document.update({ where: { id: prior.id }, data: { supersededAt: new Date().toISOString(), supersededById: doc.id } });

  // Fill gaps on the employee record from the document — never overwrite what someone entered.
  if (employee) {
    const fill: any = {};
    if (dt.name === "Iqama" && number && !employee.govId) fill.govId = number;
    if (read.nationality && !employee.nationality) fill.nationality = read.nationality.toUpperCase();
    if (read.dob && isIsoDate(read.dob) && !employee.dob) fill.dob = read.dob;
    if (Object.keys(fill).length) await prisma.employee.update({ where: { id: employee.id }, data: fill });
  }

  const changed: Record<string, { read: unknown; accepted: unknown }> = {};
  if (docTypeName !== s.docType) changed.docType = { read: s.docType, accepted: docTypeName };
  if (number !== (read.number ?? null)) changed.number = { read: read.number, accepted: number };
  if (expiry !== (read.expiry ?? null)) changed.expiry = { read: read.expiry, accepted: expiry };
  if (issueDate !== (read.issueDate ?? null)) changed.issueDate = { read: read.issueDate, accepted: issueDate };
  if ((employee?.id ?? null) !== s.employeeId) changed.employee = { read: s.employeeId, accepted: employee?.id ?? null };

  await prisma.documentSuggestion.update({
    where: { id: s.id },
    data: { status: "accepted", decidedBy: input.actorId, decidedAt: new Date().toISOString(), documentId: doc.id, decision: { changed, superseded: prior?.id ?? null } as any },
  });
  return { document: doc, superseded: prior?.id ?? null, changed };
}

export async function rejectSuggestion(id: string, actorId: string | null, reason: string) {
  const s = await prisma.documentSuggestion.findUnique({ where: { id } });
  if (!s) throw new IntakeError("That suggestion no longer exists.", 404);
  if (s.status !== "pending") throw new IntakeError(`This suggestion was already ${s.status}.`, 409);
  return prisma.documentSuggestion.update({
    where: { id },
    data: { status: "rejected", decidedBy: actorId, decidedAt: new Date().toISOString(), decision: { reason: reason || null } as any },
  });
}

// ── what the agent has done ───────────────────────────────────────────────────────────────────

/** A reading still marked "reading" after this long was interrupted (a restart mid-call), not slow. */
const STALE_READING_MS = 5 * 60 * 1000;

/**
 * Everything the Agents screen shows about this agent, computed from its own records.
 *
 * Nothing here is estimated. "Working" is the rows currently marked reading; "accepted as read" is
 * the accepted suggestions where the officer changed nothing — the honest measure of how often the
 * reading was right, which is the number that decides whether anyone should trust it.
 */
export async function intakeActivity() {
  const status = await intakeStatus();
  const now = Date.now();
  const rows = await prisma.documentSuggestion.findMany({ orderBy: { createdAt: "desc" }, take: 500 });

  const isStale = (r: typeof rows[number]) => r.status === "reading" && now - Date.parse(r.createdAt) > STALE_READING_MS;
  const working = rows.filter(r => r.status === "reading" && !isStale(r));
  const accepted = rows.filter(r => r.status === "accepted");
  const changedKeys = (r: typeof rows[number]) => Object.keys(((r.decision as any)?.changed) ?? {});
  const asRead = accepted.filter(r => changedKeys(r).length === 0).length;
  const readDurations = rows.filter(r => r.readAt).map(r => (Date.parse(r.readAt!) - Date.parse(r.createdAt)) / 1000).filter(n => n >= 0 && n < 600);

  // Seven days, oldest first, so a chart reads left to right.
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(now - (6 - i) * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    return { day: key, label: d.toLocaleDateString("en-GB", { weekday: "short" }), count: rows.filter(r => r.createdAt.slice(0, 10) === key).length };
  });

  // Names for the recent list, in three queries rather than one per row.
  const recent = rows.slice(0, 40);
  const companyIds = [...new Set(recent.map(r => r.companyId))];
  const employeeIds = [...new Set(recent.map(r => r.employeeId).filter(Boolean) as string[])];
  const userIds = [...new Set(recent.flatMap(r => [r.createdBy, r.decidedBy]).filter(Boolean) as string[])];
  const [companies, employees, users] = await Promise.all([
    prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }),
    prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
  ]);
  const nameOf = (list: { id: string; name: string }[], id: string | null) => (id ? list.find(x => x.id === id)?.name ?? null : null);

  return {
    agents: [{
      key: "document-intake",
      name: "Document Intake Agent",
      does: "Reads scanned passports, Iqamas, CRs, permits and insurance cards, checks them against what is on file, and prepares the document for a person to accept.",
      never: "Never creates a document by itself — every reading waits for a person to accept or reject it.",
      model: status.model,
      readerLabel: status.readerLabel,
      state: working.length ? "working" : status.ready ? "idle" : "off",
      why: status.why,
      canEnable: !status.enabled,
      working: working.map(r => ({ id: r.id, fileName: r.fileName, client: null as string | null, since: r.createdAt })),
      stats: {
        read: rows.filter(r => ["pending", "accepted", "rejected"].includes(r.status)).length,
        accepted: accepted.length,
        acceptedAsRead: asRead,
        acceptedAsReadPct: accepted.length ? Math.round((asRead * 100) / accepted.length) : null,
        rejected: rows.filter(r => r.status === "rejected").length,
        waiting: rows.filter(r => r.status === "pending").length,
        failed: rows.filter(r => r.status === "failed" || isStale(r)).length,
        fieldsCorrected: accepted.reduce((n, r) => n + changedKeys(r).length, 0),
        avgReadSeconds: readDurations.length ? Math.round((readDurations.reduce((a, b) => a + b, 0) / readDurations.length) * 10) / 10 : null,
      },
      days,
      tasks: recent.map(r => ({
        id: r.id,
        status: isStale(r) ? "interrupted" : r.status,
        docType: r.docType,
        person: nameOf(employees, r.employeeId),
        client: nameOf(companies, r.companyId),
        companyId: r.companyId,
        fileName: r.fileName,
        createdAt: r.createdAt,
        readAt: r.readAt,
        decidedAt: r.decidedAt,
        scannedBy: nameOf(users, r.createdBy),
        decidedBy: nameOf(users, r.decidedBy),
        corrected: changedKeys(r),
        issues: Array.isArray(r.issues) ? (r.issues as any[]).filter(i => i.level !== "info").length : 0,
        error: r.error,
        reader: r.model === BUILTIN_READER ? "built-in" : r.model ? "model" : null,
      })),
    }],
  };
}
