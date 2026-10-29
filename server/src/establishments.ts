/**
 * A CLIENT'S CRs — the main commercial registration and any sub (branch) CRs.
 *
 * WHY ROWS UNDER ONE CLIENT. A firm with branches holds one main CR and several sub CRs. Each has its
 * own certificate, expiry and often its own Qiwa file, but the firm is still one client: one portal,
 * one contact list, one package, one account. Making each sub CR its own client would split every one
 * of those, so a CR is a row under the client and employees and company documents point at it.
 *
 * THE MAIN CR IS WHERE NULL POINTS. An employee or company document with no `establishmentId` belongs
 * to the main CR. That keeps every existing record valid without touching it, and a client that never
 * adds a sub CR never sees any of this.
 *
 * `Company.cr` IS A MIRROR of the main CR's number, written here and — for the client form, which
 * still edits `cr` — synced back here. One writer each way, so the two cannot disagree.
 */
import { prisma } from "./db.js";
import { logNotification } from "./auth.js";
import { resolveCountry } from "./countries.js";

export class EstablishmentError extends Error { constructor(message: string, public status = 400) { super(message); } }

export type EstablishmentInput = { crNumber?: string; name?: string | null; kind?: string; city?: string | null; qiwaNo?: string | null; gosiNo?: string | null; unifiedNo?: string | null; notes?: string | null; status?: string };

/** CR numbers are compared without spaces or dashes — "1010 123 456" and "1010123456" are one CR. */
export const normCr = (v: unknown) => String(v ?? "").replace(/[\s\-–./]/g, "").trim();
export const isRealCr = (v: unknown) => { const n = normCr(v); return /\d{5,}/.test(n) && !/^0+$/.test(n); };
const clean = (v: unknown, max = 200) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };

/** Every client with a CR gets that CR as its main establishment. Safe to run on every start. */
export async function ensureMainEstablishments() {
  const cos = await prisma.company.findMany({ where: { NOT: { cr: null } }, select: { id: true, cr: true, name: true, city: true } });
  if (!cos.length) return 0;
  const have = new Set((await prisma.establishment.findMany({ where: { companyId: { in: cos.map(c => c.id) } }, select: { companyId: true } })).map(e => e.companyId));
  let made = 0;
  for (const c of cos) {
    // A placeholder typed into the CR box ("—", "N/A", "0000") is not a CR.
    if (have.has(c.id) || !isRealCr(c.cr)) continue;
    await prisma.establishment.create({ data: { companyId: c.id, crNumber: normCr(c.cr), name: c.name, kind: "main", city: c.city, status: "active", createdAt: new Date().toISOString() } });
    made++;
  }
  return made;
}

export async function listEstablishments(companyId: string) {
  const rows = await prisma.establishment.findMany({ where: { companyId }, orderBy: [{ kind: "desc" }, { createdAt: "asc" }] });
  // Null establishmentId counts toward the main CR.
  const main = rows.find(r => r.kind === "main" && r.status === "active") ?? null;
  const [emps, docs] = await Promise.all([
    prisma.employee.groupBy({ by: ["establishmentId", "nationality"], where: { companyId, archived: false, exitStatus: { not: "exited" } }, _count: { _all: true } }),
    prisma.document.groupBy({ by: ["establishmentId"], where: { companyId, employeeId: null, supersededAt: null }, _count: { _all: true } }),
  ]);
  const count = (list: { establishmentId: string | null; _count: { _all: number } }[], id: string, isMain: boolean) =>
    list.filter(x => x.establishmentId === id || (isMain && x.establishmentId === null)).reduce((n, x) => n + x._count._all, 0);
  return rows
    .sort((a, b) => (a.kind === "main" ? -1 : b.kind === "main" ? 1 : 0) || (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1))
    .map(r => {
      const isMain = r.id === main?.id;
      const employees = count(emps, r.id, isMain);
      // A plain headcount ratio for this CR — not a band. Bands come from the client's scheme and its
      // counting rules on the Workforce card; this only shows how the people are spread across CRs.
      const saudis = count(emps.filter(x => resolveCountry(x.nationality) === "SA"), r.id, isMain);
      return { ...r, employees, saudis, saudiPct: employees ? Math.round((saudis * 1000) / employees) / 10 : null, documents: count(docs, r.id, isMain) };
    });
}

/** The active CR a number belongs to at this client, or null. */
export async function findByCr(companyId: string, cr: string) {
  const n = normCr(cr);
  if (!n) return null;
  const rows = await prisma.establishment.findMany({ where: { companyId, status: "active" } });
  return rows.find(r => normCr(r.crNumber) === n) ?? null;
}

export async function mainEstablishment(companyId: string) {
  return prisma.establishment.findFirst({ where: { companyId, kind: "main", status: "active" } });
}

/** Resolve an incoming establishmentId for an employee/document: must be an active CR of this client. Main CR → null. */
export async function resolveEstablishmentId(companyId: string, id: unknown): Promise<string | null> {
  if (id === undefined || id === null || id === "") return null;
  const e = await prisma.establishment.findUnique({ where: { id: String(id) } });
  if (!e || e.companyId !== companyId) throw new EstablishmentError("That CR does not belong to this client.");
  if (e.status !== "active") throw new EstablishmentError(`CR ${e.crNumber} is cancelled.`);
  return e.kind === "main" ? null : e.id;
}

async function mirrorCompanyCr(companyId: string) {
  const main = await mainEstablishment(companyId);
  // A main CR exists, so nobody is waiting for one any more — however it got here. The CRs card's
  // own "+ Add main CR" reaches this too, and a waiver left standing beside a real registration is
  // a flag that outlives the fact it describes.
  if (main) await prisma.company.update({ where: { id: companyId }, data: { cr: main.crNumber, crPending: false } });
}

async function assertUnique(companyId: string, crNumber: string, exceptId?: string) {
  const clash = (await prisma.establishment.findMany({ where: { companyId, status: "active", NOT: exceptId ? { id: exceptId } : undefined } })).find(r => normCr(r.crNumber) === crNumber);
  if (clash) throw new EstablishmentError(`CR ${crNumber} is already on this client${clash.name ? ` (${clash.name})` : ""}.`, 409);
  const elsewhere = await prisma.establishment.findFirst({ where: { crNumber, status: "active", NOT: { companyId } }, select: { company: { select: { name: true } } } });
  if (elsewhere) throw new EstablishmentError(`CR ${crNumber} already belongs to another client, ${elsewhere.company.name}.`, 409);
}

function fields(input: EstablishmentInput) {
  return {
    ...(input.name !== undefined ? { name: clean(input.name) } : {}),
    ...(input.city !== undefined ? { city: clean(input.city, 80) } : {}),
    ...(input.qiwaNo !== undefined ? { qiwaNo: clean(input.qiwaNo, 40) } : {}),
    ...(input.gosiNo !== undefined ? { gosiNo: clean(input.gosiNo, 40) } : {}),
    ...(input.unifiedNo !== undefined ? { unifiedNo: clean(input.unifiedNo, 40) } : {}),
    ...(input.notes !== undefined ? { notes: clean(input.notes, 2000) } : {}),
  };
}

export async function createEstablishment(companyId: string, input: EstablishmentInput) {
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
  if (!co) throw new EstablishmentError("Client not found.", 404);
  const crNumber = normCr(input.crNumber);
  if (!/^[0-9A-Za-z]{5,20}$/.test(crNumber)) throw new EstablishmentError("Enter the CR number (digits only, as on the certificate).");
  await assertUnique(companyId, crNumber);
  const hasMain = !!(await mainEstablishment(companyId));
  const kind = hasMain ? "branch" : "main";
  const row = await prisma.establishment.create({ data: { companyId, crNumber, kind, status: "active", createdAt: new Date().toISOString(), ...fields(input), name: clean(input.name) ?? (kind === "main" ? co.name : null) } });
  if (kind === "main") { await mirrorCompanyCr(companyId); return row; }
  // A new CR declared as the main one goes through the same switch as promoting an existing one, so the
  // people and certificates on the old main CR stay with it rather than silently moving.
  return input.kind === "main" ? updateEstablishment(companyId, row.id, { kind: "main" }) : row;
}

export async function updateEstablishment(companyId: string, id: string, input: EstablishmentInput) {
  const cur = await prisma.establishment.findUnique({ where: { id } });
  if (!cur || cur.companyId !== companyId) throw new EstablishmentError("CR not found.", 404);
  const data: any = fields(input);
  if (input.crNumber !== undefined) {
    const crNumber = normCr(input.crNumber);
    if (!/^[0-9A-Za-z]{5,20}$/.test(crNumber)) throw new EstablishmentError("Enter the CR number (digits only, as on the certificate).");
    if (crNumber !== normCr(cur.crNumber)) await assertUnique(companyId, crNumber, id);
    data.crNumber = crNumber;
  }
  if (input.status === "cancelled" && cur.status !== "cancelled") {
    if (cur.kind === "main") throw new EstablishmentError("The main CR cannot be cancelled. Make another CR the main one first.", 409);
    const [emps, docs] = await Promise.all([
      prisma.employee.count({ where: { establishmentId: id, archived: false, exitStatus: { not: "exited" } } }),
      prisma.document.count({ where: { establishmentId: id, supersededAt: null, employeeId: null } }),
    ]);
    if (emps) throw new EstablishmentError(`${emps} active employee${emps === 1 ? " is" : "s are"} still under CR ${cur.crNumber}. Move them to another CR first.`, 409);
    data.status = "cancelled";
    void docs; // its certificates stay on file as history
  } else if (input.status === "active" && cur.status === "cancelled") {
    await assertUnique(companyId, normCr(data.crNumber ?? cur.crNumber), id);
    data.status = "active";
  }
  // Making this CR the main one: the old main becomes a branch, and the people and certificates that
  // counted toward it by default (establishmentId null) are pinned to it, so nobody silently changes CR.
  if (input.kind === "main" && cur.kind !== "main") {
    if ((data.status ?? cur.status) !== "active") throw new EstablishmentError("Only an active CR can be the main one.", 409);
    const old = await mainEstablishment(companyId);
    await prisma.$transaction([
      ...(old ? [
        prisma.employee.updateMany({ where: { companyId, establishmentId: null }, data: { establishmentId: old.id } }),
        prisma.document.updateMany({ where: { companyId, employeeId: null, establishmentId: null }, data: { establishmentId: old.id } }),
        prisma.establishment.update({ where: { id: old.id }, data: { kind: "branch" } }),
      ] : []),
      prisma.employee.updateMany({ where: { companyId, establishmentId: id }, data: { establishmentId: null } }),
      prisma.document.updateMany({ where: { companyId, employeeId: null, establishmentId: id }, data: { establishmentId: null } }),
    ]);
    data.kind = "main";
  }
  const row = await prisma.establishment.update({ where: { id }, data });
  if (row.kind === "main") await mirrorCompanyCr(companyId);
  return row;
}

/** The client form still edits Company.cr: keep the main CR in step, creating it if there was none. */
export async function syncMainFromCompany(companyId: string) {
  const co = await prisma.company.findUnique({ where: { id: companyId }, select: { cr: true, name: true, city: true } });
  const cr = normCr(co?.cr);
  if (!co || !isRealCr(cr)) return;
  const main = await mainEstablishment(companyId);
  if (!main) {
    const existing = await findByCr(companyId, cr);
    if (existing) { await updateEstablishment(companyId, existing.id, { kind: "main" }); return; }
    await prisma.establishment.create({ data: { companyId, crNumber: cr, name: co.name, kind: "main", city: co.city, status: "active", createdAt: new Date().toISOString() } });
    return;
  }
  if (normCr(main.crNumber) !== cr) await prisma.establishment.update({ where: { id: main.id }, data: { crNumber: cr } });
}

/**
 * THE COMMERCIAL REGISTRATION THAT FINISHES A BUSINESS SETUP.
 *
 * A client converted with `crPending` has no CR because the firm is getting them one. When it comes,
 * it comes as a CERTIFICATE — the document somebody files against the client — and that document is
 * the only honest moment to learn the number. Typing it into a field somewhere else as well would be
 * the same number in two places, which is exactly what `Company.cr` and the main CR row already work
 * hard to avoid.
 *
 * So: the first commercial registration filed for a client still waiting for one becomes the MAIN CR,
 * and the waiver is lifted. Deliberately narrow — it does nothing for a client that already has a CR,
 * nothing for a client that never waived one, and nothing for an employee's document.
 *
 * Returns whether it adopted, so the caller can say so. Never throws into the caller's path: a
 * certificate that files correctly must not fail because the bookkeeping around it did.
 */
export async function adoptMainCr(doc: {
  companyId?: string | null; employeeId?: string | null; docType?: string | null; docNumber?: string | null;
}): Promise<string | null> {
  if (!doc.companyId || doc.employeeId) return null;
  const cr = normCr(doc.docNumber);
  if (!isRealCr(cr)) return null;
  const co = await prisma.company.findUnique({
    where: { id: doc.companyId },
    select: { id: true, name: true, crPending: true, cr: true, companyType: true },
  });
  if (!co || !co.crPending || isRealCr(co.cr)) return null;
  // Which types ARE a commercial registration is the firm's own list, so it is read from the type
  // rather than hardcoded here — by pack key first, because a firm may rename the row.
  const name = String(doc.docType ?? "");
  const dt = await prisma.documentType.findFirst({ where: { name }, select: { packKey: true, name: true } });
  const isCr = dt
    ? dt.packKey === "sa.doctype.commercial-registration" || dt.name === "Commercial Registration"
    : name === "Commercial Registration";
  if (!isCr) return null;
  // cr first, then the main-CR row from it — syncMainFromCompany is the one writer of that pairing.
  await prisma.company.update({ where: { id: co.id }, data: { cr, crPending: false } });
  await syncMainFromCompany(co.id);
  /**
   * AND IF THE RECORD STILL SAYS IT IS A PERSON, SOMEBODY HAS TO SAY WHAT THE COMPANY IS CALLED.
   *
   * This is the end of a business setup: a client who signed as "Abdullah Al-Ghamdi" now holds a
   * certificate in the name of a company. Renaming them here is tempting and wrong — the legal name
   * is a human reading of the certificate, and silently rewriting a client's name across every list,
   * print and draft is not something a background hook should do. So it asks.
   *
   * The entity type has to move with it, or the form will go on hiding the VAT, GOSI and MOL boxes
   * that the new company needs.
   */
  if (String(co.companyType ?? "") === "Individual") {
    await logNotification({
      type: "system",
      title: `${co.name} is registered — set the company name`,
      message: `CR ${cr} has been filed, but the record is still a person. Open them, and set the legal name and the type of company.`,
    }).catch(() => {});
  }
  return cr;
}

/** A short label for a CR — used in renewal titles, lists and exports. */
export const crLabel = (e: { crNumber: string; name?: string | null; city?: string | null; kind?: string } | null | undefined) =>
  !e ? "" : `${e.kind === "main" ? "Main CR" : e.city || e.name || "Sub CR"} (${e.crNumber})`;
